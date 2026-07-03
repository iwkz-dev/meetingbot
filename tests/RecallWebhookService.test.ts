import { strict as assert } from 'node:assert';
import test from 'node:test';
import { MeetingStore } from '../src/MeetingStore';
import { RecallClient } from '../src/RecallClient';
import {
    RecallWebhookPayload,
    RecallWebhookService,
} from '../src/RecallWebhookService';
import { createTempDir, buildConfig, signRecallWebhook } from './helpers';

function createLogger() {
    const entries: Array<{ level: string; message: string; metadata?: unknown }> = [];
    return {
        entries,
        logger: {
            info(message: string, metadata?: unknown) {
                entries.push({ level: 'info', message, metadata });
            },
            warn(message: string, metadata?: unknown) {
                entries.push({ level: 'warn', message, metadata });
            },
            error(message: string, metadata?: unknown) {
                entries.push({ level: 'error', message, metadata });
            },
        },
    };
}

async function createService() {
    const config = buildConfig();
    const store = await MeetingStore.create(await createTempDir('meetingbot-webhook-'));
    const transcriptRequests: Array<{ recordingId: string; payload: unknown }> = [];
    const processingQueueCalls: Array<{ meetingId: string; videoOnly: boolean }> = [];
    const loggerState = createLogger();
    const recallClient = new RecallClient(config, {
        fetchImpl: async (url, init) => {
            const parsedBody = init?.body ? JSON.parse(String(init.body)) : null;
            if (String(url).includes('/create_transcript/')) {
                const match = String(url).match(/recording\/([^/]+)\/create_transcript/);
                transcriptRequests.push({
                    recordingId: match?.[1] ?? 'unknown',
                    payload: parsedBody,
                });
                return new Response(JSON.stringify({ id: 'transcript-job' }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }

            return new Response(JSON.stringify({ id: 'ok' }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        },
        jitterMs: () => 0,
        sleep: async () => undefined,
    });
    const service = new RecallWebhookService(store, recallClient, config, {
        logger: loggerState.logger,
        now: () => '2026-07-02T15:00:00.000Z',
        queueArtifactProcessing: async (meetingId, options) => {
            processingQueueCalls.push({
                meetingId,
                videoOnly: Boolean(options?.videoOnly),
            });
        },
        scheduleAsync: (task) => task(),
    });

    return {
        config,
        store,
        service,
        transcriptRequests,
        processingQueueCalls,
        loggerEntries: loggerState.entries,
    };
}

async function seedMeeting(serviceState: Awaited<ReturnType<typeof createService>>) {
    const job = await serviceState.store.createJob({
        meetingUrl: 'https://meet.google.com/abc-defg-hij',
        meetingSubject: 'Weekly Coordination',
        botDisplayName: 'IWKZ Bot',
        meetingType: 'RAPAT',
        onJoinMessage: '',
        status: 'joining',
    });

    await serviceState.store.updateJob(job.id, (current) => ({
        ...current,
        recallBotId: 'recall-bot-1',
        status: 'joining',
    }));

    return job.id;
}

function buildPayload(
    event: string,
    overrides: Partial<RecallWebhookPayload> = {},
): RecallWebhookPayload {
    return {
        event,
        data: {
            data: {
                code: event.split('.').pop() ?? event,
                sub_code: null,
                updated_at: '2026-07-02T15:00:00.000Z',
            },
            bot: {
                id: 'recall-bot-1',
                metadata: {
                    meetingbot_job_id: 'unused',
                },
            },
            ...overrides.data,
        },
        ...overrides,
    };
}

test('unverified webhook payload causes zero store or Recall side effects', async () => {
    const state = await createService();
    const payload = JSON.stringify({ event: 'bot.joining_call', data: {} });
    const invalidHeaders = {
        ...signRecallWebhook({ payload }),
        'webhook-signature': 'v1,invalid-signature',
    };

    await assert.rejects(
        async () => {
            state.service.verifyAndParse(Buffer.from(payload, 'utf8'), invalidHeaders);
        },
        /Recall webhook signature did not match/,
    );

    assert.equal((await state.store.listNewestFirst()).length, 0);
    assert.equal(state.transcriptRequests.length, 0);
    assert.equal(state.processingQueueCalls.length, 0);
});

test('RecallWebhookService maps bot lifecycle events correctly', async () => {
    const state = await createService();
    const meetingId = await seedMeeting(state);

    const cases: Array<{
        event: string;
        startingStatus: string;
        expectedStatus: string;
        joinedAt?: string | null;
    }> = [
        {
            event: 'bot.joining_call',
            startingStatus: 'joining',
            expectedStatus: 'joining',
            joinedAt: null,
        },
        {
            event: 'bot.in_waiting_room',
            startingStatus: 'joining',
            expectedStatus: 'waiting_room',
            joinedAt: null,
        },
        {
            event: 'bot.in_call_not_recording',
            startingStatus: 'waiting_room',
            expectedStatus: 'in_call_not_recording',
            joinedAt: '2026-07-02T15:00:00.000Z',
        },
        {
            event: 'bot.recording_permission_allowed',
            startingStatus: 'waiting_room',
            expectedStatus: 'waiting_room',
            joinedAt: '2026-07-02T15:00:00.000Z',
        },
        {
            event: 'bot.recording_permission_denied',
            startingStatus: 'recording',
            expectedStatus: 'in_call_not_recording',
            joinedAt: '2026-07-02T15:00:00.000Z',
        },
        {
            event: 'bot.in_call_recording',
            startingStatus: 'in_call_not_recording',
            expectedStatus: 'recording',
            joinedAt: '2026-07-02T15:00:00.000Z',
        },
        {
            event: 'bot.call_ended',
            startingStatus: 'recording',
            expectedStatus: 'call_ended',
        },
        {
            event: 'bot.done',
            startingStatus: 'call_ended',
            expectedStatus: 'call_ended',
        },
        {
            event: 'bot.fatal',
            startingStatus: 'recording',
            expectedStatus: 'failed',
        },
    ];

    for (const item of cases) {
        await state.store.updateJob(meetingId, (current) => ({
            ...current,
            status: item.startingStatus as never,
            joinedAt: null,
            lastError: null,
            recallStatusMessage: null,
        }));

        await state.service.processVerifiedWebhook(buildPayload(item.event));
        const updated = await state.store.getById(meetingId);
        assert.equal(updated?.status, item.expectedStatus);
        if (item.joinedAt !== undefined) {
            assert.equal(updated?.joinedAt, item.joinedAt);
        }
    }
});

test('duplicate recording.done creates only one async transcript request', async () => {
    const state = await createService();
    const meetingId = await seedMeeting(state);

    const payload = buildPayload('recording.done', {
        data: {
            data: {
                code: 'done',
                sub_code: null,
                updated_at: '2026-07-02T15:00:00.000Z',
            },
            bot: {
                id: 'recall-bot-1',
                metadata: {
                    meetingbot_job_id: meetingId,
                },
            },
            recording: {
                id: 'recording-1',
                metadata: {},
            },
        },
    });

    await state.service.processVerifiedWebhook(payload);
    await state.service.processVerifiedWebhook(payload);

    assert.equal(state.transcriptRequests.length, 1);
    assert.equal(state.transcriptRequests[0]?.recordingId, 'recording-1');
    const updated = await state.store.getById(meetingId);
    assert.equal(updated?.status, 'transcribing');
    assert.equal(updated?.recallRecordingId, 'recording-1');
    assert.equal(updated?.transcriptRequestedAt, '2026-07-02T15:00:00.000Z');
});

test('transcript.done queues processing only once', async () => {
    const state = await createService();
    const meetingId = await seedMeeting(state);

    const payload = buildPayload('transcript.done', {
        data: {
            data: {
                code: 'done',
                sub_code: null,
                updated_at: '2026-07-02T15:00:00.000Z',
            },
            bot: {
                id: 'recall-bot-1',
                metadata: {
                    meetingbot_job_id: meetingId,
                },
            },
            recording: {
                id: 'recording-1',
                metadata: {},
            },
            transcript: {
                id: 'transcript-1',
                metadata: {},
            },
        },
    });

    await state.service.processVerifiedWebhook(payload);
    await state.service.processVerifiedWebhook(payload);

    assert.equal(state.processingQueueCalls.length, 1);
    assert.deepEqual(state.processingQueueCalls[0], {
        meetingId,
        videoOnly: false,
    });
    const updated = await state.store.getById(meetingId);
    assert.equal(updated?.status, 'uploading');
    assert.equal(updated?.processingStartedAt, '2026-07-02T15:00:00.000Z');
    assert.equal(updated?.recallTranscriptId, 'transcript-1');
});

test('unknown verified event is acknowledged safely', async () => {
    const state = await createService();
    const meetingId = await seedMeeting(state);

    await state.service.processVerifiedWebhook(
        buildPayload('bot.breakout_room_opened', {
            data: {
                bot: {
                    id: 'recall-bot-1',
                    metadata: {
                        meetingbot_job_id: meetingId,
                    },
                },
            },
        }),
    );

    const infoLog = state.loggerEntries.find(
        (entry) => entry.level === 'info' && entry.message.includes('Ignoring unknown verified Recall webhook event'),
    );
    assert.ok(infoLog);
});

test('transcript.failed keeps uploading state and requests video-only processing', async () => {
    const state = await createService();
    const meetingId = await seedMeeting(state);

    await state.service.processVerifiedWebhook(
        buildPayload('transcript.failed', {
            data: {
                data: {
                    code: 'failed',
                    sub_code: 'transcript_error',
                    updated_at: '2026-07-02T15:00:00.000Z',
                    message: 'Recall transcript failed',
                },
                bot: {
                    id: 'recall-bot-1',
                    metadata: {
                        meetingbot_job_id: meetingId,
                    },
                },
                recording: {
                    id: 'recording-1',
                    metadata: {},
                },
                transcript: {
                    id: 'transcript-1',
                    metadata: {},
                },
            },
        }),
    );

    const updated = await state.store.getById(meetingId);
    assert.equal(updated?.status, 'uploading');
    assert.equal(updated?.artifactProcessingMode, 'video_only');
    assert.equal(updated?.processingStartedAt, '2026-07-02T15:00:00.000Z');
    assert.deepEqual(state.processingQueueCalls[0], {
        meetingId,
        videoOnly: true,
    });
});



