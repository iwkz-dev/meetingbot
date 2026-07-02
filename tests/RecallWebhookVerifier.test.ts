import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
    RecallWebhookVerificationError,
    RecallWebhookVerifier,
} from '../src/RecallWebhookVerifier';
import { buildConfig, signRecallWebhook } from './helpers';

test('RecallWebhookVerifier accepts valid current webhook headers', () => {
    const verifier = new RecallWebhookVerifier(buildConfig());
    const payload = JSON.stringify({ event: 'bot.joining_call', data: {} });
    const headers = signRecallWebhook({ payload });

    assert.doesNotThrow(() => verifier.verify(headers, Buffer.from(payload, 'utf8')));
});

test('RecallWebhookVerifier accepts valid legacy Svix headers', () => {
    const verifier = new RecallWebhookVerifier(buildConfig());
    const payload = JSON.stringify({ event: 'bot.joining_call', data: {} });
    const headers = signRecallWebhook({ payload, includeLegacyHeaders: true });

    assert.doesNotThrow(() => verifier.verify(headers, Buffer.from(payload, 'utf8')));
});

test('RecallWebhookVerifier rejects invalid signatures', () => {
    const verifier = new RecallWebhookVerifier(buildConfig());
    const payload = JSON.stringify({ event: 'bot.joining_call', data: {} });
    const headers = {
        ...signRecallWebhook({ payload }),
        'webhook-signature': 'v1,invalid-signature',
    };

    assert.throws(
        () => verifier.verify(headers, Buffer.from(payload, 'utf8')),
        (error: unknown) => {
            assert.ok(error instanceof RecallWebhookVerificationError);
            assert.equal(error.statusCode, 401);
            return true;
        },
    );
});

test('RecallWebhookVerifier rejects missing headers', () => {
    const verifier = new RecallWebhookVerifier(buildConfig());
    const payload = JSON.stringify({ event: 'bot.joining_call', data: {} });

    assert.throws(
        () => verifier.verify({}, Buffer.from(payload, 'utf8')),
        (error: unknown) => {
            assert.ok(error instanceof RecallWebhookVerificationError);
            assert.equal(error.statusCode, 400);
            return true;
        },
    );
});

test('RecallWebhookVerifier accepts multiple signatures when one is valid', () => {
    const verifier = new RecallWebhookVerifier(buildConfig());
    const payload = JSON.stringify({ event: 'bot.joining_call', data: {} });
    const headers = signRecallWebhook({
        payload,
        extraSignatures: ['v1,ZmFrZS1zaWduYXR1cmU=', 'v0,legacy'],
    });

    assert.doesNotThrow(() => verifier.verify(headers, Buffer.from(payload, 'utf8')));
});

test('RecallWebhookVerifier rejects a changed body even when headers are reused', () => {
    const verifier = new RecallWebhookVerifier(buildConfig());
    const originalPayload = JSON.stringify({ event: 'bot.joining_call', data: {} });
    const changedPayload = JSON.stringify({ event: 'bot.fatal', data: {} });
    const headers = signRecallWebhook({ payload: originalPayload });

    assert.throws(
        () => verifier.verify(headers, Buffer.from(changedPayload, 'utf8')),
        /Recall webhook signature did not match/,
    );
});
