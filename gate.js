// Lock screen shown when Brew has no verified SOMA connection. The app cannot
// proceed to its main UI until a token is pasted and verified here. On success
// we ask the main process to unlock, which reloads the window into index.html.

// Reuse the same background particles as the main window for visual continuity.
function createParticles() {
  const particlesContainer = document.getElementById('particles');
  if (!particlesContainer) return;
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

const gateConnectBtn = document.getElementById('gateConnectBtn');
const gateConnectBox = document.getElementById('gateConnectBox');
const gateTokenInput = document.getElementById('gateTokenInput');
const gateConnectMsg = document.getElementById('gateConnectMsg');

function cleanErrorMessage(msg) {
  return String(msg || '')
    .replace(/^Error:\s*/i, '')
    .replace(/^.*Error invoking remote method '[^']+':\s*/i, '');
}

function setGateMsg(text, kind) {
  if (!gateConnectMsg) return;
  if (!text) {
    gateConnectMsg.style.display = 'none';
    gateConnectMsg.textContent = '';
    gateConnectMsg.classList.remove('ok', 'err');
    return;
  }
  gateConnectMsg.textContent = text;
  gateConnectMsg.style.display = 'block';
  gateConnectMsg.classList.remove('ok', 'err');
  if (kind) gateConnectMsg.classList.add(kind);
}

// "Connect to SOMA" — open the token page and reveal the paste box.
async function gateConnect() {
  try {
    await window.brew.updateOpenTokenPage();
  } catch {
    /* opening the browser is best-effort */
  }
  gateConnectBox.style.display = 'block';
  setGateMsg('');
  gateTokenInput.value = '';
  gateTokenInput.focus();
}

// "Save & Verify" — persist + verify the token. On success, unlock the app.
async function gateSaveToken() {
  const token = gateTokenInput.value.trim();
  if (!token) {
    setGateMsg('Paste a token first.', 'err');
    return;
  }
  const btn = document.getElementById('gateSaveBtn');
  btn.disabled = true;
  setGateMsg('Verifying…', null);
  try {
    const res = await window.brew.updateConnect(token);
    if (res.ok) {
      gateTokenInput.value = '';
      setGateMsg(`Connected${res.login ? ' as ' + res.login : ''}. Unlocking…`, 'ok');
      // Hand off to the main process, which reloads the window into index.html.
      await window.brew.unlock();
    } else {
      setGateMsg(cleanErrorMessage(res.message || 'Token could not be verified.'), 'err');
      btn.disabled = false;
    }
  } catch (e) {
    setGateMsg(cleanErrorMessage((e && e.message) || e), 'err');
    btn.disabled = false;
  }
}

if (gateTokenInput) {
  gateTokenInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      gateSaveToken();
    }
  });
}

createParticles();
