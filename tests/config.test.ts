import { strict as assert } from 'node:assert';
import test from 'node:test';
import { createConfig } from '../src/config';

function buildValidEnv(
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

test('createConfig validates required Recall variables', () => {
    assert.throws(
        () =>
            createConfig(buildValidEnv({ RECALL_API_KEY: '' }), {
                allowTestDefaults: false,
            }),
        /Missing required environment variables: RECALL_API_KEY/,
    );
});

test('createConfig no longer requires a join-message environment variable', () => {
    const config = createConfig(buildValidEnv());

    assert.equal(config.recallRegion, 'eu-central-1');
});

test('createConfig rejects unsupported Recall region', () => {
    assert.throws(
        () =>
            createConfig(
                buildValidEnv({ RECALL_REGION: 'eu-west-1' as unknown as string }),
            ),
        /Invalid RECALL_REGION/,
    );
});

test('createConfig rejects non-public callback urls', () => {
    assert.throws(
        () =>
            createConfig(
                buildValidEnv({ PUBLIC_API_BASE_URL: 'http://localhost:3010' }),
            ),
        /PUBLIC_API_BASE_URL must use https:\/\//,
    );

    assert.throws(
        () =>
            createConfig(
                buildValidEnv({ PUBLIC_API_BASE_URL: 'https://127.0.0.1:3010' }),
            ),
        /stable public HTTPS backend URL/,
    );
});

test('createConfig parses timeout values and defaults data dir', () => {
    const config = createConfig(
        buildValidEnv({
            DATA_DIR: './tmp/meetings',
            RECALL_WAITING_ROOM_TIMEOUT_SECONDS: '5',
            RECALL_NOONE_JOINED_TIMEOUT_SECONDS: '6',
            RECALL_EVERYONE_LEFT_TIMEOUT_SECONDS: '7',
            RECALL_EVERYONE_LEFT_ACTIVATE_AFTER_SECONDS: '8',
        }),
    );

    assert.equal(config.recallAutomaticLeave.waitingRoomTimeoutSeconds, 5);
    assert.equal(config.recallAutomaticLeave.nooneJoinedTimeoutSeconds, 6);
    assert.equal(config.recallAutomaticLeave.everyoneLeftTimeoutSeconds, 7);
    assert.equal(config.recallAutomaticLeave.everyoneLeftActivateAfterSeconds, 8);
    assert.match(config.dataDir, /tmp[\\/]meetings$/);
});
