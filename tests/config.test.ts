import { strict as assert } from 'node:assert';
import test from 'node:test';
import { buildStartupConfigLogLines, createConfig } from '../src/config';
import { buildValidEnv } from './helpers';

test('createConfig validates required Recall variables', () => {
    assert.throws(
        () =>
            createConfig(buildValidEnv({ RECALL_API_KEY: '' }), {
                allowTestDefaults: false,
            }),
        /Missing required environment variables: RECALL_API_KEY/,
    );
});

test('createConfig validates required OpenAI variables', () => {
    assert.throws(
        () => createConfig(buildValidEnv({ OPENAI_API_KEY: '' })),
        /Missing required environment variables: OPENAI_API_KEY/,
    );
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
            OPENAI_MAX_OUTPUT_TOKENS: '7000',
            OPENAI_TIMEOUT_MS: '300000',
            OPENAI_MAX_RETRIES: '3',
            OPENAI_FILE_EXPIRY_SECONDS: '7200',
            OPENAI_DIRECT_MAX_INPUT_TOKENS: '260000',
            AI_DATE_TIMEZONE: 'Asia/Jakarta',
        }),
    );

    assert.equal(config.recallAutomaticLeave.waitingRoomTimeoutSeconds, 5);
    assert.equal(config.recallAutomaticLeave.nooneJoinedTimeoutSeconds, 6);
    assert.equal(config.recallAutomaticLeave.everyoneLeftTimeoutSeconds, 7);
    assert.equal(config.recallAutomaticLeave.everyoneLeftActivateAfterSeconds, 8);
    assert.equal(config.openaiMaxOutputTokens, 7000);
    assert.equal(config.openaiTimeoutMs, 300000);
    assert.equal(config.openaiMaxRetries, 3);
    assert.equal(config.openaiFileExpirySeconds, 7200);
    assert.equal(config.openaiDirectMaxInputTokens, 260000);
    assert.equal(config.aiDateTimezone, 'Asia/Jakarta');
    assert.match(config.dataDir, /tmp[\\/]meetings$/);
});

test('createConfig rejects invalid numeric OpenAI settings', () => {
    assert.throws(
        () => createConfig(buildValidEnv({ OPENAI_MAX_OUTPUT_TOKENS: '0' })),
        /OPENAI_MAX_OUTPUT_TOKENS must be at least 1/,
    );

    assert.throws(
        () => createConfig(buildValidEnv({ OPENAI_FILE_EXPIRY_SECONDS: '3599' })),
        /OPENAI_FILE_EXPIRY_SECONDS must be at least 3600/,
    );
});

test('createConfig rejects invalid AI timezone', () => {
    assert.throws(
        () => createConfig(buildValidEnv({ AI_DATE_TIMEZONE: 'Mars/Olympus' })),
        /AI_DATE_TIMEZONE must be a valid IANA timezone name/,
    );
});

test('OpenAI API key is omitted from serialized config and startup logs', () => {
    const config = createConfig(buildValidEnv({ OPENAI_API_KEY: 'sk-secret-openai-value' }));
    const serialized = JSON.stringify(config);
    const logs = buildStartupConfigLogLines(config).join('\n');

    assert.equal(serialized.includes('sk-secret-openai-value'), false);
    assert.equal(logs.includes('sk-secret-openai-value'), false);
    assert.equal(logs.includes(config.openaiModel), true);
});

