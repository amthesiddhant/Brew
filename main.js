const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell } = require('electron');
const { spawn, execSync } = require('child_process');
const path = require('path');
const https = require('https');

let mainWindow;
let tray = null;
let caffeinateProcess = null;
let isAwake = false;
let isSlackMode = false;
let mouseJiggleInterval = null;

// Mouse jiggle interval in ms (every 4 minutes - well under Slack's 10min timeout)
const JIGGLE_INTERVAL = 4 * 60 * 1000;

// GitHub repo for update checks
const GITHUB_OWNER = 'amthesiddhant';
const GITHUB_REPO = 'Brew';
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

  mainWindow.loadFile('index.html');

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
  const statusLabel = isAwake
    ? (isSlackMode ? 'Brewing + Slack Online' : 'Brewing')
    : 'Idle';

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

// ===== UPDATE CHECKER (GitHub Releases) =====

function compareVersions(v1, v2) {
  const parts1 = v1.replace(/^v/, '').split('.').map(Number);
  const parts2 = v2.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const a = parts1[i] || 0;
    const b = parts2[i] || 0;
    if (a > b) return 1;
    if (a < b) return -1;
  }
  return 0;
}

// Use `gh` CLI to check releases — works with private repos since gh is already authenticated
function checkViaGhCli() {
  return new Promise((resolve, reject) => {
    const ghProc = spawn('gh', [
      'api', `repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`
    ]);

    let data = '';
    let errorData = '';

    ghProc.stdout.on('data', (chunk) => { data += chunk; });
    ghProc.stderr.on('data', (chunk) => { errorData += chunk; });

    ghProc.on('close', (code) => {
      if (code === 0 && data) {
        try {
          const release = JSON.parse(data);
          const latestVersion = release.tag_name || release.name;
          const hasUpdate = compareVersions(latestVersion, CURRENT_VERSION) > 0;

          // Find the .dmg or .zip asset for macOS
          let downloadUrl = release.html_url;
          if (release.assets && release.assets.length > 0) {
            const macAsset = release.assets.find(a =>
              a.name.endsWith('.dmg') || a.name.endsWith('.zip') || a.name.includes('mac')
            );
            if (macAsset) {
              downloadUrl = macAsset.browser_download_url;
            }
          }

          resolve({
            currentVersion: CURRENT_VERSION,
            latestVersion: latestVersion.replace(/^v/, ''),
            hasUpdate,
            downloadUrl,
            releaseUrl: release.html_url,
            releaseNotes: release.body || '',
            releaseName: release.name || latestVersion
          });
        } catch (e) {
          reject(new Error('Failed to parse release data'));
        }
      } else {
        // gh CLI not available or repo has no releases
        if (errorData.includes('Not Found') || errorData.includes('404')) {
          resolve({
            currentVersion: CURRENT_VERSION,
            latestVersion: CURRENT_VERSION,
            hasUpdate: false,
            downloadUrl: null,
            releaseUrl: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases`,
            releaseNotes: '',
            releaseName: '',
            noReleases: true
          });
        } else {
          reject(new Error(errorData.trim() || `gh exited with code ${code}`));
        }
      }
    });

    ghProc.on('error', (err) => {
      reject(new Error('gh CLI not found — install GitHub CLI to check updates'));
    });
  });
}

// Fallback: unauthenticated HTTPS (works for public repos)
function checkViaHTTPS() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
      method: 'GET',
      headers: {
        'User-Agent': 'Brew-App',
        'Accept': 'application/vnd.github.v3+json'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const release = JSON.parse(data);
            const latestVersion = release.tag_name || release.name;
            const hasUpdate = compareVersions(latestVersion, CURRENT_VERSION) > 0;

            let downloadUrl = release.html_url;
            if (release.assets && release.assets.length > 0) {
              const macAsset = release.assets.find(a =>
                a.name.endsWith('.dmg') || a.name.endsWith('.zip') || a.name.includes('mac')
              );
              if (macAsset) {
                downloadUrl = macAsset.browser_download_url;
              }
            }

            resolve({
              currentVersion: CURRENT_VERSION,
              latestVersion: latestVersion.replace(/^v/, ''),
              hasUpdate,
              downloadUrl,
              releaseUrl: release.html_url,
              releaseNotes: release.body || '',
              releaseName: release.name || latestVersion
            });
          } catch (e) {
            reject(new Error('Failed to parse release data'));
          }
        } else if (res.statusCode === 404) {
          resolve({
            currentVersion: CURRENT_VERSION,
            latestVersion: CURRENT_VERSION,
            hasUpdate: false,
            downloadUrl: null,
            releaseUrl: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases`,
            releaseNotes: '',
            releaseName: '',
            noReleases: true
          });
        } else {
          reject(new Error(`GitHub API returned status ${res.statusCode}`));
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Request timed out')); });
    req.end();
  });
}

// Try gh CLI first (works with private repos), fall back to HTTPS
async function checkForUpdates() {
  try {
    return await checkViaGhCli();
  } catch (e) {
    return await checkViaHTTPS();
  }
}

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

ipcMain.handle('check-for-updates', async () => {
  try {
    const result = await checkForUpdates();
    return { success: true, ...result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('open-download-url', (event, url) => {
  shell.openExternal(url);
});

ipcMain.handle('get-app-version', () => {
  return CURRENT_VERSION;
});

// ===== APP LIFECYCLE =====

app.whenReady().then(() => {
  createWindow();
  createTray();
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
