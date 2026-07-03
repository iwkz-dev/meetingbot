import { strict as assert } from 'node:assert';
import test from 'node:test';
import OpenAI from 'openai';
import { getOpenAIClient, resetOpenAIClientForTests } from '../src/openai/OpenAIClient';
import { buildConfig } from './helpers';

test('getOpenAIClient reuses one shared client for the same config', () => {
    resetOpenAIClientForTests();
    const config = buildConfig();

    const first = getOpenAIClient(config);
    const second = getOpenAIClient(config);

    assert.ok(first instanceof OpenAI);
    assert.equal(first, second);
});

test('getOpenAIClient rebuilds when transport config changes', () => {
    resetOpenAIClientForTests();
    const first = getOpenAIClient(buildConfig({ OPENAI_TIMEOUT_MS: '600000' }));
    const second = getOpenAIClient(buildConfig({ OPENAI_TIMEOUT_MS: '120000' }));

    assert.notEqual(first, second);
});
