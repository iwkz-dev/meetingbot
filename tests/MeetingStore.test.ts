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

    const job = await store.createJob(buildCreateInput());
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

    const reloaded = await MeetingStore.create(dataDir);
    const byId = await reloaded.getById(job.id);
    const byRecallBotId = await reloaded.getByRecallBotId('recall-bot-1');
    const newestFirst = await reloaded.listNewestFirst();
    const activeJobs = await reloaded.listActiveJobs();

    assert.equal(byId?.meetingSubject, 'Weekly Coordination');
    assert.equal(byRecallBotId?.id, job.id);
    assert.equal(newestFirst[0]?.id, job.id);
    assert.equal(activeJobs.length, 1);

    const filePath = path.join(dataDir, 'meetings.json');
    const raw = await fs.promises.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.length, 1);
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
