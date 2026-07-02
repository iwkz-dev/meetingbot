import { ControlPanelMeeting, MeetingJob, RuntimeStats } from './types';

export function serializeMeetingForControlPanel(
    meeting: MeetingJob,
): ControlPanelMeeting {
    return {
        id: meeting.id,
        recallBotId: meeting.recallBotId,
        meetingUrl: meeting.meetingUrl,
        meetingSubject: meeting.meetingSubject,
        botDisplayName: meeting.botDisplayName,
        meetingType: meeting.meetingType,
        status: meeting.status,
        recallStatusCode: meeting.recallStatusCode,
        recallStatusSubCode: meeting.recallStatusSubCode,
        recallStatusMessage: meeting.recallStatusMessage,
        createdAt: meeting.createdAt,
        joinedAt: meeting.joinedAt,
        completedAt: meeting.completedAt,
        videoUpload: meeting.videoUpload,
        transcriptJsonUpload: meeting.transcriptJsonUpload,
        transcriptTextUpload: meeting.transcriptTextUpload,
        lastError: meeting.lastError,
    };
}

export function buildControlPanelState(payload: {
    meetings: MeetingJob[];
    stats: RuntimeStats;
}) {
    return {
        stats: payload.stats,
        meetings: payload.meetings.map(serializeMeetingForControlPanel),
    };
}
