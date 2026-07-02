import { AppConfig } from './config';

export type RecallRequestOptions = {
    body?: unknown;
    headers?: Record<string, string>;
    method?: 'GET' | 'POST';
};

export class RecallClient {
    private readonly baseUrl: string;

    constructor(private readonly config: AppConfig) {
        this.baseUrl = `https://${config.recallRegion}.recall.ai/api/v1`;
    }

    get region() {
        return this.config.recallRegion;
    }

    async request<T>(path: string, options: RecallRequestOptions = {}) {
        const response = await fetch(`${this.baseUrl}${path}`, {
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

        if (!response.ok) {
            const body = await response.text().catch(() => '');
            throw new Error(
                `Recall request failed with status ${response.status}: ${body.slice(0, 500)}`,
            );
        }

        if (response.status === 204) {
            return undefined as T;
        }

        return (await response.json()) as T;
    }

    async createBot(payload: unknown) {
        return this.request('/bot/', { method: 'POST', body: payload });
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
}
