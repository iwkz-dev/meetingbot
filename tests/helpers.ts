import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
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
        RECALL_WORKSPACE_VERIFICATION_SECRET: 'whsec_c2VjcmV0LXRlc3Qta2V5',
        PUBLIC_API_BASE_URL: 'https://meetingbot.example.com',
        RECALL_WAITING_ROOM_TIMEOUT_SECONDS: '1200',
        RECALL_NOONE_JOINED_TIMEOUT_SECONDS: '1200',
        RECALL_EVERYONE_LEFT_TIMEOUT_SECONDS: '15',
        RECALL_EVERYONE_LEFT_ACTIVATE_AFTER_SECONDS: '0',
        GDRIVE_CLIENT_ID: 'client-id',
        GDRIVE_CLIENT_SECRET: 'client-secret',
        GDRIVE_REFRESH_TOKEN: 'refresh-token',
        GDRIVE_OAUTH_REDIRECT_URI:
            'https://developers.google.com/oauthplayground',
        GDRIVE_FOLDER_RAPAT: 'folder-rapat',
        GDRIVE_FOLDER_SEMINAR: 'folder-seminar',
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

export function signRecallWebhook(args: {
    payload: string;
    secret?: string;
    msgId?: string;
    timestamp?: string;
    includeLegacyHeaders?: boolean;
    extraSignatures?: string[];
}) {
    const secret = args.secret ?? 'whsec_c2VjcmV0LXRlc3Qta2V5';
    const msgId = args.msgId ?? 'msg_test_123';
    const timestamp = args.timestamp ?? '1731705121';
    const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
    const expectedSig = crypto
        .createHmac('sha256', key)
        .update(`${msgId}.${timestamp}.${args.payload}`)
        .digest('base64');
    const signatureHeader = [`v1,${expectedSig}`, ...(args.extraSignatures ?? [])].join(' ');

    if (args.includeLegacyHeaders) {
        return {
            'svix-id': msgId,
            'svix-timestamp': timestamp,
            'svix-signature': signatureHeader,
        };
    }

    return {
        'webhook-id': msgId,
        'webhook-timestamp': timestamp,
        'webhook-signature': signatureHeader,
    };
}