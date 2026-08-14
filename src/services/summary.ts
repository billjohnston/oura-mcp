import type { OuraClient } from "./oura-client.js";
import { addDays } from "./oura-client.js";
import { redactErrorMessage } from "./redaction.js";

const DAY_MS = 24 * 60 * 60 * 1000;

type UnknownRecord = Record<string, unknown>;

export interface SummaryOptions {
  days: number;
  compare_days?: number;
  timezone?: string;
}

function isObject(value: unknown): value is UnknownRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function firstData(value: unknown): UnknownRecord {
  if (Array.isArray(value)) return isObject(value[0]) ? value[0] : {};
  if (!isObject(value)) return {};
  if (Array.isArray(value.data)) return isObject(value.data[0]) ? value.data[0] : {};
  return value;
}

function num(record: UnknownRecord, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function round(value?: number, digits = 1): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function sum(values: Array<number | undefined>): number {
  return values.reduce<number>((total, value) => total + (typeof value === "number" && Number.isFinite(value) ? value : 0), 0);
}

function avg(values: Array<number | undefined>): number | undefined {
  const nums = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return nums.length ? sum(nums) / nums.length : undefined;
}

function percentDelta(current?: number, previous?: number): number | undefined {
  if (current === undefined || previous === undefined || previous === 0) return undefined;
  return ((current - previous) / previous) * 100;
}

function dateString(daysAgo = 0): string {
  return new Date(Date.now() - daysAgo * DAY_MS).toISOString().slice(0, 10);
}

async function safeGet(client: Pick<OuraClient, "get">, endpoint: string, params?: Record<string, string>): Promise<unknown> {
  try {
    return await client.get(endpoint, params);
  } catch (error) {
    const message = redactErrorMessage(error instanceof Error ? error.message : String(error));
    process.stderr.write(`[oura-mcp] summary domain error: ${message}\n`);
    return { error: message, endpoint };
  }
}

async function dailyBundle(client: Pick<OuraClient, "get">, date: string) {
  // `daily_activity` and `sleep` treat end_date as EXCLUSIVE, so start_date == end_date
  // returns nothing for them while the daily_* score endpoints return the day. Asking
  // for one day the same way on every endpoint is what silently zeroed steps and HRV.
  const dayRange = { start_date: date, end_date: date };
  const spanRange = { start_date: date, end_date: addDays(date, 1) };
  const [activity, dailySleep, readiness, sleep, spo2] = await Promise.all([
    safeGet(client, "/usercollection/daily_activity", spanRange),
    safeGet(client, "/usercollection/daily_sleep", dayRange),
    safeGet(client, "/usercollection/daily_readiness", dayRange),
    safeGet(client, "/usercollection/sleep", spanRange),
    safeGet(client, "/usercollection/daily_spo2", dayRange)
  ]);
  return { date, activity, dailySleep, readiness, sleep, spo2 };
}

/** Records from a widened window can include the following day; keep the one asked for. */
function recordsForDay(payload: unknown, date: string): UnknownRecord[] {
  const rows = Array.isArray(payload)
    ? payload
    : isObject(payload) && Array.isArray(payload.data)
      ? payload.data
      : [];
  const matching = rows.filter((row): row is UnknownRecord => isObject(row) && row.day === date);
  // Fall back to the raw rows when the payload carries no `day` at all, so this stays
  // compatible with fixtures and with any endpoint that omits it.
  return matching.length ? matching : rows.filter((row): row is UnknownRecord => isObject(row));
}

/**
 * The night's main sleep, not merely the first record.
 *
 * Oura returns every sleep period for a day, and a 30-second `type: "sleep"` blip sorts
 * ahead of the real `long_sleep` — taking `data[0]` then reports a half-minute night with
 * no HRV. Prefer a long_sleep period, then the longest, which is what "last night" means.
 */
function mainSleep(payload: unknown, date: string): UnknownRecord {
  const rows = recordsForDay(payload, date);
  if (!rows.length) return {};
  const duration = (row: UnknownRecord) => num(row, ["total_sleep_duration", "time_in_bed"]) ?? 0;
  const longSleeps = rows.filter((row) => row.type === "long_sleep");
  const candidates = longSleeps.length ? longSleeps : rows;
  return candidates.reduce((best, row) => (duration(row) > duration(best) ? row : best), candidates[0]);
}

function dailyStats(bundle: Awaited<ReturnType<typeof dailyBundle>>) {
  const activity = recordsForDay(bundle.activity, bundle.date)[0] ?? {};
  const dailySleep = firstData(bundle.dailySleep);
  const readiness = firstData(bundle.readiness);
  const sleep = mainSleep(bundle.sleep, bundle.date);
  const spo2 = firstData(bundle.spo2);
  const totalSleepSeconds = num(sleep, ["total_sleep_duration", "time_in_bed"]);
  const activeCalories = num(activity, ["active_calories", "calories"]);
  const equivalentWalkingMeters = num(activity, ["equivalent_walking_distance"]);

  return {
    date: bundle.date,
    readiness_score: num(readiness, ["score"]),
    sleep_score: num(dailySleep, ["score"]),
    activity_score: num(activity, ["score"]),
    steps: num(activity, ["steps"]),
    active_calories: activeCalories,
    total_calories: num(activity, ["total_calories"]),
    distance_km: equivalentWalkingMeters === undefined ? undefined : round(equivalentWalkingMeters / 1000, 2),
    sleep_minutes: totalSleepSeconds === undefined ? undefined : round(totalSleepSeconds / 60, 0),
    sleep_efficiency: num(sleep, ["efficiency"]),
    average_heart_rate: num(sleep, ["average_heart_rate"]),
    lowest_heart_rate: num(sleep, ["lowest_heart_rate"]),
    hrv_rmssd: num(sleep, ["average_hrv"]),
    spo2_percentage: num(spo2, ["spo2_percentage"]),
    temperature_deviation: num(readiness, ["temperature_deviation"]),
    has_activity_error: isObject(bundle.activity) && typeof bundle.activity.error === "string",
    has_sleep_error: isObject(bundle.sleep) && typeof bundle.sleep.error === "string",
    has_readiness_error: isObject(bundle.readiness) && typeof bundle.readiness.error === "string",
    has_spo2_error: isObject(bundle.spo2) && typeof bundle.spo2.error === "string"
  };
}

function classifyReadiness(stats: ReturnType<typeof dailyStats>): string {
  const readiness = stats.readiness_score;
  const sleepScore = stats.sleep_score;
  const sleepHours = (stats.sleep_minutes ?? 0) / 60;
  if (readiness !== undefined && readiness >= 85) return "high_readiness";
  if (readiness !== undefined && readiness < 60) return "low_readiness";
  if (sleepScore !== undefined && sleepScore < 65) return "sleep_limited";
  if (sleepHours > 0 && sleepHours < 6) return "sleep_limited";
  if ((stats.activity_score ?? 0) >= 85 && (readiness ?? 100) < 70) return "load_recovery_mismatch";
  return "neutral";
}

/**
 * A threshold claim plus the number that triggered it.
 *
 * Every string that asserts a comparison ("sleep below 6.5h") also carries the observed
 * value, the threshold and the metric name, so a reader can check the claim instead of
 * taking it on faith — and so a downstream agent can re-evaluate it without re-parsing
 * English.
 */
export interface Finding {
  code: string;
  message: string;
  metric?: string;
  value?: number;
  threshold?: number;
  comparator?: "lt" | "gt" | "lte" | "gte";
  unit?: string;
}

function threshold(
  code: string,
  metric: string,
  value: number | undefined,
  comparator: "lt" | "gt",
  limit: number,
  unit: string,
  message: (value: number) => string
): Finding | undefined {
  if (value === undefined) return undefined;
  const breached = comparator === "lt" ? value < limit : value > limit;
  if (!breached) return undefined;
  return { code, message: message(value), metric, value, threshold: limit, comparator, unit };
}

function buildFindings(stats: ReturnType<typeof dailyStats>, weekly?: ReturnType<typeof aggregateStats>): Finding[] {
  const findings: Finding[] = [];
  const state = classifyReadiness(stats);
  const sleepHours = stats.sleep_minutes === undefined ? undefined : round(stats.sleep_minutes / 60, 2);

  if (state === "low_readiness") {
    findings.push({
      code: "low_readiness",
      message: `Readiness is ${stats.readiness_score} (below 60). Keep intensity low today and prioritize recovery inputs before adding more training stress.`,
      metric: "readiness_score", value: stats.readiness_score, threshold: 60, comparator: "lt", unit: "score"
    });
  }
  if (state === "sleep_limited") {
    findings.push({
      code: "sleep_limited",
      message: `Sleep is the limiting input today (${sleepHours ?? "?"}h slept, sleep score ${stats.sleep_score ?? "n/a"}). Protect bedtime, light exposure and stimulant cutoff before optimizing workouts.`,
      metric: "sleep_hours", value: sleepHours, threshold: 6, comparator: "lt", unit: "hours"
    });
  }
  if (state === "load_recovery_mismatch") {
    findings.push({
      code: "load_recovery_mismatch",
      message: `Activity score ${stats.activity_score} is high against readiness ${stats.readiness_score}; use subjective soreness and schedule pressure before deciding on intensity.`,
      metric: "activity_score", value: stats.activity_score, threshold: 85, comparator: "gt", unit: "score"
    });
  }
  if (state === "high_readiness") {
    findings.push({
      code: "high_readiness",
      message: `Readiness is ${stats.readiness_score} (at or above 85). If subjective energy agrees, this is a reasonable day for quality work or progressive aerobic volume.`,
      metric: "readiness_score", value: stats.readiness_score, threshold: 85, comparator: "gt", unit: "score"
    });
  }
  if (state === "neutral") {
    findings.push({
      code: "neutral",
      message: "Use Oura as a baseline check today: pair the scores with subjective energy, soreness and schedule pressure."
    });
  }

  const temperature = threshold(
    "temperature_deviation", "temperature_deviation", stats.temperature_deviation, "gt", 0.5, "celsius",
    (value) => `Temperature deviation is +${value}°C (above 0.5). Treat as context only; illness symptoms should override training plans.`
  );
  if (temperature) findings.push(temperature);

  const weeklySleep = threshold(
    "weekly_sleep_low", "avg_sleep_hours", weekly?.avg_sleep_hours, "lt", 6.5, "hours",
    (value) => `Weekly sleep average is ${value}h (below 6.5h); recovery improvements may beat training complexity.`
  );
  if (weeklySleep) findings.push(weeklySleep);

  findings.push({
    code: "not_medical_advice",
    message: "This is not medical advice; use Oura as trend context and escalate symptoms or abnormal vitals to a clinician."
  });
  return findings;
}

function buildActions(stats: ReturnType<typeof dailyStats>, weekly?: ReturnType<typeof aggregateStats>): string[] {
  return [...new Set(buildFindings(stats, weekly).map((finding) => finding.message))];
}

function aggregateStats(days: ReturnType<typeof dailyStats>[]) {
  return {
    days: days.length,
    avg_readiness_score: round(avg(days.map((day) => day.readiness_score)), 1),
    avg_sleep_score: round(avg(days.map((day) => day.sleep_score)), 1),
    avg_activity_score: round(avg(days.map((day) => day.activity_score)), 1),
    total_steps: round(sum(days.map((day) => day.steps)), 0),
    avg_steps: round(avg(days.map((day) => day.steps)), 0),
    avg_active_calories: round(avg(days.map((day) => day.active_calories)), 0),
    avg_sleep_hours: round(avg(days.map((day) => day.sleep_minutes).map((minutes) => minutes === undefined ? undefined : minutes / 60)), 2),
    avg_lowest_heart_rate: round(avg(days.map((day) => day.lowest_heart_rate)), 0),
    avg_hrv_rmssd: round(avg(days.map((day) => day.hrv_rmssd)), 1),
    avg_spo2_percentage: round(avg(days.map((day) => day.spo2_percentage)), 1),
    days_with_readiness: days.filter((day) => day.readiness_score !== undefined).length,
    days_with_sleep: days.filter((day) => day.sleep_minutes !== undefined || day.sleep_score !== undefined).length,
    days_with_hrv: days.filter((day) => day.hrv_rmssd !== undefined).length
  };
}

export async function buildDailySummary(client: Pick<OuraClient, "get">, options: SummaryOptions) {
  const date = dateString(0);
  const bundle = await dailyBundle(client, date);
  const stats = dailyStats(bundle);
  const readiness = classifyReadiness(stats);

  return {
    kind: "daily_summary" as const,
    generated_at: new Date().toISOString(),
    window: { date, days: options.days, timezone: options.timezone ?? "UTC" },
    data_quality: {
      confidence: [stats.has_activity_error, stats.has_sleep_error, stats.has_readiness_error].filter(Boolean).length === 0 ? "high" : "partial",
      missing_or_failed: {
        activity: stats.has_activity_error,
        sleep: stats.has_sleep_error,
        readiness: stats.has_readiness_error,
        spo2: stats.has_spo2_error
      }
    },
    scorecard: stats,
    diagnostic: {
      readiness_context: readiness,
      primary_signal: readiness === "low_readiness" || readiness === "sleep_limited"
        ? "Recovery is the limiting context today; keep recommendations conservative."
        : "Use Oura readiness, sleep and activity together as context, not diagnosis.",
      action_candidates: buildActions(stats),
      findings: buildFindings(stats)
    },
    safety: {
      medical_advice: false,
      api_boundary: "Oura Cloud API exposes processed readiness, sleep, activity, workout, heart-rate and SpO2 data; this MCP does not expose raw sensor streams."
    }
  };
}

export async function buildWeeklySummary(client: Pick<OuraClient, "get">, options: SummaryOptions) {
  const days = Math.max(options.days, 7);
  const compareDays = options.compare_days ?? 7;
  const currentBundles = await Promise.all(Array.from({ length: days }, (_, index) => dailyBundle(client, dateString(index))));
  const current = currentBundles.map(dailyStats).reverse();
  const previous = compareDays > 0
    ? (await Promise.all(Array.from({ length: compareDays }, (_, index) => dailyBundle(client, dateString(days + index))))).map(dailyStats).reverse()
    : [];
  const currentStats = aggregateStats(current);
  const previousStats = previous.length ? aggregateStats(previous) : undefined;

  return {
    kind: "weekly_summary" as const,
    generated_at: new Date().toISOString(),
    window: { days, compare_days: compareDays, timezone: options.timezone ?? "UTC" },
    data_quality: {
      days_with_readiness: currentStats.days_with_readiness,
      days_with_sleep: currentStats.days_with_sleep,
      days_with_hrv: currentStats.days_with_hrv,
      confidence: currentStats.days_with_readiness >= 5 && currentStats.days_with_sleep >= 5 ? "high" : currentStats.days_with_sleep >= 3 ? "medium" : "low"
    },
    scorecard: {
      current: currentStats,
      previous: previousStats,
      delta: previousStats ? {
        readiness_pct: round(percentDelta(currentStats.avg_readiness_score, previousStats.avg_readiness_score), 1),
        sleep_score_pct: round(percentDelta(currentStats.avg_sleep_score, previousStats.avg_sleep_score), 1),
        steps_pct: round(percentDelta(currentStats.avg_steps, previousStats.avg_steps), 1),
        sleep_hours_pct: round(percentDelta(currentStats.avg_sleep_hours, previousStats.avg_sleep_hours), 1),
        hrv_pct: round(percentDelta(currentStats.avg_hrv_rmssd, previousStats.avg_hrv_rmssd), 1)
      } : undefined
    },
    diagnostic: {
      load_classification: classifyWeeklyLoad(currentStats),
      bottlenecks: inferBottlenecks(currentStats, previousStats),
      action_candidates: buildActions(current[current.length - 1] ?? current[0], currentStats),
      findings: [
        ...inferBottleneckFindings(currentStats, previousStats),
        ...buildFindings(current[current.length - 1] ?? current[0], currentStats)
      ],
      next_week_success_metrics: [
        "Keep sleep average above the user's sustainable baseline before increasing intensity.",
        "Track readiness score, sleep score and HRV together rather than optimizing one metric.",
        "Use HRV only when enough days are available; sparse HRV should be treated as low confidence.",
        "If symptoms, illness or abnormal vitals appear, seek clinical guidance instead of agent optimization."
      ]
    },
    safety: {
      medical_advice: false,
      raw_sensor_boundary: "Oura MCP exposes processed Cloud API data, not raw ring telemetry."
    }
  };
}

function classifyWeeklyLoad(stats: ReturnType<typeof aggregateStats>): string {
  const readiness = stats.avg_readiness_score ?? 100;
  const sleep = stats.avg_sleep_hours ?? 0;
  const activity = stats.avg_activity_score ?? 0;
  if (readiness < 65 && sleep < 6.5) return "low_readiness_low_sleep";
  if (activity >= 85 && readiness < 75) return "high_activity_lower_readiness";
  if (sleep < 6.5) return "sleep_limited";
  if (readiness >= 80 && sleep >= 7) return "good_recovery_base";
  return "neutral";
}

function inferBottleneckFindings(current: ReturnType<typeof aggregateStats>, previous?: ReturnType<typeof aggregateStats>): Finding[] {
  const findings: Finding[] = [];
  const sleepDelta = round(percentDelta(current.avg_sleep_hours, previous?.avg_sleep_hours), 1);
  const readinessDelta = round(percentDelta(current.avg_readiness_score, previous?.avg_readiness_score), 1);

  const readiness = threshold(
    "avg_readiness_low", "avg_readiness_score", current.avg_readiness_score, "lt", 65, "score",
    (value) => `Average readiness is ${value} (below 65); keep intensity recommendations conservative.`
  );
  if (readiness) findings.push(readiness);

  const sleep = threshold(
    "avg_sleep_low", "avg_sleep_hours", current.avg_sleep_hours, "lt", 6.5, "hours",
    (value) => `Average sleep is ${value}h (below 6.5h); recovery may be the limiting factor.`
  );
  if (sleep) findings.push(sleep);

  const readinessDrop = threshold(
    "readiness_declined", "readiness_delta_pct", readinessDelta, "lt", -10, "percent",
    (value) => `Readiness fell ${value}% versus the comparison window (beyond -10%).`
  );
  if (readinessDrop) findings.push(readinessDrop);

  const sleepDrop = threshold(
    "sleep_declined", "sleep_hours_delta_pct", sleepDelta, "lt", -10, "percent",
    (value) => `Sleep duration fell ${value}% versus the comparison window (beyond -10%).`
  );
  if (sleepDrop) findings.push(sleepDrop);

  const hrv = threshold(
    "hrv_sparse", "days_with_hrv", current.days_with_hrv, "lt", 3, "days",
    (value) => `HRV is present on only ${value} of ${current.days} days (below 3); do not over-weight HRV conclusions.`
  );
  if (hrv) findings.push(hrv);

  if (!findings.length) {
    findings.push({
      code: "no_bottleneck",
      message: "No obvious Oura-only bottleneck; combine trends with subjective energy, soreness and life stress."
    });
  }
  return findings;
}

function inferBottlenecks(current: ReturnType<typeof aggregateStats>, previous?: ReturnType<typeof aggregateStats>): string[] {
  return inferBottleneckFindings(current, previous).map((finding) => finding.message);
}

export function formatSummaryMarkdown(summary: Record<string, unknown>): string {
  const lines = [`# Oura ${summary.kind === "weekly_summary" ? "Weekly" : "Daily"} Summary`, ""];
  lines.push(`Generated: ${summary.generated_at}`);
  const diagnostic = summary.diagnostic as { primary_signal?: string; load_classification?: string; readiness_context?: string; action_candidates?: string[]; bottlenecks?: string[] } | undefined;
  if (diagnostic?.primary_signal) lines.push(`\n## Primary signal\n${diagnostic.primary_signal}`);
  if (diagnostic?.readiness_context) lines.push(`\n## Readiness context\n${diagnostic.readiness_context}`);
  if (diagnostic?.load_classification) lines.push(`\n## Load\n${diagnostic.load_classification}`);
  if (diagnostic?.bottlenecks?.length) {
    lines.push("\n## Bottlenecks");
    diagnostic.bottlenecks.forEach((item) => lines.push(`- ${item}`));
  }
  if (diagnostic?.action_candidates?.length) {
    lines.push("\n## Action candidates");
    diagnostic.action_candidates.forEach((item) => lines.push(`- ${item}`));
  }
  lines.push("\n## Structured data");
  lines.push("```json");
  lines.push(JSON.stringify(summary, null, 2));
  lines.push("```");
  return lines.join("\n");
}
