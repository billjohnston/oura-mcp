/**
 * Regression gate for the Oura date-window semantics behind total_steps=0 and
 * days_with_hrv=0.
 *
 * Every record here is SYNTHETIC.
 *
 * Oura does not treat `end_date` consistently. Verified against the live API:
 *
 *   start_date == end_date            records
 *   daily_readiness / daily_sleep / daily_spo2   1     (inclusive)
 *   daily_activity / sleep / workout / session   0     (EXCLUSIVE)
 *
 * The per-day aggregator asked every endpoint the same way, so activity and sleep came
 * back empty on every single day. The visible result was a weekly scorecard reporting
 * total_steps: 0 and days_with_hrv: 0 against a week of real data, with confidence
 * "high" — the aggregator counted days it had, not days it could read.
 *
 * Also pins main-sleep selection: Oura returns every sleep period for a day, and a
 * 30-second `type: "sleep"` blip sorts ahead of the real `long_sleep`. Taking data[0]
 * reported a half-minute night with no HRV.
 */
import assert from 'node:assert/strict';
import { buildWeeklySummary, buildDailySummary } from '../dist/services/summary.js';

const DAY_MS = 86_400_000;
const day = (offset) => new Date(Date.now() - offset * DAY_MS).toISOString().slice(0, 10);

/** A fake that reproduces Oura's real end_date behaviour per endpoint. */
function makeClient({ napOnDay } = {}) {
  const requests = [];
  const exclusive = ['/usercollection/daily_activity', '/usercollection/sleep'];

  return {
    requests,
    async get(endpoint, params = {}) {
      requests.push({ endpoint, ...params });
      const { start_date: start, end_date: end } = params;
      const isExclusive = exclusive.some((path) => endpoint.startsWith(path));
      // The behaviour under test: an exclusive endpoint serves nothing when the window
      // has no width, which is exactly what start_date == end_date produces.
      const days = [];
      for (let offset = 0; offset < 8; offset += 1) {
        const candidate = day(offset);
        if (candidate < start) continue;
        if (isExclusive ? candidate >= end : candidate > end) continue;
        days.push(candidate);
      }
      if (!days.length) return { data: [] };

      if (endpoint.startsWith('/usercollection/daily_activity')) {
        return { data: days.map((d) => ({ day: d, score: 80, steps: 10_000, active_calories: 500, total_calories: 2400 })) };
      }
      if (endpoint.startsWith('/usercollection/sleep')) {
        return {
          data: days.flatMap((d) => {
            const main = { day: d, type: 'long_sleep', total_sleep_duration: 25_200, efficiency: 90, average_hrv: 48, lowest_heart_rate: 52 };
            // A nap sorts FIRST, exactly as Oura returns it.
            return d === napOnDay ? [{ day: d, type: 'sleep', total_sleep_duration: 30 }, main] : [main];
          })
        };
      }
      if (endpoint.startsWith('/usercollection/daily_sleep')) return { data: days.map((d) => ({ day: d, score: 85 })) };
      if (endpoint.startsWith('/usercollection/daily_readiness')) return { data: days.map((d) => ({ day: d, score: 82, temperature_deviation: 0.1 })) };
      if (endpoint.startsWith('/usercollection/daily_spo2')) return { data: days.map((d) => ({ day: d, spo2_percentage: 97 })) };
      throw new Error(`unexpected endpoint ${endpoint}`);
    }
  };
}

// --- the two reported bugs -------------------------------------------------
const weekly = await buildWeeklySummary(makeClient(), { days: 7, compare_days: 0, timezone: 'UTC' });
const current = weekly.scorecard.current;

assert.ok(current.total_steps > 0, `total_steps must not be 0 against a week of activity records (got ${current.total_steps})`);
assert.equal(current.total_steps, 70_000, '7 days x 10,000 steps');
assert.equal(current.avg_steps, 10_000);
assert.equal(current.days_with_hrv, 7, `days_with_hrv must not be 0 when every night has average_hrv (got ${current.days_with_hrv})`);
assert.equal(current.avg_hrv_rmssd, 48);
assert.equal(current.avg_sleep_hours, 7);

// --- the widened window must not bleed into the next day -------------------
const daily = await buildDailySummary(makeClient(), { days: 1, timezone: 'UTC' });
assert.equal(daily.scorecard.steps, 10_000, 'a widened window must still report ONE day of steps, not two');
assert.equal(daily.scorecard.date, day(0));

// --- naps must not shadow the main sleep -----------------------------------
const napped = await buildDailySummary(makeClient({ napOnDay: day(0) }), { days: 1, timezone: 'UTC' });
assert.equal(napped.scorecard.sleep_minutes, 420, 'a 30-second nap sorted first must not become "last night"');
assert.equal(napped.scorecard.hrv_rmssd, 48, 'HRV must come from the main sleep period, not the nap');

// --- threshold claims must carry their value -------------------------------
const findings = weekly.diagnostic.findings;
assert.ok(Array.isArray(findings) && findings.length, 'weekly diagnostics must expose structured findings');
for (const finding of findings) {
  assert.equal(typeof finding.message, 'string');
  if (finding.threshold === undefined) continue;
  assert.equal(typeof finding.value, 'number', `finding ${finding.code} asserts a threshold and must emit its value`);
  assert.equal(typeof finding.metric, 'string', `finding ${finding.code} must name the metric it measured`);
  assert.ok(
    finding.message.includes(String(finding.value)),
    `finding ${finding.code} says "${finding.message}" but never states the observed value ${finding.value}`
  );
}

// A low-sleep week must produce the 6.5h finding WITH the number behind it.
const lowSleep = {
  async get(endpoint, params) {
    const base = await makeClient().get(endpoint, params);
    if (!endpoint.startsWith('/usercollection/sleep')) return base;
    return { data: base.data.map((row) => ({ ...row, total_sleep_duration: 20_000 })) };
  }
};
const lowWeekly = await buildWeeklySummary(lowSleep, { days: 7, compare_days: 0, timezone: 'UTC' });
const sleepFinding = lowWeekly.diagnostic.findings.find((f) => f.code === 'avg_sleep_low');
assert.ok(sleepFinding, 'a 5.6h week must raise the below-6.5h finding');
assert.equal(sleepFinding.threshold, 6.5);
assert.equal(sleepFinding.metric, 'avg_sleep_hours');
assert.equal(sleepFinding.value, lowWeekly.scorecard.current.avg_sleep_hours);
// 20000s -> 333 whole minutes -> 5.55h, so the message must say 5.55, not the threshold.
assert.match(sleepFinding.message, /5\.55/, 'the message must state the observed average, not just the threshold');

console.log(JSON.stringify({
  ok: true,
  suite: 'summary-window',
  total_steps: current.total_steps,
  days_with_hrv: current.days_with_hrv,
  findings: findings.length
}, null, 2));
