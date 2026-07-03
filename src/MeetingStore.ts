import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import {
    MeetingJob,
    MeetingJobCreateInput,
    MeetingJobStatus,
    MeetingType,
} from './types';
import { normalizeAiContentState } from './openai/AiContent';

const MAX_RETAINED_RECORDS = 200;
const TERMINAL_STATUSES: ReadonlySet<MeetingJobStatus> = new Set([
    'completed',
    'completed_with_errors',
    'failed',
]);

export class MeetingStore {
    private readonly filePath: string;
    private readonly tempFilePath: string;
    private jobs: MeetingJob[] = [];
    private writeQueue: Promise<void> = Promise.resolve();

    private constructor(filePath: string) {
        this.filePath = filePath;
        this.tempFilePath = `${filePath}.tmp`;
    }

    static async create(dataDir: string) {
        const resolvedDir = path.resolve(dataDir);
        const filePath = path.join(resolvedDir, 'meetings.json');
        const store = new MeetingStore(filePath);
        await store.initialize();
        return store;
    }

    async createJob(input: MeetingJobCreateInput) {
        const now = new Date().toISOString();
        const job = normalizeMeetingJob({
            id: randomUUID(),
            recallBotId: null,
            recallRecordingId: null,
            recallTranscriptId: null,
            meetingUrl: input.meetingUrl,
            meetingSubject: input.meetingSubject,
            botDisplayName: input.botDisplayName,
            meetingType: input.meetingType,
            onJoinMessage: input.onJoinMessage,
            status: input.status ?? 'creating_bot',
            recallStatusCode: null,
            recallStatusSubCode: null,
            recallStatusMessage: null,
            transcriptRequestedAt: null,
            processingStartedAt: null,
            artifactProcessingMode: null,
            stopRequestedAt: null,
            createdAt: now,
            updatedAt: now,
            joinedAt: null,
            completedAt: null,
            driveFolder: null,
            videoUpload: null,
            transcriptJsonUpload: null,
            transcriptTextUpload: null,
            participantJsonUpload: null,
            participantTextUpload: null,
            participantArtifactStatus: null,
            participantArtifactError: null,
            participantArtifactAttempts: 0,
            participantArtifactNextRetryAt: null,
            lastError: null,
        });

        await this.enqueueWrite(async () => {
            this.jobs.push(job);
            this.pruneJobs();
            await this.persist();
        });

        return structuredClone(job);
    }

    async getById(id: string) {
        const job = this.jobs.find((item) => item.id === id);
        return job ? structuredClone(job) : null;
    }

    async getByRecallBotId(recallBotId: string) {
        const job = this.jobs.find((item) => item.recallBotId === recallBotId);
        return job ? structuredClone(job) : null;
    }

    async updateJob(
        id: string,
        updater: (job: MeetingJob) => MeetingJob,
    ) {
        let updatedJob: MeetingJob | null = null;

        await this.enqueueWrite(async () => {
            const index = this.jobs.findIndex((item) => item.id === id);
            if (index < 0) {
                throw new Error(`Meeting job not found: ${id}`);
            }

            const current = this.jobs[index];
            if (!current) {
                throw new Error(`Meeting job not found: ${id}`);
            }

            const next = normalizeMeetingJob(updater(structuredClone(current)));
            next.updatedAt = new Date().toISOString();
            this.jobs[index] = next;
            this.pruneJobs();
            await this.persist();
            updatedJob = structuredClone(next);
        });

        return updatedJob;
    }

    async listNewestFirst() {
        return structuredClone(
            [...this.jobs].sort(
                (left, right) =>
                    new Date(right.createdAt).getTime() -
                    new Date(left.createdAt).getTime(),
            ),
        );
    }

    async listActiveJobs() {
        return structuredClone(
            this.jobs.filter((job) => !TERMINAL_STATUSES.has(job.status)),
        );
    }

    private async initialize() {
        await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });

        try {
            const content = await fs.promises.readFile(this.filePath, 'utf8');
            const parsed = JSON.parse(content);
            this.jobs = Array.isArray(parsed)
                ? parsed.map((item) => normalizeMeetingJob(item))
                : [];
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
            }

            this.jobs = [];
            await this.persist();
        }
    }

    private async enqueueWrite(action: () => Promise<void>) {
        this.writeQueue = this.writeQueue.then(action, action);
        await this.writeQueue;
    }

    private async persist() {
        const payload = JSON.stringify(this.jobs, null, 2);
        await fs.promises.writeFile(this.tempFilePath, payload, 'utf8');
        await fs.promises.rename(this.tempFilePath, this.filePath);
    }

    private pruneJobs() {
        const newestFirst = [...this.jobs].sort(
            (left, right) =>
                new Date(right.createdAt).getTime() -
                new Date(left.createdAt).getTime(),
        );

        const retained = new Set<string>();
        let completedKept = 0;

        for (const job of newestFirst) {
            if (!TERMINAL_STATUSES.has(job.status)) {
                retained.add(job.id);
                continue;
            }

            if (completedKept < MAX_RETAINED_RECORDS) {
                retained.add(job.id);
                completedKept += 1;
            }
        }

        this.jobs = this.jobs.filter((job) => retained.has(job.id));
    }
}

function normalizeMeetingJob(value: Partial<MeetingJob> & Record<string, unknown>): MeetingJob {
    const meetingType = normalizeMeetingType(value.meetingType);

    const normalized: MeetingJob = {
        ...(value as MeetingJob),
        meetingType,
        onJoinMessage: typeof value.onJoinMessage === 'string' ? value.onJoinMessage : '',
        artifactProcessingMode: value.artifactProcessingMode ?? null,
        driveFolder: value.driveFolder ?? null,
        videoUpload: value.videoUpload ?? null,
        transcriptJsonUpload: value.transcriptJsonUpload ?? null,
        transcriptTextUpload: value.transcriptTextUpload ?? null,
        participantJsonUpload: value.participantJsonUpload ?? null,
        participantTextUpload: value.participantTextUpload ?? null,
        participantArtifactStatus: value.participantArtifactStatus ?? null,
        participantArtifactError: value.participantArtifactError ?? null,
        participantArtifactAttempts:
            typeof value.participantArtifactAttempts === 'number' &&
            Number.isFinite(value.participantArtifactAttempts) &&
            value.participantArtifactAttempts >= 0
                ? value.participantArtifactAttempts
                : 0,
        participantArtifactNextRetryAt: value.participantArtifactNextRetryAt ?? null,
        lastError: value.lastError ?? null,
        aiContent: normalizeAiContentState(
            {
                meetingType,
                transcriptTextUpload: value.transcriptTextUpload,
                participantTextUpload: value.participantTextUpload,
            },
            value.aiContent,
        ),
    };

    return normalized;
}

function normalizeMeetingType(value: unknown): MeetingType {
    return value === 'SEMINAR' ? 'SEMINAR' : 'RAPAT';
}
