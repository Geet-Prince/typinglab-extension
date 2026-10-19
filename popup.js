const MAX_PDF_SLICE_BYTES = 524288;
const MAX_TXT_SLICE_BYTES = 102400;

const statusBadge = document.getElementById('statusBadge');
const countdownEl = document.getElementById('countdown');
const progressFill = document.getElementById('progressFill');
const milestoneVal = document.getElementById('milestoneVal');
const exactCharsVal = document.getElementById('exactCharsVal');
const errorBox = document.getElementById('errorBox');
const configSection = document.getElementById('configSection');
const sourceTextEl = document.getElementById('sourceText');
const fileInput = document.getElementById('fileInput');
const durationSelect = document.getElementById('durationSelect');
const paceSelect = document.getElementById('paceSelect');
const bufferModeSelect = document.getElementById('bufferModeSelect');
const startBtn = document.getElementById('startBtn');
const pauseBtn = document.getElementById('pauseBtn');
const stopBtn = document.getElementById('stopBtn');

let currentState = null;

function updateInitialCountdown() {
  if (!currentState || (currentState.status !== 'RUNNING' && currentState.status !== 'PAUSED')) {
    const mins = String(durationSelect.value || 20).padStart(2, '0');
    countdownEl.textContent = `${mins}:00`;
  }
}

// Load persisted user text and settings from storage immediately on popup open
chrome.storage.local.get(['persistedUserText', 'persistedDuration', 'persistedPace', 'persistedBufferMode'], (res) => {
  if (res.persistedUserText) {
    sourceTextEl.value = res.persistedUserText;
  }
  if (res.persistedDuration && durationSelect) {
    durationSelect.value = res.persistedDuration;
  }
  if (res.persistedPace && paceSelect) {
    paceSelect.value = res.persistedPace;
  }
  if (res.persistedBufferMode && bufferModeSelect) {
    bufferModeSelect.value = res.persistedBufferMode;
  }
  updateInitialCountdown();
});

// Auto-save user input text instantly into local storage as they type/paste
sourceTextEl.addEventListener('input', () => {
  chrome.storage.local.set({ persistedUserText: sourceTextEl.value });
});

// Update countdown and persist duration choice
durationSelect.addEventListener('change', () => {
  chrome.storage.local.set({ persistedDuration: durationSelect.value });
  updateInitialCountdown();
});

paceSelect.addEventListener('change', () => {
  chrome.storage.local.set({ persistedPace: paceSelect.value });
});

bufferModeSelect.addEventListener('change', () => {
  chrome.storage.local.set({ persistedBufferMode: bufferModeSelect.value });
});

function formatMMSS(ms, durationMs) {
  const targetDuration = durationMs || 1200000;
  const clamped = Math.max(0, Math.min(targetDuration, ms));
  const totalSec = Math.ceil(clamped / 1000);
  const m = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const s = String(totalSec % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function render(state) {
  currentState = state;
  statusBadge.textContent = state.status;
  statusBadge.className = `badge ${state.status}`;

  const isRunningOrPaused = state.status === 'RUNNING' || state.status === 'PAUSED';
  const durationMs = state.durationMs || (parseInt(durationSelect.value, 10) * 60000) || 1200000;
  const elapsed = isRunningOrPaused && state.startedAt
    ? (state.status === 'RUNNING' ? Date.now() - state.startedAt : state.elapsedMs)
    : (state.elapsedMs || 0);

  const remaining = Math.max(0, durationMs - elapsed);
  const mins = String(durationSelect.value || 20).padStart(2, '0');
  countdownEl.textContent = isRunningOrPaused ? formatMMSS(remaining, durationMs) : `${mins}:00`;

  const pct = Math.min(100, (elapsed / durationMs) * 100);
  progressFill.style.width = `${isRunningOrPaused ? pct : 0}%`;

  milestoneVal.textContent = `${(state.lastMilestone || 0).toLocaleString()} chars`;
  exactCharsVal.textContent = `${(state.processedChars || 0).toLocaleString()} / ${(state.totalChars || 0).toLocaleString()}`;

  if (state.errorReason) {
    errorBox.style.display = 'block';
    errorBox.textContent = state.errorReason;
  } else {
    errorBox.style.display = 'none';
  }

  configSection.style.display = isRunningOrPaused ? 'none' : 'flex';
  startBtn.style.display = isRunningOrPaused ? 'none' : 'block';
  pauseBtn.style.display = isRunningOrPaused ? 'block' : 'none';
  stopBtn.style.display = isRunningOrPaused ? 'block' : 'none';

  if (state.status === 'PAUSED') {
    pauseBtn.textContent = 'Resume';
  } else {
    pauseBtn.textContent = 'Pause';
  }
}

fileInput.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  let extracted = '';
  if (file.name.endsWith('.pdf')) {
    const slice = file.slice(0, MAX_PDF_SLICE_BYTES);
    const buf = await slice.arrayBuffer();
    const raw = new TextDecoder('latin1').decode(buf);
    const matches = [...raw.matchAll(/\(([^()\\]{2,})\)/g)].map(m => m[1]);
    extracted = matches.join(' ').replace(/[^\x20-\x7E]+/g, ' ').trim().slice(0, 25000);
  } else {
    const slice = file.slice(0, MAX_TXT_SLICE_BYTES);
    extracted = (await slice.text()).slice(0, 25000);
  }

  sourceTextEl.value = extracted || 'Failed to read document text.';
  chrome.storage.local.set({ persistedUserText: sourceTextEl.value });
});

startBtn.addEventListener('click', () => {
  errorBox.style.display = 'none';
  chrome.runtime.sendMessage({
    type: 'CMD_START',
    text: sourceTextEl.value,
    durationMinutes: durationSelect.value,
    pace: paceSelect.value,
    bufferMode: bufferModeSelect.value
  }, (res) => {
    if (res && !res.ok) {
      errorBox.style.display = 'block';
      errorBox.textContent = res.error || 'Failed to start.';
    } else if (res?.state) {
      render(res.state);
    }
  });
});

pauseBtn.addEventListener('click', () => {
  if (!currentState) return;
  const cmd = currentState.status === 'PAUSED' ? 'CMD_RESUME' : 'CMD_PAUSE';
  chrome.runtime.sendMessage({ type: cmd }, (res) => {
    if (res?.state) render(res.state);
  });
});

stopBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'CMD_STOP' }, (res) => {
    if (res?.state) render(res.state);
  });
});

function syncState() {
  chrome.runtime.sendMessage({ type: 'GET_STATE' }, (res) => {
    if (res?.state) render(res.state);
  });
}

syncState();
setInterval(syncState, 1000);

const toggleLogsBtn = document.getElementById('toggleLogsBtn');
const clearLogsBtn = document.getElementById('clearLogsBtn');
const logsDrawer = document.getElementById('logsDrawer');
const logsList = document.getElementById('logsList');
let logsOpen = false;

function renderLogs() {
  chrome.storage.local.get(['sessionLogs'], (res) => {
    const logs = Array.isArray(res.sessionLogs) ? res.sessionLogs : [];
    const errCount = logs.filter(l => l.level === 'ERROR').length;
    toggleLogsBtn.textContent = errCount > 0
      ? `View Logs (${logs.length} · ${errCount} ERR)`
      : `View Logs (${logs.length})`;
    toggleLogsBtn.style.color = errCount > 0 ? '#ef4444' : '#9ca3af';

    if (!logsOpen) return;
    if (logs.length === 0) {
      logsList.innerHTML = '<div style="color:#9ca3af;">No logs recorded yet.</div>';
      return;
    }

    logsList.innerHTML = logs.map(item => {
      const color = item.level === 'ERROR' ? '#ef4444' : (item.level === 'WARN' ? '#f59e0b' : '#10b981');
      const detailText = item.details ? `<div style="color:#9ca3af; font-size:10px;">${item.details}</div>` : '';
      return `<div style="border-bottom:1px solid #2b3036; padding-bottom:4px;">
        <span style="color:#9ca3af;">[${item.time}]</span>
        <strong style="color:${color};"> ${item.level}:</strong>
        <span> ${item.message}</span>
        ${detailText}
      </div>`;
    }).join('');
  });
}

toggleLogsBtn.addEventListener('click', () => {
  logsOpen = !logsOpen;
  logsDrawer.style.display = logsOpen ? 'block' : 'none';
  clearLogsBtn.style.display = logsOpen ? 'block' : 'none';
  if (logsOpen) renderLogs();
});

clearLogsBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'CLEAR_LOGS' }, () => renderLogs());
});

renderLogs();
setInterval(renderLogs, 1500);