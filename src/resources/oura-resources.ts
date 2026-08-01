import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { LATEST_LOOKBACK_DAYS } from "../constants.js";
import { buildAgentManifest, formatAgentManifestMarkdown } from "../services/agent-manifest.js";
import { buildCapabilities } from "../services/capabilities.js";
import { buildDataInventory } from "../services/inventory.js";
import { getConfig } from "../services/config.js";
import { applyPrivacy, resolvePrivacyMode } from "../services/privacy.js";
import { buildDailySummary, buildWeeklySummary, formatSummaryMarkdown } from "../services/summary.js";
import { OuraClient } from "../services/oura-client.js";

function textResource(uri: URL, text: string, mimeType = "text/markdown"): ReadResourceResult {
  return { contents: [{ uri: uri.toString(), mimeType, text }] };
}

async function profileResource(uri: URL) {
  const config = getConfig();
  const endpoint = "/usercollection/personal_info";
  const data = applyPrivacy(endpoint, await new OuraClient(config).get(endpoint), resolvePrivacyMode(config));
  return textResource(uri, JSON.stringify({ endpoint, data }, null, 2), "application/json");
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

async function latestReadinessResource(uri: URL) {
  const config = getConfig();
  const endpoint = "/usercollection/daily_readiness";
  const oura = new OuraClient(config);

  // "Most recent" by construction, not by luck of where the page boundary fell.
  //
  // Oura serves collections oldest-first with an opaque cursor and no sort parameter, so
  // the newest record lives on the LAST page of the window. Reading one page and taking
  // its tail returns the newest of the OLDEST block — correct only while the window
  // happens to fit in a single page, which is a property of the data, not of the code.
  //
  // So: ask for a short recent window (cheap — one page in practice, since daily_readiness
  // is one record per day), walk that window's cursor to exhaustion, and widen only when
  // it came back empty, so a ring that has not synced in weeks still answers.
  let scan = await oura.latest(endpoint, { after: isoDaysAgo(LATEST_LOOKBACK_DAYS[0]) });
  let lookbackDays = LATEST_LOOKBACK_DAYS[0];
  for (const days of LATEST_LOOKBACK_DAYS.slice(1)) {
    if (scan.record !== undefined) break;
    lookbackDays = days;
    scan = await oura.latest(endpoint, { after: isoDaysAgo(days) });
  }

  const data = applyPrivacy(endpoint, {
    records: scan.record === undefined ? [] : [scan.record],
    lookback_days: lookbackDays,
    pages_scanned: scan.pages_fetched,
    // False only when the page budget ran out mid-window: then this is the newest record
    // SEEN, and the caller should narrow the window rather than trust the label.
    most_recent_guaranteed: scan.cursor_exhausted
  }, resolvePrivacyMode(config));
  return textResource(uri, JSON.stringify(data, null, 2), "application/json");
}

async function dailySummaryResource(uri: URL) {
  const summary = await buildDailySummary(new OuraClient(getConfig()), { days: 7, timezone: "UTC" });
  return textResource(uri, formatSummaryMarkdown(summary));
}

async function weeklySummaryResource(uri: URL) {
  const summary = await buildWeeklySummary(new OuraClient(getConfig()), { days: 7, compare_days: 7, timezone: "UTC" });
  return textResource(uri, formatSummaryMarkdown(summary));
}

export function registerOuraResources(server: McpServer): void {
  server.registerResource("oura_data_inventory", "oura://inventory", { title: "Oura Data Inventory", description: "Static inventory of supported Oura data domains, privacy modes and recommended first calls.", mimeType: "application/json" }, async (uri) => textResource(uri, JSON.stringify(buildDataInventory(), null, 2), "application/json"));
  server.registerResource("oura_capabilities", "oura://capabilities", { title: "Oura MCP Capabilities", description: "Static capabilities, API boundary, privacy modes and recommended agent workflow.", mimeType: "application/json" }, async (uri) => textResource(uri, JSON.stringify(buildCapabilities(), null, 2), "application/json"));
  server.registerResource("oura_agent_manifest", "oura://agent-manifest", { title: "Oura Agent Manifest", description: "Machine-readable install and operating instructions for AI agents.", mimeType: "text/markdown" }, async (uri) => textResource(uri, formatAgentManifestMarkdown(buildAgentManifest("generic"))));
  server.registerResource("oura_personal_info", "oura://personal-info", { title: "Oura Personal Info", description: "Authenticated Oura personal info using the configured privacy mode.", mimeType: "application/json" }, profileResource);
  server.registerResource("oura_latest_readiness", "oura://latest/readiness", { title: "Latest Oura Readiness", description: "The single most recent Oura readiness record, in the configured privacy mode. Walks the Oura cursor to the end of a recent window, so it is the newest record that exists and not the newest of page 1 — this is the correct way to ask for 'my latest readiness'. oura_list_daily_readiness with limit:1 returns the OLDEST record instead.", mimeType: "application/json" }, latestReadinessResource);
  server.registerResource("oura_daily_summary", "oura://summary/daily", { title: "Oura Daily Summary", description: "Daily Oura health summary built from API data.", mimeType: "text/markdown" }, dailySummaryResource);
  server.registerResource("oura_weekly_summary", "oura://summary/weekly", { title: "Oura Weekly Summary", description: "Weekly Oura health review built from API data.", mimeType: "text/markdown" }, weeklySummaryResource);
}
