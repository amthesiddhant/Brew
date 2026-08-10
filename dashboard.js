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
