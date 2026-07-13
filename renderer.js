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

// Listen for status changes from main process
window.brew.onStatusChanged((status) => {
  updateUI(status);
});

// Initialize on load
init();
