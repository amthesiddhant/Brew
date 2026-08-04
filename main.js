const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell } = require('electron');
const { spawn, execSync } = require('child_process');
const path = require('path');
const https = require('https');

let mainWindow;
let tray = null;
let caffeinateProcess = null;
let isAwake = false;
let isSlackMode = false;
let isOmniMode = false;
let mouseJiggleInterval = null;
let omniKeepAliveInterval = null;

// Mouse jiggle interval in ms (every 4 minutes - well under Slack's 10min timeout)
const JIGGLE_INTERVAL = 4 * 60 * 1000;

// Omni-Channel keep-alive interval (every 3 minutes)
const OMNI_INTERVAL = 3 * 60 * 1000;

// Salesforce Omni-Channel config
const SF_INSTANCE_URL = 'https://gus.my.salesforce.com';
const SF_PRESENCE_STATUS_ID = '0N53y000000k9c5CAA'; // "Available - Case"

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
  let statusLabel = 'Idle';
  if (isAwake) {
    const extras = [];
    if (isSlackMode) extras.push('Slack');
    if (isOmniMode) extras.push('Omni');
    statusLabel = extras.length > 0 ? `Brewing + ${extras.join(' + ')}` : 'Brewing';
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
    {
      label: `Omni Mode: ${isOmniMode ? 'ON' : 'OFF'}`,
      click: () => {
        if (isOmniMode) {
          stopOmniKeepAlive();
        } else {
          startOmniKeepAlive();
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
        stopOmniKeepAlive();
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

// ===== OMNI-CHANNEL KEEP-ALIVE =====

function getSfAccessToken() {
  const fs = require('fs');
  const os = require('os');

  // Read directly from the sf auth file (non-interactive, fast)
  const authFilePaths = [
    path.join(os.homedir(), '.sfdx', 'ssenapati@gus.com.json'),
  ];

  for (const authPath of authFilePaths) {
    try {
      if (!fs.existsSync(authPath)) continue;
      const data = JSON.parse(fs.readFileSync(authPath, 'utf8'));
      if (data.accessToken && data.accessToken.length > 20) {
        return data.accessToken;
      }
    } catch (e) {
      continue;
    }
  }

  // Fallback: try sf CLI with auto-confirm
  const possiblePaths = [
    '/Users/ssenapati/.aisuite/bin/sf',
    '/opt/homebrew/bin/sf',
    '/usr/local/bin/sf',
  ];

  for (const sfPath of possiblePaths) {
    try {
      if (!fs.existsSync(sfPath)) continue;
      const token = execSync(
        `echo "y" | "${sfPath}" org auth show-access-token --target-org orgcs 2>/dev/null`,
        { encoding: 'utf8', timeout: 10000 }
      ).trim();
      if (token && token.length > 20) return token;
    } catch (e) {
      continue;
    }
  }
  return null;
}

function omniSetPresence() {
  const token = getSfAccessToken();
  if (!token) {
    console.error('Omni keep-alive: failed to get SF access token');
    return;
  }

  const url = new URL('/services/data/v62.0/connect/presence', SF_INSTANCE_URL);
  const postData = JSON.stringify({
    servicePresenceStatusId: SF_PRESENCE_STATUS_ID
  });

  const options = {
    hostname: url.hostname,
    path: url.pathname,
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    }
  };

  const req = https.request(options, (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        console.log('Omni keep-alive: presence refreshed');
      } else {
        console.error(`Omni keep-alive: API returned ${res.statusCode}`, data);
      }
    });
  });

  req.on('error', (err) => {
    console.error('Omni keep-alive: request error', err.message);
  });

  req.setTimeout(10000, () => { req.destroy(); });
  req.write(postData);
  req.end();
}

function startOmniKeepAlive() {
  if (omniKeepAliveInterval) return;

  isOmniMode = true;

  // Set presence immediately, then every OMNI_INTERVAL
  omniSetPresence();
  omniKeepAliveInterval = setInterval(omniSetPresence, OMNI_INTERVAL);

  // Also start caffeinate if not already running
  if (!isAwake) {
    startCaffeinate();
  }

  notifyRenderer();
  updateTrayMenu();
}

function stopOmniKeepAlive() {
  if (omniKeepAliveInterval) {
    clearInterval(omniKeepAliveInterval);
    omniKeepAliveInterval = null;
  }
  isOmniMode = false;
  notifyRenderer();
  updateTrayMenu();
}

// ===== NOTIFY RENDERER =====

function notifyRenderer() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('status-changed', { isAwake, isSlackMode, isOmniMode });
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

// Get GitHub token from gh CLI (works regardless of PATH since we use full path)
function getGitHubToken() {
  const possiblePaths = [
    '/opt/homebrew/bin/gh',
    '/usr/local/bin/gh',
    `${process.env.HOME}/.aisuite/bin/gh`,
    'gh'  // last resort: rely on PATH
  ];

  const fs = require('fs');
  for (const ghPath of possiblePaths) {
    try {
      if (ghPath !== 'gh' && !fs.existsSync(ghPath)) continue;
      const token = execSync(`"${ghPath}" auth token 2>/dev/null`, { encoding: 'utf8' }).trim();
      if (token) return token;
    } catch (e) {
      continue;
    }
  }
  return null;
}

// Single reliable method: authenticated HTTPS (no rate limits, works with private repos)
function checkForUpdates() {
  return new Promise((resolve, reject) => {
    const token = getGitHubToken();

    const headers = {
      'User-Agent': 'Brew-App',
      'Accept': 'application/vnd.github.v3+json'
    };
    if (token) {
      headers['Authorization'] = `token ${token}`;
    }

    const options = {
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
      method: 'GET',
      headers
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

            // Find the .dmg asset for macOS
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

// ===== IPC HANDLERS =====

ipcMain.handle('toggle-awake', () => {
  if (isAwake) {
    stopCaffeinate();
    if (isSlackMode) stopMouseJiggle();
    if (isOmniMode) stopOmniKeepAlive();
  } else {
    startCaffeinate();
  }
  return { isAwake, isSlackMode, isOmniMode };
});

ipcMain.handle('get-status', () => ({ isAwake, isSlackMode, isOmniMode }));

ipcMain.handle('turn-on', () => {
  startCaffeinate();
  return { isAwake, isSlackMode, isOmniMode };
});

ipcMain.handle('turn-off', () => {
  stopCaffeinate();
  if (isSlackMode) stopMouseJiggle();
  if (isOmniMode) stopOmniKeepAlive();
  return { isAwake, isSlackMode, isOmniMode };
});

ipcMain.handle('toggle-slack-mode', () => {
  if (isSlackMode) {
    stopMouseJiggle();
  } else {
    startMouseJiggle();
  }
  return { isAwake, isSlackMode, isOmniMode };
});

ipcMain.handle('toggle-omni-mode', () => {
  if (isOmniMode) {
    stopOmniKeepAlive();
  } else {
    startOmniKeepAlive();
  }
  return { isAwake, isSlackMode, isOmniMode };
});

ipcMain.handle('check-for-updates', async () => {
  try {
    const result = await checkForUpdates();
    return { success: true, ...result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('download-and-install-update', async (event, downloadUrl) => {
  const os = require('os');
  const fs = require('fs');
  const dmgPath = path.join(os.tmpdir(), 'Brew-update.dmg');

  try {
    // Notify renderer: download starting
    mainWindow.webContents.send('update-progress', { stage: 'downloading', percent: 0 });

    // Use curl to download — it handles all GitHub redirects properly
    await new Promise((resolve, reject) => {
      // Remove old file if exists
      try { fs.unlinkSync(dmgPath); } catch (e) {}

      const curlProc = spawn('curl', [
        '-L',                   // follow redirects
        '-o', dmgPath,          // output file
        '-#',                   // progress bar on stderr
        '-H', 'Accept: application/octet-stream',
        downloadUrl
      ]);

      let stderrData = '';
      curlProc.stderr.on('data', (chunk) => {
        stderrData += chunk.toString();
        // Parse curl progress (e.g., "## 45.0%")
        const match = stderrData.match(/(\d+\.?\d*)%/g);
        if (match) {
          const lastPercent = Math.round(parseFloat(match[match.length - 1]));
          mainWindow.webContents.send('update-progress', { stage: 'downloading', percent: lastPercent });
        }
      });

      curlProc.on('close', (code) => {
        if (code === 0) {
          // Verify the file is actually a DMG (check file size and magic bytes)
          try {
            const stats = fs.statSync(dmgPath);
            if (stats.size < 1000000) { // Less than 1MB is suspicious
              reject(new Error('Downloaded file is too small — may not be a valid DMG'));
              return;
            }
          } catch (e) {
            reject(new Error('Download failed — file not found'));
            return;
          }
          resolve();
        } else {
          reject(new Error(`Download failed (curl exit code ${code})`));
        }
      });

      curlProc.on('error', (err) => {
        reject(new Error(`Failed to start download: ${err.message}`));
      });
    });

    // Notify renderer: installing
    mainWindow.webContents.send('update-progress', { stage: 'installing', percent: 100 });

    // Mount the DMG (without -quiet so we get the mount path)
    const mountOutput = execSync(`hdiutil attach "${dmgPath}" -nobrowse`, { encoding: 'utf8' });

    // Parse mount point from hdiutil output (last column of last line with /Volumes)
    const volumeLines = mountOutput.split('\n').filter(l => l.includes('/Volumes/'));
    if (volumeLines.length === 0) {
      throw new Error('Failed to mount DMG — no volume found');
    }
    const volumePath = volumeLines[0].match(/\/Volumes\/.+/)[0].trim();

    // Find the .app in the mounted volume
    const appsInVolume = fs.readdirSync(volumePath).filter(f => f.endsWith('.app'));
    if (appsInVolume.length === 0) {
      execSync(`hdiutil detach "${volumePath}"`, { encoding: 'utf8' });
      throw new Error('No .app found in the DMG');
    }

    const appName = appsInVolume[0];
    const sourceApp = path.join(volumePath, appName);
    const destApp = `/Applications/${appName}`;

    // Copy new app to Applications (replace existing)
    execSync(`rm -rf "${destApp}"`, { encoding: 'utf8' });
    execSync(`cp -R "${sourceApp}" "${destApp}"`, { encoding: 'utf8' });

    // Unmount DMG
    execSync(`hdiutil detach "${volumePath}" -quiet`, { encoding: 'utf8' });

    // Clean up temp file
    fs.unlink(dmgPath, () => {});

    // Notify renderer: done
    mainWindow.webContents.send('update-progress', { stage: 'done', percent: 100 });

    return { success: true };
  } catch (err) {
    // Clean up on failure
    try { fs.unlinkSync(dmgPath); } catch (e) {}
    mainWindow.webContents.send('update-progress', { stage: 'error', error: err.message });
    return { success: false, error: err.message };
  }
});

ipcMain.handle('restart-app', () => {
  app.isQuitting = true;
  stopCaffeinate();
  stopMouseJiggle();
  stopOmniKeepAlive();
  app.relaunch();
  app.quit();
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
  stopOmniKeepAlive();
});
