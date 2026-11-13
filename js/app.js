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

  /* ------------------------------ storage ------------------------------ */
  const K_RES = 'kyro.resources.v3';
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

  let resources = read(K_RES, null);
  if (!Array.isArray(resources) || !resources.length) {
    resources = window.KYRO_SEED.map(r => Object.assign({}, r));
    write(K_RES, resources);
  }
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

  /* ------------------------------ DOM refs ----------------------------- */
  const authSlot = $('#authSlot');
  const accessStrip = $('#accessStrip');
  const softwareGrid = $('#softwareGrid');
  const softwareNote = $('#softwareNote');
  const browseGrid = $('#browseGrid');
  const discordCard = $('#discordCard');
  const emptyState = $('#emptyState');
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
    apple: '<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M13.1 8.5c0-1.7 1.4-2.6 1.5-2.6-.8-1.2-2.1-1.3-2.5-1.4-1.1-.1-2.1.6-2.7.6-.6 0-1.4-.6-2.3-.6-1.2 0-2.3.7-2.9 1.7-1.2 2.1-.3 5.3.9 7 .6.9 1.3 1.8 2.2 1.8.9 0 1.2-.6 2.3-.6s1.4.6 2.3.5c1 0 1.6-.8 2.1-1.7.7-1 1-2 1-2-.1 0-1.9-.7-1.9-2.7zM11.3 3.5c.5-.6.8-1.4.7-2.2-.7 0-1.5.5-2 1.1-.4.5-.8 1.3-.7 2.1.8.1 1.5-.4 2-1z"/></svg>'
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
  }

  /* ========================= directory rendering ======================== */
  function byNewest(a, b) {
    const d = String(b.added || '').localeCompare(String(a.added || ''));
    return d !== 0 ? d : String(b.version || '').localeCompare(String(a.version || ''), undefined, { numeric: true });
  }

  function listFor(b) {
    let list = resources.slice();
    if (b.cats) list = list.filter(r => b.cats.indexOf(r.category) !== -1);
    if (b.free) list = list.filter(r => Number(r.price) === 0);
    if (b.sort === 'newest') list = list.sort(byNewest);
    return list;
  }

  function currentView() {
    return BROWSE.find(b => b.id === filters.view) || { title: 'All', cats: null, free: false };
  }

  function currentList() {
    return listFor(currentView());
  }

  function priceBadge(r) {
    return Number(r.price) === 0
      ? '<span class="badge badge-free">FREE</span>'
      : '<span class="badge badge-pro">$' + esc(r.price) + ' PRO</span>';
  }

  function cardHTML(r, i) {
    const isSaved = saved.has(r.id);
    const exts = (r.files || [{ ext: r.format }]).map(f => f.ext.toUpperCase().replace('.', '')).join(' · ');
    return (
      '<article class="software-card" data-id="' + esc(r.id) + '" tabindex="0" role="button" aria-label="Inspect ' + esc(r.title) + '" style="animation-delay:' + (i * 50) + 'ms">' +
        '<div class="card-top">' +
          '<h3 class="card-title card-title--row">' + esc(r.title) + '</h3>' +
          '<span class="version-chip mono">' + esc(r.version) + '</span>' +
          '<span class="arrow" aria-hidden="true">→</span>' +
        '</div>' +
        '<p class="card-desc">' + esc(r.desc) + '</p>' +
        '<div class="card-meta">' +
          '<span class="chip"><b>' + full(r.downloads) + '</b> downloads</span>' +
          '<span class="chip">AE ' + esc(r.aeMin) + '+</span>' +
          '<span class="chip">' + esc(exts) + '</span>' +
          priceBadge(r) +
        '</div>' +
        '<div class="card-foot">' +
          '<button class="save-btn' + (isSaved ? ' is-saved' : '') + '" data-save="' + esc(r.id) + '" aria-pressed="' + isSaved + '" aria-label="Save ' + esc(r.title) + '">' + ICON.bookmark + '</button>' +
          '<button class="btn btn-primary" data-inspect>' + ICON.download + 'Inspect &amp; Download</button>' +
        '</div>' +
      '</article>'
    );
  }

  function renderSoftware() {
    const list = currentList();
    softwareGrid.innerHTML = list.map(cardHTML).join('');
    emptyState.hidden = list.length > 0;
    const v = currentView();
    softwareNote.textContent = '· ' + v.title.toLowerCase() + ' · ' + list.length + ' ' + (list.length === 1 ? 'item' : 'items');
  }

  /* Flush 3×3 browse grid. `cats`/`free` filter the list below, `osValue`
     also moves the hero toggle, `href` cells open the server. */
  const BROWSE = [
    { id: 'windows', osValue: 'windows', icon: 'windows', title: 'Windows',
      desc: 'Software, tools, and plugins for Windows editors.' },
    { id: 'macos', osValue: 'macos', icon: 'apple', title: 'MacOS',
      desc: 'Software, tools, and plugins for Mac editors.' },
    { id: 'guide', href: 'beginners', title: 'Beginner’s Guide',
      desc: 'Start here for After Effects setup, plugins, composition settings, and shortcuts.' },
    { id: 'tutorials', href: 'tutorials', title: 'Tutorials',
      desc: 'Video walkthroughs for installs, plugins, setup, and common editor fixes.' },
    { id: 'guides', href: 'guides', title: 'Guides',
      desc: 'Written setup, troubleshooting, activation, plugin, and workflow guides.' },
    { id: 'new', sort: 'newest', title: 'New Drops',
      desc: 'Latest software releases and updates, posted live from Discord.' },
    { id: 'extensions', cats: ['extension', 'script'], title: 'Extensions & Scripts',
      desc: 'Extensions and scripts to push your workflow further.' },
    { id: 'project', cats: ['project'], title: 'Project Files',
      desc: 'Curated index — .aep breakdowns, presets, LUTs, and templates.' },
    { id: 'free', free: true, title: 'Free Assets',
      desc: 'SFX, music, fonts, footage, 3D, icons, converters, and more — all free.' }
  ];

  function cellMeta(b, count) {
    if (filters.view === b.id) return 'showing';
    if (b.href) return 'discord';
    return count + ' ' + (count === 1 ? 'item' : 'items');
  }

  function cellInner(b, count) {
    const icon = b.icon ? '<span class="cell-ico">' + ICON[b.icon] + '</span>' : '';
    const pill = (b.osValue && b.osValue === DETECTED_OS) ? '<span class="browse-pill">detected</span>' : '';
    const arrow = '<span class="cell-arrow" aria-hidden="true">' + (b.href ? '↗' : '→') + '</span>';
    return '<div class="cell-top">' + icon + '<span class="cell-title">' + esc(b.title) + '</span>' + pill + arrow + '</div>' +
      '<p class="cell-desc">' + esc(b.desc) + '</p>' +
      '<p class="cell-meta mono">' + cellMeta(b, count) + '</p>';
  }

  function renderBrowse() {
    browseGrid.innerHTML = BROWSE.map((b) => {
      const cls = 'browse-cell' + (filters.view === b.id ? ' is-active' : '');
      const count = listFor(b).length;
      if (b.href) {
        return '<a class="' + cls + '" href="' + esc(INVITE_URL) +
          '" target="_blank" rel="noopener noreferrer">' + cellInner(b, count) + '</a>';
      }
      return '<button type="button" class="' + cls + '" data-browse="' + esc(b.id) + '">' +
        cellInner(b, count) + '</button>';
    }).join('');
  }

  /* Two-column community banner: Kyro logo plate + gated-access call to action. */
  function renderBanner() {
    const s = window.KYRO_SITE;
    const inviteLink = '<a class="banner-link" href="' + esc(INVITE_URL) +
      '" target="_blank" rel="noopener noreferrer">Join the Kyro Discord ↗</a>';
    let primary, secondary;
    if (auth.state === OUT) {
      primary = '<button type="button" class="btn btn-primary" id="bannerLogin">Login with Discord</button>';
      secondary = inviteLink;
    } else if (auth.state === LOGGED) {
      primary = '<button type="button" class="btn btn-primary" id="bannerRecheck">Refresh Verification</button>';
      secondary = inviteLink;
    } else {
      primary = '<button type="button" class="btn btn-ghost" id="bannerRecheck">Refresh Verification</button>';
      secondary = '<span class="banner-state">Verified member · ' + esc(auth.user.username) + '</span>';
    }

    discordCard.innerHTML =
      '<div class="banner-visual">' +
        '<img class="banner-logo" src="assets/kyro-banner.png" alt="Kyro — est. Nov 2026" />' +
      '</div>' +
      '<div class="banner-body">' +
        '<p class="banner-kicker"><img class="banner-avatar" src="assets/kyro-icon.png" alt="" />' +
          '<i class="presence-dot" aria-hidden="true"></i>' +
          s.online + ' online · ' + s.members + ' members</p>' +
        '<h2 class="banner-title">Verify membership to unlock downloads.</h2>' +
        '<p class="banner-sub">Sign in and join the Kyro Discord to access exclusive tools.</p>' +
        '<div class="banner-actions">' + primary + secondary + '</div>' +
        '<p class="banner-foot"><span>' + esc(s.domain) + '</span><span>' + esc(INVITE_CODE) + '</span></p>' +
      '</div>';

    Preview.gc();

    const bl = $('#bannerLogin');
    if (bl) bl.addEventListener('click', startLogin);
    const br = $('#bannerRecheck');
    if (br) br.addEventListener('click', recheckMembership);
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
    vaultList.innerHTML = items.map(r =>
      '<div class="vault-item" data-id="' + esc(r.id) + '" role="button" tabindex="0">' +
        '<div class="vault-thumb"><canvas></canvas></div>' +
        '<div class="vault-info">' +
          '<div class="v-title">' + esc(r.title) + '</div>' +
          '<div class="v-meta mono"><span>' + esc(r.version) + '</span><span>' + esc((r.files || [{ ext: r.format }])[0].ext).toUpperCase().replace('.', '') + '</span><span>' + (Number(r.price) === 0 ? 'FREE' : '$' + esc(r.price)) + '</span></div>' +
        '</div>' +
        '<button class="vault-remove" data-remove="' + esc(r.id) + '" aria-label="Remove from vault">' + ICON.x + '</button>' +
      '</div>'
    ).join('');
    items.forEach(r => {
      const c = vaultList.querySelector('.vault-item[data-id="' + r.id + '"] canvas');
      if (c) Preview.attach(c, r.preview || 'grid', r.seed || 7);
    });
  }

  function openDrawer() {
    vaultRefresh();
    drawerScrim.hidden = false;
    drawer.classList.add('is-open');
    drawer.setAttribute('aria-hidden', 'false');
  }
  function closeDrawer() {
    releaseFocus(drawer);
    drawer.classList.remove('is-open');
    drawer.setAttribute('aria-hidden', 'true');
    setTimeout(() => { drawerScrim.hidden = true; }, 320);
  }

  /* Focus left inside an aria-hidden container is an accessibility warning. */
  function releaseFocus(el) {
    if (el.contains(document.activeElement)) document.activeElement.blur();
  }

  /* ------------------------------ detail modal -------------------------- */
  let modalId = null;
  let modalTab = 'overview';

  function compatHTML(r) {
    const osLabel = os === 'windows' ? 'Windows' : 'macOS';
    return (
      '<span class="compat"><i class="dot"></i>' + osLabel + ' / ' + (os === 'windows' ? 'macOS' : 'Windows') + '</span>' +
      '<span class="compat"><i class="dot"></i>After Effects ' + esc(r.aeMin) + ' – 2026</span>' +
      '<span class="compat"><i class="dot"></i>' + esc(window.KYRO_CATEGORY_LABEL[r.category] || 'Asset') + '</span>'
    );
  }

  function installBlock(ext, label) {
    const guide = window.KYRO_INSTALL[ext];
    if (!guide) return '';
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
    const files = r.files && r.files.length ? r.files : [{ ext: r.format, label: '' }];
    const blocks = files.map(f => installBlock(f.ext, f.label)).filter(Boolean).join('');
    return blocks || '<p class="m-desc">No install guide on file for this format.</p>';
  }

  function fileRowsHTML(r) {
    const unlocked = auth.state === VERIFIED;
    return (r.files || []).map(f =>
      '<div class="file-row ' + (unlocked ? 'is-unlocked' : 'is-locked') + '">' +
        '<span class="file-ico mono">' + esc(f.ext.replace('.', '').toUpperCase()) + '</span>' +
        '<span class="file-info">' +
          '<span class="file-name">' + esc(f.name) + '</span>' +
          '<span class="file-sub">' + esc(f.label) + '</span>' +
        '</span>' +
        '<span class="file-actions">' +
          '<span class="file-size mono">' + esc(f.size) + '</span>' +
          (unlocked
            ? '<button type="button" class="btn btn-primary btn-sm" data-file="' + esc(f.ext) + '" style="position:relative">' + ICON.download + 'Download<span class="ring"></span></button>'
            : '<button type="button" class="btn btn-ghost btn-sm" data-file="' + esc(f.ext) + '">' + ICON.lock + (auth.state === OUT ? 'Login' : 'Locked') + '</button>') +
        '</span>' +
      '</div>'
    ).join('');
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

  function openModal(id) {
    const r = resources.find(x => x.id === id);
    if (!r) return;
    modalId = id;
    const isSaved = saved.has(id);
    modalBox.innerHTML =
      '<button class="close-x modal-close" aria-label="Close"></button>' +
      '<div class="m-stage"><canvas id="modalCanvas"></canvas>' +
        '<span class="preview-chip mono">LIVE PREVIEW</span>' +
        '<div class="badge-row">' + priceBadge(r) + '<span class="badge badge-format">' + esc((r.files || [{ ext: r.format }])[0].ext).toUpperCase().replace('.', '') + '</span></div>' +
      '</div>' +
      '<div class="m-body">' +
        '<div class="m-title-row"><h2 class="m-title">' + esc(r.title) + '</h2><span class="m-version mono">' + esc(r.version) + '</span></div>' +
        '<p class="m-desc">' + esc(r.desc) + '</p>' +
        '<div class="compat-row">' + compatHTML(r) + '</div>' +
        '<div class="tabs" role="tablist">' +
          '<button class="tab" data-tab="overview" role="tab">Overview</button>' +
          '<button class="tab" data-tab="install" role="tab">Installation Guide</button>' +
          '<button class="tab" data-tab="changelog" role="tab">Changelog</button>' +
        '</div>' +
        '<div class="tab-panel" data-panel="overview">' +
          '<ul class="feature-list">' + (r.features || []).map(f => '<li>' + ICON.check + '<span>' + esc(f) + '</span></li>').join('') + '</ul>' +
          '<div class="tag-row">' + (r.tags || []).map(t => '<span class="tag-chip">#' + esc(t) + '</span>').join('') + '</div>' +
          '<div class="meta-row">' +
            '<span class="dl-count">' + ICON.download + fmt(r.downloads) + ' downloads</span>' +
            '<span>by ' + esc(r.creator) + '</span>' +
            '<span>ADDED ' + esc(r.added) + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="tab-panel" data-panel="install">' + installHTML(r) + '</div>' +
        '<div class="tab-panel" data-panel="changelog"><div class="changelog">' +
          (r.changelog || []).map(c =>
            '<div class="log-entry"><div class="log-head"><span class="log-version">' + esc(c.v) + '</span><span class="log-date mono">' + esc(c.date) + '</span></div>' +
            '<div class="log-body">' + esc(c.notes) + '</div></div>').join('') +
        '</div></div>' +
        '<p class="section-label section-label--tight">Downloads</p>' +
        gateBannerHTML(r) +
        '<div class="file-list">' + fileRowsHTML(r) + '</div>' +
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

    const gl = $('#gateLogin');
    if (gl) gl.addEventListener('click', startLogin);
    const gr = $('#gateRecheck');
    if (gr) gr.addEventListener('click', recheckMembership);

    modalBox.querySelectorAll('[data-file]').forEach(btn =>
      btn.addEventListener('click', () => requestFile(r, btn.dataset.file, btn)));

    syncTabs();
    showOverlay(modalOverlay);
    Preview.pin($('#modalCanvas'), r.preview || 'grid', r.seed || 7);
    modalBox.focus({ preventScroll: true });
  }

  function syncTabs() {
    modalBox.querySelectorAll('.tab').forEach(t => t.classList.toggle('is-active', t.dataset.tab === modalTab));
    modalBox.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('is-active', p.dataset.panel === modalTab));
  }

  function closeModal() {
    Preview.unpin($('#modalCanvas'));
    hideOverlay(modalOverlay);
    modalId = null;
    modalTab = 'overview';
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
        r.downloads += 1;
        write(K_RES, resources);
        t.finish('Download started', file.name + ' · saved to your Downloads folder');
        btn.disabled = false;
        btn.classList.add('is-done');
        btn.innerHTML = ICON.check + 'Unlocked';
        setTimeout(() => { btn.classList.remove('is-done'); btn.innerHTML = original; }, 1900);
        // keep visible counters fresh without a heavy re-render
        const meta = modalBox.querySelector('[data-panel="overview"] .dl-count');
        if (meta) meta.innerHTML = ICON.download + fmt(r.downloads) + ' downloads';
        const chip = softwareGrid.querySelector('.software-card[data-id="' + r.id + '"] .card-meta .chip b');
        if (chip) chip.textContent = full(r.downloads);
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
        '<span class="badge badge-format">V' + esc(r.version) + '</span>' +
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
    if (!$('.overlay:not([hidden])') && !drawer.classList.contains('is-open')) {
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
  softwareGrid.addEventListener('click', (e) => {
    const save = e.target.closest('[data-save]');
    if (save) { toggleSave(save.dataset.save, save); return; }
    const card = e.target.closest('.software-card');
    if (card) openModal(card.dataset.id);
  });
  softwareGrid.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (e.target.closest('button')) return;
    const card = e.target.closest('.software-card');
    if (card) { e.preventDefault(); openModal(card.dataset.id); }
  });

  browseGrid.addEventListener('click', (e) => {
    const cell = e.target.closest('[data-browse]');
    if (!cell) return;
    const b = BROWSE.find(x => x.id === cell.dataset.browse);
    if (!b) return;
    if (filters.view === b.id) {
      filters.view = 'all';
    } else {
      filters.view = b.id;
      if (b.osValue && b.osValue !== os) { os = b.osValue; write(K_OS, os); syncOsButtons(os); }
    }
    renderSoftware();
    renderBrowse();
    document.getElementById('software').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  });

  $('#resetFiltersBtn').addEventListener('click', () => {
    filters.view = 'all';
    renderSoftware();
    renderBrowse();
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

  $('#heroSearch').addEventListener('click', openPalette);
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

  $('#brandLink').addEventListener('click', (e) => {
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
  captureSessionFromUrl();
  syncOsButtons(os);
  renderAuth();
  renderAccess();
  renderSoftware();
  renderBrowse();
  updateSavedUI();

  // Deep links: #r-<asset> opens its modal, #login starts the Discord OAuth redirect.
  const hash = location.hash;
  if (hash.startsWith('#r-')) {
    const id = decodeURIComponent(hash.slice(3));
    if (resources.some(r => r.id === id)) openModal(id);
  } else if (hash === '#login') {
    if (auth.state === OUT) startLogin();
  }
})();
