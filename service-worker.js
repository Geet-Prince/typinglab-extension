/* TypingLab - Background Service Worker */
const DEFAULT_DURATION_MS = 1200000; /* 20 mins */
const MAX_CHAR_CAP = 25000;
const MILESTONE_STEP = 1000;
const MAX_LOGS = 50;
const ALARM_NAME = 'TYPINGLAB_HARD_DEADLINE';

const SPEED_PROFILES = {
  steady:  { minDelayMs: 160, rangeMs: 70, pauseChance: 0.03, pauseMs: 650 },
  natural: { minDelayMs: 95,  rangeMs: 90, pauseChance: 0.07, pauseMs: 1000 },
  fast:    { minDelayMs: 65,  rangeMs: 50, pauseChance: 0.04, pauseMs: 500 }
};

let runtimeCache = null;

function createInitialState() {
  return {
    status: 'IDLE',
    sessionId: null,
    targetTabId: null,
    startedAt: null,
    deadlineAt: null,
    durationMs: DEFAULT_DURATION_MS,
    elapsedMs: 0,
    lastTickAt: null,
    nextCharAt: null,
    totalChars: 0,
    processedChars: 0,
    lastMilestone: 0,
    pace: 'natural',
    bufferMode: 'rolling',
    errorReason: null
  };
}

/* Persistent Error & Event Logger (Ring buffer of 50 entries in chrome.storage.local) */
async function appendLog(level, message, details = '') {
  try {
    const data = await chrome.storage.local.get(['sessionLogs']);
    const logs = Array.isArray(data.sessionLogs) ? data.sessionLogs : [];
    const entry = {
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      time: new Date().toLocaleTimeString(),
      level, /* 'INFO' | 'WARN' | 'ERROR' */
      message,
      details
    };
    logs.unshift(entry);
    if (logs.length > MAX_LOGS) logs.length = MAX_LOGS;
    await chrome.storage.local.set({ sessionLogs: logs });
  } catch (_e) {}
}

function updateBadge(status) {
  if (status === 'RUNNING') {
    chrome.action.setBadgeText({ text: 'ON' });
    chrome.action.setBadgeBackgroundColor({ color: '#10b981' });
  } else if (status === 'PAUSED') {
    chrome.action.setBadgeText({ text: 'II' });
    chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
  } else if (status === 'ERROR') {
    chrome.action.setBadgeText({ text: 'ERR' });
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

async function getState() {
  if (runtimeCache) return runtimeCache;
  const data = await chrome.storage.session.get(['sessionState', 'textBuffer']);
  runtimeCache = {
    state: data.sessionState || createInitialState(),
    textBuffer: data.textBuffer || ''
  };
  return runtimeCache;
}

async function saveState(state, textBuffer = undefined) {
  const cache = await getState();
  cache.state = state;
  const payload = { sessionState: state };
  if (textBuffer !== undefined) {
    cache.textBuffer = textBuffer;
    payload.textBuffer = textBuffer;
  }
  updateBadge(state.status);
  await chrome.storage.session.set(payload);
}

/* Keeps CPU + Offscreen Worker awake even when macOS screen is locked */
async function setSystemKeepAwake(active) {
  try {
    if (active) {
      chrome.power.requestKeepAwake('system');
    } else {
      chrome.power.releaseKeepAwake();
    }
  } catch (e) {
    await appendLog('WARN', 'Power keep-awake API unavailable', e.message);
  }
}

async function ensureOffscreenTimer(active) {
  let hasDoc = false;
  try {
    hasDoc = await chrome.offscreen.hasDocument();
  } catch (_e) {}

  if (active) {
    if (!hasDoc) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['DOM_SCRAPING'],
        justification: 'Humanized background typing simulation timer'
      });
    }
    chrome.runtime.sendMessage({ target: 'OFFSCREEN', cmd: 'START_TIMER', intervalMs: 400 }).catch(() => {});
  } else if (hasDoc) {
    chrome.runtime.sendMessage({ target: 'OFFSCREEN', cmd: 'STOP_TIMER' }).catch(() => {});
    await chrome.offscreen.closeDocument().catch(() => {});
  }
}

/* ANTI-BOT HUMANIZED TEXT SYNTHESIZER:
   Tokenizes input text, dynamically injects conversational filler phrases every ~10 words,
   and normalizes spacing to look completely organic and defeat anti-bot heuristics. */
function buildHumanizedCorpus(rawText) {
  const clean = String(rawText || '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (!clean) return '';

  const fillerPhrases = [
    'well', 'let me check', 'hold on', 'actually',
    'give me a second', 'true', 'sounds good', 'got it', 'mmhm'
  ];

  const words = clean.split(' ');
  let synthesized = '';

  for (let i = 0; i < words.length; i++) {
    synthesized += words[i] + ' ';
    // Every ~10 words, inject a natural conversational filler phrase
    if (i > 0 && i % 10 === 0 && Math.random() < 0.6) {
      const randomFiller = fillerPhrases[Math.floor(Math.random() * fillerPhrases.length)];
      synthesized += randomFiller + ' ';
    }
  }

  return synthesized.replace(/\s{2,}/g, ' ').trim().slice(0, MAX_CHAR_CAP);
}

function computeNextDelay(paceKey, char) {
  const p = SPEED_PROFILES[paceKey] || SPEED_PROFILES.natural;
  let delay = p.minDelayMs + Math.round(Math.random() * p.rangeMs);
  if (char === '.' || char === ',' || char === ' ') {
    if (Math.random() < p.pauseChance) {
      delay += p.pauseMs;
    }
  }
  return delay;
}

async function injectScriptsIntoTab(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['focus-spoof.js'],
    world: 'MAIN'
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js'],
    world: 'ISOLATED'
  });
  await chrome.tabs.sendMessage(tabId, { type: 'SET_FOCUS_SPOOF', active: true });
}

async function disableFocusSpoof(tabId) {
  if (!tabId) return;
  await chrome.tabs.sendMessage(tabId, { type: 'SET_FOCUS_SPOOF', active: false }).catch(() => {});
}

async function stopAndCleanup(finalStatus, errorReason = null) {
  const { state } = await getState();
  await ensureOffscreenTimer(false).catch(() => {});
  await setSystemKeepAwake(false);
  await chrome.alarms.clear(ALARM_NAME).catch(() => {});
  await disableFocusSpoof(state.targetTabId).catch(() => {});

  const now = Date.now();
  const duration = state.durationMs || DEFAULT_DURATION_MS;
  const updated = {
    ...state,
    status: finalStatus,
    elapsedMs: state.startedAt ? Math.min(duration, now - state.startedAt) : state.elapsedMs,
    errorReason,
    lastTickAt: null,
    nextCharAt: null
  };
  await saveState(updated, '');

  if (finalStatus === 'ERROR') {
    await appendLog('ERROR', errorReason || 'Unknown session error', `Typed ${state.processedChars} chars before failure.`);
  } else {
    await appendLog('INFO', `Session ended: ${finalStatus}`, `Total typed: ${state.processedChars} chars.`);
  }
  return updated;
}

async function handleTick(now) {
  const { state, textBuffer } = await getState();
  if (state.status !== 'RUNNING') return;

  if (now >= state.deadlineAt) {
    await stopAndCleanup('EXPIRED');
    return;
  }

  if (!textBuffer) {
    await stopAndCleanup('COMPLETED');
    return;
  }

  state.elapsedMs = now - state.startedAt;
  if (now < state.nextCharAt) return;

  let charsToSend = '';
  let cursor = state.processedChars;
  let scheduledTime = state.nextCharAt;
  let steps = 0;

  while (scheduledTime <= now && steps < 5) {
    const ch = textBuffer[cursor % textBuffer.length];
    charsToSend += ch;
    cursor++;
    steps++;
    scheduledTime += computeNextDelay(state.pace, ch);
  }

  if (scheduledTime < now) {
    scheduledTime = now + computeNextDelay(state.pace, ' ');
  }

  if (state.targetTabId && charsToSend.length > 0) {
    try {
      const res = await chrome.tabs.sendMessage(state.targetTabId, {
        type: 'TYPE_CHARS',
        chars: charsToSend,
        bufferMode: state.bufferMode
      });
      if (!res || !res.ok) {
        const errCode = (res && res.error) ? res.error : 'NO_INPUT_BOX';
        await stopAndCleanup('ERROR', `Input box lost (${errCode}). Open chat box & retry.`);
        return;
      }
    } catch (err) {
      await stopAndCleanup('ERROR', `Target tab unreachable or closed (${err.message || 'IPC disconnected'}).`);
      return;
    }
  }

  const prevMilestone = state.lastMilestone;
  state.processedChars = cursor;
  state.lastTickAt = now;
  state.nextCharAt = scheduledTime;

  const currentMilestone = Math.floor(state.processedChars / MILESTONE_STEP) * MILESTONE_STEP;
  if (currentMilestone > prevMilestone) {
    state.lastMilestone = currentMilestone;
    await saveState(state);
    await appendLog('INFO', `Milestone reached: ${currentMilestone} chars`);
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    const { state } = await getState();
    if (state.status === 'RUNNING' || state.status === 'PAUSED') {
      await stopAndCleanup('EXPIRED');
    }
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg.type === 'OFFSCREEN_TICK') {
      await handleTick(msg.now || Date.now());
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'GET_STATE') {
      const { state } = await getState();
      if ((state.status === 'RUNNING' || state.status === 'PAUSED') && Date.now() >= state.deadlineAt) {
        const expired = await stopAndCleanup('EXPIRED');
        sendResponse({ state: expired });
        return;
      }
      if (state.status === 'RUNNING' && state.startedAt) {
        state.elapsedMs = Date.now() - state.startedAt;
      }
      sendResponse({ state });
      return;
    }

    if (msg.type === 'CLEAR_LOGS') {
      await chrome.storage.local.set({ sessionLogs: [] });
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'CMD_START') {
      const humanizedCorpus = buildHumanizedCorpus(msg.text);
      if (!humanizedCorpus) {
        await appendLog('ERROR', 'Start aborted: Empty text source');
        sendResponse({ ok: false, error: 'Please provide valid text or upload a document.' });
        return;
      }

      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!activeTab || !activeTab.id || activeTab.url?.startsWith('chrome://') || activeTab.url?.startsWith('brave://')) {
        await appendLog('ERROR', 'Start aborted: Invalid active tab', activeTab?.url || 'No URL');
        sendResponse({ ok: false, error: 'Open WhatsApp Web or an active webpage before starting.' });
        return;
      }

      try {
        await injectScriptsIntoTab(activeTab.id);
      } catch (e) {
        await appendLog('ERROR', 'Script injection failed', e.message);
        sendResponse({ ok: false, error: 'Cannot inject into this page: ' + e.message });
        return;
      }

      const durationMinutes = Math.max(1, Math.min(20, parseInt(msg.durationMinutes, 10) || 20));
      const durationMs = durationMinutes * 60000;

      const now = Date.now();
      const deadlineAt = now + durationMs;
      const newState = {
        status: 'RUNNING',
        sessionId: String(now),
        targetTabId: activeTab.id,
        startedAt: now,
        deadlineAt,
        durationMs,
        elapsedMs: 0,
        lastTickAt: now,
        nextCharAt: now + 150,
        totalChars: humanizedCorpus.length,
        processedChars: 0,
        lastMilestone: 0,
        pace: msg.pace || 'natural',
        bufferMode: msg.bufferMode || 'rolling',
        errorReason: null
      };

      await saveState(newState, humanizedCorpus);
      await setSystemKeepAwake(true);
      await chrome.alarms.create(ALARM_NAME, { when: deadlineAt });
      await ensureOffscreenTimer(true);
      await appendLog('INFO', `Started ${durationMinutes}m session (${newState.pace})`, `Tab ID: ${activeTab.id}, KeepAwake: ON`);
      sendResponse({ ok: true, state: newState });
      return;
    }

    if (msg.type === 'CMD_PAUSE') {
      const { state } = await getState();
      if (state.status !== 'RUNNING') {
        sendResponse({ ok: false, state });
        return;
      }
      await ensureOffscreenTimer(false);
      await setSystemKeepAwake(false);
      state.status = 'PAUSED';
      state.elapsedMs = Date.now() - state.startedAt;
      await saveState(state);
      await appendLog('INFO', 'Session paused by user', `At ${state.processedChars} chars`);
      sendResponse({ ok: true, state });
      return;
    }

    if (msg.type === 'CMD_RESUME') {
      const { state } = await getState();
      if (state.status !== 'PAUSED') {
        sendResponse({ ok: false, state });
        return;
      }
      const now = Date.now();
      if (now >= state.deadlineAt) {
        const expired = await stopAndCleanup('EXPIRED');
        sendResponse({ ok: false, state: expired });
        return;
      }
      state.status = 'RUNNING';
      state.lastTickAt = now;
      state.nextCharAt = now + 150;
      await saveState(state);
      await setSystemKeepAwake(true);
      await ensureOffscreenTimer(true);
      await appendLog('INFO', 'Session resumed');
      sendResponse({ ok: true, state });
      return;
    }

    if (msg.type === 'CMD_STOP') {
      const stopped = await stopAndCleanup('STOPPED');
      sendResponse({ ok: true, state: stopped });
      return;
    }
  })();
  return true;
});