import { MeetingBot } from './MeetingBot';
import { MeetingType } from './types';
import { uploadFileToGDrive } from './GDriveUploader';

const BOT_NAME = process.env.BOT_NAME || 'IWKZ Bot';
const DEFAULT_TIMEOUT = 9000; //9 second

export const createBot = async (
    meetingUrl: string,
    meetingTitle: string,
    meetingType: MeetingType
) => {
    let meetingRecord = {};
    const bot = await new MeetingBot({
        id: 1,
        meetingInfo: {
            meetingUrl: meetingUrl,
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
