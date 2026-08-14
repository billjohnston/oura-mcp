import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildConnectionStatus } from '../dist/services/connection-status.js';
import { formatCollection } from '../dist/services/format.js';

const dir = mkdtempSync(join(tmpdir(), 'oura-mcp-agent-readiness-'));

try {
  // Real Oura workout field names. The previous fixture used Strava/Fitbit ones
  // (sport_type, start_date, name) and so did the formatter, which is why a genuine
  // Oura workout rendered as "start: n/a, sport: n/a" while distance survived by
  // coincidence — the one field name the two schemas happen to share.
  const markdown = formatCollection('Oura Workouts', [
    {
      id: 'ba6f31ba-c96c-4219-bec5-e45bfff64e44',
      day: '2026-08-12',
      activity: 'walking',
      intensity: 'moderate',
      start_datetime: '2026-08-12T08:26:00.000-04:00',
      end_datetime: '2026-08-12T09:10:00.000-04:00',
      duration_seconds: 2640,
      calories: 172.13,
      distance: 3658.91
    },
    {
      id: '0f6d9d20-3e5b-4e0e-9a1f-2b0c3d4e5f60',
      day: '2026-08-12',
      activity: 'HIIT',
      intensity: 'moderate',
      start_datetime: '2026-08-12T17:23:00.000-04:00',
      end_datetime: '2026-08-12T17:34:00.000-04:00',
      duration_seconds: 660,
      calories: 39.23,
      distance: 8.97
    }
  ], {
    endpoint: '/usercollection/workout',
    privacy_mode: 'structured',
    count: 2,
    records: [{ id: 1 }, { id: 2 }],
    pages_fetched: 1
  });

  assert.doesNotMatch(markdown, /\[object Object\]/, 'Markdown previews must never leak JavaScript object stringification.');
  assert.doesNotMatch(markdown, /\*\*records\*\*/i, 'Collection markdown should not duplicate full record arrays in metadata.');
  assert.doesNotMatch(markdown, /n\/a/, 'Oura records must not render as n/a; that means the formatter is reading another API\'s field names.');

  for (const expected of [/walking/, /HIIT/, /moderate/, /2026-08-12T08:26/, /44 min/, /172\.13/]) {
    assert.match(markdown, expected, `markdown must surface ${expected}`);
  }

  // A bare UUID must never be a heading: it is noise to a reader and bait for a model to
  // invent one. It stays as a labelled field, because oura_get_workout can act on it.
  assert.doesNotMatch(
    markdown,
    /^##\s*[0-9a-f]{8}-[0-9a-f]{4}-/m,
    'record headings must be human-readable, not raw UUIDs'
  );
  assert.match(markdown, /^## 2026-08-12 · walking$/m, 'headings should read as date · activity');
  assert.match(markdown, /\*\*id\*\*: `ba6f31ba-/, 'the id stays available as a field for oura_get_workout');

  const tokenPath = join(dir, 'tokens.json');
  writeFileSync(tokenPath, JSON.stringify({
    access_token: 'access',
    refresh_token: 'refresh',
    expires_at: 2_000_000,
    scope: 'personal'
  }), { mode: 0o600 });

  const limited = await buildConnectionStatus({
    env: {
      OURA_CLIENT_ID: 'client-id',
      OURA_CLIENT_SECRET: 'client-secret',
      OURA_REDIRECT_URI: 'http://127.0.0.1:4567/callback',
      OURA_TOKEN_PATH: tokenPath
    },
    homeDir: dir,
    nowMs: 1_000_000
  });

  assert.equal(limited.ready_for_oura_api, false, 'A personal-only token should not be reported as fully ready for Oura health tools.');
  assert.equal(limited.ok, false);
  assert.deepEqual(limited.oauth.granted_scopes, ['personal']);
  assert.ok(limited.oauth.missing_recommended_scopes.includes('daily'));
  assert.ok(limited.oauth.missing_recommended_scopes.includes('workout'));
  assert.ok(!limited.oauth.missing_recommended_scopes.includes('sleep'), 'Oura has no sleep OAuth scope; doctor must not require it.');
  assert.equal(limited.oauth.activity_tools_ready, false);
  assert.equal(limited.oauth.profile_tools_ready, true);
  assert.ok(limited.next_steps.some((step) => /re-authorize/i.test(step) && /daily/.test(step)));

  // Real Oura consent grants (no separate "sleep" scope — sleep lives under daily).
  writeFileSync(tokenPath, JSON.stringify({
    access_token: 'access',
    refresh_token: 'refresh',
    expires_at: 2_000_000,
    scope: 'daily heartrate personal workout spo2'
  }), { mode: 0o600 });

  const ready = await buildConnectionStatus({
    env: {
      OURA_CLIENT_ID: 'client-id',
      OURA_CLIENT_SECRET: 'client-secret',
      OURA_REDIRECT_URI: 'http://127.0.0.1:4567/callback',
      OURA_TOKEN_PATH: tokenPath
    },
    homeDir: dir,
    nowMs: 1_000_000
  });

  assert.equal(ready.ok, true);
  assert.equal(ready.ready_for_oura_api, true);
  assert.deepEqual(ready.oauth.missing_recommended_scopes, []);
  assert.equal(ready.oauth.activity_tools_ready, true);

  // OpenAPI wire name spo2Daily must satisfy the spo2 recommendation (#8 regression).
  writeFileSync(tokenPath, JSON.stringify({
    access_token: 'access',
    refresh_token: 'refresh',
    expires_at: 2_000_000,
    scope: 'daily heartrate personal workout spo2Daily'
  }), { mode: 0o600 });

  const aliased = await buildConnectionStatus({
    env: {
      OURA_CLIENT_ID: 'client-id',
      OURA_CLIENT_SECRET: 'client-secret',
      OURA_REDIRECT_URI: 'http://127.0.0.1:4567/callback',
      OURA_TOKEN_PATH: tokenPath
    },
    homeDir: dir,
    nowMs: 1_000_000
  });

  assert.equal(aliased.oauth.scope_status, 'ok');
  assert.deepEqual(aliased.oauth.missing_recommended_scopes, []);
  assert.equal(aliased.ok, true);

  // Legacy local tokens that still list the non-existent "sleep" scope should not fail.
  writeFileSync(tokenPath, JSON.stringify({
    access_token: 'access',
    refresh_token: 'refresh',
    expires_at: 2_000_000,
    scope: 'daily heartrate personal sleep workout spo2'
  }), { mode: 0o600 });

  const legacy = await buildConnectionStatus({
    env: {
      OURA_CLIENT_ID: 'client-id',
      OURA_CLIENT_SECRET: 'client-secret',
      OURA_REDIRECT_URI: 'http://127.0.0.1:4567/callback',
      OURA_TOKEN_PATH: tokenPath
    },
    homeDir: dir,
    nowMs: 1_000_000
  });
  assert.equal(legacy.oauth.scope_status, 'ok');
  assert.deepEqual(legacy.oauth.missing_recommended_scopes, []);

  console.log(JSON.stringify({ ok: true, markdown: true, scope_diagnostics: true, spo2_alias: true }, null, 2));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
