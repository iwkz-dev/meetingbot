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
};

export type ConfigOptions = {
    allowTestDefaults?: boolean;
};

let cachedConfig: AppConfig | null = null;

export function getConfig() {
    if (!cachedConfig) {
        cachedConfig = createConfig(process.env);
        console.log(`[config] Recall region: ${cachedConfig.recallRegion}`);
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

    const port = parseInteger(env.PORT, 'PORT', 3010);
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

    if (publicApiBaseUrl) {
        validatePublicApiBaseUrl(publicApiBaseUrl);
    }

    if (missing.length) {
        throw new Error(
            `Missing required environment variables: ${missing.join(', ')}`,
        );
    }

    return {
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
            waitingRoomTimeoutSeconds: parseInteger(
                env.RECALL_WAITING_ROOM_TIMEOUT_SECONDS,
                'RECALL_WAITING_ROOM_TIMEOUT_SECONDS',
                1200,
            ),
            nooneJoinedTimeoutSeconds: parseInteger(
                env.RECALL_NOONE_JOINED_TIMEOUT_SECONDS,
                'RECALL_NOONE_JOINED_TIMEOUT_SECONDS',
                1200,
            ),
            everyoneLeftTimeoutSeconds: parseInteger(
                env.RECALL_EVERYONE_LEFT_TIMEOUT_SECONDS,
                'RECALL_EVERYONE_LEFT_TIMEOUT_SECONDS',
                15,
            ),
            everyoneLeftActivateAfterSeconds: parseInteger(
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
    };
}

function parseInteger(
    rawValue: string | undefined,
    envName: string,
    fallback: number,
) {
    const trimmed = rawValue?.trim();
    if (!trimmed) {
        return fallback;
    }

    if (!/^\d+$/.test(trimmed)) {
        throw new Error(`${envName} must be a non-negative integer.`);
    }

    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`${envName} must be a non-negative integer.`);
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