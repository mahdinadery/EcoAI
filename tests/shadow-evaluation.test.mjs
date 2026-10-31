import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateShadow, freshnessAt } from '../src/lib/ai/shadow-evaluation.ts';
const now = Date.parse('2026-10-28T12:00:00Z');
const date = '2026-10-28T10:00:00Z';
const text = 'بانک تخصیص اعتبار را منوط به امتیاز اعتباری کرد';
const base = { relation: 'direct', evidence: 'منوط به امتیاز اعتباری', impact: 4, reach: 3, urgency: 2 };
test('evidence-backed direct and impact news qualify using deterministic weighted importance', () => {
  for (const relation of ['direct', 'impact']) {
    const result = evaluateShadow({ ...base, relation }, text, date, now);
    assert.equal(result.importance, 83);
    assert.equal(result.decision, 'candidate');
  }
});
test('invented, absent or oversized evidence cannot qualify', () => {
  for (const evidence of ['شاهد ساختگی معتبر', '', 'ا'.repeat(181)]) {
    assert.equal(evaluateShadow({ ...base, evidence }, text, date, now).decision, 'review');
  }
});
test('malformed and absent shadow data fail to review, never throw', () => {
  for (const raw of [null, [], 'bad', { ...base, impact: '4' }, { ...base, reach: 7 }, { ...base, urgency: 1.5 }]) {
    assert.equal(evaluateShadow(raw, text, date, now).decision, 'review');
  }
});
test('unrelated high-impact news never qualify', () => {
  assert.equal(evaluateShadow({ ...base, relation: 'unrelated' }, text, date, now).decision, 'reject');
});
test('old, future and unknown dates require review; receipt time is not publication', () => {
  for (const value of [null, 'invalid', '2026-10-24T12:00:00Z', '2026-10-29T12:00:00Z']) {
    assert.equal(evaluateShadow(base, text, value, now).decision, 'review');
  }
});
test('freshness has deterministic inclusive boundaries', () => {
  for (const [hours, expected] of [[0,'fresh'], [24,'fresh'], [24.1,'recent'], [72,'recent'], [72.1,'old'], [-1,'future']]) {
    assert.equal(freshnessAt(new Date(now-hours*3600000).toISOString(), now).freshness, expected);
  }
});

test('schema ensure includes additive shadow migration', async () => {
  const { STEPS } = await import('../scripts/db-ensure.mjs');
  assert.ok(STEPS.some(s => s.name === 'column ai_analyses.shadow_evaluation' && s.sql.includes('IF NOT EXISTS')));
});

test('low importance remains rejected even for direct relevant news', () => {
  assert.equal(evaluateShadow({ ...base, impact: 1, reach: 1, urgency: 0 }, text, date, now).decision, 'reject');
});

test('dashboard importance threshold and freshness windows affect the shadow decision', () => {
  const policy = { shadowMinImportance: 90, freshHours: 1, recentHours: 4 };
  assert.equal(evaluateShadow(base, text, date, now, policy).decision, 'reject');
  assert.equal(evaluateShadow(base, text, date, now, {...policy, shadowMinImportance: 80}).decision, 'candidate');
  assert.equal(freshnessAt(date, now, policy).freshness, 'recent');
  assert.equal(freshnessAt(date, now, {freshHours:1, recentHours:1}).freshness, 'old');
});
