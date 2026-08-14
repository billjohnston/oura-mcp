import { URL, URLSearchParams } from "node:url";
import { DEFAULT_LIMIT, DEFAULT_MAX_PAGES, EXCLUSIVE_END_DATE_ENDPOINTS, HR_SCAN_MAX_PAGES, LATEST_SCAN_MAX_PAGES, MAX_PAGES, OURA_API_BASE_URL, OURA_AUTH_URL, OURA_REVOKE_URL, OURA_TOKEN_URL, MAX_OURA_LIMIT } from "../constants.js";
import type { OuraConfig, OuraTokenSet } from "../types.js";
import { disabledCacheStatus, OuraCache, type CacheStatus } from "./cache.js";
import { fetchWithCache, getCacheStats } from "./http-cache.js";
import { fetchWithRetry as fetchWithRetryMiddleware } from "./http-retry.js";
import { mostRecentRecord } from "./recency.js";
import { redactErrorMessage } from "./redaction.js";
import { TokenStore } from "./token-store.js";

export type SortOrder = "asc" | "desc";

export interface ListParams {
  after?: string;
  before?: string;
  /** Opaque Oura v2 cursor from a previous list response. Not a page number. */
  next_token?: string;
  limit?: number;
  /** Which end of the window `limit` keeps. Defaults to newest-first. */
  sort?: SortOrder;
  all_pages?: boolean;
  max_pages?: number;
}

export interface ListResult {
  records: unknown[];
  /** Which end of the window these records came from. */
  sort: SortOrder;
  /** Present only when it is safe to resume without skipping records. */
  next_token?: string;
  pages_fetched: number;
  has_more: boolean;
  truncated: boolean;
  /** False when the page budget ran out before Oura's cursor did. */
  cursor_exhausted: boolean;
}

export interface HeartRateSample {
  /** Epoch milliseconds. */
  at: number;
  bpm: number;
  /** Oura's own labelling, e.g. "workout", "awake", "rest". */
  source?: string;
}

export interface HeartRateScan {
  samples: HeartRateSample[];
  pages_fetched: number;
  cursor_exhausted: boolean;
}

export interface LatestParams {
  after?: string;
  before?: string;
  max_pages?: number;
}

export interface LatestResult {
  record?: unknown;
  pages_fetched: number;
  records_scanned: number;
  /** False when the page budget ran out first: the record is the newest SEEN, not provably the newest. */
  cursor_exhausted: boolean;
}

export class OuraClient {
  private readonly tokenStore: TokenStore;
  private cache?: OuraCache;

  constructor(private readonly config: OuraConfig) {
    this.tokenStore = new TokenStore(config.tokenPath);
  }

  authUrl(state?: string, scopes?: string[]): string {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: "code",
      scope: (scopes?.length ? scopes : this.config.scopes).join(" ")
    });
    if (state) params.set("state", state);
    return `${OURA_AUTH_URL}?${params.toString()}`;
  }

  async exchangeCode(input: string): Promise<{ ok: true; token_path: string; scope?: string; expires_at?: number }> {
    const code = this.extractCode(input);
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.config.redirectUri
    });
    const tokens = await this.requestTokens(body);
    const redirectScope = this.extractScope(input);
    await this.tokenStore.withLock(async () => this.tokenStore.write({ ...tokens, scope: tokens.scope ?? redirectScope }));
    return { ok: true, token_path: this.config.tokenPath, scope: tokens.scope ?? redirectScope, expires_at: tokens.expires_at };
  }

  async get(path: string, params?: Record<string, string | number | boolean | undefined>): Promise<unknown> {
    return this.request("GET", path, undefined, params);
  }

  async post(path: string, body?: Record<string, string | number | boolean | undefined>): Promise<unknown> {
    return this.request("POST", path, body);
  }

  async revokeAccess(): Promise<{ ok: true; token_path: string; local_tokens_cleared: boolean }> {
    const token = await this.getValidToken();
    const revokeUrl = new URL(OURA_REVOKE_URL);
    revokeUrl.searchParams.set("access_token", token.access_token);
    const response = await this.fetchWithRetry(revokeUrl.toString(), { method: "POST", headers: this.formHeaders() });
    await this.parseResponse(response);
    await this.tokenStore.withLock(async () => this.tokenStore.clear());
    return { ok: true, token_path: this.config.tokenPath, local_tokens_cleared: true };
  }

  cacheStatus(): CacheStatus {
    const httpStats = getCacheStats();
    const http_cache = {
      size: httpStats.size,
      hit_count: httpStats.hit_count,
      miss_count: httpStats.miss_count,
      hit_rate: httpStats.hit_rate,
      default_ttl_seconds: 60,
      bypass_env_var: "OURA_NO_CACHE"
    };
    if (!this.config.cacheEnabled) return { ...disabledCacheStatus(this.config.cachePath), http_cache };
    return { ...this.getCache().status(), http_cache };
  }

  /**
   * Read an Oura collection endpoint.
   *
   * `limit` caps how many records come back and `sort` picks which end they come from.
   * Oura v2 has no sort or page-size parameter and always serves oldest-first behind an
   * opaque cursor, so `sort: "desc"` is satisfied here: the window is walked to its end
   * (bounded by `max_pages`) and the newest `limit` records are returned. `sort: "asc"`
   * can stop as soon as the cap is met, so it is the cheaper option on wide windows.
   *
   * Resume with `params.next_token`. Integer `page` / `next_page` are not Oura v2
   * parameters: a leftover `page` other than 1 is rejected so agents cannot loop or skip
   * by incrementing a number the API has never seen.
   *
   * `next_token` is returned only when resuming would not skip records — that is, for
   * ascending reads that did not drop rows locally. A descending read already consumed
   * the window, so its cursor points at older records the caller ranked past.
   */
  async list(path: string, params: ListParams = {}): Promise<ListResult> {
    rejectDecorativePage(params);
    const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIMIT, 1), MAX_OURA_LIMIT);
    const sort = params.sort ?? "desc";
    // Descending has to reach the newest record, which sits on the LAST page, so it
    // always walks the cursor. Ascending may stop as soon as the cap is met.
    const walkAll = sort === "desc" || Boolean(params.all_pages);
    const maxPages = walkAll ? Math.max(1, params.max_pages ?? (sort === "desc" ? MAX_PAGES : DEFAULT_MAX_PAGES)) : 1;
    const collected: unknown[] = [];
    let nextToken: string | undefined = params.next_token;
    let pages = 0;

    while (pages < maxPages) {
      const payload = await this.get(path, {
        ...ouraDateRange(params, path),
        next_token: nextToken
      });
      collected.push(...extractRecords(payload));
      pages += 1;
      nextToken = extractNextToken(payload);
      if (!nextToken) break;
      if (sort === "asc" && collected.length >= limit) break;
      if (!walkAll) break;
    }

    // Oura serves oldest-first; reverse before capping so "newest N" keeps the newest.
    const ordered = sort === "desc" ? [...collected].reverse() : collected;
    const records = ordered.slice(0, limit);
    const truncated = collected.length > limit;
    return {
      records,
      sort,
      next_token: sort === "desc" || truncated ? undefined : nextToken,
      pages_fetched: pages,
      has_more: Boolean(nextToken) || truncated,
      truncated,
      cursor_exhausted: !nextToken
    };
  }

  /** Fetch a single document by id, e.g. `/usercollection/workout/{id}`. */
  async getById(collectionPath: string, documentId: string): Promise<unknown> {
    return this.get(`${collectionPath}/${encodeURIComponent(documentId)}`);
  }

  /**
   * Walk every heart-rate sample in an instant range.
   *
   * `/usercollection/heartrate` takes `start_datetime` / `end_datetime` — not the
   * `start_date` / `end_date` the collection endpoints use — and caps a page at 1000
   * samples, which one workout can exceed: during exercise Oura samples roughly every
   * 5 seconds rather than every 5 minutes.
   */
  async heartrateSamples(startIso: string, endIso: string, maxPages = HR_SCAN_MAX_PAGES): Promise<HeartRateScan> {
    const samples: HeartRateSample[] = [];
    let nextToken: string | undefined;
    let pages = 0;

    while (pages < maxPages) {
      const payload = await this.get("/usercollection/heartrate", {
        start_datetime: startIso,
        end_datetime: endIso,
        next_token: nextToken
      });
      for (const record of extractRecords(payload)) {
        if (!record || typeof record !== "object") continue;
        const { timestamp, bpm, source } = record as Record<string, unknown>;
        if (typeof timestamp !== "string" || typeof bpm !== "number") continue;
        const at = Date.parse(timestamp);
        if (!Number.isFinite(at)) continue;
        samples.push({ at, bpm, source: typeof source === "string" ? source : undefined });
      }
      pages += 1;
      nextToken = extractNextToken(payload);
      if (!nextToken) break;
    }

    samples.sort((a, b) => a.at - b.at);
    return { samples, pages_fetched: pages, cursor_exhausted: !nextToken };
  }

  /**
   * The single newest record of a collection.
   *
   * Oura v2 serves collections OLDEST-FIRST and has no sort parameter, so the newest
   * record is never at the head of a response — it is at the tail of the whole window,
   * i.e. on the LAST page. Reading one page and taking its newest record returns "the
   * newest of the oldest block", which is correct only when the window happens to fit in
   * a single page. This walks the cursor to exhaustion instead, keeping just the newest
   * record seen (O(1) memory), so the answer never depends on where Oura decides to put
   * a page boundary.
   *
   * Cost is bounded by the CALLER narrowing the window with `after`, not by stopping the
   * walk early. `max_pages` is a runaway guard, and `cursor_exhausted: false` reports
   * honestly that it fired and the answer is therefore not provably the newest.
   */
  async latest(path: string, params: LatestParams = {}): Promise<LatestResult> {
    const maxPages = Math.max(1, params.max_pages ?? LATEST_SCAN_MAX_PAGES);
    let best: unknown;
    let nextToken: string | undefined;
    let pages = 0;
    let scanned = 0;

    while (pages < maxPages) {
      const payload = await this.get(path, { ...ouraDateRange(params, path), next_token: nextToken });
      const pageRecords = extractRecords(payload);
      scanned += pageRecords.length;
      if (pageRecords.length > 0) best = mostRecentRecord(best === undefined ? pageRecords : [best, ...pageRecords]);
      pages += 1;
      nextToken = extractNextToken(payload);
      if (!nextToken) break;
    }

    return { record: best, pages_fetched: pages, records_scanned: scanned, cursor_exhausted: !nextToken };
  }

  private extractCode(input: string): string {
    try {
      const url = new URL(input);
      const code = url.searchParams.get("code");
      if (code) return code;
    } catch {
      // Not a URL; treat as raw code.
    }
    return input;
  }

  private extractScope(input: string): string | undefined {
    try {
      const url = new URL(input);
      return url.searchParams.get("scope") ?? undefined;
    } catch {
      return undefined;
    }
  }

  private async request(method: "GET" | "POST", path: string, body?: Record<string, string | number | boolean | undefined>, params?: Record<string, string | number | boolean | undefined>): Promise<unknown> {
    const token = await this.getValidToken();
    const url = this.buildUrl(path, params);
    const response = await this.fetchWithRetry(url, {
      method,
      headers: this.jsonHeaders(token.access_token),
      body: body ? JSON.stringify(cleanParams(body)) : undefined
    });

    if (response.status === 401) {
      // Nothing to refresh in PAT mode — a 401 means the token is wrong or revoked.
      if (this.config.personalAccessToken) {
        throw new Error(
          "Oura API rejected the personal access token (HTTP 401). Check OURA_PERSONAL_ACCESS_TOKEN " +
          "against https://cloud.ouraring.com/personal-access-tokens."
        );
      }
      const refreshed = await this.refreshToken(true);
      const retry = await this.fetchWithRetry(url, {
        method,
        headers: this.jsonHeaders(refreshed.access_token),
        body: body ? JSON.stringify(cleanParams(body)) : undefined
      });
      return this.parseAndCache(method, url, retry);
    }

    return this.parseAndCache(method, url, response);
  }

  private buildUrl(path: string, params?: Record<string, string | number | boolean | undefined>): string {
    const cleanPath = path.startsWith("/") ? path : `/${path}`;
    const url = new URL(`${OURA_API_BASE_URL}${cleanPath}`);
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private async getValidToken(): Promise<OuraTokenSet> {
    // A PAT is already a bearer token for api.ouraring.com/v2 and has no refresh
    // counterpart, so it bypasses the token store, its lock file and the whole
    // authorization-code flow.
    if (this.config.personalAccessToken) {
      return { access_token: this.config.personalAccessToken };
    }
    const tokens = await this.tokenStore.read();
    if (!tokens?.access_token) {
      throw new Error("Oura token not found. Run oura-mcp-server auth, or use oura_get_auth_url then oura_exchange_code.");
    }
    const expiresAt = tokens.expires_at ?? 0;
    const shouldRefresh = Boolean(tokens.refresh_token && expiresAt && expiresAt - Math.floor(Date.now() / 1000) < 3600);
    return shouldRefresh ? this.refreshToken(false) : tokens;
  }

  private async refreshToken(force: boolean): Promise<OuraTokenSet> {
    return this.tokenStore.withLock(async () => {
      const current = await this.tokenStore.read();
      if (!current?.refresh_token) {
        throw new Error("Oura refresh token not found. Re-authorize with oura-mcp-server auth.");
      }
      if (!force && current.expires_at && current.expires_at - Math.floor(Date.now() / 1000) >= 3600) return current;

      const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: current.refresh_token });
      const refreshed = await this.requestTokens(body);
      // Oura refresh responses often omit `scope`; never wipe a previously granted scope string.
      const merged = {
        ...current,
        ...refreshed,
        scope: refreshed.scope ?? current.scope,
        refresh_token: refreshed.refresh_token ?? current.refresh_token
      };
      await this.tokenStore.write(merged);
      return merged;
    });
  }

  private async requestTokens(body: URLSearchParams): Promise<OuraTokenSet> {
    const response = await this.fetchWithRetry(OURA_TOKEN_URL, {
      method: "POST",
      headers: this.formHeaders(),
      body: body.toString()
    });
    const data = await this.parseResponse(response) as Record<string, unknown>;
    const expiresAt = typeof data.expires_at === "number"
      ? data.expires_at
      : typeof data.expires_in === "number"
        ? Math.floor(Date.now() / 1000) + data.expires_in
        : undefined;
    return {
      access_token: String(data.access_token ?? ""),
      refresh_token: typeof data.refresh_token === "string" ? data.refresh_token : undefined,
      token_type: typeof data.token_type === "string" ? data.token_type : undefined,
      scope: typeof data.scope === "string" ? data.scope : undefined,
      expires_in: typeof data.expires_in === "number" ? data.expires_in : undefined,
      expires_at: expiresAt
    };
  }

  private jsonHeaders(accessToken: string): Record<string, string> {
    return {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "Accept-Language": "en_US",
      "User-Agent": "oura-mcp-server/0.1.0"
    };
  }

  private formHeaders(): Record<string, string> {
    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64");
    return {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "Accept-Language": "en_US",
      "User-Agent": "oura-mcp-server/0.1.0"
    };
  }

  private async parseResponse(response: Response): Promise<unknown> {
    const text = await response.text();
    const payload = text ? safeJson(text) : null;
    if (!response.ok) {
      const details = payload && typeof payload === "object" ? JSON.stringify(payload) : text;
      throw new Error(`Oura API HTTP ${response.status}: ${redactErrorMessage(details || response.statusText)}`);
    }
    return payload ?? {};
  }

  private async parseAndCache(method: "GET" | "POST", url: string, response: Response): Promise<unknown> {
    try {
      const payload = await this.parseResponse(response);
      if (this.config.cacheEnabled && method === "GET") this.getCache().set(method, url, payload);
      return payload;
    } catch (error) {
      if (this.config.cacheEnabled && method === "GET") {
        const cached = this.getCache().get(method, url);
        if (cached !== undefined) return cached;
      }
      throw error;
    }
  }

  private getCache(): OuraCache {
    this.cache ??= new OuraCache(this.config.cachePath);
    return this.cache;
  }

  private async fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    const retryWrappedFetch = (u: string, i?: RequestInit) => fetchWithRetryMiddleware(fetch, u, i, {
      vendor: "oura",
      envFlag: "OURA_NO_RETRY"
    });
    return fetchWithCache(url, init, {
      defaultTtlSeconds: 60,
      envVarBypass: "OURA_NO_CACHE",
      innerFetch: retryWrappedFetch
    });
  }
}

/**
 * Build Oura's `start_date` / `end_date` for a caller window that is inclusive at both
 * ends, compensating for the endpoints where Oura's `end_date` is exclusive.
 */
export function ouraDateRange(params: { after?: string; before?: string }, path = ""): Record<string, string> {
  const range: Record<string, string> = {};
  if (params.after) range.start_date = toDate(params.after);
  if (params.before) {
    const end = toDate(params.before);
    range.end_date = isExclusiveEndDate(path) ? addDays(end, 1) : end;
  }
  return range;
}

function isExclusiveEndDate(path: string): boolean {
  const clean = path.startsWith("/") ? path : `/${path}`;
  return EXCLUSIVE_END_DATE_ENDPOINTS.some((endpoint) => clean.startsWith(endpoint));
}

export function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function toDate(value: string): string {
  if (value === "today") return value;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(value);
  if (!match) throw new Error(`Invalid Oura date range value: ${value}`);

  const date = `${match[1]}-${match[2]}-${match[3]}`;
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error(`Invalid Oura date range value: ${value}`);
  }
  return date;
}

function extractRecords(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  for (const key of ["data", "activities", "sleep", "workouts", "heartrate", "sessions", "tags", "records"]) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  return [];
}

function extractNextToken(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const token = (payload as Record<string, unknown>).next_token;
  return typeof token === "string" && token ? token : undefined;
}

/**
 * Oura v2 has no integer page index. `page: 1` is a no-op leftover from the old schema;
 * any other number would previously be ignored while `next_page` still incremented, which
 * is how agents looped forever or skipped data.
 */
function rejectDecorativePage(params: ListParams): void {
  const leftoverPage = (params as { page?: unknown }).page;
  if (leftoverPage === undefined) return;
  if (leftoverPage === 1) return;
  throw new Error(
    "Oura v2 does not paginate by page number. Pass next_token from the previous collection response to resume; do not increment a page index."
  );
}

function cleanParams(input: Record<string, string | number | boolean | undefined>): Record<string, string | number | boolean> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== null && value !== "")) as Record<string, string | number | boolean>;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
