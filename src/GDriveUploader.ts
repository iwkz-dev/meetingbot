import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';
import { randomUUID } from 'crypto';

const CLIENT_ID = process.env.GDRIVE_CLIENT_ID;
const CLIENT_SECRET = process.env.GDRIVE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GDRIVE_REFRESH_TOKEN;
const OAUTH_REDIRECT_URI = process.env.GDRIVE_OAUTH_REDIRECT_URI;

const oAuth2Client = new google.auth.OAuth2(
    CLIENT_ID,
    CLIENT_SECRET,
    OAUTH_REDIRECT_URI
);
oAuth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });

export async function uploadFileToGDrive(
    uploadedFileName: string,
    recordingFilePath: string,
    folderId: string
): Promise<{ name: string; id: string; link: string }> {
    const drive = google.drive({ version: 'v3', auth: oAuth2Client });

    const extension = path.extname(recordingFilePath);
    const givenFileName = uploadedFileName || randomUUID();
    const fileName = `${givenFileName}${extension}`;

    const fileMetadata: any = {
        name: fileName,
        parents: [folderId],
    };

    const media = {
        mimeType: 'video/webm',
        body: fs.createReadStream(recordingFilePath),
    };

    const res = await drive.files.create({
        requestBody: fileMetadata,
        media,
        fields: 'id, name, webViewLink',
        supportsAllDrives: true,
    });

    console.log(`File Uploaded: ${res.data.name}`);
    console.log(`Link: ${res.data.webViewLink}`);

    return {
        name: res.data.name!,
        id: res.data.id!,
        link: res.data.webViewLink!,
    };
}
