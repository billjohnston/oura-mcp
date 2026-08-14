import { Router } from "express";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createAuthCode, consumeAuthCode, createAccessToken } from "./store.js";

// Constant-time compare that does not leak length via early return.
function secretMatches(provided: string | undefined, expected: string | undefined): boolean {
  if (!provided || !expected) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

// The consent page is rendered twice (initial GET, and again on a wrong secret),
// so it lives in one place.
function approvalPage(params: string, error?: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Oura MCP — Authorize</title>
  <style>
    body { font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
    .card { background: white; padding: 2rem; border-radius: 12px; box-shadow: 0 2px 16px rgba(0,0,0,0.1); max-width: 380px; width: 100%; }
    h1 { font-size: 1.2rem; margin: 0 0 0.5rem; }
    p { color: #666; font-size: 0.9rem; margin: 0 0 1.5rem; }
    input { width: 100%; padding: 0.6rem 0.75rem; border: 1px solid #ddd; border-radius: 6px; font-size: 1rem; box-sizing: border-box; margin-bottom: 1rem; }
    button { width: 100%; padding: 0.7rem; background: #1071d3; color: white; border: none; border-radius: 6px; font-size: 1rem; cursor: pointer; }
    button:hover { background: #0c5cab; }
    .error { color: #d32f2f; font-size: 0.85rem; margin-bottom: 1rem; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Oura MCP</h1>
    <p>Enter the server secret to authorize access to your Oura data.</p>
    ${error ? `<div class="error">${error}</div>` : ""}
    <form method="POST" action="/oauth/approve?${params}">
      <input type="password" name="secret" placeholder="Server secret" autofocus required>
      <button type="submit">Authorize</button>
    </form>
  </div>
</body>
</html>`;
}

export function createOAuthRouter(serverUrl: string): Router {
  const router = Router();

  // RFC 9728: protected resource metadata — tells clients where to find the auth server
  router.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json({
      resource: serverUrl,
      authorization_servers: [serverUrl]
    });
  });

  // RFC 8414: authorization server metadata
  router.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json({
      issuer: serverUrl,
      authorization_endpoint: `${serverUrl}/oauth/authorize`,
      token_endpoint: `${serverUrl}/oauth/token`,
      registration_endpoint: `${serverUrl}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"]
    });
  });

  // RFC 7591: dynamic client registration — issues a client_id and returns the
  // pre-shared client_secret so claude.ai can complete the flow without manual config.
  router.post("/oauth/register", (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    // Stable client_id derived from the secret so it survives container restarts:
    // claude.ai re-registers on reconnect and needs the same client_id back.
    const stableClientId = createHmac("sha256", process.env.OAUTH_CLIENT_SECRET ?? "")
      .update("client_id")
      .digest("hex")
      .slice(0, 32);
    res.status(201).json({
      client_id: stableClientId,
      client_secret: process.env.OAUTH_CLIENT_SECRET,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      token_endpoint_auth_method: "client_secret_post",
      grant_types: body.grant_types ?? ["authorization_code"],
      response_types: body.response_types ?? ["code"],
      redirect_uris: body.redirect_uris ?? [],
      client_name: body.client_name ?? "client"
    });
  });

  // Authorization endpoint — shows a password prompt to gate access.
  // Security: only someone who knows OAUTH_CLIENT_SECRET can approve the flow.
  router.get("/oauth/authorize", (req, res) => {
    const { redirect_uri, code_challenge, code_challenge_method, response_type } = req.query;

    if (response_type !== "code") {
      res.status(400).json({ error: "unsupported_response_type" });
      return;
    }
    if (!redirect_uri || typeof redirect_uri !== "string") {
      res.status(400).json({ error: "invalid_request", error_description: "redirect_uri required" });
      return;
    }
    if (!code_challenge || typeof code_challenge !== "string") {
      res.status(400).json({ error: "invalid_request", error_description: "code_challenge required" });
      return;
    }
    if (code_challenge_method !== "S256") {
      res.status(400).json({ error: "invalid_request", error_description: "code_challenge_method must be S256" });
      return;
    }

    const params = new URLSearchParams(req.query as Record<string, string>).toString();
    res.status(200).send(approvalPage(params));
  });

  // Approval POST — validates the secret and issues an auth code.
  router.post("/oauth/approve", (req, res) => {
    const { redirect_uri, code_challenge, response_type, client_id, state } = req.query;
    const { secret } = (req.body ?? {}) as Record<string, string>;

    if (response_type !== "code" || typeof redirect_uri !== "string" || typeof code_challenge !== "string") {
      res.status(400).json({ error: "invalid_request" });
      return;
    }

    if (!secretMatches(secret, process.env.OAUTH_CLIENT_SECRET)) {
      const params = new URLSearchParams(req.query as Record<string, string>).toString();
      res.status(401).send(approvalPage(params, "Incorrect secret. Try again."));
      return;
    }

    const code = createAuthCode({
      clientId: (client_id as string | undefined) ?? "",
      redirectUri: redirect_uri,
      codeChallenge: code_challenge
    });

    const redirectUrl = new URL(redirect_uri);
    redirectUrl.searchParams.set("code", code);
    if (state && typeof state === "string") redirectUrl.searchParams.set("state", state);
    res.redirect(redirectUrl.toString());
  });

  // Token endpoint — validates client_secret + PKCE before issuing an access token.
  router.post("/oauth/token", (req, res) => {
    const { grant_type, code, redirect_uri, client_secret, code_verifier } = (req.body ?? {}) as Record<string, string>;

    if (grant_type !== "authorization_code") {
      res.status(400).json({ error: "unsupported_grant_type" });
      return;
    }

    // If the client sends a secret, validate it (CLI flow). Public clients
    // (the claude.ai browser flow) send none — PKCE is their credential.
    if (client_secret && !secretMatches(client_secret, process.env.OAUTH_CLIENT_SECRET)) {
      res.status(401).json({ error: "invalid_client" });
      return;
    }

    if (!code || !code_verifier) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }

    const authCode = consumeAuthCode(code);
    if (!authCode) {
      res.status(400).json({ error: "invalid_grant", error_description: "code invalid or expired" });
      return;
    }

    if (redirect_uri && authCode.redirectUri !== redirect_uri) {
      res.status(400).json({ error: "invalid_grant", error_description: "redirect_uri mismatch" });
      return;
    }

    // Verify PKCE: base64url(SHA256(code_verifier)) must equal the code_challenge.
    const computed = createHash("sha256").update(code_verifier).digest("base64url");
    if (computed !== authCode.codeChallenge) {
      res.status(400).json({ error: "invalid_grant", error_description: "code_verifier mismatch" });
      return;
    }

    res.json({ access_token: createAccessToken(), token_type: "Bearer", expires_in: 86400 });
  });

  return router;
}
