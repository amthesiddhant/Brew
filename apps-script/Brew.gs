/**
 * Brew — Access + Usage Web App (standalone Apps Script)
 * ======================================================
 * ONE endpoint that powers Brew for EVERY user, not just the sheet owner:
 *
 *   • action "checkAccess" → reads the private "App Access" sheet and answers
 *       whether the *calling* user is allowed to open Brew.
 *   • action "logUsage"    → upserts ONE row per user per day into the private
 *       "BrewUsage" sheet (keyed by Date + Email).
 *
 * WHY A WEB APP (and not the DX Gateway):
 *   The DX Gateway reads/writes as EACH machine's own Google account, so it
 *   only ever worked for the sheet owner (the sheets are private) and most
 *   users don't even have the gateway. A Web App deployed "Execute as: Me"
 *   runs with the OWNER's permissions — full access to the private sheets —
 *   while "Who has access: Anyone within Salesforce.com" lets any signed-in
 *   salesforce.com user reach it over plain HTTPS. No gateway, no OAuth client.
 *
 * IDENTITY IS UNSPOOFABLE:
 *   The caller's email comes from Session.getActiveUser().getEmail() — the
 *   Google-authenticated salesforce.com user — NOT from the request body. Brew
 *   cannot claim to be someone else. (Brew authenticates by carrying the user's
 *   Google session cookies; see webapp.js.)
 *
 * -------------------------------------------------------------------------
 * DEPLOYMENT (one-time — do this as the owner of BOTH sheets)
 * -------------------------------------------------------------------------
 *  1. Open https://script.google.com  →  New project.
 *  2. Delete the default Code.gs contents and paste THIS entire file.
 *  3. Save (name it e.g. "Brew Access + Usage").
 *  4. Run  →  setup   once. Approve the Google authorization prompt on first
 *     run (this grants the script access to your sheets). It ensures the
 *     BrewUsage header row exists and logs a self-check.
 *  5. Deploy  →  New deployment  →  type "Web app".
 *        - Description:        Brew Access + Usage
 *        - Execute as:         Me   (your salesforce.com account)
 *        - Who has access:     Anyone within Salesforce.com
 *  6. Copy the /exec Web App URL and paste it into Brew's access-config.js
 *     (WEBAPP.execUrl). It looks like:
 *        https://script.google.com/a/macros/salesforce.com/s/AKfycb.../exec
 *
 * Re-deploy note: after editing this script, use Deploy → Manage deployments
 * → edit (pencil) → Version: New version, so the /exec URL stays the same.
 * Creating a brand-new deployment mints a NEW url (which then needs re-wiring).
 * -------------------------------------------------------------------------
 */

// ---- Access sheet (the shared "App Access" allowlist) ----------------------
var ACCESS_SHEET_ID = '1BIPh0wVhdpRc1RwNMr_05oKZWCflVpDek9YrJMUyx5E';
var ACCESS_TAB = 'Access';
// Only rows for THIS app count (matched against the "App ID" column). Brew's
// catalog id. Set to '' to allow any app's row.
var ACCESS_APP_ID = 'AI761690';

// ---- Usage sheet (Brew's own daily rollup) --------------------------------
var USAGE_SHEET_ID = '1_neG3QxbK0mHLYC2uC3rftl3ioGRMu5I3KdD_mwL5a4';
var USAGE_TAB = 'BrewUsage';
var USAGE_HEADERS = [
  'Date', 'Email', 'Name', 'Total Brewing', 'Slack Time',
  'Sessions', 'Longest Session', 'App Version', 'Last Updated'
];

// Some people sign in under an alias domain that maps to the same person in the
// sheet. Canonicalize both sides before comparing.
var DOMAIN_ALIASES = { 'orgcs.com': 'salesforce.com' };

// ---------------------------------------------------------------------------
// HTTP entry points
// ---------------------------------------------------------------------------

// Brew POSTs a JSON body: { action: 'checkAccess' | 'logUsage', ...payload }.
// We keep Content-Type as text/plain on the client to dodge a CORS preflight;
// the body is still JSON, parsed here.
function doPost(e) {
  try {
    var payload = {};
    if (e && e.postData && e.postData.contents) {
      payload = JSON.parse(e.postData.contents);
    }
    var action = (payload.action || '').toString().trim();

    // Authoritative, unspoofable caller identity.
    var email = activeEmail_();
    if (!email) {
      // No Google session reached the script — the caller must authorize once.
      return jsonOut({ ok: false, error: 'NOT_AUTHENTICATED' });
    }

    if (action === 'checkAccess') {
      return jsonOut(handleCheckAccess_(email));
    }
    if (action === 'logUsage') {
      return jsonOut(handleLogUsage_(email, payload));
    }
    return jsonOut({ ok: false, error: 'Unknown action: ' + action });
  } catch (err) {
    return jsonOut({ ok: false, error: err && err.message ? err.message : String(err) });
  }
}

// Opening the /exec URL in a browser shows a live status page AND triggers the
// one-time Google authorization prompt for a brand-new user. Brew points its
// first-launch sign-in window here.
function doGet() {
  var email = activeEmail_() || 'unknown';
  var html =
    '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Brew</title>' +
    '<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
    'background:#0b0d12;color:#e7e9ee;margin:0;min-height:100vh;display:flex;' +
    'align-items:center;justify-content:center}' +
    '.card{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);' +
    'border-radius:16px;padding:40px 48px;text-align:center;max-width:420px}' +
    'h1{margin:0 0 8px;font-size:22px}p{margin:6px 0;color:#b4bcd0;font-size:14px}' +
    '.ok{color:#22c55e;font-weight:600}</style>' +
    '</head><body><div class="card">' +
    '<h1>Brew ☕</h1>' +
    '<p class="ok">● You’re signed in</p>' +
    '<p>Signed in as: ' + escapeHtml_(email) + '</p>' +
    '<p>You can close this tab and return to Brew.</p>' +
    '</div></body></html>';
  return HtmlService.createHtmlOutput(html)
    .setTitle('Brew')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ---------------------------------------------------------------------------
// action: checkAccess
// ---------------------------------------------------------------------------

function handleCheckAccess_(email) {
  var want = canonEmail_(email);
  var allowed = allowedEmails_().indexOf(want) !== -1;
  return { ok: true, allowed: allowed, email: email, reason: allowed ? 'listed' : 'not-listed' };
}

// Read the allowlist and return the set of canonical emails allowed for Brew.
// Columns are matched by HEADER name (row 1), so column order can change freely.
function allowedEmails_() {
  var ss = SpreadsheetApp.openById(ACCESS_SHEET_ID);
  var sheet = ss.getSheetByName(ACCESS_TAB);
  if (!sheet) throw new Error('Access tab "' + ACCESS_TAB + '" not found');
  var values = sheet.getDataRange().getValues();
  if (!values || values.length < 2) return [];

  var header = values[0].map(function (h) { return String(h == null ? '' : h).trim().toLowerCase(); });
  var iEmail = header.indexOf('email');
  var iAccess = header.indexOf('access');
  var iApp = header.indexOf('app id');
  if (iEmail === -1) throw new Error('allowlist sheet has no "Email" column');

  var want = String(ACCESS_APP_ID || '').trim().toLowerCase();
  var seen = {};
  var out = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    if (iAccess !== -1 && !isYes_(row[iAccess])) continue;
    if (want && iApp !== -1 && String(row[iApp] == null ? '' : row[iApp]).trim().toLowerCase() !== want) continue;
    var em = canonEmail_(row[iEmail]);
    if (!em || seen[em]) continue;
    seen[em] = true;
    out.push(em);
  }
  return out;
}

// ---------------------------------------------------------------------------
// action: logUsage
// ---------------------------------------------------------------------------
// Upserts ONE row per (Date + Email). Brew sends the already-rolled-up totals
// for a day; the script overwrites that user's row for the day if present, else
// appends a new one. A LockService guard keeps concurrent callers from racing
// on the append target.
//
// Expected payload:
//   { action:'logUsage', name, date:'YYYY-MM-DD', totalBrewing, slackTime,
//     sessions, longestSession, appVersion, lastUpdated }
// (totalBrewing/slackTime/longestSession are pre-formatted strings like
// "2h 30m"; sessions is a number/string. email is IGNORED — we use the
// authenticated one.)

function handleLogUsage_(email, payload) {
  var date = (payload.date || '').toString().trim();
  if (!date) return { ok: false, error: 'Missing date' };

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (_) {
    return { ok: false, error: 'Busy — could not acquire lock' };
  }
  try {
    var sheet = getUsageSheet_();
    var values = sheet.getDataRange().getValues();

    // Ensure header on first-ever write.
    if (!values.length || values[0].length === 0) {
      sheet.getRange(1, 1, 1, USAGE_HEADERS.length).setValues([USAGE_HEADERS]);
      values = [USAGE_HEADERS.slice()];
    }

    var header = values[0].map(function (h) { return String(h == null ? '' : h).trim().toLowerCase(); });
    var iDate = header.indexOf('date');
    var iEmail = header.indexOf('email');

    var row = [
      date,
      email,
      (payload.name || '').toString(),
      (payload.totalBrewing || '').toString(),
      (payload.slackTime || '').toString(),
      (payload.sessions == null ? '' : payload.sessions).toString(),
      (payload.longestSession || '').toString(),
      (payload.appVersion || '').toString(),
      (payload.lastUpdated || '').toString()
    ];

    // Find this user's existing row for the day.
    var emailKey = canonEmail_(email);
    var found = -1;
    if (iDate !== -1 && iEmail !== -1) {
      for (var r = 1; r < values.length; r++) {
        if (String(values[r][iDate]).trim() === date &&
            canonEmail_(values[r][iEmail]) === emailKey) {
          found = r + 1; // 1-based sheet row
          break;
        }
      }
    }

    if (found !== -1) {
      sheet.getRange(found, 1, 1, row.length).setValues([row]);
      return { ok: true, action: 'updated', row: found };
    }
    sheet.appendRow(row);
    return { ok: true, action: 'appended' };
  } finally {
    lock.releaseLock();
  }
}

function getUsageSheet_() {
  var ss = SpreadsheetApp.openById(USAGE_SHEET_ID);
  var sheet = ss.getSheetByName(USAGE_TAB);
  if (!sheet) {
    sheet = ss.insertSheet(USAGE_TAB);
    writeUsageHeader_(sheet);
  } else if (sheet.getLastRow() === 0) {
    writeUsageHeader_(sheet);
  }
  return sheet;
}

function writeUsageHeader_(sheet) {
  sheet.getRange(1, 1, 1, USAGE_HEADERS.length).setValues([USAGE_HEADERS]);
  sheet.getRange(1, 1, 1, USAGE_HEADERS.length)
    .setFontWeight('bold')
    .setBackground('#6f4e37')
    .setFontColor('#ffffff');
  sheet.setFrozenRows(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function activeEmail_() {
  try { return (Session.getActiveUser().getEmail() || '').trim(); }
  catch (_) { return ''; }
}

// trim + lowercase, then rewrite an aliased domain to its canonical form.
function canonEmail_(s) {
  var email = String(s == null ? '' : s).trim().toLowerCase();
  var at = email.lastIndexOf('@');
  if (at === -1) return email;
  var local = email.slice(0, at);
  var domain = email.slice(at + 1);
  var canonical = DOMAIN_ALIASES[domain] || domain;
  return local + '@' + canonical;
}

function isYes_(v) {
  var s = String(v == null ? '' : v).trim().toLowerCase();
  return s === 'yes' || s === 'y' || s === 'true' || s === '1' ||
    s === 'granted' || s === 'allowed' || s === 'enabled';
}

function escapeHtml_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------------------
// One-time setup + self-tests (run from the editor)
// ---------------------------------------------------------------------------

// Run ONCE after pasting: approves authorization + ensures the usage header.
function setup() {
  var sheet = getUsageSheet_();
  writeUsageHeader_(sheet);
  var n = allowedEmails_().length;
  Logger.log('BrewUsage ready. Allowlist currently grants ' + n + ' Brew user(s).');
}

// Simulate an access check for the editor account.
function testCheckAccess() {
  Logger.log(JSON.stringify(handleCheckAccess_(activeEmail_() || 'you@salesforce.com')));
}

// Simulate a usage upsert for the editor account.
function testLogUsage() {
  var res = handleLogUsage_(activeEmail_() || 'you@salesforce.com', {
    name: 'Test User', date: '2026-01-01', totalBrewing: '2h 30m',
    slackTime: '1h 0m', sessions: 3, longestSession: '1h 15m',
    appVersion: '0.0.0-test', lastUpdated: '2026-01-01 09:00'
  });
  Logger.log(JSON.stringify(res));
}
