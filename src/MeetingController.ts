import { MeetingBot } from './MeetingService';
import {
    MeetingInfo,
    MeetingPlatform,
    MeetingType,
    ZoomJoinInfo,
    ZoomJoinTarget,
    ZoomMeetingKind,
} from './types';
import { uploadFileToGDrive } from './GDriveUploader';
import {
    attachSessionController,
    markSessionError,
    markSessionFinished,
    markSessionStarted,
    registerSession,
} from './runtimeState';
import fs from 'fs';

const DEFAULT_BOT_NAME = 'IWKZ Bot';
const DEFAULT_TIMEOUT = 9000; //9 second
const ALONE_TIMEOUT = 5000;
const STATUS_POLL_INTERVAL = 2000;
const SCREEN_WIDTH = 1920;
const SCREEN_HEIGHT = 1080;
let nextBotId = 1;

export const createBot = async (
    meetingUrl: string,
    meetingTitle: string,
    meetingType: MeetingType,
    botDisplayName: string = DEFAULT_BOT_NAME
) => {
    let meetingRecord = {};
    const meetingInfo = evaluateMeetingUrl(meetingUrl);
    const sessionId = nextBotId++;

    const bot = new MeetingBot({
        id: sessionId,
        meetingInfo,
        meetingTitle: meetingTitle,
        botDisplayName,
        automaticLeave: {
            waitingRoomTimeout: DEFAULT_TIMEOUT,
            noOneJoinedTimeout: DEFAULT_TIMEOUT,
            everyoneLeftTimeout: DEFAULT_TIMEOUT,
            aloneTimeout: ALONE_TIMEOUT,
            statusPollInterval: STATUS_POLL_INTERVAL,
        },
        chromePath: process.env.CHROME_PATH,
        useChromePath: process.env.USE_CHROME_PATH,
    });

    registerSession({
        id: sessionId,
        meetingTitle,
        botDisplayName,
        meetingType,
        platform: meetingInfo.platform,
        targetMeetingUrl: meetingInfo.meetingUrl,
        originalMeetingUrl: meetingInfo.originalMeetingUrl,
    });
    attachSessionController(sessionId, {
        stop: () => bot.requestStop(),
        getCurrentPageUrl: () => bot.getCurrentPageUrl(),
    });

    console.log(
        `[bot:${sessionId}] Starting ${meetingInfo.platform} session for "${meetingTitle}"`
    );
    markSessionStarted(sessionId);

    try {
        await bot.run();

        meetingRecord = await uploadRecordingToGDrive(
            meetingTitle,
            meetingType,
            bot,
            sessionId
        );
    } catch (error) {
        markSessionError(error, sessionId);
        console.error(`[bot:${sessionId}] Session failed`, error);
    } finally {
        await bot.cleanupArtifacts();
        markSessionFinished(sessionId);
        console.log(`[bot:${sessionId}] Finish job...`);
    }

    return meetingRecord;
};

const uploadRecordingToGDrive = async (
    meetingTitle: string,
    meetingType: MeetingType,
    bot: MeetingBot,
    sessionId: number
) => {
    let gDriveFolderId = '';
    let gDriveTmpFolderId = '';
    let meetingRecord = {};

    switch (meetingType) {
        case MeetingType.SEMINAR:
            gDriveFolderId = process.env.GDRIVE_FOLDER_SEMINAR;
            gDriveTmpFolderId = process.env.GDRIVE_FOLDER_SEMINAR_TMP;
            break;
        case MeetingType.RAPAT:
            gDriveFolderId = process.env.GDRIVE_FOLDER_RAPAT;
            gDriveTmpFolderId = process.env.GDRIVE_FOLDER_RAPAT_TMP;
            break;
    }

    const videoPath = bot.getRecordingVideoPath();
    const audioPath = bot.getRecordingAudioPath();

    if (!fs.existsSync(videoPath)) {
        console.warn(
            `[bot:${sessionId}] Recording video not found at ${videoPath}, skipping Google Drive upload.`
        );
        return meetingRecord;
    }

    if (gDriveFolderId !== '' && gDriveTmpFolderId !== '') {
        console.log('Start uploading MP4 to gdrive...');
        meetingRecord = await uploadFileToGDrive(
            meetingTitle,
            videoPath,
            gDriveFolderId
        );

        if (fs.existsSync(audioPath)) {
            console.log('Start uploading MP3 to gdrive...');
            await uploadFileToGDrive(meetingTitle, audioPath, gDriveTmpFolderId);
        } else {
            console.warn(
                `[bot:${sessionId}] Recording audio not found at ${audioPath}, skipping audio upload.`
            );
        }
    }

    return meetingRecord;
};

const evaluateMeetingUrl = (meetingUrl: string): MeetingInfo => {
    if (meetingUrl.includes('meet.google')) {
        return {
            platform: MeetingPlatform.MEET,
            meetingUrl,
            originalMeetingUrl: meetingUrl,
            screenWidth: SCREEN_WIDTH,
            screenHeight: SCREEN_HEIGHT,
        };
    }

    const zoomJoinInfo = parseZoomMeetingLink(meetingUrl);

    return {
        platform: MeetingPlatform.ZOOM,
        meetingUrl: zoomJoinInfo.joinTargets[0]?.url ?? zoomJoinInfo.originalUrl,
        originalMeetingUrl: zoomJoinInfo.originalUrl,
        screenWidth: SCREEN_WIDTH,
        screenHeight: SCREEN_HEIGHT,
        zoomJoinInfo,
    };
};

function parseZoomMeetingLink(rawInput: string): ZoomJoinInfo {
    const trimmedInput = rawInput.trim();

    if (/^\d{9,12}$/.test(trimmedInput)) {
        const originalUrl = `https://zoom.us/j/${trimmedInput}`;

        return {
            kind: ZoomMeetingKind.MEETING,
            originalUrl,
            meetingId: trimmedInput,
            joinTargets: buildZoomJoinTargets(
                ZoomMeetingKind.MEETING,
                originalUrl,
                trimmedInput
            ),
        };
    }

    const url = new URL(trimmedInput);
    const meetingId = extractMeetingId(url);
    const passcode = url.searchParams.get('pwd') ?? undefined;
    const webinarToken = url.searchParams.get('tk') ?? undefined;
    const kind = detectZoomMeetingKind(url, webinarToken);

    return {
        kind,
        originalUrl: url.toString(),
        meetingId,
        passcode,
        webinarToken,
        joinTargets: buildZoomJoinTargets(
            kind,
            url.toString(),
            meetingId,
            passcode,
            webinarToken
        ),
    };
}

function detectZoomMeetingKind(
    url: URL,
    webinarToken?: string
): ZoomMeetingKind {
    const path = url.pathname.toLowerCase();
    const hostname = url.hostname.toLowerCase();

    if (
        hostname.includes('events.zoom') ||
        path.includes('/event/') ||
        path.includes('/events/') ||
        path.includes('/e/')
    ) {
        return ZoomMeetingKind.EVENT;
    }

    if (
        path.includes('/webinar/') ||
        path.includes('/w/') ||
        Boolean(webinarToken)
    ) {
        return ZoomMeetingKind.WEBINAR;
    }

    return ZoomMeetingKind.MEETING;
}

function buildZoomJoinTargets(
    kind: ZoomMeetingKind,
    originalUrl: string,
    meetingId?: string,
    passcode?: string,
    webinarToken?: string
): ZoomJoinTarget[] {
    const query = new URLSearchParams({ fromPWA: '1' });
    const targets: ZoomJoinTarget[] = [];

    if (passcode) {
        query.set('pwd', passcode);
    }

    if (webinarToken) {
        query.set('tk', webinarToken);
    }

    if (meetingId) {
        targets.push({
            label: `${kind.toLowerCase()}-webclient`,
            url: `https://app.zoom.us/wc/${meetingId}/join?${query.toString()}`,
        });
    }

    targets.push({
        label: `${kind.toLowerCase()}-original`,
        url: originalUrl,
    });

    return dedupeJoinTargets(targets);
}

function dedupeJoinTargets(targets: ZoomJoinTarget[]) {
    const seen = new Set<string>();

    return targets.filter((target) => {
        if (seen.has(target.url)) {
            return false;
        }

        seen.add(target.url);
        return true;
    });
}

function extractMeetingId(url: URL) {
    const hostname = url.hostname.toLowerCase();
    const pathname = url.pathname;

    if (hostname.includes('app.zoom.us')) {
        const match = pathname.match(/\/wc\/(\d+)\/join/i);
        return match?.[1];
    }

    const match = pathname.match(/\/(?:j|w)\/(\d+)/i);
    return match?.[1];
}
