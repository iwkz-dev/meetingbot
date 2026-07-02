import { strict as assert } from 'node:assert';
import test from 'node:test';
import { resolveDriveMimeType } from '../src/GDriveUploader';

test('resolveDriveMimeType supports mp4 json txt and fallback', () => {
    assert.equal(resolveDriveMimeType('recording.mp4'), 'video/mp4');
    assert.equal(
        resolveDriveMimeType('recording.transcript.json'),
        'application/json',
    );
    assert.equal(
        resolveDriveMimeType('recording.transcript.txt'),
        'text/plain; charset=utf-8',
    );
    assert.equal(
        resolveDriveMimeType('recording.bin'),
        'application/octet-stream',
    );
});
