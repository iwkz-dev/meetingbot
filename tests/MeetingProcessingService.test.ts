import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { MeetingProcessingService, buildMeetingArtifactBaseName, buildMeetingDriveFolderName, formatTranscriptText } from '../src/MeetingProcessingService';
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
    recordingResponse?: unknown;
    transcriptResponse?: unknown;
    transcriptBody?: string;
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
    const transcriptResponse = options.transcriptResponse ?? {
        data: {
            download_url: 'https://downloads.example/transcript-fallback.json',
        },
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

    const fetchImpl: typeof fetch = async (url) => {
        const value = String(url);
        fetchUrls.push(value);

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
        botDisplayName: 'IWKZ Bot',
        meetingType: options.meetingType ?? 'SEMINAR',
        onJoinMessage: '',
        status: 'uploading',
    });

    const seeded = await store.updateJob(job.id, (current) => ({
        ...current,
        status: 'uploading',
        createdAt: now,
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

test('MeetingProcessingService uploads all artifacts into one meeting folder', async () => {
    const harness = await createHarness({ meetingType: 'SEMINAR' });

    await harness.service.processCompletedMeeting(harness.job.id);

    const updated = await harness.store.getById(harness.job.id);
    assert.equal(updated?.status, 'completed');
    assert.equal(updated?.driveFolder?.name, 'HelloWorld_2026-07-02');
    assert.equal(harness.ensureFolderCalls.length, 1);
    assert.deepEqual(harness.ensureFolderCalls[0], {
        folderName: 'HelloWorld_2026-07-02',
        parentFolderId: harness.config.gdriveFolderSeminar,
    });
    assert.deepEqual(
        harness.uploadCalls.map((call) => call.name),
        [
            '2026-07-02_13-45_HelloWorld_' + harness.job.id.replace(/-/g, '').slice(0, 8) + '.mp4',
            '2026-07-02_13-45_HelloWorld_' + harness.job.id.replace(/-/g, '').slice(0, 8) + '.transcript.json',
            '2026-07-02_13-45_HelloWorld_' + harness.job.id.replace(/-/g, '').slice(0, 8) + '.transcript.txt',
        ],
    );
    assert.ok(harness.uploadCalls[0]?.content.includes('video-chunk'));
    assert.ok(harness.uploadCalls[2]?.content.includes('Alice: Hallo Welt! Tschuss'));
});

test('MeetingProcessingService falls back to transcript endpoint and resumes only missing artifacts', async () => {
    const harness = await createHarness({
        meetingType: 'RAPAT',
        recordingResponse: {
            media_shortcuts: {
                video_mixed: {
                    data: {
                        download_url: 'https://downloads.example/video.mp4',
                    },
                },
            },
        },
    });

    await harness.store.updateJob(harness.job.id, (current) => ({
        ...current,
        driveFolder: {
            id: 'folder-existing',
            name: 'HelloWorld_2026-07-02',
            link: 'https://drive.example/folders/existing',
        },
        videoUpload: {
            id: 'video-existing',
            name: 'existing.mp4',
            link: 'https://drive.example/files/existing.mp4',
        },
    }));

    await harness.service.processCompletedMeeting(harness.job.id);

    const updated = await harness.store.getById(harness.job.id);
    assert.equal(updated?.status, 'completed');
    assert.equal(harness.ensureFolderCalls.length, 0);
    assert.deepEqual(
        harness.uploadCalls.map((call) => path.extname(call.name)),
        ['.json', '.txt'],
    );
    assert.ok(
        harness.fetchUrls.some((url) => url.includes('/transcript/transcript-1/')),
    );
    assert.equal(updated?.videoUpload?.id, 'video-existing');
});

test('MeetingProcessingService marks completed_with_errors when transcript upload fails after video success', async () => {
    const harness = await createHarness({ uploadFailureNameIncludes: '.transcript.txt' });

    await harness.service.processCompletedMeeting(harness.job.id);

    const updated = await harness.store.getById(harness.job.id);
    assert.equal(updated?.status, 'completed_with_errors');
    assert.ok(updated?.videoUpload);
    assert.ok(updated?.transcriptJsonUpload);
    assert.equal(updated?.transcriptTextUpload, null);
    assert.match(updated?.lastError ?? '', /Simulated upload failure/);
});

test('MeetingProcessingService videoOnly mode still uploads video and preserves transcript error', async () => {
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
    assert.match(updated?.lastError ?? '', /Recall transcript failed/);
});

test('MeetingProcessingService resumeInterruptedJobs requeues persisted uploads', async () => {
    const harness = await createHarness();

    const resumedCount = await harness.service.resumeInterruptedJobs();

    const updated = await harness.store.getById(harness.job.id);
    assert.equal(resumedCount, 1);
    assert.equal(updated?.status, 'completed');
    assert.equal(harness.uploadCalls.length, 3);
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
});


