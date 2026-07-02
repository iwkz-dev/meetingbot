import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppConfig } from './config';
import { ensureMeetingFolder, uploadFileToGDrive } from './GDriveUploader';
import { MeetingStore } from './MeetingStore';
import { RecallClient } from './RecallClient';
import { sanitizeFilenameBaseName } from './filename';
import { DriveArtifact, DriveFolder, MeetingJob } from './types';

const DOWNLOAD_TIMEOUT_MS = 120000;
const MAX_TRANSCRIPT_BYTES = 10 * 1024 * 1024;

type FetchLike = typeof fetch;

type ProcessingLogger = {
    info: (message: string, metadata?: unknown) => void;
    warn: (message: string, metadata?: unknown) => void;
    error: (message: string, metadata?: unknown) => void;
};

type GDriveArtifactsClient = {
    ensureMeetingFolder: (folderName: string, parentFolderId: string) => Promise<DriveFolder>;
    uploadFile: (finalFileName: string, localFilePath: string, folderId: string) => Promise<DriveArtifact>;
};

type MeetingProcessingServiceDependencies = {
    fetchImpl?: FetchLike;
    logger?: ProcessingLogger;
    now?: () => string;
    tempDirRoot?: string;
    gdriveClient?: GDriveArtifactsClient;
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

export class MeetingProcessingService {
    private readonly fetchImpl: FetchLike;
    private readonly logger: ProcessingLogger;
    private readonly now: () => string;
    private readonly tempDirRoot: string;
    private readonly gdriveClient: GDriveArtifactsClient;
    private readonly locks = new Set<string>();

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
        };
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
        const requeueable = meetings.filter(
            (meeting) =>
                meeting.status === 'uploading' &&
                Boolean(meeting.recallRecordingId) &&
                hasMissingRequiredArtifacts(meeting),
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

            const driveFolder = await this.ensurePersistedDriveFolder(meeting);
            meeting = (await this.store.getById(meeting.id)) ?? meeting;

            if (!meeting.videoUpload) {
                await downloadFileToPath(this.fetchImpl, videoDownloadUrl, videoPath);
                const uploadedVideo = await this.gdriveClient.uploadFile(
                    path.basename(videoPath),
                    videoPath,
                    driveFolder.id,
                );
                meeting = await this.persistArtifact(
                    meeting.id,
                    'videoUpload',
                    uploadedVideo,
                );
            }

            if (!videoOnly && needsTranscriptArtifacts(meeting)) {
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

                meeting = (await this.store.getById(meeting.id)) ?? meeting;

                if (!meeting.transcriptJsonUpload) {
                    const uploadedJson = await this.gdriveClient.uploadFile(
                        path.basename(transcriptJsonPath),
                        transcriptJsonPath,
                        driveFolder.id,
                    );
                    meeting = await this.persistArtifact(
                        meeting.id,
                        'transcriptJsonUpload',
                        uploadedJson,
                    );
                }

                if (!meeting.transcriptTextUpload) {
                    const uploadedText = await this.gdriveClient.uploadFile(
                        path.basename(transcriptTextPath),
                        transcriptTextPath,
                        driveFolder.id,
                    );
                    meeting = await this.persistArtifact(
                        meeting.id,
                        'transcriptTextUpload',
                        uploadedText,
                    );
                }
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
        field: 'videoUpload' | 'transcriptJsonUpload' | 'transcriptTextUpload',
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

    private async finalizeMeeting(
        meetingId: string,
        videoOnly: boolean,
        errors: string[],
    ) {
        const updated = await this.store.updateJob(meetingId, (current) => {
            const mergedError = mergeErrorMessages(current.lastError, errors);
            const hasVideo = Boolean(current.videoUpload);
            const hasTranscriptJson = Boolean(current.transcriptJsonUpload);
            const hasTranscriptText = Boolean(current.transcriptTextUpload);
            const transcriptComplete =
                videoOnly || (hasTranscriptJson && hasTranscriptText);
            const hasProcessingErrors =
                errors.length > 0 || (videoOnly && Boolean(current.lastError));

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

        if (/^['’]/.test(word) && /[A-Za-z0-9]$/.test(result)) {
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
        return false;
    }

    return !meeting.transcriptJsonUpload || !meeting.transcriptTextUpload;
}

function needsTranscriptArtifacts(meeting: MeetingJob) {
    return !meeting.transcriptJsonUpload || !meeting.transcriptTextUpload;
}

function isFullyProcessed(meeting: MeetingJob, videoOnly: boolean) {
    return Boolean(
        meeting.videoUpload &&
            (videoOnly || (meeting.transcriptJsonUpload && meeting.transcriptTextUpload)),
    );
}

function mergeErrorMessages(existing: string | null, errors: string[]) {
    const values = [existing, ...errors]
        .filter((value): value is string => Boolean(value && value.trim()))
        .map((value) => value.trim());

    if (!values.length) {
        return null;
    }

    return [...new Set(values)].join(' | ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object');
}




