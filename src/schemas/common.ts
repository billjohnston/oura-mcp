import { z } from "zod";
import { DEFAULT_LIMIT, DEFAULT_MAX_PAGES, MAX_PAGES, MAX_OURA_LIMIT } from "../constants.js";
import { AGENT_CLIENTS } from "../services/agent-manifest.js";

export const ResponseFormatSchema = z.enum(["markdown", "json"]).default("markdown");
export const AgentClientSchema = z.enum(AGENT_CLIENTS).default("generic");
export const PrivacyModeValueSchema = z.enum(["summary", "structured", "raw"]);
export const PrivacyModeSchema = PrivacyModeValueSchema.optional()
  .describe("Optional per-call privacy override. Defaults to OURA_PRIVACY_MODE or structured. raw returns upstream Oura JSON. summary minimizes sensitive health and profile details.");

export const ExplicitPrivacyIntentSchema = z
  .boolean()
  .optional()
  .describe("Required true when privacy_mode=raw (agent escalation of redaction).");

export const DateTimeSchema = z.string()
  .datetime({ offset: true })
  .optional()
  .describe("ISO 8601 date-time with timezone, e.g. 2026-05-01T00:00:00Z");

/**
 * How to reach the NEWEST record of a domain, which is never what `limit` gives you.
 *
 * This text is per-tool on purpose. It used to live in the shared schema, which meant all
 * nine oura_list_* tools told the agent to read `oura://latest/readiness` — the only
 * latest resource that exists. An agent listing sleep was sent to readiness data, which
 * cannot answer its question.
 */
function recencyRoute(latestResourceUri?: string): string {
  return latestResourceUri === undefined
    ? "This domain has no latest-record shortcut resource (only daily readiness has one), so to reach the newest record here, narrow the window with after/before until the response comes back with truncated=false and has_more=false: records are oldest-first, so the LAST one is then the newest that exists in that window."
    : `To get the most recent record of this domain, read the resource ${latestResourceUri}, which walks the Oura cursor to the end of the window instead of stopping at its oldest block. Narrowing the window with after/before also works.`;
}

/**
 * Collection input for one oura_list_* tool.
 *
 * `latestResourceUri` names the oura://latest/... resource that answers "most recent" for
 * THIS endpoint, when one exists. Everything else is identical across the nine tools.
 */
export function collectionInputSchema(latestResourceUri?: string) {
  return z.object({
    after: DateTimeSchema.describe("Only return Oura records after this time. Converted to an Oura start_date."),
    before: DateTimeSchema.describe("Only return Oura records before this time. Converted to an Oura end_date."),
    next_token: z.string().min(1).max(4096).optional()
      .describe("Opaque Oura v2 cursor from a previous collection response. Pass it back unchanged with the same after/before window to resume. Oura has no integer page index and no page-size parameter; do not invent or increment a page number."),
    limit: z.number().int().min(1).max(MAX_OURA_LIMIT).default(DEFAULT_LIMIT)
      .describe("Maximum number of records to return, taken from the end named by sort."),
    sort: z.enum(["asc", "desc"]).default("desc")
      .describe(`Order of the returned records: desc is newest-first (the default), asc is oldest-first. Oura serves oldest-first behind a cursor, so desc walks the whole window before returning and asc is cheaper on wide windows. ${recencyRoute(latestResourceUri)}`),
    all_pages: z.boolean().default(false)
      .describe("When true, follow the Oura next_token cursor up to max_pages in this one call. Resume later by passing the returned next_token with the same after/before window."),
    max_pages: z.number().int().min(1).max(MAX_PAGES).optional()
      .describe(`Maximum upstream Oura pages to fetch in this call. A runaway guard, not an Oura page index. Left unset it defaults to ${DEFAULT_MAX_PAGES} for ascending reads and ${MAX_PAGES} for descending ones, which must reach the end of the window to know which records are newest.`),
    privacy_mode: PrivacyModeSchema,
    explicit_user_intent: ExplicitPrivacyIntentSchema,
    response_format: ResponseFormatSchema
  }).strict();
}

/** Default shape (no latest resource). Kept for callers that only need the type. */
export const CollectionInputSchema = collectionInputSchema();

export const IdInputSchema = z.object({
  id: z.union([z.string().min(1), z.number().int().positive()]).describe("Oura resource id."),
  privacy_mode: PrivacyModeSchema,
  explicit_user_intent: ExplicitPrivacyIntentSchema,
  response_format: ResponseFormatSchema
}).strict();

export const SimpleReadInputSchema = z.object({
  privacy_mode: PrivacyModeSchema,
  explicit_user_intent: ExplicitPrivacyIntentSchema,
  response_format: ResponseFormatSchema
}).strict();

export const ResponseOnlyInputSchema = z.object({
  response_format: ResponseFormatSchema
}).strict();

export const AgentManifestInputSchema = z.object({
  client: AgentClientSchema,
  response_format: ResponseFormatSchema
}).strict();

export const ConnectionStatusInputSchema = z.object({
  client: AgentClientSchema.optional(),
  response_format: ResponseFormatSchema
}).strict();

export const AuthUrlInputSchema = z.object({
  state: z.string().max(500).optional().describe("Optional OAuth state value generated by the caller."),
  scopes: z.array(z.string()).optional().describe("Optional scope override. Defaults to read-only Oura scopes used by this server."),
  response_format: ResponseFormatSchema
}).strict();

export const ExchangeCodeInputSchema = z.object({
  code: z.string().min(1).describe("OAuth authorization code, or a full redirect URL containing ?code=..."),
  response_format: ResponseFormatSchema
}).strict();

export const DailySummaryInputSchema = z.object({
  days: z.number().int().min(1).max(30).default(7).describe("Lookback window for recent training context."),
  timezone: z.string().min(1).max(80).default("UTC").describe("IANA timezone used only for display, e.g. America/New_York."),
  response_format: ResponseFormatSchema
}).strict();

export const WellnessContextInputSchema = z.object({
  days: z.number().int().min(1).max(30).default(7).describe("Lookback window for normalized Oura wellness context."),
  timezone: z.string().min(1).max(80).default("UTC").describe("IANA timezone used only for display, e.g. America/New_York."),
  soreness: z.array(z.string().min(1).max(80)).default([]),
  injury_flags: z.array(z.string().min(1).max(120)).default([]),
  notes: z.string().max(500).optional(),
  response_format: ResponseFormatSchema
}).strict();

export const WeeklySummaryInputSchema = z.object({
  days: z.number().int().min(7).max(60).default(7).describe("Recent analysis window in days."),
  compare_days: z.number().int().min(0).max(60).default(7).describe("Prior comparison window in days. Use 0 to disable comparison."),
  timezone: z.string().min(1).max(80).default("UTC").describe("IANA timezone used only for display, e.g. America/New_York."),
  response_format: ResponseFormatSchema
}).strict();

export const AuthUrlOutputSchema = z.object({
  auth_url: z.string(),
  redirect_uri: z.string(),
  scopes: z.array(z.string()),
  next_step: z.string()
}).strict();

export const ExchangeCodeOutputSchema = z.object({
  ok: z.boolean(),
  token_path: z.string(),
  scope: z.string().optional(),
  expires_at: z.number().optional(),
  note: z.string()
}).strict();

export const EndpointDataOutputSchema = z.object({
  endpoint: z.string(),
  privacy_mode: PrivacyModeValueSchema,
  data: z.unknown()
}).strict();

export const CollectionOutputSchema = z.object({
  endpoint: z.string(),
  privacy_mode: PrivacyModeValueSchema,
  count: z.number().int().nonnegative(),
  records: z.array(z.unknown()),
  sort: z.enum(["asc", "desc"]).describe("Which end of the window these records came from."),
  next_token: z.string().min(1).optional()
    .describe("Opaque Oura v2 cursor to resume from, for ascending reads only. Pass it back unchanged with the same after/before window; never increment a page number. Omitted when sort is desc (the window was already consumed) or when truncated is true (resuming would skip dropped rows) — raise limit instead."),
  has_more: z.boolean().describe("True when more records exist beyond this response, either upstream or because the limit cap dropped some."),
  truncated: z.boolean().describe("True when the limit cap dropped records that had already been fetched. Raise limit or narrow after/before to see them."),
  pages_fetched: z.number().int().nonnegative(),
  cursor_exhausted: z.boolean().describe("False when the page budget ran out before Oura's cursor did, meaning a desc read may not have reached the true newest record.")
}).strict();

export const CacheStatusOutputSchema = z.object({
  enabled: z.boolean(),
  path: z.string(),
  entries: z.number().int().nonnegative(),
  newest_cached_at: z.string().optional(),
  http_cache: z.object({
    size: z.number().int().nonnegative(),
    hit_count: z.number().int().nonnegative(),
    miss_count: z.number().int().nonnegative(),
    hit_rate: z.number().min(0).max(1),
    default_ttl_seconds: z.number().int().nonnegative(),
    bypass_env_var: z.string()
  }).strict().optional()
}).strict();

export const RevokeAccessOutputSchema = z.object({
  ok: z.boolean(),
  token_path: z.string(),
  local_tokens_cleared: z.boolean(),
  note: z.string()
}).strict();

export const PrivacyAuditOutputSchema = z.object({
  project: z.string(),
  unofficial: z.boolean(),
  config_source: z.enum(["env", "local_config", "mixed", "missing"]),
  local_config_path: z.string(),
  local_config_exists: z.boolean(),
  local_config_secure_permissions: z.boolean().optional(),
  privacy_mode_default: PrivacyModeValueSchema,
  raw_payloads_opt_in: z.boolean(),
  gps_redaction_default: z.boolean(),
  cache_enabled: z.boolean(),
  cache_path: z.string(),
  token_path: z.string(),
  stdout_safe: z.boolean(),
  secret_env_vars: z.array(z.string()),
  required_env_present: z.record(z.string(), z.boolean()),
  redacted_key_patterns: z.array(z.string()),
  notes: z.array(z.string())
}).strict();

export const CapabilitiesOutputSchema = z.object({
  project: z.string(),
  mcp_name: z.string(),
  creator: z.object({ name: z.string(), github: z.string() }).strict(),
  unofficial: z.boolean(),
  api_boundary: z.object({ source: z.string(), raw_definition: z.string(), does_not_include: z.array(z.string()) }).strict(),
  auth_model: z.object({ type: z.string(), token_storage: z.string(), recommended_redirect_uri: z.string(), default_scopes: z.array(z.string()) }).strict(),
  privacy_modes: z.array(z.object({ mode: PrivacyModeValueSchema, use_when: z.string() }).strict()),
  supported_data: z.array(z.object({ name: z.string(), examples: z.array(z.string()), tools: z.array(z.string()) }).strict()),
  recommended_agent_flow: z.array(z.string()),
  client_aliases: z.object({
    hermes: z.object({
      tool_prefix: z.string(),
      direct_tools: z.array(z.string()),
      reload_command: z.string(),
      gateway_restart_required_for_data_access: z.boolean()
    }).strict()
  }).strict(),
  contribution_paths: z.array(z.string()),
  links: z.record(z.string(), z.string())
}).passthrough();

export const AgentManifestOutputSchema = z.object({
  project: z.string(),
  mcp_name: z.string(),
  client: AgentClientSchema,
  unofficial: z.boolean(),
  package: z.object({
    name: z.string(),
    version: z.string(),
    install_command: z.string(),
    pinned_install_command: z.string(),
    binary: z.string()
  }).strict(),
  oauth: z.object({
    provider: z.string(),
    redirect_uri: z.string(),
    scopes: z.array(z.string()),
    token_storage: z.string(),
    secret_storage: z.string()
  }).strict(),
  recommended_first_calls: z.array(z.string()),
  standard_tools: z.array(z.string()),
  resources: z.array(z.string()),
  hermes: z.object({
    config_path: z.string(),
    skill_path: z.string(),
    tool_name_prefix: z.string(),
    common_tool_names: z.array(z.string()),
    recommended_config: z.string(),
    use_direct_tools: z.boolean(),
    avoid_terminal_workarounds: z.boolean(),
    no_gateway_restart_for_data_access: z.boolean(),
    reload_after_config_change: z.string(),
    doctor_command: z.string()
  }).strict(),
  agent_rules: z.array(z.string()),
  troubleshooting: z.array(z.object({ symptom: z.string(), action: z.string() }).strict()),
  links: z.record(z.string(), z.string())
}).strict();

export const ConnectionStatusOutputSchema = z.object({
  ok: z.boolean(),
  ready_for_oura_api: z.boolean(),
  client: AgentClientSchema.optional(),
  node: z.object({ version: z.string(), supported: z.boolean() }).strict(),
  privacy_mode: PrivacyModeValueSchema,
  auth_mode: z.enum(["pat", "oauth"]),
  required_env: z.record(z.string(), z.boolean()),
  missing_env: z.array(z.string()),
  redirect_uri: z.string().optional(),
  automatic_auth_supported: z.boolean(),
  config: z.object({ source: z.enum(["env", "local_config", "mixed", "missing"]), path: z.string(), exists: z.boolean(), secure_permissions: z.boolean().optional(), error: z.string().optional() }).strict(),
  token: z.object({ path: z.string(), exists: z.boolean(), readable: z.boolean(), permissions: z.string().optional(), secure_permissions: z.boolean().optional(), expires_at: z.number().optional(), expired: z.boolean().optional(), has_refresh_token: z.boolean().optional(), scope: z.string().optional(), error: z.string().optional() }).strict(),
  oauth: z.object({
    recommended_scopes: z.array(z.string()),
    granted_scopes: z.array(z.string()),
    missing_recommended_scopes: z.array(z.string()),
    scope_status: z.enum(["ok", "missing_recommended", "unknown", "missing_token"]),
    activity_tools_ready: z.boolean(),
    profile_tools_ready: z.boolean()
  }).strict(),
  cache: z.object({ enabled: z.boolean(), path: z.string() }).strict(),
  client_checks: z.object({
    hermes: z.object({
      config_path: z.string(),
      config_exists: z.boolean(),
      oura_server_configured: z.boolean(),
      package_pinned: z.boolean(),
      mcp_reload_confirmation_disabled: z.boolean().optional(),
      skill_path: z.string(),
      skill_installed: z.boolean(),
      direct_tool_prefix: z.string(),
      expected_direct_tools: z.array(z.string()),
      recommendations: z.array(z.string()),
      error: z.string().optional()
    }).strict().optional()
  }).strict().optional(),
  next_steps: z.array(z.string())
}).strict();


export const DataInventoryOutputSchema = z.object({
  kind: z.literal("data_inventory"),
  source: z.string(),
  mcp_name: z.string(),
  generated_at: z.string(),
  unofficial: z.boolean(),
  data_access_model: z.string(),
  auth: z.unknown().optional(),
  scopes: z.array(z.string()),
  api_boundary: z.unknown().optional(),
  privacy_modes: z.array(z.unknown()),
  categories: z.array(z.object({
    name: z.string(),
    examples: z.array(z.string()),
    tools: z.array(z.string())
  }).strict()),
  totals: z.object({
    categories: z.number().int().nonnegative(),
    listed_tools: z.number().int().nonnegative(),
    scopes: z.number().int().nonnegative()
  }).strict(),
  first_tools: z.array(z.string()),
  recommended_agent_flow: z.array(z.string()),
  links: z.record(z.string(), z.string()),
  notes: z.array(z.string())
}).strict();

export const WorkoutZonesInputSchema = z.object({
  workout_id: z.string().min(1).optional()
    .describe("Roll up a single workout by its Oura document id, as returned by oura_list_workouts."),
  after: DateTimeSchema.describe("Start of a date range to roll up every workout in. Ignored when workout_id is given."),
  before: DateTimeSchema.describe("End of a date range to roll up every workout in, inclusive. Ignored when workout_id is given."),
  hrmax: z.number().int().min(100).max(230).optional()
    .describe("Measured maximum heart rate in bpm. Strongly preferred: without it zones are derived from 220-age, which carries roughly +/-10-12 bpm of individual error."),
  max_workouts: z.number().int().min(1).max(20).default(5)
    .describe("Cap on how many workouts to roll up when using a date range. Each one costs at least one heart-rate request."),
  response_format: ResponseFormatSchema
}).strict();

export const ZoneBucketSchema = z.object({
  zone: z.string(),
  label: z.string(),
  min_pct_hrmax: z.number(),
  max_pct_hrmax: z.number().nullable(),
  min_bpm: z.number(),
  max_bpm: z.number().nullable(),
  minutes: z.number(),
  sample_count: z.number().int().nonnegative()
}).strict();

export const WorkoutZonesOutputSchema = z.object({
  kind: z.literal("workout_zones"),
  generated_at: z.string(),
  workouts_analyzed: z.number().int().nonnegative(),
  rollups: z.array(z.object({
    workout: z.object({
      id: z.string().optional(),
      day: z.string().optional(),
      activity: z.string().optional(),
      intensity: z.string().optional(),
      start_datetime: z.string().optional(),
      end_datetime: z.string().optional(),
      duration_minutes: z.number().optional()
    }).strict(),
    hrmax: z.object({
      bpm: z.number(),
      source: z.enum(["provided", "estimated_220_minus_age"]),
      age: z.number().optional()
    }).strict(),
    zones: z.array(ZoneBucketSchema),
    below_zone1_minutes: z.number(),
    total_measured_minutes: z.number(),
    data_completeness_pct: z.number()
      .describe("Share of the workout window covered by heart-rate samples, 0-100. Below ~80% the zone minutes are a floor, not a total."),
    sample_count: z.number().int().nonnegative(),
    average_bpm: z.number().optional(),
    max_bpm: z.number().optional(),
    cursor_exhausted: z.boolean(),
    notes: z.array(z.string())
  }).strict()),
  safety: z.object({ medical_advice: z.boolean() }).strict()
}).strict();

export const SummaryOutputSchema = z.object({
  kind: z.enum(["daily_summary", "weekly_summary"]),
  generated_at: z.string()
}).passthrough();

export const WellnessContextOutputSchema = z.object({
  source: z.literal("oura"),
  generated_at: z.string(),
  recent_training_load: z.enum(["low", "normal", "high", "unknown"]),
  soreness: z.array(z.string()),
  injury_flags: z.array(z.string()),
  notes: z.array(z.string())
}).passthrough();

export type CollectionInput = z.infer<typeof CollectionInputSchema>;
export type IdInput = z.infer<typeof IdInputSchema>;
export type SimpleReadInput = z.infer<typeof SimpleReadInputSchema>;
export type ResponseOnlyInput = z.infer<typeof ResponseOnlyInputSchema>;
export type AgentManifestInput = z.infer<typeof AgentManifestInputSchema>;
export type AuthUrlInput = z.infer<typeof AuthUrlInputSchema>;
export type ExchangeCodeInput = z.infer<typeof ExchangeCodeInputSchema>;
export type DailySummaryInput = z.infer<typeof DailySummaryInputSchema>;
export type WellnessContextInput = z.infer<typeof WellnessContextInputSchema>;
export type WeeklySummaryInput = z.infer<typeof WeeklySummaryInputSchema>;
