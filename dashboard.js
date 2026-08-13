'use strict';

// Brew Insights dashboard renderer. Pulls the aggregated payload from the main
// process (window.brew.statsGet) and paints stat cards + a bar chart. No chart
// library — bars are plain divs sized by percentage, so the app stays
// dependency-free and works fully offline.

let insights = null;
let period = 'daily'; // 'daily' | 'weekly' | 'monthly'

// ---- Formatting helpers ----------------------------------------------------

// Human-friendly duration: "2h 15m", "45m", "38s". Compact for cards.
function fmtDuration(ms) {
  if (!ms || ms < 1000) return '0m';
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return `${Math.floor(ms / 1000)}s`;
}

// Even shorter, for the small mini-cards where space is tight.
function fmtShort(ms) {
  if (!ms || ms < 1000) return '0m';
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h >= 10) return `${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function fmtSince(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return '—';
  }
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

// ---- Rendering -------------------------------------------------------------

function renderCards() {
  const { today, week, month, allTime } = insights;

  setText('cardToday', fmtDuration(today.totalMs));
  setText('cardTodaySub', `${today.count} session${today.count === 1 ? '' : 's'}`);

  setText('cardWeek', fmtDuration(week.totalMs));
  setText('cardWeekSub', `${week.count} session${week.count === 1 ? '' : 's'}`);

  setText('cardMonth', fmtDuration(month.totalMs));
  setText('cardMonthSub', `${month.count} session${month.count === 1 ? '' : 's'}`);

  setText('cardAll', fmtDuration(allTime.totalMs));
  setText('cardAllSub', `${allTime.count} session${allTime.count === 1 ? '' : 's'}`);
}

function renderMini() {
  const { allTime, streak, firstSessionAt } = insights;
  setText('miniStreak', `${streak} day${streak === 1 ? '' : 's'}`);
  setText('miniLongest', fmtShort(allTime.longestMs));
  setText('miniAvg', fmtShort(allTime.avgMs));
  setText('miniSlack', fmtShort(allTime.slackMs));
  setText('miniSessions', String(allTime.count));
  setText('miniSince', fmtSince(firstSessionAt));
}

// Pick the bucket set + titles for the active period.
function bucketsForPeriod() {
  const c = insights.charts;
  switch (period) {
    case 'monthly':
      return { buckets: c.monthly, title: 'Last 6 Months', hint: 'Brew time per month' };
    case 'weekly':
      // Weekly view = the same 7 daily bars, framed as the current week.
      return { buckets: c.weekly, title: 'This Week', hint: 'Brew time per day' };
    case 'daily':
    default:
      return { buckets: c.daily, title: 'Last 7 Days', hint: 'Brew time per day' };
  }
}

// Track the chart shape we last built so we can update bars *in place* (smooth
// height transitions) instead of tearing down and rebuilding the DOM — that's
// what makes the live update look fluid rather than flickering.
let chartSignature = null; // `${period}:${bucketCount}`

function buildChartSkeleton(area, buckets) {
  area.innerHTML = '';
  for (const b of buckets) {
    const col = document.createElement('div');
    col.className = 'bar-col';

    const barWrap = document.createElement('div');
    barWrap.className = 'bar-wrap';

    const bar = document.createElement('div');
    bar.className = 'bar';

    const slack = document.createElement('div');
    slack.className = 'bar-slack';
    bar.appendChild(slack);

    const val = document.createElement('span');
    val.className = 'bar-value';
    bar.appendChild(val);

    barWrap.appendChild(bar);

    const label = document.createElement('span');
    label.className = 'bar-label';
    label.textContent = b.label;

    col.appendChild(barWrap);
    col.appendChild(label);
    area.appendChild(col);
  }
}

function renderChart() {
  const area = document.getElementById('chartArea');
  const empty = document.getElementById('chartEmpty');
  const { buckets, title, hint } = bucketsForPeriod();

  setText('chartTitle', title);
  setText('chartHint', hint);

  const maxMs = Math.max(...buckets.map((b) => b.totalMs), 0);

  // Empty state: nothing recorded in any visible bucket.
  if (maxMs <= 0) {
    area.style.display = 'none';
    empty.style.display = 'flex';
    chartSignature = null;
    return;
  }
  area.style.display = 'flex';
  empty.style.display = 'none';

  // Rebuild the skeleton only when the period or bucket count changes; otherwise
  // reuse the existing bars so CSS height transitions animate the update.
  const sig = `${period}:${buckets.length}`;
  if (sig !== chartSignature || area.children.length !== buckets.length) {
    buildChartSkeleton(area, buckets);
    chartSignature = sig;
  }

  const cols = area.children;
  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i];
    const col = cols[i];
    if (!col) continue;
    const bar = col.querySelector('.bar');
    const slack = col.querySelector('.bar-slack');
    const val = col.querySelector('.bar-value');
    const label = col.querySelector('.bar-label');

    const pct = Math.max(b.totalMs > 0 ? 3 : 0, (b.totalMs / maxMs) * 100);
    const slackPct = b.totalMs > 0 ? Math.min(100, (b.slackMs / b.totalMs) * 100) : 0;

    bar.classList.toggle('bar-empty', b.totalMs <= 0);
    bar.style.height = `${pct}%`;
    slack.style.height = `${slackPct}%`;
    slack.style.display = slackPct > 0 ? '' : 'none';
    val.textContent = b.totalMs > 0 ? fmtShort(b.totalMs) : '';
    if (label) label.textContent = b.label;

    const slackTxt = b.slackMs > 0 ? ` · ${fmtShort(b.slackMs)} on Slack` : '';
    col.querySelector('.bar-wrap').title =
      `${b.dateLabel}: ${fmtDuration(b.totalMs)}${slackTxt} · ${b.count} session${b.count === 1 ? '' : 's'}`;
  }
}

// Drive the "Live" indicator: active (pulsing) whenever a session is in
// progress right now, dim otherwise.
function renderLive() {
  const live = document.getElementById('dashLive');
  if (!live) return;
  // A teammate / All view is historical sheet data — there's no live signal, so
  // label it "Recorded" and never pulse.
  if (dashboardSource() !== 'live') {
    live.classList.remove('active');
    setText('dashLiveText', 'Recorded');
    return;
  }
  const active = !!(insights && insights.brewing);
  live.classList.toggle('active', active);
  setText('dashLiveText', active ? 'Live' : 'Idle');
}

function render() {
  if (!insights) return;
  renderCards();
  renderMini();
  renderChart();
  renderLive();
}

// ---- Admin view (Team Usage) ----------------------------------------------
// Shown ONLY when the web app confirms the signed-in user has an Admin/Owner
// role. The decision is made server-side (unspoofable Google identity); this
// just paints the rows it returns. All cell text is set via textContent, so
// user-supplied Name/Email can never inject markup.

let adminRows = null;        // cached rows from the server, or null until loaded
let adminIsAdmin = false;    // whether the admin panel is active
let adminEmail = '';         // the signed-in admin's own email (default selection)
let adminSelected = '';      // selected user's canonical email, or '' for All
let adminSort = { key: 'date', dir: -1 }; // default: newest date first

const DASH_DAY_MS = 24 * 60 * 60 * 1000;

// Which data source the WHOLE dashboard is currently showing:
//   'live' — the admin's own local session log (per-second, real brewing dot).
//   'user' — one teammate, reconstructed from their BrewUsage sheet rows.
//   'all'  — every teammate's cumulative totals, reconstructed from the sheet.
// Non-admins are always 'live'. Default for an admin is 'live' (their own data).
function dashboardSource() {
  if (!adminIsAdmin) return 'live';
  if (!adminSelected) return 'all';
  if (adminSelected === adminEmail) return 'live';
  return 'user';
}

const ADMIN_COLS = [
  { key: 'Date' }, { key: 'Name' }, { key: 'Email' }, { key: 'Total Brewing' },
  { key: 'Slack Time' }, { key: 'Sessions' }, { key: 'Longest Session' },
  { key: 'App Version' }, { key: 'Last Updated' },
];

// Map a table header's data-sort token to the sheet column key it sorts on.
const SORT_KEY_TO_COL = {
  date: 'Date', name: 'Name', email: 'Email', totalBrewing: 'Total Brewing',
  slackTime: 'Slack Time', sessions: 'Sessions', longestSession: 'Longest Session',
  appVersion: 'App Version', lastUpdated: 'Last Updated',
};

// ---- Reconstructing insights from BrewUsage sheet rows --------------------
// The cards/chart/mini-cards render from an `insights` object that, for the
// admin's OWN data, comes live from statsGet(). Other teammates exist only as
// per-DAY rollups in the sheet (durations stored as pre-formatted strings like
// "2h 30m"). To let the whole dashboard switch, we rebuild an insights-shaped
// object from those rows for a selected user (or the cumulative "All" view).

// Parse "2h 30m" / "45m" / "38s" / "1h" back into milliseconds. Tolerant of
// stray spacing and missing units; returns 0 for blanks/unparseable input.
function parseDurationMs(str) {
  const s = String(str == null ? '' : str).trim().toLowerCase();
  if (!s || s === '0m' || s === '0') return 0;
  let ms = 0;
  let matched = false;
  const h = s.match(/(\d+)\s*h/);
  if (h) { ms += Number(h[1]) * 3600000; matched = true; }
  const m = s.match(/(\d+)\s*m/);
  if (m) { ms += Number(m[1]) * 60000; matched = true; }
  const sec = s.match(/(\d+)\s*s/);
  if (sec) { ms += Number(sec[1]) * 1000; matched = true; }
  // Bare number with no unit → treat as minutes (defensive; shouldn't happen).
  if (!matched) { const n = Number(s); if (Number.isFinite(n)) ms = n * 60000; }
  return ms;
}

// Parse a "YYYY-MM-DD" sheet date to a LOCAL start-of-day epoch ms (matches how
// stats.js buckets by local day). Returns null if unparseable.
function parseSheetDate(str) {
  const m = String(str == null ? '' : str).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}

// Start-of-day (local) epoch ms for a timestamp.
function startOfLocalDay(ts) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

// Turn a set of sheet rows (one per day) into a per-day map keyed by local
// day-start, each { totalMs, slackMs, count, longestMs }. Rows for the same day
// (e.g. the "All" view merging multiple users) are summed; longest is the max.
function rollupsByDay(rows) {
  const byDay = new Map();
  for (const r of rows) {
    const dayStart = parseSheetDate(r['Date']);
    if (dayStart == null) continue;
    const cur = byDay.get(dayStart) || { totalMs: 0, slackMs: 0, count: 0, longestMs: 0 };
    cur.totalMs += parseDurationMs(r['Total Brewing']);
    cur.slackMs += parseDurationMs(r['Slack Time']);
    cur.count += Number(r['Sessions']) || 0;
    cur.longestMs = Math.max(cur.longestMs, parseDurationMs(r['Longest Session']));
    byDay.set(dayStart, cur);
  }
  return byDay;
}

// Sum a day-map over [since, ∞) into the same summary shape stats.js emits.
// NOTE: from sheet rollups we only know per-day totals, so avgMs is per-DAY
// average (total / active days), and longestMs is the longest single session
// recorded on any day in range — a faithful read of what the sheet stores.
function summarizeDays(byDay, since) {
  let totalMs = 0, slackMs = 0, count = 0, longestMs = 0, activeDays = 0;
  for (const [dayStart, v] of byDay) {
    if (dayStart < since) continue;
    totalMs += v.totalMs;
    slackMs += v.slackMs;
    count += v.count;
    if (v.longestMs > longestMs) longestMs = v.longestMs;
    if (v.totalMs > 0 || v.count > 0) activeDays += 1;
  }
  return { totalMs, slackMs, count, longestMs, avgMs: activeDays ? Math.round(totalMs / activeDays) : 0 };
}

// Build 7 daily bars (oldest→newest, today last) from a day-map, matching the
// shape/labels stats._dailyBuckets produces so renderChart can paint them.
function dailyBarsFromDays(byDay, now, days) {
  const todayStart = startOfLocalDay(now);
  const bars = [];
  for (let i = days - 1; i >= 0; i--) {
    const dayStart = todayStart - i * DASH_DAY_MS;
    const d = new Date(dayStart);
    const v = byDay.get(dayStart) || { totalMs: 0, slackMs: 0, count: 0 };
    bars.push({
      dayStart,
      label: d.toLocaleDateString(undefined, { weekday: 'short' }),
      dateLabel: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      totalMs: v.totalMs, slackMs: v.slackMs, count: v.count,
    });
  }
  return bars;
}

// Build 6 monthly bars (oldest→newest) from a day-map.
function monthlyBarsFromDays(byDay, now, months) {
  const nowDate = new Date(now);
  const bars = [];
  const index = new Map();
  const key = (y, m) => `${y}-${m}`;
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(nowDate.getFullYear(), nowDate.getMonth() - i, 1);
    const bar = {
      key: key(d.getFullYear(), d.getMonth()),
      label: d.toLocaleDateString(undefined, { month: 'short' }),
      dateLabel: d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' }),
      totalMs: 0, slackMs: 0, count: 0,
    };
    bars.push(bar);
    index.set(bar.key, bar);
  }
  for (const [dayStart, v] of byDay) {
    const d = new Date(dayStart);
    const bar = index.get(key(d.getFullYear(), d.getMonth()));
    if (bar) { bar.totalMs += v.totalMs; bar.slackMs += v.slackMs; bar.count += v.count; }
  }
  return bars;
}

// Consecutive-day streak ending today (local) from a day-map.
function streakFromDays(byDay, now) {
  let streak = 0;
  let cursor = startOfLocalDay(now);
  const active = (ds) => { const v = byDay.get(ds); return !!v && (v.totalMs > 0 || v.count > 0); };
  if (!active(cursor)) cursor -= DASH_DAY_MS;
  while (active(cursor)) { streak += 1; cursor -= DASH_DAY_MS; }
  return streak;
}

// Reconstruct a full insights payload (same shape as stats.getInsights) from the
// given sheet rows. Used for a selected teammate and for the cumulative "All"
// view. `brewing` is always false — the sheet has no live/in-progress signal.
function insightsFromRows(rows, now) {
  const byDay = rollupsByDay(rows);
  const todayStart = startOfLocalDay(now);
  const weekStart = todayStart - 6 * DASH_DAY_MS;
  const monthStart = new Date(new Date(now).getFullYear(), new Date(now).getMonth(), 1).getTime();

  let firstSessionAt = null;
  for (const dayStart of byDay.keys()) {
    if (firstSessionAt == null || dayStart < firstSessionAt) firstSessionAt = dayStart;
  }

  return {
    generatedAt: now,
    brewing: false,
    today: summarizeDays(byDay, todayStart),
    week: summarizeDays(byDay, weekStart),
    month: summarizeDays(byDay, monthStart),
    allTime: summarizeDays(byDay, 0),
    streak: streakFromDays(byDay, now),
    firstSessionAt,
    charts: {
      daily: dailyBarsFromDays(byDay, now, 7),
      weekly: dailyBarsFromDays(byDay, now, 7),
      monthly: monthlyBarsFromDays(byDay, now, 6),
    },
  };
}

// Distinct users present in the data, keyed by lowercased email. We prefer the
// most recent non-empty Name we've seen for each email as its display label.
function adminUsers() {
  const rows = Array.isArray(adminRows) ? adminRows : [];
  const byEmail = new Map(); // email -> { email, name }
  for (const r of rows) {
    const email = String(r['Email'] || '').trim().toLowerCase();
    if (!email) continue;
    const name = String(r['Name'] || '').trim();
    const cur = byEmail.get(email);
    if (!cur) byEmail.set(email, { email, name });
    else if (!cur.name && name) cur.name = name;
  }
  return Array.from(byEmail.values())
    .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
}

// The label shown in the dropdown / input for a user. Falls back to email when
// no name is recorded. "All" is represented by the empty selection.
function adminUserLabel(u) {
  if (!u) return 'All teammates';
  return u.name ? `${u.name} (${u.email})` : u.email;
}

// Populate the datalist with "All teammates" + one entry per user, and set the
// input's value to reflect the current selection.
function buildAdminUserList() {
  const list = document.getElementById('adminUserList');
  const input = document.getElementById('adminUserSelect');
  if (!list || !input) return;
  const users = adminUsers();

  list.replaceChildren();
  const optAll = document.createElement('option');
  optAll.value = 'All teammates';
  list.appendChild(optAll);
  for (const u of users) {
    const opt = document.createElement('option');
    opt.value = adminUserLabel(u); // XSS-safe: value attr, not markup
    list.appendChild(opt);
  }

  // Reflect the active selection back into the input's text.
  if (!adminSelected) {
    input.value = 'All teammates';
  } else {
    const sel = users.find((u) => u.email === adminSelected);
    input.value = sel ? adminUserLabel(sel) : adminSelected;
  }
}

// Resolve whatever the admin typed/picked to a canonical email ('' = All).
// Accepts the exact dropdown label, a bare name, or a bare email.
function resolveAdminSelection(text) {
  const q = String(text || '').trim().toLowerCase();
  if (!q || q === 'all' || q === 'all teammates') return '';
  const users = adminUsers();
  // Exact label match first (what picking from the dropdown produces).
  const byLabel = users.find((u) => adminUserLabel(u).toLowerCase() === q);
  if (byLabel) return byLabel.email;
  // Then exact email, then exact name, then a loose contains.
  const byEmail = users.find((u) => u.email === q);
  if (byEmail) return byEmail.email;
  const byName = users.find((u) => String(u.name || '').toLowerCase() === q);
  if (byName) return byName.email;
  const loose = users.find((u) =>
    u.email.includes(q) || String(u.name || '').toLowerCase().includes(q));
  return loose ? loose.email : '';
}

// Sessions sort numerically; everything else as strings. Good enough — the
// duration columns are pre-formatted strings and sort lexically, which is fine
// for a quick glance (the Date + numeric sessions cover the real use).
function compareRows(a, b, col, dir) {
  const av = a[col] == null ? '' : a[col];
  const bv = b[col] == null ? '' : b[col];
  if (col === 'Sessions') {
    return (Number(av) - Number(bv)) * dir;
  }
  return String(av).localeCompare(String(bv)) * dir;
}

function renderAdminTable() {
  const body = document.getElementById('adminTableBody');
  const empty = document.getElementById('adminEmpty');
  if (!body) return;

  const all = Array.isArray(adminRows) ? adminRows : [];
  const col = SORT_KEY_TO_COL[adminSort.key] || 'Date';
  const rows = selectedRows()
    .slice()
    .sort((a, b) => compareRows(a, b, col, adminSort.dir));

  body.replaceChildren();
  if (rows.length === 0) {
    empty.style.display = 'flex';
    empty.querySelector('p').textContent = all.length === 0
      ? 'No team usage recorded yet.'
      : 'No usage recorded for this teammate yet.';
    return;
  }
  empty.style.display = 'none';

  for (const r of rows) {
    const tr = document.createElement('tr');
    for (const c of ADMIN_COLS) {
      const td = document.createElement('td');
      td.textContent = r[c.key] == null ? '' : String(r[c.key]); // XSS-safe
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
}

async function loadAdmin() {
  try {
    if (!window.brew.adminWhoAmI) return;
    const who = await window.brew.adminWhoAmI();
    adminIsAdmin = !!(who && who.isAdmin);
    adminEmail = String((who && who.email) || '').trim().toLowerCase();
    const panel = document.getElementById('adminPanel');
    if (!adminIsAdmin) {
      if (panel) panel.style.display = 'none';
      return;
    }
    const res = await window.brew.adminGetUsage();
    if (!res || !res.ok || !res.isAdmin) {
      if (panel) panel.style.display = 'none';
      return;
    }
    adminRows = Array.isArray(res.rows) ? res.rows : [];
    if (panel) panel.style.display = '';

    // Reveal the whole-dashboard user picker in the header.
    const picker = document.getElementById('dashUserPicker');
    if (picker) picker.style.display = '';

    // Default the view to the admin's OWN data, shown LIVE from the local
    // session log (source 'live') — the richest, real-time view of themselves.
    adminSelected = adminEmail;

    updateDashChrome();
    updateAdminHint();
    buildAdminUserList();
    refresh();           // paint cards/chart/mini for the default (live) view
    renderAdminTable();  // + the detail table
  } catch {
    /* admin view is additive — any failure just leaves it hidden */
  }
}

// Refresh the detail-table sub-title + heading to reflect the current pick.
function updateAdminHint() {
  const hint = document.getElementById('adminHint');
  const tableTitle = document.getElementById('adminTableTitle');
  if (!adminSelected) {
    const totalUsers = adminUsers().length;
    if (hint) hint.textContent = `All teammates · ${totalUsers} ${totalUsers === 1 ? 'person' : 'people'}`;
    if (tableTitle) tableTitle.textContent = 'Daily Breakdown — All Teammates';
    return;
  }
  const u = adminUsers().find((x) => x.email === adminSelected);
  const who = u ? (u.name || u.email) : adminSelected;
  if (hint) hint.textContent = `Daily rows for ${who}`;
  if (tableTitle) tableTitle.textContent = 'Daily Breakdown';
}

// Commit whatever is in the input to the active selection, then repaint the
// WHOLE dashboard (cards, chart, mini-cards) + the detail table for the pick.
function applyAdminSelection() {
  const input = document.getElementById('adminUserSelect');
  if (!input) return;
  const next = resolveAdminSelection(input.value);
  const changed = next !== adminSelected;
  adminSelected = next;
  buildAdminUserList(); // normalize the input text to the canonical label
  updateDashChrome();
  updateAdminHint();
  if (changed) refresh(); // swaps the data source and repaints everything
  renderAdminTable();
}

// Update the page title/subtitle to reflect whose data is on screen.
function updateDashChrome() {
  const title = document.getElementById('dashTitle');
  const subtitle = document.getElementById('dashSubtitle');
  const source = dashboardSource();
  if (source === 'live') {
    if (title) title.textContent = 'Your Brew Insights';
    if (subtitle) subtitle.textContent = "How much you've kept your Mac awake";
  } else if (source === 'all') {
    if (title) title.textContent = 'Team Brew Insights';
    if (subtitle) subtitle.textContent = "Everyone's brewing, combined";
  } else {
    const u = adminUsers().find((x) => x.email === adminSelected);
    const who = u ? (u.name || u.email) : adminSelected;
    if (title) title.textContent = `${who}'s Brew Insights`;
    if (subtitle) subtitle.textContent = 'From their recorded daily usage';
  }
}

// Wire the user dropdown + sortable headers once at load.
function wireAdminControls() {
  const input = document.getElementById('adminUserSelect');
  if (input) {
    // 'change' fires when a datalist option is picked or the field is committed;
    // 'blur' catches free typing. Enter also commits.
    input.addEventListener('change', applyAdminSelection);
    input.addEventListener('blur', applyAdminSelection);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    });
    // Select-all on focus so a click lets the admin type a fresh name at once.
    input.addEventListener('focus', () => input.select());
  }
  document.querySelectorAll('.admin-table th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (adminSort.key === key) adminSort.dir *= -1;
      else adminSort = { key, dir: key === 'date' ? -1 : 1 };
      renderAdminTable();
    });
  });
}

// ---- Data + events ---------------------------------------------------------

// Rows feeding the currently-selected view: one teammate, or everyone for All.
function selectedRows() {
  const all = Array.isArray(adminRows) ? adminRows : [];
  if (!adminSelected) return all; // All teammates
  return all.filter((r) => String(r['Email'] || '').trim().toLowerCase() === adminSelected);
}

// Repaint the entire dashboard from the reconstructed insights of a non-live
// selection (a teammate or the cumulative All view). No network — the sheet
// rows are already cached in adminRows.
function renderFromSheet() {
  insights = insightsFromRows(selectedRows(), Date.now());
  render();
}

async function refresh() {
  // For a teammate / All selection the data is the cached sheet rows, not the
  // local session log — rebuild from those instead of pulling statsGet().
  if (dashboardSource() !== 'live') {
    renderFromSheet();
    return;
  }
  try {
    const data = await window.brew.statsGet();
    if (data) {
      insights = data;
      render();
    }
  } catch {
    /* ignore transient IPC errors */
  }
}

// Period tabs.
document.getElementById('periodTabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.period-tab');
  if (!tab) return;
  period = tab.dataset.period;
  document.querySelectorAll('.period-tab').forEach((t) => t.classList.toggle('active', t === tab));
  renderChart();
});

// Live refresh when the main process signals a change (start/stop) or re-show.
if (window.brew.onStatsRefresh) {
  window.brew.onStatsRefresh(() => refresh());
}

// Live update: while a session is in progress the numbers change every second,
// so re-pull once per second. When idle we still refresh (cheaply) so the view
// stays current if data changes from elsewhere; the in-place bar updates make
// this smooth with no flicker. A teammate / All view is static sheet data, so
// we skip the tick there (the selection handler repaints on demand).
setInterval(() => { if (dashboardSource() === 'live') refresh(); }, 1000);

refresh();

// Admin "Team Usage" panel: wire controls, then load once (it self-hides for
// non-admins). This is a network round-trip to the web app, so it runs once at
// open rather than on the 1s tick.
wireAdminControls();
loadAdmin();
