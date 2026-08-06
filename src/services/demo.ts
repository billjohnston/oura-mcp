import { buildCollectionOutput } from "./collection-output.js";
import { buildWellnessContext } from "./context.js";
import type { OuraClient } from "./oura-client.js";
import { buildDailySummary } from "./summary.js";

/**
 * The synthetic payload behind `oura_demo` and the README quickstart block.
 *
 * The demo exists so an agent can learn the data contract before OAuth. A hand-written
 * sample that nobody compares against the server drifts in silence: the agent writes a
 * parser for fields that never arrive, and the failure surfaces as a confident wrong
 * answer, not an error.
 *
 * So this file does not *describe* the payloads — it *produces* them, by running the same
 * builders a real call runs over a synthetic in-memory Oura API. Only the upstream fixture
 * below is invented; every key an agent sees comes from the real code path.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function day(offset: number): string {
  return new Date(Date.now() - offset * DAY_MS).toISOString().slice(0, 10);
}

/** Synthetic Oura Cloud v2 records. Realistic values, no real person's data. */
function readinessRecords(): Array<Record<string, unknown>> {
  return [
    { id: "demo-readiness-0", day: day(0), score: 78, temperature_deviation: -0.1, contributors: { hrv_balance: 84, resting_heart_rate: 71, sleep_balance: 76 } },
    { id: "demo-readiness-1", day: day(1), score: 74, temperature_deviation: 0.1, contributors: { hrv_balance: 79, resting_heart_rate: 73, sleep_balance: 72 } },
    { id: "demo-readiness-2", day: day(2), score: 69, temperature_deviation: 0.3, contributors: { hrv_balance: 68, resting_heart_rate: 80, sleep_balance: 65 } }
  ];
}

/**
 * Stands in for the Oura Cloud API, returning the same envelope shape the real endpoints
 * return so the builders take their normal path over it.
 */
export function createDemoClient(): Pick<OuraClient, "get"> {
  return {
    async get(path: string): Promise<unknown> {
      if (path.includes("/daily_activity")) {
        return { data: [{ id: "demo-activity-0", day: day(0), score: 86, steps: 9420, active_calories: 412, total_calories: 2410, equivalent_walking_distance: 7180 }] };
      }
      if (path.includes("/daily_readiness")) {
        return { data: [readinessRecords()[0]] };
      }
      if (path.includes("/daily_sleep")) {
        return { data: [{ id: "demo-daily-sleep-0", day: day(0), score: 82 }] };
      }
      if (path.includes("/daily_spo2")) {
        return { data: [{ id: "demo-spo2-0", day: day(0), spo2_percentage: 96.8 }] };
      }
      if (path.includes("/usercollection/sleep")) {
        return { data: [{ id: "demo-sleep-0", day: day(0), total_sleep_duration: 27060, efficiency: 89, average_heart_rate: 54, lowest_heart_rate: 49, average_hrv: 62 }] };
      }
      return { data: [] };
    }
  };
}

export async function buildDemoPayload() {
  const client = createDemoClient();
  const options = { days: 7, timezone: "UTC" };

  const daily_summary = await buildDailySummary(client, options);
  const wellness_context = await buildWellnessContext(client, options);
  const readiness_list = buildCollectionOutput("/usercollection/daily_readiness", "structured", {
    records: readinessRecords(),
    pages_fetched: 1,
    has_more: false,
    truncated: false
  });

  return {
    ok: true as const,
    is_demo: true as const,
    sample: {
      oura_daily_summary: daily_summary,
      oura_wellness_context: wellness_context,
      oura_list_daily_readiness: readiness_list
    },
    notes: [
      "All sample data is synthetic; tagged with is_demo=true.",
      "Payloads are produced by the same builders a real call uses, so the field names match live responses.",
      "Real calls return live data from the Oura Cloud v2 API after OAuth setup."
    ]
  };
}
