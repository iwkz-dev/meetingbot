import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

test('control panel invite form includes optional onJoinMessage field', async () => {
    const html = await fs.promises.readFile(
        path.join(process.cwd(), 'src/views/control-panel.html'),
        'utf8',
    );

    assert.equal(html.includes('for="onJoinMessage"'), true);
    assert.equal(html.includes('On-join Message'), true);
    assert.equal(html.includes('id="onJoinMessage"'), true);
    assert.equal(html.includes('name="onJoinMessage"'), true);
    assert.equal(html.includes('placeholder="This meeting is being recorded."'), true);
    assert.match(html, /const payload = Object\.fromEntries\([\s\S]*new FormData\(inviteForm\)\.entries\(\)[\s\S]*\);/);
    assert.match(html, /if \(response\.ok\) \{\s*inviteForm\.reset\(\);\s*\}/);
});
