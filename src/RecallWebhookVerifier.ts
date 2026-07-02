import crypto from 'crypto';
import { AppConfig } from './config';

const MAX_LOGGED_PAYLOAD_LENGTH = 1000;

type HeaderValue = string | string[] | undefined;

export type RecallWebhookHeaders = Record<string, HeaderValue>;

export type RecallWebhookLogger = {
    warn: (message: string, metadata?: unknown) => void;
};

export class RecallWebhookVerificationError extends Error {
    constructor(
        message: string,
        readonly statusCode: number,
    ) {
        super(message);
        this.name = 'RecallWebhookVerificationError';
    }
}

export class RecallWebhookVerifier {
    private readonly secret: string;
    private readonly logger: RecallWebhookLogger;

    constructor(config: AppConfig, logger: RecallWebhookLogger = console) {
        this.secret =
            config.recallSvixWebhookSecret ||
            config.recallWorkspaceVerificationSecret;
        this.logger = logger;
    }

    verify(headers: RecallWebhookHeaders, payload: Buffer | string | null) {
        const normalizedHeaders = normalizeHeaders(headers);
        const msgId = normalizedHeaders['webhook-id'] ?? normalizedHeaders['svix-id'];
        const msgTimestamp =
            normalizedHeaders['webhook-timestamp'] ?? normalizedHeaders['svix-timestamp'];
        const msgSignature =
            normalizedHeaders['webhook-signature'] ?? normalizedHeaders['svix-signature'];
        const payloadStr = toPayloadString(payload);

        try {
            if (!this.secret || !this.secret.startsWith('whsec_')) {
                throw new RecallWebhookVerificationError(
                    'Recall webhook verification secret is missing or invalid',
                    401,
                );
            }

            if (!msgId || !msgTimestamp || !msgSignature) {
                throw new RecallWebhookVerificationError(
                    'Missing Recall webhook verification headers',
                    400,
                );
            }

            const key = Buffer.from(this.secret.slice('whsec_'.length), 'base64');
            const toSign = `${msgId}.${msgTimestamp}.${payloadStr}`;
            const expectedSig = crypto
                .createHmac('sha256', key)
                .update(toSign)
                .digest('base64');
            const expectedSigBytes = Buffer.from(expectedSig, 'base64');

            for (const versionedSig of msgSignature.split(' ')) {
                const [version, signature] = versionedSig.split(',', 2);
                if (version !== 'v1' || !signature) {
                    continue;
                }

                const sigBytes = Buffer.from(signature, 'base64');
                if (
                    sigBytes.length === expectedSigBytes.length &&
                    crypto.timingSafeEqual(sigBytes, expectedSigBytes)
                ) {
                    return;
                }
            }

            throw new RecallWebhookVerificationError(
                'Recall webhook signature did not match',
                401,
            );
        } catch (error) {
            this.logger.warn('Recall webhook verification failed', {
                reason: error instanceof Error ? error.message : String(error),
                hasWebhookId: Boolean(msgId),
                hasWebhookTimestamp: Boolean(msgTimestamp),
                hasWebhookSignature: Boolean(msgSignature),
                payloadPreview: payloadStr.slice(0, MAX_LOGGED_PAYLOAD_LENGTH),
            });
            throw error;
        }
    }
}

function normalizeHeaders(headers: RecallWebhookHeaders) {
    const normalized: Record<string, string> = {};

    for (const [key, value] of Object.entries(headers)) {
        normalized[key.toLowerCase()] = Array.isArray(value)
            ? value.join(',')
            : value ?? '';
    }

    return normalized;
}

function toPayloadString(payload: Buffer | string | null) {
    if (!payload) {
        return '';
    }

    if (Buffer.isBuffer(payload)) {
        return payload.toString('utf8');
    }

    return payload;
}
