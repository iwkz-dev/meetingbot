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

export type ParticipantArtifactStatus = 'pending' | 'processing' | 'done' | 'failed';

export type DriveArtifact = {
    id: string;
    name: string;
    link: string;
};

export type DriveFolder = {
    id: string;
    name: string;
    link: string | null;
};

export type MeetingParticipant = {
    id: number;
    name: string | null;
    is_host: boolean | null;
    platform: string | null;
    extra_data: unknown | null;
    email: string | null;
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
    onJoinMessage: string;
    status: MeetingJobStatus;
    recallStatusCode: string | null;
    recallStatusSubCode: string | null;
    recallStatusMessage: string | null;
    transcriptRequestedAt: string | null;
    processingStartedAt: string | null;
    artifactProcessingMode: 'full' | 'video_only' | null;
    stopRequestedAt: string | null;
    createdAt: string;
    updatedAt: string;
    joinedAt: string | null;
    completedAt: string | null;
    driveFolder: DriveFolder | null;
    videoUpload: DriveArtifact | null;
    transcriptJsonUpload: DriveArtifact | null;
    transcriptTextUpload: DriveArtifact | null;
    participantJsonUpload: DriveArtifact | null;
    participantTextUpload: DriveArtifact | null;
    participantArtifactStatus: ParticipantArtifactStatus | null;
    participantArtifactError: string | null;
    participantArtifactAttempts: number;
    participantArtifactNextRetryAt: string | null;
    lastError: string | null;
};

export type MeetingJobCreateInput = {
    meetingUrl: string;
    meetingSubject: string;
    botDisplayName: string;
    meetingType: MeetingType;
    onJoinMessage: string;
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
    driveFolder: DriveFolder | null;
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
    onJoinMessage: string;
};

export type InviteMeetingResult = {
    result: 'ok';
    message: 'bot join request accepted';
    meeting: {
        id: string;
        recallBotId: string;
        meetingSubject: string;
        status: 'joining';
    };
};

export type LeaveMeetingResult = {
    result: 'ok';
    message: string;
    meeting: {
        id: string;
        recallBotId: string;
        status: MeetingJobStatus;
    };
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

export type RecallCreateBotPayload = {
    meeting_url: string;
    join_at: string;
    bot_name: string;
    recording_config: {
        video_mixed_mp4: Record<string, never>;
        participant_events: Record<string, never>;
        meeting_metadata: Record<string, never>;
    };
    automatic_leave: {
        waiting_room_timeout: number;
        noone_joined_timeout: number;
        everyone_left_timeout: {
            timeout: number;
            activate_after: number;
        };
    };
    metadata: {
        meetingbot_job_id: string;
        meeting_subject: string;
        meeting_type: 'rapat' | 'seminar';
    };
    chat?: {
        on_bot_join: {
            send_to: 'everyone';
            message: string;
            pin: true;
        };
    };
};

export type RecallBotResponse = {
    id: string;
};