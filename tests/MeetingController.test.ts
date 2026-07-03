import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
    buildInviteMeetingInput,
    buildRecallCreateBotPayload,
    MeetingController,
    MeetingControllerError,
} from '../src/MeetingController';
import { MeetingStore } from '../src/MeetingStore';
import { RecallClient } from '../src/RecallClient';
import { createTempDir, buildConfig } from './helpers';

test('MeetingController creates a Recall bot and persists joining state', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const config = buildConfig();
    const store = await MeetingStore.create(await createTempDir('meetingbot-controller-'));
    const recallClient = new RecallClient(config, {
        fetchImpl: async (url, init) => {
            requests.push({ url: String(url), init });
            return new Response(JSON.stringify({ id: 'recall-bot-1' }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        },
        jitterMs: () => 0,
        sleep: async () => undefined,
    });
    const controller = new MeetingController(
        store,
        recallClient,
        config,
        () => '2026-07-02T12:00:00.000Z',
    );

    const result = await controller.inviteBot({
        meetingUrl: 'https://meet.google.com/abc-defg-hij',
        meetingSubject: 'Weekly Coordination',
        botDisplayName: 'IWKZ Bot',
        meetingType: 'rapat',
        onJoinMessage: 'Welcome everyone',
    });

    assert.equal(result.result, 'ok');
    assert.equal(result.meeting.recallBotId, 'recall-bot-1');
    assert.equal(result.meeting.status, 'joining');

    const meetings = await store.listNewestFirst();
    assert.equal(meetings.length, 1);
    assert.equal(meetings[0]?.status, 'joining');
    assert.equal(meetings[0]?.recallBotId, 'recall-bot-1');
    assert.equal(meetings[0]?.onJoinMessage, 'Welcome everyone');

    assert.equal(requests.length, 1);
    assert.match(requests[0]?.url ?? '', /\/bot\/$/);
    const body = JSON.parse(String(requests[0]?.init?.body ?? '{}'));
    assert.equal(body.metadata.meeting_type, 'rapat');
    assert.equal(body.metadata.meeting_subject, 'Weekly Coordination');
    assert.equal(body.chat.on_bot_join.message, 'Welcome everyone');
});

test('MeetingController trims onJoinMessage before persisting and sending to Recall', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const config = buildConfig();
    const store = await MeetingStore.create(await createTempDir('meetingbot-controller-trim-'));
    const recallClient = new RecallClient(config, {
        fetchImpl: async (url, init) => {
            requests.push({ url: String(url), init });
            return new Response(JSON.stringify({ id: 'recall-bot-2' }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        },
        jitterMs: () => 0,
        sleep: async () => undefined,
    });
    const controller = new MeetingController(store, recallClient, config);

    await controller.inviteBot({
        meetingUrl: 'https://meet.google.com/abc-defg-hij',
        meetingSubject: 'Weekly Coordination',
        botDisplayName: 'IWKZ Bot',
        meetingType: 'rapat',
        onJoinMessage: '  This meeting is being recorded.  ',
    });

    const meetings = await store.listNewestFirst();
    assert.equal(meetings[0]?.onJoinMessage, 'This meeting is being recorded.');
    const body = JSON.parse(String(requests[0]?.init?.body ?? '{}'));
    assert.equal(body.chat.on_bot_join.message, 'This meeting is being recorded.');
});

test('MeetingController omits chat when onJoinMessage is empty or invalid', async () => {
    const config = buildConfig();

    const emptyInput = buildInviteMeetingInput({
        meetingUrl: 'https://meet.google.com/abc-defg-hij',
        meetingSubject: 'Weekly Coordination',
        botDisplayName: 'IWKZ Bot',
        meetingType: 'rapat',
        onJoinMessage: '   ',
    });
    assert.equal(emptyInput.onJoinMessage, '');

    const invalidInput = buildInviteMeetingInput({
        meetingUrl: 'https://meet.google.com/abc-defg-hij',
        meetingSubject: 'Weekly Coordination',
        botDisplayName: 'IWKZ Bot',
        meetingType: 'rapat',
        onJoinMessage: { text: 'hello' },
    });
    assert.equal(invalidInput.onJoinMessage, '');

    const payload = buildRecallCreateBotPayload(
        emptyInput,
        'job-1',
        config,
        '2026-07-02T12:00:00.000Z',
    );
    assert.equal('chat' in payload, false);
});

test('MeetingController preserves Create Bot behavior when onJoinMessage is missing', async () => {
    const config = buildConfig({
        RECALL_EVERYONE_LEFT_ACTIVATE_AFTER_SECONDS: '0',
    });
    const input = buildInviteMeetingInput({
        meetingUrl: 'https://meet.google.com/abc-defg-hij',
        meetingSubject: 'Weekly Coordination',
        botDisplayName: 'IWKZ Bot',
        meetingType: 'rapat',
    });
    const payload = buildRecallCreateBotPayload(
        input,
        'job-legacy',
        config,
        '2026-07-02T12:00:00.000Z',
    );

    assert.equal(payload.meeting_url, 'https://meet.google.com/abc-defg-hij');
    assert.equal(payload.bot_name, 'IWKZ Bot');
    assert.deepEqual(payload.recording_config, {
        video_mixed_mp4: {},
        participant_events: {},
        meeting_metadata: {},
    });
    assert.equal(payload.automatic_leave.everyone_left_timeout.activate_after, 1);
    assert.equal('chat' in payload, false);
});

test('MeetingController rejects an invalid meeting type before calling Recall', async () => {
    let fetchCalls = 0;
    const config = buildConfig();
    const store = await MeetingStore.create(await createTempDir('meetingbot-invalid-'));
    const recallClient = new RecallClient(config, {
        fetchImpl: async () => {
            fetchCalls += 1;
            return new Response(JSON.stringify({ id: 'unused' }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        },
    });
    const controller = new MeetingController(store, recallClient, config);

    await assert.rejects(
        () =>
            controller.inviteBot({
                meetingUrl: 'https://meet.google.com/abc-defg-hij',
                meetingSubject: 'Weekly Coordination',
                botDisplayName: 'IWKZ Bot',
                meetingType: 'webinar',
            }),
        (error: unknown) => {
            assert.ok(error instanceof MeetingControllerError);
            assert.equal(error.statusCode, 400);
            assert.match(error.message, /meetingType must be either seminar or rapat/);
            return true;
        },
    );

    assert.equal(fetchCalls, 0);
    assert.equal((await store.listNewestFirst()).length, 0);
});

test('MeetingController persists failed state when Recall bot creation fails', async () => {
    const config = buildConfig();
    const store = await MeetingStore.create(await createTempDir('meetingbot-failed-'));
    const recallClient = new RecallClient(config, {
        fetchImpl: async () =>
            new Response('invalid Recall request', {
                status: 400,
            }),
        jitterMs: () => 0,
        sleep: async () => undefined,
    });
    const controller = new MeetingController(store, recallClient, config);

    await assert.rejects(
        () =>
            controller.inviteBot({
                meetingUrl: 'https://meet.google.com/abc-defg-hij',
                meetingSubject: 'Weekly Coordination',
                botDisplayName: 'IWKZ Bot',
                meetingType: 'rapat',
            }),
        (error: unknown) => {
            assert.ok(error instanceof MeetingControllerError);
            assert.equal(error.statusCode, 400);
            assert.match(error.message, /Recall request failed with status 400/);
            return true;
        },
    );

    const meetings = await store.listNewestFirst();
    assert.equal(meetings.length, 1);
    assert.equal(meetings[0]?.status, 'failed');
    assert.match(meetings[0]?.lastError ?? '', /Recall request failed with status 400/);
});

test('MeetingController leaveMeeting calls the correct Recall endpoint', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const config = buildConfig();
    const store = await MeetingStore.create(await createTempDir('meetingbot-leave-'));
    const job = await store.createJob({
        meetingUrl: 'https://meet.google.com/abc-defg-hij',
        meetingSubject: 'Weekly Coordination',
        botDisplayName: 'IWKZ Bot',
        meetingType: 'RAPAT',
        onJoinMessage: '',
        status: 'joining',
    });
    await store.updateJob(job.id, (current) => ({
        ...current,
        recallBotId: 'recall-bot-22',
        status: 'joining',
    }));

    const recallClient = new RecallClient(config, {
        fetchImpl: async (url, init) => {
            requests.push({ url: String(url), init });
            return new Response(null, { status: 204 });
        },
        jitterMs: () => 0,
        sleep: async () => undefined,
    });
    const controller = new MeetingController(
        store,
        recallClient,
        config,
        () => '2026-07-02T12:34:56.000Z',
    );

    const result = await controller.leaveMeeting(job.id);

    assert.equal(result.result, 'ok');
    assert.equal(result.meeting.recallBotId, 'recall-bot-22');
    assert.match(requests[0]?.url ?? '', /\/bot\/recall-bot-22\/leave_call\/$/);
    assert.equal(requests[0]?.init?.method, 'POST');

    const updatedJob = await store.getById(job.id);
    assert.equal(updatedJob?.status, 'leaving');
    assert.equal(updatedJob?.stopRequestedAt, '2026-07-02T12:34:56.000Z');
});

test('MeetingController leaveMeeting is idempotent when Recall says the bot already ended', async () => {
    const config = buildConfig();
    const store = await MeetingStore.create(await createTempDir('meetingbot-ended-'));
    const job = await store.createJob({
        meetingUrl: 'https://meet.google.com/abc-defg-hij',
        meetingSubject: 'Weekly Coordination',
        botDisplayName: 'IWKZ Bot',
        meetingType: 'RAPAT',
        onJoinMessage: '',
        status: 'recording',
    });
    await store.updateJob(job.id, (current) => ({
        ...current,
        recallBotId: 'recall-bot-33',
        status: 'recording',
    }));

    const recallClient = new RecallClient(config, {
        fetchImpl: async () =>
            new Response('bot already left the meeting', {
                status: 409,
            }),
        jitterMs: () => 0,
        sleep: async () => undefined,
    });
    const controller = new MeetingController(store, recallClient, config);

    const result = await controller.leaveMeeting(job.id);

    assert.equal(result.result, 'ok');
    assert.match(result.message, /already ended or left/);
    assert.equal(result.meeting.recallBotId, 'recall-bot-33');
});