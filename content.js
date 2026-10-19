(() => {
  if (window.__typingLabContentLoaded) return;
  window.__typingLabContentLoaded = true;

  let rollingCount = 0;
  const ROLLING_LIMIT = 180;

  function findTargetInput() {
    // 1. WhatsApp Web / Lexical message compose box (footer contenteditable)
    const waCompose =
      document.querySelector('footer div[contenteditable="true"][role="textbox"]') ||
      document.querySelector('div[contenteditable="true"][data-tab="10"]') ||
      document.querySelector('#main footer div[contenteditable="true"]');
    if (waCompose) return waCompose;

    // 2. Currently focused editable element
    if (document.activeElement && (
      document.activeElement.isContentEditable ||
      document.activeElement.tagName === 'TEXTAREA' ||
      document.activeElement.tagName === 'INPUT'
    )) {
      return document.activeElement;
    }

    // 3. Any visible editable element on the page
    return document.querySelector('div[contenteditable="true"], textarea');
  }

  function placeCaretAtEnd(el) {
    el.focus({ preventScroll: true });
    if (el.isContentEditable) {
      const sel = window.getSelection();
      if (!sel) return;
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    } else if (typeof el.selectionStart === 'number') {
      const len = el.value.length;
      el.setSelectionRange(len, len);
    }
  }

  function clearRollingDraft(el) {
    el.focus({ preventScroll: true });
    if (el.isContentEditable) {
      const sel = window.getSelection();
      if (!sel) return;
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);

      el.dispatchEvent(new InputEvent('beforeinput', {
        inputType: 'deleteContentBackward',
        bubbles: true,
        cancelable: true,
        composed: true
      }));
      document.execCommand('delete', false, null);
    } else {
      el.value = '';
      el.dispatchEvent(new InputEvent('input', {
        inputType: 'deleteContentBackward',
        bubbles: true
      }));
    }
    rollingCount = 0;
  }

  function insertSafeChar(el, rawChar, bufferMode) {
    // HARD SAFETY GUARD: never allow CR/LF/Tab to be typed (no Enter, no message send)
    const char = (rawChar === '\n' || rawChar === '\r' || rawChar === '\t') ? ' ' : rawChar;

    if (bufferMode === 'rolling' && rollingCount >= ROLLING_LIMIT) {
      clearRollingDraft(el);
    }

    placeCaretAtEnd(el);

    const keyOpts = {
      key: char,
      code: char === ' ' ? 'Space' : `Key${char.toUpperCase()}`,
      bubbles: true,
      cancelable: true,
      composed: true
    };

    el.dispatchEvent(new KeyboardEvent('keydown', keyOpts));

    if (el.isContentEditable) {
      // Lexical / modern editors listen to beforeinput + execCommand('insertText')
      const beforeInputEvt = new InputEvent('beforeinput', {
        inputType: 'insertText',
        data: char,
        bubbles: true,
        cancelable: true,
        composed: true
      });
      const notCancelled = el.dispatchEvent(beforeInputEvt);

      if (notCancelled) {
        document.execCommand('insertText', false, char);
      }
    } else {
      el.value += char;
      el.dispatchEvent(new InputEvent('input', {
        inputType: 'insertText',
        data: char,
        bubbles: true,
        composed: true
      }));
    }

    el.dispatchEvent(new KeyboardEvent('keyup', keyOpts));
    rollingCount++;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'SET_FOCUS_SPOOF') {
      window.postMessage({ source: 'TYPINGLAB_EXT', active: msg.active }, '*');
      if (!msg.active) rollingCount = 0;
      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === 'TYPE_CHARS') {
      const el = findTargetInput();
      if (!el) {
        sendResponse({ ok: false, error: 'NO_INPUT_BOX_FOUND' });
        return false;
      }
      for (const ch of msg.chars) {
        insertSafeChar(el, ch, msg.bufferMode);
      }
      sendResponse({ ok: true });
      return false;
    }
  });
})();