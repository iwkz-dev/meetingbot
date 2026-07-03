import OpenAI from 'openai';
import { AppConfig, getConfig } from '../config';

let sharedClient: OpenAI | null = null;
let sharedSignature = '';

export function getOpenAIClient(
    config: Pick<AppConfig, 'openaiApiKey' | 'openaiTimeoutMs' | 'openaiMaxRetries'> = getConfig(),
) {
    const signature = `${config.openaiApiKey}:${config.openaiTimeoutMs}:${config.openaiMaxRetries}`;
    if (!sharedClient || sharedSignature !== signature) {
        sharedClient = new OpenAI({
            apiKey: config.openaiApiKey,
            timeout: config.openaiTimeoutMs,
            maxRetries: config.openaiMaxRetries,
        });
        sharedSignature = signature;
    }

    return sharedClient;
}

export function resetOpenAIClientForTests() {
    sharedClient = null;
    sharedSignature = '';
}
