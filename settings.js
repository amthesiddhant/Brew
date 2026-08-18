'use strict';

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

// ============================================================================
// Brew user settings
//
// Small JSON blob in userData for the "smart auto-off" preferences. Kept
// separate from sessions.json (stats) so a corrupt/first-run file just falls
// back to defaults without touching the usage log. Same atomic-write pattern as
// stats.js.
//
//   autoOffMin    Brew auto-off after N minutes. Always bounded (15 min – 8 h);
//                 there is no open-ended brew. Persisted as the last-picked
//                 preset so the UI + tray default to it next launch.
//
// The lid-closed and low-battery (10%) guards are NOT settings — they're always
// on, applied automatically by the main process. See main.js evaluateAutoStop().
// ============================================================================

// Bounds for the auto-off timer, in minutes.
const AUTO_OFF_MIN = 15;
const AUTO_OFF_MAX = 8 * 60; // 8 hours
const AUTO_OFF_DEFAULT = 60; // 1 hour

const DEFAULTS = {
  version: 1,
  autoOffMin: AUTO_OFF_DEFAULT,
};

// Clamp a value to [min, max]; non-numbers fall back to `def`.
function clampInt(v, min, max, def) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

class Settings {
  constructor() {
    this.file = path.join(app.getPath('userData'), 'settings.json');
    this.data = this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        return this._sanitize({ ...DEFAULTS, ...parsed });
      }
    } catch (_) {
      /* first run or unreadable — start from defaults */
    }
    return { ...DEFAULTS };
  }

  _save() {
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('Settings save failed:', err.message);
    }
  }

  // Coerce every field into a safe range so a hand-edited or stale file can't
  // feed nonsense (negative timers, 500%) into the auto-stop logic.
  _sanitize(d) {
    return {
      version: 1,
      autoOffMin: clampInt(d.autoOffMin, AUTO_OFF_MIN, AUTO_OFF_MAX, AUTO_OFF_DEFAULT),
    };
  }

  get() {
    return { ...this.data };
  }

  // Merge a partial patch, sanitize, persist, and return the new full settings.
  set(patch) {
    this.data = this._sanitize({ ...this.data, ...(patch || {}) });
    this._save();
    return this.get();
  }
}

module.exports = Settings;
