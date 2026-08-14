import type { ResponseFormat, ToolResponse } from "../types.js";
import { redactErrorMessage, redactSensitive } from "./redaction.js";

export function makeResponse<T>(data: T, format: ResponseFormat, markdown: string): ToolResponse<T> {
  const safeData = redactSensitive(data) as T;
  const safeMarkdown = redactErrorMessage(markdown);
  return {
    content: [{ type: "text", text: format === "json" ? JSON.stringify(safeData, null, 2) : safeMarkdown }],
    structuredContent: safeData
  };
}

export function makeError(message: string): ToolResponse<{ error: string }> {
  const safeMessage = redactErrorMessage(message);
  return {
    isError: true,
    content: [{ type: "text", text: `Error: ${safeMessage}` }],
    structuredContent: { error: safeMessage }
  };
}

export function bulletList(title: string, fields: Record<string, unknown>): string {
  const lines = [`# ${title}`, ""];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    lines.push(`- **${key}**: ${formatMarkdownValue(value)}`);
  }
  return lines.join("\n");
}

/**
 * Fields worth showing per record, in the order a reader wants them.
 *
 * Oura names, not Strava's. The previous list asked for `start_date`, `sport_type`,
 * `moving_time` and `total_elevation_gain` — none of which Oura sends — so a workout
 * rendered as "start: n/a, sport: n/a" while `distance` survived purely because the two
 * schemas happen to share that one name.
 */
const RECORD_FIELDS: Array<{ key: string; label: string; format?: (value: unknown) => string }> = [
  { key: "activity", label: "activity" },
  { key: "label", label: "label" },
  { key: "type", label: "type" },
  { key: "intensity", label: "intensity" },
  { key: "score", label: "score" },
  { key: "start_datetime", label: "start" },
  { key: "end_datetime", label: "end" },
  { key: "duration_seconds", label: "duration", format: (value) => formatDuration(value) },
  { key: "bedtime_start", label: "bedtime start" },
  { key: "bedtime_end", label: "bedtime end" },
  { key: "total_sleep_duration", label: "slept", format: (value) => formatDuration(value) },
  { key: "efficiency", label: "efficiency" },
  { key: "average_hrv", label: "average HRV" },
  { key: "lowest_heart_rate", label: "lowest HR" },
  { key: "average_heart_rate", label: "average HR" },
  { key: "steps", label: "steps" },
  { key: "active_calories", label: "active calories" },
  { key: "total_calories", label: "total calories" },
  { key: "calories", label: "calories" },
  { key: "distance", label: "distance_m" },
  { key: "equivalent_walking_distance", label: "walking equivalent_m" },
  { key: "spo2_percentage", label: "SpO2 %" },
  { key: "temperature_deviation", label: "temp deviation" }
];

function formatDuration(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return String(value);
  const minutes = Math.round(value / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * A heading a human can scan: date, then what it was.
 *
 * Never the bare UUID — a 36-character opaque id as a heading is noise for a reader and
 * an invitation for a model to invent one. The id is still emitted as a field, because
 * `oura_get_workout` can act on it.
 */
function recordHeading(object: Record<string, unknown>, index: number): string {
  const parts = [object.day, object.activity ?? object.label ?? object.type]
    .filter((part) => typeof part === "string" && part)
    .map(String);
  return parts.length ? parts.join(" · ") : `record ${index + 1}`;
}

export function formatCollection(title: string, records: unknown[], meta: Record<string, unknown>): string {
  const metaLines = Object.entries(meta)
    .filter(([key, value]) => key !== "records" && value !== undefined && value !== null)
    .map(([key, value]) => `- **${key}**: ${formatMarkdownValue(value)}`);
  const lines = [`# ${title}`, "", ...metaLines, ""];
  const preview = records.slice(0, 8);
  for (const [index, record] of preview.entries()) {
    if (record && typeof record === "object") {
      const object = record as Record<string, unknown>;
      lines.push(`## ${recordHeading(object, index)}`);
      for (const field of RECORD_FIELDS) {
        const value = object[field.key];
        if (value === undefined || value === null) continue;
        lines.push(`- **${field.label}**: ${field.format ? field.format(value) : formatMarkdownValue(value)}`);
      }
      if (typeof object.id === "string") lines.push(`- **id**: \`${object.id}\``);
      lines.push("");
    } else {
      lines.push(`- ${JSON.stringify(record)}`);
    }
  }
  if (records.length > preview.length) lines.push(`... ${records.length - preview.length} more records omitted from markdown preview.`);
  return lines.join("\n");
}

function formatMarkdownValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "none";
    if (value.every((item) => item === null || ["string", "number", "boolean"].includes(typeof item))) {
      return value.map((item) => String(item)).join(", ");
    }
    return `${value.length} item${value.length === 1 ? "" : "s"}`;
  }
  if (value && typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}
