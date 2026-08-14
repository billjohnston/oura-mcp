import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SCOPES, OURA_DEVELOPER_PORTAL_URL } from "../constants.js";
import type { PrivacyMode, OuraConfig } from "../types.js";
import { loadConfigSources } from "./local-config.js";

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

export function getConfig(): OuraConfig {
  const sources = loadConfigSources(process.env, homedir());
  const value = (name: keyof typeof sources.values) => env(name) ?? sources.values[name];
  // Env only, deliberately not a LOCAL_CONFIG_KEY: the PAT is a bearer credential
  // and must never be persisted to ~/.oura-mcp/config.json by `setup`.
  const personalAccessToken = env("OURA_PERSONAL_ACCESS_TOKEN");
  const clientId = value("OURA_CLIENT_ID");
  const clientSecret = value("OURA_CLIENT_SECRET");
  const redirectUri = value("OURA_REDIRECT_URI");
  const tokenPath = value("OURA_TOKEN_PATH") ?? join(homedir(), ".oura-mcp", "tokens.json");
  const cachePath = value("OURA_CACHE_PATH") ?? join(homedir(), ".oura-mcp", "cache.sqlite");
  const scopes = (value("OURA_SCOPES")?.split(/[ ,]+/).filter(Boolean)) ?? DEFAULT_SCOPES;
  const privacyMode = parsePrivacyMode(value("OURA_PRIVACY_MODE"));
  const cacheEnabled = parseBool(value("OURA_CACHE"), false);

  // A personal access token is a complete credential on its own: it is sent as the
  // bearer token verbatim and never expires or refreshes, so the OAuth app triple is
  // not needed. Only demand it when there is no PAT.
  if (!personalAccessToken) {
    const missing = [
      ["OURA_CLIENT_ID", clientId],
      ["OURA_CLIENT_SECRET", clientSecret],
      ["OURA_REDIRECT_URI", redirectUri]
    ].filter(([, value]) => !value).map(([name]) => name);

    if (missing.length > 0) {
      throw new Error(
        `Missing required OURA environment variables: ${missing.join(", ")}. ` +
        `Create an app at ${OURA_DEVELOPER_PORTAL_URL} and set these variables before using Oura tools, ` +
        `or set OURA_PERSONAL_ACCESS_TOKEN instead.`
      );
    }
  }

  return {
    clientId: clientId ?? "",
    clientSecret: clientSecret ?? "",
    redirectUri: redirectUri ?? "",
    personalAccessToken,
    scopes,
    tokenPath,
    privacyMode,
    cacheEnabled,
    cachePath
  };
}

function parsePrivacyMode(value: string | undefined): PrivacyMode {
  if (value === "summary" || value === "structured" || value === "raw") return value;
  return "structured";
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  return ["1", "true", "yes", "on", "sqlite"].includes(value.toLowerCase());
}
