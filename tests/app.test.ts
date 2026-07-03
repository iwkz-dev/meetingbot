import { strict as assert } from 'node:assert';
import http from 'node:http';
import test from 'node:test';
import { AddressInfo } from 'node:net';
import { createApp } from '../src/app';
import { ControlPanelHistoryMeeting } from '../src/types';
import { buildConfig } from './helpers';

function createTestApp(options: {
    controlPanelPassword?: string;
    loadControlPanelHistory?: () => Promise<ControlPanelHistoryMeeting[]>;
}) {
    const config = buildConfig({
        CONTROL_PANEL_PASSWORD: options.controlPanelPassword ?? 'secret-pass',
    });

    return createApp({
        config,
        store: {
            listNewestFirst: async () => [],
        } as never,
        meetingController: {
            inviteBot: async () => ({ result: 'ok', message: 'bot join request accepted', meeting: { id: '1', recallBotId: 'bot-1', meetingSubject: 'Test', status: 'joining' } }),
            leaveMeeting: async () => ({ result: 'ok', message: 'left', meeting: { id: '1', recallBotId: 'bot-1', status: 'leaving' } }),
        } as never,
        recallWebhookService: {
            verifyAndParse: () => {
                throw new Error('unused');
            },
            acknowledgeAndProcess: () => undefined,
        } as never,
        loadControlPanelHistory: options.loadControlPanelHistory ?? (async () => []),
    });
}

async function withServer(app: ReturnType<typeof createApp>, run: (baseUrl: string) => Promise<void>) {
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
        const address = server.address() as AddressInfo;
        await run(`http://127.0.0.1:${address.port}`);
    } finally {
        await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
        );
    }
}

test('control panel history endpoint requires auth', async () => {
    const app = createTestApp({});

    await withServer(app, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/control-panel/history`);
        const payload = await response.json();

        assert.equal(response.status, 401);
        assert.equal(payload.message, 'Unauthorized');
    });
});

test('control panel history endpoint returns history after login', async () => {
    const app = createTestApp({
        loadControlPanelHistory: async () => [
            {
                id: 'folder-1',
                name: 'Board Weekly',
                meetingType: 'rapat',
                driveLink: 'https://drive.example/folders/folder-1',
                createdTime: '2026-07-03T08:00:00.000Z',
                modifiedTime: '2026-07-03T09:00:00.000Z',
            },
        ],
    });

    await withServer(app, async (baseUrl) => {
        const loginResponse = await fetch(`${baseUrl}/control-panel/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ password: 'secret-pass' }),
            redirect: 'manual',
        });
        const cookie = loginResponse.headers.get('set-cookie')?.split(';')[0] ?? '';

        const response = await fetch(`${baseUrl}/api/control-panel/history`, {
            headers: { Cookie: cookie },
        });
        const payload = await response.json();

        assert.equal(response.status, 200);
        assert.equal(payload.meetings.length, 1);
        assert.equal(payload.meetings[0].name, 'Board Weekly');
    });
});

test('control panel history endpoint returns safe error payloads', async () => {
    const config = buildConfig({ CONTROL_PANEL_PASSWORD: 'secret-pass' });
    const app = createApp({
        config,
        store: {
            listNewestFirst: async () => [],
        } as never,
        meetingController: {
            inviteBot: async () => ({ result: 'ok', message: 'bot join request accepted', meeting: { id: '1', recallBotId: 'bot-1', meetingSubject: 'Test', status: 'joining' } }),
            leaveMeeting: async () => ({ result: 'ok', message: 'left', meeting: { id: '1', recallBotId: 'bot-1', status: 'leaving' } }),
        } as never,
        recallWebhookService: {
            verifyAndParse: () => {
                throw new Error('unused');
            },
            acknowledgeAndProcess: () => undefined,
        } as never,
        loadControlPanelHistory: async () => {
            throw new Error(`boom ${config.gdriveRefreshToken} ${config.gdriveFolderRapat}`);
        },
    });

    await withServer(app, async (baseUrl) => {
        const loginResponse = await fetch(`${baseUrl}/control-panel/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ password: 'secret-pass' }),
            redirect: 'manual',
        });
        const cookie = loginResponse.headers.get('set-cookie')?.split(';')[0] ?? '';

        const response = await fetch(`${baseUrl}/api/control-panel/history`, {
            headers: { Cookie: cookie },
        });
        const payload = await response.json();
        const rawPayload = JSON.stringify(payload);

        assert.equal(response.status, 502);
        assert.equal(payload.message, 'Could not load meeting history from Google Drive.');
        assert.equal(rawPayload.includes(config.gdriveRefreshToken), false);
        assert.equal(rawPayload.includes(config.gdriveFolderRapat), false);
    });
});

