import type { PrivacyMode } from "../types.js";
import { applyPrivacy } from "./privacy.js";

/** The subset of `OuraClient.list` that shapes a collection response. */
export interface CollectionListResult {
  records: unknown[];
  sort: "asc" | "desc";
  next_token?: string;
  pages_fetched: number;
  has_more: boolean;
  truncated: boolean;
  cursor_exhausted: boolean;
}

/**
 * The payload every `oura_list_*` tool returns.
 *
 * Extracted so the demo can produce its sample through this exact function instead of
 * describing it by hand: a second, hand-written description of this shape is how a demo
 * ends up advertising fields the server never sends.
 */
export function buildCollectionOutput(endpoint: string, privacyMode: PrivacyMode, result: CollectionListResult) {
  const normalized = applyPrivacy(endpoint, { records: result.records }, privacyMode) as { records: unknown[] };
  return {
    endpoint,
    privacy_mode: privacyMode,
    count: normalized.records.length,
    records: normalized.records,
    sort: result.sort,
    has_more: result.has_more,
    truncated: result.truncated,
    pages_fetched: result.pages_fetched,
    cursor_exhausted: result.cursor_exhausted,
    ...(result.next_token ? { next_token: result.next_token } : {})
  };
}
