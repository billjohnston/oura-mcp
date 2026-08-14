export const SERVER_NAME = "oura-mcp-server";
export const SERVER_VERSION = "0.7.0";
export const NPM_PACKAGE_NAME = "oura-mcp-unofficial";
export const PINNED_NPM_PACKAGE = `${NPM_PACKAGE_NAME}@${SERVER_VERSION}`;

export const OURA_API_BASE_URL = "https://api.ouraring.com/v2";
export const OURA_AUTH_URL = "https://cloud.ouraring.com/oauth/authorize";
export const OURA_TOKEN_URL = "https://api.ouraring.com/oauth/token";
export const OURA_REVOKE_URL = "https://api.ouraring.com/oauth/revoke";
export const OURA_DEVELOPER_PORTAL_URL = "https://cloud.ouraring.com/oauth/applications";
export const OURA_DOCS_URL = "https://cloud.ouraring.com/docs/authentication";

// Official Oura OAuth scopes (cloud.ouraring.com OpenAPI + auth docs).
// There is no separate "sleep" scope — sleep/readiness/activity daily data is under `daily`.
// SpO2 is documented as both `spo2` (auth docs / consent UI) and `spo2Daily` (OpenAPI); doctor treats them as aliases.
export const DEFAULT_SCOPES = [
  "daily",
  "heartrate",
  "personal",
  "workout",
  "spo2"
];

/** Map wire-format aliases to the canonical name used by DEFAULT_SCOPES / doctor. */
export const SCOPE_ALIASES: Record<string, string> = {
  spo2daily: "spo2",
  spo2_daily: "spo2"
};

/**
 * Oura collections whose `end_date` behaves EXCLUSIVELY.
 *
 * These endpoints filter on a timestamp rather than a plain day, so `end_date` is
 * compared against midnight and a record on that day falls outside the window:
 * `start_date=2026-08-12&end_date=2026-08-12` returns zero records for these, while
 * `daily_readiness` / `daily_sleep` / `daily_spo2` return one. Verified against the
 * live API, not inferred from the docs.
 *
 * Callers of this server always mean an inclusive window, so requests to these
 * endpoints send `end_date + 1 day`.
 */
export const EXCLUSIVE_END_DATE_ENDPOINTS = [
  "/usercollection/daily_activity",
  "/usercollection/sleep",
  "/usercollection/workout",
  "/usercollection/session"
];

/**
 * Heart-rate zone boundaries as a fraction of HRmax, lower bound inclusive.
 * The classic five-zone model; anything under z1 is counted as "below_zone1".
 */
export const HR_ZONE_BOUNDS = [
  { zone: "zone1", label: "very light", min: 0.5, max: 0.6 },
  { zone: "zone2", label: "light", min: 0.6, max: 0.7 },
  { zone: "zone3", label: "moderate", min: 0.7, max: 0.8 },
  { zone: "zone4", label: "hard", min: 0.8, max: 0.9 },
  { zone: "zone5", label: "maximum", min: 0.9, max: Infinity }
];

/**
 * Longest gap between consecutive heart-rate samples that still counts as covered.
 *
 * Oura samples roughly every 5 minutes at rest but every ~5 seconds during a workout,
 * so a sample's weight is the distance to the next one. Without a cap, one sample
 * either side of a long optical dropout would paper over the whole gap.
 */
export const HR_SAMPLE_MAX_GAP_SECONDS = 300;

/** Page budget when walking heart-rate samples, which are capped at 1000 per page. */
export const HR_SCAN_MAX_PAGES = 20;

export const DEFAULT_LIMIT = 30;
export const MAX_OURA_LIMIT = 100;
export const DEFAULT_MAX_PAGES = 1;
export const MAX_PAGES = 10;

/**
 * Page budget for a "most recent record" scan (`OuraClient.latest`).
 *
 * Oura serves collections oldest-first with an opaque cursor, so the newest record is
 * only reachable by walking a window to the end. Bigger than MAX_PAGES because the scan
 * keeps one record in memory, not a page of them, and because stopping early is the
 * exact defect this budget exists to prevent.
 */
export const LATEST_SCAN_MAX_PAGES = 20;

/**
 * Lookback ladder for "most recent record", in days, narrowest first.
 *
 * The narrow window is what bounds the cost of the walk; widening only happens when a
 * window came back empty, so a ring that has not synced in weeks still answers.
 */
export const LATEST_LOOKBACK_DAYS = [14, 90, 400];
