import path from 'path';
import { RecallAutomaticLeaveConfig, RecallRegion } from './types';

const RECALL_REGIONS: RecallRegion[] = [
    'us-west-2',
    'us-east-1',
    'eu-central-1',
    'ap-northeast-1',
];

export type AppConfig = {
    port: number;
    nodeEnv: string;
    controlPanelPassword: string;
    dataDir: string;
    recallRegion: RecallRegion;
    recallApiKey: string;
    recallWorkspaceVerificationSecret: string;
    recallSvixWebhookSecret: string;
    publicApiBaseUrl: string;
    recallAutomaticLeave: RecallAutomaticLeaveConfig;
    gdriveClientId: string;
    gdriveClientSecret: string;
    gdriveRefreshToken: string;
    gdriveOauthRedirectUri: string;
    gdriveFolderRapat: string;
    gdriveFolderSeminar: string;
    openaiApiKey: string;
    openaiModel: string;
    openaiMaxOutputTokens: number;
    openaiTimeoutMs: number;
    openaiMaxRetries: number;
    openaiFileExpirySeconds: number;
    openaiDirectMaxInputTokens: number;
    aiDateTimezone: string;
};

export type ConfigOptions = {
    allowTestDefaults?: boolean;
};

let cachedConfig: AppConfig | null = null;

export function getConfig() {
    if (!cachedConfig) {
        cachedConfig = createConfig(process.env);
        for (const line of buildStartupConfigLogLines(cachedConfig)) {
            console.log(line);
        }
    }

    return cachedConfig;
}

export function createConfig(
    env: NodeJS.ProcessEnv,
    options: ConfigOptions = {},
): AppConfig {
    const allowTestDefaults = options.allowTestDefaults ?? false;
    const missing: string[] = [];

    const optional = (key: string, fallback = '') => env[key]?.trim() ?? fallback;
    const required = (key: string) => {
        const value = env[key]?.trim();
        if (!value && !allowTestDefaults) {
            missing.push(key);
        }
        return value ?? '';
    };

    const recallRegion = required('RECALL_REGION') as RecallRegion;
    if (recallRegion && !RECALL_REGIONS.includes(recallRegion)) {
        throw new Error(
            `Invalid RECALL_REGION "${recallRegion}". Expected one of: ${RECALL_REGIONS.join(', ')}`,
        );
    }

    const port = parseNonNegativeInteger(env.PORT, 'PORT', 3010);
    const dataDir = path.resolve(optional('DATA_DIR', './data'));
    const publicApiBaseUrl = required('PUBLIC_API_BASE_URL');
    const recallApiKey = required('RECALL_API_KEY');
    const recallWorkspaceVerificationSecret = required(
        'RECALL_WORKSPACE_VERIFICATION_SECRET',
    );
    const recallSvixWebhookSecret = optional('RECALL_SVIX_WEBHOOK_SECRET');
    const gdriveClientId = required('GDRIVE_CLIENT_ID');
    const gdriveClientSecret = required('GDRIVE_CLIENT_SECRET');
    const gdriveRefreshToken = required('GDRIVE_REFRESH_TOKEN');
    const gdriveOauthRedirectUri = required('GDRIVE_OAUTH_REDIRECT_URI');
    const gdriveFolderRapat = required('GDRIVE_FOLDER_RAPAT');
    const gdriveFolderSeminar = required('GDRIVE_FOLDER_SEMINAR');
    const openaiApiKey = required('OPENAI_API_KEY');
    const openaiModel = optional('OPENAI_MODEL', 'gpt-5.4-mini') || 'gpt-5.4-mini';
    const openaiMaxOutputTokens = parsePositiveSafeInteger(
        env.OPENAI_MAX_OUTPUT_TOKENS,
        'OPENAI_MAX_OUTPUT_TOKENS',
        6000,
        { min: 1, max: 100000 },
    );
    const openaiTimeoutMs = parsePositiveSafeInteger(
        env.OPENAI_TIMEOUT_MS,
        'OPENAI_TIMEOUT_MS',
        600000,
        { min: 1000, max: 3600000 },
    );
    const openaiMaxRetries = parseNonNegativeInteger(
        env.OPENAI_MAX_RETRIES,
        'OPENAI_MAX_RETRIES',
        4,
        { min: 0, max: 10 },
    );
    const openaiFileExpirySeconds = parsePositiveSafeInteger(
        env.OPENAI_FILE_EXPIRY_SECONDS,
        'OPENAI_FILE_EXPIRY_SECONDS',
        86400,
        { min: 3600, max: 2592000 },
    );
    const openaiDirectMaxInputTokens = parsePositiveSafeInteger(
        env.OPENAI_DIRECT_MAX_INPUT_TOKENS,
        'OPENAI_DIRECT_MAX_INPUT_TOKENS',
        250000,
        { min: 1, max: 2000000 },
    );
    const aiDateTimezone = optional('AI_DATE_TIMEZONE', 'Asia/Jakarta') || 'Asia/Jakarta';

    if (publicApiBaseUrl) {
        validatePublicApiBaseUrl(publicApiBaseUrl);
    }

    validateTimeZone(aiDateTimezone);

    if (missing.length) {
        throw new Error(
            `Missing required environment variables: ${missing.join(', ')}`,
        );
    }

    return attachSafeConfigSerializer({
        port,
        nodeEnv: optional('NODE_ENV', 'development') || 'development',
        controlPanelPassword: optional('CONTROL_PANEL_PASSWORD'),
        dataDir,
        recallRegion: recallRegion || 'eu-central-1',
        recallApiKey,
        recallWorkspaceVerificationSecret,
        recallSvixWebhookSecret,
        publicApiBaseUrl,
        recallAutomaticLeave: {
            waitingRoomTimeoutSeconds: parseNonNegativeInteger(
                env.RECALL_WAITING_ROOM_TIMEOUT_SECONDS,
                'RECALL_WAITING_ROOM_TIMEOUT_SECONDS',
                1200,
            ),
            nooneJoinedTimeoutSeconds: parseNonNegativeInteger(
                env.RECALL_NOONE_JOINED_TIMEOUT_SECONDS,
                'RECALL_NOONE_JOINED_TIMEOUT_SECONDS',
                1200,
            ),
            everyoneLeftTimeoutSeconds: parseNonNegativeInteger(
                env.RECALL_EVERYONE_LEFT_TIMEOUT_SECONDS,
                'RECALL_EVERYONE_LEFT_TIMEOUT_SECONDS',
                15,
            ),
            everyoneLeftActivateAfterSeconds: parseNonNegativeInteger(
                env.RECALL_EVERYONE_LEFT_ACTIVATE_AFTER_SECONDS,
                'RECALL_EVERYONE_LEFT_ACTIVATE_AFTER_SECONDS',
                0,
            ),
        },
        gdriveClientId,
        gdriveClientSecret,
        gdriveRefreshToken,
        gdriveOauthRedirectUri,
        gdriveFolderRapat,
        gdriveFolderSeminar,
        openaiApiKey,
        openaiModel,
        openaiMaxOutputTokens,
        openaiTimeoutMs,
        openaiMaxRetries,
        openaiFileExpirySeconds,
        openaiDirectMaxInputTokens,
        aiDateTimezone,
    });
}

export function buildStartupConfigLogLines(config: AppConfig) {
    return [
        `[config] Recall region: ${config.recallRegion}`,
        `[config] OpenAI model: ${config.openaiModel}`,
        `[config] OpenAI timeoutMs: ${config.openaiTimeoutMs} retries: ${config.openaiMaxRetries} timezone: ${config.aiDateTimezone}`,
    ];
}

function parseNonNegativeInteger(
    rawValue: string | undefined,
    envName: string,
    fallback: number,
    bounds: { min?: number; max?: number } = {},
) {
    const trimmed = rawValue?.trim();
    if (!trimmed) {
        return fallback;
    }

    if (!/^\d+$/.test(trimmed)) {
        throw new Error(`${envName} must be a non-negative integer.`);
    }

    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new Error(`${envName} must be a non-negative integer.`);
    }

    if (bounds.min !== undefined && parsed < bounds.min) {
        throw new Error(`${envName} must be at least ${bounds.min}.`);
    }

    if (bounds.max !== undefined && parsed > bounds.max) {
        throw new Error(`${envName} must be at most ${bounds.max}.`);
    }

    return parsed;
}

function parsePositiveSafeInteger(
    rawValue: string | undefined,
    envName: string,
    fallback: number,
    bounds: { min?: number; max?: number } = {},
) {
    const parsed = parseNonNegativeInteger(rawValue, envName, fallback, bounds);
    if (parsed <= 0) {
        throw new Error(`${envName} must be a positive integer.`);
    }

    if (bounds.min !== undefined && parsed < bounds.min) {
        throw new Error(`${envName} must be at least ${bounds.min}.`);
    }

    return parsed;
}

function validatePublicApiBaseUrl(value: string) {
    let parsed: URL;

    try {
        parsed = new URL(value);
    } catch {
        throw new Error('PUBLIC_API_BASE_URL must be a valid URL.');
    }

    if (parsed.protocol !== 'https:') {
        throw new Error('PUBLIC_API_BASE_URL must use https://');
    }

    const hostname = parsed.hostname.toLowerCase();
    if (
        hostname === 'localhost' ||
        hostname.endsWith('.localhost') ||
        /^127\./.test(hostname) ||
        hostname === '0.0.0.0'
    ) {
        throw new Error(
            'PUBLIC_API_BASE_URL must be a stable public HTTPS backend URL.',
        );
    }
}

function validateTimeZone(value: string) {
    try {
        new Intl.DateTimeFormat('id-ID', {
            timeZone: value,
            day: 'numeric',
            month: 'long',
            year: 'numeric',
        }).format(new Date('2026-07-03T00:00:00.000Z'));
    } catch {
        throw new Error('AI_DATE_TIMEZONE must be a valid IANA timezone name.');
    }
}

function attachSafeConfigSerializer(config: AppConfig): AppConfig {
    const safeConfig = {
        port: config.port,
        nodeEnv: config.nodeEnv,
        dataDir: config.dataDir,
        recallRegion: config.recallRegion,
        publicApiBaseUrl: config.publicApiBaseUrl,
        recallAutomaticLeave: config.recallAutomaticLeave,
        gdriveOauthRedirectUri: config.gdriveOauthRedirectUri,
        gdriveFolderRapat: config.gdriveFolderRapat,
        gdriveFolderSeminar: config.gdriveFolderSeminar,
        openaiModel: config.openaiModel,
        openaiMaxOutputTokens: config.openaiMaxOutputTokens,
        openaiTimeoutMs: config.openaiTimeoutMs,
        openaiMaxRetries: config.openaiMaxRetries,
        openaiFileExpirySeconds: config.openaiFileExpirySeconds,
        openaiDirectMaxInputTokens: config.openaiDirectMaxInputTokens,
        aiDateTimezone: config.aiDateTimezone,
    };

    Object.defineProperty(config, 'toJSON', {
        enumerable: false,
        configurable: false,
        writable: false,
        value: () => safeConfig,
    });

    return config;
}
