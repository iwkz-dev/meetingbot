import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
    normalizeMeetingType,
    sanitizeFilenameBaseName,
} from '../src/filename';

test('normalizeMeetingType accepts seminar and rapat only', () => {
    assert.equal(normalizeMeetingType(' seminar '), 'SEMINAR');
    assert.equal(normalizeMeetingType('RAPAT'), 'RAPAT');
    assert.throws(
        () => normalizeMeetingType('webinar'),
        /meetingType must be either seminar or rapat/,
    );
});

test('sanitizeFilenameBaseName strips forbidden characters and collapses spacing', () => {
    assert.equal(
        sanitizeFilenameBaseName('Quarterly Review: Sales / DACH'),
        'Quarterly_Review_Sales_DACH',
    );
    assert.equal(sanitizeFilenameBaseName('   '), 'meeting');
    assert.equal(
        sanitizeFilenameBaseName('Einfuhrung in die KI   mit   Teams'),
        'Einfuhrung_in_die_KI_mit_Teams',
    );
});

test('sanitizeFilenameBaseName enforces a safe maximum length', () => {
    const longValue = 'a'.repeat(120);
    assert.equal(sanitizeFilenameBaseName(longValue).length, 80);
});
