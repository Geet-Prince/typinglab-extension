/* Unthrottled Web Worker timer inside Offscreen Document */
const workerCode = `
  let timerId = null;
  self.onmessage = (e) => {
    if (e.data.cmd === 'START') {
      if (timerId) clearInterval(timerId);
      timerId = setInterval(() => self.postMessage('TICK'), e.data.intervalMs || 450);
    } else if (e.data.cmd === 'STOP') {
      if (timerId) clearInterval(timerId);
      timerId = null;
    }
  };
`;

const blob = new Blob([workerCode], { type: 'application/javascript' });
const worker = new Worker(URL.createObjectURL(blob));

worker.onmessage = () => {
  chrome.runtime.sendMessage({ type: 'OFFSCREEN_TICK', now: Date.now() }).catch(() => {});
};

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'OFFSCREEN') return;
  if (msg.cmd === 'START_TIMER') {
    worker.postMessage({ cmd: 'START', intervalMs: msg.intervalMs });
  } else if (msg.cmd === 'STOP_TIMER') {
    worker.postMessage({ cmd: 'STOP' });
  }
});