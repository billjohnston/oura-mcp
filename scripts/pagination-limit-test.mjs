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
 *
 * Round 2 (0.6.0) closes what (c) left open, measured on 250 records served in pages of 40:
 *  (d) the resource made ONE list() call, so "most recent" was the newest of PAGE 1 —
 *      synthetic-040 out of 250, the oldest block of the window. Correct only while the
 *      window happened to fit in one page. It now walks the cursor to exhaustion.
 *  (e) `limit` keeps the k OLDEST records of the window and the schema never said so, so
 *      an agent asking limit:1 for "my latest readiness" got the oldest one. The end is
 *      now named in the description the agent actually reads.
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
 *
 * `emptyBeforeStartDate` makes the fake honor `start_date` the one way that matters here:
 * a request whose start_date is NEWER than that floor comes back empty, which is what a
 * ring that has not synced recently looks like.
 */
let apiState = { total: 0, pageSize: 0, emptyBeforeStartDate: undefined };
const requestedUrls = [];

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  requestedUrls.push(url);
  const startDate = url.searchParams.get('start_date');
  if (apiState.emptyBeforeStartDate && startDate && startDate >= apiState.emptyBeforeStartDate) {
    return Response.json({ data: [] });
  }
  const cursor = Number(url.searchParams.get('next_token') ?? '0');
  const pageSize = apiState.pageSize;
  const slice = [];
  for (let i = cursor; i < Math.min(cursor + pageSize, apiState.total); i += 1) slice.push(syntheticRecord(i));
  const nextCursor = cursor + pageSize;
  const body = { data: slice };
  if (nextCursor < apiState.total) body.next_token = String(nextCursor);
  return Response.json(body);
};

function serve(total, pageSize, emptyBeforeStartDate) {
  apiState = { total, pageSize, emptyBeforeStartDate };
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

  // ---------------------------------------------------------------------------
  // (d) ROUND 2: latest/readiness must be newest BY CONSTRUCTION, across pages.
  // Pre-round-2 behavior: one list() call with no all_pages, so the resource only ever
  // saw page 1. With 250 records in pages of 40 it answered synthetic-040 — the newest
  // of the OLDEST block — and called it "Most recent". The single-page fixture above
  // could not catch that, which is why this one exists.
  // ---------------------------------------------------------------------------
  serve(250, 40);
  const multiPage = await client.readResource({ uri: 'oura://latest/readiness' });
  const multiPayload = JSON.parse(multiPage.contents[0].text);
  check('latest/readiness crosses page boundaries', () => {
    assert.equal(multiPayload.records.length, 1, 'the resource stays singular across pages');
    assert.equal(
      multiPayload.records[0].id,
      'synthetic-250',
      `250 records in pages of 40: expected the newest, got ${multiPayload.records[0]?.id} (synthetic-040 means it stopped at page 1)`
    );
  });
  check('latest/readiness walked the cursor to exhaustion', () => {
    assert.ok(
      multiPayload.pages_scanned >= 7,
      `250 records in pages of 40 needs 7 pages, scanned ${multiPayload.pages_scanned}`
    );
    assert.equal(
      multiPayload.most_recent_guaranteed,
      true,
      'cursor was exhausted, so the resource must state the answer is provably the newest'
    );
  });

  // The page budget is a runaway guard, not a silent truncation: when it fires, the
  // resource must SAY the answer is only the newest it saw.
  serve(4000, 10);
  const budgetBound = await client.readResource({ uri: 'oura://latest/readiness' });
  const budgetPayload = JSON.parse(budgetBound.contents[0].text);
  check('latest/readiness is honest when the page budget runs out', () => {
    assert.equal(
      budgetPayload.most_recent_guaranteed,
      false,
      'cursor still had a next_token when the scan stopped: most_recent_guaranteed must be false'
    );
    assert.equal(budgetPayload.records.length, 1, 'still singular');
  });

  // A window that came back empty must widen instead of reporting "no data".
  const floor = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  serve(20, 20, floor);
  const widened = await client.readResource({ uri: 'oura://latest/readiness' });
  const widenedPayload = JSON.parse(widened.contents[0].text);
  check('latest/readiness widens the window when the narrow one is empty', () => {
    assert.equal(widenedPayload.records.length, 1, 'a ring that has not synced in 3 weeks must still answer');
    assert.equal(widenedPayload.records[0].id, 'synthetic-020', 'and must answer with the newest record');
    assert.equal(widenedPayload.lookback_days, 90, `expected the 90-day rung, got ${widenedPayload.lookback_days}`);
  });

  // ---------------------------------------------------------------------------
  // (e) ROUND 2: `limit` cuts from the OLDEST end, and the SCHEMA must say so.
  // The behavior is deliberate — see CHANGELOG 0.6.0 — but a true description that
  // omits which end is the same trap that produced defect (c): an agent asking
  // limit:1 for "my latest readiness" gets the oldest record in the window.
  // ---------------------------------------------------------------------------
  serve(50, 50);
  const oldestEnd = await listReadiness({ limit: 1 });
  check('limit keeps the oldest end of the window', () => {
    assert.equal(oldestEnd.count, 1);
    assert.equal(
      oldestEnd.records[0].id,
      'synthetic-001',
      `limit is documented as an oldest-end cap; got ${oldestEnd.records[0]?.id}`
    );
  });

  const toolList = await client.listTools();
  const limitDescription = toolList.tools
    .find((tool) => tool.name === 'oura_list_daily_readiness')
    ?.inputSchema?.properties?.limit?.description ?? '';
  check('the limit schema names which end it cuts', () => {
    assert.match(
      limitDescription,
      /oldest/i,
      'the description an agent actually reads must say the cap keeps the OLDEST records'
    );
    assert.match(
      limitDescription,
      /oura:\/\/latest\//,
      'and must point at the resource that answers "most recent", or limit:1 stays a trap'
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
