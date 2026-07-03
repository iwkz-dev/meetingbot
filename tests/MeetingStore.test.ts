import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MeetingStore } from '../src/MeetingStore';
import { MeetingJob, MeetingType } from '../src/types';

async function createTempDir() {
    return fs.promises.mkdtemp(path.join(os.tmpdir(), 'meetingbot-store-'));
}

function buildCreateInput(meetingType: MeetingType = 'RAPAT') {
    return {
        meetingUrl: 'https://meet.google.com/example',
        meetingSubject: 'Weekly Coordination',
        botDisplayName: 'IWKZ Bot',
        meetingType,
        onJoinMessage: '',
    };
}

function expectMeetingJob(value: MeetingJob | null): MeetingJob {
    if (!value) {
        throw new Error('Expected meeting job to exist');
    }

    return value;
}

test('MeetingStore creates, updates, and reloads persisted jobs', async () => {
    const dataDir = await createTempDir();
    const store = await MeetingStore.create(dataDir);

    const job = await store.createJob({
        ...buildCreateInput(),
        onJoinMessage: 'This meeting is being recorded.',
    });
    const updated = expectMeetingJob(
        await store.updateJob(job.id, (current) => ({
            ...current,
            recallBotId: 'recall-bot-1',
            status: 'recording',
            joinedAt: '2026-07-02T10:00:00.000Z',
        })),
    );

    assert.equal(updated.recallBotId, 'recall-bot-1');
    assert.equal(updated.status, 'recording');
    assert.equal(updated.aiContent.kind, 'rapat_meeting_notes');
    assert.equal(updated.aiContent.status, 'not_ready');

    const reloaded = await MeetingStore.create(dataDir);
    const byId = await reloaded.getById(job.id);
    const byRecallBotId = await reloaded.getByRecallBotId('recall-bot-1');
    const newestFirst = await reloaded.listNewestFirst();
    const activeJobs = await reloaded.listActiveJobs();

    assert.equal(byId?.meetingSubject, 'Weekly Coordination');
    assert.equal(byId?.onJoinMessage, 'This meeting is being recorded.');
    assert.equal(byRecallBotId?.id, job.id);
    assert.equal(newestFirst[0]?.id, job.id);
    assert.equal(activeJobs.length, 1);

    const filePath = path.join(dataDir, 'meetings.json');
    const raw = await fs.promises.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]?.onJoinMessage, 'This meeting is being recorded.');
    assert.equal(parsed[0]?.aiContent?.kind, 'rapat_meeting_notes');
});

test('MeetingStore derives default AI state for older persisted records', async () => {
    const dataDir = await createTempDir();
    const filePath = path.join(dataDir, 'meetings.json');
    await fs.promises.mkdir(dataDir, { recursive: true });
    await fs.promises.writeFile(
        filePath,
        JSON.stringify([
            {
                id: 'legacy-seminar',
                recallBotId: null,
                recallRecordingId: null,
                recallTranscriptId: null,
                meetingUrl: 'https://meet.google.com/example',
                meetingSubject: 'Legacy Seminar',
                botDisplayName: 'IWKZ Bot',
                meetingType: 'SEMINAR',
                onJoinMessage: '',
                status: 'completed',
                recallStatusCode: null,
                recallStatusSubCode: null,
                recallStatusMessage: null,
                transcriptRequestedAt: null,
                processingStartedAt: null,
                artifactProcessingMode: 'full',
                stopRequestedAt: null,
                createdAt: '2026-07-03T08:00:00.000Z',
                updatedAt: '2026-07-03T08:10:00.000Z',
                joinedAt: null,
                completedAt: '2026-07-03T09:00:00.000Z',
                driveFolder: { id: 'folder-1', name: 'Legacy', link: 'https://drive.example/folder-1' },
                videoUpload: { id: 'video-1', name: 'legacy.mp4', link: 'https://drive.example/video-1' },
                transcriptJsonUpload: { id: 'json-1', name: 'legacy.transcript.json', link: 'https://drive.example/json-1' },
                transcriptTextUpload: { id: 'txt-1', name: 'legacy.transcript.txt', link: 'https://drive.example/txt-1' },
                participantJsonUpload: null,
                participantTextUpload: null,
                participantArtifactStatus: null,
                participantArtifactError: null,
                participantArtifactAttempts: 0,
                participantArtifactNextRetryAt: null,
                lastError: null,
            },
            {
                id: 'legacy-rapat',
                recallBotId: null,
                recallRecordingId: null,
                recallTranscriptId: null,
                meetingUrl: 'https://meet.google.com/example',
                meetingSubject: 'Legacy Rapat',
                botDisplayName: 'IWKZ Bot',
                meetingType: 'RAPAT',
                onJoinMessage: '',
                status: 'completed_with_errors',
                recallStatusCode: null,
                recallStatusSubCode: null,
                recallStatusMessage: null,
                transcriptRequestedAt: null,
                processingStartedAt: null,
                artifactProcessingMode: 'full',
                stopRequestedAt: null,
                createdAt: '2026-07-02T08:00:00.000Z',
                updatedAt: '2026-07-02T08:10:00.000Z',
                joinedAt: null,
                completedAt: '2026-07-02T09:00:00.000Z',
                driveFolder: null,
                videoUpload: null,
                transcriptJsonUpload: null,
                transcriptTextUpload: { id: 'txt-2', name: 'legacy-rapat.transcript.txt', link: 'https://drive.example/txt-2' },
                participantJsonUpload: null,
                participantTextUpload: null,
                participantArtifactStatus: null,
                participantArtifactError: null,
                participantArtifactAttempts: 0,
                participantArtifactNextRetryAt: null,
                lastError: 'transcript only',
            },
        ], null, 2),
        'utf8',
    );

    const store = await MeetingStore.create(dataDir);
    const seminar = expectMeetingJob(await store.getById('legacy-seminar'));
    const rapat = expectMeetingJob(await store.getById('legacy-rapat'));

    assert.equal(seminar.aiContent.kind, 'seminar_blog');
    assert.equal(seminar.aiContent.status, 'pending');
    assert.equal(seminar.aiContent.driveFileId, null);
    assert.equal(rapat.aiContent.kind, 'rapat_meeting_notes');
    assert.equal(rapat.aiContent.status, 'not_ready');
});

test('MeetingStore retains active jobs while pruning old terminal records', async () => {
    const dataDir = await createTempDir();
    const store = await MeetingStore.create(dataDir);

    const activeJob = await store.createJob(buildCreateInput('SEMINAR'));
    await store.updateJob(activeJob.id, (current) => ({
        ...current,
        status: 'recording',
    }));

    for (let index = 0; index < 205; index += 1) {
        const job = await store.createJob({
            ...buildCreateInput(),
            meetingSubject: `Job ${index}`,
        });
        await store.updateJob(job.id, (current) => ({
            ...current,
            status: 'completed',
            completedAt: `2026-07-02T10:${String(index % 60).padStart(2, '0')}:00.000Z`,
        }));
    }

    const jobs = await store.listNewestFirst();
    const activeJobs = await store.listActiveJobs();

    assert.equal(activeJobs.length, 1);
    assert.equal(activeJobs[0]?.id, activeJob.id);
    assert.equal(jobs.length, 201);
});

test('MeetingStore preserves persisted AI retry scheduling fields', async () => {
    const dataDir = await createTempDir();
    const store = await MeetingStore.create(dataDir);
    const job = await store.createJob(buildCreateInput('SEMINAR'));

    await store.updateJob(job.id, (current) => ({
        ...current,
        aiContent: {
            ...current.aiContent,
            status: 'pending',
            attemptCount: 3,
            nextRetryAt: '2026-07-03T10:15:00.000Z',
        },
    }));

    const reloaded = await MeetingStore.create(dataDir);
    const persisted = expectMeetingJob(await reloaded.getById(job.id));
    assert.equal(persisted.aiContent.status, 'pending');
    assert.equal(persisted.aiContent.attemptCount, 3);
    assert.equal(persisted.aiContent.nextRetryAt, '2026-07-03T10:15:00.000Z');
});


