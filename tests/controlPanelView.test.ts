import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

test('control panel invite form includes optional onJoinMessage field', async () => {
    const html = await fs.promises.readFile(
        path.join(process.cwd(), 'src/views/control-panel.html'),
        'utf8',
    );

    assert.match(html, /<label for="onJoinMessage">On-join Message<\/label>/);
    assert.match(html, /<textarea id="onJoinMessage" name="onJoinMessage" placeholder="This meeting is being recorded\."/);
    assert.match(html, /const payload = Object\.fromEntries\(new FormData\(inviteForm\)\.entries\(\)\);/);
    assert.match(html, /if \(response\.ok\) \{\s*inviteForm\.reset\(\);\s*\}/);
});