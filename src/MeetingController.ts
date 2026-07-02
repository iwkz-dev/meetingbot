import { InviteMeetingInput, MeetingJob, RuntimeStats } from './types';
import { normalizeMeetingType, sanitizeFilenameBaseName } from './filename';

export function buildInviteMeetingInput(payload: {
    meetingUrl?: unknown;
    meetingSubject?: unknown;
    meetingTitle?: unknown;
    botDisplayName?: unknown;
    meetingType?: unknown;
}): InviteMeetingInput {
    const meetingUrl = String(payload.meetingUrl ?? '').trim();
    const meetingSubject = String(
        payload.meetingSubject ?? payload.meetingTitle ?? '',
    ).trim();
    const botDisplayName = String(payload.botDisplayName ?? '').trim() || 'IWKZ Bot';
    const meetingType = normalizeMeetingType(String(payload.meetingType ?? ''));

    if (!meetingUrl) {
        throw new Error('meetingUrl is required');
    }

    let parsedUrl: URL;
    try {
        parsedUrl = new URL(meetingUrl);
    } catch {
        throw new Error('meetingUrl must be a valid URL');
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        throw new Error('meetingUrl must use http or https');
    }

    if (!meetingSubject) {
        throw new Error('meetingSubject is required');
    }

    if (meetingSubject.length > 200) {
        throw new Error('meetingSubject must be 1-200 characters');
    }

    if (botDisplayName.length > 100) {
        throw new Error('botDisplayName must be 1-100 characters');
    }

    return {
        meetingUrl: parsedUrl.toString(),
        meetingSubject,
        botDisplayName,
        meetingType,
    };
}

export function buildRuntimeStats(meetings: MeetingJob[]): RuntimeStats {
    const activeMeetings = meetings.filter(
        (meeting) =>
            meeting.status !== 'completed' &&
            meeting.status !== 'completed_with_errors' &&
            meeting.status !== 'failed',
    );
    const completedMeetings = meetings.filter(
        (meeting) => meeting.status === 'completed',
    );
    const failedMeetings = meetings.filter(
        (meeting) =>
            meeting.status === 'failed' ||
            meeting.status === 'completed_with_errors',
    );

    return {
        activeMeetings: activeMeetings.length,
        completedMeetings: completedMeetings.length,
        failedMeetings: failedMeetings.length,
        lastStartedAt: meetings[0]?.createdAt ?? null,
        lastFinishedAt:
            meetings.find((meeting) => meeting.completedAt)?.completedAt ?? null,
        lastError: meetings.find((meeting) => meeting.lastError)?.lastError ?? null,
    };
}

export function buildArtifactBaseName(subject: string) {
    return sanitizeFilenameBaseName(subject);
}

export function ensurePromptOneReadyMessage() {
    return [
        'Prompt 1 foundation is ready.',
        'Before live Recall bot creation can work, configure RECALL_REGION, RECALL_API_KEY, RECALL_WORKSPACE_VERIFICATION_SECRET, and PUBLIC_API_BASE_URL in the same Recall region.',
        'Then create the Recall dashboard webhook at PUBLIC_API_BASE_URL/api/recall/webhook with subscriptions bot.*, recording.done, recording.failed, transcript.done, and transcript.failed.',
        'Live Recall bot creation will be implemented in Prompt 2.',
    ].join(' ');
}
