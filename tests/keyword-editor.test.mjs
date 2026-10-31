import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKeywordText, reconcileKeywordText } from '../src/lib/admin/keyword-editor.ts';
test('typing a separator or space preserves raw input for the next keyword', () => {
  for (const text of ['بانک،', 'بانک، ', 'بانک,', 'بانک\n', 'بانک مرکزی ']) {
    assert.equal(reconcileKeywordText(text, parseKeywordText(text)), text);
  }
});
test('parses Persian commas, Latin commas and lines for immediate save', () => {
  assert.deepEqual(parseKeywordText('بانک، نکول, وثیقه\nضمانت، '), ['بانک','نکول','وثیقه','ضمانت']);
});
test('external preset, reset and removal updates replace stale input', () => {
  assert.equal(reconcileKeywordText('بانک، ', ['نکول']), 'نکول');
  assert.equal(reconcileKeywordText('بانک، ', []), '');
});
