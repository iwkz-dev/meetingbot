import { MeetingBot } from './MeetingService';
import { MeetingPlatform, MeetingType } from './types';
import { uploadFileToGDrive } from './GDriveUploader';

const BOT_NAME = process.env.BOT_NAME || 'IWKZ Bot';
const DEFAULT_TIMEOUT = 9000; //9 second
const SCREEN_WIDTH = 1920;
const SCREEN_HEIGHT = 1080;

export const createBot = async (
    meetingUrl: string,
    meetingTitle: string,
    meetingType: MeetingType
) => {
    let meetingRecord = {};
    const { url, platform } = evaluateMeetingUrl(meetingUrl);

    const bot = await new MeetingBot({
        id: 1,
        meetingInfo: {
            meetingUrl: url,
            platform,
            screenWidth: SCREEN_WIDTH,
            screenHeight: SCREEN_HEIGHT,
        },
        meetingTitle: meetingTitle,
        botDisplayName: BOT_NAME,
        automaticLeave: {
            waitingRoomTimeout: DEFAULT_TIMEOUT,
            noOneJoinedTimeout: DEFAULT_TIMEOUT,
            everyoneLeftTimeout: DEFAULT_TIMEOUT,
        },
        chromePath: process.env.CHROME_PATH,
        useChromePath: process.env.USE_CHROME_PATH,
    });

    try {
        await bot.run().catch(async (error) => {
            bot.screenshot();

            await bot.endLife();
        });

        // Upload recording to GDrive
        meetingRecord = await uploadRecordingToGDrive(
            meetingTitle,
            meetingType,
            bot
        );
    } catch (error) {}

    console.log('Finish job...');
    return meetingRecord;
};

const uploadRecordingToGDrive = async (
    meetingTitle: string,
    meetingType: MeetingType,
    bot: MeetingBot
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

    if (gDriveFolderId !== '' && gDriveTmpFolderId !== '') {
        console.log('Start uploading MP4 to gdrive...');
        meetingRecord = await uploadFileToGDrive(
            meetingTitle,
            bot.getRecordingVideoPath(),
            gDriveFolderId
        );

        console.log('Start uploading MP3 to gdrive...');
        await uploadFileToGDrive(
            meetingTitle,
            bot.getRecordingMp3Path(),
            gDriveTmpFolderId
        );
    }

    return meetingRecord;
};

const evaluateMeetingUrl = (meetingUrl: string) => {
    if (meetingUrl.includes('meet.google')) {
        return {
            platform: MeetingPlatform.MEET,
            url: meetingUrl,
        };
    }

    // zoom meeting url
    const parsed = parseZoomMeetingLink(meetingUrl);

    return {
        url: `https://app.zoom.us/wc/${parsed.meetingId}/join?fromPWA=1&pwd=${parsed.meetingPassword}`,
        platform: MeetingPlatform.ZOOM,
    };
};

function parseZoomMeetingLink(url: string) {
    const urlObj = new URL(url);
    const pathSegments = urlObj.pathname.split('/');
    const meetingId = pathSegments[pathSegments.length - 1];
    const meetingPassword = urlObj.searchParams.get('pwd') || '';

    return {
        meetingId,
        meetingPassword,
    };
}
