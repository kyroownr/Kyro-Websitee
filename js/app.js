/* ==========================================================================
   Kyro — application wiring
   Directory rendering, Discord OAuth2 sign-in, membership-gated downloads,
   command palette and Saved Vault drawer.
   ========================================================================== */
(function () {
  'use strict';

  /* =============================== config ===============================
     Live values for kyro.new.tg. The Cloudflare Worker at AUTH_WORKER_URL
     (worker.js) holds DISCORD_CLIENT_SECRET, performs the code → token
     exchange and reads the guild list; this page only ever sees the token it
     hands back on redirect. KYRO_GUILD_ID is the numeric snowflake and must
     match the worker's own env.KYRO_GUILD_ID, which is authoritative.
     ======================================================================= */
  const DISCORD_CLIENT_ID = '1570702041993711706';
  const KYRO_GUILD_ID = '1539961184323772498';
  const AUTH_WORKER_URL = 'https://kyro-auth.kyro-ownr.workers.dev';
  const DISCORD_INVITE_URL = 'https://discord.gg/5ch7XeNg98';

  const REDIRECT_URI = AUTH_WORKER_URL + '/callback';
  const INVITE_URL = DISCORD_INVITE_URL;
  const INVITE_CODE = INVITE_URL.replace(/^https?:\/\//, '');
  /* Bare slug for Discord's public presence endpoint, which needs
     /api/v9/invites/<code> rather than the discord.gg host. */
  const INVITE_SLUG = (INVITE_URL.match(/discord\.gg\/([\w-]+)/) || [])[1] || '';

  /* ------------------------------ storage ------------------------------ */
  const K_RES = 'kyro.resources.v4';
  const K_SAVED = 'kyro.saved.v3';
  const K_AUTH = 'kyro.auth.v1';
  const K_OS = 'kyro.os.v1';
  const K_STATE = 'kyro.oauth.state.v1';

  const read = (k, fallback) => {
    try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? fallback : v; }
    catch { return fallback; }
  };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };
  const readSession = (k) => { try { return sessionStorage.getItem(k); } catch { return null; } };
  const writeSession = (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* private mode */ } };
  const clearSession = (k) => { try { sessionStorage.removeItem(k); } catch { /* private mode */ } };

  /* The seed is the single source of truth for what each tool is. Rebuilding
     from it on every load means a catalogue edit — new files, copy, pricing, a
     reset download baseline — reaches returning visitors instead of being
     frozen by a stale cache. Saved vault state lives under its own key and
     download totals live on the worker, so nothing user-specific is lost. */
  let resources = (window.KYRO_SEED || []).map(r => Object.assign({}, r));
  try { localStorage.removeItem(K_RES); } catch (err) { /* private mode */ }
  const saved = new Set(read(K_SAVED, []));

  /* --------------------------- auth state model ------------------------
     out      → not signed in
     logged   → signed in with Discord, not a server member
     verified → signed in AND confirmed server member (downloads unlocked)
     --------------------------------------------------------------------- */
  const OUT = 'out', LOGGED = 'logged', VERIFIED = 'verified';

  let auth = normaliseAuth(read(K_AUTH, null));
  function normaliseAuth(v) {
    if (!v || (v.state !== LOGGED && v.state !== VERIFIED)) return { state: OUT, user: null, token: '' };
    const user = v.user && v.user.username
      ? v.user
      : { username: 'editor', id: '', avatar: '', initials: 'E' };
    return { state: v.state, user, token: v.token || '' };
  }
  const saveAuth = () => write(K_AUTH, auth);

  /* ------------------ session handed back by the worker -----------------
     /callback lands here as ?token=…&username=…&id=…&avatar=…&in_server=…
     The state param must match the one stashed before the redirect, or the
     query is someone else's (or a forged) callback and gets dropped.
     ---------------------------------------------------------------------- */
  /* Discord / worker error codes → copy a visitor can act on. Unknown codes
     fall through to the raw description so nothing is ever masked away. */
  const OAUTH_ERROR_COPY = {
    access_denied: ['Discord sign-in cancelled', 'Nothing was stored — try again whenever you like.'],
    invalid_scope: ['Discord rejected the requested scopes', 'The app must request identify and guilds.'],
    invalid_client: ['Discord does not recognise this app', 'Check DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET on the worker.'],
    invalid_grant: ['That sign-in link has expired', 'Codes last only seconds — sign in again.'],
    unauthorized_client: ['This app cannot use the sign-in flow', 'Enable the authorization code grant on the Discord app.'],
    unsupported_grant_type: ['Wrong grant type', 'The worker must exchange codes with authorization_code.'],
    invalid_request: ['Discord rejected the sign-in request', 'Check the client id, scopes and redirect URI.'],
    missing_code: ['Discord returned no code', 'Sign in again, or clear cookies and retry.'],
    worker_misconfigured: ['The auth worker is not configured', 'Set DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET on the worker.'],
    auth_failed: ['Sign-in failed', 'Discord did not complete the request — try again.']
  };

  function captureSessionFromUrl() {
    try {
      const q = new URLSearchParams(location.search);
      const error = q.get('error');
      if (!error && !q.has('token') && !q.has('username')) return;

      const expected = readSession(K_STATE);
      const returned = q.get('state');
      clearSession(K_STATE);

      if (error) {
        const copy = OAUTH_ERROR_COPY[error];
        const detail = q.get('error_description');
        /* Kept for debugging, never shown: visitors get the friendly line. */
        if (detail) console.warn('[kyro-auth] ' + error + ': ' + detail);
        window.history.replaceState({}, '', location.pathname);
        queueMicrotask(() => toast({
          title: copy ? copy[0] : 'Sign-in failed',
          sub: copy ? copy[1] : String(detail || error),
          icon: ICON.x, ttl: 6500
        }));
        return;
      }

      if (expected && returned !== expected) {
        window.history.replaceState({}, '', location.pathname);
        return;
      }

      const username = q.get('username') || 'editor';
      const inServer = q.get('in_server');
      auth = {
        state: inServer === 'true' ? VERIFIED : LOGGED,
        user: {
          username,
          id: q.get('id') || '',
          avatar: q.get('avatar') || '',
          initials: username.slice(0, 1).toUpperCase()
        },
        token: q.get('token') || auth.token || ''
      };
      saveAuth();
      window.history.replaceState({}, '', location.pathname);

      queueMicrotask(() => toast(auth.state === VERIFIED
        ? { title: 'Signed in as ' + username, sub: 'Verified Kyro member — downloads unlocked.', icon: ICON.check }
        : {
            title: 'Signed in as ' + username,
            sub: 'Membership check: not found in the Kyro server.',
            icon: ICON.discord, ttl: 7000,
            actions: [{ label: 'Join server', href: INVITE_URL }, { label: 'Refresh Verification', onClick: recheckMembership }]
          }));
    } catch (err) {
      /* A malformed callback is untrusted input; it must never take the page down. */
      console.warn('[kyro-auth] ignored callback: ' + ((err && err.message) || err));
      window.history.replaceState({}, '', location.pathname);
    }
  }

  let os = read(K_OS, 'windows') === 'macos' ? 'macos' : 'windows';

  const filters = { view: 'all' };

  /* Which OS cell gets the DETECTED pill in the browse grid. */
  function detectedOs() {
    const s = (navigator.userAgent || '') + ' ' + (navigator.platform || '');
    if (/Mac|iPhone|iPad|iPod/i.test(s)) return 'macos';
    if (/Windows|Win32|Win64/i.test(s)) return 'windows';
    return null;
  }
  const DETECTED_OS = detectedOs();

  /* ------------------------------ helpers ------------------------------ */
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n);
  const full = (n) => Number(n).toLocaleString('en-US');

  function fuzzy(q, text) {
    q = q.toLowerCase().replace(/\s+/g, '');
    text = text.toLowerCase();
    if (!q) return 0.001;
    let score = 0, run = 0, ti = 0;
    for (const ch of q) {
      const found = text.indexOf(ch, ti);
      if (found === -1) return -1;
      run = found === ti ? run + 2 : 1;
      score += run;
      ti = found + 1;
    }
    if (text.startsWith(q)) score += 20;
    return score;
  }

  /* The vault page itself lists nothing — like keyfla.me it is hero, notice and
     the browse grid. The two OS pages are the ones with lists, and each carries
     a Software section above a Tools section, so every ref here is optional. */
  const authSlot = $('#authSlot');
  const accessStrip = $('#accessStrip');
  const softwareGrid = $('#softwareGrid');
  const softwareNote = $('#softwareNote');
  const softwareEmpty = $('#softwareEmpty');
  const toolsGrid = $('#toolsGrid');
  const toolsNote = $('#toolsNote');
  const toolsEmpty = $('#toolsEmpty');
  const browseGrid = $('#browseGrid');
  const discordCard = $('#discordCard');
  const modalOverlay = $('#modalOverlay');
  const modalBox = $('#modalBox');
  const paletteOverlay = $('#paletteOverlay');
  const paletteInput = $('#paletteInput');
  const paletteResults = $('#paletteResults');
  const drawer = $('#vaultDrawer');
  const drawerScrim = $('#drawerScrim');
  const vaultList = $('#vaultList');
  const vaultCount = $('#vaultCount');
  const savedCount = $('#savedCount');
  const toasts = $('#toasts');

  /* Requests board drawer — the elements only exist on pages that ship it. */
  const requestsDrawer = $('#requestsDrawer');
  const requestCompose = $('#reqCompose');
  const requestGate = $('#reqGate');
  const requestList = $('#requestList');
  const requestCount = $('#requestCount');
  const reqCategories = $('#reqCategories');
  const reqTitle = $('#reqTitle');
  const reqAe = $('#reqAe');
  const reqDesc = $('#reqDesc');
  const reqSubmit = $('#reqSubmit');

  /* Category page head — only present on the /windows and /macos pages. */
  const catTitle = $('#catTitle');
  const catDesc = $('#catDesc');
  const catCount = $('#catCount');
  const catNav = $('#catNav');

  const ICON = {
    discord: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.3 4.9A17.4 17.4 0 0 0 15.9 3.5l-.3.5a16 16 0 0 0-7.1 0l-.3-.5c-1.6.3-3.1.8-4.4 1.5C.6 9.1-.2 12.7.1 16.2 1.7 17.5 3.7 18.4 5.8 19l1-1.6-1.9-.8.5-.4c3.8 1.7 8 1.7 11.9 0l.5.4-1.9.8 1 1.6c2.1-.6 4.1-1.5 5.7-2.9.4-4-.8-7.5-3.3-11.2ZM8.5 14c-.9 0-1.7-.9-1.7-1.9s.7-1.9 1.7-1.9c.9 0 1.7.9 1.7 1.9s-.8 1.9-1.7 1.9Zm7 0c-.9 0-1.7-.9-1.7-1.9s.8-1.9 1.7-1.9c1 0 1.7.9 1.7 1.9s-.7 1.9-1.7 1.9Z"/></svg>',
    bookmark: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M18 21 12 16.5 6 21V4.8A1.8 1.8 0 0 1 7.8 3h8.4A1.8 1.8 0 0 1 18 4.8z"/></svg>',
    download: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0 4.5-4.5M12 15l-4.5-4.5M4 20h16"/></svg>',
    lock: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="10.5" width="15" height="9.5" rx="2.5"/><path d="M8.2 10.5V7.6a3.8 3.8 0 0 1 7.6 0v2.9"/></svg>',
    unlock: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="10.5" width="15" height="9.5" rx="2.5"/><path d="M8.2 10.5V7.6a3.8 3.8 0 0 1 7.4-.9"/></svg>',
    check: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m4.5 12.5 5 5L20 7"/></svg>',
    shield: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7.5 3v6c0 4.4-3 7.7-7.5 9-4.5-1.3-7.5-4.6-7.5-9V6z"/><path d="m8.8 12 2.2 2.2 4.2-4.4"/></svg>',
    x: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    arrow: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14m0 0-5.5-5.5M19 12l-5.5 5.5"/></svg>',
    windows: '<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M0 2.3l6.5-.9v6.3H0V2.3zm7.3-1L16 0v7.7H7.3V1.3zM0 8.6h6.5v6.3L0 14V8.6zm7.3 0H16V16l-8.7-1.2V8.6z"/></svg>',
    apple: '<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M13.1 8.5c0-1.7 1.4-2.6 1.5-2.6-.8-1.2-2.1-1.3-2.5-1.4-1.1-.1-2.1.6-2.7.6-.6 0-1.4-.6-2.3-.6-1.2 0-2.3.7-2.9 1.7-1.2 2.1-.3 5.3.9 7 .6.9 1.3 1.8 2.2 1.8.9 0 1.2-.6 2.3-.6s1.4.6 2.3.5c1 0 1.6-.8 2.1-1.7.7-1 1-2 1-2-.1 0-1.9-.7-1.9-2.7zM11.3 3.5c.5-.6.8-1.4.7-2.2-.7 0-1.5.5-2 1.1-.4.5-.8 1.3-.7 2.1.8.1 1.5-.4 2-1z"/></svg>',
    copy: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2.2"/><path d="M15 5.5H6.2A2.2 2.2 0 0 0 4 7.7V15"/></svg>',
    clock: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3.5 2"/></svg>'
  };

  /* ------------------------- access-state copy -------------------------- */
  const ACCESS = {
    out: {
      cls: 'is-out', icon: ICON.lock,
      text: '<b>Downloads are locked.</b> Sign in with Discord so we can check your Kyro server membership.',
      prompt: 'Please log in with Discord to access this resource.'
    },
    logged: {
      cls: 'is-partial', icon: ICON.shield,
      text: '<b>Access Denied:</b> You must be a member of the Kyro Discord server to download assets!',
      prompt: 'You need to join the Kyro Discord server first.'
    },
    verified: {
      cls: 'is-ok', icon: ICON.unlock,
      text: '<b>Membership verified.</b> The .zxp, .jsxbin and .ffx builds are unlocked for your account.',
      prompt: ''
    }
  };
  const access = () => ACCESS[auth.state];

  /* ============================ auth surface ============================ */
  /* Discord returns an avatar hash; the CDN URL needs the user id with it. */
  function avatarSrc(user) {
    if (!user || !user.avatar) return '';
    if (/^https?:\/\//.test(user.avatar)) return user.avatar;
    if (!user.id) return '';
    return 'https://cdn.discordapp.com/avatars/' + encodeURIComponent(user.id) + '/' +
      encodeURIComponent(user.avatar) + '.png?size=64';
  }

  function avatarHTML(user) {
    const initials = esc((user && user.initials) || '·');
    const src = avatarSrc(user);
    return src
      ? '<img class="avatar-img" src="' + esc(src) + '" alt="" data-initials="' + initials + '">'
      : initials;
  }

  /* A deleted or malformed Discord avatar hash must not leave an empty plate. */
  function wireAvatars(root) {
    root.querySelectorAll('.avatar-img').forEach((img) => {
      img.addEventListener('error', () => {
        img.replaceWith(document.createTextNode(img.dataset.initials || ''));
      }, { once: true });
    });
  }

  function renderAuth() {
    if (auth.state === OUT) {
      authSlot.innerHTML =
        '<button type="button" class="login-btn" id="loginBtn">' + ICON.discord +
        '<span class="lb-text">Login with Discord</span></button>';
      $('#loginBtn').addEventListener('click', startLogin);
      return;
    }
    const verified = auth.state === VERIFIED;
    authSlot.innerHTML =
      '<button type="button" class="profile-pill" id="profileBtn" aria-haspopup="menu" aria-expanded="false">' +
        '<span class="avatar">' + avatarHTML(auth.user) +
          '<i class="status-dot' + (verified ? ' is-verified' : '') + '" aria-hidden="true"></i></span>' +
        '<span class="profile-name">' + esc(auth.user.username) + '</span>' +
        '<span class="profile-caret" aria-hidden="true">▾</span>' +
      '</button>';
    const pill = $('#profileBtn');
    pill.addEventListener('click', (e) => { e.stopPropagation(); toggleProfileMenu(pill); });
    wireAvatars(authSlot);
  }

  function toggleProfileMenu(pill, force) {
    const existing = authSlot.querySelector('.profile-menu');
    if (existing || force === false) { existing.remove(); pill.classList.remove('is-open'); pill.setAttribute('aria-expanded', 'false'); return; }
    const verified = auth.state === VERIFIED;
    const menu = document.createElement('div');
    menu.className = 'profile-menu';
    menu.setAttribute('role', 'menu');
    menu.innerHTML =
      '<div class="pm-head"><span class="avatar avatar--lg">' + avatarHTML(auth.user) + '</span>' +
        '<div><div class="pm-name">' + esc(auth.user.username) + '</div>' +
        '<div class="pm-sub">Discord' + (auth.user.id ? ' · id ' + esc(auth.user.id) : '') + '</div></div></div>' +
      '<div class="pm-state ' + (verified ? 'is-ok' : 'is-out') + '">' +
        (verified ? ICON.check + 'Verified server member' : ICON.lock + 'Not in the Kyro server') + '</div>' +
      (verified ? '' :
        '<a class="pm-item" role="menuitem" href="' + esc(INVITE_URL) + '" target="_blank" rel="noopener noreferrer">Join server ↗</a>' +
        '<button type="button" class="pm-item" role="menuitem" data-recheck>Refresh Verification</button>') +
      '<button type="button" class="pm-item danger" role="menuitem" data-logout>Logout</button>';
    authSlot.appendChild(menu);
    wireAvatars(menu);
    pill.classList.add('is-open');
    pill.setAttribute('aria-expanded', 'true');
    const rc = menu.querySelector('[data-recheck]');
    if (rc) rc.addEventListener('click', () => { closeProfileMenu(); recheckMembership(); });
    menu.querySelector('[data-logout]').addEventListener('click', () => { closeProfileMenu(); logout(); });
  }

  function closeProfileMenu() {
    const pill = $('#profileBtn');
    const menu = authSlot.querySelector('.profile-menu');
    if (menu) menu.remove();
    if (pill) { pill.classList.remove('is-open'); pill.setAttribute('aria-expanded', 'false'); }
  }
  document.addEventListener('click', (e) => { if (!e.target.closest('.nav-auth')) closeProfileMenu(); });

  /* ------------------------- real OAuth2 redirect -----------------------
     No consent modal and no simulated handshake: the browser hands over to
     Discord, and the worker returns the session on the query string.
     ---------------------------------------------------------------------- */
  function authorizeUrl(state) {
    return 'https://discord.com/api/oauth2/authorize' +
      '?client_id=' + encodeURIComponent(DISCORD_CLIENT_ID) +
      '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
      '&response_type=code&scope=' + encodeURIComponent('identify guilds') +
      '&state=' + encodeURIComponent(state);
  }

  function startLogin() {
    const state = (window.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    writeSession(K_STATE, state);
    location.assign(authorizeUrl(state));
  }

  function logout() {
    auth = { state: OUT, user: null, token: '' };
    saveAuth();
    renderAuth();
    renderAccess();
    if (modalId) openModal(modalId);
    toast({ title: 'Logged out', sub: 'Discord session cleared from this browser.', icon: ICON.x });
  }

  /* Re-reads guild membership with the stored token — the session survives. */
  async function recheckMembership() {
    if (!auth.token) { startLogin(); return; }

    const t = toast({
      title: 'Checking Kyro membership…',
      sub: 'Kyro · ' + (auth.user ? auth.user.username : 'guest'),
      icon: ICON.shield, progress: true, ttl: 0
    });
    let pct = 0;
    const crawl = setInterval(() => {
      pct = Math.min(92, pct + 7);
      t.setPct(pct);
    }, 220);

    try {
      const res = await fetch(AUTH_WORKER_URL + '/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: auth.token })
      });
      const data = await res.json().catch(() => ({}));
      clearInterval(crawl);

      if (res.status === 401) {
        logout();
        t.finish('Session expired', 'Discord rejected the token — sign in again.');
        return;
      }
      if (!res.ok) throw new Error(data.error || ('Worker responded ' + res.status));

      const member = Boolean(data.in_server);
      auth = { state: member ? VERIFIED : LOGGED, user: auth.user, token: data.token || auth.token };
      saveAuth();
      renderAuth();
      renderAccess();
      if (modalId) openModal(modalId);

      if (member) t.finish('Membership verified', 'Downloads unlocked for your account');
      else t.finish('Not a member yet', 'Join the Kyro Discord, then refresh again.');
    } catch (err) {
      clearInterval(crawl);
      /* fetch() rejects with a TypeError for an unreachable worker or a CORS
         block, which carries no useful message of its own. */
      const sub = err instanceof TypeError
        ? 'The auth worker is unreachable — check AUTH_WORKER_URL and that this origin is allowed.'
        : String((err && err.message) || err);
      t.finish('Verification failed', sub);
      const ico = t.el.querySelector('.toast-ico');
      if (ico) ico.innerHTML = ICON.x;
    }
  }

  /* --------------------------- access strip ----------------------------- */
  function renderAccess() {
    const a = access();
    let actions = '';
    if (auth.state === OUT) actions = '<button type="button" class="btn btn-discord btn-sm" id="stripLogin">' + ICON.discord + 'Login with Discord</button>';
    else if (auth.state === LOGGED) actions =
      '<a class="btn btn-danger btn-sm" href="' + INVITE_URL + '" target="_blank" rel="noopener noreferrer">' + ICON.discord + 'Join Server</a>' +
      '<button type="button" class="btn btn-ghost btn-sm" id="stripRecheck">Refresh Verification</button>';
    else actions = '<span class="a-state mono">verified · ' + esc(auth.user.username) + '</span>';

    accessStrip.innerHTML =
      '<div class="access-row ' + a.cls + '"><span class="a-icon">' + a.icon + '</span>' +
      '<span class="a-text">' + a.text + '</span>' + actions + '</div>';

    const sl = $('#stripLogin');
    if (sl) sl.addEventListener('click', startLogin);
    const sr = $('#stripRecheck');
    if (sr) sr.addEventListener('click', recheckMembership);

    renderBanner();
    /* Signing in or out changes who may post, so an open panel repaints. */
    if (requestsDrawer && requestsDrawer.classList.contains('is-open')) renderRequests();
    /* Same for an open modal: verifying without closing it must unlock the
       rows and reveal the archive password. */
    if (modalId && !modalOverlay.hidden) {
      const open = resources.find(x => x.id === modalId);
      if (open) wireDownloads(open);
    }
  }

  /* ========================= directory rendering ======================== */
  function byNewest(a, b) {
    const d = String(b.added || '').localeCompare(String(a.added || ''));
    return d !== 0 ? d : String(b.version || '').localeCompare(String(a.version || ''), undefined, { numeric: true });
  }

  /* Two shelves per OS page: the editor itself under Software, everything that
     runs inside it under Tools. A listing with no kind is a tool, because that
     is what the vault actually hands out today. */
  function kindOf(r) {
    return r.kind === 'software' ? 'software' : 'tool';
  }

  function listFor(b, kind) {
    let list = resources.slice();
    if (b.osValue) list = list.filter(r => (r.os || []).indexOf(b.osValue) !== -1);
    if (b.cats) list = list.filter(r => b.cats.indexOf(r.category) !== -1);
    if (b.free) list = list.filter(r => r.price === 0);
    if (kind) list = list.filter(r => kindOf(r) === kind);
    if (b.sort === 'newest') list = list.sort(byNewest);
    return list;
  }

  function currentView() {
    return BROWSE.find(b => b.id === filters.view) || { title: 'All', cats: null, free: false };
  }

  function currentList() {
    return listFor(currentView());
  }

  /* An unpriced listing is not a free one: when the seed leaves price out the
     badge disappears entirely instead of guessing at either. */
  function priceLabel(r) {
    if (r.price === null || r.price === undefined || r.price === '') return '';
    return Number(r.price) === 0 ? 'FREE' : '$' + esc(r.price);
  }

  function priceBadge(r) {
    const label = priceLabel(r);
    if (!label) return '';
    return label === 'FREE'
      ? '<span class="badge badge-free">FREE</span>'
      : '<span class="badge badge-pro">' + label + ' PRO</span>';
  }

  function cardHTML(r, i) {
    const isSaved = saved.has(r.id);
    const locked = isLocked(r);
    const exts = (r.files || [{ ext: r.format }]).map(f => f.ext.toUpperCase().replace('.', '')).join(' · ');
    const version = r.version ? '<span class="version-chip mono">' + esc(r.version) + '</span>' : '';
    const ae = r.aeMin ? '<span class="chip">AE ' + esc(r.aeMin) + '+</span>' : '';
    return (
      '<article class="software-card" data-id="' + esc(r.id) + '" tabindex="0" role="button" aria-label="Inspect ' + esc(r.title) + '" style="animation-delay:' + (i * 50) + 'ms">' +
        '<div class="card-top">' +
          '<h3 class="card-title card-title--row">' + esc(r.title) + '</h3>' +
          version +
          '<span class="arrow" aria-hidden="true">→</span>' +
        '</div>' +
        '<p class="card-desc">' + esc(r.desc) + '</p>' +
        '<div class="card-meta">' +
          '<span class="chip"><b>' + full(downloadCount(r)) + '</b> ' + (downloadCount(r) === 1 ? 'download' : 'downloads') + '</span>' +
          ae +
          '<span class="chip">' + esc(exts) + '</span>' +
          (locked ? '<span class="chip chip-soon mono">' + ICON.clock + 'COMING SOON</span>' : '') +
          priceBadge(r) +
        '</div>' +
        '<div class="card-foot">' +
          '<button class="save-btn' + (isSaved ? ' is-saved' : '') + '" data-save="' + esc(r.id) + '" aria-pressed="' + isSaved + '" aria-label="Save ' + esc(r.title) + '">' + ICON.bookmark + '</button>' +
          '<button class="btn btn-primary" data-inspect>' + (locked ? ICON.clock + 'Coming Soon' : ICON.download + 'Inspect &amp; Download') + '</button>' +
        '</div>' +
      '</article>'
    );
  }

  /* One shelf: rendered only where its own grid exists, which is the two OS
     pages. The vault page has no lists at all, so both calls just return. */
  function renderSection(grid, note, empty, b, kind) {
    if (!grid) return;
    const list = listFor(b, kind);
    grid.innerHTML = list.map(cardHTML).join('');
    if (note) {
      note.textContent = '· ' + (list.length ? list.length + (list.length === 1 ? ' item' : ' items') : 'coming soon');
    }
    if (empty) empty.hidden = list.length > 0;
  }

  function renderSoftware() {
    const b = currentView();
    renderSection(softwareGrid, softwareNote, softwareEmpty, b, 'software');
    renderSection(toolsGrid, toolsNote, toolsEmpty, b, 'tool');
  }

  /* Each OS page shows one browse category as its own page; the head reuses
     that cell's own copy so the two never drift apart. */
  function renderCategoryHead() {
    if (!catTitle) return;
    const b = BROWSE.find(x => x.id === filters.view);
    if (!b) return;
    const list = currentList();

    catTitle.textContent = b.title;
    catDesc.textContent = b.desc;
    document.title = b.title + ' — Kyro';

    const pill = b.osValue && b.osValue === DETECTED_OS
      ? '<span class="browse-pill">detected</span>' : '';
    catCount.innerHTML = pill + '<span>' +
      (list.length ? list.length + (list.length === 1 ? ' item' : ' items') : 'coming soon') + '</span>';

    catNav.innerHTML = BROWSE.map(x => {
      const on = x.id === b.id;
      return '<a class="cat-chip mono' + (on ? ' is-current' : '') + '" href="' +
        esc(categoryHref(x)) + '"' +
        (on ? ' aria-current="page"' : '') + '>' + esc(x.title.toUpperCase()) + '</a>';
    }).join('');
  }

  /* Flush browse grid. Three cells, three pages, clean paths like keyfla.me:
     /windows and /macos list the software, /guide is the written start-here. */
  const BROWSE = [
    { id: 'windows', osValue: 'windows', icon: 'windows', page: '/windows', title: 'Windows',
      desc: 'Software, tools, and plugins for Windows editors.' },
    { id: 'macos', osValue: 'macos', icon: 'apple', page: '/macos', title: 'MacOS',
      desc: 'Software, tools, and plugins for Mac editors.' },
    { id: 'guide', page: '/guide', noCount: true, title: 'Beginner\'s Guide',
      desc: 'Start here for After Effects setup, plugins, composition settings, and shortcuts.' }
  ];

  function categoryHref(b) {
    return b.page;
  }

  function renderBrowse() {
    if (!browseGrid) return;
    browseGrid.innerHTML = BROWSE.map((b) => {
      const count = b.noCount ? 0 : listFor(b).length;
      return '<a class="browse-cell" href="' + esc(categoryHref(b)) + '">' +
        cellInner(b, count) + '</a>';
    }).join('');
  }

  /* Below five items a raw count advertises how little there is, so the cell
     says nothing at all — and says COMING SOON when there is nothing to say. */
  const COUNT_FLOOR = 5;

  function cellFoot(b, count) {
    if (b.noCount) return '';
    if (count === 0) return '<p class="cell-meta"><span class="cell-soon mono">coming soon</span></p>';
    if (count < COUNT_FLOOR) return '';
    return '<p class="cell-meta mono">' + count + ' items</p>';
  }

  function cellInner(b, count) {
    const icon = b.icon ? '<span class="cell-ico">' + ICON[b.icon] + '</span>' : '';
    const pill = (b.osValue && b.osValue === DETECTED_OS) ? '<span class="browse-pill">detected</span>' : '';
    return '<div class="cell-top">' + icon + '<span class="cell-title">' + esc(b.title) + '</span>' + pill +
      '<span class="cell-arrow" aria-hidden="true">→</span></div>' +
      '<p class="cell-desc">' + esc(b.desc) + '</p>' +
      cellFoot(b, count);
  }

  /* --------------------------- live server stats -------------------------
     Discord's public invite endpoint answers with approximate presence and
     member counts, needs no bot token, and echoes this site's origin in
     Access-Control-Allow-Origin — so the browser can poll it directly. It is
     never authoritative: a 429 or a network failure keeps the last good
     numbers and only dims the dot, falling back to the KYRO_SITE seed before
     the first reply ever arrives.
     ----------------------------------------------------------------------- */
  const STATS_INTERVAL = 30000;
  const server = { online: null, members: null, live: false };

  function statsText() {
    const s = window.KYRO_SITE;
    const online = server.online === null ? s.online : server.online;
    const members = server.members === null ? s.members : server.members;
    return online + ' online · ' + members + ' members';
  }

  /* Repaint only the kicker: renderBanner() would rebuild the whole card and
     throw away focus, so the poll never touches the buttons. */
  function paintServerStats() {
    const text = document.getElementById('bannerStats');
    if (!text) return;
    text.textContent = statsText();
    const dot = text.parentElement && text.parentElement.querySelector('.presence-dot');
    if (!dot) return;
    dot.classList.toggle('is-stale', !server.live);
    dot.title = server.live
      ? 'Live from the Kyro Discord'
      : 'Live status unavailable right now — showing the last known counts';
  }

  async function fetchServerStats() {
    if (!INVITE_SLUG) return;
    try {
      const res = await fetch('https://discord.com/api/v9/invites/' + INVITE_SLUG + '?with_counts=true', {
        method: 'GET',
        headers: { Accept: 'application/json' },
        /* The endpoint is public; a credentialed CORS request would demand an
           exact origin plus allow-credentials and buys this nothing. */
        credentials: 'omit'
      });
      if (!res.ok) throw new Error('invite endpoint returned ' + res.status);
      const data = await res.json();
      const online = data.approximate_presence_count;
      const members = data.approximate_member_count;
      /* Number(null) is 0, which would paint "0 online · 0 members" over a
         payload that simply omitted the counts — check the type, not the cast. */
      if (typeof online !== 'number' || typeof members !== 'number' ||
          !Number.isFinite(online) || !Number.isFinite(members) || online < 0 || members < 0) {
        throw new Error('invite endpoint omitted the counts');
      }
      server.online = Math.round(online);
      server.members = Math.round(members);
      server.live = true;
    } catch (err) {
      server.live = false;
      console.warn('[kyro-stats] ' + ((err && err.message) || err));
    }
    paintServerStats();
  }

  function startServerStats() {
    fetchServerStats();
    loadDownloadCounts();
    setInterval(() => {
      /* A hidden tab gets no requests — the counts are only worth refreshing
         for someone who can actually see them. */
      if (document.hidden) return;
      fetchServerStats();
      loadDownloadCounts();
    }, STATS_INTERVAL);
  }

  /* Two-column community banner: Kyro logo plate + the call to action that
     matches what this visitor has already done. Verified members stop being
     asked to verify and get the community + requests card instead. */
  function renderBanner() {
    const s = window.KYRO_SITE;
    const inviteLink = '<a class="banner-link" href="' + esc(INVITE_URL) +
      '" target="_blank" rel="noopener noreferrer">Join the Kyro Discord ↗</a>';
    const chatLink = '<a class="banner-link" href="' + esc(INVITE_URL) +
      '" target="_blank" rel="noopener noreferrer">Join Discord Chat ↗</a>';
    let title, sub, primary, secondary, foot;
    if (auth.state === OUT) {
      title = 'Verify membership to unlock downloads.';
      sub = 'Sign in and join the Kyro Discord to access exclusive tools.';
      primary = '<button type="button" class="btn btn-primary" id="bannerLogin">Login with Discord</button>';
      secondary = inviteLink;
      foot = '';
    } else if (auth.state === LOGGED) {
      title = 'Verify membership to unlock downloads.';
      sub = 'Sign in and join the Kyro Discord to access exclusive tools.';
      primary = '<button type="button" class="btn btn-primary" id="bannerRecheck">Refresh Verification</button>';
      secondary = inviteLink;
      foot = '';
    } else {
      title = 'Community & Requests';
      sub = 'You’re in — ask for the tool you need, vote on what lands in the vault next, or just talk shop with the editors.';
      primary = '<button type="button" class="btn btn-primary" id="bannerRequests">Request a Tool / Preset</button>';
      secondary = chatLink;
      foot = '<span class="banner-state">Verified member · ' + esc(auth.user.username) + '</span>';
    }

    discordCard.innerHTML =
      '<div class="banner-visual">' +
        '<img class="banner-logo" src="/assets/kyro-banner.png" alt="Kyro — est. Nov 2026" />' +
      '</div>' +
      '<div class="banner-body">' +
        '<p class="banner-kicker"><img class="banner-avatar" src="/assets/kyro-icon.png" alt="" />' +
          '<i class="presence-dot" aria-hidden="true"></i>' +
          '<span id="bannerStats">' + esc(statsText()) + '</span></p>' +
        '<h2 class="banner-title">' + title + '</h2>' +
        '<p class="banner-sub">' + sub + '</p>' +
        '<div class="banner-actions">' + primary + secondary + '</div>' +
        '<p class="banner-foot"><span>' + esc(s.domain) + '</span><span>' + esc(INVITE_CODE) + '</span>' + foot + '</p>' +
      '</div>';

    Preview.gc();

    const bl = $('#bannerLogin');
    if (bl) bl.addEventListener('click', startLogin);
    const br = $('#bannerRecheck');
    if (br) br.addEventListener('click', recheckMembership);
    const bq = $('#bannerRequests');
    if (bq) bq.addEventListener('click', openRequests);

    paintServerStats();
  }

  /* ------------------------------ motion -------------------------------- */
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ------------------------------ save / vault -------------------------- */
  function toggleSave(id, srcBtn) {
    const adding = !saved.has(id);
    if (adding) saved.add(id); else saved.delete(id);
    write(K_SAVED, Array.from(saved));
    updateSavedUI();
    if (adding && srcBtn) { srcBtn.classList.remove('pop'); void srcBtn.offsetWidth; srcBtn.classList.add('pop'); }
    if (drawer.classList.contains('is-open')) vaultRefresh();
    const label = (resources.find(r => r.id === id) || {}).title || 'Asset';
    if (srcBtn) toast(adding ? { title: 'Saved to Vault', sub: label } : { title: 'Removed from Vault', sub: label });
  }

  function updateSavedUI() {
    const n = saved.size;
    savedCount.hidden = n === 0;
    savedCount.textContent = n;
    vaultCount.textContent = n + (n === 1 ? ' asset' : ' assets');
    $$('[data-save]').forEach(btn => {
      if (btn.closest('.drawer')) return;
      const on = saved.has(btn.dataset.save);
      btn.classList.toggle('is-saved', on);
      btn.setAttribute('aria-pressed', on);
    });
  }

  function vaultRefresh() {
    Preview.gc();
    const items = resources.filter(r => saved.has(r.id));
    if (!items.length) {
      vaultList.innerHTML = '<div class="vault-empty">Your vault is empty.<br/>Tap the bookmark on any card to stash it here.</div>';
      return;
    }
    vaultList.innerHTML = items.map(r => {
      const shot = (r.gallery && r.gallery.length)
        ? '<img class="vault-shot" src="' + esc(r.gallery[0]) + '" alt="" />'
        : '<canvas></canvas>';
      const meta = [esc(r.version), esc(firstExt(r)).toUpperCase().replace('.', ''), priceLabel(r)]
        .filter(Boolean)
        .map(t => '<span>' + t + '</span>')
        .join('');
      return '<div class="vault-item" data-id="' + esc(r.id) + '" role="button" tabindex="0">' +
        '<div class="vault-thumb">' + shot + '</div>' +
        '<div class="vault-info">' +
          '<div class="v-title">' + esc(r.title) + '</div>' +
          '<div class="v-meta mono">' + meta + '</div>' +
        '</div>' +
        '<button class="vault-remove" data-remove="' + esc(r.id) + '" aria-label="Remove from vault">' + ICON.x + '</button>' +
      '</div>';
    }).join('');
    items.forEach(r => {
      if (r.gallery && r.gallery.length) return;
      const c = vaultList.querySelector('.vault-item[data-id="' + r.id + '"] canvas');
      if (c) Preview.attach(c, r.preview || 'grid', r.seed || 7);
    });
  }

  function openDrawer() {
    if (requestsDrawer && requestsDrawer.classList.contains('is-open')) hide(requestsDrawer);
    vaultRefresh();
    openScrim();
    drawer.classList.add('is-open');
    drawer.setAttribute('aria-hidden', 'false');
  }
  function closeDrawer() {
    hide(drawer);
    closeScrim();
  }
  /* Removing is-open + aria-hidden is the whole animation; both drawers do
     it, and openScrim()/closeScrim() decide when the shared scrim may go. */
  function hide(el) {
    releaseFocus(el);
    el.classList.remove('is-open');
    el.setAttribute('aria-hidden', 'true');
  }

  /* Focus left inside an aria-hidden container is an accessibility warning. */
  function releaseFocus(el) {
    if (el.contains(document.activeElement)) document.activeElement.blur();
  }

  function openScrim() { drawerScrim.hidden = false; }
  /* Both drawers share one scrim, so the fade-out only hides it when neither
     is open — otherwise closing one would blank the other mid-slide. */
  function closeScrim() {
    setTimeout(() => {
      const anyOpen = [drawer, requestsDrawer].some(el => el.classList.contains('is-open'));
      if (!anyOpen) drawerScrim.hidden = true;
    }, 320);
  }

  /* ============================== requests board =========================
     The wishlist is one KV key behind /requests on the auth worker, and
     identity is the Discord access token that worker already validates, so a
     vote means one per verified server member rather than one per cookie.
     Reads stay public: a visitor can see what the community wants before
     deciding to join.
     ========================================================================= */
  const REQ_STATUS_LABEL = {
    under_review: 'UNDER REVIEW',
    in_progress: 'IN PROGRESS',
    added_to_vault: 'ADDED TO VAULT'
  };
  /* Monochrome ladder: dim for queued, silver for building, white for shipped. */
  const REQ_STATUS_CLASS = {
    under_review: 'badge',
    in_progress: 'badge badge-pro',
    added_to_vault: 'badge badge-free'
  };
  const REQ_CATEGORY_OPTIONS = [
    ['extension', 'Extension'], ['script', 'Script'], ['preset', 'Preset'],
    ['project', 'Project'], ['soundfx', 'Sound FX'], ['other', 'Other']
  ];

  let requests = [];
  let reqError = '';
  let reqBusy = false;
  let reqCategory = 'extension';

  function reqHeaders() {
    const h = { Accept: 'application/json' };
    /* A header, not a query string: tokens in URLs end up in access logs. */
    if (auth.token) h.Authorization = 'Bearer ' + auth.token;
    return h;
  }

  async function loadRequests() {
    try {
      const res = await fetch(AUTH_WORKER_URL + '/requests', { headers: reqHeaders(), credentials: 'omit' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error('requests responded ' + res.status + (data.error ? ': ' + data.error : ''));
      requests = Array.isArray(data.requests) ? data.requests : [];
      reqError = '';
    } catch (err) {
      reqError = 'The requests board is unreachable right now. Reopen this panel to try again.';
      console.warn('[kyro-requests] ' + ((err && err.message) || err));
    }
    renderRequests();
  }

  /* Every write answers with the whole rebuilt board, so the panel repaints
     from the server's own vote ordering instead of guessing it locally. */
  async function reqWrite(path, payload) {
    if (auth.state === OUT) {
      toast({
        title: 'Login required',
        sub: 'Sign in with Discord and join the Kyro server to use the requests board.',
        icon: ICON.lock, warn: true, ttl: 6500,
        actions: [{ label: 'Login with Discord', onClick: startLogin }]
      });
      return null;
    }
    if (auth.state === LOGGED) {
      toast({
        title: 'Access denied',
        sub: 'You must be a member of the Kyro Discord server to use the requests board.',
        icon: ICON.shield, warn: true, ttl: 7000,
        actions: [{ label: 'Join Server', href: INVITE_URL }, { label: 'Refresh Verification', onClick: recheckMembership }]
      });
      return null;
    }
    if (reqBusy) return null;

    reqBusy = true;
    renderRequests();
    try {
      const res = await fetch(AUTH_WORKER_URL + path, {
        method: 'POST',
        headers: Object.assign({ 'content-type': 'application/json' }, reqHeaders()),
        body: JSON.stringify(payload),
        credentials: 'omit'
      });
      const data = await res.json().catch(() => ({}));

      if (res.status === 401) {
        logout();
        toast({ title: 'Session expired', sub: 'Discord rejected the token — sign in again.', icon: ICON.x, warn: true, ttl: 6500 });
        return null;
      }
      if (!res.ok) {
        /* The worker's own messages are already written for a reader, so they
           travel to the toast instead of being replaced by generic copy. */
        toast({
          title: 'Nothing was posted',
          sub: data.error || 'The requests board responded ' + res.status + '.',
          icon: ICON.x, warn: true, ttl: 6500
        });
        return null;
      }
      if (Array.isArray(data.requests)) requests = data.requests;
      reqError = '';
      return data;
    } catch (err) {
      toast({ title: 'Requests board unreachable', sub: 'Check your connection and try again.', icon: ICON.x, warn: true, ttl: 6500 });
      console.warn('[kyro-requests] ' + ((err && err.message) || err));
      return null;
    } finally {
      reqBusy = false;
      renderRequests();
    }
  }

  function requestCardHTML(r) {
    const voted = Boolean(r.you_voted);
    const status = REQ_STATUS_LABEL[r.status] || REQ_STATUS_LABEL.under_review;
    const statusCls = REQ_STATUS_CLASS[r.status] || 'badge';
    const day = String(r.created || '').slice(0, 10);
    return '<article class="req-item' + (voted ? ' is-voted' : '') + '">' +
        '<button type="button" class="vote-btn mono" data-vote="' + esc(r.id) + '" aria-pressed="' + voted + '"' +
          ' aria-label="' + (voted ? 'Remove your vote from ' : 'Upvote ') + esc(r.title) + '">' +
          '<span class="vote-caret" aria-hidden="true">' + (voted ? '▲' : '△') + '</span>' +
          '<span class="vote-num">' + (Number(r.votes) || 0) + '</span>' +
        '</button>' +
        '<div class="req-main">' +
          '<p class="req-title">' + esc(r.title) + '</p>' +
          (r.desc ? '<p class="req-desc">' + esc(r.desc) + '</p>' : '') +
          '<p class="req-meta">' +
            '<span class="' + statusCls + '">' + status + '</span>' +
            '<span class="req-cat mono">' + esc((window.KYRO_CATEGORY_LABEL[r.category] || 'Other').toUpperCase()) + '</span>' +
            (r.ae ? '<span class="req-cat mono">AE ' + esc(r.ae) + '</span>' : '') +
            (day ? '<span class="req-day mono">' + esc(day) + '</span>' : '') +
          '</p>' +
        '</div>' +
      '</article>';
  }

  function reqGateHTML() {
    if (auth.state === OUT) {
      return '<p class="req-gate-text">Verified Kyro members post and vote on requests.</p>' +
        '<button type="button" class="btn btn-ghost btn-sm" id="reqLogin">' + ICON.discord + 'Login with Discord</button>';
    }
    return '<p class="req-gate-text">Join the Kyro Discord server to post and vote on requests.</p>' +
      '<a class="btn btn-ghost btn-sm" href="' + esc(INVITE_URL) + '" target="_blank" rel="noopener noreferrer">' + ICON.discord + 'Join Server</a>' +
      '<button type="button" class="btn btn-ghost btn-sm" id="reqRecheck">Refresh Verification</button>';
  }

  function renderReqCategories() {
    if (!reqCategories) return;
    reqCategories.innerHTML = REQ_CATEGORY_OPTIONS.map(([value, label]) =>
      '<button type="button" class="cat-chip mono" data-cat="' + value + '" aria-pressed="' + (value === reqCategory) + '">' +
      esc(label.toUpperCase()) + '</button>').join('');
    reqCategories.querySelectorAll('[data-cat]').forEach(btn => btn.addEventListener('click', () => {
      reqCategory = btn.dataset.cat;
      renderReqCategories();
    }));
  }

  function renderRequests() {
    if (!requestList) return;
    const verified = auth.state === VERIFIED;
    requestCompose.hidden = !verified;
    requestGate.hidden = verified;
    if (!verified) requestGate.innerHTML = reqGateHTML();

    requestCount.textContent = reqError
      ? 'board unavailable'
      : requests.length + (requests.length === 1 ? ' request' : ' requests');

    requestList.innerHTML = reqError
      ? '<p class="req-empty">' + esc(reqError) + '</p>'
      : requests.length
        ? requests.map(requestCardHTML).join('')
        : '<p class="req-empty">Nothing on the board yet.' +
          (verified ? ' Post the first request.' : ' Verified members start it off.') + '</p>';

    requestList.querySelectorAll('[data-vote]').forEach(btn =>
      btn.addEventListener('click', () => voteRequest(btn.dataset.vote, btn)));

    const rl = $('#reqLogin');
    if (rl) rl.addEventListener('click', startLogin);
    const rr = $('#reqRecheck');
    if (rr) rr.addEventListener('click', recheckMembership);

    reqSubmit.disabled = reqBusy;
    reqSubmit.textContent = reqBusy ? 'Posting…' : 'Submit Request';
  }

  function voteRequest(id, btn) {
    if (reqBusy) return;
    reqWrite('/requests/vote', { token: auth.token, id });
  }

  function submitRequest() {
    const title = reqTitle.value.trim();
    const ae = reqAe.value.trim();
    if (title.length < 3) {
      reqTitle.focus();
      toast({ title: 'Needs a title', sub: 'At least 3 characters — say which tool you want.', icon: ICON.x, warn: true });
      return;
    }
    if (ae && !/^\d{4}$/.test(ae)) {
      reqAe.focus();
      toast({ title: 'AE version is a year', sub: 'Four digits, for example 2026. Leave it blank if any version works.', icon: ICON.x, warn: true });
      return;
    }
    reqWrite('/requests', {
      token: auth.token,
      title,
      category: reqCategory,
      ae,
      desc: reqDesc.value.trim()
    }).then((data) => {
      if (!data) return;
      reqTitle.value = '';
      reqAe.value = '';
      reqDesc.value = '';
      toast({ title: 'Request posted', sub: 'Verified members can upvote it from this panel.', icon: ICON.check });
    });
  }

  function openRequests() {
    if (!requestsDrawer) return;
    if (drawer.classList.contains('is-open')) hide(drawer);
    renderRequests();
    openScrim();
    requestsDrawer.classList.add('is-open');
    requestsDrawer.setAttribute('aria-hidden', 'false');
    loadRequests();
    const focusTo = auth.state === VERIFIED ? reqTitle : $('#requestsClose');
    if (focusTo) focusTo.focus({ preventScroll: true });
  }
  function closeRequests() {
    if (!requestsDrawer) return;
    hide(requestsDrawer);
    closeScrim();
  }

  /* ------------------------------ detail modal -------------------------- */
  let modalId = null;
  let modalTab = 'overview';

  const OS_BADGES = [
    { value: 'windows', label: 'Windows' },
    { value: 'macos', label: 'macOS' }
  ];

  /* The first file extension drives the compact format badge. A pure software
     entry ships no downloadable files, so return '' instead of reading index 0
     of an empty array (which would throw and blank the whole modal). */
  function firstExt(r) {
    return (r.files && r.files.length ? r.files[0].ext : r.format) || '';
  }

  function specHTML(r) {
    const files = (r.files && r.files.length ? r.files : [{ ext: r.format }])
      .map(f => String(f.ext || '').toLowerCase())
      .filter(Boolean)
      .filter((ext, i, all) => all.indexOf(ext) === i);

    const group = (label, badges) => badges.length
      ? '<div class="spec"><span class="spec-label mono">' + label + '</span>' +
        '<span class="spec-badges">' + badges.join('') + '</span></div>'
      : '';

    return '<div class="spec-row">' +
      group('AE Compatibility', r.aeMin
        ? ['<span class="badge badge-spec">AE ' + esc(r.aeMin) + '+</span>'] : []) +
      group('OS / Architecture', OS_BADGES.filter(b => (r.os || []).includes(b.value)).map(b =>
        '<span class="badge badge-spec' + (b.value === os ? ' is-current' : '') + '">' + esc(b.label + (r.architecture ? ' · ' + r.architecture : '')) + '</span>')) +
      group('File Format', files.map(ext => '<span class="badge badge-format">' + esc(ext) + '</span>')) +
      '</div>';
  }

  /* The AppleFX guide is full prose — headings, sub-headings, paragraphs, fenced
     commands, ordered steps, a blockquote and a troubleshooting table. Each
     entry in `blocks` is one of those shapes; paragraph/list/quote/table cells
     are authored HTML (links, <code>, <b>) so they render as written, while
     headings and code are escaped because they are plain text. */
  function installBlock(ext, label) {
    const guide = window.KYRO_INSTALL[ext];
    if (!guide) return '';
    if (guide.blocks) {
      const code = (b) =>
        '<pre class="install-code">' +
        (b.lang ? '<span class="install-code-lang mono">' + esc(b.lang) + '</span>' : '') +
        '<code>' + esc(b.code) + '</code></pre>';
      const body = guide.blocks.map(b => {
        if (b.h) return '<h4 class="install-h">' + esc(b.h) + '</h4>';
        if (b.sub) return '<h5 class="install-sub">' + esc(b.sub) + '</h5>';
        if (b.p) return '<p class="install-p">' + b.p + '</p>';
        if (b.code) return code(b);
        if (b.ol) return '<ol class="install-steps">' + b.ol.map(i => '<li>' + i + '</li>').join('') + '</ol>';
        if (b.ul) return '<ul class="install-list">' + b.ul.map(i => '<li>' + i + '</li>').join('') + '</ul>';
        if (b.quote) return '<blockquote class="install-quote">' + b.quote + '</blockquote>';
        if (b.table) return '<div class="install-table-wrap"><table class="install-table"><thead><tr>' +
          b.table.head.map(h => '<th>' + esc(h) + '</th>').join('') + '</tr></thead><tbody>' +
          b.table.rows.map(r => '<tr>' + r.map(c => '<td>' + c + '</td>').join('') + '</tr>').join('') +
          '</tbody></table></div>';
        return '';
      }).join('');
      return '<div class="install-block">' +
        (guide.title ? '<p class="install-title">' + esc(guide.title) + '</p>' : '') + body + '</div>';
    }
    /* A sectioned guide is written prose, not a path walkthrough: heading and
       paragraph pairs under one title. */
    if (guide.sections) {
      return '<div class="install-block">' +
        (guide.title ? '<p class="install-title">' + esc(guide.title) + '</p>' : '') +
        guide.sections.map(s =>
          '<div class="install-section">' +
            '<h4 class="install-h">' + esc(s.h) + '</h4>' +
            '<p class="m-desc">' + esc(s.p) + '</p>' +
          '</div>').join('') +
        '</div>';
    }
    const path = guide.paths[os];
    return (
      '<div class="install-block">' +
        '<p class="section-label section-label--tight">' + esc(ext.toUpperCase()) + (label ? ' · ' + esc(label) : '') + '</p>' +
        '<p class="m-desc">' + guide.intro + '</p>' +
        '<ol class="install-steps">' + guide.steps.map(s => '<li><p>' + s + '</p></li>').join('') + '</ol>' +
        '<div class="install-path"><span class="install-path-label">' + (os === 'windows' ? 'Windows path' : 'macOS path') + '</span><code>' + esc(path) + '</code></div>' +
        '<div class="install-note">' + guide.note + '</div>' +
      '</div>'
    );
  }

  function installHTML(r) {
    if (window.KYRO_INSTALL[r.id]) return installBlock(r.id);
    const files = r.files && r.files.length ? r.files : [{ ext: r.format, label: '' }];
    const blocks = files.map(f => installBlock(f.ext, f.label)).filter(Boolean).join('');
    return blocks || '<p class="m-desc">No install guide on file for this format.</p>';
  }

  /* A SHA-256 is the only hash Discord-free scanners understand, and it is
     editable data, so it must be well-formed before it becomes a URL — a
     malformed value never renders a link at all. */
  function vtURL(sha) {
    const s = String(sha || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/.test(s) ? 'https://www.virustotal.com/gui/file/' + s : '';
  }

  function fileRowsHTML(r) {
    const unlocked = auth.state === VERIFIED;
    return (r.files || []).map(f => {
      const vt = vtURL(f.sha256);
      const action = !unlocked
        ? '<button type="button" class="btn btn-ghost btn-sm" data-file="' + esc(f.ext) + '">' +
          ICON.lock + (auth.state === OUT ? 'Login' : 'Locked') + '</button>'
        : f.url
          /* Externally hosted archives hand off to the file host, so the
             button links out instead of faking a transfer. */
          ? '<a class="btn btn-primary btn-sm" data-ext-link href="' + esc(f.url) +
            '" target="_blank" rel="noopener noreferrer">' + ICON.download + 'Download</a>'
          : '<button type="button" class="btn btn-primary btn-sm" data-file="' + esc(f.ext) +
            '" style="position:relative">' + ICON.download + 'Download<span class="ring"></span></button>';
      return (
      '<div class="file-row ' + (unlocked ? 'is-unlocked' : 'is-locked') + '">' +
        '<span class="file-ico mono">' + esc(String(f.ext).replace('.', '')).toUpperCase() + '</span>' +
        '<span class="file-info">' +
          '<span class="file-name">' + esc(f.name) + '</span>' +
          '<span class="file-sub">' + esc(f.label) + '</span>' +
        '</span>' +
        '<span class="file-actions">' +
          (f.size ? '<span class="file-size mono">' + esc(f.size) + '</span>' : '') +
          (vt
            ? '<a class="btn btn-ghost btn-sm" href="' + vt +
              '" target="_blank" rel="noopener noreferrer" title="VirusTotal report for ' + esc(f.name) + '">' +
              ICON.shield + 'VirusTotal</a>'
            : '') +
          action +
        '</span>' +
      '</div>');
    }).join('');
  }

  /* One archive, many files: the unpack password belongs beside the download
     link, not buried in the description — and only once the link is unlocked. */
  function passwordHTML(r) {
    if (auth.state !== VERIFIED) return '';
    const pass = (r.files || []).map(f => f.pass).filter(Boolean)[0];
    if (!pass) return '';
    return '<div class="pass-row">' +
      '<span class="pass-label mono">ARCHIVE PASSWORD</span>' +
      '<code class="pass-value">' + esc(pass) + '</code>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-pass-copy data-pass="' + esc(pass) + '">' + ICON.copy + 'Copy</button>' +
      '</div>';
  }

  /* -------------------------- release lock / countdown -------------------
     A staged drop carries `releaseAt` (an ISO timestamp). Until that moment its
     download stays sealed behind a live countdown; once the clock passes it the
     normal verified-member gate takes over untouched. */
  function releaseTime(r) { return r && r.releaseAt ? Date.parse(r.releaseAt) : NaN; }
  function isLocked(r) { const t = releaseTime(r); return !isNaN(t) && Date.now() < t; }
  function countdownParts(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return { d: Math.floor(s / 86400), h: Math.floor((s % 86400) / 3600), m: Math.floor((s % 3600) / 60), s: s % 60 };
  }
  function cdCell(v, lab) {
    return '<div class="cd-cell"><span class="cd-num mono">' + String(v).padStart(2, '0') + '</span><span class="cd-lab">' + lab + '</span></div>';
  }
  function cdCells(t) {
    const p = countdownParts(t - Date.now());
    return cdCell(p.d, 'days') + cdCell(p.h, 'hrs') + cdCell(p.m, 'min') + cdCell(p.s, 'sec');
  }
  function releaseWhen(t) {
    return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  }
  function countdownHTML(r) {
    const t = releaseTime(r);
    return '<div class="soon-panel">' +
      '<p class="soon-kicker mono">' + ICON.clock + 'COMING SOON · STAY TUNED</p>' +
      '<p class="soon-title">' + esc(r.title) + (r.version ? ' ' + esc(r.version) : '') + ' unlocks ' + esc(releaseWhen(t)) + '.</p>' +
      '<div class="countdown" data-release="' + t + '">' + cdCells(t) + '</div>' +
      '<a class="btn btn-ghost" href="' + INVITE_URL + '" target="_blank" rel="noopener noreferrer">' + ICON.discord + 'Get the drop in the Kyro Discord</a>' +
      '</div>';
  }
  let cdTimer = null;
  function tickCountdown() {
    const el = modalBox && modalBox.querySelector('.countdown[data-release]');
    if (!el) { stopCountdownTick(); return; }
    const t = Number(el.getAttribute('data-release'));
    if (Date.now() >= t) { stopCountdownTick(); const r = byId(modalId); if (r) wireDownloads(r); return; }
    el.innerHTML = cdCells(t);
  }
  function startCountdownTick() { if (cdTimer) return; tickCountdown(); cdTimer = setInterval(tickCountdown, 1000); }
  function stopCountdownTick() { if (cdTimer) { clearInterval(cdTimer); cdTimer = null; } }

  /* The gate, the rows and the password are one surface: rebuilt together
     whenever auth state changes, so a modal opened logged-out never keeps
     showing locked rows after the visitor verifies without closing it. */
  function wireDownloads(r) {
    const zone = modalBox.querySelector('.dl-zone');
    if (!zone) return;
    if (isLocked(r)) { zone.innerHTML = countdownHTML(r); startCountdownTick(); return; }
    stopCountdownTick();
    zone.innerHTML = gateBannerHTML(r) +
      '<div class="file-list">' + fileRowsHTML(r) + '</div>' +
      passwordHTML(r);

    const gl = zone.querySelector('#gateLogin');
    if (gl) gl.addEventListener('click', startLogin);
    const gr = zone.querySelector('#gateRecheck');
    if (gr) gr.addEventListener('click', recheckMembership);
    zone.querySelectorAll('[data-file]').forEach(btn =>
      btn.addEventListener('click', () => requestFile(r, btn.dataset.file, btn)));
    /* The externally hosted archive leaves the page, so the click itself is the
       only signal that somebody actually took the file. */
    zone.querySelectorAll('[data-ext-link]').forEach(a =>
      a.addEventListener('click', () => countDownload(r)));
    const cp = zone.querySelector('[data-pass-copy]');
    if (cp) cp.addEventListener('click', () => copyPass(cp, cp.dataset.pass));
  }

  function copyPass(btn, text) {
    const done = () => {
      btn.classList.add('is-done');
      setTimeout(() => btn.classList.remove('is-done'), 1600);
      toast({ title: 'Password copied', sub: 'Paste it when the archive asks.' });
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => toast({ title: 'Copy failed', sub: 'Select the password and copy it manually.', icon: ICON.lock, warn: true }));
    } else {
      toast({ title: 'Clipboard unavailable', sub: 'Select the password and copy it manually.', icon: ICON.lock, warn: true });
    }
  }

  function gateBannerHTML(r) {
    const a = access();
    if (auth.state === OUT) {
      return '<div class="gate-banner gate-out"><span class="g-icon">' + ICON.lock + '</span>' +
        '<span class="g-text"><b>' + esc(a.prompt) + '</b><br/>Membership is checked after you sign in.</span>' +
        '<button type="button" class="btn btn-discord btn-sm" id="gateLogin">' + ICON.discord + 'Login with Discord</button></div>';
    }
    if (auth.state === LOGGED) {
      return '<div class="gate-banner gate-denied"><span class="g-icon">' + ICON.shield + '</span>' +
        '<span class="g-text"><b>Access Denied:</b> You must be a member of the Kyro Discord server to download assets!</span>' +
        '<a class="btn btn-danger btn-sm" href="' + INVITE_URL + '" target="_blank" rel="noopener noreferrer">' + ICON.discord + 'Join Server</a>' +
        '<button type="button" class="btn btn-ghost btn-sm" id="gateRecheck">Refresh Verification</button></div>';
    }
    return '<div class="gate-banner gate-ok"><span class="g-icon">' + ICON.unlock + '</span>' +
      '<span class="g-text"><b>Downloads unlocked.</b> Signed in as ' + esc(auth.user.username) + ' · verified Kyro member.</span>' +
      '<button type="button" class="btn btn-ghost btn-sm" id="gateRecheck">Refresh Verification</button></div>';
  }

  /* Real screenshots replace the generated canvas whenever the seed ships a
     gallery; the thumbs swap the big shot in place. */
  function stageHTML(r) {
    const gal = (r.gallery || []).filter(Boolean);
    const fx = firstExt(r);
    const badgeRow =
      '<div class="badge-row">' + priceBadge(r) +
      (fx ? '<span class="badge badge-format">' + esc(String(fx)).toUpperCase().replace('.', '') + '</span>' : '') + '</div>';
    if (!gal.length) {
      return '<div class="m-stage"><canvas id="modalCanvas"></canvas>' +
        '<span class="preview-chip mono">LIVE PREVIEW</span>' + badgeRow + '</div>';
    }
    return '<div class="m-stage has-gallery">' +
      '<img class="m-shot" id="modalShot" src="' + esc(gal[0]) + '" alt="' + esc(r.title) + ' preview" />' +
      '<span class="preview-chip mono">PRODUCT IMAGES</span>' + badgeRow +
      '<div class="m-thumbs">' + gal.map((src, i) =>
        '<button type="button" class="m-thumb' + (i === 0 ? ' is-active' : '') + '" data-shot="' + esc(src) +
        '" aria-pressed="' + (i === 0) + '" aria-label="Show preview ' + (i + 1) + ' of ' + gal.length + '">' +
        '<img src="' + esc(src) + '" alt="" /></button>').join('') + '</div>' +
      '</div>';
  }

  function openModal(id) {
    const r = resources.find(x => x.id === id);
    if (!r) return;
    modalId = id;
    const isSaved = saved.has(id);
    const version = r.version ? '<span class="m-version mono">' + esc(r.version) + '</span>' : '';
    const by = r.creator ? '<span>by ' + esc(r.creator) + '</span>' : '';
    modalBox.innerHTML =
      '<button class="close-x modal-close" aria-label="Close"></button>' +
      stageHTML(r) +
      '<div class="m-body">' +
        '<div class="m-title-row"><h2 class="m-title">' + esc(r.title) + '</h2>' + version + '</div>' +
        '<p class="m-desc">' + esc(r.desc) + '</p>' +
        specHTML(r) +
        '<div class="tabs" role="tablist">' +
          '<button class="tab" data-tab="overview" role="tab">Overview</button>' +
          '<button class="tab" data-tab="install" role="tab">Installation Guide</button>' +
        '</div>' +
        '<div class="tab-panel" data-panel="overview">' +
          '<ul class="feature-list">' + (r.features || []).map(f => '<li>' + ICON.check + '<span>' + esc(f) + '</span></li>').join('') + '</ul>' +
          '<div class="tag-row">' + (r.tags || []).map(t => '<span class="tag-chip">#' + esc(t) + '</span>').join('') + '</div>' +
          '<div class="meta-row">' +
            '<span class="dl-count">' + ICON.download + downloadsLabel(downloadCount(r)) + '</span>' +
            by +
            (r.credits ? '<span>Credits: ' + esc(r.credits) + '</span>' : '') +
            '<span>ADDED ' + esc(r.added) + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="tab-panel" data-panel="install">' + installHTML(r) + '</div>' +
        '<p class="section-label section-label--tight">Downloads</p>' +
        '<div class="dl-zone"></div>' +
        '<div class="m-actions">' +
          '<button class="save-btn' + (isSaved ? ' is-saved' : '') + '" data-save="' + esc(r.id) + '" aria-pressed="' + isSaved + '" aria-label="Save to vault">' + ICON.bookmark + '</button>' +
          '<a class="btn btn-ghost" href="' + INVITE_URL + '" target="_blank" rel="noopener noreferrer">' + ICON.discord + 'Server</a>' +
        '</div>' +
      '</div>';

    // tabs
    modalBox.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => {
      modalTab = tab.dataset.tab;
      syncTabs();
    }));
    modalBox.querySelector('.modal-close').addEventListener('click', closeModal);
    modalBox.querySelector('.save-btn').addEventListener('click', (e) => toggleSave(r.id, e.currentTarget));

    wireDownloads(r);

    modalBox.querySelectorAll('[data-shot]').forEach(btn => btn.addEventListener('click', () => {
      const shot = $('#modalShot');
      if (!shot) return;
      shot.src = btn.dataset.shot;
      modalBox.querySelectorAll('[data-shot]').forEach(t => {
        const on = t === btn;
        t.classList.toggle('is-active', on);
        t.setAttribute('aria-pressed', String(on));
      });
    }));

    syncTabs();
    showOverlay(modalOverlay);
    if (!r.gallery || !r.gallery.length) Preview.pin($('#modalCanvas'), r.preview || 'grid', r.seed || 7);
    modalBox.focus({ preventScroll: true });
  }

  function syncTabs() {
    modalBox.querySelectorAll('.tab').forEach(t => t.classList.toggle('is-active', t.dataset.tab === modalTab));
    modalBox.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('is-active', p.dataset.panel === modalTab));
  }

  function closeModal() {
    Preview.unpin($('#modalCanvas'));
    stopCountdownTick();
    hideOverlay(modalOverlay);
    modalId = null;
    modalTab = 'overview';
  }

  /* -------------------------- download counters ------------------------
     The number on a card is the seed's baseline plus whatever the worker has
     actually counted since. Baselines stay in data.js — they are the vault's
     own history — while every real download lands in KV, tallied once per
     verified member, so the counter is shared instead of per-browser. */
  const SEED_BASE = {};
  (window.KYRO_SEED || []).forEach(r => { SEED_BASE[r.id] = Number(r.downloads) || 0; });
  let liveCounts = {};
  /* Per visit, so one member hammering the button cannot spam the worker; the
     server dedupes by Discord id anyway. */
  const counted = {};

  function downloadCount(r) {
    return (Number(SEED_BASE[r.id]) || 0) + (Number(liveCounts[r.id]) || 0);
  }

  /* A counter that reaches exactly one person should not say "1 downloads". */
  function downloadsLabel(n) {
    return full(n) + ' ' + (n === 1 ? 'download' : 'downloads');
  }

  /* Both grids and the open modal repaint from the same numbers, so a count
     that moved elsewhere on the site shows here without a full re-render. */
  function paintCounts() {
    [softwareGrid, toolsGrid].forEach(grid => {
      if (!grid) return;
      grid.querySelectorAll('.software-card[data-id]').forEach(card => {
        const b = card.querySelector('.card-meta .chip b');
        if (b) b.textContent = full(downloadCount(byId(card.dataset.id)));
      });
    });
    const count = modalBox.querySelector('[data-panel="overview"] .dl-count');
    if (count && modalId) {
      const r = byId(modalId);
      if (r) count.innerHTML = ICON.download + downloadsLabel(downloadCount(r));
    }
  }

  function byId(id) {
    return resources.find(r => r.id === id) || null;
  }

  async function loadDownloadCounts() {
    try {
      const res = await fetch(AUTH_WORKER_URL + '/downloads', { headers: { Accept: 'application/json' }, credentials: 'omit' });
      if (!res.ok) return;
      const data = await res.json();
      liveCounts = (data && data.counts) || {};
      paintCounts();
    } catch (err) { /* counters stay at their baseline until the worker answers */ }
  }

  /* Fired the moment a member reaches for the file — the link opens in its own
     tab, so this is the only place the site learns the download happened. */
  async function countDownload(r) {
    if (!r || auth.state !== VERIFIED || !auth.token) return;
    if (counted[r.id]) return;
    counted[r.id] = true;
    try {
      const res = await fetch(AUTH_WORKER_URL + '/downloads', {
        method: 'POST',
        headers: Object.assign({ 'content-type': 'application/json' }, reqHeaders()),
        credentials: 'omit',
        body: JSON.stringify({ token: auth.token, id: r.id })
      });
      if (!res.ok) { delete counted[r.id]; return; }
      const data = await res.json();
      if (data && data.counts) liveCounts = data.counts;
      else liveCounts[r.id] = Number(data && data.downloads) || 0;
      paintCounts();
    } catch (err) { delete counted[r.id]; }
  }

  /* --------------------------- gated downloads -------------------------- */
  function requestFile(r, ext, btn) {
    if (auth.state === OUT) {
      toast({
        title: 'Login required',
        sub: access().prompt,
        icon: ICON.lock, warn: true, ttl: 6000,
        actions: [{ label: 'Login with Discord', onClick: startLogin }]
      });
      btn.animate(
        [{ transform: 'translateX(0)' }, { transform: 'translateX(-4px)' }, { transform: 'translateX(4px)' }, { transform: 'translateX(0)' }],
        { duration: 260, easing: 'ease-in-out' }
      );
      return;
    }
    if (auth.state === LOGGED) {
      toast({
        title: 'Access denied',
        sub: 'You must be a member of the Kyro Discord server to download assets!',
        icon: ICON.shield, warn: true, ttl: 7000,
        actions: [{ label: 'Join Server', href: INVITE_URL }, { label: 'Refresh Verification', onClick: recheckMembership }]
      });
      btn.animate(
        [{ transform: 'translateX(0)' }, { transform: 'translateX(-4px)' }, { transform: 'translateX(4px)' }, { transform: 'translateX(0)' }],
        { duration: 260, easing: 'ease-in-out' }
      );
      return;
    }
    startDownload(r, ext, btn);
  }

  function startDownload(r, ext, btn) {
    if (btn.disabled) return;
    const file = (r.files || []).find(f => f.ext === ext) || { ext, name: r.title, size: '' };
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = ICON.download + 'Preparing…';
    const t = toast({
      title: 'Fetching ' + file.name,
      sub: file.ext.toUpperCase() + ' · ' + file.size + ' · membership verified',
      progress: true, icon: ICON.download, ttl: 0
    });
    let pct = 0;
    const iv = setInterval(() => {
      pct = Math.min(100, pct + 6 + Math.random() * 15);
      t.setPct(pct);
      if (pct >= 100) {
        clearInterval(iv);
        countDownload(r);
        t.finish('Download started', file.name + ' · saved to your Downloads folder');
        btn.disabled = false;
        btn.classList.add('is-done');
        btn.innerHTML = ICON.check + 'Unlocked';
        setTimeout(() => { btn.classList.remove('is-done'); btn.innerHTML = original; }, 1900);
      }
    }, 230);
  }

  /* ------------------------------ toasts -------------------------------- */
  function toast({ title, sub, progress = false, icon = ICON.check, done = false, warn = false, ttl = 3800, actions = [] }) {
    const el = document.createElement('div');
    el.className = 'toast' + (done ? ' done' : '') + (warn ? ' warn' : '');
    el.innerHTML =
      '<div class="toast-row"><div class="toast-ico">' + icon + '</div>' +
      '<div><div class="toast-title">' + esc(title) + '</div><div class="toast-sub">' + esc(sub || '') + '</div></div>' +
      (progress ? '<div class="toast-pct mono">0%</div>' : '') + '</div>' +
      (progress ? '<div class="toast-bar"><i></i></div>' : '') +
      (actions.length ? '<div class="toast-actions"></div>' : '');
    toasts.appendChild(el);

    const box = el.querySelector('.toast-actions');
    actions.forEach(a => {
      const b = a.href
        ? Object.assign(document.createElement('a'), { href: a.href, target: '_blank', rel: 'noopener noreferrer' })
        : Object.assign(document.createElement('button'), { type: 'button' });
      b.className = 'btn btn-sm ' + (a.href ? 'btn-discord' : 'btn-ghost');
      b.textContent = a.label;
      if (a.onClick) b.addEventListener('click', () => { dismiss(); a.onClick(); });
      box.appendChild(b);
    });

    const auto = ttl ? setTimeout(dismiss, ttl) : null;
    function dismiss() {
      if (auto) clearTimeout(auto);
      if (el.classList.contains('leaving')) return;
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 260);
    }
    return {
      el,
      setPct(p) {
        const pct = el.querySelector('.toast-pct');
        if (pct) pct.textContent = Math.round(p) + '%';
        const bar = el.querySelector('.toast-bar i');
        if (bar) bar.style.width = p + '%';
      },
      finish(title2, sub2) {
        el.classList.add('done');
        el.querySelector('.toast-ico').innerHTML = ICON.check;
        el.querySelector('.toast-title').textContent = title2;
        el.querySelector('.toast-sub').textContent = sub2;
        /* A finished toast has no meaningful progress left to show. */
        ['.toast-pct', '.toast-bar', '.toast-actions'].forEach(sel => {
          const node = el.querySelector(sel);
          if (node) node.remove();
        });
        setTimeout(dismiss, 2800);
      }
    };
  }

  /* --------------------------- command palette -------------------------- */
  let paletteOpen = false;
  let paletteList = [];
  let paletteCursor = 0;

  function commands() {
    const list = [];
    if (auth.state === OUT) list.push({ kind: 'cmd', title: 'Login with Discord', hint: 'OAuth2 · unlocks membership check', run: startLogin });
    else list.push({ kind: 'cmd', title: 'Logout of Discord', hint: auth.user.username, run: logout });
    if (auth.state !== VERIFIED) list.push({ kind: 'cmd', title: 'Refresh verification', hint: 'verified member unlocks downloads', run: recheckMembership });
    list.push({ kind: 'cmd', title: 'Requests board', hint: 'ask for a tool · vote on the vault', run: openRequests });
    list.push({ kind: 'cmd', title: 'Join the Kyro Discord', hint: INVITE_CODE, run: () => window.open(INVITE_URL, '_blank', 'noopener') });
    return list;
  }

  function paletteSearch(q) {
    const scored = resources
      .map(r => ({
        kind: 'asset', r, s: Math.max(
          fuzzy(q, r.title) * 1.4,
          fuzzy(q, (r.tags || []).join(' ')),
          fuzzy(q, (r.files || []).map(f => f.ext).join(' ')),
          fuzzy(q, window.KYRO_CATEGORY_LABEL[r.category] || '')
        )
      }))
      .concat(commands().map(c => ({ kind: 'cmd', r: c, s: Math.max(fuzzy(q, c.title) * 1.4, fuzzy(q, c.hint)) })))
      .filter(x => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 8);
    paletteList = scored;
    paletteCursor = 0;
    renderPaletteRows(q);
  }

  function renderPaletteRows(q) {
    if (!paletteList.length) {
      paletteResults.innerHTML = '<div class="palette-empty">Nothing matches “' + esc(q) + '”. Try “applefx”, “.ffx” or “login”.</div>';
      return;
    }
    paletteResults.innerHTML = paletteList.map((x, i) => {
      const cursor = i === paletteCursor ? ' is-cursor' : '';
      if (x.kind === 'cmd') {
        return '<div class="palette-row' + cursor + '" data-i="' + i + '" role="option" aria-selected="' + (i === paletteCursor) + '">' +
          '<span class="badge badge-format">CMD</span>' +
          '<div class="p-left"><div class="p-title">' + esc(x.r.title) + '</div><div class="p-tags">' + esc(x.r.hint) + '</div></div>' +
          ICON.arrow + '</div>';
      }
      const r = x.r;
      return '<div class="palette-row' + cursor + '" data-i="' + i + '" role="option" aria-selected="' + (i === paletteCursor) + '">' +
        '<span class="badge badge-format">' + (r.version ? 'V' + esc(r.version) : esc(window.KYRO_CATEGORY_LABEL[r.category] || 'ASSET')) + '</span>' +
        '<div class="p-left"><div class="p-title">' + esc(r.title) + '</div>' +
        '<div class="p-tags">#' + esc((r.tags || []).slice(0, 4).join(' · #')) + '</div></div>' +
        (auth.state === VERIFIED ? '<span class="badge badge-free">READY</span>' : '<span class="badge badge-locked">LOCKED</span>') +
        '</div>';
    }).join('');
  }

  function movePalette(d) {
    if (!paletteList.length) return;
    paletteCursor = (paletteCursor + d + paletteList.length) % paletteList.length;
    renderPaletteRows(paletteInput.value);
    const row = paletteResults.children[paletteCursor];
    if (row) row.scrollIntoView({ block: 'nearest' });
  }

  function openPalette() {
    paletteOpen = true;
    showOverlay(paletteOverlay);
    paletteInput.value = '';
    paletteSearch('');
    paletteInput.focus();
  }
  function closePalette() { paletteOpen = false; hideOverlay(paletteOverlay); }
  function togglePalette() { paletteOpen ? closePalette() : openPalette(); }
  function paletteEnter() {
    const hit = paletteList[paletteCursor];
    if (!hit) return;
    closePalette();
    if (hit.kind === 'cmd') hit.r.run();
    else openModal(hit.r.id);
  }

  /* --------------------------- overlay plumbing ------------------------- */
  function showOverlay(el) {
    el.hidden = false;
    document.body.style.overflow = 'hidden';
  }
  function hideOverlay(el) {
    el.hidden = true;
    const drawerOpen = [drawer, requestsDrawer].some(d => d && d.classList.contains('is-open'));
    if (!$('.overlay:not([hidden])') && !drawerOpen) {
      document.body.style.overflow = '';
    }
  }

  [modalOverlay, paletteOverlay].forEach(ov => {
    ov.addEventListener('click', (e) => {
      if (e.target !== ov) return;
      if (ov === modalOverlay) closeModal();
      else closePalette();
    });
  });
  $$('[data-close]').forEach(btn => btn.addEventListener('click', () => hideOverlay(document.getElementById(btn.dataset.close))));

  /* ------------------------------ global events ------------------------- */
  /* Both shelves behave identically; the vault page has neither, so the list
     it binds is simply empty there. */
  [softwareGrid, toolsGrid].forEach(grid => {
    if (!grid) return;
    grid.addEventListener('click', (e) => {
      const save = e.target.closest('[data-save]');
      if (save) { toggleSave(save.dataset.save, save); return; }
      const card = e.target.closest('.software-card');
      if (card) openModal(card.dataset.id);
    });
    grid.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (e.target.closest('button')) return;
      const card = e.target.closest('.software-card');
      if (card) { e.preventDefault(); openModal(card.dataset.id); }
    });
  });

  const requestsBtn = $('#requestsOpen');
  if (requestsBtn) {
    requestsBtn.addEventListener('click', () =>
      requestsDrawer.classList.contains('is-open') ? closeRequests() : openRequests());
  }
  const requestsCloseBtn = $('#requestsClose');
  if (requestsCloseBtn) requestsCloseBtn.addEventListener('click', closeRequests);
  drawerScrim.addEventListener('click', () => {
    if (requestsDrawer && requestsDrawer.classList.contains('is-open')) closeRequests();
    else closeDrawer();
  });

  function syncOsButtons(value) {
    $$('.os-toggle-btn').forEach(b => {
      const on = b.dataset.os === value;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', String(on));
    });
  }

  $$('.os-toggle-btn').forEach(btn => btn.addEventListener('click', () => {
    const value = btn.dataset.os;
    if (value === os) return;
    os = value;
    write(K_OS, os);
    syncOsButtons(os);
    if (modalId) openModal(modalId);
    toast({ title: 'Guides now show ' + (os === 'windows' ? 'Windows' : 'macOS') + ' paths', icon: ICON.check, ttl: 2600 });
  }));

  $('#savedBtn').addEventListener('click', () => drawer.classList.contains('is-open') ? closeDrawer() : openDrawer());
  $('#drawerClose').addEventListener('click', closeDrawer);
  drawerScrim.addEventListener('click', closeDrawer);
  $('#vaultClear').addEventListener('click', () => {
    saved.clear();
    write(K_SAVED, []);
    updateSavedUI();
    vaultRefresh();
    renderSoftware();
    toast({ title: 'Vault cleared', sub: 'All bookmarks removed.', icon: ICON.x });
  });
  vaultList.addEventListener('click', (e) => {
    const remove = e.target.closest('[data-remove]');
    if (remove) {
      e.stopPropagation();
      saved.delete(remove.dataset.remove);
      write(K_SAVED, Array.from(saved));
      updateSavedUI();
      vaultRefresh();
      renderSoftware();
      return;
    }
    const item = e.target.closest('.vault-item');
    if (item) { closeDrawer(); openModal(item.dataset.id); }
  });
  vaultList.addEventListener('keydown', (e) => {
    if (e.target.closest('button')) return;
    const item = e.target.closest('.vault-item');
    if (item && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); closeDrawer(); openModal(item.dataset.id); }
  });

  const heroSearch = $('#heroSearch');
  if (heroSearch) heroSearch.addEventListener('click', openPalette);
  $('#paletteOpen').addEventListener('click', openPalette);
  paletteInput.addEventListener('input', () => paletteSearch(paletteInput.value));
  paletteResults.addEventListener('click', (e) => {
    const row = e.target.closest('.palette-row');
    if (!row) return;
    paletteCursor = Number(row.dataset.i);
    paletteEnter();
  });
  paletteOverlay.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); movePalette(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); movePalette(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); paletteEnter(); }
  });

  /* On index.html the logo is a scroll-to-top; on the other pages it is a
     plain link home, so the id — and the handler — is simply absent. */
  const brand = $('#brandLink');
  if (brand) brand.addEventListener('click', (e) => {
    if (brand.getAttribute('href') !== '#') return;
    e.preventDefault();
    window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
  });

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      togglePalette();
      return;
    }
    if (e.key === 'Escape') {
      closeProfileMenu();
      if (paletteOpen) closePalette();
      else if (!modalOverlay.hidden) closeModal();
      else if (requestsDrawer && requestsDrawer.classList.contains('is-open')) closeRequests();
      else if (drawer.classList.contains('is-open')) closeDrawer();
    }
  });

  /* ------------------------------ boot ---------------------------------- */
  /* Live footer stamp: the visitor's own clock, so it never reads stale. */
  const two = (n) => String(n).padStart(2, '0');
  const stamp = $('#siteUpdated');
  function tickStamp() {
    const d = new Date();
    stamp.textContent = d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()) +
      ' ' + two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds());
  }
  tickStamp();
  setInterval(tickStamp, 1000);
  $('#footerInvite').href = INVITE_URL;
  $('#footerDomain').textContent = window.KYRO_SITE.domain;

  /* /windows and /macos are this same bundle with one browse cell expanded
     into a page; the page tells the bundle which cell it is. Anything else
     goes back to the vault. */
  if (document.body.dataset.page === 'category') {
    const b = BROWSE.find(x => x.id === document.body.dataset.category && !x.noCount);
    if (!b) location.replace('/');
    else {
      filters.view = b.id;
      /* The page’s own platform drives the badges and the install paths for
         this visit only — it does not overwrite what the visitor picked, or
         what the browser detected, everywhere else. */
      if (b.osValue) os = b.osValue;
    }
  }

  captureSessionFromUrl();
  syncOsButtons(os);
  renderAuth();
  renderAccess();
  renderSoftware();
  renderCategoryHead();
  renderBrowse();
  renderReqCategories();
  updateSavedUI();
  startServerStats();

  // Deep links: #r-<asset> opens its modal, #login starts the Discord OAuth redirect.
  const hash = location.hash;
  if (hash.startsWith('#r-')) {
    const id = decodeURIComponent(hash.slice(3));
    if (resources.some(r => r.id === id)) openModal(id);
  } else if (hash === '#login') {
    if (auth.state === OUT) startLogin();
  }
})();
