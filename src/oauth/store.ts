import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

interface AuthCode {
  codeChallenge: string;
  redirectUri: string;
  clientId: string;
  expiresAt: number;
}

const TOKENS_PATH = process.env.TOKENS_PATH ?? "/data/oauth-tokens.json";

const codes = new Map<string, AuthCode>();
const tokens = new Set<string>(loadTokens());

function loadTokens(): string[] {
  try {
    if (existsSync(TOKENS_PATH)) {
      return JSON.parse(readFileSync(TOKENS_PATH, "utf-8")) as string[];
    }
  } catch {
    // ignore — start fresh
  }
  return [];
}

// Access tokens outlive the process so a container restart does not force every
// connected client back through the consent page.
function persistTokens(): void {
  try {
    mkdirSync(dirname(TOKENS_PATH), { recursive: true, mode: 0o700 });
    writeFileSync(TOKENS_PATH, JSON.stringify(Array.from(tokens)), { mode: 0o600 });
  } catch (err) {
    process.stderr.write(`[store] failed to persist tokens: ${err}\n`);
  }
}

export function createAuthCode(params: Omit<AuthCode, "expiresAt">): string {
  const code = randomBytes(32).toString("hex");
  codes.set(code, { ...params, expiresAt: Date.now() + 5 * 60 * 1000 });
  return code;
}

export function consumeAuthCode(code: string): AuthCode | null {
  const entry = codes.get(code);
  if (!entry) return null;
  codes.delete(code);
  if (Date.now() > entry.expiresAt) return null;
  return entry;
}

export function createAccessToken(): string {
  const token = randomBytes(32).toString("hex");
  tokens.add(token);
  persistTokens();
  return token;
}

export function isValidToken(token: string): boolean {
  return tokens.has(token);
}
