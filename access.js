'use strict';

// Access allowlist gate. On every launch (after the SOMA connection is
// verified) we ask the Apps Script Web App whether the signed-in user is
// allowed to open Brew.
//
// The web app (apps-script/Brew.gs, "Execute as: Me / Anyone within
// Salesforce.com") reads the private "App Access" sheet with the OWNER's
// permissions and answers for the *calling* user — whose identity it resolves
// server-side from their Google session (unspoofable). This is what makes the
// gate work for EVERY user, not just the sheet owner: the old DX Gateway path
// read as each machine's own Google account, so it only worked for the owner.
// Brew carries the user's Google cookies on the call (see webapp.js); the first
// launch pops a one-time sign-in window.
//
// Identity for the local grace cache: the connected SOMA account's email
// (git.soma.salesforce.com /api/v3/user), the canonical salesforce.com address.
// The allow/deny DECISION comes from the web app; SOMA email is only the cache
// key + what we display.
//
// Offline policy = GRACE: a user who passed the check before (recorded in a
// local cache) stays allowed when the web app can't be reached; only brand-new
// unknown users are denied while offline.
//
// NOTE: this is an access-management convenience, not a hardened security
// boundary. It decides who the app opens for.

const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { ACCESS } = require('./access-config');
const webapp = require('./webapp');

function normEmail(s) {
  return String(s || '').trim().toLowerCase();
}

// Canonicalize an email for matching: trim+lowercase, then rewrite an aliased
// login domain to the one the allowlist uses for the same person. Applied to
// BOTH the signed-in email and every sheet email, so the two always meet in the
// same namespace.
function canonEmail(s) {
  const email = normEmail(s);
  const at = email.lastIndexOf('@');
  if (at === -1) return email;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const aliases = (ACCESS && ACCESS.domainAliases) || {};
  const canonical = aliases[domain] || domain;
  return `${local}@${canonical}`;
}

function cacheFilePath() {
  return path.join(app.getPath('userData'), ACCESS.cacheFile);
}

// ---- grace cache (userData JSON) -----------------------------------------
// Shape: { list: ["a@x.com", ...], updated: "ISO", grants: { "email": "ISO" } }
function readCache() {
  try {
    return JSON.parse(fs.readFileSync(cacheFilePath(), 'utf8')) || {};
  } catch (_) {
    return {};
  }
}

function writeCache(obj) {
  try {
    fs.writeFileSync(cacheFilePath(), JSON.stringify(obj), 'utf8');
  } catch (_) {
    /* best-effort — a missing cache just means no grace for this user yet */
  }
}

// ---- sheet parsing --------------------------------------------------------
// read_sheet_values returns human-readable text, one line per row, each row a
// Python-style list repr, e.g.:
//   Successfully read 2 rows from range 'Access!A1:I10' ... for you@x.com:
//   Row  1: ['Timestamp', 'ID', 'App ID', 'App Name', 'Name', 'Email', ...]
//   Row  2: ['...', 'Brew', 'Name', 'you@x.com', 'User', 'Yes', 'note']
// Cells are single-quoted (may contain escaped quotes / commas) or bare values.

// Split the inside of a "[ ... ]" list into its cell strings, honoring quotes.
function parseRowCells(inner) {
  const cells = [];
  const n = inner.length;
  let i = 0;
  while (i < n) {
    while (i < n && (inner[i] === ' ' || inner[i] === ',')) i++;
    if (i >= n) break;
    const c = inner[i];
    if (c === "'" || c === '"') {
      i++;
      let s = '';
      while (i < n) {
        if (inner[i] === '\\' && i + 1 < n) { s += inner[i + 1]; i += 2; continue; }
        if (inner[i] === c) { i++; break; }
        s += inner[i];
        i++;
      }
      cells.push(s);
    } else {
      let s = '';
      while (i < n && inner[i] !== ',') { s += inner[i]; i++; }
      cells.push(s.trim());
    }
  }
  return cells;
}

// Turn the tool's text output into an array of row-cell arrays (header first).
function parseSheetRows(text) {
  const rows = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    const open = line.indexOf('[');
    const close = line.lastIndexOf(']');
    if (!/^Row\s+\d+\s*:/.test(line) || open === -1 || close <= open) continue;
    rows.push(parseRowCells(line.slice(open + 1, close)));
  }
  return rows;
}

// Treat Yes / Y / True / 1 / Granted / Allowed / Enabled as affirmative.
function isYes(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return s === 'yes' || s === 'y' || s === 'true' || s === '1' ||
    s === 'granted' || s === 'allowed' || s === 'enabled';
}

// From parsed rows, collect the canonical emails allowed for this app.
// Columns are matched by HEADER name (row 1), so column order can change freely.
function allowedEmailsFromRows(rows) {
  if (!rows || rows.length < 2) return [];
  const header = rows[0].map((h) => String(h || '').trim().toLowerCase());
  const iEmail = header.indexOf('email');
  const iAccess = header.indexOf('access');
  const iApp = header.indexOf('app id');
  if (iEmail === -1) throw new Error('allowlist sheet has no "Email" column');

  const want = String(ACCESS.appId || '').trim().toLowerCase();
  const seen = new Set();
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (iAccess !== -1 && !isYes(row[iAccess])) continue;
    if (want && iApp !== -1 && String(row[iApp] || '').trim().toLowerCase() !== want) continue;
    const email = canonEmail(row[iEmail]);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}

// Reject `p` if it hasn't settled within `ms`.
function withTimeout(p, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

// Ask the web app whether the CALLING user is allowed. The web app resolves the
// caller's identity from their Google session server-side, so it returns a
// single boolean for this user — not the whole list. Interactive: the launch
// gate is allowed to pop the one-time sign-in window. Resolves { allowed }.
// Rejects on transport error / not-configured / not-yet-authorized (→ GRACE).
async function fetchAllowed() {
  const res = await withTimeout(
    webapp.call('checkAccess', {}, { interactive: true }),
    ACCESS.timeoutMs,
    'access check timed out'
  );
  if (!res || res.ok !== true) {
    throw new Error((res && res.error) || 'web app access check failed');
  }
  return { allowed: !!res.allowed };
}

// Resolve identity, ask the web app, apply grace. Returns:
//   { allowed:boolean, email:string, reason:string, offline:boolean }
//
// `resolveEmail` is an async function returning the signed-in user's email
// (Brew passes soma.getIdentityEmail). Kept as a parameter so the gate has no
// direct dependency on the SOMA client. It's the cache key + display value; the
// authoritative allow/deny comes from the web app's own identity resolution.
async function check(resolveEmail) {
  let email = '';
  try {
    email = canonEmail(await resolveEmail());
  } catch (_) {
    /* identity failed — treat as unknown below */
  }

  if (!email) return { allowed: false, email: '', reason: 'no-email', offline: false };

  try {
    const { allowed } = await fetchAllowed();
    const cache = readCache();
    cache.grants = cache.grants || {};
    // Record a fresh grant when allowed; CLEAR any stale grant when the web app
    // says this user is no longer allowed — so offline Grace can only ever
    // resurrect users we couldn't verify, never ones we verified as removed.
    if (allowed) cache.grants[email] = new Date().toISOString();
    else delete cache.grants[email];
    writeCache(cache);
    return { allowed, email, reason: allowed ? 'listed' : 'not-listed', offline: false };
  } catch (_) {
    // Web app unreachable / not configured / not yet authorized → GRACE: allow
    // if this email holds a grant confirmed within the grace window. A grant
    // older than graceDays is treated as expired.
    const cache = readCache();
    const graceMs = Math.max(0, Number(ACCESS.graceDays) || 0) * 86400000;
    const withinGrace = (iso) => {
      const t = Date.parse(iso);
      return Number.isFinite(t) && Date.now() - t <= graceMs;
    };
    const grantedAt = cache.grants && cache.grants[email];
    const allowed = !!grantedAt && withinGrace(grantedAt);
    return { allowed, email, reason: allowed ? 'grace' : 'offline-unknown', offline: true };
  }
}

module.exports = { check, parseSheetRows, allowedEmailsFromRows, parseRowCells, canonEmail };
