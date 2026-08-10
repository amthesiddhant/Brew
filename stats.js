'use strict';

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

// ============================================================================
// Brew usage stats
//
// Brew never recorded anything before this — isAwake/isSlackMode lived only in
// memory. This module persists every brew *session* to an append-only JSON log
// in userData, then aggregates it into the Daily / Weekly / Monthly / All-time
// insights the dashboard shows.
//
// A "session" is one continuous stretch of the Mac being kept awake: it opens
// when brewing starts and closes when it stops (or when the app quits/relaunches
// while still brewing — see finalizeOpenSession). We also track how much of that
// stretch was spent in Slack mode.
//
// Storage shape (sessions.json):
//   { version: 1, sessions: [ { start, end, durationMs, slackMs }, ... ] }
// Timestamps are epoch ms. All bucketing is done in the user's LOCAL timezone
// (via Date) so "today" means the user's today.
// ============================================================================

const DAY_MS = 24 * 60 * 60 * 1000;

class Stats {
  constructor() {
    this.file = path.join(app.getPath('userData'), 'sessions.json');
    this.data = this._load();

    // The currently-open session, held in memory until brewing stops. We keep
    // slack sub-intervals so a session that toggled Slack on/off still reports
    // accurate Slack time.
    this.open = null; // { start, slackStart|null, slackAccumMs }
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.sessions)) return parsed;
    } catch (_) {
      /* first run or unreadable — start fresh */
    }
    return { version: 1, sessions: [] };
  }

  _save() {
    try {
      // Atomic-ish write: temp file + rename so a crash mid-write can't corrupt
      // the log.
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('Stats save failed:', err.message);
    }
  }

  // ---- Session lifecycle ---------------------------------------------------

  // Brewing started. now = epoch ms.
  startSession(now, slackActive) {
    if (this.open) return; // already open
    this.open = {
      start: now,
      slackStart: slackActive ? now : null,
      slackAccumMs: 0,
    };
  }

  // Slack mode toggled while a session is open.
  setSlack(now, slackActive) {
    if (!this.open) return;
    if (slackActive) {
      if (this.open.slackStart == null) this.open.slackStart = now;
    } else if (this.open.slackStart != null) {
      this.open.slackAccumMs += Math.max(0, now - this.open.slackStart);
      this.open.slackStart = null;
    }
  }

  // Brewing stopped. Close the open session and persist it.
  endSession(now) {
    if (!this.open) return;
    const o = this.open;
    let slackMs = o.slackAccumMs;
    if (o.slackStart != null) slackMs += Math.max(0, now - o.slackStart);

    const durationMs = Math.max(0, now - o.start);
    // Ignore accidental blips shorter than 1s — they'd just clutter the log.
    if (durationMs >= 1000) {
      this.data.sessions.push({
        start: o.start,
        end: now,
        durationMs,
        slackMs: Math.min(slackMs, durationMs),
      });
      this._save();
    }
    this.open = null;
  }

  // Called on quit/relaunch: if a session is still open, close it at `now` so
  // its time isn't lost. Best-effort.
  finalizeOpenSession(now) {
    if (this.open) this.endSession(now);
  }

  hasOpenSession() {
    return !!this.open;
  }

  // ---- Aggregation ---------------------------------------------------------

  // Start-of-day (local) for a given Date, as epoch ms.
  _startOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }

  // Sum a set of sessions into a compact summary.
  _summarize(sessions) {
    let totalMs = 0;
    let slackMs = 0;
    let longestMs = 0;
    for (const s of sessions) {
      totalMs += s.durationMs;
      slackMs += s.slackMs || 0;
      if (s.durationMs > longestMs) longestMs = s.durationMs;
    }
    const count = sessions.length;
    return {
      totalMs,
      slackMs,
      count,
      longestMs,
      avgMs: count ? Math.round(totalMs / count) : 0,
    };
  }

  // Build an array of daily buckets from `days` ago through today (local),
  // each { label, dayStart, totalMs, slackMs, count }. Includes any time from a
  // still-open session attributed to "now".
  _dailyBuckets(now, days) {
    const nowDate = new Date(now);
    const todayStart = this._startOfDay(nowDate);
    const buckets = [];
    const index = new Map(); // dayStart -> bucket

    for (let i = days - 1; i >= 0; i--) {
      const dayStart = todayStart - i * DAY_MS;
      const d = new Date(dayStart);
      const bucket = {
        dayStart,
        // Short weekday + day-of-month, e.g. "Mon 12". Rendered on the x-axis.
        label: d.toLocaleDateString(undefined, { weekday: 'short' }),
        dateLabel: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
        totalMs: 0,
        slackMs: 0,
        count: 0,
      };
      buckets.push(bucket);
      index.set(dayStart, bucket);
    }

    const addTo = (start, ms, slack) => {
      const ds = this._startOfDay(new Date(start));
      const b = index.get(ds);
      if (b) {
        b.totalMs += ms;
        b.slackMs += slack;
        b.count += 1;
      }
    };

    for (const s of this.data.sessions) addTo(s.start, s.durationMs, s.slackMs || 0);

    // Fold in the live open session so today reflects in-progress brewing.
    if (this.open) {
      const liveMs = Math.max(0, now - this.open.start);
      let liveSlack = this.open.slackAccumMs;
      if (this.open.slackStart != null) liveSlack += Math.max(0, now - this.open.slackStart);
      addTo(this.open.start, liveMs, Math.min(liveSlack, liveMs));
    }

    return buckets;
  }

  // Monthly buckets for the last `months` calendar months (local), oldest first.
  _monthlyBuckets(now, months) {
    const nowDate = new Date(now);
    const buckets = [];
    const index = new Map(); // "YYYY-M" -> bucket
    const key = (y, m) => `${y}-${m}`;

    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(nowDate.getFullYear(), nowDate.getMonth() - i, 1);
      const bucket = {
        key: key(d.getFullYear(), d.getMonth()),
        label: d.toLocaleDateString(undefined, { month: 'short' }),
        dateLabel: d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' }),
        totalMs: 0,
        slackMs: 0,
        count: 0,
      };
      buckets.push(bucket);
      index.set(bucket.key, bucket);
    }

    const addTo = (start, ms, slack) => {
      const d = new Date(start);
      const b = index.get(key(d.getFullYear(), d.getMonth()));
      if (b) {
        b.totalMs += ms;
        b.slackMs += slack;
        b.count += 1;
      }
    };

    for (const s of this.data.sessions) addTo(s.start, s.durationMs, s.slackMs || 0);
    if (this.open) {
      const liveMs = Math.max(0, now - this.open.start);
      let liveSlack = this.open.slackAccumMs;
      if (this.open.slackStart != null) liveSlack += Math.max(0, now - this.open.slackStart);
      addTo(this.open.start, liveMs, Math.min(liveSlack, liveMs));
    }

    return buckets;
  }

  // Sessions whose start falls on/after `since` (epoch ms), plus a synthetic
  // entry for the live open session so summaries include in-progress time.
  _sessionsSince(now, since) {
    const out = this.data.sessions.filter((s) => s.start >= since);
    if (this.open && this.open.start >= since) {
      const liveMs = Math.max(0, now - this.open.start);
      let liveSlack = this.open.slackAccumMs;
      if (this.open.slackStart != null) liveSlack += Math.max(0, now - this.open.slackStart);
      out.push({ start: this.open.start, end: now, durationMs: liveMs, slackMs: Math.min(liveSlack, liveMs) });
    }
    return out;
  }

  // Current consecutive-day brewing streak ending today (local). A day counts
  // if it has any recorded brew time.
  _currentStreak(now) {
    const active = new Set();
    for (const s of this.data.sessions) active.add(this._startOfDay(new Date(s.start)));
    if (this.open) active.add(this._startOfDay(new Date(this.open.start)));

    let streak = 0;
    let cursor = this._startOfDay(new Date(now));
    // If today has no activity yet, the streak is whatever ran up to yesterday.
    if (!active.has(cursor)) cursor -= DAY_MS;
    while (active.has(cursor)) {
      streak += 1;
      cursor -= DAY_MS;
    }
    return streak;
  }

  // The full payload the dashboard renders.
  getInsights(now) {
    const nowDate = new Date(now);
    const todayStart = this._startOfDay(nowDate);
    const weekStart = todayStart - 6 * DAY_MS; // rolling 7 days incl. today
    const monthStart = new Date(nowDate.getFullYear(), nowDate.getMonth(), 1).getTime();

    const daily = this._dailyBuckets(now, 7);
    const weekly = this._dailyBuckets(now, 7); // week view = last 7 daily bars
    const monthly = this._monthlyBuckets(now, 6);

    const firstStart = this.data.sessions.length
      ? Math.min(...this.data.sessions.map((s) => s.start))
      : this.open
      ? this.open.start
      : null;

    return {
      generatedAt: now,
      // True while a brew session is in progress right now — drives the
      // dashboard's live indicator and the per-second refresh feel.
      brewing: !!this.open,
      today: this._summarize(this._sessionsSince(now, todayStart)),
      week: this._summarize(this._sessionsSince(now, weekStart)),
      month: this._summarize(this._sessionsSince(now, monthStart)),
      allTime: this._summarize(this._sessionsSince(now, 0)),
      streak: this._currentStreak(now),
      firstSessionAt: firstStart,
      charts: {
        // 7 daily bars for the Daily/Weekly tabs, 6 monthly bars for Monthly.
        daily,
        weekly,
        monthly,
      },
    };
  }
}

module.exports = Stats;
