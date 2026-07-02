import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppConfig, createConfig } from '../src/config';

export function buildValidEnv(
    overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
    return {
        PORT: '3010',
        NODE_ENV: 'test',
        CONTROL_PANEL_PASSWORD: '',
        DATA_DIR: './data-test',
        RECALL_REGION: 'eu-central-1',
        RECALL_API_KEY: 'recall-key',
        RECALL_WORKSPACE_VERIFICATION_SECRET: 'verify-secret',
        PUBLIC_API_BASE_URL: 'https://meetingbot.example.com',
        RECALL_WAITING_ROOM_TIMEOUT_SECONDS: '1200',
        RECALL_NOONE_JOINED_TIMEOUT_SECONDS: '1200',
        RECALL_EVERYONE_LEFT_TIMEOUT_SECONDS: '15',
        RECALL_EVERYONE_LEFT_ACTIVATE_AFTER_SECONDS: '0',
        RECALL_ON_JOIN_MESSAGE: '',
        GDRIVE_CLIENT_ID: 'client-id',
        GDRIVE_CLIENT_SECRET: 'client-secret',
        GDRIVE_REFRESH_TOKEN: 'refresh-token',
        GDRIVE_OAUTH_REDIRECT_URI:
            'https://developers.google.com/oauthplayground',
        GDRIVE_FOLDER_RAPAT: 'folder-rapat',
        GDRIVE_FOLDER_RAPAT_TMP: 'folder-rapat-tmp',
        GDRIVE_FOLDER_SEMINAR: 'folder-seminar',
        GDRIVE_FOLDER_SEMINAR_TMP: 'folder-seminar-tmp',
        ...overrides,
    };
}

export function buildConfig(
    overrides: Record<string, string | undefined> = {},
): AppConfig {
    return createConfig(buildValidEnv(overrides));
}

export async function createTempDir(prefix = 'meetingbot-tests-') {
    return fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
}
