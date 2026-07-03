import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
    ensureMeetingFolder,
    listDirectChildFolders,
    resolveDriveMimeType,
} from '../src/GDriveUploader';

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
            get: async () => ({ data: '' }),
        },
    });

    assert.deepEqual(calls, ['list']);
    assert.equal(folder.id, 'folder-1');
    assert.equal(folder.name, 'HelloWorld_2026-07-02');
});

test('listDirectChildFolders paginates and validates safe folder fields', async () => {
    const calls: Array<Record<string, unknown>> = [];

    const folders = await listDirectChildFolders('root-folder', {
        files: {
            create: async () => ({ data: {} }),
            get: async () => ({ data: '' }),
            list: async (params) => {
                calls.push(params);

                if (params.pageToken === undefined) {
                    return {
                        data: {
                            nextPageToken: 'page-2',
                            files: [
                                {
                                    id: 'folder-2',
                                    name: 'Beta Session',
                                    webViewLink: 'javascript:alert(1)',
                                    createdTime: '2026-07-01T09:00:00.000Z',
                                    modifiedTime: 'not-a-date',
                                },
                            ],
                        },
                    };
                }

                return {
                    data: {
                        files: [
                            {
                                id: 'folder-1',
                                name: 'Alpha Session',
                                webViewLink: 'https://drive.example/folders/folder-1',
                                createdTime: '2026-07-02T10:00:00.000Z',
                                modifiedTime: '2026-07-02T11:00:00.000Z',
                            },
                        ],
                    },
                };
            },
        },
    });

    assert.equal(calls.length, 2);
    assert.equal(
        calls[0]?.q,
        "'root-folder' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false",
    );
    assert.equal(
        calls[0]?.fields,
        'nextPageToken, files(id, name, webViewLink, createdTime, modifiedTime)',
    );
    assert.equal(calls[0]?.spaces, 'drive');
    assert.equal(calls[0]?.supportsAllDrives, true);
    assert.equal(calls[0]?.includeItemsFromAllDrives, true);
    assert.equal(calls[0]?.pageSize, 100);
    assert.equal(calls[1]?.pageToken, 'page-2');
    assert.deepEqual(folders, [
        {
            id: 'folder-2',
            name: 'Beta Session',
            link: null,
            createdTime: '2026-07-01T09:00:00.000Z',
            modifiedTime: null,
        },
        {
            id: 'folder-1',
            name: 'Alpha Session',
            link: 'https://drive.example/folders/folder-1',
            createdTime: '2026-07-02T10:00:00.000Z',
            modifiedTime: '2026-07-02T11:00:00.000Z',
        },
    ]);
});
