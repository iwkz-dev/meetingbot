import { AiContentArtifactState, AiContentKind, MeetingType } from '../types';

const AGENT_PROMPT_PATHS: Record<AiContentKind, string> = {
    seminar_blog: 'docs/agent/seminar-blog-id.md',
    rapat_meeting_notes: 'docs/agent/rapat-meeting-notes-id.md',
};

const OUTPUT_SUFFIXES: Record<AiContentKind, string> = {
    seminar_blog: '.blog.md',
    rapat_meeting_notes: '.meeting-notes.md',
};

export type LowerMeetingType = 'seminar' | 'rapat';

type AiReadinessMeeting = {
    meetingType: MeetingType | LowerMeetingType;
    transcriptTextUpload?: unknown;
    participantTextUpload?: unknown;
};

export function meetingTypeToAiContentKind(
    meetingType: MeetingType | LowerMeetingType,
): AiContentKind {
    return toLowerMeetingType(meetingType) === 'seminar'
        ? 'seminar_blog'
        : 'rapat_meeting_notes';
}

export function meetingTypeToAgentPromptPath(
    meetingType: MeetingType | LowerMeetingType,
) {
    return AGENT_PROMPT_PATHS[meetingTypeToAiContentKind(meetingType)];
}

export function meetingTypeToOutputSuffix(
    meetingType: MeetingType | LowerMeetingType,
) {
    return OUTPUT_SUFFIXES[meetingTypeToAiContentKind(meetingType)];
}

export function formatAiCurrentDate(date: Date, timeZone: string) {
    return new Intl.DateTimeFormat('id-ID', {
        timeZone,
        day: 'numeric',
        month: 'long',
        year: 'numeric',
    }).format(date);
}

export function hasRequiredAiSourceArtifacts(meeting: AiReadinessMeeting) {
    if (!hasDriveArtifact(meeting.transcriptTextUpload)) {
        return false;
    }

    return toLowerMeetingType(meeting.meetingType) === 'seminar'
        ? true
        : hasDriveArtifact(meeting.participantTextUpload);
}

export function buildDefaultAiContentState(meeting: AiReadinessMeeting): AiContentArtifactState {
    return {
        kind: meetingTypeToAiContentKind(meeting.meetingType),
        status: hasRequiredAiSourceArtifacts(meeting) ? 'pending' : 'not_ready',
        generationDateIso: null,
        driveFileId: null,
        outputFilename: null,
        openaiResponseId: null,
        openaiRequestId: null,
        inputTokens: null,
        outputTokens: null,
        attemptCount: 0,
        lastAttemptAt: null,
        completedAt: null,
        errorCode: null,
        errorMessage: null,
    };
}

export function normalizeAiContentState(
    meeting: AiReadinessMeeting,
    rawState: unknown,
): AiContentArtifactState {
    const fallback = buildDefaultAiContentState(meeting);
    if (!isRecord(rawState)) {
        return fallback;
    }

    const kind = isAiContentKind(rawState.kind)
        ? rawState.kind
        : fallback.kind;
    const driveFileId = asTrimmedString(rawState.driveFileId);
    const status = normalizeAiContentStatus(rawState.status, fallback.status, driveFileId);

    return {
        kind,
        status,
        generationDateIso: asTrimmedString(rawState.generationDateIso),
        driveFileId,
        outputFilename: asTrimmedString(rawState.outputFilename),
        openaiResponseId: asTrimmedString(rawState.openaiResponseId),
        openaiRequestId: asTrimmedString(rawState.openaiRequestId),
        inputTokens: asNonNegativeNumber(rawState.inputTokens),
        outputTokens: asNonNegativeNumber(rawState.outputTokens),
        attemptCount: asNonNegativeNumber(rawState.attemptCount) ?? 0,
        lastAttemptAt: asTrimmedString(rawState.lastAttemptAt),
        completedAt: asTrimmedString(rawState.completedAt),
        errorCode: asTrimmedString(rawState.errorCode),
        errorMessage: asTrimmedString(rawState.errorMessage),
    };
}

export function sanitizeAiErrorMessage(error: unknown) {
    const raw = error instanceof Error ? error.message : String(error ?? 'Unknown AI error');
    return raw
        .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]')
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 500);
}

function toLowerMeetingType(meetingType: MeetingType | LowerMeetingType) {
    return meetingType === 'SEMINAR' || meetingType === 'seminar'
        ? 'seminar'
        : 'rapat';
}

function normalizeAiContentStatus(
    value: unknown,
    fallbackStatus: AiContentArtifactState['status'],
    driveFileId: string | null,
): AiContentArtifactState['status'] {
    if (driveFileId) {
        return 'done';
    }

    if (
        value === 'not_ready' ||
        value === 'pending' ||
        value === 'processing' ||
        value === 'done' ||
        value === 'failed'
    ) {
        return value;
    }

    return fallbackStatus;
}

function hasDriveArtifact(value: unknown) {
    return isRecord(value) && typeof value.id === 'string' && value.id.trim().length > 0;
}

function asTrimmedString(value: unknown) {
    if (typeof value !== 'string') {
        return null;
    }

    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}

function asNonNegativeNumber(value: unknown) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? value
        : null;
}

function isAiContentKind(value: unknown): value is AiContentKind {
    return value === 'seminar_blog' || value === 'rapat_meeting_notes';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object');
}
