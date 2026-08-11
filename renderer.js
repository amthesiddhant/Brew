let isAwake = false;
let isSlackMode = false;
let timerInterval = null;
let startTime = null;

// DOM Elements
const appIcon = document.getElementById('appIcon');
const appIconWrapper = document.getElementById('appIconWrapper');
const statusText = document.getElementById('statusText');
const statusDot = document.getElementById('statusDot');
const btnOn = document.getElementById('btnOn');
const btnOff = document.getElementById('btnOff');
const timerSection = document.getElementById('timerSection');
const timerValue = document.getElementById('timerValue');
const timerBarFill = document.getElementById('timerBarFill');
const toggleSwitch = document.getElementById('toggleSwitch');
const toggleKnob = document.getElementById('toggleKnob');
const slackDesc = document.getElementById('slackDesc');
const slackToggleRow = document.querySelector('.slack-toggle-row');

// Create floating coffee beans
function createCoffeeBeans() {
  const container = document.body;
  for (let i = 0; i < 7; i++) {
    const bean = document.createElement('div');
    bean.classList.add('coffee-bean');
    container.appendChild(bean);
  }
}

// Create floating particles
function createParticles() {
  const particlesContainer = document.getElementById('particles');
  for (let i = 0; i < 20; i++) {
    const particle = document.createElement('div');
    particle.classList.add('particle');
    particle.style.left = `${Math.random() * 100}%`;
    particle.style.bottom = `${Math.random() * 20}%`;
    particle.style.animationDelay = `${Math.random() * 8}s`;
    particle.style.animationDuration = `${6 + Math.random() * 6}s`;
    particle.style.width = `${2 + Math.random() * 4}px`;
    particle.style.height = particle.style.width;
    particlesContainer.appendChild(particle);
  }
}

// Full-window "Access not enabled" gate for users who aren't on the allowlist.
// Blocks the whole app (no brewing, no Slack mode). Mirrors Genie's lock screen.
// email is rendered via textContent (XSS-safe).
const ACCESS_LOCK_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
  'stroke-linecap="round" stroke-linejoin="round">' +
  '<rect x="4" y="10.5" width="16" height="10.5" rx="2.5"></rect>' +
  '<path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"></path>' +
  '<circle cx="12" cy="15.5" r="1.4" fill="currentColor" stroke="none"></circle>' +
  '<path d="M12 16.9v1.6"></path></svg>';

const accessDeniedView = document.getElementById('accessDeniedView');
const accessGlyph = document.getElementById('accessGlyph');
const accessEmail = document.getElementById('accessEmail');
const accessRetryBtn = document.getElementById('accessRetryBtn');
const accessLogoutBtn = document.getElementById('accessLogoutBtn');

function showAccessDenied(email) {
  if (accessGlyph && !accessGlyph.firstChild) {
    accessGlyph.innerHTML = ACCESS_LOCK_SVG; // static markup — safe
  }
  if (accessEmail) accessEmail.textContent = email || '';
  accessDeniedView.classList.remove('hidden');
  // Trigger the entrance animation on the next frame (class toggle after unhide).
  requestAnimationFrame(() => accessDeniedView.classList.add('show'));
}

function hideAccessDenied() {
  accessDeniedView.classList.remove('show');
  accessDeniedView.classList.add('hidden');
}

// Run the allowlist check. Fail OPEN on a thrown error (a gate bug must never
// brick the app), but honor a clean "denied". Returns true if the app may open.
async function runAccessGate() {
  let access;
  try {
    access = await window.brew.checkAccess();
  } catch (_) {
    access = { allowed: true, reason: 'gate-error' };
  }
  if (access && access.allowed === false) {
    showAccessDenied(access.email);
    return false;
  }
  hideAccessDenied();
  return true;
}

// Full-window "Update required" gate. When SOMA has a newer published release
// (with an installer attached), Brew blocks the whole app behind this screen
// until the user updates — there is no dismiss-into-the-app path. Mirrors the
// access gate. Fails OPEN (never blocks) on a check error, so a network blip
// can't brick the app; it only blocks when it KNOWS a newer version exists.
const FORCE_UPDATE_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
  'stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>' +
  '<polyline points="7 10 12 15 17 10"></polyline>' +
  '<line x1="12" y1="15" x2="12" y2="3"></line></svg>';

const forceUpdateView = document.getElementById('forceUpdateView');
const forceUpdateGlyph = document.getElementById('forceUpdateGlyph');
const forceCurrentVersion = document.getElementById('forceCurrentVersion');
const forceLatestVersion = document.getElementById('forceLatestVersion');
const forceUpdateNotes = document.getElementById('forceUpdateNotes');
const forceUpdateBtn = document.getElementById('forceUpdateBtn');
const forceUpdateProgress = document.getElementById('forceUpdateProgress');
const forceUpdateProgressLabel = document.getElementById('forceUpdateProgressLabel');
const forceUpdateProgressFill = document.getElementById('forceUpdateProgressFill');
const forceUpdateProgressPercent = document.getElementById('forceUpdateProgressPercent');

let forceUpdateInfo = null; // the mandatory-update payload (version + notes)

function showForceUpdate(info) {
  forceUpdateInfo = info;
  if (forceUpdateGlyph && !forceUpdateGlyph.firstChild) {
    forceUpdateGlyph.innerHTML = FORCE_UPDATE_SVG; // static markup — safe
  }
  if (forceCurrentVersion) forceCurrentVersion.textContent = info.currentVersion || '';
  if (forceLatestVersion) forceLatestVersion.textContent = info.version || '';
  if (forceUpdateNotes) {
    const notes = (info.notes || '').trim();
    if (notes) {
      forceUpdateNotes.textContent = notes.substring(0, 400) + (notes.length > 400 ? '…' : '');
      forceUpdateNotes.classList.remove('hidden');
    } else {
      forceUpdateNotes.textContent = '';
      forceUpdateNotes.classList.add('hidden');
    }
  }
  forceUpdateView.classList.remove('hidden');
  requestAnimationFrame(() => forceUpdateView.classList.add('show'));
}

// Ask the main process whether a newer installable release exists. Returns true
// if the app must NOT open (a mandatory update is showing). Fails open on any
// error or when not connected — the app opens normally in those cases.
async function runForceUpdateGate() {
  let res;
  try {
    res = await window.brew.updateCheck();
  } catch (_) {
    return false; // fail open — never brick the app on a check error
  }
  // Only block when we positively know a newer version with an installer is
  // available. `needsAuth`, `error`, or no installer → let the app open.
  if (res && res.available && res.hasInstaller) {
    showForceUpdate({
      version: res.version,
      notes: res.notes,
      currentVersion: res.currentVersion || currentVersionEl.textContent,
    });
    return true;
  }
  return false;
}

// "Update now" on the force-update gate — download + swap + relaunch. Reuses
// the main process install flow; polls progress into the gate's own bar.
async function forceInstallUpdate() {
  if (!forceUpdateBtn) return;
  forceUpdateBtn.disabled = true;
  const btnLabel = forceUpdateBtn.querySelector('.btn-label');
  if (btnLabel) btnLabel.textContent = 'Updating…';

  forceUpdateProgress.style.display = 'block';
  forceUpdateProgressFill.style.width = '0%';
  forceUpdateProgressFill.classList.remove('installing', 'error');
  forceUpdateProgressLabel.textContent = 'Downloading…';
  forceUpdateProgressPercent.textContent = '0%';

  let pollId = setInterval(async () => {
    try {
      const p = await window.brew.updateProgress();
      const pct = Math.max(0, Math.min(100, p.progress || 0));
      forceUpdateProgressFill.style.width = `${pct}%`;
      if (pct >= 100) {
        forceUpdateProgressLabel.textContent = 'Installing…';
        forceUpdateProgressPercent.textContent = '';
        forceUpdateProgressFill.classList.add('installing');
      } else {
        forceUpdateProgressLabel.textContent = 'Downloading…';
        forceUpdateProgressPercent.textContent = `${pct}%`;
      }
    } catch {
      /* ignore transient poll errors */
    }
  }, 400);

  const stopPoll = () => { if (pollId) { clearInterval(pollId); pollId = null; } };

  try {
    const res = await window.brew.updateInstall();
    stopPoll();
    if (res && res.deferred) {
      // User chose "Later" at the OS confirm dialog. Keep them on the gate.
      forceUpdateProgress.style.display = 'none';
      forceUpdateBtn.disabled = false;
      if (btnLabel) btnLabel.textContent = 'Update now';
    } else {
      forceUpdateProgressFill.style.width = '100%';
      forceUpdateProgressFill.classList.add('installing');
      forceUpdateProgressLabel.textContent = 'Restarting…';
      forceUpdateProgressPercent.textContent = '';
    }
  } catch (e) {
    stopPoll();
    forceUpdateProgressFill.style.width = '100%';
    forceUpdateProgressFill.classList.add('error');
    forceUpdateProgressLabel.textContent = `Error: ${cleanErrorMessage((e && e.message) || e)}`;
    forceUpdateProgressPercent.textContent = '';
    forceUpdateBtn.disabled = false;
    if (btnLabel) btnLabel.textContent = 'Try again';
  }
}

if (forceUpdateBtn) {
  forceUpdateBtn.addEventListener('click', forceInstallUpdate);
}

// Initialize
async function init() {
  createCoffeeBeans();
  createParticles();
  // Access gate first — only paint/wire the main UI for allowlisted users.
  const allowed = await runAccessGate();
  if (!allowed) return;
  // Force-update gate next — a mandatory update blocks the app entirely.
  const mustUpdate = await runForceUpdateGate();
  if (mustUpdate) return;
  const status = await window.brew.getStatus();
  updateUI(status);
}

// Access-denied page: re-run the gate, or sign out (disconnect SOMA → the main
// process re-locks and reloads the gate screen).
if (accessRetryBtn) {
  accessRetryBtn.addEventListener('click', async () => {
    accessRetryBtn.disabled = true;
    try {
      const allowed = await runAccessGate();
      if (allowed) {
        const status = await window.brew.getStatus();
        updateUI(status);
      }
    } finally {
      accessRetryBtn.disabled = false;
    }
  });
}
if (accessLogoutBtn) {
  accessLogoutBtn.addEventListener('click', async () => {
    try {
      await window.brew.updateDisconnect();
    } catch {
      /* the main process reloads gate.html regardless */
    }
  });
}

// Turn ON
async function turnOn() {
  btnOn.style.transform = 'scale(0.95)';
  setTimeout(() => { btnOn.style.transform = ''; }, 150);
  const status = await window.brew.turnOn();
  updateUI(status);
}

// Turn OFF
async function turnOff() {
  btnOff.style.transform = 'scale(0.95)';
  setTimeout(() => { btnOff.style.transform = ''; }, 150);
  const status = await window.brew.turnOff();
  updateUI(status);
}

// Open the insights dashboard window.
async function openInsights() {
  try {
    await window.brew.openDashboard();
  } catch {
    /* opening the dashboard is best-effort */
  }
}

// Toggle Slack Mode
async function toggleSlackMode() {
  const status = await window.brew.toggleSlackMode();
  updateUI(status);
}

// Update UI based on status
function updateUI(status) {
  isAwake = status.isAwake;
  isSlackMode = status.isSlackMode;

  // Brew state
  if (isAwake) {
    document.body.classList.add('brewing');
    btnOn.classList.add('active');
    btnOff.classList.remove('active');
    timerSection.classList.add('active');

    if (isSlackMode) {
      statusText.textContent = 'Brewing + Slack Online';
    } else {
      statusText.textContent = 'Brewing... Mac staying awake';
    }

    startTimer();
  } else {
    document.body.classList.remove('brewing');
    btnOn.classList.remove('active');
    btnOff.classList.add('active');
    timerSection.classList.remove('active');
    statusText.textContent = 'Your Mac can sleep';
    stopTimer();
  }

  // Slack mode state
  if (isSlackMode) {
    toggleSwitch.classList.add('active');
    slackToggleRow.classList.add('active');
    slackDesc.textContent = 'Active - jiggling every 4 min';
  } else {
    toggleSwitch.classList.remove('active');
    slackToggleRow.classList.remove('active');
    slackDesc.textContent = 'Simulates activity every 4 min';
  }
}

// Timer functions
function startTimer() {
  if (timerInterval) return;
  startTime = Date.now();
  timerInterval = setInterval(updateTimer, 1000);
  updateTimer();
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  startTime = null;
  timerValue.textContent = '00:00:00';
  timerBarFill.style.width = '0%';
}

function updateTimer() {
  if (!startTime) return;

  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const hours = Math.floor(elapsed / 3600);
  const minutes = Math.floor((elapsed % 3600) / 60);
  const seconds = elapsed % 60;

  timerValue.textContent =
    `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

  // Animate timer bar (loops every 60 seconds)
  const progress = (seconds / 60) * 100;
  timerBarFill.style.width = `${progress}%`;
}

// ===== UPDATE FEATURE =====
// Brew updates itself from its latest published Release on SOMA. The flow:
//   1. Connect once — paste a repo-scoped SOMA token (stored encrypted in the
//      main process; the renderer never holds it).
//   2. Check for Updates — asks the main process to compare our version to the
//      latest release tag.
//   3. Update & Restart — downloads the packaged .zip, swaps the app bundle in
//      place, and relaunches (handled entirely in the main process).

let updateLatest = null; // the available-update payload from the last check
let updatePollId = null;  // interval id while a download is in progress

const updateLabel = document.getElementById('updateLabel');
const updateDesc = document.getElementById('updateDesc');
const currentVersionEl = document.getElementById('currentVersion');
const updateBadge = document.getElementById('updateBadge');
const updateDetails = document.getElementById('updateDetails');
const latestVersionEl = document.getElementById('latestVersion');
const updateNotes = document.getElementById('updateNotes');
const updateSection = document.getElementById('updateSection');
const updateIconWrap = document.getElementById('updateIconWrap');

// SOMA connection elements.
const somaStateLine = document.getElementById('somaStateLine');
const somaConnectBtn = document.getElementById('somaConnectBtn');
const somaDisconnectBtn = document.getElementById('somaDisconnectBtn');
const somaConnectBox = document.getElementById('somaConnectBox');
const somaTokenInput = document.getElementById('somaTokenInput');
const somaConnectMsg = document.getElementById('somaConnectMsg');

// Strip the noisy Error: prefix Electron adds when an IPC handler throws.
function cleanErrorMessage(msg) {
  return String(msg || '').replace(/^Error:\s*/i, '').replace(/^.*Error invoking remote method '[^']+':\s*/i, '');
}

function setSomaMsg(text, kind) {
  if (!somaConnectMsg) return;
  if (!text) {
    somaConnectMsg.style.display = 'none';
    somaConnectMsg.textContent = '';
    somaConnectMsg.classList.remove('ok', 'err');
    return;
  }
  somaConnectMsg.textContent = text;
  somaConnectMsg.style.display = 'block';
  somaConnectMsg.classList.remove('ok', 'err');
  if (kind) somaConnectMsg.classList.add(kind);
}

// Paint the whole update section from the main process's current status.
async function refreshUpdatePanel() {
  let status;
  try {
    status = await window.brew.updateStatus();
  } catch {
    status = { connected: false, currentVersion: null };
  }
  const connected = !!status.connected;

  // SOMA connection row.
  somaConnectBtn.style.display = connected ? 'none' : '';
  somaDisconnectBtn.style.display = connected ? '' : 'none';
  somaStateLine.textContent = connected
    ? 'Connected to SOMA. Brew can fetch updates.'
    : 'Connect once so Brew can fetch updates from SOMA.';
  if (connected) {
    somaConnectBox.style.display = 'none';
    setSomaMsg('');
  }

  const cur = status.currentVersion || currentVersionEl.textContent;
  if (cur) currentVersionEl.textContent = cur;

  if (!connected) {
    updateLabel.textContent = 'Check for Updates';
    updateDesc.innerHTML = `v<span id="currentVersion">${cur || ''}</span>`;
    updateBadge.style.display = 'none';
    updateDetails.style.display = 'none';
    updateSection.classList.remove('has-update');
    return;
  }

  if (status.updateAvailable && status.latestRelease) {
    showAvailableUpdate({
      version: status.latestRelease.version,
      name: status.latestRelease.name,
      notes: status.latestRelease.body,
      hasInstaller: !!status.latestRelease.assetUrl,
    });
  }
}

// Render the "an update is available" state in the inline panel.
function showAvailableUpdate(info) {
  updateLatest = info;
  updateLabel.textContent = 'Update Available!';
  updateDesc.textContent = `v${currentVersionEl.textContent} → v${info.version}`;
  updateBadge.style.display = 'flex';
  latestVersionEl.textContent = info.version;
  updateNotes.textContent = info.notes
    ? info.notes.trim().substring(0, 180) + (info.notes.trim().length > 180 ? '…' : '')
    : 'A new version is available.';
  updateDetails.style.display = 'block';
  updateSection.classList.add('has-update');

  const btnUpdate = document.getElementById('btnUpdate');
  btnUpdate.disabled = !info.hasInstaller;
}

// "Check for Updates" — probe SOMA for a newer release.
async function checkForUpdates() {
  // Not connected yet → guide the user to connect first.
  let status;
  try { status = await window.brew.updateStatus(); } catch { status = {}; }
  if (!status.connected) {
    somaConnect();
    return;
  }

  updateLabel.textContent = 'Brewing update check…';
  updateIconWrap.classList.add('checking');
  updateBadge.style.display = 'none';
  updateDetails.style.display = 'none';

  try {
    const res = await window.brew.updateCheck();
    if (res.needsAuth) {
      updateLabel.textContent = 'Reconnect to SOMA';
      updateDesc.textContent = 'Token invalid or expired';
      await refreshUpdatePanel();
    } else if (res.available) {
      showAvailableUpdate({
        version: res.version,
        name: res.name,
        notes: res.notes,
        hasInstaller: res.hasInstaller,
      });
    } else if (res.error) {
      updateLabel.textContent = 'Update check failed';
      updateDesc.textContent = cleanErrorMessage(res.error);
      setTimeout(resetUpdateRow, 3000);
    } else {
      const cur = res.currentVersion || currentVersionEl.textContent;
      updateLabel.textContent = "You're up to date!";
      updateDesc.textContent = `v${cur} is the latest`;
      updateBadge.style.display = 'none';
      updateDetails.style.display = 'none';
      updateSection.classList.remove('has-update');
      setTimeout(resetUpdateRow, 3000);
    }
  } catch (e) {
    updateLabel.textContent = 'Update check failed';
    updateDesc.textContent = cleanErrorMessage((e && e.message) || e);
    setTimeout(resetUpdateRow, 3000);
  } finally {
    updateIconWrap.classList.remove('checking');
  }
}

function resetUpdateRow() {
  if (updateLatest) return; // don't clobber an available-update state
  updateLabel.textContent = 'Check for Updates';
  updateDesc.innerHTML = `v<span id="currentVersion">${currentVersionEl.textContent}</span>`;
}

// "Update & Restart" — download, swap, relaunch (main process). We poll for
// download progress; on success the app relaunches so this promise won't
// resolve in-window.
async function downloadUpdate() {
  if (!updateLatest) return;

  const btnUpdate = document.getElementById('btnUpdate');
  const updateProgress = document.getElementById('updateProgress');
  const progressLabel = document.getElementById('updateProgressLabel');
  const progressFill = document.getElementById('updateProgressFill');
  const progressPercent = document.getElementById('updateProgressPercent');

  btnUpdate.style.display = 'none';
  updateProgress.style.display = 'block';
  progressFill.style.width = '0%';
  progressFill.classList.remove('installing', 'error');
  progressLabel.textContent = 'Downloading…';
  progressPercent.textContent = '0%';

  updatePollId = setInterval(async () => {
    try {
      const p = await window.brew.updateProgress();
      const pct = Math.max(0, Math.min(100, p.progress || 0));
      progressFill.style.width = `${pct}%`;
      if (pct >= 100) {
        progressLabel.textContent = 'Installing…';
        progressPercent.textContent = '';
        progressFill.classList.add('installing');
      } else {
        progressLabel.textContent = 'Downloading…';
        progressPercent.textContent = `${pct}%`;
      }
    } catch {
      /* ignore transient poll errors */
    }
  }, 400);

  const stopPoll = () => {
    if (updatePollId) { clearInterval(updatePollId); updatePollId = null; }
  };

  try {
    const res = await window.brew.updateInstall();
    stopPoll();
    if (res && res.deferred) {
      // User chose "Later" at the confirm dialog.
      updateProgress.style.display = 'none';
      btnUpdate.style.display = 'flex';
      updateLabel.textContent = 'Update Available!';
      updateDesc.textContent = `v${updateLatest.version} is ready when you are`;
    } else {
      // Success path relaunches the app; keep the bar full meanwhile.
      progressFill.style.width = '100%';
      progressFill.classList.add('installing');
      progressLabel.textContent = 'Restarting…';
      progressPercent.textContent = '';
    }
  } catch (e) {
    stopPoll();
    progressFill.style.width = '100%';
    progressFill.classList.add('error');
    progressLabel.textContent = `Error: ${cleanErrorMessage((e && e.message) || e)}`;
    progressPercent.textContent = '';
    setTimeout(() => {
      updateProgress.style.display = 'none';
      btnUpdate.style.display = 'flex';
    }, 4000);
  }
}

// ----- SOMA connect / disconnect -----

// "Connect to SOMA" — open the token page and reveal the paste box.
async function somaConnect() {
  try {
    await window.brew.updateOpenTokenPage();
  } catch {
    /* opening the browser is best-effort */
  }
  somaConnectBox.style.display = 'block';
  setSomaMsg('');
  somaTokenInput.value = '';
  somaTokenInput.focus();
}

// "Save & Verify" — persist the pasted token and confirm it can read the repo.
async function saveSomaToken() {
  const token = somaTokenInput.value.trim();
  if (!token) {
    setSomaMsg('Paste a token first.', 'err');
    return;
  }
  const btn = document.getElementById('somaSaveBtn');
  btn.disabled = true;
  setSomaMsg('Verifying…', null);
  try {
    const res = await window.brew.updateConnect(token);
    if (res.ok) {
      somaTokenInput.value = '';
      setSomaMsg(`Connected${res.login ? ' as ' + res.login : ''}.`, 'ok');
      await refreshUpdatePanel();
      // Immediately check so the user sees any available update right away.
      checkForUpdates();
    } else {
      setSomaMsg(cleanErrorMessage(res.message || 'Token could not be verified.'), 'err');
    }
  } catch (e) {
    setSomaMsg(cleanErrorMessage((e && e.message) || e), 'err');
  } finally {
    btn.disabled = false;
  }
}

// "Disconnect" — forget the SOMA token.
async function somaDisconnect() {
  try {
    await window.brew.updateDisconnect();
  } catch {
    /* ignore */
  }
  updateLatest = null;
  await refreshUpdatePanel();
}

if (somaTokenInput) {
  somaTokenInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveSomaToken();
    }
  });
}

// -------------------- Background auto-update prompt -------------------------
// The main process runs a background check (on launch + hourly). When it finds
// a newer release it pushes `update:available`; we show a centered modal.
//   • Update Now → start the download (reuses the manual install flow).
//   • Later     → snooze THIS version for 24h. The next background check after
//     the snooze expires re-surfaces it. A newer version ignores the snooze.
const SNOOZE_MS = 24 * 60 * 60 * 1000;
const SNOOZE_PREFIX = 'brew.updateSnooze.'; // + version → epoch ms when snoozed
let updateModalVersionShown = null;

const updateModal = document.getElementById('updateModal');
const updateModalVersion = document.getElementById('updateModalVersion');
const updateModalNotes = document.getElementById('updateModalNotes');
const updateModalNow = document.getElementById('updateModalNow');

function isUpdateSnoozed(version) {
  const raw = localStorage.getItem(`${SNOOZE_PREFIX}${version}`);
  if (!raw) return false;
  const when = Number(raw);
  if (!Number.isFinite(when)) return false;
  return Date.now() - when < SNOOZE_MS;
}

function snoozeUpdate(version) {
  localStorage.setItem(`${SNOOZE_PREFIX}${version}`, String(Date.now()));
}

function showUpdateModal(info) {
  if (!updateModal || !info || !info.version) return;
  updateModalVersionShown = info.version;
  updateModalVersion.textContent = `Brew ${info.version} is ready to install.`;

  if (info.notes && info.notes.trim()) {
    updateModalNotes.textContent = info.notes.trim();
    updateModalNotes.classList.remove('hidden');
  } else {
    updateModalNotes.textContent = '';
    updateModalNotes.classList.add('hidden');
  }

  updateModal.classList.remove('hidden');
  requestAnimationFrame(() => updateModal.classList.add('show'));
}

function hideUpdateModal() {
  if (!updateModal) return;
  updateModal.classList.remove('show');
  setTimeout(() => updateModal.classList.add('hidden'), 180);
}

// Decide whether to actually surface a pushed update (respects the snooze).
function handleUpdateAvailable(info) {
  if (!info || !info.version) return;
  // Keep the inline panel in sync too.
  showAvailableUpdate({
    version: info.version,
    name: info.name,
    notes: info.notes,
    hasInstaller: info.hasInstaller,
  });
  if (isUpdateSnoozed(info.version)) return; // still within the 24h window
  showUpdateModal(info);
}

if (updateModalNow) {
  updateModalNow.addEventListener('click', async () => {
    hideUpdateModal();
    await refreshUpdatePanel();
    const btnUpdate = document.getElementById('btnUpdate');
    if (btnUpdate) btnUpdate.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (updateLatest && updateLatest.hasInstaller) {
      downloadUpdate();
    } else {
      checkForUpdates();
    }
  });
}

// "Later" / backdrop / any [data-update-close] — snooze for 24h.
if (updateModal) {
  updateModal.addEventListener('click', (e) => {
    if (e.target.closest('[data-update-close]')) {
      if (updateModalVersionShown) snoozeUpdate(updateModalVersionShown);
      hideUpdateModal();
    }
  });
}

// Subscribe to background "update available" pushes from the main process.
if (window.brew.onUpdateAvailable) {
  window.brew.onUpdateAvailable(handleUpdateAvailable);
}

// Set initial version display + paint the panel from current status.
async function initVersion() {
  try {
    const version = await window.brew.getAppVersion();
    currentVersionEl.textContent = version;
    const footerVersionEl = document.getElementById('footerVersion');
    if (footerVersionEl) footerVersionEl.textContent = version;
  } catch {
    /* ignore */
  }
  await refreshUpdatePanel();
}

// Listen for status changes from main process
window.brew.onStatusChanged((status) => {
  updateUI(status);
});

// Listen for update check trigger from tray menu
window.brew.onTriggerUpdateCheck(() => {
  checkForUpdates();
});

// Initialize on load
init();
initVersion();
