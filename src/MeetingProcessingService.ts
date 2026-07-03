import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppConfig } from './config';
import {
    downloadTextFileFromGDrive,
    ensureMeetingFolder,
    findFileInFolderByExactName,
    uploadFileToGDrive,
} from './GDriveUploader';
import { MeetingStore } from './MeetingStore';
import { RecallClient } from './RecallClient';
import { sanitizeFilenameBaseName } from './filename';
import {
    hasRequiredAiSourceArtifacts,
    meetingTypeToOutputSuffix,
} from './openai/AiContent';
import {
    isAiProcessingStale,
    OpenAIContentGenerationService,
} from './openai/OpenAIContentGenerationService';
import {
    DriveArtifact,
    DriveFolder,
    MeetingJob,
    MeetingParticipant,
    ParticipantArtifactStatus,
} from './types';

const DOWNLOAD_TIMEOUT_MS = 120000;
const MAX_TRANSCRIPT_BYTES = 10 * 1024 * 1024;
const MAX_PARTICIPANT_BYTES = 10 * 1024 * 1024;
const PARTICIPANT_RETRY_DELAYS_MS = [60000, 300000, 900000, 1800000, 3600000];
const MANUAL_AI_RETRY_COOLDOWN_MS = 15000;

type FetchLike = typeof fetch;

type ProcessingLogger = {
    info: (message: string, metadata?: unknown) => void;
    warn: (message: string, metadata?: unknown) => void;
    error: (message: string, metadata?: unknown) => void;
};

type GDriveArtifactsClient = {
    ensureMeetingFolder: (folderName: string, parentFolderId: string) => Promise<DriveFolder>;
    uploadFile: (finalFileName: string, localFilePath: string, folderId: string) => Promise<DriveArtifact>;
    findFileByName?: (fileName: string, folderId: string) => Promise<DriveArtifact | null>;
    downloadTextFile?: (fileId: string) => Promise<string>;
};

type MeetingProcessingServiceDependencies = {
    fetchImpl?: FetchLike;
    logger?: ProcessingLogger;
    now?: () => string;
    tempDirRoot?: string;
    gdriveClient?: GDriveArtifactsClient;
    aiContentService?: OpenAIContentGenerationService;
};

type TranscriptWord = {
    text: string;
    startSeconds: number | null;
};

type TranscriptBlock = {
    speaker: string;
    timestampSeconds: number | null;
    text: string;
};

export class MeetingProcessingServiceError extends Error {
    constructor(
        message: string,
        readonly statusCode: number,
    ) {
        super(message);
        this.name = 'MeetingProcessingServiceError';
    }
}

export class MeetingProcessingService {
    private readonly fetchImpl: FetchLike;
    private readonly logger: ProcessingLogger;
    private readonly now: () => string;
    private readonly tempDirRoot: string;
    private readonly gdriveClient: GDriveArtifactsClient;
    private readonly aiContentService: OpenAIContentGenerationService;
    private readonly locks = new Set<string>();
    private readonly manualAiRetryCooldowns = new Map<string, number>();

    constructor(
        private readonly store: MeetingStore,
        private readonly recallClient: RecallClient,
        private readonly config: AppConfig,
        dependencies: MeetingProcessingServiceDependencies = {},
    ) {
        this.fetchImpl = dependencies.fetchImpl ?? fetch;
        this.logger = dependencies.logger ?? console;
        this.now = dependencies.now ?? (() => new Date().toISOString());
        this.tempDirRoot = dependencies.tempDirRoot ?? os.tmpdir();
        this.gdriveClient = dependencies.gdriveClient ?? {
            ensureMeetingFolder,
            uploadFile: uploadFileToGDrive,
            findFileByName: findFileInFolderByExactName,
            downloadTextFile: downloadTextFileFromGDrive,
        };
        this.aiContentService =
            dependencies.aiContentService ??
            new OpenAIContentGenerationService(this.config, {
                gdriveClient: this.gdriveClient,
                logger: this.logger,
                now: this.now,
            });
    }

    async processCompletedMeeting(
        meetingId: string,
        options: { videoOnly?: boolean } = {},
    ): Promise<void> {
        if (this.locks.has(meetingId)) {
            return;
        }

        this.locks.add(meetingId);
        try {
            await this.processUnlocked(meetingId, options);
        } finally {
            this.locks.delete(meetingId);
        }
    }

    async resumeInterruptedJobs() {
        const meetings = await this.store.listNewestFirst();
        const now = this.now();
        const requeueable = meetings.filter(
            (meeting) =>
                (meeting.status === 'uploading' &&
                    Boolean(meeting.recallRecordingId) &&
                    hasMissingRequiredArtifacts(meeting)) ||
                shouldRetryParticipantArtifacts(meeting, now) ||
                shouldRetryAiContent(meeting, now),
        );

        await Promise.all(
            requeueable.map((meeting) =>
                this.processCompletedMeeting(meeting.id, {
                    videoOnly: meeting.artifactProcessingMode === 'video_only',
                }),
            ),
        );

        return requeueable.length;
    }
    async retryAiContent(meetingId: string) {
        const meeting = await this.store.getById(meetingId);
        if (!meeting) {
            throw new MeetingProcessingServiceError('Meeting job not found.', 404);
        }

        const now = Date.parse(this.now());
        const lastManualRetryAt = this.manualAiRetryCooldowns.get(meetingId) ?? 0;
        if (now - lastManualRetryAt < MANUAL_AI_RETRY_COOLDOWN_MS) {
            throw new MeetingProcessingServiceError(
                'AI retry was requested too recently. Please wait a moment and try again.',
                429,
            );
        }

        if (!meeting.driveFolder?.id) {
            throw new MeetingProcessingServiceError(
                'AI content cannot be retried before the meeting Drive folder exists.',
                409,
            );
        }

        if (!hasRequiredAiSourceArtifacts(meeting)) {
            throw new MeetingProcessingServiceError(
                'AI content cannot be retried until the required source files are available.',
                409,
            );
        }

        const outputFilename =
            meeting.aiContent.outputFilename ??
            `${buildMeetingArtifactBaseName(meeting)}${meetingTypeToOutputSuffix(meeting.meetingType)}`;
        const existingOutput = this.gdriveClient.findFileByName
            ? await this.gdriveClient.findFileByName(
                  outputFilename,
                  meeting.driveFolder.id,
              )
            : null;

        if (existingOutput) {
            throw new MeetingProcessingServiceError(
                'AI content already exists in Google Drive for this meeting.',
                409,
            );
        }

        if (
            meeting.aiContent.status !== 'failed' &&
            meeting.aiContent.status !== 'pending' &&
            meeting.aiContent.status !== 'done'
        ) {
            throw new MeetingProcessingServiceError(
                'AI content can only be retried from a failed, queued, or missing-output completed state.',
                409,
            );
        }

        const updated = await this.store.updateJob(meeting.id, (current) => ({
            ...current,
            aiContent: {
                ...current.aiContent,
                status: 'pending',
                driveFileId:
                    current.aiContent.status === 'done'
                        ? null
                        : current.aiContent.driveFileId,
                outputFilename,
                openaiResponseId:
                    current.aiContent.status === 'done'
                        ? null
                        : current.aiContent.openaiResponseId,
                openaiRequestId:
                    current.aiContent.status === 'done'
                        ? null
                        : current.aiContent.openaiRequestId,
                openaiInputFileIds: [],
                nextRetryAt: null,
                completedAt:
                    current.aiContent.status === 'done'
                        ? null
                        : current.aiContent.completedAt,
                errorCode: null,
                errorMessage: null,
            },
        }));

        if (!updated) {
            throw new MeetingProcessingServiceError('Meeting job not found.', 404);
        }

        const queuedMeeting = await this.store.getById(meetingId);
        if (!queuedMeeting) {
            throw new MeetingProcessingServiceError('Meeting job not found.', 404);
        }

        this.manualAiRetryCooldowns.set(meetingId, now);
        void this.processCompletedMeeting(meetingId, {
            videoOnly: queuedMeeting.artifactProcessingMode === 'video_only',
        }).catch((error) => {
            this.logger.error('Manual AI retry processing failed', {
                meetingId,
                error: error instanceof Error ? error.message : String(error),
            });
        });

        return {
            result: 'ok' as const,
            message: 'AI content retry queued.',
            meeting: {
                id: queuedMeeting.id,
                aiStatus: queuedMeeting.aiContent.status,
            },
        };
    }

    private async processUnlocked(
        meetingId: string,
        options: { videoOnly?: boolean },
    ) {
        const persistedMeeting = await this.store.getById(meetingId);
        if (!persistedMeeting) {
            return;
        }

        const videoOnly =
            options.videoOnly ??
            persistedMeeting.artifactProcessingMode === 'video_only';

        if (isFullyProcessed(persistedMeeting, videoOnly)) {
            return;
        }

        let meeting = await this.updateMeetingForProcessing(
            persistedMeeting.id,
            videoOnly,
        );
        if (!meeting.recallRecordingId) {
            await this.finishMeetingWithFailure(
                meeting.id,
                'No Recall recording ID is available for artifact processing.',
            );
            return;
        }

        const tempDir = await fs.promises.mkdtemp(
            path.join(this.tempDirRoot, 'meetingbot-artifacts-'),
        );

        const errors: string[] = [];
        try {
            const recording = await this.recallClient.getRecording(
                meeting.recallRecordingId,
            );
            const videoDownloadUrl = getDownloadUrl(recording, [
                'media_shortcuts',
                'video_mixed',
                'data',
                'download_url',
            ]);

            if (!videoDownloadUrl) {
                throw new Error(
                    'Recall recording metadata did not include media_shortcuts.video_mixed.data.download_url.',
                );
            }

            const baseName = buildMeetingArtifactBaseName(meeting);
            const videoPath = path.join(tempDir, `${baseName}.mp4`);
            const transcriptJsonPath = path.join(
                tempDir,
                `${baseName}.transcript.json`,
            );
            const transcriptTextPath = path.join(
                tempDir,
                `${baseName}.transcript.txt`,
            );
            const participantTextPath = path.join(
                tempDir,
                `${baseName}.participants.txt`,
            );

            const driveFolder = await this.ensurePersistedDriveFolder(meeting);
            meeting = (await this.store.getById(meeting.id)) ?? meeting;

            await this.processVideoArtifact(
                meeting,
                driveFolder,
                videoDownloadUrl,
                videoPath,
                errors,
            );
            meeting = (await this.store.getById(meeting.id)) ?? meeting;

            if (!videoOnly) {
                await this.processTranscriptArtifacts(
                    meeting,
                    driveFolder,
                    recording,
                    transcriptJsonPath,
                    transcriptTextPath,
                    errors,
                );
                meeting = (await this.store.getById(meeting.id)) ?? meeting;
            }

            await this.processParticipantArtifacts(
                meeting,
                driveFolder,
                baseName,
                tempDir,
            );
            meeting = (await this.store.getById(meeting.id)) ?? meeting;

            if (!videoOnly) {
                await this.processAiContent(meeting, driveFolder, baseName, tempDir, {
                    transcriptTextPath,
                    participantTextPath,
                });
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            errors.push(message);
            this.logger.error('Meeting artifact processing failed', {
                meetingId,
                videoOnly,
                error: message,
            });
        } finally {
            await fs.promises.rm(tempDir, { recursive: true, force: true });
        }

        await this.finalizeMeeting(meetingId, videoOnly, errors);
    }

    private async processVideoArtifact(
        meeting: MeetingJob,
        driveFolder: DriveFolder,
        videoDownloadUrl: string,
        videoPath: string,
        errors: string[],
    ) {
        if (meeting.videoUpload) {
            return;
        }

        try {
            await downloadFileToPath(this.fetchImpl, videoDownloadUrl, videoPath);
            const uploadedVideo = await this.gdriveClient.uploadFile(
                path.basename(videoPath),
                videoPath,
                driveFolder.id,
            );
            await this.persistArtifact(
                meeting.id,
                'videoUpload',
                uploadedVideo,
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            errors.push(message);
            this.logger.error('Meeting video artifact processing failed', {
                meetingId: meeting.id,
                error: message,
            });
        }
    }

    private async processTranscriptArtifacts(
        meeting: MeetingJob,
        driveFolder: DriveFolder,
        recording: unknown,
        transcriptJsonPath: string,
        transcriptTextPath: string,
        errors: string[],
    ) {
        if (!needsTranscriptArtifacts(meeting)) {
            return;
        }

        try {
            const transcriptDownloadUrl = await this.resolveTranscriptDownloadUrl(
                meeting,
                recording,
            );
            if (!transcriptDownloadUrl) {
                throw new Error(
                    'Recall transcript metadata did not include a usable download URL.',
                );
            }

            const transcriptJsonText = await downloadTextWithLimit(
                this.fetchImpl,
                transcriptDownloadUrl,
                MAX_TRANSCRIPT_BYTES,
            );
            const transcriptPayload = parseTranscriptJson(transcriptJsonText);
            await fs.promises.writeFile(
                transcriptJsonPath,
                transcriptJsonText,
                'utf8',
            );
            await fs.promises.writeFile(
                transcriptTextPath,
                formatTranscriptText(transcriptPayload),
                'utf8',
            );

            const currentMeeting = (await this.store.getById(meeting.id)) ?? meeting;

            if (!currentMeeting.transcriptJsonUpload) {
                const uploadedJson = await this.gdriveClient.uploadFile(
                    path.basename(transcriptJsonPath),
                    transcriptJsonPath,
                    driveFolder.id,
                );
                await this.persistArtifact(
                    meeting.id,
                    'transcriptJsonUpload',
                    uploadedJson,
                );
            }

            const refreshedMeeting = (await this.store.getById(meeting.id)) ?? currentMeeting;
            if (!refreshedMeeting.transcriptTextUpload) {
                const uploadedText = await this.gdriveClient.uploadFile(
                    path.basename(transcriptTextPath),
                    transcriptTextPath,
                    driveFolder.id,
                );
                await this.persistArtifact(
                    meeting.id,
                    'transcriptTextUpload',
                    uploadedText,
                );
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            errors.push(message);
            this.logger.error('Meeting transcript artifact processing failed', {
                meetingId: meeting.id,
                error: message,
            });
        }
    }

    private async processParticipantArtifacts(
        meeting: MeetingJob,
        driveFolder: DriveFolder,
        baseName: string,
        tempDir: string,
    ) {
        const currentMeeting = (await this.store.getById(meeting.id)) ?? meeting;
        if (!shouldAttemptParticipantArtifacts(currentMeeting, this.now())) {
            return;
        }

        const startedMeeting = await this.store.updateJob(meeting.id, (current) => {
            if (!shouldAttemptParticipantArtifacts(current, this.now())) {
                return current;
            }

            return {
                ...current,
                participantArtifactStatus: 'processing',
                participantArtifactError: null,
                participantArtifactAttempts: current.participantArtifactAttempts + 1,
            };
        });

        const processingMeeting = startedMeeting ?? currentMeeting;
        if (processingMeeting.participantArtifactStatus !== 'processing') {
            return;
        }

        try {
            if (!processingMeeting.recallBotId) {
                throw new Error('No Recall bot ID is available for participant artifact processing.');
            }

            const bot = await this.recallClient.getBot(processingMeeting.recallBotId);
            const participantsDownloadUrl = await this.resolveParticipantsDownloadUrl(
                processingMeeting,
                bot,
            );

            if (!participantsDownloadUrl) {
                await this.persistParticipantArtifactState(
                    meeting.id,
                    'pending',
                    'Recall participant metadata did not include a usable participants download URL.',
                    true,
                );
                return;
            }

            const participantsJsonText = await downloadTextWithLimit(
                this.fetchImpl,
                participantsDownloadUrl,
                MAX_PARTICIPANT_BYTES,
            );
            const participants = parseParticipantsJson(participantsJsonText);
            const participantJsonPath = path.join(
                tempDir,
                `${baseName}.participants.json`,
            );
            const participantTextPath = path.join(
                tempDir,
                `${baseName}.participants.txt`,
            );

            await fs.promises.writeFile(
                participantJsonPath,
                JSON.stringify(participants, null, 2),
                'utf8',
            );
            await fs.promises.writeFile(
                participantTextPath,
                formatParticipantNamesText(
                    participants,
                    processingMeeting.botDisplayName,
                ),
                'utf8',
            );

            let refreshed = (await this.store.getById(meeting.id)) ?? processingMeeting;
            if (!refreshed.participantJsonUpload) {
                const uploadedJson = await this.gdriveClient.uploadFile(
                    path.basename(participantJsonPath),
                    participantJsonPath,
                    driveFolder.id,
                );
                refreshed = await this.persistArtifact(
                    meeting.id,
                    'participantJsonUpload',
                    uploadedJson,
                );
            }

            if (!refreshed.participantTextUpload) {
                const uploadedText = await this.gdriveClient.uploadFile(
                    path.basename(participantTextPath),
                    participantTextPath,
                    driveFolder.id,
                );
                refreshed = await this.persistArtifact(
                    meeting.id,
                    'participantTextUpload',
                    uploadedText,
                );
            }

            await this.persistParticipantArtifactState(meeting.id, 'done', null, false);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await this.persistParticipantArtifactState(meeting.id, 'failed', message, false);
            this.logger.error('Meeting participant artifact processing failed', {
                meetingId: meeting.id,
                error: message,
            });
        }
    }

    private async updateMeetingForProcessing(
        meetingId: string,
        videoOnly: boolean,
    ): Promise<MeetingJob> {
        const updated: MeetingJob | null = await this.store.updateJob(meetingId, (current) => ({
            ...current,
            status: 'uploading',
            processingStartedAt: current.processingStartedAt ?? this.now(),
            artifactProcessingMode: videoOnly ? 'video_only' : 'full',
        }));

        if (!updated) {
            throw new Error(`Meeting job not found: ${meetingId}`);
        }

        return updated;
    }

    private async resolveTranscriptDownloadUrl(
        meeting: MeetingJob,
        recording: unknown,
    ) {
        const shortcutUrl = getDownloadUrl(recording, [
            'media_shortcuts',
            'transcript',
            'data',
            'download_url',
        ]);
        if (shortcutUrl) {
            return shortcutUrl;
        }

        if (!meeting.recallTranscriptId) {
            return null;
        }

        const transcript = await this.recallClient.getTranscript(
            meeting.recallTranscriptId,
        );
        return getDownloadUrl(transcript, ['data', 'download_url']);
    }

    private async resolveParticipantsDownloadUrl(
        meeting: MeetingJob,
        bot: unknown,
    ) {
        const botRecording = findBotRecording(bot, meeting.recallRecordingId);
        const shortcutUrl = getParticipantsDownloadUrl(botRecording);
        if (shortcutUrl) {
            return shortcutUrl;
        }

        if (!meeting.recallRecordingId) {
            return null;
        }

        const participantEvents = await this.recallClient.listParticipantEvents(
            meeting.recallRecordingId,
        );
        return getParticipantsDownloadUrlFromParticipantEvents(participantEvents);
    }

    private async ensurePersistedDriveFolder(
        meeting: MeetingJob,
    ): Promise<DriveFolder> {
        if (meeting.driveFolder?.id) {
            return meeting.driveFolder;
        }

        const parentFolderId = getParentFolderId(this.config, meeting);
        const folderName = buildMeetingDriveFolderName(meeting);
        const driveFolder = await this.gdriveClient.ensureMeetingFolder(
            folderName,
            parentFolderId,
        );

        await this.store.updateJob(meeting.id, (current) => ({
            ...current,
            driveFolder: current.driveFolder ?? driveFolder,
        }));

        return driveFolder;
    }

    private async persistArtifact(
        meetingId: string,
        field:
            | 'videoUpload'
            | 'transcriptJsonUpload'
            | 'transcriptTextUpload'
            | 'participantJsonUpload'
            | 'participantTextUpload',
        artifact: DriveArtifact,
    ): Promise<MeetingJob> {
        const updated: MeetingJob | null = await this.store.updateJob(meetingId, (current) => ({
            ...current,
            [field]: current[field] ?? artifact,
        }));

        if (!updated) {
            throw new Error(`Meeting job not found: ${meetingId}`);
        }

        return updated;
    }

    private async persistParticipantArtifactState(
        meetingId: string,
        status: ParticipantArtifactStatus,
        errorMessage: string | null,
        retryable: boolean,
    ) {
        await this.store.updateJob(meetingId, (current) => ({
            ...current,
            participantArtifactStatus: status,
            participantArtifactError: errorMessage,
            participantArtifactNextRetryAt:
                retryable && status === 'pending'
                    ? addDelayToIso(
                          this.now(),
                          getParticipantRetryDelayMs(current.participantArtifactAttempts),
                      )
                    : null,
        }));
    }

    private async processAiContent(
        meeting: MeetingJob,
        driveFolder: DriveFolder,
        baseName: string,
        tempDir: string,
        localPaths: { transcriptTextPath: string; participantTextPath: string },
    ) {
        if (!driveFolder.id) {
            return;
        }

        let currentMeeting = (await this.store.getById(meeting.id)) ?? meeting;
        currentMeeting = await this.aiContentService.recoverStateForMeeting({
            meeting: currentMeeting,
            baseName,
            driveFolderId: driveFolder.id,
            persistAiState: (updater) =>
                this.store.updateJob(meeting.id, (current) => ({
                    ...current,
                    aiContent: updater(current.aiContent),
                })),
        });

        if (!shouldAttemptAiContent(currentMeeting, this.now())) {
            return;
        }

        await this.aiContentService.generateForMeeting({
            meeting: currentMeeting,
            baseName,
            driveFolderId: driveFolder.id,
            tempDir,
            transcriptTextPath: localPaths.transcriptTextPath,
            participantTextPath: localPaths.participantTextPath,
            persistAiState: (updater) =>
                this.store.updateJob(meeting.id, (current) => ({
                    ...current,
                    aiContent: updater(current.aiContent),
                })),
        });
    }

    private async finalizeMeeting(
        meetingId: string,
        videoOnly: boolean,
        errors: string[],
    ) {
        const updated = await this.store.updateJob(meetingId, (current) => {
            const participantIncomplete = !hasCompletedParticipantArtifacts(current);
            const mergedError = mergeErrorMessages(current.lastError, [
                ...errors,
                current.participantArtifactError,
                current.aiContent.errorMessage,
            ]);
            const hasVideo = Boolean(current.videoUpload);
            const hasTranscriptJson = Boolean(current.transcriptJsonUpload);
            const hasTranscriptText = Boolean(current.transcriptTextUpload);
            const transcriptComplete =
                videoOnly || (hasTranscriptJson && hasTranscriptText);
            const aiIncomplete = !videoOnly && hasMissingAiArtifact(current);
            const hasProcessingErrors =
                errors.length > 0 ||
                (videoOnly && Boolean(current.lastError)) ||
                participantIncomplete ||
                aiIncomplete;

            let status: MeetingJob['status'];
            if (!hasVideo) {
                status = 'failed';
            } else if (transcriptComplete && !hasProcessingErrors) {
                status = 'completed';
            } else {
                status = 'completed_with_errors';
            }

            return {
                ...current,
                status,
                completedAt: this.now(),
                artifactProcessingMode: videoOnly ? 'video_only' : 'full',
                lastError: status === 'completed' ? null : mergedError,
            };
        });

        if (!updated) {
            throw new Error(`Meeting job not found: ${meetingId}`);
        }
    }

    private async finishMeetingWithFailure(meetingId: string, errorMessage: string) {
        await this.store.updateJob(meetingId, (current) => ({
            ...current,
            status: 'failed',
            completedAt: this.now(),
            lastError: mergeErrorMessages(current.lastError, [errorMessage]),
        }));
    }
}

export function buildMeetingArtifactBaseName(
    meeting: Pick<MeetingJob, 'createdAt' | 'meetingSubject' | 'id'>,
) {
    const date = new Date(meeting.createdAt);
    const datePart = Number.isNaN(date.getTime())
        ? 'unknown-date'
        : `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}_${pad(date.getUTCHours())}-${pad(date.getUTCMinutes())}`;
    const subjectPart =
        sanitizeFilenameBaseName(meeting.meetingSubject).slice(0, 50) || 'meeting';
    const shortJobId = meeting.id.replace(/-/g, '').slice(0, 8) || 'job';
    return `${datePart}_${subjectPart}_${shortJobId}`;
}

export function buildMeetingDriveFolderName(
    meeting: Pick<MeetingJob, 'createdAt' | 'meetingSubject'>,
) {
    const date = new Date(meeting.createdAt);
    const datePart = Number.isNaN(date.getTime())
        ? 'unknown-date'
        : `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
    const subjectPart =
        sanitizeFilenameBaseName(meeting.meetingSubject).slice(0, 60) || 'meeting';
    return `${subjectPart}_${datePart}`;
}

export function formatTranscriptText(payload: unknown) {
    const blocks = buildTranscriptBlocks(payload);
    if (!blocks.length) {
        return '';
    }

    return blocks
        .map((block) => {
            const prefix =
                block.timestampSeconds === null
                    ? `${block.speaker}: ${block.text}`
                    : `[${formatTimestamp(block.timestampSeconds)}] ${block.speaker}: ${block.text}`;
            return prefix.trim();
        })
        .join('\n\n');
}

export function collectParticipantNames(
    participants: unknown,
    botDisplayName: string,
) {
    const normalizedBotName = normalizeParticipantName(botDisplayName);
    const seen = new Set<string>();
    const names: string[] = [];

    for (const participant of ensureParticipantArray(participants)) {
        const normalizedName = normalizeParticipantName(participant.name);
        if (!normalizedName) {
            continue;
        }

        if (normalizedBotName && normalizedName.toLocaleLowerCase() === normalizedBotName.toLocaleLowerCase()) {
            continue;
        }

        const key = normalizedName.toLocaleLowerCase();
        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        names.push(normalizedName);
    }

    return names.sort((left, right) =>
        left.localeCompare(right, undefined, { sensitivity: 'base' }),
    );
}

export function formatParticipantNamesText(
    participants: unknown,
    botDisplayName: string,
) {
    const names = collectParticipantNames(participants, botDisplayName);
    return names.length ? `${names.join('\n')}\n` : '';
}

function buildTranscriptBlocks(payload: unknown) {
    const entries = extractTranscriptEntries(payload);
    const blocks: TranscriptBlock[] = [];

    for (const entry of entries) {
        const speaker = resolveSpeakerName(entry);
        const words = extractWords(entry);
        const text = words.length
            ? joinTranscriptWords(words.map((word) => word.text))
            : extractFallbackText(entry);

        if (!text) {
            continue;
        }

        const timestampSeconds =
            words.find((word) => word.startSeconds !== null)?.startSeconds ??
            extractTimestampSeconds(entry);
        const previous = blocks[blocks.length - 1];
        if (previous && previous.speaker === speaker) {
            previous.text = `${previous.text} ${text}`.trim();
            continue;
        }

        blocks.push({
            speaker,
            timestampSeconds,
            text,
        });
    }

    return blocks;
}

function extractTranscriptEntries(payload: unknown): Array<Record<string, unknown>> {
    if (Array.isArray(payload)) {
        return payload.filter(isRecord);
    }

    if (!isRecord(payload)) {
        return [];
    }

    const candidates = ['entries', 'transcript', 'utterances', 'segments', 'monologues'];
    for (const key of candidates) {
        const value = payload[key];
        if (Array.isArray(value)) {
            return value.filter(isRecord);
        }
    }

    return [];
}

function resolveSpeakerName(entry: Record<string, unknown>) {
    const candidates: unknown[] = [
        entry.speaker,
        entry.participant_name,
        entry.name,
        isRecord(entry.participant) ? entry.participant.name : undefined,
        isRecord(entry.participant)
            ? entry.participant.display_name
            : undefined,
    ];

    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim()) {
            return candidate.trim();
        }
    }

    return 'Unknown Speaker';
}

function extractWords(entry: Record<string, unknown>) {
    const words = entry.words;
    if (!Array.isArray(words)) {
        return [] as TranscriptWord[];
    }

    return words
        .filter(isRecord)
        .map((word) => ({
            text: extractWordText(word),
            startSeconds: extractTimestampSeconds(word),
        }))
        .filter((word) => Boolean(word.text));
}

function extractWordText(word: Record<string, unknown>) {
    const candidates = [word.punctuated_word, word.text, word.word, word.value];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim()) {
            return candidate;
        }
    }

    return '';
}

function extractFallbackText(entry: Record<string, unknown>) {
    const candidates = [entry.text, entry.transcript, entry.content];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim()) {
            return candidate.trim();
        }
    }

    return '';
}

function joinTranscriptWords(words: string[]) {
    let result = '';
    for (const word of words) {
        if (!result) {
            result = word;
            continue;
        }

        if (/^[,.;:!?)]/.test(word)) {
            result += word;
            continue;
        }

        if (/^['']/.test(word) && /[A-Za-z0-9]$/.test(result)) {
            result += word;
            continue;
        }

        result += ` ${word}`;
    }

    return result.trim();
}

function extractTimestampSeconds(value: unknown) {
    if (!isRecord(value)) {
        return null;
    }

    const candidates = [
        value.start,
        value.start_time,
        value.start_timestamp,
        value.offset,
    ];

    for (const candidate of candidates) {
        const parsed = parseTimestampSeconds(candidate);
        if (parsed !== null) {
            return parsed;
        }
    }

    return null;
}

function parseTimestampSeconds(value: unknown) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value > 100000 ? value / 1000 : value;
    }

    if (typeof value === 'string' && value.trim()) {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) {
            return numeric > 100000 ? numeric / 1000 : numeric;
        }
    }

    return null;
}

function formatTimestamp(totalSeconds: number) {
    const safeSeconds = Math.max(0, Math.floor(totalSeconds));
    const hours = Math.floor(safeSeconds / 3600);
    const minutes = Math.floor((safeSeconds % 3600) / 60);
    const seconds = safeSeconds % 60;
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

function pad(value: number) {
    return String(value).padStart(2, '0');
}

function parseTranscriptJson(value: string) {
    try {
        return JSON.parse(value);
    } catch {
        throw new Error('Recall transcript download did not return valid JSON.');
    }
}

function parseParticipantsJson(value: string) {
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        throw new Error('Recall participants download did not return valid JSON.');
    }

    return ensureParticipantArray(parsed);
}

function ensureParticipantArray(value: unknown): MeetingParticipant[] {
    if (!Array.isArray(value)) {
        throw new Error('Recall participants download did not return a JSON array.');
    }

    return value.map((item) => normalizeParticipant(item));
}

function normalizeParticipant(value: unknown): MeetingParticipant {
    const item = isRecord(value) ? value : {};
    return {
        id: typeof item.id === 'number' && Number.isFinite(item.id) ? item.id : -1,
        name: typeof item.name === 'string' ? item.name : null,
        is_host: typeof item.is_host === 'boolean' ? item.is_host : null,
        platform: typeof item.platform === 'string' ? item.platform : null,
        extra_data: 'extra_data' in item ? item.extra_data ?? null : null,
        email: typeof item.email === 'string' ? item.email : null,
    };
}

async function downloadFileToPath(
    fetchImpl: FetchLike,
    url: string,
    targetPath: string,
) {
    const response = await fetchWithTimeout(fetchImpl, url);
    if (!response.ok || !response.body) {
        throw new Error(`Download failed with status ${response.status} for ${url}`);
    }

    await pipeline(
        Readable.fromWeb(response.body as any),
        fs.createWriteStream(targetPath),
    );
}

async function downloadTextWithLimit(
    fetchImpl: FetchLike,
    url: string,
    maxBytes: number,
) {
    const response = await fetchWithTimeout(fetchImpl, url);
    if (!response.ok) {
        throw new Error(`Download failed with status ${response.status} for ${url}`);
    }

    const contentLengthHeader = response.headers.get('content-length');
    if (contentLengthHeader) {
        const contentLength = Number(contentLengthHeader);
        if (Number.isFinite(contentLength) && contentLength > maxBytes) {
            throw new Error(`Transcript download exceeded the ${maxBytes}-byte limit.`);
        }
    }

    const body = await response.text();
    if (Buffer.byteLength(body, 'utf8') > maxBytes) {
        throw new Error(`Transcript download exceeded the ${maxBytes}-byte limit.`);
    }

    return body;
}

async function fetchWithTimeout(fetchImpl: FetchLike, url: string) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
        return await fetchImpl(url, {
            signal: controller.signal,
        });
    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            throw new Error(
                `Download timed out after ${DOWNLOAD_TIMEOUT_MS}ms for ${url}`,
            );
        }

        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

function getDownloadUrl(payload: unknown, segments: string[]) {
    let current: unknown = payload;
    for (const segment of segments) {
        if (!isRecord(current)) {
            return null;
        }
        current = current[segment];
    }

    return typeof current === 'string' && current.trim() ? current.trim() : null;
}

function getParentFolderId(
    config: AppConfig,
    meeting: Pick<MeetingJob, 'meetingType'>,
) {
    return meeting.meetingType === 'RAPAT'
        ? config.gdriveFolderRapat
        : config.gdriveFolderSeminar;
}

function hasMissingRequiredArtifacts(meeting: MeetingJob) {
    if (!meeting.videoUpload) {
        return true;
    }

    if (meeting.artifactProcessingMode === 'video_only') {
        return hasMissingParticipantArtifacts(meeting);
    }

    return (
        !meeting.transcriptJsonUpload ||
        !meeting.transcriptTextUpload ||
        hasMissingParticipantArtifacts(meeting) ||
        hasMissingAiArtifact(meeting)
    );
}

function hasMissingParticipantArtifacts(meeting: MeetingJob) {
    return !meeting.participantJsonUpload || !meeting.participantTextUpload;
}

function needsTranscriptArtifacts(meeting: MeetingJob) {
    return !meeting.transcriptJsonUpload || !meeting.transcriptTextUpload;
}

function isFullyProcessed(meeting: MeetingJob, videoOnly: boolean) {
    return Boolean(
        meeting.videoUpload &&
            hasCompletedParticipantArtifacts(meeting) &&
            (videoOnly || (meeting.transcriptJsonUpload && meeting.transcriptTextUpload)) &&
            (videoOnly || hasCompletedAiContent(meeting)),
    );
}

function hasCompletedParticipantArtifacts(meeting: MeetingJob) {
    return Boolean(
        meeting.participantJsonUpload &&
            meeting.participantTextUpload &&
            meeting.participantArtifactStatus === 'done',
    );
}

function shouldAttemptParticipantArtifacts(meeting: MeetingJob, now: string) {
    if (hasCompletedParticipantArtifacts(meeting)) {
        return false;
    }

    if (meeting.participantArtifactStatus === 'processing') {
        return true;
    }

    if (meeting.participantArtifactStatus === 'pending') {
        if (!meeting.participantArtifactNextRetryAt) {
            return true;
        }

        return compareIsoTimestamps(meeting.participantArtifactNextRetryAt, now) <= 0;
    }

    return meeting.participantArtifactStatus !== 'failed';
}

function hasCompletedAiContent(meeting: MeetingJob) {
    return Boolean(meeting.aiContent.driveFileId && meeting.aiContent.status === 'done');
}

function hasMissingAiArtifact(meeting: MeetingJob) {
    if (!hasRequiredAiSourceArtifacts(meeting)) {
        return false;
    }

    return !hasCompletedAiContent(meeting);
}

function shouldAttemptAiContent(meeting: MeetingJob, now: string) {
    if (!meeting.driveFolder?.id || !hasRequiredAiSourceArtifacts(meeting)) {
        return false;
    }

    if (meeting.aiContent.driveFileId) {
        return false;
    }

    if (meeting.aiContent.status === 'processing') {
        return isAiProcessingStale(meeting.aiContent, now);
    }

    if (meeting.aiContent.status === 'pending') {
        if (!meeting.aiContent.nextRetryAt) {
            return true;
        }

        return compareIsoTimestamps(meeting.aiContent.nextRetryAt, now) <= 0;
    }

    return false;
}

function shouldRetryAiContent(meeting: MeetingJob, now: string) {
    if (!meeting.recallRecordingId || !shouldAttemptAiContent(meeting, now)) {
        return false;
    }

    return (
        meeting.status === 'uploading' ||
        meeting.status === 'completed' ||
        meeting.status === 'completed_with_errors'
    );
}

function shouldRetryParticipantArtifacts(meeting: MeetingJob, now: string) {
    return Boolean(
        meeting.recallRecordingId &&
            meeting.recallBotId &&
            (meeting.status === 'uploading' ||
                meeting.status === 'completed' ||
                meeting.status === 'completed_with_errors') &&
            (meeting.participantArtifactStatus === 'processing' ||
                (meeting.participantArtifactStatus === 'pending' &&
                    shouldAttemptParticipantArtifacts(meeting, now))),
    );
}

function mergeErrorMessages(existing: string | null, errors: Array<string | null>) {
    const values = [existing, ...errors]
        .filter((value): value is string => Boolean(value && value.trim()))
        .map((value) => value.trim());

    if (!values.length) {
        return null;
    }

    return [...new Set(values)].join(' | ');
}

function findBotRecording(bot: unknown, recordingId: string | null) {
    if (!recordingId || !isRecord(bot) || !Array.isArray(bot.recordings)) {
        return null;
    }

    for (const item of bot.recordings) {
        if (!isRecord(item)) {
            continue;
        }

        const itemId = typeof item.id === 'string' ? item.id.trim() : '';
        if (itemId && itemId === recordingId) {
            return item;
        }
    }

    return null;
}

function getParticipantsDownloadUrl(recording: unknown) {
    return (
        getDownloadUrl(recording, [
            'media_shortcuts',
            'participant_events',
            'data',
            'participants_download_url',
        ]) ??
        getDownloadUrl(recording, [
            'participant_events',
            'data',
            'participants_download_url',
        ])
    );
}

function getParticipantsDownloadUrlFromParticipantEvents(payload: unknown) {
    if (!isRecord(payload) || !Array.isArray(payload.results)) {
        return null;
    }

    for (const item of payload.results) {
        const url = getDownloadUrl(item, ['data', 'participants_download_url']);
        if (url) {
            return url;
        }
    }

    return null;
}

function normalizeParticipantName(value: unknown) {
    if (typeof value !== 'string') {
        return '';
    }

    return value.trim().replace(/\s+/g, ' ');
}

function getParticipantRetryDelayMs(attempts: number) {
    const index = Math.max(0, Math.min(PARTICIPANT_RETRY_DELAYS_MS.length - 1, attempts - 1));
    return PARTICIPANT_RETRY_DELAYS_MS[index] ?? PARTICIPANT_RETRY_DELAYS_MS[PARTICIPANT_RETRY_DELAYS_MS.length - 1] ?? 60000;
}

function addDelayToIso(baseIso: string, delayMs: number) {
    const baseTime = Date.parse(baseIso);
    if (Number.isNaN(baseTime)) {
        return null;
    }

    return new Date(baseTime + delayMs).toISOString();
}

function compareIsoTimestamps(left: string, right: string) {
    const leftTime = Date.parse(left);
    const rightTime = Date.parse(right);
    if (Number.isNaN(leftTime) || Number.isNaN(rightTime)) {
        return 0;
    }

    return leftTime - rightTime;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object');
}












