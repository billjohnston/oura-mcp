import type { PrivacyMode, OuraConfig } from "../types.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function pickDefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== null));
}

export type PrivacyEscalationOpts = {
  explicit_user_intent?: boolean;
};

/**
 * Agent-requested privacy_mode=raw requires explicit_user_intent=true.
 * Config-default raw (env) is allowed without per-call intent.
 */
export function resolvePrivacyMode(
  config: { privacyMode: PrivacyMode },
  override?: PrivacyMode,
  opts?: PrivacyEscalationOpts
): PrivacyMode {
  if (override === "raw" && opts?.explicit_user_intent !== true) {
    throw new Error(
      "USER_ACTION_REQUIRED: privacy_mode=raw requires explicit_user_intent=true after the user explicitly asked for unredacted payloads."
    );
  }
  return override ?? config.privacyMode;
}

export function applyPrivacy(endpoint: string, payload: unknown, mode: PrivacyMode): unknown {
  if (mode === "raw") return payload;
  if (isObject(payload) && Array.isArray(payload.records)) {
    return { ...payload, privacy_mode: mode, records: payload.records.map((record) => normalizeRecord(endpoint, record, mode)) };
  }
  if (Array.isArray(payload)) return payload.map((record) => normalizeRecord(endpoint, record, mode));
  return normalizeRecord(endpoint, payload, mode);
}

export function normalizeRecord(endpoint: string, record: unknown, mode: PrivacyMode): unknown {
  if (!isObject(record)) return record;
  if (endpoint.includes("personal_info")) return normalizePersonalInfo(record, mode);
  if (endpoint.includes("workout")) return normalizeOuraWorkout(record, mode);
  if (endpoint.includes("daily_activity")) return normalizeOuraActivity(record, mode);
  if (endpoint.includes("daily_readiness")) return normalizeOuraReadiness(record, mode);
  if (endpoint.includes("sleep")) return normalizeOuraSleep(record, mode);
  if (endpoint.includes("heartrate") || endpoint.includes("spo2")) return normalizeVitals(record, mode);
  if (endpoint.includes("session") || endpoint.includes("tag")) return mode === "summary" ? summarizeUnknown(record) : removeSensitive(record);
  return mode === "summary" ? summarizeUnknown(record) : removeSensitive(record);
}

export function normalizeStreams(payload: unknown, mode: PrivacyMode, includeGps: boolean): unknown {
  if (mode === "raw") return payload;
  if (!isObject(payload)) return payload;
  const clean = removeSensitive(payload);
  if (!includeGps) { delete clean["activities-tracker-gps"]; delete clean.latlng; delete clean.gps; }
  if (mode === "summary") return summarizeUnknown(clean);
  return clean;
}

function normalizeProfile(record: Record<string, unknown>, mode: PrivacyMode): unknown {
  const user = isObject(record.user) ? record.user : record;
  const base = pickDefined({
    encodedId: user.encodedId,
    displayName: user.displayName,
    memberSince: user.memberSince,
    timezone: user.timezone,
    locale: user.locale,
    clockTimeDisplayFormat: user.clockTimeDisplayFormat,
    distanceUnit: user.distanceUnit,
    weightUnit: user.weightUnit
  });
  if (mode === "summary") return base;
  return removeSensitive({ ...user, email: undefined, avatar: undefined, avatar150: undefined });
}

/**
 * Personal info minus the direct identifiers.
 *
 * `email` and `id` name the account; age, height, weight and biological sex describe a
 * body and are inputs the analytic tools genuinely need — `age` is the 220-age HRmax
 * fallback behind the zone rollup. Everything is available under privacy_mode=raw.
 */
function normalizePersonalInfo(record: Record<string, unknown>, mode: PrivacyMode): unknown {
  const base = pickDefined({
    age: record.age,
    height: record.height,
    weight: record.weight,
    biological_sex: record.biological_sex
  });
  if (mode === "summary") return base;
  const clean = removeSensitive(record);
  delete clean.id;
  return clean;
}

/**
 * A workout, keeping what makes it analysable.
 *
 * The point of a workout record is when it happened, how long it lasted, what it was and
 * how hard it was. Those are not identifying, so `structured` keeps them; identity and
 * location are what gets dropped. `duration_seconds` is derived because Oura only gives
 * the two endpoints.
 */
function normalizeOuraWorkout(record: Record<string, unknown>, mode: PrivacyMode): unknown {
  const base = pickDefined({
    id: record.id,
    day: record.day,
    activity: record.activity,
    label: record.label,
    intensity: record.intensity,
    source: record.source,
    start_datetime: record.start_datetime,
    end_datetime: record.end_datetime,
    duration_seconds: durationSeconds(record.start_datetime, record.end_datetime),
    calories: record.calories,
    distance: record.distance
  });
  if (mode === "summary") return base;
  return removeSensitive({ ...record, ...base });
}

function normalizeOuraActivity(record: Record<string, unknown>, mode: PrivacyMode): unknown {
  const base = pickDefined({
    id: record.id,
    day: record.day,
    score: record.score,
    steps: record.steps,
    active_calories: record.active_calories,
    total_calories: record.total_calories,
    equivalent_walking_distance: record.equivalent_walking_distance,
    activity: record.activity,
    start_datetime: record.start_datetime,
    end_datetime: record.end_datetime
  });
  if (mode === "summary") return base;
  return removeSensitive({ ...record, ...base });
}

function normalizeOuraReadiness(record: Record<string, unknown>, mode: PrivacyMode): unknown {
  const base = pickDefined({
    id: record.id,
    day: record.day,
    score: record.score,
    contributors: record.contributors,
    temperature_deviation: record.temperature_deviation
  });
  if (mode === "summary") return base;
  return removeSensitive({ ...record, ...base });
}

function normalizeOuraSleep(record: Record<string, unknown>, mode: PrivacyMode): unknown {
  const base = pickDefined({
    id: record.id,
    day: record.day,
    score: record.score,
    bedtime_start: record.bedtime_start,
    bedtime_end: record.bedtime_end,
    total_sleep_duration: record.total_sleep_duration,
    efficiency: record.efficiency,
    average_hrv: record.average_hrv,
    lowest_heart_rate: record.lowest_heart_rate
  });
  if (mode === "summary") return base;
  return removeSensitive({ ...record, ...base });
}

function normalizeDevices(record: Record<string, unknown>, mode: PrivacyMode): unknown {
  const devices = Array.isArray(record) ? record : [record];
  const normalized = devices.map((device) => isObject(device) ? pickDefined({
    id: mode === "summary" ? undefined : device.id,
    deviceVersion: device.deviceVersion,
    type: device.type,
    battery: device.battery,
    lastSyncTime: device.lastSyncTime
  }) : device);
  return Array.isArray(record) ? normalized : normalized[0];
}

function normalizeActivity(record: Record<string, unknown>, mode: PrivacyMode): unknown {
  const base = pickDefined({
    activityId: record.activityId,
    logId: record.logId,
    name: record.name,
    activityName: record.activityName,
    startTime: record.startTime,
    duration: record.duration,
    distance: record.distance,
    steps: record.steps,
    calories: record.calories,
    activeDuration: record.activeDuration,
    averageHeartRate: record.averageHeartRate
  });
  if (mode === "summary") return base;
  return removeSensitive({ ...record, ...base });
}

function normalizeActivityDetail(record: Record<string, unknown>, mode: PrivacyMode): unknown {
  if (mode === "summary") return normalizeActivity(record, mode);
  return removeSensitive(record);
}

function normalizeSleep(record: Record<string, unknown>, mode: PrivacyMode): unknown {
  if (Array.isArray(record.sleep)) return { ...record, sleep: record.sleep.map((item) => isObject(item) ? normalizeSleepLog(item, mode) : item) };
  return normalizeSleepLog(record, mode);
}

function normalizeSleepLog(record: Record<string, unknown>, mode: PrivacyMode): unknown {
  const base = pickDefined({
    logId: record.logId,
    dateOfSleep: record.dateOfSleep,
    startTime: record.startTime,
    endTime: record.endTime,
    duration: record.duration,
    minutesAsleep: record.minutesAsleep,
    minutesAwake: record.minutesAwake,
    efficiency: record.efficiency,
    type: record.type
  });
  if (mode === "summary") return base;
  return removeSensitive({ ...record, ...base });
}

function normalizeVitals(record: Record<string, unknown>, mode: PrivacyMode): unknown {
  if (mode === "summary") return summarizeUnknown(record);
  return removeSensitive(record);
}

function normalizeWeight(record: Record<string, unknown>, mode: PrivacyMode): unknown {
  if (Array.isArray(record.weight)) return { weight: record.weight.map((item) => isObject(item) ? normalizeWeight(item, mode) : item) };
  return mode === "summary" ? pickDefined({ date: record.date, weight: record.weight, bmi: record.bmi }) : removeSensitive(record);
}

function normalizeNutrition(record: Record<string, unknown>, mode: PrivacyMode): unknown {
  if (mode === "summary") return summarizeUnknown(record);
  return removeSensitive(record);
}

function summarizeUnknown(record: Record<string, unknown>): Record<string, unknown> {
  return pickDefined({
    id: record.id ?? record.logId ?? record.activityId,
    date: record.date ?? record.dateTime ?? record.dateOfSleep ?? record.day,
    name: record.name ?? record.activityName,
    score: record.score,
    summary: record.summary,
    value: record.value
  });
}

/**
 * Fields that name a person or a credential. Removed in every mode except raw.
 */
const IDENTITY_KEYS = [
  "email", "fullName", "firstName", "lastName", "displayName", "username",
  "user_id", "userId", "avatar", "avatar150", "access_token", "refresh_token"
];

/**
 * Fields that place a person somewhere. Removed in every mode except raw.
 *
 * A route is far more identifying than any biometric in this dataset: it names where you
 * live, work and exercise. Oura does not currently return these, but workout records are
 * the obvious place for them to appear, and a redaction list that only covers today's
 * schema stops working the moment the schema grows.
 */
const LOCATION_KEYS = [
  "start_latlng", "end_latlng", "latlng", "lat", "lng", "latitude", "longitude",
  "map", "polyline", "summary_polyline", "route", "gps", "tcxLink", "gpx", "location"
];

function removeSensitive(record: Record<string, unknown>): Record<string, unknown> {
  const clone = { ...record };
  for (const key of [...IDENTITY_KEYS, ...LOCATION_KEYS, "features"]) delete clone[key];
  return clone;
}

/** Seconds between two ISO instants, or undefined if either is unusable. */
function durationSeconds(start: unknown, end: unknown): number | undefined {
  if (typeof start !== "string" || typeof end !== "string") return undefined;
  const from = Date.parse(start);
  const to = Date.parse(end);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return undefined;
  return Math.round((to - from) / 1000);
}
