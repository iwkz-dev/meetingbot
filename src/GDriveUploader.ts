import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';
import { DriveArtifact, DriveFolder } from './types';

const CLIENT_ID = process.env.GDRIVE_CLIENT_ID;
const CLIENT_SECRET = process.env.GDRIVE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GDRIVE_REFRESH_TOKEN;
const OAUTH_REDIRECT_URI = process.env.GDRIVE_OAUTH_REDIRECT_URI;
const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

type DriveFilesResourceLike = {
    create: (params: Record<string, unknown>) => Promise<{ data: Record<string, unknown> }>;
    list: (params: Record<string, unknown>) => Promise<{ data: { files?: Array<Record<string, unknown>> } }>;
};

type DriveLike = {
    files: DriveFilesResourceLike;
};

const oAuth2Client = new google.auth.OAuth2(
    CLIENT_ID,
    CLIENT_SECRET,
    OAUTH_REDIRECT_URI,
);
oAuth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });

export async function uploadFileToGDrive(
    finalFileName: string,
    localFilePath: string,
    folderId: string,
    drive: DriveLike = createDriveClient(),
): Promise<DriveArtifact> {
    if (!folderId?.trim()) {
        throw new Error('Google Drive folder ID is required');
    }

    const fileMetadata = {
        name: finalFileName,
        parents: [folderId],
    };

    const media = {
        mimeType: resolveDriveMimeType(localFilePath),
        body: fs.createReadStream(localFilePath),
    };

    const response = await drive.files.create({
        requestBody: fileMetadata,
        media,
        fields: 'id, name, webViewLink',
        supportsAllDrives: true,
    });

    return parseDriveArtifact(response.data, 'Uploaded Google Drive file response was incomplete');
}

export async function ensureMeetingFolder(
    folderName: string,
    parentFolderId: string,
    drive: DriveLike = createDriveClient(),
): Promise<DriveFolder> {
    if (!folderName.trim()) {
        throw new Error('Google Drive meeting folder name is required');
    }

    if (!parentFolderId.trim()) {
        throw new Error('Google Drive parent folder ID is required');
    }

    const existing = await drive.files.list({
        q: [
            `mimeType='${FOLDER_MIME_TYPE}'`,
            'trashed=false',
            `'${escapeDriveQueryValue(parentFolderId)}' in parents`,
            `name='${escapeDriveQueryValue(folderName)}'`,
        ].join(' and '),
        fields: 'files(id, name, webViewLink)',
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
        pageSize: 10,
    });

    const existingFolder = existing.data.files?.[0];
    if (existingFolder) {
        return parseDriveFolder(existingFolder, 'Existing Google Drive folder response was incomplete');
    }

    const created = await drive.files.create({
        requestBody: {
            name: folderName,
            mimeType: FOLDER_MIME_TYPE,
            parents: [parentFolderId],
        },
        fields: 'id, name, webViewLink',
        supportsAllDrives: true,
    });

    return parseDriveFolder(created.data, 'Created Google Drive folder response was incomplete');
}

export function resolveDriveMimeType(filePath: string) {
    switch (path.extname(filePath).toLowerCase()) {
        case '.mp4':
            return 'video/mp4';
        case '.json':
            return 'application/json';
        case '.txt':
            return 'text/plain; charset=utf-8';
        default:
            return 'application/octet-stream';
    }
}

function createDriveClient(): DriveLike {
    return google.drive({ version: 'v3', auth: oAuth2Client }) as unknown as DriveLike;
}

function parseDriveArtifact(data: Record<string, unknown>, errorMessage: string): DriveArtifact {
    const id = typeof data.id === 'string' ? data.id : '';
    const name = typeof data.name === 'string' ? data.name : '';
    const link = typeof data.webViewLink === 'string' ? data.webViewLink : '';

    if (!id || !name || !link) {
        throw new Error(errorMessage);
    }

    return { id, name, link };
}

function parseDriveFolder(data: Record<string, unknown>, errorMessage: string): DriveFolder {
    const id = typeof data.id === 'string' ? data.id : '';
    const name = typeof data.name === 'string' ? data.name : '';
    const link = typeof data.webViewLink === 'string' ? data.webViewLink : null;

    if (!id || !name) {
        throw new Error(errorMessage);
    }

    return { id, name, link };
}

function escapeDriveQueryValue(value: string) {
    return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

