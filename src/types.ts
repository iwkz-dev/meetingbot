export type MeetingType = 'RAPAT' | 'SEMINAR';

export type MeetingJobStatus =
    | 'creating_bot'
    | 'joining'
    | 'waiting_room'
    | 'in_call_not_recording'
    | 'recording'
    | 'leaving'
    | 'call_ended'
    | 'recording_processing'
    | 'transcribing'
    | 'uploading'
    | 'completed'
    | 'completed_with_errors'
    | 'failed';

export type DriveArtifact = {
    id: string;
    name: string;
    link: string;
};

export type MeetingJob = {
    id: string;
    recallBotId: string | null;
    recallRecordingId: string | null;
    recallTranscriptId: string | null;
    meetingUrl: string;
    meetingSubject: string;
    botDisplayName: string;
    meetingType: MeetingType;
    status: MeetingJobStatus;
    recallStatusCode: string | null;
    recallStatusSubCode: string | null;
    recallStatusMessage: string | null;
    transcriptRequestedAt: string | null;
    processingStartedAt: string | null;
    stopRequestedAt: string | null;
    createdAt: string;
    updatedAt: string;
    joinedAt: string | null;
    completedAt: string | null;
    videoUpload: DriveArtifact | null;
    transcriptJsonUpload: DriveArtifact | null;
    transcriptTextUpload: DriveArtifact | null;
    lastError: string | null;
};

export type MeetingJobCreateInput = {
    meetingUrl: string;
    meetingSubject: string;
    botDisplayName: string;
    meetingType: MeetingType;
    status?: MeetingJobStatus;
};

export type ControlPanelMeeting = {
    id: string;
    recallBotId: string | null;
    meetingUrl: string;
    meetingSubject: string;
    botDisplayName: string;
    meetingType: MeetingType;
    status: MeetingJobStatus;
    recallStatusCode: string | null;
    recallStatusSubCode: string | null;
    recallStatusMessage: string | null;
    createdAt: string;
    joinedAt: string | null;
    completedAt: string | null;
    videoUpload: DriveArtifact | null;
    transcriptJsonUpload: DriveArtifact | null;
    transcriptTextUpload: DriveArtifact | null;
    lastError: string | null;
};

export type RuntimeStats = {
    activeMeetings: number;
    completedMeetings: number;
    failedMeetings: number;
    lastStartedAt: string | null;
    lastFinishedAt: string | null;
    lastError: string | null;
};

export type InviteMeetingInput = {
    meetingUrl: string;
    meetingSubject: string;
    botDisplayName: string;
    meetingType: MeetingType;
};

export type RecallRegion =
    | 'us-west-2'
    | 'us-east-1'
    | 'eu-central-1'
    | 'ap-northeast-1';

export type RecallAutomaticLeaveConfig = {
    waitingRoomTimeoutSeconds: number;
    nooneJoinedTimeoutSeconds: number;
    everyoneLeftTimeoutSeconds: number;
    everyoneLeftActivateAfterSeconds: number;
};
