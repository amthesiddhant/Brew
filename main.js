const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, Notification } = require('electron');
const { spawn, execFile } = require('child_process');
const path = require('path');
const SomaClient = require('./soma-client');
const Updater = require('./updater');
const Stats = require('./stats');
const Settings = require('./settings');
const access = require('./access');
const webapp = require('./webapp');
const UsageSync = require('./usage-sync');

let mainWindow;
// Separate, larger window for the usage-insights dashboard. Created lazily the
// first time the user opens it; hidden (not destroyed) on close so re-opening
// is instant.
let dashboardWindow = null;
// Usage stats recorder. Instantiated in whenReady (needs app.getPath). Records
// every brew session to userData and aggregates it for the dashboard.
let stats = null;
// Monotonic-ish clock used for stat timestamps. `Date.now` is the real wall
// clock here (this is the main process, not a workflow sandbox).
function nowMs() {
  return Date.now();
}
// In-app updater: reads Brew's latest published Release on SOMA and swaps the
// bundle in place. Wired up in app.whenReady (SomaClient's `net` needs ready).
let updater = null;
let soma = null;
// Best-effort usage-tracking sync: mirrors the local session log to a Google
// Sheet (one row per user per day) via the Apps Script Web App. Instantiated in
// whenReady (needs soma + stats). All calls are fire-and-forget.
let usageSync = null;
// Debounce so overlapping triggers (stop-brewing + quit firing together) don't
// stack up web-app round-trips.
let usageSyncTimer = null;
function scheduleUsageSync(delayMs = 1500) {
  if (!usageSync) return;
  if (usageSyncTimer) clearTimeout(usageSyncTimer);
  usageSyncTimer = setTimeout(() => {
    usageSyncTimer = null;
    // Only sync for a connected user; identity is meaningless without a SOMA
    // connection. Never throws (usageSync.sync swallows).
    if (isConnected()) usageSync.sync(nowMs());
  }, delayMs);
}
// SOMA gate: Brew will not proceed to its main UI without a saved SOMA token.
// The window boots into gate.html (lock screen) and only loads index.html once
// connected. Disconnecting re-locks the window.
function isConnected() {
  return !!(soma && soma.hasToken());
}
let tray = null;
let caffeinateProcess = null;
let isAwake = false;
let isSlackMode = false;
let mouseJiggleInterval = null;

// User settings (auto-off timer + idle/battery guards). Instantiated in
// whenReady (needs app.getPath).
let settings = null;

// Auto-off ("Brew for…"): every brew is started with a duration, so `brewEndsAt`
// is the epoch-ms deadline and `autoOffTimer` fires stopCaffeinate at it. The
// renderer reads brewEndsAt to paint a countdown.
let autoOffTimer = null;
let brewEndsAt = null;
// Poller (every AUTO_STOP_TICK_MS while brewing) for the lid + battery guards.
let autoStopPoll = null;
// Why the last auto-stop happened, so we notify with the right message and the
// renderer/tray can reset cleanly. One of: 'timer' | 'lid' | 'battery' | null.
let lastAutoStopReason = null;

// Mouse jiggle interval in ms (every 4 minutes - well under Slack's 10min timeout)
const JIGGLE_INTERVAL = 4 * 60 * 1000;
// How often the lid/battery guard poller runs while brewing.
const AUTO_STOP_TICK_MS = 30 * 1000;
// Fixed low-battery cutoff: when the battery guard is on and we're on battery
// power at or below this charge, brewing stops. Not user-configurable.
const BATTERY_GUARD_PCT = 10;

const CURRENT_VERSION = require('./package.json').version;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 680,
    resizable: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1a1a2e',
    icon: path.join(__dirname, 'assets', 'icon.icns'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // Gate: without a saved SOMA token, boot into the lock screen instead of the
  // main UI. index.html is only loaded once the user is connected.
  mainWindow.loadFile(isConnected() ? 'index.html' : 'gate.html');

  // Set the dock icon explicitly on macOS
  if (process.platform === 'darwin') {
    const dockIcon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'));
    app.dock.setIcon(dockIcon);
  }

  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      // Hide dock icon when window is closed — behave as a tray-only app
      if (process.platform === 'darwin') {
        app.dock.hide();
      }
    }
  });
}

// Open (or focus) the insights dashboard in its own larger window. Gated the
// same way the rest of the app is: no SOMA connection, no dashboard.
function openDashboard() {
  if (!isConnected()) return;

  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    if (process.platform === 'darwin') app.dock.show();
    dashboardWindow.show();
    dashboardWindow.focus();
    dashboardWindow.webContents.send('stats-refresh');
    return;
  }

  dashboardWindow = new BrowserWindow({
    width: 920,
    height: 720,
    minWidth: 760,
    minHeight: 560,
    title: 'Brew Insights',
    backgroundColor: '#1a1a2e',
    titleBarStyle: 'hiddenInset',
    icon: path.join(__dirname, 'assets', 'icon.icns'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  dashboardWindow.loadFile('dashboard.html');

  // Hide instead of destroy so re-opening is instant and keeps scroll state.
  dashboardWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      dashboardWindow.hide();
    }
  });
}

function createTray() {
  let trayIcon;
  try {
    const trayIconPath = path.join(__dirname, 'assets', 'tray-icon.png');
    trayIcon = nativeImage.createFromPath(trayIconPath);
  } catch (e) {
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  updateTrayMenu();

  tray.on('click', () => {
    if (mainWindow.isVisible()) {
      mainWindow.hide();
      // Hide dock icon when window is hidden via tray click
      if (process.platform === 'darwin') {
        app.dock.hide();
      }
    } else {
      // Show dock icon and window when bringing app back from tray
      if (process.platform === 'darwin') {
        app.dock.show();
      }
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function updateTrayMenu() {
  // Gated: without a SOMA connection, the tray only lets the user open the
  // lock screen (to connect) or quit — no brewing controls.
  if (!isConnected()) {
    const lockedMenu = Menu.buildFromTemplate([
      { label: 'Brew: Locked — connect to SOMA', enabled: false },
      { type: 'separator' },
      {
        label: 'Connect to SOMA…',
        click: () => {
          if (process.platform === 'darwin') app.dock.show();
          if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
        }
      },
      { type: 'separator' },
      {
        label: 'Quit Brew',
        click: () => {
          app.isQuitting = true;
          stopCaffeinate();
          stopMouseJiggle();
          app.quit();
        }
      }
    ]);
    tray.setContextMenu(lockedMenu);
    tray.setToolTip('Brew - Locked (connect to SOMA)');
    return;
  }

  let statusLabel = 'Idle';
  if (isAwake) {
    statusLabel = isSlackMode ? 'Brewing + Slack' : 'Brewing';
    if (brewEndsAt) {
      const leftMin = Math.max(0, Math.round((brewEndsAt - nowMs()) / 60000));
      statusLabel += ` · ${leftMin}m left`;
    }
  }

  // Duration presets for the "Brew for…" submenu (minutes). Always bounded —
  // the timer maxes out at 8 hours; there is no open-ended brew.
  const DURATION_PRESETS = [
    { label: '15 minutes', min: 15 },
    { label: '30 minutes', min: 30 },
    { label: '1 hour', min: 60 },
    { label: '2 hours', min: 120 },
    { label: '4 hours', min: 240 },
    { label: '8 hours', min: 480 },
  ];

  const contextMenu = Menu.buildFromTemplate([
    {
      label: `Brew: ${statusLabel}`,
      enabled: false
    },
    { type: 'separator' },
    {
      label: isAwake ? 'Stop Brewing' : 'Start Brewing',
      click: () => {
        if (isAwake) {
          stopCaffeinate();
        } else {
          startCaffeinate();
        }
      }
    },
    {
      label: 'Brew for',
      enabled: !isAwake, // pick a duration only when starting fresh
      submenu: DURATION_PRESETS.map((p) => ({
        label: p.label,
        click: () => {
          if (settings) settings.set({ autoOffMin: p.min });
          startCaffeinate(p.min > 0 ? p.min * 60 * 1000 : 0);
        },
      })),
    },
    {
      label: `Slack Mode: ${isSlackMode ? 'ON' : 'OFF'}`,
      click: () => {
        if (isSlackMode) {
          stopMouseJiggle();
        } else {
          startMouseJiggle();
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Insights…',
      click: () => {
        if (process.platform === 'darwin') app.dock.show();
        openDashboard();
      }
    },
    {
      label: 'Check for Updates',
      click: async () => {
        // Show window and trigger update check in renderer
        if (process.platform === 'darwin') {
          app.dock.show();
        }
        mainWindow.show();
        mainWindow.focus();
        mainWindow.webContents.send('trigger-update-check');
      }
    },
    { type: 'separator' },
    {
      label: 'Show Brew',
      click: () => {
        // Restore dock icon and show window
        if (process.platform === 'darwin') {
          app.dock.show();
        }
        mainWindow.show();
        mainWindow.focus();
      }
    },
    {
      label: 'Quit Brew',
      click: () => {
        app.isQuitting = true;
        stopCaffeinate();
        stopMouseJiggle();
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
  tray.setToolTip(isAwake ? 'Brew - Keeping Mac Awake' : 'Brew - Mac Can Sleep');
}

// ===== CAFFEINATE (Keep Mac Awake) =====

// Start brewing. durationMs (optional) auto-stops after that long. Every brew
// is bounded: a missing/zero duration falls back to the saved autoOffMin preset
// (15 min – 8 h), so the tray "Start Brewing" and the renderer both honor the
// user's last choice.
function startCaffeinate(durationMs) {
  if (!isConnected()) return; // gated: no SOMA connection, no brewing
  if (caffeinateProcess) return;

  caffeinateProcess = spawn('caffeinate', ['-d', '-i', '-s', '-u'], {
    stdio: 'ignore',
    detached: false
  });

  caffeinateProcess.on('error', (err) => {
    console.error('Failed to start caffeinate:', err);
    isAwake = false;
    clearAutoOff();
    stopAutoStopPoll();
    notifyRenderer();
  });

  caffeinateProcess.on('exit', () => {
    caffeinateProcess = null;
    isAwake = false;
    clearAutoOff();
    stopAutoStopPoll();
    notifyRenderer();
    updateTrayMenu();
  });

  isAwake = true;
  lastAutoStopReason = null;

  // Resolve the auto-off duration. Every brew is bounded now, so a positive
  // arg wins; anything else (undefined/0/invalid) falls back to the saved
  // preset (itself clamped to 15 min – 8 h).
  let ms = typeof durationMs === 'number' && durationMs > 0 ? durationMs : 0;
  if (!ms) {
    const mins = settings ? settings.get().autoOffMin : 60;
    ms = mins * 60 * 1000;
  }
  clearAutoOff();
  brewEndsAt = nowMs() + ms;
  autoOffTimer = setTimeout(() => autoStop('timer'), ms);

  // Start the lid/battery guard poller (both guards are always on).
  startAutoStopPoll();

  // Open a usage session for this brew stretch.
  if (stats) stats.startSession(nowMs(), isSlackMode);
  notifyRenderer();
  updateTrayMenu();
}

function stopCaffeinate() {
  if (caffeinateProcess) {
    caffeinateProcess.kill('SIGTERM');
    caffeinateProcess = null;
  }
  isAwake = false;
  clearAutoOff();
  stopAutoStopPoll();
  // Close the usage session (records duration + Slack time).
  if (stats) stats.endSession(nowMs());
  // Mirror the day's totals to the usage sheet (best-effort, debounced).
  scheduleUsageSync();
  notifyRenderer();
  updateTrayMenu();
}

// ===== SMART AUTO-OFF (timer + idle + battery) =====

// Cancel a pending auto-off timer and clear its deadline.
function clearAutoOff() {
  if (autoOffTimer) {
    clearTimeout(autoOffTimer);
    autoOffTimer = null;
  }
  brewEndsAt = null;
}

// Common path for every automatic stop (timer expiry, idle, low battery). Stops
// brewing exactly like a manual OFF — including Slack mode — then notifies.
function autoStop(reason) {
  if (!isAwake) return;
  lastAutoStopReason = reason;
  if (isSlackMode) stopMouseJiggle();
  stopCaffeinate();
  notifyAutoStopped(reason);
}

function startAutoStopPoll() {
  if (autoStopPoll) return;
  autoStopPoll = setInterval(evaluateAutoStop, AUTO_STOP_TICK_MS);
}

function stopAutoStopPoll() {
  if (autoStopPoll) {
    clearInterval(autoStopPoll);
    autoStopPoll = null;
  }
}

// Read battery charge % + whether we're on battery via `pmset -g batt`. Async
// (callback) so we never block the main thread; best-effort — on any error the
// guard simply doesn't trigger this tick. Output line looks like:
//   -InternalBattery-0 (id=...)\t82%; discharging; 3:14 remaining present: true
// and the header line says "Now drawing from 'Battery Power'|'AC Power'".
function readBattery(cb) {
  execFile('pmset', ['-g', 'batt'], { timeout: 4000 }, (err, stdout) => {
    if (err || !stdout) return cb(null);
    const onBattery = /drawing from ['"]?Battery/i.test(stdout);
    const m = stdout.match(/(\d+)%/);
    const pct = m ? Number(m[1]) : null;
    if (pct == null) return cb(null);
    cb({ pct, onBattery });
  });
}

// Whether the laptop lid is currently closed. macOS exposes this as
// `AppleClamshellState = Yes` in the IORegistry. Async (callback); best-effort —
// on any error or on a desktop Mac (key absent) we report "not closed" so the
// guard never fires spuriously.
function readLidClosed(cb) {
  execFile('ioreg', ['-r', '-k', 'AppleClamshellState', '-d', '4'], { timeout: 4000 }, (err, stdout) => {
    if (err || !stdout) return cb(false);
    const m = stdout.match(/"AppleClamshellState"\s*=\s*(Yes|No)/i);
    cb(!!m && /yes/i.test(m[1]));
  });
}

// Runs on the poll tick while brewing. Both guards are always on (built-in
// behavior, not user options): stop brewing when the laptop lid is closed, or
// when on battery at/below the fixed 10% cutoff.
function evaluateAutoStop() {
  if (!isAwake) return;

  // Lid guard: stop brewing when the laptop lid is closed.
  readLidClosed((closed) => {
    if (!isAwake) return;
    if (closed) autoStop('lid');
  });

  // Battery guard: only when actually running on battery, at/below 10%.
  readBattery((batt) => {
    if (!batt || !isAwake) return;
    if (batt.onBattery && batt.pct <= BATTERY_GUARD_PCT) {
      autoStop('battery');
    }
  });
}

// Fire a native notification explaining why brewing stopped on its own, so a
// backgrounded/tray app doesn't just silently go quiet.
function notifyAutoStopped(reason) {
  if (!Notification.isSupported()) return;
  const body = {
    timer: 'Your Brew timer finished — your Mac can sleep now.',
    lid: 'You closed the lid, so Brew stopped to let your Mac sleep.',
    battery: 'Battery dropped to 10%, so Brew stopped to save power.',
  }[reason] || 'Brewing has stopped.';

  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  const n = new Notification({
    title: 'Brew finished ☕',
    body,
    silent: false,
    icon: require('fs').existsSync(iconPath) ? iconPath : undefined,
  });
  n.on('click', () => {
    if (process.platform === 'darwin') app.dock.show();
    if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); }
  });
  n.show();
}

// ===== MOUSE JIGGLE (Keep Slack Online) =====

function jiggleMouse() {
  try {
    // Use osascript to move mouse by 1px and back - simulates activity
    // This keeps Slack/Teams/etc. from detecting idle
    const script = `
      tell application "System Events"
        set currentPos to do shell script "python3 -c \\"import Quartz; loc = Quartz.NSEvent.mouseLocation(); print(int(loc.x), int(loc.y))\\""
        set posWords to words of currentPos
        set curX to item 1 of posWords as integer
        set curY to item 2 of posWords as integer
      end tell

      do shell script "python3 -c \\"
import Quartz
import time
from Quartz import CGEventCreateMouseEvent, CGEventPost, kCGEventMouseMoved, kCGHIDEventTap, CGPointMake

# Get current position
loc = Quartz.NSEvent.mouseLocation()
screen_height = Quartz.CGDisplayPixelsHigh(Quartz.CGMainDisplayID())
x = loc.x
y = screen_height - loc.y

# Move 1px right
event = CGEventCreateMouseEvent(None, kCGEventMouseMoved, CGPointMake(x + 1, y), 0)
CGEventPost(kCGHIDEventTap, event)
time.sleep(0.1)

# Move back
event = CGEventCreateMouseEvent(None, kCGEventMouseMoved, CGPointMake(x, y), 0)
CGEventPost(kCGHIDEventTap, event)
\\""
    `;
    spawn('osascript', ['-e', script], { stdio: 'ignore' });
  } catch (err) {
    console.error('Mouse jiggle error:', err);
  }
}

function startMouseJiggle() {
  if (!isConnected()) return; // gated: no SOMA connection, no Slack mode
  if (mouseJiggleInterval) return;

  isSlackMode = true;

  // Jiggle immediately, then every JIGGLE_INTERVAL
  jiggleMouse();
  mouseJiggleInterval = setInterval(jiggleMouse, JIGGLE_INTERVAL);

  // Also start caffeinate if not already running. If a session is already open
  // (brewing was on), just mark the Slack sub-interval as starting now; if not,
  // startCaffeinate opens the session already flagged as Slack-active.
  if (!isAwake) {
    startCaffeinate();
  } else if (stats) {
    stats.setSlack(nowMs(), true);
  }

  notifyRenderer();
  updateTrayMenu();
}

function stopMouseJiggle() {
  if (mouseJiggleInterval) {
    clearInterval(mouseJiggleInterval);
    mouseJiggleInterval = null;
  }
  isSlackMode = false;
  // Close the Slack sub-interval, but leave the brew session itself open.
  if (stats) stats.setSlack(nowMs(), false);
  notifyRenderer();
  updateTrayMenu();
}

// ===== NOTIFY RENDERER =====

// The status the renderer paints its UI from. `brewEndsAt` (epoch ms or null)
// drives the countdown bar; `autoStopReason` lets the UI show why a brew ended
// on its own.
function statusPayload() {
  return { isAwake, isSlackMode, brewEndsAt, autoStopReason: lastAutoStopReason };
}

function notifyRenderer() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('status-changed', statusPayload());
  }
  // Keep the dashboard live: any start/stop changes the numbers.
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.webContents.send('stats-refresh');
  }
}

// ===== UPDATE NOTIFICATION =====
// A background check that finds a newer release both shows the in-app pop-up
// (via the renderer) and fires a native macOS notification, so the user is
// alerted even when Brew is in the background/tray. We de-dupe by version so
// the hourly re-check doesn't re-notify for the same release each hour.
let lastNotifiedVersion = null;

function notifyUpdateAvailable(info) {
  const version = info && info.version;
  if (!version || version === lastNotifiedVersion) return;
  if (!Notification.isSupported()) return;
  lastNotifiedVersion = version;

  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  const notification = new Notification({
    title: 'Brew update available',
    body: `Version ${version} is ready to install. Open Brew to update.`,
    silent: false,
    icon: require('fs').existsSync(iconPath) ? iconPath : undefined,
  });

  // Clicking the banner brings Brew forward so the in-app prompt is visible.
  notification.on('click', () => {
    if (process.platform === 'darwin') app.dock.show();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  notification.show();
}

// ===== UPDATE CHECKER =====
// The self-updater now lives in updater.js + soma-client.js: it reads Brew's
// latest published Release on SOMA (git.soma.salesforce.com) and swaps the app
// bundle in place. The old public-GitHub / gh-CLI path has been removed. See
// the `updater` instance wired up in app.whenReady() and the update:* IPC
// handlers below.

// ===== IPC HANDLERS =====

ipcMain.handle('toggle-awake', () => {
  if (isAwake) {
    stopCaffeinate();
    if (isSlackMode) stopMouseJiggle();
  } else {
    startCaffeinate();
  }
  return statusPayload();
});

ipcMain.handle('get-status', () => statusPayload());

// Optional { durationMs }: auto-off after that long (0/omitted = use the saved
// preset; explicit 0 = open-ended). Also persists the choice as the new preset
// so the UI and tray default to it next time.
ipcMain.handle('turn-on', (_evt, opts = {}) => {
  const durationMs = opts && typeof opts.durationMs === 'number' ? opts.durationMs : undefined;
  // Persist a positive duration as the new preset (clamped in settings). A
  // missing/zero duration means "use the saved preset" — don't overwrite it.
  if (settings && typeof durationMs === 'number' && durationMs > 0) {
    settings.set({ autoOffMin: Math.round(durationMs / 60000) });
  }
  startCaffeinate(durationMs);
  return statusPayload();
});

ipcMain.handle('turn-off', () => {
  stopCaffeinate();
  if (isSlackMode) stopMouseJiggle();
  return statusPayload();
});

ipcMain.handle('toggle-slack-mode', () => {
  if (isSlackMode) {
    stopMouseJiggle();
  } else {
    startMouseJiggle();
  }
  return statusPayload();
});

// ------------------------------ Settings ----------------------------------
// Just the auto-off timer preset (autoOffMin). Persisted in userData so the
// window pills and tray submenu default to the user's last pick. The lid and
// low-battery guards are always-on and not settings.
ipcMain.handle('settings:get', () => (settings ? settings.get() : null));

ipcMain.handle('settings:set', (_evt, patch = {}) => {
  if (!settings) return null;
  return settings.set(patch);
});

// ----------------------------- App updates --------------------------------
// SOMA connection + in-app update. The token is host-wide (repo scope) and
// stored encrypted via the OS keychain (safeStorage) — see soma-client.js.
ipcMain.handle('update:status', () => {
  return updater ? updater.getStatus() : { connected: false, currentVersion: CURRENT_VERSION };
});

// Open the SOMA token-creation page (user is already SSO'd in the browser).
ipcMain.handle('update:openTokenPage', () => {
  if (updater && updater.soma) return updater.soma.openTokenPage();
  return false;
});

// Save + verify a pasted token. Returns { ok, login?, message? }.
ipcMain.handle('update:connect', async (_evt, { token } = {}) => {
  if (!updater || !updater.soma) throw new Error('Updater not configured');
  updater.soma.saveToken(token);
  const result = await updater.soma.verifyToken();
  if (!result.ok) {
    // Bad token — don't leave it stored where it'll keep failing.
    updater.soma.clearToken();
  }
  return result;
});

ipcMain.handle('update:disconnect', () => {
  if (updater && updater.soma) updater.soma.clearToken();
  // Re-lock: stop everything and send the window back to the gate.
  if (stats) stats.finalizeOpenSession(nowMs());
  stopCaffeinate();
  stopMouseJiggle();
  updateTrayMenu();
  // Hide the dashboard too — it's gated behind the connection.
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.hide();
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadFile('gate.html');
  }
  return { connected: false };
});

// Called by the lock screen after a token is saved + verified: leave the gate
// and load the main UI. Guarded so it can't be used to bypass verification.
ipcMain.handle('unlock', () => {
  if (!isConnected()) return { unlocked: false };
  updateTrayMenu();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadFile('index.html');
  }
  return { unlocked: true };
});

// Check SOMA for a newer published release. Returns the check result.
ipcMain.handle('update:check', async () => {
  if (!updater) throw new Error('Updater not configured');
  return updater.checkForUpdates();
});

// Download + swap + relaunch. On success the app relaunches, so the renderer
// usually won't see the resolved value; { deferred: true } means the user
// chose "Later" at the confirm dialog.
ipcMain.handle('update:install', async () => {
  if (!updater) throw new Error('Updater not configured');
  return updater.downloadAndInstall();
});

// Live download progress for the UI to poll while installing.
ipcMain.handle('update:progress', () => {
  return updater
    ? { isDownloading: updater.isDownloading, progress: updater.downloadProgress }
    : { isDownloading: false, progress: 0 };
});

ipcMain.handle('get-app-version', () => {
  return CURRENT_VERSION;
});

// ----------------------------- Access gate --------------------------------
// Allowlist check via the Apps Script Web App (see access.js / webapp.js): it
// reads the shared "App Access" sheet with the owner's permissions and answers
// for the signed-in Google user. Identity for the cache is the connected SOMA
// account's email. Returns { allowed, email, reason, offline }. Fail OPEN on a
// thrown error (a gate bug must never brick the app), but honor a clean deny.
ipcMain.handle('access:check', async () => {
  if (!isConnected()) return { allowed: false, email: '', reason: 'not-connected', offline: false };
  try {
    return await access.check(() => soma.getIdentityEmail());
  } catch (_) {
    return { allowed: true, email: '', reason: 'gate-error', offline: false };
  }
});

// ----------------------------- Usage insights -----------------------------
// Open the dashboard window from the renderer (the "Insights" button).
ipcMain.handle('open-dashboard', () => {
  openDashboard();
  return { opened: true };
});

// Full aggregated insights payload for the dashboard. Gated: no connection,
// no data.
ipcMain.handle('stats:get', () => {
  if (!stats || !isConnected()) return null;
  return stats.getInsights(nowMs());
});

// Admin: is the signed-in user allowed to see everyone's usage? The web app
// decides from the caller's unspoofable Google identity + their Role in the
// "App Access" sheet — the client can only ASK. Fail CLOSED to non-admin on any
// error (the admin view is additive; hiding it never breaks the app).
ipcMain.handle('admin:whoami', async () => {
  if (!isConnected()) return { isAdmin: false, role: '', email: '' };
  try {
    const res = await webapp.call('whoAmI', {}, { interactive: true });
    if (res && res.ok) return { isAdmin: !!res.isAdmin, role: res.role || '', email: res.email || '' };
  } catch (_) { /* not configured / offline / not authorized → not admin */ }
  return { isAdmin: false, role: '', email: '' };
});

// Admin: all users' daily usage rows from the shared BrewUsage sheet. The web
// app enforces the admin check server-side and returns `forbidden` otherwise,
// so a non-admin can never pull other people's data even by calling directly.
ipcMain.handle('admin:getUsage', async () => {
  if (!isConnected()) return { ok: false, isAdmin: false, rows: [] };
  try {
    const res = await webapp.call('getUsage', {}, { interactive: true });
    if (res && res.ok) return { ok: true, isAdmin: true, rows: Array.isArray(res.rows) ? res.rows : [] };
    return { ok: false, isAdmin: false, rows: [], error: res && res.error };
  } catch (err) {
    return { ok: false, isAdmin: false, rows: [], error: err && err.message };
  }
});

// ===== APP LIFECYCLE =====

app.whenReady().then(() => {
  // Create the SOMA client FIRST — createWindow() consults isConnected() to
  // decide between the lock screen (gate.html) and the main UI (index.html).
  // `net` (used by SomaClient) is only usable after whenReady, which holds here.
  soma = new SomaClient({ owner: 'ssenapati', repo: 'Brew' });

  // Usage stats recorder (persists sessions under userData).
  stats = new Stats();

  // User settings (auto-off timer + idle/battery guards).
  settings = new Settings();

  // Usage-sheet sync (best-effort mirror to Google Sheets via the Web App).
  usageSync = new UsageSync({
    resolveIdentity: () => soma.getIdentity(),
    stats,
    appVersion: CURRENT_VERSION,
  });
  // Sync shortly after launch: reconciles today + yesterday, so a session that
  // ended while the app was closed (or spanned midnight) still lands in the
  // sheet. Delayed so startup isn't blocked; skips silently until connected.
  setTimeout(() => scheduleUsageSync(0), 12000);

  createWindow();
  createTray();

  // Wire up the in-app updater against Brew's own SOMA repo. Auto-check runs
  // 10s after launch, then hourly; it silently no-ops until the user has
  // connected a SOMA token.
  updater = new Updater({
    soma,
    // Stop keep-alive machinery before the updater relaunches the app.
    onBeforeRelaunch: () => {
      app.isQuitting = true;
      if (stats) stats.finalizeOpenSession(nowMs());
      stopCaffeinate();
      stopMouseJiggle();
    },
    // When a background check finds a newer release, tell the renderer so it
    // can show a centered "update available" prompt (the renderer honors a 24h
    // per-version snooze), AND fire a native macOS notification so the user is
    // alerted even when Brew is in the background or tray.
    onUpdateAvailable: (info) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update:available', info);
      }
      notifyUpdateAvailable(info);
    },
  });
  updater.startAutoCheck();
});

app.on('window-all-closed', () => {});

app.on('activate', () => {
  if (mainWindow) {
    if (process.platform === 'darwin') {
      app.dock.show();
    }
    mainWindow.show();
    mainWindow.focus();
  }
});

app.on('before-quit', () => {
  app.isQuitting = true;
  // Close any in-progress session so its time is recorded before we exit.
  if (stats) stats.finalizeOpenSession(nowMs());
  stopCaffeinate();
  stopMouseJiggle();
});
