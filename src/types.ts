export type MeetingInfo = {
    meetingId?: string;
    meetingPassword?: string;
    meetingUrl?: string;
    platform?: 'zoom' | 'google';
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
