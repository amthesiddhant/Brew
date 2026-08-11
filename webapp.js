'use strict';

// Brew ↔ Apps Script Web App bridge.
//
// Replaces the DX Gateway for BOTH the access check and usage logging. The
// gateway read/wrote as each machine's own Google account, so it only worked
// for the sheet owner (the sheets are private) and most users don't even have
// it. Instead we call a Google Apps Script Web App deployed "Execute as: Me /
// Anyone within Salesforce.com" (see apps-script/Brew.gs): it runs with the
// owner's permissions (full access to the private sheets) while being reachable
// by any signed-in salesforce.com user over HTTPS.
//
// AUTH MODEL (same trick the ECHO plugin uses): we carry the user's Google
// session COOKIES on the request. Because the web app is domain-restricted,
// Google resolves the caller from that session and the script reads their real,
// unspoofable email via Session.getActiveUser().getEmail(). There is NO OAuth
// client, no token to store or refresh, and no secret embedded in the app.
//
// A Chrome extension gets the browser's cookie jar for free; Electron has its
// own. So we keep a PERSISTENT session partition ("persist:brew-google") that
// holds the user's Google login across launches, established once via a small
// sign-in window (ensureAuth). Every subsequent call is a background
// net.request bound to that partition — cookies ride along automatically.

const { BrowserWindow, net, session } = require('electron');
const { WEBAPP } = require('./access-config');

// Persistent partition so the Google login survives quit/relaunch. `persist:`
// prefix is what makes it durable (an in-memory partition would force sign-in
// every launch).
const PARTITION = 'persist:brew-google';

let signInWindow = null;

// The Electron Session that holds the user's Google cookies. Lazily created so
// this module is import-safe before app is ready.
function googleSession() {
  return session.fromPartition(PARTITION);
}

// True when the web app endpoint has been configured. Until the owner pastes
// the deployed /exec URL into access-config.js, every call is a safe no-op so
// the app ships and runs fine before the endpoint is live.
function isConfigured() {
  const url = WEBAPP && WEBAPP.execUrl;
  return typeof url === 'string' && /^https:\/\/script\.google\.com\/.+\/exec$/.test(url.trim());
}

// Low-level POST to the /exec endpoint, bound to the Google-cookie partition.
// Resolves the parsed JSON body. Rejects on transport error, timeout, or when
// the endpoint returns an HTML page (which means Google wants the user to
// authorize — the caller distinguishes this via err.needsAuth).
function post(payload) {
  return new Promise((resolve, reject) => {
    const request = net.request({
      method: 'POST',
      url: WEBAPP.execUrl.trim(),
      redirect: 'follow', // Apps Script 302-redirects /exec → googleusercontent
      session: googleSession(),
      useSessionCookies: true, // attach the partition's Google cookies
    });
    request.setHeader('Content-Type', 'text/plain;charset=UTF-8');

    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { request.abort(); } catch (_) {}
      reject(err);
    };
    const timer = setTimeout(
      () => fail(new Error('web app request timed out')),
      (WEBAPP && WEBAPP.timeoutMs) || 20000
    );

    request.on('response', (response) => {
      const ctype = String(
        (response.headers['content-type'] || response.headers['Content-Type'] || '')
      ).toLowerCase();
      let body = '';
      response.on('data', (chunk) => { body += chunk.toString(); });
      response.on('error', fail);
      response.on('end', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // A 401 or an HTML page means the Google session isn't authorized yet —
        // the caller should trigger the one-time interactive sign-in.
        if (response.statusCode === 401 || ctype.includes('text/html')) {
          const e = new Error('web app requires sign-in');
          e.needsAuth = true;
          return reject(e);
        }
        try {
          resolve(JSON.parse(body));
        } catch (_) {
          const e = new Error('web app returned a non-JSON response');
          // A stray HTML/login body we didn't catch above is also an auth signal.
          e.needsAuth = /<html|sign in|accounts\.google/i.test(body);
          reject(e);
        }
      });
    });
    request.on('error', fail);

    try {
      request.write(JSON.stringify(payload));
      request.end();
    } catch (e) {
      fail(e);
    }
  });
}

// Open a small window at the /exec URL so the user completes their one-time
// Google sign-in / authorization for this app. The persistent partition retains
// the resulting cookies. Resolves true if we end up on the app's own success
// page (a Google-hosted googleusercontent/script domain), false if the user
// closes the window first. Never rejects — sign-in is best-effort.
function ensureAuth() {
  return new Promise((resolve) => {
    if (signInWindow && !signInWindow.isDestroyed()) {
      signInWindow.focus();
      return resolve(false);
    }
    signInWindow = new BrowserWindow({
      width: 480,
      height: 640,
      title: 'Sign in to continue',
      autoHideMenuBar: true,
      webPreferences: {
        partition: PARTITION, // MUST match googleSession() so cookies persist
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      resolve(ok);
      if (signInWindow && !signInWindow.isDestroyed()) {
        try { signInWindow.close(); } catch (_) {}
      }
    };

    // When navigation lands back on the Apps Script success page (our doGet),
    // the user is authorized. Apps Script serves /exec from a googleusercontent
    // sandbox domain, so match on either host.
    const onNav = (url) => {
      if (/script\.googleusercontent\.com|\/exec/i.test(url) &&
          !/accounts\.google\.com|ServiceLogin|signin/i.test(url)) {
        finish(true);
      }
    };
    signInWindow.webContents.on('did-navigate', (_e, url) => onNav(url));
    signInWindow.webContents.on('did-redirect-navigation', (_e, url) => onNav(url));

    signInWindow.on('closed', () => {
      signInWindow = null;
      finish(false);
    });

    signInWindow.loadURL(WEBAPP.execUrl.trim());
  });
}

// Call an action on the web app, transparently running the one-time sign-in and
// retrying ONCE if the endpoint reports the session isn't authorized yet.
// `interactive` gates whether we're allowed to pop the sign-in window (the
// access gate at launch does; background usage sync does NOT — it just waits
// for the next launch).
async function call(action, payload = {}, { interactive = false } = {}) {
  if (!isConfigured()) {
    const e = new Error('web app not configured');
    e.notConfigured = true;
    throw e;
  }
  try {
    return await post({ action, ...payload });
  } catch (err) {
    if (err && err.needsAuth && interactive) {
      const signedIn = await ensureAuth();
      if (signedIn) return await post({ action, ...payload });
    }
    throw err;
  }
}

module.exports = { call, ensureAuth, isConfigured };
