export type MeetingInfo = {
    meetingUrl: string;
    platform: MeetingPlatform;
    screenWidth: number;
    screenHeight: number;
};

export type AutomaticLeave = {
    waitingRoomTimeout: number;
    noOneJoinedTimeout: number;
    everyoneLeftTimeout: number;
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
