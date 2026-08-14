import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';

const port = String(43000 + Math.floor(Math.random() * 1000));
const secret = 'smoke-test-secret';
const serverUrl = `http://127.0.0.1:${port}`;
const healthCheckAttempts = 100;
const healthCheckDelayMs = 200;
const child = spawn(process.execPath, ['dist/index.js', '--http'], {
  env: {
    ...process.env,
    OURA_MCP_PORT: port,
    OURA_MCP_HOST: '127.0.0.1',
    OAUTH_CLIENT_SECRET: secret,
    SERVER_URL: serverUrl,
    // Keep the token store out of the developer's real ~/.oura-mcp.
    TOKENS_PATH: `/tmp/oura-mcp-smoke-${port}.json`
  },
  stdio: ['ignore', 'ignore', 'pipe']
});

let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

function request(method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${serverUrl}${path}`, { method, headers, timeout: 1000 }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        let data;
        try { data = JSON.parse(text); } catch { data = text; }
        resolve({ statusCode: response.statusCode, headers: response.headers, data });
      });
    });
    req.on('timeout', () => req.destroy(new Error('HTTP request timed out')));
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

try {
  let ok = false;
  for (let i = 0; i < healthCheckAttempts; i += 1) {
    try {
      const { statusCode, data } = await request('GET', '/health');
      assert.equal(statusCode, 200);
      assert.equal(data.ok, true);
      ok = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, healthCheckDelayMs));
    }
  }
  if (!ok) throw new Error(`HTTP server did not become healthy. stderr=${stderr}`);

  // Discovery must stay open, or no client can ever start the flow.
  const asMeta = await request('GET', '/.well-known/oauth-authorization-server');
  assert.equal(asMeta.statusCode, 200);
  assert.equal(asMeta.data.issuer, serverUrl);
  assert.deepEqual(asMeta.data.code_challenge_methods_supported, ['S256']);

  const prMeta = await request('GET', '/.well-known/oauth-protected-resource');
  assert.equal(prMeta.statusCode, 200);
  assert.equal(prMeta.data.resource, serverUrl);

  // The MCP endpoint must reject anonymous and bogus-bearer callers on both mounts,
  // and must advertise where to authenticate.
  const initialize = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  for (const path of ['/mcp', '/']) {
    for (const headers of [{}, { authorization: 'Bearer not-a-real-token' }]) {
      const denied = await request('POST', path, {
        headers: { 'content-type': 'application/json', ...headers },
        body: initialize
      });
      assert.equal(denied.statusCode, 401, `expected 401 for POST ${path}`);
      assert.match(denied.headers['www-authenticate'] ?? '', /resource_metadata=/);
    }
  }

  console.log(JSON.stringify({
    ok: true,
    transport: 'http',
    port: Number(port),
    oauth_discovery: true,
    mcp_requires_bearer: true
  }, null, 2));
} finally {
  child.kill('SIGTERM');
}
