const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const SomaClient = require('./soma-client');
const Updater = require('./updater');

let mainWindow;
// In-app updater: reads Brew's latest published Release on SOMA and swaps the
// bundle in place. Wired up in app.whenReady (SomaClient's `net` needs ready).
let updater = null;
let soma = null;
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

// Mouse jiggle interval in ms (every 4 minutes - well under Slack's 10min timeout)
const JIGGLE_INTERVAL = 4 * 60 * 1000;

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
  }

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

function startCaffeinate() {
  if (!isConnected()) return; // gated: no SOMA connection, no brewing
  if (caffeinateProcess) return;

  caffeinateProcess = spawn('caffeinate', ['-d', '-i', '-s', '-u'], {
    stdio: 'ignore',
    detached: false
  });

  caffeinateProcess.on('error', (err) => {
    console.error('Failed to start caffeinate:', err);
    isAwake = false;
    notifyRenderer();
  });

  caffeinateProcess.on('exit', () => {
    caffeinateProcess = null;
    isAwake = false;
    notifyRenderer();
    updateTrayMenu();
  });

  isAwake = true;
  notifyRenderer();
  updateTrayMenu();
}

function stopCaffeinate() {
  if (caffeinateProcess) {
    caffeinateProcess.kill('SIGTERM');
    caffeinateProcess = null;
  }
  isAwake = false;
  notifyRenderer();
  updateTrayMenu();
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

  // Also start caffeinate if not already running
  if (!isAwake) {
    startCaffeinate();
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
  notifyRenderer();
  updateTrayMenu();
}

// ===== NOTIFY RENDERER =====

function notifyRenderer() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('status-changed', { isAwake, isSlackMode });
  }
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
  return { isAwake, isSlackMode };
});

ipcMain.handle('get-status', () => ({ isAwake, isSlackMode }));

ipcMain.handle('turn-on', () => {
  startCaffeinate();
  return { isAwake, isSlackMode };
});

ipcMain.handle('turn-off', () => {
  stopCaffeinate();
  if (isSlackMode) stopMouseJiggle();
  return { isAwake, isSlackMode };
});

ipcMain.handle('toggle-slack-mode', () => {
  if (isSlackMode) {
    stopMouseJiggle();
  } else {
    startMouseJiggle();
  }
  return { isAwake, isSlackMode };
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
  stopCaffeinate();
  stopMouseJiggle();
  updateTrayMenu();
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

// ===== APP LIFECYCLE =====

app.whenReady().then(() => {
  // Create the SOMA client FIRST — createWindow() consults isConnected() to
  // decide between the lock screen (gate.html) and the main UI (index.html).
  // `net` (used by SomaClient) is only usable after whenReady, which holds here.
  soma = new SomaClient({ owner: 'ssenapati', repo: 'Brew' });

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
      stopCaffeinate();
      stopMouseJiggle();
    },
    // When a background check finds a newer release, tell the renderer so it
    // can show a centered "update available" prompt. The renderer decides
    // whether to actually display it (it honors a 24h per-version snooze).
    onUpdateAvailable: (info) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update:available', info);
      }
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
  stopCaffeinate();
  stopMouseJiggle();
});
