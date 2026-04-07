export type MeetingInfo = {
    meetingUrl: string;
    originalMeetingUrl: string;
    platform: MeetingPlatform;
    screenWidth: number;
    screenHeight: number;
    zoomJoinInfo?: ZoomJoinInfo;
};

export type AutomaticLeave = {
    waitingRoomTimeout: number;
    noOneJoinedTimeout: number;
    everyoneLeftTimeout: number;
    aloneTimeout: number;
    statusPollInterval: number;
};

export type BotConfig = {
    id: number;
    meetingInfo: MeetingInfo;
    meetingTitle: string;
    botDisplayName: string;
    automaticLeave: AutomaticLeave;
    chromePath?: string;
    useChromePath: string;
};

export enum MeetingType {
    SEMINAR = 'SEMINAR',
    RAPAT = 'RAPAT',
}

export enum MeetingPlatform {
    ZOOM = 'ZOOM',
    MEET = 'MEET',
}

export enum ZoomMeetingKind {
    MEETING = 'MEETING',
    WEBINAR = 'WEBINAR',
    EVENT = 'EVENT',
}

export type ZoomJoinTarget = {
    label: string;
    url: string;
};

export type ZoomJoinInfo = {
    kind: ZoomMeetingKind;
    originalUrl: string;
    meetingId?: string;
    passcode?: string;
    webinarToken?: string;
    joinTargets: ZoomJoinTarget[];
};
