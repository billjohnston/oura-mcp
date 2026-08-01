/**
 * Recency comparison for Oura collection records.
 *
 * Oura v2 serves collections OLDEST-FIRST, exposes no sort parameter and no page-size
 * parameter. "Most recent" therefore can never be requested from the API — it can only
 * be found, at the tail of a fully walked window. These helpers are the "found" part;
 * `OuraClient.latest()` is the walk.
 */

/** Timestamp-ish field of a record, in the order Oura populates them. Empty when absent. */
export function recencyKey(record: unknown): string {
  if (!record || typeof record !== "object") return "";
  const value = record as Record<string, unknown>;
  for (const key of ["timestamp", "bedtime_end", "day", "end_datetime", "created_at"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate) return candidate;
  }
  return "";
}

/**
 * The newest record of a batch, or undefined when the batch is empty.
 *
 * Falls back to the last element when no record carries a parseable timestamp, which is
 * still the newest under Oura's oldest-first ordering.
 */
export function mostRecentRecord(records: unknown[]): unknown {
  if (records.length === 0) return undefined;
  let best = records[records.length - 1];
  let bestTime = Number.NEGATIVE_INFINITY;
  for (const record of records) {
    const parsed = Date.parse(recencyKey(record));
    if (Number.isFinite(parsed) && parsed >= bestTime) {
      bestTime = parsed;
      best = record;
    }
  }
  return best;
}
