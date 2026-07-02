import { strict as assert } from 'node:assert';
import test from 'node:test';
import { ensureMeetingFolder, resolveDriveMimeType } from '../src/GDriveUploader';

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

test('ensureMeetingFolder reuses existing folder before creating a new one', async () => {
    const calls: string[] = [];
    const folder = await ensureMeetingFolder('HelloWorld_2026-07-02', 'parent-1', {
        files: {
            list: async () => {
                calls.push('list');
                return {
                    data: {
                        files: [
                            {
                                id: 'folder-1',
                                name: 'HelloWorld_2026-07-02',
                                webViewLink: 'https://drive.example/folders/folder-1',
                            },
                        ],
                    },
                };
            },
            create: async () => {
                calls.push('create');
                return { data: {} };
            },
        },
    });

    assert.deepEqual(calls, ['list']);
    assert.equal(folder.id, 'folder-1');
    assert.equal(folder.name, 'HelloWorld_2026-07-02');
});
