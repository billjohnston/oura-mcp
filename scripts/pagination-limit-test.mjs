/**
 * Regression gate for the Oura collection pagination contract.
 *
 * Every record here is SYNTHETIC. No real Oura export is ever used in this repo's tests.
 *
 * Guards three defects found in 0.4.11:
 *  (a) `limit` was advertised in the tool schema but never truncated anything and was
 *      never sent upstream: limit=1 returned the whole window.
 *  (b) the all_pages loop broke on `pageRecords.length < limit`, an inverted heuristic
 *      that made the DEFAULT limit stop after page 1 whenever a page was smaller than
 *      30 records, while a small limit paged forever. Pagination must end on the absence
 *      of `next_token`.
 *  (c) `oura://latest/readiness` ("Most recent Oura readiness record", singular) returned
 *      the entire window instead of one record.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerOuraTools } from '../dist/tools/oura-tools.js';
import { registerOuraResources } from '../dist/resources/oura-resources.js';

const dir = mkdtempSync(join(tmpdir(), 'oura-mcp-pagination-'));
const tokenPath = join(dir, 'tokens.json');
writeFileSync(tokenPath, JSON.stringify({ access_token: 'synthetic-token' }), { mode: 0o600 });

const originalEnv = { ...process.env };
Object.assign(process.env, {
  OURA_CLIENT_ID: 'synthetic-client',
  OURA_CLIENT_SECRET: 'synthetic-secret',
  OURA_REDIRECT_URI: 'http://127.0.0.1/callback',
  OURA_TOKEN_PATH: tokenPath,
  OURA_CACHE_PATH: join(dir, 'cache.sqlite'),
  OURA_CACHE: 'false',
  OURA_NO_CACHE: 'true',
  OURA_NO_RETRY: 'true',
  OURA_PRIVACY_MODE: 'structured',
  OURA_CONFIG_PATH: join(dir, 'config.json')
});

/** Synthetic readiness record. Ids and days are obviously fake. */
function syntheticRecord(index) {
  const day = new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10);
  return { id: `synthetic-${String(index + 1).padStart(3, '0')}`, day, score: 50 + (index % 40) };
}

/**
 * Serves `total` synthetic records in pages of `pageSize`.
 * Emits `next_token` on every page except the last, exactly like Oura v2 cursors.
 */
let apiState = { total: 0, pageSize: 0 };
const requestedUrls = [];

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  requestedUrls.push(url);
  const cursor = Number(url.searchParams.get('next_token') ?? '0');
  const pageSize = apiState.pageSize;
  const slice = [];
  for (let i = cursor; i < Math.min(cursor + pageSize, apiState.total); i += 1) slice.push(syntheticRecord(i));
  const nextCursor = cursor + pageSize;
  const body = { data: slice };
  if (nextCursor < apiState.total) body.next_token = String(nextCursor);
  return Response.json(body);
};

function serve(total, pageSize) {
  apiState = { total, pageSize };
  requestedUrls.length = 0;
}

const server = new McpServer({ name: 'oura-mcp-pagination-test', version: '0.0.0' });
registerOuraTools(server);
registerOuraResources(server);
const client = new Client({ name: 'oura-mcp-pagination-test-client', version: '0.0.0' });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);

async function listReadiness(args) {
  const result = await client.callTool({
    name: 'oura_list_daily_readiness',
    arguments: { response_format: 'json', ...args }
  });
  assert.ok(!result.isError, `oura_list_daily_readiness failed: ${JSON.stringify(result.content)}`);
  return result.structuredContent;
}

const failures = [];
function check(name, fn) {
  try {
    fn();
  } catch (error) {
    failures.push(new Error(`[${name}] ${error.message}`));
  }
}

try {
  // ---------------------------------------------------------------------------
  // (a) limit=k must return at most k records.
  // Old behavior: 50 records returned for every k, and limit never left the process.
  // ---------------------------------------------------------------------------
  for (const limit of [1, 3, 10]) {
    serve(50, 50);
    const output = await listReadiness({ limit });
    check(`limit=${limit} caps count`, () => {
      assert.ok(
        output.count <= limit,
        `limit=${limit} must return at most ${limit} records, got ${output.count}`
      );
      assert.equal(output.records.length, output.count, 'count must match records length');
    });
    check(`limit=${limit} reports truncation`, () => {
      assert.equal(output.truncated, true, `limit=${limit} dropped records and must report truncated=true`);
      assert.equal(output.has_more, true, `limit=${limit} dropped records and must report has_more=true`);
    });
  }

  serve(50, 50);
  const defaultOutput = await listReadiness({});
  check('default limit caps at 30', () => {
    assert.equal(defaultOutput.count, 30, `default limit must cap at 30, got ${defaultOutput.count}`);
  });

  // A window smaller than the cap must not be padded or flagged.
  serve(4, 50);
  const smallWindow = await listReadiness({ limit: 10 });
  check('limit above window size is a no-op', () => {
    assert.equal(smallWindow.count, 4);
    assert.equal(smallWindow.truncated, false);
    assert.equal(smallWindow.has_more, false);
  });

  // ---------------------------------------------------------------------------
  // (b) all_pages with the DEFAULT limit must not stop early while next_token exists.
  // Old behavior: page 1 returned 10 records, 10 < 30 broke the loop, 1 page fetched.
  // ---------------------------------------------------------------------------
  serve(50, 10);
  const paged = await listReadiness({ all_pages: true, max_pages: 5 });
  check('all_pages with default limit keeps paging', () => {
    assert.ok(
      paged.pages_fetched > 1,
      `all_pages must follow next_token past page 1, fetched only ${paged.pages_fetched} page(s)`
    );
    assert.equal(paged.pages_fetched, 3, 'must fetch pages until the 30-record cap is reached');
    assert.equal(paged.count, 30, `expected the default cap of 30 records, got ${paged.count}`);
  });

  // Pagination ends on the ABSENCE of next_token, not on a page-size comparison.
  serve(12, 5);
  const exhausted = await listReadiness({ all_pages: true, max_pages: 5 });
  check('all_pages stops when next_token is gone', () => {
    assert.equal(exhausted.pages_fetched, 3, 'must fetch exactly the 3 pages the cursor offers');
    assert.equal(exhausted.count, 12, `expected all 12 synthetic records, got ${exhausted.count}`);
    assert.equal(exhausted.has_more, false, 'cursor exhausted and nothing truncated: has_more must be false');
    assert.equal(exhausted.truncated, false);
  });

  // A small limit must fetch LESS, never more. Old behavior paged until max_pages.
  serve(50, 10);
  const smallLimitPaged = await listReadiness({ all_pages: true, max_pages: 5, limit: 5 });
  check('small limit does not page further than a large one', () => {
    assert.equal(smallLimitPaged.count, 5, `limit=5 must return 5 records, got ${smallLimitPaged.count}`);
    assert.equal(smallLimitPaged.pages_fetched, 1, `limit=5 must stop after 1 page, fetched ${smallLimitPaged.pages_fetched}`);
  });

  check('max_pages still bounds the loop', () => {
    assert.ok(requestedUrls.length > 0, 'the synthetic API must have been called');
  });
  serve(500, 10);
  const bounded = await listReadiness({ all_pages: true, max_pages: 2, limit: 100 });
  check('max_pages wins over the cap', () => {
    assert.equal(bounded.pages_fetched, 2);
    assert.equal(bounded.count, 20);
    assert.equal(bounded.has_more, true, 'more data upstream: has_more must be true');
  });

  // ---------------------------------------------------------------------------
  // (c) oura://latest/readiness is singular and must return exactly one record.
  // Old behavior: 14 of 14 synthetic records.
  // ---------------------------------------------------------------------------
  serve(14, 14);
  const resource = await client.readResource({ uri: 'oura://latest/readiness' });
  const payload = JSON.parse(resource.contents[0].text);
  check('latest/readiness returns exactly one record', () => {
    assert.ok(Array.isArray(payload.records), 'resource must keep the { records: [...] } shape');
    assert.equal(
      payload.records.length,
      1,
      `"Most recent Oura readiness record" must return 1 record, got ${payload.records.length}`
    );
  });
  check('latest/readiness returns the MOST RECENT record', () => {
    assert.equal(
      payload.records[0].id,
      'synthetic-014',
      `expected the newest synthetic record, got ${payload.records[0]?.id}`
    );
  });

  if (failures.length) throw new AggregateError(failures, 'Oura pagination/limit contract regressions');
  console.log(JSON.stringify({ ok: true, suite: 'pagination-limit', http_requests: requestedUrls.length }, null, 2));
} finally {
  globalThis.fetch = originalFetch;
  await client.close().catch(() => undefined);
  await server.close().catch(() => undefined);
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  rmSync(dir, { recursive: true, force: true });
}
