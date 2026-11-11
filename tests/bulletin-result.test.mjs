import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeBulletinOutcomes } from '../src/lib/agent/bulletin-result.ts';
import { shouldContinueAfterBulletin } from '../src/lib/agent/bulletin-tick.ts';

const ok = { attempted: true, sent: true, itemCount: 3, reason: null };
const empty = { attempted: true, sent: false, itemCount: 0, reason: 'no_qualifying_items' };
const failed = { attempted: true, sent: false, itemCount: 3, reason: 'delivery_failed', destinations: [{ destination: 'bale', sent: false, reason: 'delivery_failed', detail: 'HTTP 400' }] };

test('local success cannot hide a Bale failure', () => {
  const result = summarizeBulletinOutcomes([{ destination: 'local', summary: ok }, { destination: 'bale', summary: failed }]);
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'delivery_failed');
  assert.equal(result.destinations[1].detail, 'HTTP 400');
});
test('reports local-only explicitly rather than implying Bale', () => {
  const result = summarizeBulletinOutcomes([{ destination: 'local', summary: ok }]);
  assert.equal(result.sent, true);
  assert.deepEqual(result.destinations.map(x => x.destination), ['local']);
});
test('does not claim success when no articles qualified', () => {
  const result = summarizeBulletinOutcomes([{ destination: 'bale', summary: empty }]);
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'no_qualifying_items');
});
test('records each target independently when one had nothing to send', () => {
  const result = summarizeBulletinOutcomes([{ destination: 'local', summary: empty }, { destination: 'bale', summary: ok }]);
  assert.equal(result.sent, true);
  assert.equal(result.destinations[0].sent, false);
  assert.equal(result.destinations[1].sent, true);
});
test('empty bulletin does not starve a due regular ingest and analysis slot', () => {
  assert.equal(shouldContinueAfterBulletin('no_qualifying_items', true), true);
  assert.equal(shouldContinueAfterBulletin('nothing_new', true), true);
  assert.equal(shouldContinueAfterBulletin('no_qualifying_items', false), false);
  assert.equal(shouldContinueAfterBulletin('delivery_failed', true), false);
  assert.equal(shouldContinueAfterBulletin(null, true), false);
});
