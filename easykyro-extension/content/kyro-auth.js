/* Runs only on kyro.new.tg. The website stores its Discord session under
 * localStorage["kyro.auth.v1"] as { state, user, token }. When the user signs
 * in with Discord, this script forwards the token to the extension so both
 * share one login. It never reads cookies and never talks to the page.
 */
(() => {
  const KEY = 'kyro.auth.v1';
  const MAX_WAIT_MS = 5 * 60 * 1000;
  let lastToken = '';

  function readAuth() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return null;
      const value = JSON.parse(raw);
      if (!value || typeof value.token !== 'string' || !value.token) return null;
      return value;
    } catch {
      return null;
    }
  }

  function forward(auth) {
    if (!auth || auth.token === lastToken) return;
    lastToken = auth.token;
    try {
      chrome.runtime.sendMessage(
        { type: 'EASYKYRO_AUTH', token: auth.token, user: auth.user || null },
        () => void chrome.runtime.lastError
      );
    } catch {
      /* Extension was reloaded or removed; nothing to do. */
    }
  }

  forward(readAuth());

  const started = Date.now();
  const timer = setInterval(() => {
    forward(readAuth());
    if (Date.now() - started > MAX_WAIT_MS) clearInterval(timer);
  }, 1200);

  /* The popup may open while this tab already holds a session. Hand it over on
   * request so the connection shows up without another page load. */
  try {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message || message.type !== 'EASYKYRO_READ_SESSION') return;
      const auth = readAuth();
      sendResponse({ ok: Boolean(auth), token: auth ? auth.token : '' });
    });
  } catch {
    /* Extension context invalidated. */
  }

  window.addEventListener('focus', () => forward(readAuth()));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) forward(readAuth());
  });
})();
