import { HR_SAMPLE_MAX_GAP_SECONDS, HR_ZONE_BOUNDS } from "../constants.js";
import type { HeartRateSample, OuraClient } from "./oura-client.js";

export interface ZoneBucket {
  zone: string;
  label: string;
  /** Inclusive lower bound as a fraction of HRmax. */
  min_pct_hrmax: number;
  /** Exclusive upper bound; null on the open-ended top zone. */
  max_pct_hrmax: number | null;
  min_bpm: number;
  max_bpm: number | null;
  minutes: number;
  sample_count: number;
}

export interface WorkoutZoneRollup {
  workout: {
    id?: string;
    day?: string;
    activity?: string;
    intensity?: string;
    start_datetime?: string;
    end_datetime?: string;
    duration_minutes?: number;
  };
  hrmax: {
    bpm: number;
    source: "provided" | "estimated_220_minus_age";
    age?: number;
  };
  zones: ZoneBucket[];
  below_zone1_minutes: number;
  total_measured_minutes: number;
  /**
   * Share of the workout window actually covered by heart-rate samples, 0-100.
   *
   * Optical HR drops out constantly during exercise — wrist movement, cold, a loose band.
   * Without this number a rollup built from 40% coverage is indistinguishable from a
   * complete one, and every zone total silently reads low.
   */
  data_completeness_pct: number;
  sample_count: number;
  average_bpm?: number;
  max_bpm?: number;
  /** False when the sample page budget ran out before Oura's cursor did. */
  cursor_exhausted: boolean;
  notes: string[];
}

function minutes(seconds: number): number {
  return Math.round((seconds / 60) * 10) / 10;
}

/** Zone boundaries in bpm for a given HRmax. */
export function zoneBands(hrmax: number): Array<{ zone: string; label: string; min: number; max: number; minBpm: number; maxBpm: number }> {
  return HR_ZONE_BOUNDS.map((bound) => ({
    zone: bound.zone,
    label: bound.label,
    min: bound.min,
    max: bound.max,
    minBpm: Math.round(bound.min * hrmax),
    maxBpm: bound.max === Infinity ? Infinity : Math.round(bound.max * hrmax)
  }));
}

/**
 * Turn heart-rate samples into minutes per zone.
 *
 * Each sample is weighted by the time until the next one rather than counted, because
 * Oura's sampling rate is not constant: roughly every 5 seconds during a workout and
 * every 5 minutes at rest. Counting samples would therefore weight a workout's dense
 * middle far above its sparse edges. Gaps longer than HR_SAMPLE_MAX_GAP_SECONDS are not
 * credited to any zone — they are dropout, and pretending the last known bpm persisted
 * across them is how a rollup invents minutes that were never measured.
 */
export function bucketSamples(
  samples: HeartRateSample[],
  hrmax: number,
  windowStartMs: number,
  windowEndMs: number
): { zones: ZoneBucket[]; belowZone1Seconds: number; measuredSeconds: number; average?: number; max?: number } {
  const bands = zoneBands(hrmax);
  const seconds = new Map<string, number>(bands.map((band) => [band.zone, 0]));
  const counts = new Map<string, number>(bands.map((band) => [band.zone, 0]));
  let belowZone1Seconds = 0;
  let measuredSeconds = 0;
  let bpmTotal = 0;
  let bpmMax: number | undefined;

  const inWindow = samples.filter((sample) => sample.at >= windowStartMs && sample.at <= windowEndMs);

  for (const [index, sample] of inWindow.entries()) {
    const next = inWindow[index + 1];
    const rawGapSeconds = next ? (next.at - sample.at) / 1000 : (windowEndMs - sample.at) / 1000;
    const weight = Math.min(Math.max(rawGapSeconds, 0), HR_SAMPLE_MAX_GAP_SECONDS);
    if (weight <= 0) continue;

    measuredSeconds += weight;
    bpmTotal += sample.bpm * weight;
    if (bpmMax === undefined || sample.bpm > bpmMax) bpmMax = sample.bpm;

    const fraction = sample.bpm / hrmax;
    const band = bands.find((candidate) => fraction >= candidate.min && fraction < candidate.max);
    if (!band) {
      belowZone1Seconds += weight;
      continue;
    }
    seconds.set(band.zone, (seconds.get(band.zone) ?? 0) + weight);
    counts.set(band.zone, (counts.get(band.zone) ?? 0) + 1);
  }

  return {
    zones: bands.map((band) => ({
      zone: band.zone,
      label: band.label,
      min_pct_hrmax: Math.round(band.min * 100),
      max_pct_hrmax: band.max === Infinity ? null : Math.round(band.max * 100),
      min_bpm: band.minBpm,
      max_bpm: band.maxBpm === Infinity ? null : band.maxBpm,
      minutes: minutes(seconds.get(band.zone) ?? 0),
      sample_count: counts.get(band.zone) ?? 0
    })),
    belowZone1Seconds,
    measuredSeconds,
    average: measuredSeconds > 0 ? Math.round(bpmTotal / measuredSeconds) : undefined,
    max: bpmMax
  };
}

export interface WorkoutLike {
  id?: string;
  day?: string;
  activity?: string;
  intensity?: string;
  start_datetime?: string;
  end_datetime?: string;
}

/** Build the zone rollup for one workout. */
export async function rollupWorkoutZones(
  client: Pick<OuraClient, "heartrateSamples">,
  workout: WorkoutLike,
  hrmax: number,
  hrmaxSource: "provided" | "estimated_220_minus_age",
  age?: number
): Promise<WorkoutZoneRollup> {
  const notes: string[] = [];
  const startMs = workout.start_datetime ? Date.parse(workout.start_datetime) : NaN;
  const endMs = workout.end_datetime ? Date.parse(workout.end_datetime) : NaN;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new Error(`Workout ${workout.id ?? "(unknown)"} has no usable start_datetime/end_datetime window.`);
  }

  const windowSeconds = (endMs - startMs) / 1000;
  const scan = await client.heartrateSamples(new Date(startMs).toISOString(), new Date(endMs).toISOString());
  const bucketed = bucketSamples(scan.samples, hrmax, startMs, endMs);
  const completeness = windowSeconds > 0 ? Math.min(100, Math.round((bucketed.measuredSeconds / windowSeconds) * 1000) / 10) : 0;

  if (hrmaxSource === "estimated_220_minus_age") {
    notes.push(`HRmax estimated as 220-${age} = ${hrmax} bpm. The 220-age formula carries roughly +/-10-12 bpm of individual error, so zone edges are approximate; pass hrmax from a tested maximum for accuracy.`);
  }
  if (completeness < 80) {
    notes.push(`Heart-rate samples cover only ${completeness}% of the workout window; zone minutes are a floor, not a total. Optical HR dropout during movement is the usual cause.`);
  }
  if (!scan.cursor_exhausted) {
    notes.push("The heart-rate page budget ran out before the window did; some samples were not read.");
  }
  if (!bucketed.measuredSeconds) {
    notes.push("No heart-rate samples fell inside this workout window.");
  }

  return {
    workout: {
      id: workout.id,
      day: workout.day,
      activity: workout.activity,
      intensity: workout.intensity,
      start_datetime: workout.start_datetime,
      end_datetime: workout.end_datetime,
      duration_minutes: minutes(windowSeconds)
    },
    hrmax: { bpm: hrmax, source: hrmaxSource, age },
    zones: bucketed.zones,
    below_zone1_minutes: minutes(bucketed.belowZone1Seconds),
    total_measured_minutes: minutes(bucketed.measuredSeconds),
    data_completeness_pct: completeness,
    sample_count: bucketed.zones.reduce((total, zone) => total + zone.sample_count, 0),
    average_bpm: bucketed.average,
    max_bpm: bucketed.max,
    cursor_exhausted: scan.cursor_exhausted,
    notes
  };
}

export function formatZoneMarkdown(rollups: WorkoutZoneRollup[]): string {
  const lines = ["# Oura Workout Heart-Rate Zones", ""];
  for (const rollup of rollups) {
    const { workout } = rollup;
    lines.push(`## ${[workout.day, workout.activity].filter(Boolean).join(" · ") || "workout"}`);
    lines.push(`- **window**: ${workout.start_datetime ?? "?"} → ${workout.end_datetime ?? "?"} (${workout.duration_minutes} min)`);
    lines.push(`- **HRmax**: ${rollup.hrmax.bpm} bpm (${rollup.hrmax.source === "provided" ? "provided" : `estimated 220-${rollup.hrmax.age}`})`);
    lines.push(`- **data completeness**: ${rollup.data_completeness_pct}% of the window has HR samples`);
    if (rollup.average_bpm !== undefined) lines.push(`- **average / max bpm**: ${rollup.average_bpm} / ${rollup.max_bpm}`);
    lines.push("");
    lines.push("| Zone | % HRmax | bpm | Minutes |");
    lines.push("|---|---|---|---|");
    for (const zone of rollup.zones) {
      const pct = zone.max_pct_hrmax === null ? `${zone.min_pct_hrmax}%+` : `${zone.min_pct_hrmax}-${zone.max_pct_hrmax}%`;
      const bpm = zone.max_bpm === null ? `${zone.min_bpm}+` : `${zone.min_bpm}-${zone.max_bpm}`;
      lines.push(`| ${zone.zone} (${zone.label}) | ${pct} | ${bpm} | ${zone.minutes} |`);
    }
    lines.push(`| below zone1 | <${rollup.zones[0]?.min_pct_hrmax ?? 50}% | — | ${rollup.below_zone1_minutes} |`);
    lines.push("");
    for (const note of rollup.notes) lines.push(`> ${note}`);
    if (rollup.notes.length) lines.push("");
  }
  return lines.join("\n");
}
