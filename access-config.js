'use strict';

// Configuration for Brew's access gate — ported from Genie's config.js.
//
// Brew reuses the exact same access model as Genie: the allowlist lives in a
// shared Google Sheet ("App Access") and is read LIVE through the local DX MCP
// Gateway (devbar's `mcpgw` plugin) — the authenticated `google_workspace` MCP
// server's `read_sheet_values` tool. There is no Apps Script, no /exec URL and
// no separate Google sign-in: the gateway already handles Google auth and reads
// as the signed-in user.
//
// A user is allowed when their sheet row has Access=Yes AND App ID == Brew's id
// (AI761690). We match the signed-in SOMA user's email against those rows
// (case-insensitive). Sheet edits need no app change — it's read on every launch.
module.exports = {
  // Google Workspace via the local DX MCP Gateway. The proxy port is assigned
  // dynamically by devbar; we discover it at runtime from devbar's log (see
  // dxgw.js), falling back to the well-known default.
  GCAL: {
    // MCP server name on the gateway (the same one that powers Genie's calendar
    // and Gmail features).
    serverName: 'google_workspace',
    // Path template on the proxy; {server} filled in at runtime.
    proxyPathTemplate: '/proxy/mcp/server/{server}/mcp',
    // Fallback port if it can't be discovered from devbar's log.
    fallbackPort: 13316,
  },

  // Access allowlist gate.
  ACCESS: {
    // The shared "App Access" spreadsheet id (from its URL) — same sheet Genie
    // reads. Brew and Genie are distinguished by the App ID column below.
    sheetId: '1BIPh0wVhdpRc1RwNMr_05oKZWCflVpDek9YrJMUyx5E',
    // A1-notation range to read (tab-qualified). Columns are matched by HEADER
    // name (row 1), so reordering/adding columns is safe.
    rangeName: 'Access!A1:I1000',
    // Only rows for THIS app count (matched against the "App ID" column,
    // case-insensitive). Brew's catalog id is AI761690. Set '' to ignore.
    appId: 'AI761690',
    // The signed-in login can carry a different email DOMAIN than the sheet uses
    // for the same person; canonicalize any alias domain (left) to the canonical
    // one (right) on BOTH sides before matching. (SOMA already returns
    // salesforce.com, so this is a harmless safety net.)
    domainAliases: {
      'orgcs.com': 'salesforce.com',
    },
    // Read timeout (ms). The gateway round-trip is slower than a plain fetch,
    // and the client has its own 30s socket timeout; this bounds the whole call.
    timeoutMs: 20000,
    // Cache file (in userData): last-known list + per-email grants for GRACE.
    cacheFile: 'access-cache.json',
    // GRACE window (days). When the sheet can't be read, a previously-granted
    // user stays allowed only if their grant was confirmed online within this
    // many days. A successful online read that no longer lists the user clears
    // their grant immediately (revocation is instant online).
    graceDays: 7,
  },

  // Usage tracking. Brew writes ONE row per user per day to a Google Sheet
  // through the same DX Gateway used for the access gate. The local
  // sessions.json log stays the source of truth; this is an opportunistic,
  // best-effort mirror (a gateway outage never loses data — it re-syncs next
  // launch). Upsert key = (Date + Email): today's existing row is updated in
  // place, otherwise a new row is appended.
  USAGE: {
    // Dedicated usage sheet (separate from the access sheet).
    sheetId: '1_neG3QxbK0mHLYC2uC3rftl3ioGRMu5I3KdD_mwL5a4',
    // Tab (sheet) name the rows live in.
    tabName: 'BrewUsage',
    // Column order for the row we write. Row 1 of the tab is a header with these
    // exact labels; Brew ensures it exists on first sync.
    headers: [
      'Date', 'Email', 'Name', 'Total Brewing', 'Slack Time',
      'Sessions', 'Longest Session', 'App Version', 'Last Updated',
    ],
    // google_workspace tool names on the gateway. Kept as config so a rename on
    // the server side is a one-line change here, not a code edit.
    readTool: 'read_sheet_values',
    writeTool: 'modify_sheet_values',
    // How many trailing days to reconcile each sync (today + yesterday catches a
    // session that spanned local midnight or an app that was closed overnight).
    syncDays: 2,
    // Bound the whole gateway round-trip (ms).
    timeoutMs: 20000,
  },
};
