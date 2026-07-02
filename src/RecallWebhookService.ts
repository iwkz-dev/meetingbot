import { AppConfig } from './config';
import { MeetingStore } from './MeetingStore';
import { RecallApiError, RecallClient } from './RecallClient';
import { MeetingJob, MeetingJobStatus } from './types';
import {
    RecallWebhookHeaders,
    RecallWebhookVerificationError,
    RecallWebhookVerifier,
} from './RecallWebhookVerifier';

const MAX_LOGGED_PAYLOAD_LENGTH = 1000;
const NON_REGRESSION_TERMINAL_STATUSES: ReadonlySet<MeetingJobStatus> = new Set([
    'completed',
    'completed_with_errors',
    'failed',
]);

export type RecallWebhookLogger = {
    info: (message: string, metadata?: unknown) => void;
    warn: (message: string, metadata?: unknown) => void;
    error: (message: string, metadata?: unknown) => void;
};

export type TranscriptProcessingQueueFn = (
    meetingId: string,
    options?: { videoOnly?: boolean },
) => Promise<void> | void;

export type RecallWebhookServiceDependencies = {
    logger?: RecallWebhookLogger;
    now?: () => string;
    verifier?: RecallWebhookVerifier;
    queueArtifactProcessing?: TranscriptProcessingQueueFn;
    scheduleAsync?: (task: () => void) => void;
};

export type RecallWebhookPayload = {
    event: string;
    data: {
        data?: {
            code?: string;
            sub_code?: string | null;
            updated_at?: string;
            message?: string;
        };
        bot?: {
            id?: string;
            metadata?: {
                meetingbot_job_id?: string;
                [key: string]: unknown;
            };
        };
        recording?: {
            id?: string;
            metadata?: Record<string, unknown>;
        };
        transcript?: {
            id?: string;
            metadata?: Record<string, unknown>;
        };
        message?: string;
    };
};

export class RecallWebhookService {
    private readonly logger: RecallWebhookLogger;
    private readonly now: () => string;
    private readonly verifier: RecallWebhookVerifier;
    private readonly queueArtifactProcessing: TranscriptProcessingQueueFn;
    private readonly scheduleAsync: (task: () => void) => void;
    private processingQueue: Promise<void> = Promise.resolve();
    private readonly artifactProcessingLocks = new Set<string>();

    constructor(
        private readonly store: MeetingStore,
        private readonly recallClient: RecallClient,
        config: AppConfig,
        dependencies: RecallWebhookServiceDependencies = {},
    ) {
        this.logger = dependencies.logger ?? console;
        this.now = dependencies.now ?? (() => new Date().toISOString());
        this.verifier =
            dependencies.verifier ?? new RecallWebhookVerifier(config, this.logger);
        this.queueArtifactProcessing =
            dependencies.queueArtifactProcessing ??
            ((meetingId, options) => {
                this.logger.info('Queued meeting artifact processing placeholder', {
                    meetingId,
                    videoOnly: Boolean(options?.videoOnly),
                });
            });
        this.scheduleAsync = dependencies.scheduleAsync ?? setImmediate;
    }

    verifyAndParse(rawBody: Buffer, headers: RecallWebhookHeaders) {
        this.verifier.verify(headers, rawBody);

        let parsed: unknown;
        try {
            parsed = JSON.parse(rawBody.toString('utf8'));
        } catch {
            throw new RecallWebhookVerificationError(
                'Recall webhook payload must be valid JSON',
                400,
            );
        }

        if (!isRecallWebhookPayload(parsed)) {
            throw new RecallWebhookVerificationError(
                'Recall webhook payload is missing required fields',
                400,
            );
        }

        return parsed;
    }

    acknowledgeAndProcess(payload: RecallWebhookPayload) {
        this.scheduleAsync(() => {
            this.processingQueue = this.processingQueue
                .then(() => this.processVerifiedWebhook(payload))
                .catch((error) => {
                    this.logger.error('Recall webhook processing failed', {
                        event: payload.event,
                        error: error instanceof Error ? error.message : String(error),
                    });
                });
        });
    }

    async processVerifiedWebhook(payload: RecallWebhookPayload) {
        const meeting = await this.findMeetingJob(payload);
        if (!meeting) {
            this.logger.warn('Verified Recall webhook did not match any meeting job', {
                event: payload.event,
                recallBotId: payload.data.bot?.id ?? null,
                meetingbotJobId:
                    payload.data.bot?.metadata?.meetingbot_job_id ?? null,
                payloadPreview: JSON.stringify(payload).slice(0, MAX_LOGGED_PAYLOAD_LENGTH),
            });
            return;
        }

        switch (payload.event) {
            case 'bot.joining_call':
                await this.applyBotLifecycleUpdate(meeting.id, payload, 'joining');
                return;
            case 'bot.in_waiting_room':
                await this.applyBotLifecycleUpdate(meeting.id, payload, 'waiting_room');
                return;
            case 'bot.in_call_not_recording':
                await this.applyBotLifecycleUpdate(
                    meeting.id,
                    payload,
                    'in_call_not_recording',
                    { setJoinedAtIfEmpty: true },
                );
                return;
            case 'bot.recording_permission_allowed':
                await this.applyBotLifecycleUpdate(
                    meeting.id,
                    payload,
                    preserveOrFallbackStatus(meeting.status, 'in_call_not_recording'),
                    { setJoinedAtIfEmpty: true },
                );
                return;
            case 'bot.recording_permission_denied':
                await this.applyBotLifecycleUpdate(
                    meeting.id,
                    payload,
                    'in_call_not_recording',
                    { setJoinedAtIfEmpty: true },
                );
                return;
            case 'bot.in_call_recording':
                await this.applyBotLifecycleUpdate(meeting.id, payload, 'recording', {
                    setJoinedAtIfEmpty: true,
                });
                return;
            case 'bot.call_ended':
                await this.applyBotLifecycleUpdate(meeting.id, payload, 'call_ended');
                return;
            case 'bot.done':
                await this.applyBotLifecycleUpdate(meeting.id, payload, meeting.status);
                return;
            case 'bot.fatal':
                await this.applyBotFatalUpdate(meeting.id, payload);
                return;
            case 'recording.done':
                await this.handleRecordingDone(meeting, payload);
                return;
            case 'recording.failed':
                await this.handleRecordingFailed(meeting.id, payload);
                return;
            case 'transcript.done':
                await this.handleTranscriptDone(meeting, payload);
                return;
            case 'transcript.failed':
                await this.handleTranscriptFailed(meeting, payload);
                return;
            default:
                this.logger.info('Ignoring unknown verified Recall webhook event', {
                    event: payload.event,
                });
        }
    }

    private async findMeetingJob(payload: RecallWebhookPayload) {
        const recallBotId = payload.data.bot?.id?.trim();
        if (recallBotId) {
            const byBotId = await this.store.getByRecallBotId(recallBotId);
            if (byBotId) {
                return byBotId;
            }
        }

        const meetingId = payload.data.bot?.metadata?.meetingbot_job_id?.trim();
        if (meetingId) {
            return this.store.getById(meetingId);
        }

        return null;
    }

    private async applyBotLifecycleUpdate(
        meetingId: string,
        payload: RecallWebhookPayload,
        nextStatus: MeetingJobStatus,
        options: { setJoinedAtIfEmpty?: boolean } = {},
    ) {
        await this.store.updateJob(meetingId, (current) => {
            const status = shouldKeepCurrentStatus(current.status, nextStatus)
                ? current.status
                : nextStatus;

            return {
                ...current,
                status,
                joinedAt:
                    options.setJoinedAtIfEmpty && !current.joinedAt
                        ? this.now()
                        : current.joinedAt,
                recallStatusCode: payload.data.data?.code ?? current.recallStatusCode,
                recallStatusSubCode:
                    payload.data.data?.sub_code ?? current.recallStatusSubCode,
                recallStatusMessage:
                    extractRecallMessage(payload) ?? current.recallStatusMessage,
            };
        });
    }

    private async applyBotFatalUpdate(
        meetingId: string,
        payload: RecallWebhookPayload,
    ) {
        await this.store.updateJob(meetingId, (current) => ({
            ...current,
            status: shouldKeepCurrentStatus(current.status, 'failed')
                ? current.status
                : 'failed',
            recallStatusCode: payload.data.data?.code ?? current.recallStatusCode,
            recallStatusSubCode:
                payload.data.data?.sub_code ?? current.recallStatusSubCode,
            recallStatusMessage:
                extractRecallMessage(payload) ?? current.recallStatusMessage,
            lastError:
                extractRecallMessage(payload) ?? current.lastError ?? 'Recall bot fatal event received',
        }));
    }

    private async handleRecordingDone(
        meeting: MeetingJob,
        payload: RecallWebhookPayload,
    ) {
        const recordingId = payload.data.recording?.id?.trim();
        if (!recordingId) {
            this.logger.warn('recording.done webhook missing recording ID', {
                meetingId: meeting.id,
            });
            return;
        }

        const currentMeeting = await this.store.getById(meeting.id);
        if (currentMeeting?.transcriptRequestedAt) {
            return;
        }

        await this.store.updateJob(meeting.id, (current) => {
            if (current.transcriptRequestedAt) {
                return current;
            }

            return {
                ...current,
                recallRecordingId: recordingId,
                transcriptRequestedAt: this.now(),
                status: 'transcribing',
                artifactProcessingMode: null,
                recallStatusCode: payload.data.data?.code ?? current.recallStatusCode,
                recallStatusSubCode:
                    payload.data.data?.sub_code ?? current.recallStatusSubCode,
                recallStatusMessage:
                    extractRecallMessage(payload) ?? current.recallStatusMessage,
            };
        });

        try {
            await this.recallClient.createTranscript(recordingId, {
                provider: {
                    recallai_async: {
                        language_code: 'auto',
                    },
                },
                diarization: {
                    use_separate_streams_when_available: true,
                },
            });
        } catch (error) {
            const safeMessage = buildSafeWebhookError(error);
            await this.store.updateJob(meeting.id, (current) => ({
                ...current,
                recallRecordingId: recordingId,
                status: 'uploading',
                processingStartedAt: current.processingStartedAt ?? this.now(),
                artifactProcessingMode: 'video_only',
                lastError: safeMessage,
                recallStatusCode: payload.data.data?.code ?? current.recallStatusCode,
                recallStatusSubCode:
                    payload.data.data?.sub_code ?? current.recallStatusSubCode,
                recallStatusMessage:
                    extractRecallMessage(payload) ?? current.recallStatusMessage,
            }));
        }
    }

    private async handleRecordingFailed(
        meetingId: string,
        payload: RecallWebhookPayload,
    ) {
        const recordingId = payload.data.recording?.id?.trim() ?? null;
        await this.store.updateJob(meetingId, (current) => ({
            ...current,
            recallRecordingId: recordingId ?? current.recallRecordingId,
            status: 'failed',
            lastError:
                extractRecallMessage(payload) ??
                current.lastError ??
                'Recall recording failed',
            recallStatusCode: payload.data.data?.code ?? current.recallStatusCode,
            recallStatusSubCode:
                payload.data.data?.sub_code ?? current.recallStatusSubCode,
            recallStatusMessage:
                extractRecallMessage(payload) ?? current.recallStatusMessage,
        }));
    }

    private async handleTranscriptDone(
        meeting: MeetingJob,
        payload: RecallWebhookPayload,
    ) {
        const transcriptId = payload.data.transcript?.id?.trim();
        const recordingId = payload.data.recording?.id?.trim();
        if (!transcriptId || !recordingId) {
            this.logger.warn('transcript.done webhook missing transcript or recording ID', {
                meetingId: meeting.id,
            });
            return;
        }

        const currentMeeting = await this.store.getById(meeting.id);
        if (
            currentMeeting?.processingStartedAt ||
            areAllArtifactsAlreadyUploaded(currentMeeting)
        ) {
            return;
        }

        await this.store.updateJob(meeting.id, (current) => {
            if (current.processingStartedAt || areAllArtifactsAlreadyUploaded(current)) {
                return current;
            }

            return {
                ...current,
                recallRecordingId: recordingId,
                recallTranscriptId: transcriptId,
                status: 'uploading',
                processingStartedAt: current.processingStartedAt ?? this.now(),
                artifactProcessingMode: 'full',
                recallStatusCode: payload.data.data?.code ?? current.recallStatusCode,
                recallStatusSubCode:
                    payload.data.data?.sub_code ?? current.recallStatusSubCode,
                recallStatusMessage:
                    extractRecallMessage(payload) ?? current.recallStatusMessage,
            };
        });

        this.queueArtifactProcessingOnce(meeting.id, { videoOnly: false });
    }

    private async handleTranscriptFailed(
        meeting: MeetingJob,
        payload: RecallWebhookPayload,
    ) {
        const transcriptId = payload.data.transcript?.id?.trim() ?? null;
        const recordingId = payload.data.recording?.id?.trim() ?? null;

        await this.store.updateJob(meeting.id, (current) => ({
            ...current,
            recallTranscriptId: transcriptId ?? current.recallTranscriptId,
            recallRecordingId: recordingId ?? current.recallRecordingId,
            status: 'uploading',
            processingStartedAt: current.processingStartedAt ?? this.now(),
            artifactProcessingMode: 'video_only',
            lastError:
                extractRecallMessage(payload) ??
                current.lastError ??
                'Recall transcript failed',
            recallStatusCode: payload.data.data?.code ?? current.recallStatusCode,
            recallStatusSubCode:
                payload.data.data?.sub_code ?? current.recallStatusSubCode,
            recallStatusMessage:
                extractRecallMessage(payload) ?? current.recallStatusMessage,
        }));

        this.queueArtifactProcessingOnce(meeting.id, { videoOnly: true });
    }

    private queueArtifactProcessingOnce(
        meetingId: string,
        options: { videoOnly?: boolean },
    ) {
        if (this.artifactProcessingLocks.has(meetingId)) {
            return;
        }

        this.artifactProcessingLocks.add(meetingId);
        Promise.resolve(this.queueArtifactProcessing(meetingId, options)).finally(() => {
            this.artifactProcessingLocks.delete(meetingId);
        });
    }
}

function isRecallWebhookPayload(value: unknown): value is RecallWebhookPayload {
    if (!value || typeof value !== 'object') {
        return false;
    }

    const candidate = value as { event?: unknown; data?: unknown };
    return typeof candidate.event === 'string' && Boolean(candidate.data && typeof candidate.data === 'object');
}

function extractRecallMessage(payload: RecallWebhookPayload) {
    const candidates = [
        payload.data.data?.message,
        payload.data.message,
        payload.data.data?.sub_code,
        payload.data.data?.code,
    ];

    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim()) {
            return candidate.trim();
        }
    }

    return null;
}

function shouldKeepCurrentStatus(
    currentStatus: MeetingJobStatus,
    nextStatus: MeetingJobStatus,
) {
    if (NON_REGRESSION_TERMINAL_STATUSES.has(currentStatus)) {
        return !NON_REGRESSION_TERMINAL_STATUSES.has(nextStatus);
    }

    return false;
}

function preserveOrFallbackStatus(
    currentStatus: MeetingJobStatus,
    fallbackStatus: MeetingJobStatus,
) {
    return currentStatus === 'joining' || currentStatus === 'waiting_room'
        ? currentStatus
        : fallbackStatus;
}

function areAllArtifactsAlreadyUploaded(meeting: MeetingJob | null | undefined) {
    return Boolean(
        meeting?.videoUpload &&
            meeting.transcriptJsonUpload &&
            meeting.transcriptTextUpload,
    );
}

function buildSafeWebhookError(error: unknown) {
    if (error instanceof RecallApiError) {
        return error.responseBody
            ? `Recall request failed with status ${error.status}: ${error.responseBody}`
            : `Recall request failed with status ${error.status}`;
    }

    return error instanceof Error ? error.message : String(error);
}



