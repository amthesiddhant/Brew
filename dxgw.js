'use strict';

// DX MCP Gateway (devbar `mcpgw` plugin) discovery + liveness.
// Ported verbatim from Genie — the gateway is machine-wide, so the same
// discovery works for Brew.
//
// devbar's mcpgw plugin runs a loopback "hostproxy". Its port used to be
// readable via `devbar mcpgw status --json`, but that CLI command was REMOVED
// (mcpgw became a plugin, and the devbar CLI daemon is unresponsive whenever
// the menubar GUI owns the daemon — so shelling out is unreliable anyway).
// We discover the port two ways instead, newest-wins then fallback:
//
//   1. Parse the newest port from devbar's own log. Two shapes appear:
//        msg="hostproxy: HTTP server started" addr=127.0.0.1:13316
//        msg="Host proxy started" port=13316
//   2. Fall back to the well-known default (GCAL.fallbackPort, 13316).
//
// Liveness is confirmed by POSTing a JSON-RPC `initialize` to the gateway —
// that returns HTTP 200 in a fraction of a second.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { GCAL } = require('./access-config');

const DEVBAR_LOG = path.join(os.homedir(), '.devbar', 'logs', 'devbar.log');

// Read the last `maxBytes` of a (possibly large, growing) file synchronously,
// without pulling the whole thing into memory. Returns '' on any error.
function readTail(file, maxBytes = 65536) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const { size } = fs.fstatSync(fd);
    const start = size > maxBytes ? size - maxBytes : 0;
    const len = size - start;
    if (len <= 0) return '';
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

// Discover the gateway port from devbar's log (newest match wins), falling back
// to the well-known default. Cheap and synchronous. Never throws.
function discoverPort() {
  const tail = readTail(DEVBAR_LOG);
  if (tail) {
    // Match both `addr=127.0.0.1:PORT` and `port=PORT`; keep the LAST one seen.
    const re = /(?:addr=127\.0\.0\.1:|port=)(\d{2,5})\b/g;
    let m;
    let last = null;
    while ((m = re.exec(tail)) !== null) last = Number(m[1]);
    if (Number.isInteger(last) && last > 0 && last < 65536) return last;
  }
  return GCAL.fallbackPort;
}

// POST a JSON-RPC `initialize` and resolve true iff the gateway answers 2xx.
// A fast, accurate "is the gateway up + Google-authenticated" signal. Never
// rejects — resolves false on any error/timeout.
function probe(port, timeoutMs = 8_000) {
  return new Promise((resolve) => {
    const serverPath = GCAL.proxyPathTemplate.replace('{server}', GCAL.serverName);
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'Brew-preflight', version: '1' },
      },
    });
    let settled = false;
    const finish = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: serverPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        // We only care that it answered 2xx; drain and discard the body.
        res.on('data', () => {});
        res.on('end', () => finish(res.statusCode >= 200 && res.statusCode < 300));
      }
    );
    req.on('error', () => finish(false));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      finish(false);
    });
    req.write(payload);
    req.end();
  });
}

// Convenience for preflight: discover the port, then probe it.
async function isReachable() {
  return probe(discoverPort());
}

module.exports = { discoverPort, probe, isReachable, DEVBAR_LOG };
