import { AppConfig } from './config';
import { listDirectChildFolders } from './GDriveUploader';
import { ControlPanelHistoryMeeting } from './types';

export class ControlPanelHistoryError extends Error {
    constructor(message = 'Could not load meeting history from Google Drive') {
        super(message);
        this.name = 'ControlPanelHistoryError';
    }
}

export async function listControlPanelHistory(
    config: Pick<AppConfig, 'gdriveFolderRapat' | 'gdriveFolderSeminar'>,
    listFolders: typeof listDirectChildFolders = listDirectChildFolders,
) {
    try {
        const [rapatFolders, seminarFolders] = await Promise.all([
            listFolders(config.gdriveFolderRapat),
            listFolders(config.gdriveFolderSeminar),
        ]);

        return [...mapFolders(rapatFolders, 'rapat'), ...mapFolders(seminarFolders, 'seminar')]
            .sort(compareHistoryMeetings);
    } catch {
        throw new ControlPanelHistoryError();
    }
}

function mapFolders(
    folders: Awaited<ReturnType<typeof listDirectChildFolders>>,
    meetingType: ControlPanelHistoryMeeting['meetingType'],
): ControlPanelHistoryMeeting[] {
    return folders.map((folder) => ({
        id: folder.id,
        name: folder.name,
        meetingType,
        driveLink: folder.link,
        createdTime: folder.createdTime,
        modifiedTime: folder.modifiedTime,
    }));
}

function compareHistoryMeetings(
    left: ControlPanelHistoryMeeting,
    right: ControlPanelHistoryMeeting,
) {
    const leftTimestamp = getSortTimestamp(left);
    const rightTimestamp = getSortTimestamp(right);

    if (leftTimestamp !== rightTimestamp) {
        return rightTimestamp - leftTimestamp;
    }

    return left.name.localeCompare(right.name, undefined, { sensitivity: 'accent' });
}

function getSortTimestamp(meeting: ControlPanelHistoryMeeting) {
    return parseTimestamp(meeting.createdTime) ?? parseTimestamp(meeting.modifiedTime) ?? 0;
}

function parseTimestamp(value: string | null) {
    if (!value) {
        return null;
    }

    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
}
