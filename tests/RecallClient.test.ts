import { strict as assert } from 'node:assert';
import test from 'node:test';
import { RecallApiError, RecallClient } from '../src/RecallClient';
import { buildConfig } from './helpers';

test('RecallClient retries 429 responses using Retry-After', async () => {
    const sleepCalls: number[] = [];
    let attempts = 0;
    const client = new RecallClient(buildConfig(), {
        fetchImpl: async () => {
            attempts += 1;
            if (attempts === 1) {
                return new Response('rate limited', {
                    status: 429,
                    headers: { 'Retry-After': '2' },
                });
            }

            return new Response(JSON.stringify({ id: 'bot-123' }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        },
        jitterMs: () => 0,
        sleep: async (delayMs) => {
            sleepCalls.push(delayMs);
        },
    });

    const result = await client.createBot({ hello: 'world' });

    assert.equal(result.id, 'bot-123');
    assert.equal(attempts, 2);
    assert.deepEqual(sleepCalls, [2000]);
});

test('RecallClient retries 507 responses with default delay', async () => {
    const sleepCalls: number[] = [];
    let attempts = 0;
    const client = new RecallClient(buildConfig(), {
        fetchImpl: async () => {
            attempts += 1;
            if (attempts === 1) {
                return new Response('insufficient storage', {
                    status: 507,
                });
            }

            return new Response(JSON.stringify({ id: 'bot-507' }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        },
        jitterMs: () => 0,
        sleep: async (delayMs) => {
            sleepCalls.push(delayMs);
        },
    });

    const result = await client.createBot({ hello: 'world' });

    assert.equal(result.id, 'bot-507');
    assert.equal(attempts, 2);
    assert.deepEqual(sleepCalls, [30000]);
});

test('RecallClient does not retry ordinary 400 responses', async () => {
    let attempts = 0;
    const client = new RecallClient(buildConfig(), {
        fetchImpl: async () => {
            attempts += 1;
            return new Response('invalid request', {
                status: 400,
            });
        },
        jitterMs: () => 0,
        sleep: async () => {
            throw new Error('sleep should not be called');
        },
    });

    await assert.rejects(
        () => client.createBot({ hello: 'world' }),
        (error: unknown) => {
            assert.ok(error instanceof RecallApiError);
            assert.equal(error.status, 400);
            assert.match(error.message, /invalid request/);
            return true;
        },
    );
    assert.equal(attempts, 1);
});
