// Fork divergence: OURA_PERSONAL_ACCESS_TOKEN authenticates on its own, with no OAuth
// app, no token file and no authorization-code tools. This pins that behaviour.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { getConfig } from '../dist/services/config.js';
import { OuraClient } from '../dist/services/oura-client.js';

const PAT = 'pat-mode-test-token';
const OAUTH_ONLY_TOOLS = ['oura_get_auth_url', 'oura_exchange_code', 'oura_revoke_access'];

for (const name of ['OURA_CLIENT_ID', 'OURA_CLIENT_SECRET', 'OURA_REDIRECT_URI']) delete process.env[name];
process.env.OURA_PERSONAL_ACCESS_TOKEN = PAT;
process.env.OURA_NO_CACHE = 'true';
// Point the token path somewhere that does not exist: PAT mode must never read it.
const missingTokenPath = join(tmpdir(), 'oura-mcp-pat-mode-absent', 'tokens.json');
process.env.OURA_TOKEN_PATH = missingTokenPath;

// 1. Config resolves without the OAuth triple that upstream demands.
const config = getConfig();
assert.equal(config.personalAccessToken, PAT);
assert.equal(config.clientId, '');

// 2. The PAT is sent verbatim as the bearer token, with no token file present.
const originalFetch = globalThis.fetch;
let seenAuthorization;
globalThis.fetch = async (input, init) => {
  seenAuthorization = new Headers(init?.headers).get('authorization');
  return Response.json({ data: [{ id: 'synthetic-record', day: '2026-08-13' }] });
};
try {
  const result = await new OuraClient(config).list('/usercollection/daily_sleep', {});
  assert.equal(result.records[0].id, 'synthetic-record');
  assert.equal(seenAuthorization, `Bearer ${PAT}`);
} finally {
  globalThis.fetch = originalFetch;
}

// 3. A 401 in PAT mode reports the token, not a missing refresh token.
globalThis.fetch = async () => new Response('{}', { status: 401 });
try {
  await assert.rejects(
    () => new OuraClient(config).list('/usercollection/daily_sleep', {}),
    /personal access token/i
  );
} finally {
  globalThis.fetch = originalFetch;
}

// 4. The authorization-code tools are not registered, and status reports PAT mode.
const client = new Client({ name: 'oura-mcp-pat-test', version: '0.0.0' });
const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/index.js'],
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    OURA_PERSONAL_ACCESS_TOKEN: PAT,
    OURA_TOKEN_PATH: missingTokenPath
  }
});
await client.connect(transport);
try {
  const toolNames = (await client.listTools()).tools.map((tool) => tool.name);
  for (const name of OAUTH_ONLY_TOOLS) {
    assert.ok(!toolNames.includes(name), `${name} must not be registered in PAT mode`);
  }
  assert.ok(toolNames.includes('oura_list_daily_sleep'), 'data tools must still be registered');

  const status = (await client.callTool({
    name: 'oura_connection_status',
    arguments: { response_format: 'json' }
  })).structuredContent;
  assert.equal(status.auth_mode, 'pat');
  assert.deepEqual(status.missing_env, []);
  assert.equal(status.ready_for_oura_api, true);

  console.log(JSON.stringify({
    ok: true,
    suite: 'pat-mode',
    oauth_tools_hidden: OAUTH_ONLY_TOOLS.length,
    bearer_is_pat: true,
    tools: toolNames.length
  }, null, 2));
} finally {
  await client.close();
}
