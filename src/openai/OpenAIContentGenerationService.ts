import fs from 'node:fs';
import path from 'node:path';
import {
    APIConnectionError,
    APIConnectionTimeoutError,
    AuthenticationError,
    InternalServerError,
    NotFoundError,
    OpenAI,
    PermissionDeniedError,
    RateLimitError,
} from 'openai';
import { AppConfig, getConfig } from '../config';
import { DriveArtifact, MeetingJob } from '../types';
import { renderAgentPrompt } from './AgentPromptService';
import {
    hasRequiredAiSourceArtifacts,
    meetingTypeToOutputSuffix,
    sanitizeAiErrorMessage,
} from './AiContent';
import { getOpenAIClient } from './OpenAIClient';

const MAX_OPENAI_INPUT_BYTES = 48 * 1024 * 1024;
const TRANSCRIPT_SOURCE_SUFFIX = '.transcript.txt';
const PARTICIPANT_SOURCE_SUFFIX = '.participants.txt';

type AiLogger = {
    info: (message: string, metadata?: unknown) => void;
    warn: (message: string, metadata?: unknown) => void;
    error: (message: string, metadata?: unknown) => void;
};

type OpenAIFileLike = {
    id: string;
};

type OpenAIResponseLike = {
    id: string;
    output_text: string;
    status?: string | null;
    incomplete_details?: { reason?: string | null } | null;
    usage?: {
        input_tokens: number;
        output_tokens: number;
    } | null;
    _request_id?: string | null;
};

type OpenAIClientLike = Pick<OpenAI, 'files' | 'responses'>;

type DriveAiClient = {
    uploadFile: (finalFileName: string, localFilePath: string, folderId: string) => Promise<DriveArtifact>;
    findFileByName?: (fileName: string, folderId: string) => Promise<DriveArtifact | null>;
    downloadTextFile?: (fileId: string) => Promise<string>;
};

type PersistAiState = (
    updater: (aiContent: MeetingJob['aiContent']) => MeetingJob['aiContent'],
) => Promise<MeetingJob | null>;

type GenerateAiContentArgs = {
    meeting: MeetingJob;
    baseName: string;
    driveFolderId: string;
    tempDir: string;
    transcriptTextPath?: string;
    participantTextPath?: string;
    persistAiState: PersistAiState;
};

type OpenAIContentGenerationDependencies = {
    openaiClient?: OpenAIClientLike;
    gdriveClient: DriveAiClient;
    logger?: AiLogger;
    now?: () => string;
};

type MaterializedSourceFile = {
    localPath: string;
    fileName: string;
    byteSize: number;
};

export class OpenAIContentGenerationService {
    private readonly openaiClient: OpenAIClientLike;
    private readonly logger: AiLogger;
    private readonly now: () => string;

    constructor(
        private readonly config: Pick<
            AppConfig,
            | 'openaiModel'
            | 'openaiMaxOutputTokens'
            | 'openaiFileExpirySeconds'
            | 'openaiDirectMaxInputTokens'
            | 'aiDateTimezone'
            | 'openaiApiKey'
            | 'openaiTimeoutMs'
            | 'openaiMaxRetries'
        > = getConfig(),
        private readonly dependencies: OpenAIContentGenerationDependencies,
    ) {
        this.openaiClient = dependencies.openaiClient ?? getOpenAIClient(config);
        this.logger = dependencies.logger ?? console;
        this.now = dependencies.now ?? (() => new Date().toISOString());
    }

    async generateForMeeting(args: GenerateAiContentArgs): Promise<void> {
        if (!hasRequiredAiSourceArtifacts(args.meeting)) {
            return;
        }

        const outputFilename =
            args.meeting.aiContent.outputFilename ??
            `${args.baseName}${meetingTypeToOutputSuffix(args.meeting.meetingType)}`;

        if (args.meeting.aiContent.driveFileId) {
            await this.persistDoneState(args, args.meeting.aiContent.driveFileId, outputFilename, {
                completedAt: args.meeting.aiContent.completedAt ?? this.now(),
            });
            return;
        }

        const generationDateIso = await this.ensurePendingState(args, outputFilename);
        const existingDriveArtifact = await this.findExistingDriveArtifact(
            outputFilename,
            args.driveFolderId,
        );
        if (existingDriveArtifact) {
            await this.persistDoneState(args, existingDriveArtifact.id, outputFilename, {
                completedAt: this.now(),
            });
            return;
        }

        const startedMeeting = await args.persistAiState((aiContent) => ({
            ...aiContent,
            status: 'processing',
            outputFilename,
            generationDateIso: aiContent.generationDateIso ?? generationDateIso,
            attemptCount: aiContent.attemptCount + 1,
            lastAttemptAt: this.now(),
            completedAt: null,
            openaiResponseId: null,
            openaiRequestId: null,
            inputTokens: null,
            outputTokens: null,
            openaiInputFileIds: [],
            errorCode: null,
            errorMessage: null,
        }));

        const activeMeeting = startedMeeting ?? args.meeting;
        const openaiFileIds: string[] = [];
        let generationSucceeded = false;

        try {
            const sources = await this.materializeSourceFiles({
                meeting: activeMeeting,
                baseName: args.baseName,
                tempDir: args.tempDir,
                transcriptTextPath: args.transcriptTextPath,
                participantTextPath: args.participantTextPath,
            });
            const totalBytes = sources.reduce((sum, source) => sum + source.byteSize, 0);
            if (totalBytes > MAX_OPENAI_INPUT_BYTES) {
                throw new AiGenerationFailure(
                    'OPENAI_INPUT_FILES_TOO_LARGE',
                    `Combined AI input files are ${totalBytes} bytes, exceeding the 48 MiB limit.`,
                    false,
                );
            }

            for (const source of sources) {
                const uploaded = await this.openaiClient.files.create({
                    file: fs.createReadStream(source.localPath),
                    purpose: 'user_data',
                    expires_after: {
                        anchor: 'created_at',
                        seconds: this.config.openaiFileExpirySeconds,
                    },
                });
                openaiFileIds.push(uploaded.id);
                await args.persistAiState((aiContent) => ({
                    ...aiContent,
                    openaiInputFileIds: [...openaiFileIds],
                }));
                this.logger.info('OpenAI input file uploaded', {
                    meetingId: activeMeeting.id,
                    kind: activeMeeting.aiContent.kind,
                    fileName: source.fileName,
                    byteSize: source.byteSize,
                    openaiFileId: uploaded.id,
                });
            }

            const renderedPrompt = await renderAgentPrompt(
                {
                    meetingType: toLowerMeetingType(activeMeeting.meetingType),
                    generationDate: new Date(generationDateIso),
                },
                {
                    config: { aiDateTimezone: this.config.aiDateTimezone },
                },
            );
            const input = buildResponseInput(openaiFileIds);
            const tokenCount = await this.openaiClient.responses.inputTokens.count({
                model: this.config.openaiModel,
                instructions: renderedPrompt.instructions,
                input,
                truncation: 'disabled',
                tools: [],
            });

            await args.persistAiState((aiContent) => ({
                ...aiContent,
                inputTokens: tokenCount.input_tokens,
            }));

            if (tokenCount.input_tokens > this.config.openaiDirectMaxInputTokens) {
                throw new AiGenerationFailure(
                    'OPENAI_INPUT_CONTEXT_TOO_LARGE',
                    `AI input token count ${tokenCount.input_tokens} exceeds configured limit ${this.config.openaiDirectMaxInputTokens}.`,
                    false,
                );
            }

            const response = (await this.openaiClient.responses.create({
                model: this.config.openaiModel,
                instructions: renderedPrompt.instructions,
                input,
                max_output_tokens: this.config.openaiMaxOutputTokens,
                store: false,
                truncation: 'disabled',
                tools: [],
            })) as OpenAIResponseLike;

            await args.persistAiState((aiContent) => ({
                ...aiContent,
                openaiResponseId: response.id,
                openaiRequestId:
                    typeof response._request_id === 'string' && response._request_id.trim()
                        ? response._request_id.trim()
                        : null,
                outputTokens:
                    typeof response.usage?.output_tokens === 'number'
                        ? response.usage.output_tokens
                        : aiContent.outputTokens,
            }));

            if (
                response.status === 'incomplete' &&
                response.incomplete_details?.reason === 'max_output_tokens'
            ) {
                throw new AiGenerationFailure(
                    'OPENAI_OUTPUT_TRUNCATED',
                    'OpenAI response was incomplete because max_output_tokens was reached.',
                    true,
                );
            }

            const markdown = normalizeGeneratedMarkdown(response.output_text);
            if (!markdown) {
                throw new AiGenerationFailure(
                    'OPENAI_EMPTY_OUTPUT',
                    'OpenAI response output_text was blank.',
                    false,
                );
            }

            const alreadyUploaded = await this.findExistingDriveArtifact(
                outputFilename,
                args.driveFolderId,
            );
            if (alreadyUploaded) {
                await this.persistDoneState(args, alreadyUploaded.id, outputFilename, {
                    openaiResponseId: response.id,
                    openaiRequestId:
                        typeof response._request_id === 'string' && response._request_id.trim()
                            ? response._request_id.trim()
                            : null,
                    outputTokens:
                        typeof response.usage?.output_tokens === 'number'
                            ? response.usage.output_tokens
                            : null,
                    completedAt: this.now(),
                });
                generationSucceeded = true;
                return;
            }

            const outputPath = path.join(args.tempDir, outputFilename);
            await fs.promises.writeFile(outputPath, markdown, 'utf8');

            let uploadedMarkdown: DriveArtifact;
            try {
                uploadedMarkdown = await this.dependencies.gdriveClient.uploadFile(
                    outputFilename,
                    outputPath,
                    args.driveFolderId,
                );
            } catch (error) {
                throw new AiGenerationFailure(
                    'OPENAI_DRIVE_UPLOAD_FAILED',
                    error,
                    true,
                );
            }

            await this.persistDoneState(args, uploadedMarkdown.id, outputFilename, {
                openaiResponseId: response.id,
                openaiRequestId:
                    typeof response._request_id === 'string' && response._request_id.trim()
                        ? response._request_id.trim()
                        : null,
                inputTokens: tokenCount.input_tokens,
                outputTokens:
                    typeof response.usage?.output_tokens === 'number'
                        ? response.usage.output_tokens
                        : null,
                completedAt: this.now(),
            });
            generationSucceeded = true;
        } catch (error) {
            const failure = classifyAiGenerationError(error);
            await args.persistAiState((aiContent) => ({
                ...aiContent,
                status: failure.retryable ? 'pending' : 'failed',
                outputFilename,
                generationDateIso: aiContent.generationDateIso ?? generationDateIso,
                errorCode: failure.code,
                errorMessage: sanitizeAiErrorMessage(failure.message),
                completedAt: null,
            }));
            this.logger.error('AI content generation failed', {
                meetingId: activeMeeting.id,
                kind: activeMeeting.aiContent.kind,
                code: failure.code,
                retryable: failure.retryable,
                error: sanitizeAiErrorMessage(failure.message),
            });
        } finally {
            const cleanupCleared = await this.cleanupOpenAiFiles(openaiFileIds, activeMeeting.id);
            if (cleanupCleared) {
                await args.persistAiState((aiContent) => ({
                    ...aiContent,
                    openaiInputFileIds: [],
                }));
            }

            if (generationSucceeded) {
                this.logger.info('AI content generation completed', {
                    meetingId: activeMeeting.id,
                    kind: activeMeeting.aiContent.kind,
                    outputFilename,
                });
            }
        }
    }

    private async materializeSourceFiles(args: {
        meeting: MeetingJob;
        baseName: string;
        tempDir: string;
        transcriptTextPath?: string;
        participantTextPath?: string;
    }): Promise<MaterializedSourceFile[]> {
        const sources: MaterializedSourceFile[] = [];
        sources.push(
            await this.resolveSourceFile({
                kind: 'transcript',
                persistedFileId: args.meeting.transcriptTextUpload?.id ?? null,
                candidatePath: args.transcriptTextPath,
                outputPath: path.join(args.tempDir, `${args.baseName}${TRANSCRIPT_SOURCE_SUFFIX}`),
                allowEmpty: false,
                fileName: `${args.baseName}${TRANSCRIPT_SOURCE_SUFFIX}`,
                tempDir: args.tempDir,
            }),
        );

        if (toLowerMeetingType(args.meeting.meetingType) === 'rapat') {
            sources.push(
                await this.resolveSourceFile({
                    kind: 'participants',
                    persistedFileId: args.meeting.participantTextUpload?.id ?? null,
                    candidatePath: args.participantTextPath,
                    outputPath: path.join(args.tempDir, `${args.baseName}${PARTICIPANT_SOURCE_SUFFIX}`),
                    allowEmpty: true,
                    fileName: `${args.baseName}${PARTICIPANT_SOURCE_SUFFIX}`,
                    tempDir: args.tempDir,
                }),
            );
        }

        return sources;
    }

    private async resolveSourceFile(args: {
        kind: 'transcript' | 'participants';
        persistedFileId: string | null;
        candidatePath?: string;
        outputPath: string;
        allowEmpty: boolean;
        fileName: string;
        tempDir: string;
    }): Promise<MaterializedSourceFile> {
        const candidateText = await readReusableLocalFile(args.candidatePath, args.tempDir);
        const sourceText =
            candidateText ??
            (await this.downloadSourceText(args.kind, args.persistedFileId));
        const normalizedText = normalizeAiSourceText(sourceText, {
            allowEmpty: args.allowEmpty,
            emptyCode: args.kind === 'transcript' ? 'OPENAI_EMPTY_TRANSCRIPT' : 'OPENAI_PROMPT_INVALID',
        });
        await fs.promises.writeFile(args.outputPath, normalizedText, 'utf8');
        return {
            localPath: args.outputPath,
            fileName: args.fileName,
            byteSize: Buffer.byteLength(normalizedText, 'utf8'),
        };
    }

    private async downloadSourceText(kind: 'transcript' | 'participants', fileId: string | null) {
        if (!fileId || !this.dependencies.gdriveClient.downloadTextFile) {
            throw new AiGenerationFailure(
                'OPENAI_SOURCE_DOWNLOAD_FAILED',
                `No persisted Google Drive file is available for ${kind} source recovery.`,
                true,
            );
        }

        try {
            return await this.dependencies.gdriveClient.downloadTextFile(fileId);
        } catch (error) {
            throw new AiGenerationFailure(
                'OPENAI_SOURCE_DOWNLOAD_FAILED',
                error,
                true,
            );
        }
    }

    private async ensurePendingState(
        args: GenerateAiContentArgs,
        outputFilename: string,
    ) {
        const generationDateIso = args.meeting.aiContent.generationDateIso ?? this.now();
        const updated = await args.persistAiState((aiContent) => ({
            ...aiContent,
            status: aiContent.driveFileId ? 'done' : 'pending',
            outputFilename,
            generationDateIso: aiContent.generationDateIso ?? generationDateIso,
            errorCode: null,
            errorMessage: null,
        }));

        return updated?.aiContent.generationDateIso ?? generationDateIso;
    }

    private async findExistingDriveArtifact(fileName: string, folderId: string) {
        if (!this.dependencies.gdriveClient.findFileByName) {
            return null;
        }

        return this.dependencies.gdriveClient.findFileByName(fileName, folderId);
    }

    private async persistDoneState(
        args: GenerateAiContentArgs,
        driveFileId: string,
        outputFilename: string,
        metadata: {
            openaiResponseId?: string | null;
            openaiRequestId?: string | null;
            inputTokens?: number | null;
            outputTokens?: number | null;
            completedAt: string;
        },
    ) {
        await args.persistAiState((aiContent) => ({
            ...aiContent,
            status: 'done',
            driveFileId,
            outputFilename,
            openaiResponseId: metadata.openaiResponseId ?? aiContent.openaiResponseId,
            openaiRequestId: metadata.openaiRequestId ?? aiContent.openaiRequestId,
            inputTokens:
                metadata.inputTokens === undefined ? aiContent.inputTokens : metadata.inputTokens,
            outputTokens:
                metadata.outputTokens === undefined ? aiContent.outputTokens : metadata.outputTokens,
            errorCode: null,
            errorMessage: null,
            completedAt: metadata.completedAt,
        }));
    }

    private async cleanupOpenAiFiles(fileIds: string[], meetingId: string) {
        if (!fileIds.length) {
            return true;
        }

        let allCleared = true;
        for (const fileId of fileIds) {
            try {
                await this.openaiClient.files.delete(fileId);
            } catch (error) {
                if (error instanceof NotFoundError) {
                    continue;
                }

                allCleared = false;
                this.logger.warn('OpenAI input file cleanup failed', {
                    meetingId,
                    openaiFileId: fileId,
                    error: sanitizeAiErrorMessage(error),
                });
            }
        }

        return allCleared;
    }
}

class AiGenerationFailure extends Error {
    constructor(
        readonly code: string,
        message: unknown,
        readonly retryable: boolean,
    ) {
        super(normalizeFailureMessage(message));
        this.name = 'AiGenerationFailure';
    }
}

function buildResponseInput(fileIds: string[]) {
    return [
        {
            role: 'user' as const,
            content: fileIds.map((fileId) => ({
                type: 'input_file' as const,
                file_id: fileId,
            })),
        },
    ];
}

function normalizeFailureMessage(message: unknown) {
    if (message instanceof Error) {
        return message.message;
    }

    return String(message ?? 'Unknown AI generation error');
}

function classifyAiGenerationError(error: unknown) {
    if (error instanceof AiGenerationFailure) {
        return error;
    }

    if (error instanceof AuthenticationError) {
        return new AiGenerationFailure('OPENAI_AUTHENTICATION_FAILED', error, false);
    }

    if (error instanceof PermissionDeniedError) {
        return new AiGenerationFailure('OPENAI_PERMISSION_DENIED', error, false);
    }

    if (error instanceof RateLimitError) {
        return new AiGenerationFailure('OPENAI_RATE_LIMIT', error, true);
    }

    if (error instanceof APIConnectionTimeoutError) {
        return new AiGenerationFailure('OPENAI_TIMEOUT', error, true);
    }

    if (error instanceof APIConnectionError) {
        return new AiGenerationFailure('OPENAI_CONNECTION_ERROR', error, true);
    }

    if (error instanceof InternalServerError) {
        return new AiGenerationFailure('OPENAI_SERVER_ERROR', error, true);
    }

    if (error instanceof NotFoundError) {
        return new AiGenerationFailure('OPENAI_MODEL_NOT_FOUND', error, false);
    }

    if (error instanceof Error) {
        if (/Agent prompt file is missing/i.test(error.message)) {
            return new AiGenerationFailure('OPENAI_PROMPT_MISSING', error, false);
        }

        if (/Agent prompt/i.test(error.message)) {
            return new AiGenerationFailure('OPENAI_PROMPT_INVALID', error, false);
        }
    }

    return new AiGenerationFailure('OPENAI_SERVER_ERROR', error, true);
}

async function readReusableLocalFile(candidatePath: string | undefined, tempDir: string) {
    if (!candidatePath) {
        return null;
    }

    const resolvedCandidate = path.resolve(candidatePath);
    const resolvedTempDir = `${path.resolve(tempDir)}${path.sep}`;
    if (!resolvedCandidate.startsWith(resolvedTempDir)) {
        return null;
    }

    let stat: fs.Stats;
    try {
        stat = await fs.promises.stat(resolvedCandidate);
    } catch {
        return null;
    }

    if (!stat.isFile() || stat.size <= 0) {
        return null;
    }

    return fs.promises.readFile(resolvedCandidate, 'utf8');
}

export function normalizeAiSourceText(
    value: string,
    options: { allowEmpty: boolean; emptyCode: string },
) {
    const normalized = value
        .replace(/\u0000/g, '')
        .replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n');

    if (!options.allowEmpty && !normalized.trim()) {
        throw new AiGenerationFailure(
            options.emptyCode,
            'Transcript text is empty after normalization.',
            false,
        );
    }

    return normalized;
}

export function normalizeGeneratedMarkdown(value: string) {
    const trimmed = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    return trimmed ? `${trimmed}\n` : '';
}

function toLowerMeetingType(meetingType: MeetingJob['meetingType']) {
    return meetingType === 'SEMINAR' ? 'seminar' : 'rapat';
}
