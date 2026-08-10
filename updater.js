'use strict';

const { app, dialog, shell, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Absolute paths to the macOS system tools we shell out to. A packaged .app
// launched from Finder/dock inherits a minimal environment whose PATH usually
// does NOT include /usr/bin, so bare `execFileSync('ditto', ...)` throws ENOENT
// in the installed app (but works when run from a shell). Always call by full
// path. These are present on every macOS install.
const DITTO = '/usr/bin/ditto';
const XATTR = '/usr/bin/xattr';
const PLISTBUDDY = '/usr/libexec/PlistBuddy';

// Self-updater for the Brew Mac app. It reads the latest *published Release*
// on Brew's SOMA repo (never a branch tip) and installs the packaged .zip
// asset attached to that release.
//
// All networking goes through a SomaClient (Electron `net` → trusts the
// Salesforce internal root CA, honors the system proxy, follows redirects).
//
// Release-gated: users only see an update when a maintainer publishes a
// Release with a mac .zip asset — day-to-day pushes to main never reach them,
// and drafts/prereleases are excluded by GHE's releases/latest.
//
// Brew is UNSIGNED, which is exactly why this hand-rolled swap works: an
// unsigned bundle can be replaced on disk without Gatekeeper re-validating a
// signature. Squirrel.Mac / electron-updater would require a Developer ID cert
// + notarization, which we deliberately avoid.
class Updater {
  constructor(options = {}) {
    // A SomaClient instance pointed at the app repo. Required.
    this.soma = options.soma;
    this.currentVersion = app.getVersion();
    this.updateAvailable = false;
    this.latestRelease = null;
    this.downloadProgress = 0;
    this.isDownloading = false;
    this.checkInterval = options.checkInterval || 60 * 60 * 1000; // 1 hour
    this.intervalId = null;
    // Called before the app relaunches so the host can tear down timers,
    // caffeinate, mouse-jiggle, etc. cleanly. Best-effort.
    this.onBeforeRelaunch = options.onBeforeRelaunch || null;
    // Called with the check result whenever a *background* check finds a newer
    // release. Wired in main.js to push a "update available" prompt to the
    // renderer. Manual checks (the Check button) don't fire this — the user is
    // already looking at the panel.
    this.onUpdateAvailable = options.onUpdateAvailable || null;
  }

  // Start periodic update checks. Any check that surfaces a newer release
  // notifies via onUpdateAvailable so the UI can prompt proactively.
  startAutoCheck() {
    const tick = async () => {
      const res = await this.checkForUpdates().catch(() => null);
      if (res && res.available && typeof this.onUpdateAvailable === 'function') {
        try {
          this.onUpdateAvailable(res);
        } catch {
          /* notifying the UI is best-effort */
        }
      }
    };

    // Check on launch (after a short delay so startup isn't blocked).
    setTimeout(tick, 10000);

    this.intervalId = setInterval(tick, this.checkInterval);
  }

  stopAutoCheck() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  // Check the app's SOMA repo for a newer published release.
  async checkForUpdates() {
    if (!this.soma) return { available: false, error: 'Updater not configured' };

    // No token yet → not connected. Not an error; the user connects via the
    // "Connect to SOMA" button in the update panel.
    if (!this.soma.hasToken()) {
      return { available: false, needsAuth: true, currentVersion: this.currentVersion };
    }

    try {
      let release;
      try {
        release = await this.soma.getLatestRelease();
      } catch (err) {
        // No release published yet → nothing to offer, not an error state.
        if (/no published release/i.test(err.message)) {
          return { available: false, currentVersion: this.currentVersion };
        }
        const needsAuth = /invalid|expired|denied|403|401/i.test(err.message);
        return { available: false, needsAuth, error: err.message };
      }

      if (!release || !release.tag_name) return { available: false };

      const latestVersion = release.tag_name.replace(/^v/i, '');
      if (!this.isNewerVersion(latestVersion, this.currentVersion)) {
        this.updateAvailable = false;
        return { available: false, currentVersion: this.currentVersion };
      }

      const asset = this.findMacAsset(release);
      this.updateAvailable = true;
      this.latestRelease = {
        version: latestVersion,
        tag: release.tag_name,
        name: release.name,
        body: release.body,
        publishedAt: release.published_at,
        // The asset's API URL (…/releases/assets/<id>) — downloaded via net
        // with octet-stream. null if the release has no mac .zip attached.
        assetUrl: asset ? asset.url : null,
        assetName: asset ? asset.name : null,
        htmlUrl: release.html_url,
      };

      return {
        available: true,
        version: latestVersion,
        name: release.name,
        notes: release.body,
        publishedAt: release.published_at,
        hasInstaller: !!asset,
        currentVersion: this.currentVersion,
      };
    } catch (error) {
      console.error('Update check failed:', error.message);
      return { available: false, error: error.message };
    }
  }

  // Find the packaged macOS .zip asset on a release. electron-builder emits
  // e.g. "Brew-1.8.0-arm64-mac.zip". We install from the .zip (not the .dmg)
  // because it extracts to a plain Brew.app we can swap in place.
  findMacAsset(release) {
    const assets = release.assets || [];
    return (
      assets.find((a) => /mac\.zip$/i.test(a.name)) ||
      assets.find((a) => /mac/i.test(a.name) && /\.zip$/i.test(a.name)) ||
      assets.find((a) => /darwin/i.test(a.name) && /\.zip$/i.test(a.name)) ||
      assets.find((a) => /\.zip$/i.test(a.name)) ||
      null
    );
  }

  // Compare dotted versions (true if latest > current).
  isNewerVersion(latest, current) {
    const l = String(latest).split('.').map(Number);
    const c = String(current).split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      const a = l[i] || 0;
      const b = c[i] || 0;
      if (a > b) return true;
      if (a < b) return false;
    }
    return false;
  }

  // Resolve the running .app bundle root, e.g. /Applications/Brew.app.
  // exe = /Applications/Brew.app/Contents/MacOS/Brew → up 3 levels.
  getAppBundlePath() {
    const exe = app.getPath('exe');
    const bundle = path.dirname(path.dirname(path.dirname(exe)));
    return bundle.endsWith('.app') ? bundle : null;
  }

  // Download the release's .zip asset and swap it into place, then relaunch.
  async downloadAndInstall() {
    if (!this.latestRelease) throw new Error('No update available to install');
    if (!this.latestRelease.assetUrl) {
      // No installable asset attached — send the user to the release page.
      if (this.latestRelease.htmlUrl) shell.openExternal(this.latestRelease.htmlUrl);
      throw new Error('This release has no macOS installer attached. Opening the release page instead.');
    }
    if (!app.isPackaged) {
      throw new Error('In-app update only works in the packaged app (you are running from source).');
    }
    const appBundle = this.getAppBundlePath();
    if (!appBundle) throw new Error('Could not locate the Brew.app bundle to update.');

    this.isDownloading = true;
    this.downloadProgress = 0;

    const version = this.latestRelease.version;
    const tempDir = path.join(app.getPath('temp'), `brew-update-${process.pid}-${Date.now()}`);
    const zipPath = path.join(tempDir, `Brew-${version}.zip`);
    const extractDir = path.join(tempDir, 'extracted');

    try {
      fs.mkdirSync(extractDir, { recursive: true });

      // 1. Download the asset via SOMA (net, token, TLS-trusted, redirects).
      await this.soma.downloadUrl(this.latestRelease.assetUrl, zipPath, (p) => {
        this.downloadProgress = p;
      });

      // 2. Extract. ditto preserves macOS bundle metadata better than unzip.
      execFileSync(DITTO, ['-xk', zipPath, extractDir], { timeout: 120000 });

      // 3. Locate the extracted Brew.app and sanity-check it.
      const newApp = this.findDotApp(extractDir);
      if (!newApp) throw new Error('Downloaded update did not contain Brew.app');
      const newVersion = this.readBundleVersion(newApp);
      if (!newVersion) throw new Error('Downloaded Brew.app has no readable version');

      // 4. Strip any quarantine flag so the swapped-in bundle launches without
      //    a fresh Gatekeeper prompt (best-effort; unsigned apps still need the
      //    one-time xattr on first *manual* install).
      try { execFileSync(XATTR, ['-cr', newApp], { timeout: 15000 }); } catch (_) {}

      // 5. Confirm with the user before replacing the running app.
      const iconPath = path.join(app.getAppPath(), 'assets/icon.png');
      const choice = dialog.showMessageBoxSync({
        type: 'info',
        title: 'Brew Update',
        message: `Brew ${newVersion} is ready to install.`,
        detail: 'Brew will replace itself and restart. This takes a few seconds.',
        buttons: ['Restart & Update', 'Later'],
        defaultId: 0,
        cancelId: 1,
        icon: fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : undefined,
      });
      if (choice !== 0) {
        this.isDownloading = false;
        return { success: false, deferred: true };
      }

      // 6. Atomic-ish swap beside the target (same volume → rename is atomic).
      //    Move current aside, move new into place, delete backup on success;
      //    roll back on any failure so we never leave the user without an app.
      const parent = path.dirname(appBundle);
      const stamp = `${process.pid}-${Date.now()}`;
      const backup = path.join(parent, `.Brew.app.bak-${stamp}`);
      const staged = path.join(parent, `.Brew.app.new-${stamp}`);

      // Stage the new bundle beside the target first (cross-volume copy from
      // temp happens here, not during the swap).
      execFileSync(DITTO, [newApp, staged], { timeout: 120000 });
      try { execFileSync(XATTR, ['-cr', staged], { timeout: 15000 }); } catch (_) {}

      try {
        fs.renameSync(appBundle, backup); // move running bundle aside
      } catch (err) {
        try { fs.rmSync(staged, { recursive: true, force: true }); } catch (_) {}
        throw new Error(
          `Could not update Brew in place (${err.code || err.message}). ` +
            `You may need to install manually by dragging Brew to Applications.`
        );
      }
      try {
        fs.renameSync(staged, appBundle); // move new bundle into place
      } catch (err) {
        // Roll back to the original.
        try { if (!fs.existsSync(appBundle)) fs.renameSync(backup, appBundle); } catch (_) {}
        try { fs.rmSync(staged, { recursive: true, force: true }); } catch (_) {}
        throw new Error(`Update failed during swap, kept existing Brew: ${err.message}`);
      }

      // 7. Success — remove backup + temp, then relaunch the (same-path) app.
      try { fs.rmSync(backup, { recursive: true, force: true }); } catch (_) {}
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}

      // Let the host stop caffeinate / jiggle before we relaunch.
      if (typeof this.onBeforeRelaunch === 'function') {
        try { this.onBeforeRelaunch(); } catch (_) {}
      }

      app.relaunch();
      app.exit(0);
      return { success: true, version: newVersion };
    } catch (error) {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
      console.error('Update install failed:', error);
      throw error;
    } finally {
      this.isDownloading = false;
    }
  }

  // Find the first *.app directory directly inside dir.
  findDotApp(dir) {
    try {
      for (const name of fs.readdirSync(dir)) {
        if (name.endsWith('.app')) {
          const full = path.join(dir, name);
          if (fs.statSync(full).isDirectory()) return full;
        }
      }
    } catch (_) {}
    return null;
  }

  // Read CFBundleShortVersionString from an .app's Info.plist.
  readBundleVersion(appBundle) {
    try {
      const out = execFileSync(
        PLISTBUDDY,
        ['-c', 'Print :CFBundleShortVersionString', path.join(appBundle, 'Contents/Info.plist')],
        { encoding: 'utf-8', timeout: 5000 }
      ).trim();
      return out || null;
    } catch (_) {
      return null;
    }
  }

  // Update status for the UI.
  getStatus() {
    return {
      currentVersion: this.currentVersion,
      connected: this.soma ? this.soma.hasToken() : false,
      updateAvailable: this.updateAvailable,
      latestRelease: this.latestRelease,
      isDownloading: this.isDownloading,
      downloadProgress: this.downloadProgress,
    };
  }
}

module.exports = Updater;
