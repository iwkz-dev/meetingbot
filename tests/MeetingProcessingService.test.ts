import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
    MeetingProcessingService,
    buildMeetingArtifactBaseName,
    buildMeetingDriveFolderName,
    collectParticipantNames,
    formatParticipantNamesText,
    formatTranscriptText,
} from '../src/MeetingProcessingService';
import { MeetingStore } from '../src/MeetingStore';
import { RecallClient } from '../src/RecallClient';
import { buildControlPanelState } from '../src/runtimeState';
import { createTempDir, buildConfig } from './helpers';

function createVideoStream(chunks: string[]) {
    return new ReadableStream({
        start(controller) {
            for (const chunk of chunks) {
                controller.enqueue(new TextEncoder().encode(chunk));
            }
            controller.close();
        },
    });
}

async function createHarness(options: {
    meetingType?: 'RAPAT' | 'SEMINAR';
    botDisplayName?: string;
    recordingResponse?: unknown;
    botResponse?: unknown;
    transcriptResponse?: unknown;
    participantEventsResponse?: unknown;
    transcriptBody?: string;
    participantsBody?: string;
    uploadFailureNameIncludes?: string;
    now?: string;
} = {}) {
    const config = buildConfig();
    const store = await MeetingStore.create(await createTempDir('meetingbot-processing-store-'));
    const tempDirRoot = await createTempDir('meetingbot-processing-temp-');
    const uploadCalls: Array<{ name: string; folderId: string; content: string }> = [];
    const ensureFolderCalls: Array<{ folderName: string; parentFolderId: string }> = [];
    const fetchUrls: string[] = [];
    const now = options.now ?? '2026-07-02T13:45:00.000Z';
    const recordingResponse = options.recordingResponse ?? {
        media_shortcuts: {
            video_mixed: {
                data: {
                    download_url: 'https://downloads.example/video.mp4',
                },
            },
            transcript: {
                data: {
                    download_url: 'https://downloads.example/transcript.json',
                },
            },
        },
    };
    const botResponse = options.botResponse ?? {
        recordings: [
            {
                id: 'recording-1',
                media_shortcuts: {
                    participant_events: {
                        data: {
                            participants_download_url: 'https://downloads.example/participants.json',
                        },
                    },
                },
            },
        ],
    };
    const transcriptResponse = options.transcriptResponse ?? {
        data: {
            download_url: 'https://downloads.example/transcript-fallback.json',
        },
    };
    const participantEventsResponse = options.participantEventsResponse ?? {
        results: [
            {
                data: {
                    participants_download_url: 'https://downloads.example/participants-fallback.json',
                },
            },
        ],
    };
    const transcriptBody = options.transcriptBody ?? JSON.stringify({
        entries: [
            {
                participant: { name: 'Alice' },
                words: [
                    { text: 'Hallo', start: 0 },
                    { punctuated_word: 'Welt!', start: 1 },
                ],
            },
            {
                participant: { name: 'Alice' },
                words: [{ text: 'Tschuss', start: 2 }],
            },
            {
                participant: { name: 'Bob' },
                words: [{ text: 'Guten', start: 5 }, { text: 'Tag', start: 6 }],
            },
        ],
    });
    const participantsBody = options.participantsBody ?? JSON.stringify([
        { id: 1, name: 'Alice', is_host: true, platform: 'desktop', extra_data: null, email: null },
        { id: 2, name: 'Bob', is_host: false, platform: 'desktop', extra_data: null, email: null },
        { id: 3, name: options.botDisplayName ?? 'IWKZ Bot', is_host: false, platform: 'desktop', extra_data: null, email: null },
    ]);

    const fetchImpl: typeof fetch = async (url) => {
        const value = String(url);
        fetchUrls.push(value);

        if (value.includes('/bot/')) {
            return new Response(JSON.stringify(botResponse), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        if (value.includes('/participant_events/')) {
            return new Response(JSON.stringify(participantEventsResponse), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        if (value.includes('/recording/')) {
            return new Response(JSON.stringify(recordingResponse), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        if (value.includes('/transcript/')) {
            return new Response(JSON.stringify(transcriptResponse), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        if (value.endsWith('/video.mp4')) {
            return new Response(createVideoStream(['video-', 'chunk']), {
                status: 200,
                headers: { 'Content-Type': 'video/mp4' },
            });
        }

        if (value.includes('participants')) {
            return new Response(participantsBody, {
                status: 200,
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': String(Buffer.byteLength(participantsBody, 'utf8')),
                },
            });
        }

        if (value.includes('transcript')) {
            return new Response(transcriptBody, {
                status: 200,
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': String(Buffer.byteLength(transcriptBody, 'utf8')),
                },
            });
        }

        throw new Error(`Unexpected fetch URL: ${value}`);
    };

    const recallClient = new RecallClient(config, {
        fetchImpl,
        jitterMs: () => 0,
        sleep: async () => undefined,
    });

    const service = new MeetingProcessingService(store, recallClient, config, {
        fetchImpl,
        now: () => now,
        tempDirRoot,
        gdriveClient: {
            ensureMeetingFolder: async (folderName, parentFolderId) => {
                ensureFolderCalls.push({ folderName, parentFolderId });
                return {
                    id: `${parentFolderId}-${folderName}`,
                    name: folderName,
                    link: `https://drive.example/folders/${folderName}`,
                };
            },
            uploadFile: async (finalFileName, localFilePath, folderId) => {
                if (
                    options.uploadFailureNameIncludes &&
                    finalFileName.includes(options.uploadFailureNameIncludes)
                ) {
                    throw new Error(`Simulated upload failure for ${finalFileName}`);
                }

                const content = await fs.promises.readFile(localFilePath, 'utf8');
                uploadCalls.push({
                    name: finalFileName,
                    folderId,
                    content,
                });
                return {
                    id: `${folderId}-${finalFileName}`,
                    name: finalFileName,
                    link: `https://drive.example/files/${finalFileName}`,
                };
            },
        },
    });

    const job = await store.createJob({
        meetingUrl: 'https://meet.google.com/abc-defg-hij',
        meetingSubject: 'HelloWorld',
        botDisplayName: options.botDisplayName ?? 'IWKZ Bot',
        meetingType: options.meetingType ?? 'SEMINAR',
        onJoinMessage: '',
        status: 'uploading',
    });

    const seeded = await store.updateJob(job.id, (current) => ({
        ...current,
        status: 'uploading',
        createdAt: now,
        recallBotId: 'bot-1',
        recallRecordingId: 'recording-1',
        recallTranscriptId: 'transcript-1',
        processingStartedAt: current.processingStartedAt ?? now,
        artifactProcessingMode: 'full',
    }));

    return {
        config,
        store,
        service,
        job: seeded ?? job,
        uploadCalls,
        ensureFolderCalls,
        fetchUrls,
        tempDirRoot,
    };
}

test('buildMeetingArtifactBaseName is deterministic and sanitized', () => {
    const result = buildMeetingArtifactBaseName({
        id: '12345678-90ab-cdef-1234-567890abcdef',
        createdAt: '2026-07-02T13:45:00.000Z',
        meetingSubject: 'Quarterly Review: DACH / Nord',
    });

    assert.equal(result, '2026-07-02_13-45_Quarterly_Review_DACH_Nord_12345678');
});

test('buildMeetingDriveFolderName uses subject and meeting date', () => {
    const result = buildMeetingDriveFolderName({
        createdAt: '2026-07-02T13:45:00.000Z',
        meetingSubject: 'HelloWorld',
    });

    assert.equal(result, 'HelloWorld_2026-07-02');
});

test('formatTranscriptText groups adjacent speaker entries and preserves text', () => {
    const result = formatTranscriptText({
        entries: [
            {
                participant: { name: 'Alice' },
                words: [
                    { text: 'Guten', start: 0 },
                    { punctuated_word: 'Morgen!', start: 1 },
                ],
            },
            {
                participant: { name: 'Alice' },
                words: [{ text: 'Wie', start: 2 }, { text: 'gehts', start: 3 }],
            },
            {
                words: [{ text: 'Hallo', start: 8 }],
            },
        ],
    });

    assert.equal(
        result,
        '[00:00:00] Alice: Guten Morgen! Wie gehts\n\n[00:00:08] Unknown Speaker: Hallo',
    );
});

test('collectParticipantNames normalizes whitespace, excludes bot, deduplicates, retains host, and sorts', () => {
    const result = collectParticipantNames(
        [
            { id: 1, name: '  bob  ' },
            { id: 2, name: 'Alice' },
            { id: 3, name: 'IWKZ   Bot' },
            { id: 4, name: 'alice' },
            { id: 5, name: 'Carol   Ann', is_host: true },
            { id: 6, name: null },
            { id: 7, name: '   ' },
            { id: 8, name: 'Bob' },
        ],
        '  IWKZ Bot ',
    );

    assert.deepEqual(result, ['Alice', 'bob', 'Carol Ann']);
});

test('formatParticipantNamesText returns empty output or newline-terminated names only', () => {
    assert.equal(formatParticipantNamesText([], 'IWKZ Bot'), '');
    assert.equal(
        formatParticipantNamesText(
            [
                { id: 1, name: 'Zed' },
                { id: 2, name: 'Alpha' },
            ],
            'IWKZ Bot',
        ),
        'Alpha\nZed\n',
    );
});

test('MeetingProcessingService uploads all artifacts into one meeting folder', async () => {
    const harness = await createHarness({ meetingType: 'SEMINAR' });

    await harness.service.processCompletedMeeting(harness.job.id);

    const updated = await harness.store.getById(harness.job.id);
    assert.equal(updated?.status, 'completed');
    assert.equal(updated?.driveFolder?.name, 'HelloWorld_2026-07-02');
    assert.equal(updated?.participantArtifactStatus, 'done');
    assert.equal(harness.ensureFolderCalls.length, 1);
    assert.deepEqual(harness.ensureFolderCalls[0], {
        folderName: 'HelloWorld_2026-07-02',
        parentFolderId: harness.config.gdriveFolderSeminar,
    });
    assert.deepEqual(
        harness.uploadCalls.map((call) => path.extname(call.name)),
        ['.mp4', '.json', '.txt', '.json', '.txt'],
    );
    assert.ok(harness.uploadCalls[3]?.content.includes('"name": "Alice"'));
    assert.equal(harness.uploadCalls[4]?.content, 'Alice\nBob\n');
});

test('MeetingProcessingService selects recording by ID and uses participants download URL', async () => {
    const harness = await createHarness({
        botResponse: {
            recordings: [
                {
                    id: 'recording-other',
                    media_shortcuts: {
                        participant_events: {
                            data: {
                                participants_download_url: 'https://downloads.example/participants-wrong.json',
                            },
                        },
                    },
                },
                {
                    id: 'recording-1',
                    media_shortcuts: {
                        participant_events: {
                            data: {
                                participants_download_url: 'https://downloads.example/participants-right.json',
                            },
                        },
                    },
                },
            ],
        },
    });

    await harness.service.processCompletedMeeting(harness.job.id);

    assert.ok(harness.fetchUrls.some((url) => url.includes('/bot/bot-1/')));
    assert.ok(harness.fetchUrls.some((url) => url.includes('participants-right.json')));
    assert.equal(harness.fetchUrls.some((url) => url.includes('participants-wrong.json')), false);
});

test('MeetingProcessingService falls back to participant events endpoint when bot shortcut is unavailable', async () => {
    const harness = await createHarness({
        botResponse: {
            recordings: [
                {
                    id: 'recording-1',
                },
            ],
        },
    });

    await harness.service.processCompletedMeeting(harness.job.id);

    assert.ok(
        harness.fetchUrls.some((url) => url.includes('/participant_events/?recording_id=recording-1')),
    );
    const updated = await harness.store.getById(harness.job.id);
    assert.equal(updated?.participantArtifactStatus, 'done');
});

test('MeetingProcessingService marks participant artifacts pending when no URL is available', async () => {
    const harness = await createHarness({
        botResponse: {
            recordings: [{ id: 'recording-1' }],
        },
        participantEventsResponse: {
            results: [{}],
        },
    });

    await harness.service.processCompletedMeeting(harness.job.id);

    const updated = await harness.store.getById(harness.job.id);
    assert.equal(updated?.status, 'completed_with_errors');
    assert.equal(updated?.participantArtifactStatus, 'pending');
    assert.match(updated?.participantArtifactError ?? '', /participants download URL/);
    assert.equal(updated?.participantJsonUpload, null);
    assert.equal(updated?.participantTextUpload, null);
    assert.deepEqual(
        harness.uploadCalls.map((call) => path.extname(call.name)),
        ['.mp4', '.json', '.txt'],
    );
});

test('MeetingProcessingService malformed participant payload only fails participant processing', async () => {
    const harness = await createHarness({
        participantsBody: '{}',
    });

    await harness.service.processCompletedMeeting(harness.job.id);

    const updated = await harness.store.getById(harness.job.id);
    assert.equal(updated?.status, 'completed_with_errors');
    assert.equal(updated?.participantArtifactStatus, 'failed');
    assert.match(updated?.participantArtifactError ?? '', /JSON array/);
    assert.ok(updated?.videoUpload);
    assert.ok(updated?.transcriptJsonUpload);
    assert.ok(updated?.transcriptTextUpload);
    assert.equal(updated?.participantJsonUpload, null);
    assert.equal(updated?.participantTextUpload, null);
});

test('MeetingProcessingService reprocessing is idempotent for participant uploads', async () => {
    const harness = await createHarness();

    await harness.service.processCompletedMeeting(harness.job.id);
    await harness.service.processCompletedMeeting(harness.job.id);

    assert.equal(harness.uploadCalls.length, 5);
});

test('MeetingProcessingService videoOnly mode still uploads video and participant artifacts', async () => {
    const harness = await createHarness();

    await harness.store.updateJob(harness.job.id, (current) => ({
        ...current,
        artifactProcessingMode: 'video_only',
        lastError: 'Recall transcript failed',
        recallTranscriptId: null,
    }));

    await harness.service.processCompletedMeeting(harness.job.id, { videoOnly: true });

    const updated = await harness.store.getById(harness.job.id);
    assert.equal(updated?.status, 'completed_with_errors');
    assert.ok(updated?.videoUpload);
    assert.equal(updated?.transcriptJsonUpload, null);
    assert.equal(updated?.transcriptTextUpload, null);
    assert.ok(updated?.participantJsonUpload);
    assert.ok(updated?.participantTextUpload);
});

test('MeetingProcessingService resumeInterruptedJobs requeues persisted uploads', async () => {
    const harness = await createHarness();

    const resumedCount = await harness.service.resumeInterruptedJobs();

    const updated = await harness.store.getById(harness.job.id);
    assert.equal(resumedCount, 1);
    assert.equal(updated?.status, 'completed');
    assert.equal(harness.uploadCalls.length, 5);
});

test('buildControlPanelState exposes artifact links and hides processing internals', async () => {
    const harness = await createHarness();
    await harness.service.processCompletedMeeting(harness.job.id);
    const meeting = await harness.store.getById(harness.job.id);
    assert.ok(meeting);

    const state = buildControlPanelState({
        meetings: [meeting],
        stats: {
            activeMeetings: 0,
            completedMeetings: 1,
            failedMeetings: 0,
            lastStartedAt: meeting.createdAt,
            lastFinishedAt: meeting.completedAt,
            lastError: null,
        },
    });

    assert.equal(state.meetings[0]?.videoUpload?.link?.startsWith('https://drive.example/files/'), true);
    assert.equal('artifactProcessingMode' in (state.meetings[0] ?? {}), false);
    assert.equal('participantArtifactStatus' in (state.meetings[0] ?? {}), false);
});
