'use strict';

// Minimal DX Gateway MCP client for Brew — the generic tool-caller only.
//
// Ported from Genie's gcal.js (just the loopback JSON-RPC client, not the
// calendar/Gmail helpers). Brew uses it for exactly one thing: reading the
// access allowlist Sheet via the authenticated `google_workspace` server's
// `read_sheet_values` tool. See access.js.
//
// Brew does NOT run its own Google OAuth. The user's machine already runs the
// DX MCP Gateway (devbar's `mcpgw` plugin) — a loopback proxy already
// authenticated to Google Workspace. We talk to it over http://127.0.0.1:<port>
// with JSON-RPC / Streamable-HTTP. The proxy handles upstream auth itself, so
// no Authorization header is needed. Responses may be plain JSON or SSE-framed.

const http = require('http');
const { GCAL } = require('./access-config');
const dxgw = require('./dxgw');

// The proxy port is assigned dynamically by devbar. Discover it once from
// devbar's log (see dxgw.js) and cache it; resetSession() clears the cache in
// case the proxy restarts on a new port.
let cachedPort = null;
function resolvePort() {
  if (cachedPort != null) return cachedPort;
  cachedPort = dxgw.discoverPort();
  return cachedPort;
}

function gatewayUrl() {
  const port = resolvePort();
  const path = GCAL.proxyPathTemplate.replace('{server}', GCAL.serverName);
  return { origin: `http://127.0.0.1:${port}`, path };
}

let sessionId = null;
let initialized = false;
let rpcId = 0;

function nextId() {
  return ++rpcId;
}

// POST one JSON-RPC message and return the parsed response body.
function postRpc(body, { expectResponse = true } = {}) {
  const { origin, path } = gatewayUrl();
  const url = new URL(origin);
  const payload = JSON.stringify(body);
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'Content-Length': Buffer.byteLength(payload),
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path,
        method: 'POST',
        headers,
      },
      (res) => {
        // Capture a session id handed back on initialize.
        const sid = res.headers['mcp-session-id'];
        if (sid) sessionId = Array.isArray(sid) ? sid[0] : sid;

        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (!expectResponse) return resolve(null);
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(
              new Error(`DX Gateway HTTP ${res.statusCode}: ${data.slice(0, 300)}`)
            );
          }
          resolve(parseRpcBody(data));
        });
      }
    );
    req.on('error', (e) =>
      reject(
        new Error(
          `Cannot reach the DX Gateway (${e.code || e.message}). ` +
            'Make sure Suite Manager / DevBar is running.'
        )
      )
    );
    // The loopback gateway can accept the socket but stall if its upstream
    // hangs. Bound the whole call so boot isn't blocked indefinitely.
    req.setTimeout(30_000, () => {
      req.destroy(new Error('DX Gateway timed out — no response.'));
    });
    req.write(payload);
    req.end();
  });
}

// Body is either JSON or an SSE stream of `data:` lines; return the JSON-RPC msg.
function parseRpcBody(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return JSON.parse(trimmed);
  }
  let last = null;
  for (const line of trimmed.split('\n')) {
    const l = line.trim();
    if (l.startsWith('data:')) {
      const p = l.slice(5).trim();
      if (p && p !== '[DONE]') {
        try {
          last = JSON.parse(p);
        } catch {
          /* keep-alive / partial */
        }
      }
    }
  }
  return last;
}

async function ensureInitialized() {
  if (initialized) return;
  const res = await postRpc({
    jsonrpc: '2.0',
    id: nextId(),
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'Brew', version: '1.0.0' },
    },
  });
  if (res && res.error) {
    throw new Error(`DX Gateway init failed: ${res.error.message || 'unknown error'}`);
  }
  // Best-effort initialized notification (no response expected).
  try {
    await postRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, { expectResponse: false });
  } catch {
    /* non-fatal */
  }
  initialized = true;
}

// Call a gateway tool and return its raw text content.
async function callTool(name, args = {}) {
  await ensureInitialized();
  const res = await postRpc({
    jsonrpc: '2.0',
    id: nextId(),
    method: 'tools/call',
    params: { name, arguments: args },
  });
  if (res && res.error) {
    throw new Error(res.error.message || `Gateway tool ${name} failed.`);
  }
  const result = res && res.result;
  if (!result) throw new Error(`Gateway tool ${name} returned nothing.`);

  const text = ((result.content || []).find((c) => c.type === 'text') || {}).text || '';

  // The upstream Google provider surfaces auth problems as an isError result
  // whose text starts with PROVIDER_AUTH_REQUIRED. Translate for the UI.
  if (result.isError || /PROVIDER_AUTH_REQUIRED|MANUAL_AUTH_REQUIRED/.test(text)) {
    throw new Error(
      'Google Workspace is not connected. Open Suite Manager and connect ' +
        '“Google Workspace”, then try again.'
    );
  }
  return text;
}

function resetSession() {
  sessionId = null;
  initialized = false;
  cachedPort = null;
}

module.exports = { callTool, resetSession };
