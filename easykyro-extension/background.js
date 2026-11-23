/* EasyKyro background service worker.
 *
 * The popup does the talking to the Kyro worker and to Gemini. The background
 * owns the Discord hand-off: the website already runs the OAuth flow, so this
 * worker reads the session the site stored (in any open kyro.new.tg tab) and
 * verifies it. That keeps the extension on exactly the same login as the
 * website — no second Discord app, no extra redirect URI.
 */

const WORKER = 'https://kyro-auth.kyro-ownr.workers.dev';
const SITE_TABS = 'https://kyro.new.tg/*';

/* Right-click entry points. They only save what the user pointed at and open
 * the popup, which still does all the reading and posting. */
function createMenus() {
  if (!chrome.contextMenus) return;
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'easykyro-page',
      title: 'Send this page to EasyKyro',
      contexts: ['page']
    });
    chrome.contextMenus.create({
      id: 'easykyro-link',
      title: 'Request this link in EasyKyro',
      contexts: ['link']
    });
    chrome.contextMenus.create({
      id: 'easykyro-selection',
      title: 'Request "%s" in EasyKyro',
      contexts: ['selection']
    });
  });
}

function openPopup() {
  if (!chrome.action || !chrome.action.openPopup) return;
  chrome.action.openPopup().catch(() => {
    /* Older builds refuse without a gesture: the saved hint is still used the
     * next time the user opens the popup. */
  });
}

if (chrome.contextMenus) {
  chrome.runtime.onInstalled.addListener(createMenus);
  chrome.runtime.onStartup.addListener(createMenus);

  chrome.contextMenus.onClicked.addListener((info) => {
    const hint = {
      url: info.linkUrl || info.pageUrl || '',
      text: String(info.selectionText || '').slice(0, 1200),
      at: Date.now()
    };
    chrome.storage.local.set({ hint }).catch(() => {});
    openPopup();
  });
}

async function verifyToken(token) {
  const res = await fetch(WORKER + '/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Discord sign-in could not be verified.');
  return data;
}

function toAuth(token, data) {
  return {
    token,
    user: {
      id: String(data.id || ''),
      username: data.username || 'editor',
      avatar: data.avatar || '',
      inServer: Boolean(data.in_server),
      isOwner: Boolean(data.is_owner),
      role: data.role || 'Member'
    },
    verifiedAt: Date.now()
  };
}

/* Injected into a kyro.new.tg tab. Must stay self-contained: Chrome serialises
 * this function into the page. It only reads the session the site itself saved. */
function readSiteSession() {
  try {
    const raw = localStorage.getItem('kyro.auth.v1');
    if (!raw) return null;
    const value = JSON.parse(raw);
    if (!value || typeof value.token !== 'string' || !value.token) return null;
    return { token: value.token };
  } catch {
    return null;
  }
}

/* Find the session in any open Kyro tab and turn it into extension auth. */
async function syncFromSite() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: SITE_TABS });
  } catch {
    tabs = [];
  }

  let token = '';
  for (const tab of tabs) {
    if (!tab || !tab.id) continue;
    try {
      const [injection] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readSiteSession });
      if (injection && injection.result && injection.result.token) {
        token = injection.result.token;
        break;
      }
    } catch {
      /* Tab is discarded, loading or restricted; try the next one. */
    }
  }
  if (!token) return { ok: false, reason: 'no_session' };

  const stored = await chrome.storage.local.get('auth').catch(() => ({}));
  const current = stored && stored.auth;
  if (current && current.token === token && Date.now() - (current.verifiedAt || 0) < 60 * 1000) {
    return { ok: true, auth: current };
  }

  const data = await verifyToken(token);
  const auth = toAuth(token, data);
  await chrome.storage.local.set({ auth });
  return { ok: true, auth };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return;

  if (message.type === 'EASYKYRO_AUTH' && typeof message.token === 'string' && message.token) {
    (async () => {
      try {
        const stored = await chrome.storage.local.get('auth');
        const current = stored && stored.auth;
        // The content script runs on every Kyro page load; skip the Discord
        // round-trip when the same token was verified minutes ago.
        if (current && current.token === message.token && Date.now() - (current.verifiedAt || 0) < 5 * 60 * 1000) {
          sendResponse({ ok: true, auth: current });
          return;
        }
        const data = await verifyToken(message.token);
        const auth = toAuth(message.token, data);
        await chrome.storage.local.set({ auth });
        sendResponse({ ok: true, auth });
        // The popup is usually closed while the login tab has focus, so this
        // broadcast is best-effort only.
        chrome.runtime.sendMessage({ type: 'EASYKYRO_AUTH_CHANGED', auth }).catch(() => {});
      } catch (err) {
        sendResponse({ ok: false, error: err.message || 'Discord sign-in failed.' });
      }
    })();
    return true;
  }

  /* The popup asks once on open: "does the website already know me?" */
  if (message.type === 'EASYKYRO_SYNC') {
    (async () => {
      try {
        const result = await syncFromSite();
        sendResponse(result);
      } catch (err) {
        sendResponse({ ok: false, error: err.message || 'Could not read the Kyro session.' });
      }
    })();
    return true;
  }

  if (message.type === 'EASYKYRO_OPEN_LOGIN') {
    (async () => {
      try {
        const tab = await chrome.tabs.create({ url: 'https://kyro.new.tg/?easykyro=login' });
        sendResponse({ ok: true, tabId: tab.id });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || 'Could not open the Kyro site.' });
      }
    })();
    return true;
  }

  if (message.type === 'EASYKYRO_LOGOUT') {
    chrome.storage.local.remove('auth')
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});
