import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { buildMeetingArtifactBaseName } from '../src/MeetingProcessingService';
import { MeetingStore } from '../src/MeetingStore';
import { OpenAIContentGenerationService } from '../src/openai/OpenAIContentGenerationService';
import { MeetingJob } from '../src/types';
import { buildConfig, createTempDir } from './helpers';

type HarnessOptions = {
    meetingType?: 'SEMINAR' | 'RAPAT';
    transcriptText?: string;
    participantText?: string;
    openaiInputTokens?: number;
    openaiOutputText?: string;
    countImpl?: (params: Record<string, unknown>) => Promise<{ input_tokens: number }>;
    createImpl?: (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
    findFileResult?: { id: string; name: string; link: string } | null;
    downloadTextById?: Record<string, string>;
    deleteShouldFail?: boolean;
    configOverrides?: Record<string, string | undefined>;
};

async function createHarness(options: HarnessOptions = {}) {
    const config = buildConfig({
        OPENAI_API_KEY: 'sk-secret-123',
        ...(options.configOverrides ?? {}),
    });
    const store = await MeetingStore.create(await createTempDir('meetingbot-openai-store-'));
    const tempDir = await createTempDir('meetingbot-openai-temp-');
    const meeting = await store.createJob({
        meetingUrl: 'https://meet.google.com/abc-defg-hij',
        meetingSubject: 'Prompt 2 Review',
        botDisplayName: 'IWKZ Bot',
        meetingType: options.meetingType ?? 'SEMINAR',
        onJoinMessage: '',
        status: 'uploading',
    });
    const readyMeeting = await store.updateJob(meeting.id, (current) => ({
        ...current,
        driveFolder: {
            id: 'folder-1',
            name: 'Prompt 2 Review_2026-07-03',
            link: 'https://drive.example/folders/folder-1',
        },
        transcriptTextUpload: {
            id: 'transcript-drive-1',
            name: 'source.transcript.txt',
            link: 'https://drive.example/files/transcript-drive-1',
        },
        participantTextUpload:
            (options.meetingType ?? 'SEMINAR') === 'RAPAT'
                ? {
                      id: 'participants-drive-1',
                      name: 'source.participants.txt',
                      link: 'https://drive.example/files/participants-drive-1',
                  }
                : null,
    }));
    assert.ok(readyMeeting);
    const readyMeetingRecord: MeetingJob = readyMeeting;
    const baseName = buildMeetingArtifactBaseName(readyMeetingRecord);
    const transcriptPath = path.join(tempDir, `${baseName}.transcript.txt`);
    const participantPath = path.join(tempDir, `${baseName}.participants.txt`);

    if (options.transcriptText !== undefined) {
        await fs.promises.writeFile(transcriptPath, options.transcriptText, 'utf8');
    }

    if (options.participantText !== undefined) {
        await fs.promises.writeFile(participantPath, options.participantText, 'utf8');
    }

    const uploadCalls: Array<{ fileName: string; content: string }> = [];
    const findFileCalls: Array<{ fileName: string; folderId: string }> = [];
    const countCalls: Record<string, unknown>[] = [];
    const responseCalls: Record<string, unknown>[] = [];
    const createdOpenAiFiles: string[] = [];
    const deletedOpenAiFiles: string[] = [];
    let uploadCounter = 0;

    const openaiClient = {
        files: {
            create: async () => {
                const id = `openai-file-${createdOpenAiFiles.length + 1}`;
                createdOpenAiFiles.push(id);
                return { id };
            },
            delete: async (fileId: string) => {
                deletedOpenAiFiles.push(fileId);
                if (options.deleteShouldFail) {
                    throw new Error('cleanup failed');
                }
                return { id: fileId, deleted: true, object: 'file' as const };
            },
        },
        responses: {
            inputTokens: {
                count: async (params: Record<string, unknown>) => {
                    countCalls.push(params);
                    if (options.countImpl) {
                        return options.countImpl(params);
                    }
                    return { input_tokens: options.openaiInputTokens ?? 1200 };
                },
            },
            create: async (params: Record<string, unknown>) => {
                responseCalls.push(params);
                if (options.createImpl) {
                    return options.createImpl(params);
                }
                return {
                    id: 'resp-1',
                    _request_id: 'req-1',
                    status: 'completed',
                    output_text: options.openaiOutputText ?? '# Heading\r\nBody',
                    usage: {
                        input_tokens: options.openaiInputTokens ?? 1200,
                        output_tokens: 321,
                    },
                };
            },
        },
    };

    const gdriveClient = {
        uploadFile: async (fileName: string, localFilePath: string) => {
            uploadCounter += 1;
            const content = await fs.promises.readFile(localFilePath, 'utf8');
            uploadCalls.push({ fileName, content });
            return {
                id: `drive-output-${uploadCounter}`,
                name: fileName,
                link: `https://drive.example/files/${fileName}`,
            };
        },
        findFileByName: async (fileName: string, folderId: string) => {
            findFileCalls.push({ fileName, folderId });
            return options.findFileResult ?? null;
        },
        downloadTextFile: async (fileId: string) => {
            const text = options.downloadTextById?.[fileId];
            if (text === undefined) {
                throw new Error(`No download text stub for ${fileId}`);
            }
            return text;
        },
    };

    const service = new OpenAIContentGenerationService(config, {
        openaiClient: openaiClient as any,
        gdriveClient,
        logger: {
            info: () => undefined,
            warn: () => undefined,
            error: () => undefined,
        },
        now: () => '2026-07-03T10:00:00.000Z',
    });

    return {
        config,
        store,
        service,
        meeting: readyMeetingRecord,
        baseName,
        tempDir,
        transcriptPath,
        participantPath,
        uploadCalls,
        findFileCalls,
        countCalls,
        responseCalls,
        createdOpenAiFiles,
        deletedOpenAiFiles,
    };
}

async function runGeneration(harness: Awaited<ReturnType<typeof createHarness>>) {
    await harness.service.generateForMeeting({
        meeting: harness.meeting,
        baseName: harness.baseName,
        driveFolderId: 'folder-1',
        tempDir: harness.tempDir,
        transcriptTextPath: harness.transcriptPath,
        participantTextPath: harness.participantPath,
        persistAiState: (updater) =>
            harness.store.updateJob(harness.meeting.id, (current) => ({
                ...current,
                aiContent: updater(current.aiContent),
            })),
    });

    return harness.store.getById(harness.meeting.id);
}

test('OpenAIContentGenerationService generates seminar blog markdown using input_file requests', async () => {
    const transcriptText = '[00:00:00] Speaker: unique seminar transcript text';
    const harness = await createHarness({ transcriptText });
    const updated = await runGeneration(harness);

    assert.equal(updated?.aiContent.status, 'done');
    assert.equal(updated?.aiContent.driveFileId, 'drive-output-1');
    assert.equal(updated?.aiContent.outputFilename, `${harness.baseName}.blog.md`);
    assert.equal(updated?.aiContent.inputTokens, 1200);
    assert.equal(updated?.aiContent.outputTokens, 321);
    assert.deepEqual(updated?.aiContent.openaiInputFileIds, []);
    assert.equal(harness.uploadCalls[0]?.fileName, `${harness.baseName}.blog.md`);
    assert.equal(harness.uploadCalls[0]?.content, '# Heading\nBody\n');
    assert.equal(harness.countCalls.length, 1);
    assert.equal(harness.responseCalls.length, 1);
    assert.equal(JSON.stringify(harness.countCalls[0]).includes(transcriptText), false);
    assert.equal(JSON.stringify(harness.responseCalls[0]).includes(transcriptText), false);
    assert.deepEqual((harness.responseCalls[0]?.tools as unknown[]) ?? [], []);
    assert.equal(harness.responseCalls[0]?.store, false);
    assert.equal(harness.responseCalls[0]?.truncation, 'disabled');
    const responseInput = harness.responseCalls[0]?.input as Array<Record<string, unknown>>;
    assert.equal(responseInput[0]?.role, 'user');
    assert.equal(((responseInput[0]?.content as Array<Record<string, unknown>>) ?? []).length, 1);
    assert.deepEqual(harness.deletedOpenAiFiles, ['openai-file-1']);
});

test('OpenAIContentGenerationService generates rapat notes with transcript and participant input files', async () => {
    const harness = await createHarness({
        meetingType: 'RAPAT',
        transcriptText: '[00:00:00] Speaker: rapat transcript',
        downloadTextById: {
            'participants-drive-1': '',
        },
    });
    const updated = await runGeneration(harness);

    assert.equal(updated?.aiContent.status, 'done');
    assert.equal(updated?.aiContent.outputFilename, `${harness.baseName}.meeting-notes.md`);
    assert.equal(harness.createdOpenAiFiles.length, 2);
    const responseInput = harness.responseCalls[0]?.input as Array<Record<string, unknown>>;
    assert.equal(((responseInput[0]?.content as Array<Record<string, unknown>>) ?? []).length, 2);
});

test('OpenAIContentGenerationService skips OpenAI when the output file already exists in Drive', async () => {
    const harness = await createHarness({
        transcriptText: 'seminar transcript',
        findFileResult: {
            id: 'drive-existing-1',
            name: 'existing.blog.md',
            link: 'https://drive.example/files/existing.blog.md',
        },
    });
    const updated = await runGeneration(harness);

    assert.equal(updated?.aiContent.status, 'done');
    assert.equal(updated?.aiContent.driveFileId, 'drive-existing-1');
    assert.equal(harness.countCalls.length, 0);
    assert.equal(harness.responseCalls.length, 0);
    assert.equal(harness.uploadCalls.length, 0);
});

test('OpenAIContentGenerationService recovers source text from Drive when local files are unavailable', async () => {
    const harness = await createHarness({
        downloadTextById: {
            'transcript-drive-1': 'Recovered\r\ntranscript',
        },
    });
    const updated = await runGeneration(harness);

    assert.equal(updated?.aiContent.status, 'done');
    assert.equal(harness.responseCalls.length, 1);
    assert.deepEqual(harness.deletedOpenAiFiles, ['openai-file-1']);
});

test('OpenAIContentGenerationService blocks oversized token contexts before response generation', async () => {
    const harness = await createHarness({
        transcriptText: 'seminar transcript',
        openaiInputTokens: 999999,
        configOverrides: {
            OPENAI_DIRECT_MAX_INPUT_TOKENS: '100',
        },
    });
    const updated = await runGeneration(harness);

    assert.equal(updated?.aiContent.status, 'failed');
    assert.equal(updated?.aiContent.errorCode, 'OPENAI_INPUT_CONTEXT_TOO_LARGE');
    assert.equal(harness.responseCalls.length, 0);
    assert.equal(harness.uploadCalls.length, 0);
    assert.deepEqual(harness.deletedOpenAiFiles, ['openai-file-1']);
});

test('OpenAIContentGenerationService rejects empty transcript content after normalization', async () => {
    const harness = await createHarness({
        downloadTextById: {
            'transcript-drive-1': '\u0000\r\n\r\n',
        },
    });
    const updated = await runGeneration(harness);

    assert.equal(updated?.aiContent.status, 'failed');
    assert.equal(updated?.aiContent.errorCode, 'OPENAI_EMPTY_TRANSCRIPT');
    assert.equal(harness.createdOpenAiFiles.length, 0);
});

test('OpenAIContentGenerationService rejects blank model output', async () => {
    const harness = await createHarness({
        transcriptText: 'seminar transcript',
        openaiOutputText: '   \r\n  ',
    });
    const updated = await runGeneration(harness);

    assert.equal(updated?.aiContent.status, 'failed');
    assert.equal(updated?.aiContent.errorCode, 'OPENAI_EMPTY_OUTPUT');
    assert.equal(harness.uploadCalls.length, 0);
});

test('OpenAIContentGenerationService cleanup failures do not undo successful uploads', async () => {
    const harness = await createHarness({
        transcriptText: 'seminar transcript',
        deleteShouldFail: true,
    });
    const updated = await runGeneration(harness);

    assert.equal(updated?.aiContent.status, 'done');
    assert.equal(updated?.aiContent.driveFileId, 'drive-output-1');
    assert.deepEqual(updated?.aiContent.openaiInputFileIds, ['openai-file-1']);
});

test('OpenAIContentGenerationService sanitizes AI errors before persistence', async () => {
    const harness = await createHarness({
        transcriptText: 'seminar transcript',
        createImpl: async () => {
            throw new Error('request failed for sk-secret-123');
        },
    });
    const updated = await runGeneration(harness);

    assert.equal(updated?.aiContent.status, 'pending');
    assert.equal(updated?.aiContent.errorCode, 'OPENAI_SERVER_ERROR');
    assert.equal(updated?.aiContent.errorMessage?.includes('sk-secret-123'), false);
});
