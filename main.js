const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const { spawn, execSync } = require('child_process');
const path = require('path');

let mainWindow;
let tray = null;
let caffeinateProcess = null;
let isAwake = false;
let isSlackMode = false;
let mouseJiggleInterval = null;

// Mouse jiggle interval in ms (every 4 minutes - well under Slack's 10min timeout)
const JIGGLE_INTERVAL = 4 * 60 * 1000;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 620,
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
    } else {
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
      label: 'Show Brew',
      click: () => {
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

// ===== APP LIFECYCLE =====

app.whenReady().then(() => {
  createWindow();
  createTray();
});

app.on('window-all-closed', () => {});

app.on('activate', () => {
  if (mainWindow) mainWindow.show();
});

app.on('before-quit', () => {
  app.isQuitting = true;
  stopCaffeinate();
  stopMouseJiggle();
});
