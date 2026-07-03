import { strict as assert } from 'node:assert';
import test from 'node:test';
import { ControlPanelHistoryError, listControlPanelHistory } from '../src/ControlPanelHistoryService';
import { buildConfig } from './helpers';

test('listControlPanelHistory combines both roots, labels type, and sorts newest first', async () => {
    const config = buildConfig({
        GDRIVE_FOLDER_RAPAT: 'rapat-root',
        GDRIVE_FOLDER_SEMINAR: 'seminar-root',
    });
    const calls: string[] = [];

    const result = await listControlPanelHistory(config, async (parentFolderId: string) => {
        calls.push(parentFolderId);

        if (parentFolderId === 'rapat-root') {
            return [
                {
                    id: 'rapat-1',
                    name: 'Rapat Weekly',
                    link: 'https://drive.example/folders/rapat-1',
                    createdTime: '2026-07-01T08:00:00.000Z',
                    modifiedTime: '2026-07-01T09:00:00.000Z',
                },
                {
                    id: 'rapat-2',
                    name: 'Alpha Archive',
                    link: 'https://drive.example/folders/rapat-2',
                    createdTime: null,
                    modifiedTime: '2026-06-10T09:00:00.000Z',
                },
            ];
        }

        return [
            {
                id: 'seminar-1',
                name: 'Seminar Launch',
                link: 'https://drive.example/folders/seminar-1',
                createdTime: '2026-07-03T08:00:00.000Z',
                modifiedTime: '2026-07-03T09:00:00.000Z',
            },
            {
                id: 'seminar-2',
                name: 'beta archive',
                link: 'https://drive.example/folders/seminar-2',
                createdTime: null,
                modifiedTime: null,
            },
        ];
    });

    assert.deepEqual(calls, ['rapat-root', 'seminar-root']);
    assert.deepEqual(
        result.map((entry) => ({ id: entry.id, type: entry.meetingType })),
        [
            { id: 'seminar-1', type: 'seminar' },
            { id: 'rapat-1', type: 'rapat' },
            { id: 'rapat-2', type: 'rapat' },
            { id: 'seminar-2', type: 'seminar' },
        ],
    );
});

test('listControlPanelHistory fails safely when one root cannot be read', async () => {
    const config = buildConfig({
        GDRIVE_FOLDER_RAPAT: 'rapat-secret-root',
        GDRIVE_FOLDER_SEMINAR: 'seminar-secret-root',
    });

    await assert.rejects(
        () =>
            listControlPanelHistory(config, async (parentFolderId: string) => {
                if (parentFolderId === 'seminar-secret-root') {
                    throw new Error(`boom ${config.gdriveRefreshToken} ${config.gdriveFolderSeminar}`);
                }

                return [];
            }),
        (error: unknown) => {
            assert.ok(error instanceof ControlPanelHistoryError);
            assert.equal(error.message, 'Could not load meeting history from Google Drive');
            assert.equal(error.message.includes(config.gdriveRefreshToken), false);
            assert.equal(error.message.includes(config.gdriveFolderSeminar), false);
            return true;
        },
    );
});
