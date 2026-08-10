'use strict';

const { app, safeStorage, shell, net } = require('electron');
const fs = require('fs');
const path = require('path');

// Client for Brew's own repo hosted on Salesforce internal git (SOMA). SOMA
// is a GitHub Enterprise instance behind Salesforce SSO, so even "public"
// (org-visible) repos require a token for programmatic access — an
// unauthenticated API call returns 403. This client stores a Personal Access
// Token (encrypted at rest via Electron safeStorage) and uses it to read the
// latest published release and download that release's packaged app asset.
//
// RELEASE-GATED UPDATES: we deliberately read the repo's latest published
// *Release* — never `main`. This separates "pushing code" from "shipping to
// users": day-to-day commits never reach anyone, and a user only sees an
// update when a maintainer publishes a Release on SOMA. GHE's `releases/latest`
// endpoint excludes drafts and prereleases by definition, so work-in-progress
// tagged as a draft/prerelease stays invisible too.
//
// TLS: we deliberately use Electron's `net` module rather than Node's `https`.
// SOMA's certificate chains to Salesforce's INTERNAL root CA (installed on
// managed Macs via MDM). Node's https ships its own Mozilla CA bundle, which
// does NOT include that internal root, so it rejects SOMA with "self signed
// certificate in certificate chain". `net` routes through Chromium's network
// stack — the same one the browser uses — so it honors the macOS system
// keychain (and any corporate proxy), matching browser trust exactly. As a
// bonus, `net` follows redirects itself and strips the Authorization header on
// cross-origin redirects, which is precisely what the asset download needs.
// `net` is only usable after app.whenReady(); every call here is made from a
// post-ready IPC handler, so that holds.
class SomaClient {
  constructor(options = {}) {
    this.host = options.host || 'git.soma.salesforce.com';
    this.owner = options.owner || 'ssenapati';
    this.repo = options.repo || 'Brew';

    // Token lives in userData, encrypted with the OS keychain when available.
    // A ".enc" file holds ciphertext; we fall back to a plaintext ".txt" only
    // if the platform can't encrypt (safeStorage unavailable), so the feature
    // still works while making the secure path the default.
    this.tokenEncPath = path.join(app.getPath('userData'), 'soma-token.enc');
    this.tokenPlainPath = path.join(app.getPath('userData'), 'soma-token.txt');
  }

  // ---- Token management --------------------------------------------------

  // The token-creation page on the SOMA web UI. The engineer is already SSO'd
  // in the browser, so this opens, they click "Generate token", and paste it
  // back into Brew once. We request full `repo` scope because the Brew repo
  // is PRIVATE: a `public_repo`-scoped token 404s on a private repo's
  // releases/latest, which the updater can't distinguish from "no release yet".
  // `repo` is the narrowest scope GHE offers that can read a private repo.
  getTokenPageUrl() {
    const params = new URLSearchParams({
      description: 'Brew Mac App — in-app updates',
      scopes: 'repo',
    });
    return `https://${this.host}/settings/tokens/new?${params.toString()}`;
  }

  openTokenPage() {
    return shell.openExternal(this.getTokenPageUrl());
  }

  hasToken() {
    return fs.existsSync(this.tokenEncPath) || fs.existsSync(this.tokenPlainPath);
  }

  getToken() {
    try {
      if (fs.existsSync(this.tokenEncPath) && safeStorage.isEncryptionAvailable()) {
        const buf = fs.readFileSync(this.tokenEncPath);
        return safeStorage.decryptString(buf).trim();
      }
    } catch (_) {
      // fall through to plaintext / null
    }
    if (fs.existsSync(this.tokenPlainPath)) {
      return fs.readFileSync(this.tokenPlainPath, 'utf-8').trim();
    }
    return null;
  }

  saveToken(token) {
    const clean = (token || '').trim();
    if (!clean) throw new Error('Token is empty');

    if (safeStorage.isEncryptionAvailable()) {
      const enc = safeStorage.encryptString(clean);
      fs.writeFileSync(this.tokenEncPath, enc);
      // Remove any stale plaintext token from before encryption was available.
      if (fs.existsSync(this.tokenPlainPath)) {
        try { fs.unlinkSync(this.tokenPlainPath); } catch (_) {}
      }
    } else {
      fs.writeFileSync(this.tokenPlainPath, clean, 'utf-8');
    }
  }

  clearToken() {
    for (const p of [this.tokenEncPath, this.tokenPlainPath]) {
      if (fs.existsSync(p)) {
        try { fs.unlinkSync(p); } catch (_) {}
      }
    }
  }

  // ---- API calls ---------------------------------------------------------

  // Verify the stored token can actually read the repo. Returns
  // { ok, login?, message? } — used by the "Connect to SOMA" flow to confirm
  // the paste worked before we rely on it.
  async verifyToken() {
    const token = this.getToken();
    if (!token) return { ok: false, message: 'No token saved' };
    try {
      const me = await this._apiJson(`/api/v3/user`);
      // Also confirm this token can see the specific repo.
      await this._apiJson(`/api/v3/repos/${this.owner}/${this.repo}`);
      return { ok: true, login: me && me.login };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  }

  // Resolve the signed-in user's email from SOMA (GitHub Enterprise
  // `/api/v3/user`). Used by the access gate to learn who's connected before
  // deciding whether to open the app. SOMA returns the canonical
  // salesforce.com address. Falls back to `<login>@salesforce.com` if the
  // `email` field is empty (some GHE accounts hide it), then to '' on failure.
  async getIdentityEmail() {
    try {
      const me = await this._apiJson('/api/v3/user');
      const email = (me && me.email && String(me.email).trim()) || '';
      if (email) return email;
      const login = (me && me.login && String(me.login).trim()) || '';
      return login ? `${login}@salesforce.com` : '';
    } catch (_) {
      return '';
    }
  }

  // Fetch the latest *published* release (drafts and prereleases excluded by
  // GHE). Returns the raw release object; callers read `.tag_name`. A 404 here
  // means the maintainer hasn't published a release yet — we translate that
  // into a clear "no releases" error so the UI can say "you're up to date"
  // rather than surfacing a raw HTTP 404.
  async getLatestRelease() {
    try {
      return await this._apiJson(`/api/v3/repos/${this.owner}/${this.repo}/releases/latest`);
    } catch (err) {
      if (/Not found/i.test(err.message)) {
        throw new Error('No published release yet on SOMA');
      }
      throw err;
    }
  }

  // Download an arbitrary SOMA URL to destPath via `net`. Used to fetch a
  // release *asset* (the packaged app .zip): pass the asset's API URL
  // (…/releases/assets/<id>) with octet-stream Accept, and GHE streams the
  // binary (redirecting to signed storage, which `net` follows while stripping
  // our token cross-origin). `onProgress(percent)` is optional.
  downloadUrl(url, destPath, onProgress) {
    const token = this.getToken();
    if (!token) return Promise.reject(new Error('Not connected to SOMA (no token)'));

    return new Promise((resolve, reject) => {
      const request = net.request({ method: 'GET', url, redirect: 'follow' });
      request.setHeader('User-Agent', 'Brew-App');
      request.setHeader('Authorization', `token ${token}`);
      // octet-stream tells the GHE assets endpoint to return the binary itself
      // rather than the asset's JSON metadata.
      request.setHeader('Accept', 'application/octet-stream');

      let settled = false;
      let file = null;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (file) { try { file.destroy(); } catch (_) {} }
        if (fs.existsSync(destPath)) { try { fs.unlinkSync(destPath); } catch (_) {} }
        try { request.abort(); } catch (_) {}
        reject(err);
      };
      const timer = setTimeout(() => fail(new Error('Download timed out')), 300000);

      request.on('response', (response) => {
        if (response.statusCode !== 200) {
          if (response.resume) response.resume();
          return fail(new Error(`SOMA asset download failed: HTTP ${response.statusCode}`));
        }
        const total = parseInt(response.headers['content-length'], 10);
        let received = 0;
        file = fs.createWriteStream(destPath);
        file.on('error', fail);
        file.on('finish', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(destPath);
        });
        response.on('data', (chunk) => {
          received += chunk.length;
          if (total && typeof onProgress === 'function') {
            onProgress(Math.round((received / total) * 100));
          }
        });
        response.on('error', fail);
        response.pipe(file);
      });
      request.on('error', fail);
      request.end();
    });
  }

  // ---- internal ----------------------------------------------------------

  // GET a JSON endpoint on the SOMA host with the stored token, via Electron's
  // `net` (Chromium stack → trusts the Salesforce internal root that signs
  // SOMA; Node's https would reject it as self-signed).
  _apiJson(reqPath, { accept = 'application/vnd.github+json' } = {}) {
    const token = this.getToken();
    if (!token) return Promise.reject(new Error('Not connected to SOMA (no token)'));

    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(arg);
      };

      const req = net.request({ method: 'GET', url: `https://${this.host}${reqPath}`, redirect: 'follow' });
      req.setHeader('User-Agent', 'Brew-App');
      req.setHeader('Authorization', `token ${token}`);
      req.setHeader('Accept', accept);

      const timer = setTimeout(() => {
        try { req.abort(); } catch (_) {}
        done(reject, new Error('SOMA request timed out'));
      }, 15000);

      req.on('response', (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode === 200) {
            try { done(resolve, JSON.parse(data)); }
            catch (_) { done(reject, new Error('Invalid response from SOMA')); }
          } else if (res.statusCode === 401) {
            done(reject, new Error('SOMA token is invalid or expired — reconnect'));
          } else if (res.statusCode === 403) {
            done(reject, new Error('SOMA denied access (403) — token missing repo scope or SSO not authorized'));
          } else if (res.statusCode === 404) {
            done(reject, new Error('Not found on SOMA (repo or file missing)'));
          } else {
            done(reject, new Error(`SOMA API returned ${res.statusCode}`));
          }
        });
        res.on('error', (err) => done(reject, err));
      });
      req.on('error', (err) => done(reject, err));
      req.end();
    });
  }
}

module.exports = SomaClient;
