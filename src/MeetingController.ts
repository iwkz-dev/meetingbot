import { AppConfig } from './config';
import { MeetingStore } from './MeetingStore';
import { RecallApiError, RecallClient } from './RecallClient';
import {
    InviteMeetingInput,
    InviteMeetingResult,
    LeaveMeetingResult,
    MeetingJob,
    MeetingJobStatus,
    RecallCreateBotPayload,
    RuntimeStats,
} from './types';
import { normalizeMeetingType, sanitizeFilenameBaseName } from './filename';

const TERMINAL_STATUSES: ReadonlySet<MeetingJobStatus> = new Set([
    'completed',
    'completed_with_errors',
    'failed',
]);

export class MeetingControllerError extends Error {
    constructor(
        message: string,
        readonly statusCode: number,
    ) {
        super(message);
        this.name = 'MeetingControllerError';
    }
}

export class MeetingController {
    constructor(
        private readonly store: MeetingStore,
        private readonly recallClient: RecallClient,
        private readonly config: AppConfig,
        private readonly now: () => string = () => new Date().toISOString(),
    ) {}

    async inviteBot(payload: {
        meetingUrl?: unknown;
        meetingSubject?: unknown;
        meetingTitle?: unknown;
        botDisplayName?: unknown;
        meetingType?: unknown;
    }): Promise<InviteMeetingResult> {
        const input = buildInviteMeetingInput(payload);
        const job = await this.store.createJob({
            ...input,
            status: 'creating_bot',
        });

        try {
            const recallPayload = buildRecallCreateBotPayload(
                input,
                job.id,
                this.config,
                this.now(),
            );
            const updatedJob = expectMeetingJob(
                await this.store.updateJob(job.id, (current) => ({
                    ...current,
                    recallBotId: null,
                    status: current.status,
                    lastError: current.lastError,
                })),
            );
            const response = await this.recallClient.createBot(recallPayload);
            const persistedJob = expectMeetingJob(
                await this.store.updateJob(updatedJob.id, (current) => ({
                    ...current,
                    recallBotId: response.id,
                    status: 'joining',
                    lastError: null,
                })),
            );

            return {
                result: 'ok',
                message: 'bot join request accepted',
                meeting: {
                    id: persistedJob.id,
                    recallBotId: expectString(
                        persistedJob.recallBotId,
                        'Recall bot was created but not persisted.',
                    ),
                    meetingSubject: persistedJob.meetingSubject,
                    status: 'joining',
                },
            };
        } catch (error) {
            const { message, statusCode } = mapControllerFailure(error);
            await this.store.updateJob(job.id, (current) => ({
                ...current,
                status: 'failed',
                lastError: message,
            }));
            throw new MeetingControllerError(message, statusCode);
        }
    }

    async leaveMeeting(meetingId: string): Promise<LeaveMeetingResult> {
        const job = await this.store.getById(meetingId);
        if (!job) {
            throw new MeetingControllerError('Meeting not found', 404);
        }

        if (!job.recallBotId) {
            throw new MeetingControllerError(
                'Meeting does not have a Recall bot yet',
                409,
            );
        }

        if (TERMINAL_STATUSES.has(job.status)) {
            throw new MeetingControllerError(
                'Meeting is already in a terminal state',
                409,
            );
        }

        const updatedJob = expectMeetingJob(
            await this.store.updateJob(job.id, (current) => ({
                ...current,
                stopRequestedAt: this.now(),
                status: 'leaving',
            })),
        );

        const recallBotId = expectString(
            updatedJob.recallBotId,
            'Meeting does not have a Recall bot yet',
        );

        try {
            await this.recallClient.leaveBotCall(recallBotId);
            return {
                result: 'ok',
                message: 'leave request accepted',
                meeting: {
                    id: updatedJob.id,
                    recallBotId,
                    status: updatedJob.status,
                },
            };
        } catch (error) {
            if (isRecallAlreadyEndedError(error)) {
                return {
                    result: 'ok',
                    message: 'Recall bot already ended or left the meeting',
                    meeting: {
                        id: updatedJob.id,
                        recallBotId,
                        status: updatedJob.status,
                    },
                };
            }

            const { message, statusCode } = mapControllerFailure(error);
            await this.store.updateJob(job.id, (current) => ({
                ...current,
                lastError: message,
            }));
            throw new MeetingControllerError(message, statusCode);
        }
    }
}

export function buildInviteMeetingInput(payload: {
    meetingUrl?: unknown;
    meetingSubject?: unknown;
    meetingTitle?: unknown;
    botDisplayName?: unknown;
    meetingType?: unknown;
}): InviteMeetingInput {
    const meetingUrl = String(payload.meetingUrl ?? '').trim();
    const meetingSubject = String(
        payload.meetingSubject ?? payload.meetingTitle ?? '',
    ).trim();
    const botDisplayName = String(payload.botDisplayName ?? '').trim() || 'IWKZ Bot';

    let meetingType: InviteMeetingInput['meetingType'];
    try {
        meetingType = normalizeMeetingType(String(payload.meetingType ?? ''));
    } catch (error) {
        throw new MeetingControllerError(
            error instanceof Error ? error.message : String(error),
            400,
        );
    }

    if (!meetingUrl) {
        throw new MeetingControllerError('meetingUrl is required', 400);
    }

    let parsedUrl: URL;
    try {
        parsedUrl = new URL(meetingUrl);
    } catch {
        throw new MeetingControllerError('meetingUrl must be a valid URL', 400);
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        throw new MeetingControllerError('meetingUrl must use http or https', 400);
    }

    if (!meetingSubject) {
        throw new MeetingControllerError('meetingSubject is required', 400);
    }

    if (meetingSubject.length > 200) {
        throw new MeetingControllerError(
            'meetingSubject must be 1-200 characters',
            400,
        );
    }

    if (botDisplayName.length > 100) {
        throw new MeetingControllerError(
            'botDisplayName must be 1-100 characters',
            400,
        );
    }

    return {
        meetingUrl: parsedUrl.toString(),
        meetingSubject,
        botDisplayName,
        meetingType,
    };
}

export function buildRuntimeStats(meetings: MeetingJob[]): RuntimeStats {
    const activeMeetings = meetings.filter(
        (meeting) =>
            meeting.status !== 'completed' &&
            meeting.status !== 'completed_with_errors' &&
            meeting.status !== 'failed',
    );
    const completedMeetings = meetings.filter(
        (meeting) => meeting.status === 'completed',
    );
    const failedMeetings = meetings.filter(
        (meeting) =>
            meeting.status === 'failed' ||
            meeting.status === 'completed_with_errors',
    );

    return {
        activeMeetings: activeMeetings.length,
        completedMeetings: completedMeetings.length,
        failedMeetings: failedMeetings.length,
        lastStartedAt: meetings[0]?.createdAt ?? null,
        lastFinishedAt:
            meetings.find((meeting) => meeting.completedAt)?.completedAt ?? null,
        lastError: meetings.find((meeting) => meeting.lastError)?.lastError ?? null,
    };
}

export function buildArtifactBaseName(subject: string) {
    return sanitizeFilenameBaseName(subject);
}

function buildRecallCreateBotPayload(
    input: InviteMeetingInput,
    jobId: string,
    config: AppConfig,
    now: string,
): RecallCreateBotPayload {
    const payload: RecallCreateBotPayload = {
        meeting_url: input.meetingUrl,
        join_at: now,
        bot_name: input.botDisplayName,
        recording_config: {
            video_mixed_mp4: {},
            participant_events: {},
            meeting_metadata: {},
        },
        automatic_leave: {
            waiting_room_timeout: config.recallAutomaticLeave.waitingRoomTimeoutSeconds,
            noone_joined_timeout: config.recallAutomaticLeave.nooneJoinedTimeoutSeconds,
            everyone_left_timeout: {
                timeout: config.recallAutomaticLeave.everyoneLeftTimeoutSeconds,
                activate_after:
                    config.recallAutomaticLeave.everyoneLeftActivateAfterSeconds,
            },
        },
        metadata: {
            meetingbot_job_id: jobId,
            meeting_subject: input.meetingSubject,
            meeting_type: input.meetingType.toLowerCase() as 'rapat' | 'seminar',
        },
    };

    if (config.recallOnJoinMessage.trim()) {
        payload.chat = {
            on_bot_join: {
                send_to: 'everyone',
                message: config.recallOnJoinMessage,
                pin: true,
            },
        };
    }

    return payload;
}

function mapControllerFailure(error: unknown) {
    if (error instanceof MeetingControllerError) {
        return {
            message: error.message,
            statusCode: error.statusCode,
        };
    }

    if (error instanceof RecallApiError) {
        return {
            message: buildSafeRecallErrorMessage(error),
            statusCode: normalizeRecallStatusCode(error.status),
        };
    }

    return {
        message: error instanceof Error ? error.message : String(error),
        statusCode: 500,
    };
}

function buildSafeRecallErrorMessage(error: RecallApiError) {
    const body = error.responseBody.trim();
    return body
        ? `Recall request failed with status ${error.status}: ${body}`
        : `Recall request failed with status ${error.status}`;
}

function normalizeRecallStatusCode(status: number) {
    if (status >= 400 && status < 500) {
        return status;
    }

    if (status >= 500 && status < 600) {
        return 502;
    }

    return 500;
}

function isRecallAlreadyEndedError(error: unknown) {
    if (!(error instanceof RecallApiError)) {
        return false;
    }

    if (error.status !== 404 && error.status !== 409 && error.status !== 400) {
        return false;
    }

    const normalized = `${error.message} ${error.responseBody}`.toLowerCase();
    return (
        normalized.includes('already ended') ||
        normalized.includes('already left') ||
        normalized.includes('not in a call') ||
        normalized.includes('ended')
    );
}

function expectMeetingJob(value: MeetingJob | null) {
    if (!value) {
        throw new Error('Expected meeting job to exist');
    }

    return value;
}

function expectString(value: string | null, message: string) {
    if (!value) {
        throw new Error(message);
    }

    return value;
}

