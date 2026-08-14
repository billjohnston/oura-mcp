/**
 * Contract for the heart-rate zone rollup.
 *
 * Every sample here is SYNTHETIC.
 *
 * The two things that make a zone rollup lie:
 *  (a) counting samples instead of weighting them by time. Oura samples roughly every
 *      5 seconds during a workout and every 5 minutes at rest, so a count weights the
 *      dense middle of a session far above its sparse edges.
 *  (b) reporting minutes without reporting coverage. Optical HR drops out constantly
 *      during movement; a rollup built from 40% coverage looks identical to a complete
 *      one and every zone reads low.
 */
import assert from 'node:assert/strict';
import { bucketSamples, rollupWorkoutZones, zoneBands } from '../dist/services/zones.js';

const HRMAX = 190;
const start = Date.parse('2026-08-12T17:00:00.000Z');
const end = start + 20 * 60_000; // a 20 minute workout

/** Samples every `stepSeconds` from `fromMin` to `toMin`, all at one bpm. */
function samples(fromMin, toMin, bpm, stepSeconds = 5) {
  const out = [];
  for (let t = fromMin * 60; t < toMin * 60; t += stepSeconds) out.push({ at: start + t * 1000, bpm });
  return out;
}

// --- bands ------------------------------------------------------------------
const bands = zoneBands(HRMAX);
assert.equal(bands.length, 5);
assert.equal(bands[0].minBpm, 95, 'zone1 starts at 50% of HRmax');
assert.equal(bands[4].minBpm, 171, 'zone5 starts at 90% of HRmax');

// --- time weighting, not sample counting ------------------------------------
// 10 minutes in zone2 sampled every 5s (120 samples) and 10 minutes in zone4 sampled
// every 60s (10 samples). A count-based rollup would call this 92% zone2.
const mixed = [...samples(0, 10, 120, 5), ...samples(10, 20, 165, 60)];
const bucketed = bucketSamples(mixed, HRMAX, start, end);
const byZone = Object.fromEntries(bucketed.zones.map((zone) => [zone.zone, zone.minutes]));

assert.equal(byZone.zone2, 10, `120bpm is 63% of HRmax -> zone2, and must total 10 minutes (got ${byZone.zone2})`);
assert.equal(byZone.zone4, 10, `165bpm is 87% of HRmax -> zone4, and must total 10 minutes (got ${byZone.zone4})`);
assert.ok(
  bucketed.zones.find((z) => z.zone === 'zone2').sample_count > bucketed.zones.find((z) => z.zone === 'zone4').sample_count,
  'the fixture must actually have unequal sample counts, or it is not testing weighting'
);

// --- dropout must not be credited to a zone ---------------------------------
// 5 minutes of samples, then a 15 minute hole. The last sample before a hole may only
// carry its capped gap (5 min), never the whole hole.
const withGap = samples(0, 5, 120, 5);
const gapped = bucketSamples(withGap, HRMAX, start, end);
assert.ok(gapped.measuredSeconds <= 10 * 60, `a 15-minute dropout must not be credited as measured time (got ${gapped.measuredSeconds}s)`);

// --- rollup reports completeness honestly -----------------------------------
const client = {
  async heartrateSamples() {
    return { samples: withGap, pages_fetched: 1, cursor_exhausted: true };
  }
};
const workout = {
  id: 'synthetic-workout',
  day: '2026-08-12',
  activity: 'HIIT',
  start_datetime: new Date(start).toISOString(),
  end_datetime: new Date(end).toISOString()
};

const partial = await rollupWorkoutZones(client, workout, HRMAX, 'provided');
assert.equal(partial.workout.duration_minutes, 20);
assert.ok(partial.data_completeness_pct < 60, `5 minutes of samples in a 20 minute window is not complete (got ${partial.data_completeness_pct}%)`);
assert.ok(
  partial.notes.some((note) => /cover only|floor/i.test(note)),
  'a partially covered window must SAY the minutes are a floor, not just report a number'
);
assert.equal(partial.hrmax.source, 'provided');

// A fully covered window reports ~100% and raises no completeness warning.
const fullClient = { async heartrateSamples() { return { samples: samples(0, 20, 120, 5), pages_fetched: 1, cursor_exhausted: true }; } };
const full = await rollupWorkoutZones(fullClient, workout, HRMAX, 'provided');
assert.ok(full.data_completeness_pct >= 99, `full coverage must report ~100% (got ${full.data_completeness_pct}%)`);
assert.ok(!full.notes.some((note) => /cover only/i.test(note)), 'a complete window must not warn about coverage');
assert.equal(full.total_measured_minutes, 20);
assert.equal(full.average_bpm, 120);
assert.equal(full.max_bpm, 120);

// --- an estimated HRmax must say so -----------------------------------------
const estimated = await rollupWorkoutZones(fullClient, workout, 220 - 41, 'estimated_220_minus_age', 41);
assert.equal(estimated.hrmax.bpm, 179);
assert.ok(
  estimated.notes.some((note) => /220-41/.test(note) && /bpm/.test(note)),
  'an estimated HRmax must be labelled with its error, or zone edges look measured'
);

// --- a workout with no usable window is an error, not a silent zero ---------
await assert.rejects(
  () => rollupWorkoutZones(fullClient, { id: 'broken' }, HRMAX, 'provided'),
  /start_datetime/,
  'a workout without a window must fail loudly'
);

// --- samples outside the window are ignored ---------------------------------
const outside = [
  { at: start - 60_000, bpm: 180 },
  ...samples(0, 20, 120, 5),
  { at: end + 60_000, bpm: 180 }
];
const clipped = bucketSamples(outside, HRMAX, start, end);
assert.equal(clipped.max, 120, 'samples before/after the workout must not enter the rollup');

console.log(JSON.stringify({
  ok: true,
  suite: 'zones',
  weighted_minutes: byZone,
  partial_completeness_pct: partial.data_completeness_pct
}, null, 2));
