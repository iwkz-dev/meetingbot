import { AppConfig } from './config';
import { RecallBotResponse } from './types';

const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504, 507]);
const MAX_ERROR_BODY_LENGTH = 500;

export type FetchLike = typeof fetch;

export type RecallRequestOptions = {
    body?: unknown;
    headers?: Record<string, string>;
    method?: 'GET' | 'POST';
    maxAttempts?: number;
};

export type RecallClientDependencies = {
    fetchImpl?: FetchLike;
    jitterMs?: () => number;
    sleep?: (delayMs: number) => Promise<void>;
};

export class RecallApiError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly responseBody: string,
    ) {
        super(message);
        this.name = 'RecallApiError';
    }
}

export class RecallClient {
    private readonly baseUrl: string;
    private readonly fetchImpl: FetchLike;
    private readonly jitterMs: () => number;
    private readonly sleep: (delayMs: number) => Promise<void>;

    constructor(
        private readonly config: AppConfig,
        dependencies: RecallClientDependencies = {},
    ) {
        this.baseUrl = `https://${config.recallRegion}.recall.ai/api/v1`;
        this.fetchImpl = dependencies.fetchImpl ?? fetch;
        this.jitterMs = dependencies.jitterMs ?? (() => Math.floor(Math.random() * 5001));
        this.sleep =
            dependencies.sleep ??
            ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    }

    get region() {
        return this.config.recallRegion;
    }

    async request<T>(path: string, options: RecallRequestOptions = {}) {
        const maxAttempts = options.maxAttempts ?? 6;
        let attempt = 0;
        let lastError: Error | null = null;

        while (attempt < maxAttempts) {
            attempt += 1;

            try {
                const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
                    method: options.method ?? 'GET',
                    headers: {
                        Authorization: `Token ${this.config.recallApiKey}`,
                        'Content-Type': 'application/json',
                        ...options.headers,
                    },
                    body:
                        options.body === undefined
                            ? undefined
                            : JSON.stringify(options.body),
                });

                if (response.ok) {
                    if (response.status === 204) {
                        return undefined as T;
                    }

                    return (await response.json()) as T;
                }

                const responseBody = truncateBody(
                    await response.text().catch(() => ''),
                );
                const error = new RecallApiError(
                    `Recall request failed with status ${response.status}: ${responseBody}`,
                    response.status,
                    responseBody,
                );

                if (!this.shouldRetry(response.status) || attempt >= maxAttempts) {
                    throw error;
                }

                await this.sleep(this.getRetryDelayMs(response, response.status));
                lastError = error;
            } catch (error) {
                if (error instanceof RecallApiError) {
                    throw error;
                }

                lastError = error instanceof Error ? error : new Error(String(error));
                if (attempt >= maxAttempts) {
                    throw lastError;
                }

                await this.sleep(1000 + this.jitterMs());
            }
        }

        throw lastError ?? new Error('Recall request failed');
    }

    async createBot(payload: unknown) {
        return this.request<RecallBotResponse>('/bot/', {
            method: 'POST',
            body: payload,
        });
    }

    async leaveBotCall(recallBotId: string) {
        return this.request(`/bot/${encodeURIComponent(recallBotId)}/leave_call/`, {
            method: 'POST',
        });
    }

    async getRecording(recallRecordingId: string) {
        return this.request(`/recording/${encodeURIComponent(recallRecordingId)}/`);
    }

    async getTranscript(recallTranscriptId: string) {
        return this.request(`/transcript/${encodeURIComponent(recallTranscriptId)}/`);
    }

    async createTranscript(recallRecordingId: string, payload: unknown) {
        return this.request(
            `/recording/${encodeURIComponent(recallRecordingId)}/create_transcript/`,
            {
                method: 'POST',
                body: payload,
            },
        );
    }

    private shouldRetry(status: number) {
        return RETRYABLE_STATUS_CODES.has(status);
    }

    private getRetryDelayMs(response: Response, status: number) {
        const retryAfterHeader = response.headers.get('Retry-After');
        const retryAfterMs = parseRetryAfterHeader(retryAfterHeader);
        const baseDelayMs =
            retryAfterMs ??
            (status === 507
                ? 30000
                : status === 429
                  ? 1000
                  : 1000);

        return baseDelayMs + this.jitterMs();
    }
}

function parseRetryAfterHeader(value: string | null) {
    if (!value) {
        return null;
    }

    const numericSeconds = Number.parseFloat(value);
    if (Number.isFinite(numericSeconds) && numericSeconds >= 0) {
        return Math.round(numericSeconds * 1000);
    }

    const dateValue = Date.parse(value);
    if (Number.isNaN(dateValue)) {
        return null;
    }

    return Math.max(0, dateValue - Date.now());
}

function truncateBody(value: string) {
    return value.slice(0, MAX_ERROR_BODY_LENGTH);
}
