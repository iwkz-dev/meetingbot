import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';

const CLIENT_ID = process.env.GDRIVE_CLIENT_ID;
const CLIENT_SECRET = process.env.GDRIVE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GDRIVE_REFRESH_TOKEN;
const OAUTH_REDIRECT_URI = process.env.GDRIVE_OAUTH_REDIRECT_URI;

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
): Promise<{ name: string; id: string; link: string }> {
    if (!folderId?.trim()) {
        throw new Error('Google Drive folder ID is required');
    }

    const drive = google.drive({ version: 'v3', auth: oAuth2Client });
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

    return {
        name: response.data.name!,
        id: response.data.id!,
        link: response.data.webViewLink!,
    };
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
