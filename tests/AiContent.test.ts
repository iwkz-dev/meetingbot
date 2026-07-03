import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
    buildDefaultAiContentState,
    formatAiCurrentDate,
    hasRequiredAiSourceArtifacts,
    isRetryableAiErrorCode,
    meetingTypeToAgentPromptPath,
    meetingTypeToAiContentKind,
    meetingTypeToOutputSuffix,
    normalizeAiContentState,
    sanitizeAiErrorMessage,
} from '../src/openai/AiContent';

test('AI helpers map meeting types to content kind prompt path and output suffix', () => {
    assert.equal(meetingTypeToAiContentKind('seminar'), 'seminar_blog');
    assert.equal(meetingTypeToAiContentKind('RAPAT'), 'rapat_meeting_notes');
    assert.equal(meetingTypeToAgentPromptPath('seminar'), 'docs/agent/seminar-blog-id.md');
    assert.equal(meetingTypeToAgentPromptPath('rapat'), 'docs/agent/rapat-meeting-notes-id.md');
    assert.equal(meetingTypeToOutputSuffix('SEMINAR'), '.blog.md');
    assert.equal(meetingTypeToOutputSuffix('rapat'), '.meeting-notes.md');
});

test('formatAiCurrentDate honors Indonesian locale and timezone', () => {
    const result = formatAiCurrentDate(
        new Date('2026-07-02T18:00:00.000Z'),
        'Asia/Jakarta',
    );

    assert.equal(result, '3 Juli 2026');
});

test('AI readiness detection follows meeting-type source artifact requirements', () => {
    assert.equal(
        hasRequiredAiSourceArtifacts({
            meetingType: 'SEMINAR',
            transcriptTextUpload: { id: 'txt-1' },
        }),
        true,
    );
    assert.equal(
        hasRequiredAiSourceArtifacts({
            meetingType: 'RAPAT',
            transcriptTextUpload: { id: 'txt-1' },
        }),
        false,
    );
    assert.equal(
        hasRequiredAiSourceArtifacts({
            meetingType: 'rapat',
            transcriptTextUpload: { id: 'txt-1' },
            participantTextUpload: { id: 'participants-1' },
        }),
        true,
    );
});

test('default and normalized AI content state stay backward compatible', () => {
    const fallback = buildDefaultAiContentState({ meetingType: 'RAPAT' });
    assert.equal(fallback.kind, 'rapat_meeting_notes');
    assert.equal(fallback.status, 'not_ready');
    assert.deepEqual(fallback.openaiInputFileIds, []);

    const normalized = normalizeAiContentState(
        {
            meetingType: 'SEMINAR',
            transcriptTextUpload: { id: 'txt-1' },
        },
        {
            status: 'processing',
            driveFileId: 'drive-1',
            outputFilename: 'hello.blog.md',
            openaiInputFileIds: ['file-1', ' file-2 '],
            attemptCount: 2,
        },
    );

    assert.equal(normalized.kind, 'seminar_blog');
    assert.equal(normalized.status, 'done');
    assert.equal(normalized.driveFileId, 'drive-1');
    assert.equal(normalized.outputFilename, 'hello.blog.md');
    assert.deepEqual(normalized.openaiInputFileIds, ['file-1', 'file-2']);
    assert.equal(normalized.attemptCount, 2);
});

test('sanitizeAiErrorMessage removes control characters and redacts obvious keys', () => {
    const result = sanitizeAiErrorMessage('boom\u0000 sk-secret-12345\nnext');
    assert.equal(result.includes('sk-secret-12345'), false);
    assert.equal(result, 'boom [redacted] next');
});

test('retryable AI error helper only retries operational failures', () => {
    assert.equal(isRetryableAiErrorCode('OPENAI_RATE_LIMIT'), true);
    assert.equal(isRetryableAiErrorCode('OPENAI_TIMEOUT'), true);
    assert.equal(isRetryableAiErrorCode('OPENAI_INPUT_CONTEXT_TOO_LARGE'), false);
    assert.equal(isRetryableAiErrorCode('OPENAI_AUTHENTICATION_FAILED'), false);
    assert.equal(isRetryableAiErrorCode(null), false);
});



