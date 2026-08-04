let isAwake = false;
let isSlackMode = false;
let isOmniMode = false;
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

// Initialize
async function init() {
  createCoffeeBeans();
  createParticles();
  const status = await window.brew.getStatus();
  updateUI(status);
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

// Toggle Slack Mode
async function toggleSlackMode() {
  const status = await window.brew.toggleSlackMode();
  updateUI(status);
}

// Toggle Omni Mode
async function toggleOmniMode() {
  const status = await window.brew.toggleOmniMode();
  updateUI(status);
}

// Update UI based on status
function updateUI(status) {
  isAwake = status.isAwake;
  isSlackMode = status.isSlackMode;
  isOmniMode = status.isOmniMode;

  // Brew state
  if (isAwake) {
    document.body.classList.add('brewing');
    btnOn.classList.add('active');
    btnOff.classList.remove('active');
    timerSection.classList.add('active');

    const extras = [];
    if (isSlackMode) extras.push('Slack');
    if (isOmniMode) extras.push('Omni');
    if (extras.length > 0) {
      statusText.textContent = `Brewing + ${extras.join(' + ')} Online`;
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

  // Omni mode state
  const omniToggleSwitch = document.getElementById('omniToggleSwitch');
  const omniToggleRow = document.querySelector('.omni-toggle-row');
  const omniDesc = document.getElementById('omniDesc');
  if (isOmniMode) {
    omniToggleSwitch.classList.add('active');
    omniToggleRow.classList.add('active');
    omniDesc.textContent = 'Active - refreshing every 3 min';
  } else {
    omniToggleSwitch.classList.remove('active');
    omniToggleRow.classList.remove('active');
    omniDesc.textContent = 'Refreshes presence every 3 min';
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

let updateDownloadUrl = null;

const updateLabel = document.getElementById('updateLabel');
const updateDesc = document.getElementById('updateDesc');
const currentVersionEl = document.getElementById('currentVersion');
const updateBadge = document.getElementById('updateBadge');
const updateDetails = document.getElementById('updateDetails');
const latestVersionEl = document.getElementById('latestVersion');
const updateNotes = document.getElementById('updateNotes');
const updateIcon = document.getElementById('updateIcon');
const updateSection = document.getElementById('updateSection');

const updateIconWrap = document.getElementById('updateIconWrap');

async function checkForUpdates() {
  // Show loading state with coffee pour animation
  updateLabel.textContent = 'Brewing update check...';
  updateIconWrap.classList.add('checking');
  updateBadge.style.display = 'none';
  updateDetails.style.display = 'none';

  const result = await window.brew.checkForUpdates();

  updateIconWrap.classList.remove('checking');

  if (!result.success) {
    updateLabel.textContent = 'Update check failed';
    updateDesc.textContent = result.error || 'Network error';
    setTimeout(() => {
      updateLabel.textContent = 'Check for Updates';
      updateDesc.innerHTML = `v<span id="currentVersion">${currentVersionEl.textContent}</span>`;
    }, 3000);
    return;
  }

  if (result.noReleases) {
    updateLabel.textContent = 'You\'re up to date!';
    updateDesc.textContent = `v${result.currentVersion} — no newer releases found`;
    setTimeout(() => {
      updateLabel.textContent = 'Check for Updates';
      updateDesc.innerHTML = `v<span id="currentVersion">${result.currentVersion}</span>`;
    }, 3000);
    return;
  }

  currentVersionEl.textContent = result.currentVersion;

  if (result.hasUpdate) {
    updateLabel.textContent = 'Update Available!';
    updateDesc.textContent = `v${result.currentVersion} → v${result.latestVersion}`;
    updateBadge.style.display = 'flex';
    latestVersionEl.textContent = result.latestVersion;
    updateNotes.textContent = result.releaseNotes
      ? result.releaseNotes.substring(0, 150) + (result.releaseNotes.length > 150 ? '...' : '')
      : 'A new version is available.';
    updateDetails.style.display = 'block';
    updateDownloadUrl = result.downloadUrl || result.releaseUrl;
    updateSection.classList.add('has-update');
  } else {
    updateLabel.textContent = 'You\'re up to date!';
    updateDesc.textContent = `v${result.currentVersion} is the latest`;
    updateBadge.style.display = 'none';
    updateDetails.style.display = 'none';
    updateSection.classList.remove('has-update');
    setTimeout(() => {
      updateLabel.textContent = 'Check for Updates';
      updateDesc.innerHTML = `v<span id="currentVersion">${result.currentVersion}</span>`;
    }, 3000);
  }
}

async function downloadUpdate() {
  if (!updateDownloadUrl) return;

  const btnUpdate = document.getElementById('btnUpdate');
  const updateProgress = document.getElementById('updateProgress');
  const btnRestart = document.getElementById('btnRestart');

  // Hide button, show progress
  btnUpdate.style.display = 'none';
  updateProgress.style.display = 'block';

  const result = await window.brew.downloadAndInstall(updateDownloadUrl);

  if (!result.success) {
    // Show error and restore button
    updateProgress.style.display = 'none';
    btnUpdate.style.display = 'flex';
    updateLabel.textContent = 'Install failed';
    updateDesc.textContent = result.error || 'Unknown error';
  }
}

function restartApp() {
  window.brew.restartApp();
}

// Listen for download/install progress updates
window.brew.onUpdateProgress((progress) => {
  const progressLabel = document.getElementById('updateProgressLabel');
  const progressFill = document.getElementById('updateProgressFill');
  const progressPercent = document.getElementById('updateProgressPercent');
  const updateProgress = document.getElementById('updateProgress');
  const btnRestart = document.getElementById('btnRestart');

  if (progress.stage === 'downloading') {
    progressLabel.textContent = 'Downloading...';
    progressFill.style.width = `${progress.percent}%`;
    progressPercent.textContent = `${progress.percent}%`;
  } else if (progress.stage === 'installing') {
    progressLabel.textContent = 'Installing...';
    progressFill.style.width = '100%';
    progressPercent.textContent = '';
    progressFill.classList.add('installing');
  } else if (progress.stage === 'done') {
    updateProgress.style.display = 'none';
    btnRestart.style.display = 'flex';
    updateLabel.textContent = 'Update Installed!';
    updateDesc.textContent = 'Restart to use the new version';
  } else if (progress.stage === 'error') {
    progressLabel.textContent = `Error: ${progress.error}`;
    progressFill.style.width = '100%';
    progressFill.classList.add('error');
  }
});

// Set initial version display
async function initVersion() {
  const version = await window.brew.getAppVersion();
  currentVersionEl.textContent = version;
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
