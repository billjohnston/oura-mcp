import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPrivacyAudit } from '../dist/services/audit.js';
import { OuraCache } from '../dist/services/cache.js';
import { applyPrivacy, normalizeStreams } from '../dist/services/privacy.js';
import { redactErrorMessage, redactSensitive } from '../dist/services/redaction.js';

// Field names here match a real Oura v2 workout record: `calories`, `activity`,
// `intensity`, `start_datetime`/`end_datetime`. The location keys are hypothetical —
// Oura does not send them today — but they are exactly what must never survive if it
// starts to, so the redaction is pinned before the schema can grow into it.
const workout = {
  id: 'ba6f31ba-c96c-4219-bec5-e45bfff64e44',
  day: '2026-08-12',
  activity: 'walking',
  intensity: 'moderate',
  calories: 172.13,
  distance: 3658.91,
  start_datetime: '2026-08-12T08:26:00.000-04:00',
  end_datetime: '2026-08-12T09:10:00.000-04:00',
  label: null,
  source: 'confirmed',
  start_latlng: [40.1, -73.1],
  map: { summary_polyline: 'encoded' },
  average_heart_rate: 142
};

// structured must keep what makes a workout analysable and drop only identity/location.
const structured = applyPrivacy('/usercollection/workout', workout, 'structured');
assert.equal(structured.id, 'ba6f31ba-c96c-4219-bec5-e45bfff64e44');
assert.equal(structured.average_heart_rate, 142);
for (const [field, expected] of [
  ['start_datetime', '2026-08-12T08:26:00.000-04:00'],
  ['end_datetime', '2026-08-12T09:10:00.000-04:00'],
  ['activity', 'walking'],
  ['intensity', 'moderate'],
  ['calories', 172.13],
  ['distance', 3658.91]
]) {
  assert.equal(structured[field], expected, `structured must keep the analytic field ${field}`);
}
// Duration is derived: Oura only sends the two endpoints. 08:26 -> 09:10 is 44 minutes.
assert.equal(structured.duration_seconds, 2640, 'structured must derive duration_seconds from the window');
assert.equal(structured.start_latlng, undefined, 'GPS must not survive structured');
assert.equal(structured.map, undefined, 'route polylines must not survive structured');

const summary = applyPrivacy('/usercollection/workout', workout, 'summary');
assert.equal(summary.activity, 'walking');
assert.equal(summary.calories, 172.13);
assert.equal(summary.intensity, 'moderate');
assert.equal(summary.map, undefined);
assert.equal(summary.start_latlng, undefined);

const raw = applyPrivacy('/usercollection/workout', workout, 'raw');
assert.equal(raw.map.summary_polyline, 'encoded');

// personal_info: direct identifiers go, body metrics stay (age feeds the HRmax fallback).
const person = { id: 'user-abc', email: 'someone@example.com', age: 41, biological_sex: 'male', height: 1.8, weight: 82.1 };
const personStructured = applyPrivacy('/usercollection/personal_info', person, 'structured');
assert.equal(personStructured.email, undefined, 'email must not survive structured');
assert.equal(personStructured.id, undefined, 'the account id must not survive structured');
assert.equal(personStructured.age, 41);
assert.equal(personStructured.biological_sex, 'male');
assert.equal(personStructured.height, 1.8);
assert.equal(personStructured.weight, 82.1);
assert.equal(applyPrivacy('/usercollection/personal_info', person, 'raw').email, 'someone@example.com');

const futureStructured = applyPrivacy('/usercollection/daily_readiness', {
  id: 'future-record',
  day: '2026-07-08',
  score: 84,
  contributors: { recovery_index: 91 },
  futureMetrics: { cardiovascularAge: 37 },
}, 'structured');
assert.deepEqual(futureStructured.contributors, { recovery_index: 91 });
assert.deepEqual(futureStructured.futureMetrics, { cardiovascularAge: 37 });

const streams = normalizeStreams({ heartrate: { data: [120, 121] }, latlng: { data: [[1, 2]] } }, 'structured', false);
assert.equal(streams.latlng, undefined);
assert.deepEqual(streams.heartrate.data, [120, 121]);

assert.equal(redactSensitive({ access_token: 'abc', nested: { client_secret: 'def' } }).access_token, '[REDACTED]');
assert.match(redactErrorMessage('Authorization: Bearer abc.def.ghi'), /REDACTED/);
assert.equal(buildPrivacyAudit().unofficial, true);
assert.equal(buildPrivacyAudit().gps_redaction_default, true);

const dir = mkdtempSync(join(tmpdir(), 'oura-mcp-cache-'));
try {
  const path = join(dir, 'cache.sqlite');
  const cache = new OuraCache(path);
  cache.set('GET', 'https://example.com/a', { ok: true });
  assert.deepEqual(cache.get('GET', 'https://example.com/a'), { ok: true });
  assert.equal(cache.status().entries, 1);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(JSON.stringify({ ok: true, privacy: true, cache: true, redaction: true, audit: true }, null, 2));

// Agent raw escalation requires explicit_user_intent
{
  const { resolvePrivacyMode } = await import('../dist/services/privacy.js');
  const cfg = { privacyMode: 'structured' };
  try {
    resolvePrivacyMode(cfg, 'raw', { explicit_user_intent: false });
    assert.fail('raw without intent should throw');
  } catch (e) {
    assert.match(String(e.message || e), /USER_ACTION_REQUIRED|explicit_user_intent/i);
  }
  assert.equal(resolvePrivacyMode(cfg, 'raw', { explicit_user_intent: true }), 'raw');
  assert.equal(resolvePrivacyMode({ privacyMode: 'raw' }), 'raw');
  console.log(JSON.stringify({ ok: true, suite: 'privacy-escalation-gate' }, null, 2));
}
