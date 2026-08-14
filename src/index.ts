#!/usr/bin/env node
import cors from "cors";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { runCliCommand } from "./cli/commands.js";
import { registerOuraPrompts } from "./prompts/oura-prompts.js";
import { registerOuraResources } from "./resources/oura-resources.js";
import { registerOuraTools } from "./tools/oura-tools.js";
import { createOAuthRouter } from "./oauth/routes.js";
import { requireBearerToken } from "./oauth/middleware.js";

function createServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION
  });

  registerOuraTools(server);
  registerOuraResources(server);
  registerOuraPrompts(server);
  return server;
}

async function runStdio(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function runHttp(): Promise<void> {
  const app = express();
  const host = process.env.OURA_MCP_HOST ?? "127.0.0.1";
  const port = Number(process.env.OURA_MCP_PORT ?? process.env.PORT ?? 3000);
  // The OAuth issuer identity. It MUST equal the URL clients reach this server on,
  // or discovery and the redirect back from the consent page break.
  const serverUrl = (process.env.SERVER_URL ?? `http://${host}:${port}`).replace(/\/$/, "");
  // Default to the public URL rather than the bind address: with OURA_MCP_HOST=0.0.0.0
  // the old default produced the meaningless origin "http://0.0.0.0:3000".
  const allowedOrigin = process.env.OURA_MCP_ALLOWED_ORIGIN ?? serverUrl;
  const authDisabled = process.env.OURA_MCP_NO_AUTH === "true";

  // Refuse to serve an unauthenticated /mcp by accident: this transport is meant to
  // be reachable from the internet, and the tools read personal health data.
  if (!authDisabled && !process.env.OAUTH_CLIENT_SECRET) {
    console.error(
      "FATAL: OAUTH_CLIENT_SECRET is required for the HTTP transport. " +
      "Set it, or set OURA_MCP_NO_AUTH=true to run without auth on a trusted loopback."
    );
    process.exit(1);
  }

  app.use(express.json({ limit: "1mb" }));
  // The consent form and the RFC 6749 token endpoint both post form-encoded bodies.
  app.use(express.urlencoded({ extended: true, limit: "1mb" }));
  app.use(cors({ origin: allowedOrigin }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, name: SERVER_NAME, version: SERVER_VERSION });
  });

  // Discovery, consent and token endpoints — deliberately unauthenticated, since
  // they are how a client obtains a token in the first place.
  if (!authDisabled) app.use(createOAuthRouter(serverUrl));

  const gate = authDisabled
    ? ((_req: express.Request, _res: express.Response, next: express.NextFunction) => next())
    : requireBearerToken(serverUrl);

  // claude.ai posts to the resource URL root; the Claude Code CLI posts to /mcp.
  app.post(["/", "/mcp"], gate, async (req, res) => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });

    res.on("close", () => {
      transport.close().catch(() => undefined);
      server.close().catch(() => undefined);
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("MCP HTTP request failed:", error);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });

  const server = app.listen(port, host, () => {
    console.error(`${SERVER_NAME} HTTP transport listening on http://${host}:${port}/mcp`);
    console.error(`Server URL: ${serverUrl}`);
    console.error(`Auth: ${authDisabled ? "DISABLED (OURA_MCP_NO_AUTH=true)" : "OAuth 2.1 bearer required on /mcp"}`);
    console.error(`Oura auth mode: ${process.env.OURA_PERSONAL_ACCESS_TOKEN ? "personal access token" : "OAuth app"}`);
  });

  // Without this, `systemctl stop` / `podman stop` waits out the full kill timeout.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      console.error(`Received ${signal}, shutting down.`);
      server.close(() => process.exit(0));
      // Fall back to a hard exit if connections refuse to drain.
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }
}

const args = new Set(process.argv.slice(2));
let cliResult: number | undefined;

try {
  cliResult = await runCliCommand(process.argv.slice(2));
} catch (error) {
  console.error(`Error: ${(error as Error).message}`);
  process.exitCode = 1;
}

if (cliResult !== undefined) {
  process.exitCode = cliResult;
} else if (process.exitCode === undefined) {
  const transport = process.env.OURA_MCP_TRANSPORT ?? (args.has("--http") ? "http" : "stdio");

  if (transport === "http") {
    await runHttp();
  } else {
    await runStdio();
  }
}
