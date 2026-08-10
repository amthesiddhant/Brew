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
    return;
  }
  area.style.display = 'flex';
  empty.style.display = 'none';

  // Build bars. Height is a percentage of the tallest bar (min 2% so a tiny
  // non-zero value is still visible). Slack time is shown as a darker overlay
  // segment at the base of each bar.
  area.innerHTML = '';
  for (const b of buckets) {
    const pct = maxMs > 0 ? Math.max(b.totalMs > 0 ? 3 : 0, (b.totalMs / maxMs) * 100) : 0;
    const slackPct = b.totalMs > 0 ? Math.min(100, (b.slackMs / b.totalMs) * 100) : 0;

    const col = document.createElement('div');
    col.className = 'bar-col';

    const barWrap = document.createElement('div');
    barWrap.className = 'bar-wrap';

    const bar = document.createElement('div');
    bar.className = 'bar' + (b.totalMs > 0 ? '' : ' bar-empty');
    bar.style.height = `${pct}%`;

    // Slack overlay at the base of the bar.
    if (slackPct > 0) {
      const slack = document.createElement('div');
      slack.className = 'bar-slack';
      slack.style.height = `${slackPct}%`;
      bar.appendChild(slack);
    }

    // Value label floating above the bar.
    const val = document.createElement('span');
    val.className = 'bar-value';
    val.textContent = b.totalMs > 0 ? fmtShort(b.totalMs) : '';
    bar.appendChild(val);

    // Rich tooltip.
    const slackTxt = b.slackMs > 0 ? ` · ${fmtShort(b.slackMs)} on Slack` : '';
    barWrap.title = `${b.dateLabel}: ${fmtDuration(b.totalMs)}${slackTxt} · ${b.count} session${b.count === 1 ? '' : 's'}`;

    barWrap.appendChild(bar);

    const label = document.createElement('span');
    label.className = 'bar-label';
    label.textContent = b.label;

    col.appendChild(barWrap);
    col.appendChild(label);
    area.appendChild(col);
  }
}

function render() {
  if (!insights) return;
  renderCards();
  renderMini();
  renderChart();
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

// Reset with a confirm.
document.getElementById('dashReset').addEventListener('click', async () => {
  const ok = window.confirm('Clear all recorded Brew history? This cannot be undone.');
  if (!ok) return;
  await window.brew.statsReset();
  await refresh();
});

// Live refresh when the main process signals a change (start/stop) or re-show.
if (window.brew.onStatsRefresh) {
  window.brew.onStatsRefresh(() => refresh());
}

// While the window is open, re-pull every 30s so an in-progress session's
// "today"/live bar keeps ticking up.
setInterval(refresh, 30000);

refresh();
