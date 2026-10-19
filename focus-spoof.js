(() => {
  if (window.__typingLabFocusInstalled) return;
  window.__typingLabFocusInstalled = true;
  window.__typingLabActive = false;

  const origHasFocus = Document.prototype.hasFocus;
  const origVisDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
  const origHiddenDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');

  Document.prototype.hasFocus = function () {
    if (window.__typingLabActive) return true;
    return origHasFocus.apply(this, arguments);
  };

  if (origVisDesc) {
    Object.defineProperty(Document.prototype, 'visibilityState', {
      get() {
        if (window.__typingLabActive) return 'visible';
        return origVisDesc.get.call(this);
      },
      configurable: true
    });
  }

  if (origHiddenDesc) {
    Object.defineProperty(Document.prototype, 'hidden', {
      get() {
        if (window.__typingLabActive) return false;
        return origHiddenDesc.get.call(this);
      },
      configurable: true
    });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.source !== 'TYPINGLAB_EXT') return;
    window.__typingLabActive = Boolean(event.data.active);
    if (window.__typingLabActive) {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    }
  });
})();