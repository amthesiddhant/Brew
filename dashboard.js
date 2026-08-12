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
let adminFilter = '';        // current search text (lowercased)
let adminSort = { key: 'date', dir: -1 }; // default: newest date first

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

function adminRowMatches(row, q) {
  if (!q) return true;
  const name = String(row['Name'] || '').toLowerCase();
  const email = String(row['Email'] || '').toLowerCase();
  return name.includes(q) || email.includes(q);
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
  const rows = all
    .filter((r) => adminRowMatches(r, adminFilter))
    .sort((a, b) => compareRows(a, b, col, adminSort.dir));

  body.replaceChildren();
  if (rows.length === 0) {
    empty.style.display = 'flex';
    empty.querySelector('p').textContent = all.length === 0
      ? 'No team usage recorded yet.'
      : 'No rows match your filter.';
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
    const hint = document.getElementById('adminHint');
    if (hint) {
      const users = new Set(adminRows.map((r) => String(r['Email'] || '').toLowerCase()).filter(Boolean));
      hint.textContent = `${adminRows.length} row${adminRows.length === 1 ? '' : 's'} · ${users.size} teammate${users.size === 1 ? '' : 's'}`;
    }
    renderAdminTable();
  } catch {
    /* admin view is additive — any failure just leaves it hidden */
  }
}

// Wire admin search + sortable headers once at load.
function wireAdminControls() {
  const search = document.getElementById('adminSearch');
  if (search) {
    search.addEventListener('input', () => {
      adminFilter = search.value.trim().toLowerCase();
      renderAdminTable();
    });
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

async function refresh() {
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
// this smooth with no flicker.
setInterval(refresh, 1000);

refresh();

// Admin "Team Usage" panel: wire controls, then load once (it self-hides for
// non-admins). This is a network round-trip to the web app, so it runs once at
// open rather than on the 1s tick.
wireAdminControls();
loadAdmin();
