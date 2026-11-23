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
  /* One invite for the whole site. Links are never rewritten per visitor: the
     Discord join card names whoever created the invite, so swapping in a
     personal code made the site show a random member as the inviter. */
  const DEFAULT_INVITE_URL = 'https://discord.gg/N3KJBSWrkR';
  const INVITE_URL = DEFAULT_INVITE_URL;
  const INVITE_CODE = INVITE_URL.replace(/^https?:\/\//, '');
  const INVITE_SLUG = 'N3KJBSWrkR';

  const REDIRECT_URI = AUTH_WORKER_URL + '/callback';

  /* ------------------------------ storage ------------------------------ */
  const K_RES = 'kyro.resources.v4';
  const K_SAVED = 'kyro.saved.v3';
  const K_AUTH = 'kyro.auth.v1';
  const K_OS = 'kyro.os.v1';
  const K_STATE = 'kyro.oauth.state.v1';
  const K_RETURN = 'kyro.oauth.return.v1';

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

  let hiddenResources = new Set();
  const isHiddenResource = (...values) => values.some(value => value && hiddenResources.has(String(value).toLowerCase()));

  // Merge approved contributor/owner items from cloud. Rebuild the whole list
  // every time so a deletion (including a built-in catalogue entry) is visible
  // immediately instead of waiting for a cache to clear.
  let lastVaultSync = 0;
  async function loadPublicVaultItems() {
    try {
      const res = await fetch(AUTH_WORKER_URL + '/vault/public', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      hiddenResources = new Set((Array.isArray(data.hidden) ? data.hidden : []).map(value => String(value).toLowerCase()));
      const cloudItems = (data.items || []).map(item => {
        let itemSlug = (item.slug || '').toLowerCase();
        if (/^https?:\/\//i.test(itemSlug)) {
          try {
            const u = new URL(itemSlug);
            const parts = u.pathname.split('/').filter(Boolean);
            itemSlug = parts[parts.length - 1] || u.hash.replace(/^#\/?/, '') || u.hostname.replace(/\./g, '-');
          } catch {}
        }
        itemSlug = itemSlug.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || item.id;

        const osList = item.os === 'both' ? ['windows', 'macos'] : [item.os || 'windows'];
        const resourceKind = item.kind === 'software' ? 'software' : item.kind === 'course' ? 'course' : 'tool';

        return {
          id: itemSlug,
          cloud_id: item.id,
          title: item.title,
          desc: item.details || `${item.title} — verified resource on Kyro.`,
          category: item.category || (resourceKind === 'software' ? 'software' : 'extension'),
          kind: resourceKind,
          os: osList,
          version: item.version || '1.0',
          creator: item.creator || item.by_username || 'Contributor',
          releaseAt: item.releaseAt || item.release_at || undefined,
          source_url: item.source_url || '',
          level: item.level || item.skill_level || '',
          duration: item.duration || '',
          language: item.language || '',
          downloads: 0,
          added: item.created ? item.created.slice(0, 10) : '2026-11-14',
          addedTs: item.created ? Date.parse(item.created) || 0 : 0,
          tags: [item.category || 'plugin', ...(osList)],
          gallery: item.image_url ? [item.image_url] : [],
          files: item.download_url ? [{
            ext: 'link',
            name: item.title,
            size: item.size || 'Vault Build',
            label: item.title,
            url: item.download_url,
            pass: item.pass || item.password || undefined
          }] : []
        };
      }).filter(item => !isHiddenResource(item.id, item.cloud_id));

      const seed = window.KYRO_SEED || [];
      const seedIds = new Set(seed.map(r => r.id));
      resources = seed
        .filter(r => !isHiddenResource(r.id, r.slug))
        .map(r => Object.assign({}, r));
      cloudItems.forEach(item => {
        if (seedIds.has(item.id)) return;
        seedIds.add(item.id);
        resources.push(item);
      });

      lastVaultSync = Date.now();
      renderSoftware();
      renderCategoryHead();
      renderBrowse();
      checkUrlDeepLink();
    } catch (e) {
      // Offline fallback
    }
  }
  loadPublicVaultItems();

  /* Uploads land on the worker, not in this file, so a tab left open would keep
     showing the old "Recently added" row. Re-read the public list when the tab
     comes back into view, at most once a minute. */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - lastVaultSync < 60000) return;
    loadPublicVaultItems();
  });

  /* --------------------------- auth state model ------------------------
     out      → not signed in
     logged   → signed in with Discord, not a server member
     verified → signed in AND confirmed server member (downloads unlocked)
     --------------------------------------------------------------------- */
  const OUT = 'out', LOGGED = 'logged', VERIFIED = 'verified';

  let auth = normaliseAuth(read(K_AUTH, null));
  let discordRole = '';
  function normaliseAuth(v) {
    if (!v || (v.state !== LOGGED && v.state !== VERIFIED)) return { state: OUT, user: null, token: '' };
    const user = v.user && v.user.username
      ? { username: v.user.username, id: v.user.id || '', avatar: v.user.avatar || '', initials: v.user.initials || '' }
      : { username: 'editor', id: '', avatar: '', initials: 'E' };
    // Privilege flags are never trusted from storage. Role and is_owner are
    // re-stated by the auth worker on every load (refreshDiscordRole), so a
    // hand-edited localStorage entry cannot render owner UI even for the
    // moment before the server replies.
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

      if (!expected || returned !== expected || !q.get('token')) {
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
      const returnPath = readSession(K_RETURN);
      clearSession(K_RETURN);
      if (returnPath) {
        const destination = new URL(returnPath, location.origin);
        if (destination.origin === location.origin && (destination.pathname.startsWith('/apply') || destination.pathname.startsWith('/feedback'))) {
          location.replace(destination.href);
          return;
        }
      }

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

  /* /courses keeps its own lightweight filters: free-text search plus the
     platforms the catalogue actually declares. Level, duration and language
     only show on courses that carry those fields — nothing is inferred. */
  let courseQuery = '';
  let coursePlatform = 'all';
  function courseMatches(r) {
    if (coursePlatform !== 'all' && (r.os || []).indexOf(coursePlatform) === -1) return false;
    const q = courseQuery.trim().toLowerCase();
    if (!q) return true;
    return [r.title, r.desc, r.category, r.level, r.skill_level, r.duration, r.language,
      (r.tags || []).join(' '), r.creator || ''].join(' ').toLowerCase().indexOf(q) !== -1;
  }

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
  /* Only absolute http(s) URLs may be opened or linked. Blocks javascript:/data:
     even if a bad value ever reaches the client, mirroring the worker's guard. */
  const safeHref = (u) => /^https?:\/\//i.test(String(u == null ? '' : u).trim()) ? String(u).trim() : '';
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
  const coursesGrid = $('#coursesGrid');
  const coursesNote = $('#coursesNote');
  const coursesEmpty = $('#coursesEmpty');
  const browseGrid = $('#browseGrid');
  const recentGrid = $('#recentGrid');
  const applefxRow = $('#applefxRow');
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
  const reqReference = $('#reqReference');
  const reqSimilar = $('#reqSimilar');
  const reqNewRequest = $('#reqNewRequest');
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
    course: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="m10 9 5 3-5 3z" fill="currentColor"/></svg>',
    copy: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2.2"/><path d="M15 5.5H6.2A2.2 2.2 0 0 0 4 7.7V15"/></svg>',
    clock: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3.5 2"/></svg>'
  };

  /* ------------------------- access-state copy -------------------------- */
  const ACCESS = {
    out: {
      cls: 'is-out', icon: ICON.lock,
      text: '<b>Browsing is open to everyone.</b> Downloads unlock with a free Kyro Discord membership — sign in when you are ready to download.',
      prompt: 'Sign in with Discord to unlock downloads. Browsing and previews stay open.'
    },
    logged: {
      cls: 'is-partial', icon: ICON.shield,
      text: '<b>One step left.</b> Join the Kyro Discord, then refresh verification to unlock downloads. Browsing stays open either way.',
      prompt: 'Join the Kyro Discord, then refresh verification. Browsing stays open.'
    },
          verified: {
      cls: 'is-ok', icon: ICON.unlock,
      text: '<b>Membership verified.</b> Download buttons are unlocked for your account.',
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
    window.dispatchEvent(new CustomEvent('kyro:auth'));
    if (auth.state === OUT) {
      authSlot.innerHTML =
        '<button type="button" class="login-btn" id="loginBtn">' + ICON.discord +
        '<span class="lb-text">Login with Discord</span></button>';
      $('#loginBtn').addEventListener('click', startLogin);
      return;
    }
    const verified = auth.state === VERIFIED;
    const userRole = (auth.user && auth.user.role) || (discordRole ? discordRole.toUpperCase() : 'MEMBER');
    authSlot.innerHTML =
      '<button type="button" class="profile-pill" id="profileBtn" aria-haspopup="menu" aria-expanded="false">' +
        '<span class="avatar">' + avatarHTML(auth.user) +
          '<i class="status-dot' + (verified ? ' is-verified' : '') + '" aria-hidden="true"></i></span>' +
        '<span class="profile-name">' + esc(auth.user.username) + '</span>' +
        (userRole ? '<span class="badge badge-free mono profile-role">' + esc(userRole) + '</span>' : '') +
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
    const userRole = (auth.user && auth.user.role) || (discordRole ? discordRole.toUpperCase() : 'MEMBER');
    const menu = document.createElement('div');
    menu.className = 'profile-menu';
    menu.setAttribute('role', 'menu');
    menu.innerHTML =
      '<div class="pm-head"><span class="avatar avatar--lg">' + avatarHTML(auth.user) + '</span>' +
        '<div><div class="pm-name">' + esc(auth.user.username) + '</div>' +
        '<div class="pm-sub">Discord' + (auth.user.id ? ' · id ' + esc(auth.user.id) : '') + '</div></div></div>' +
      '<div class="pm-state ' + (verified ? 'is-ok' : 'is-out') + '">' +
        (verified ? ICON.check + 'Verified server member' : ICON.lock + 'Not in the Kyro server') + '</div>' +
      (verified ? '<div class="pm-role mono">Discord role <span class="badge badge-free">' + esc(userRole) + '</span></div>' : '') +
      '<button type="button" class="pm-item" role="menuitem" data-account-settings>Account Settings</button>' +
      (verified ? '<button type="button" class="pm-item" role="menuitem" data-recheck>Refresh Discord Role</button>' : '') +
      (verified ? '' :
        '<a class="pm-item" role="menuitem" href="' + esc(INVITE_URL) + '" target="_blank" rel="noopener noreferrer">Join server ↗</a>' +
        '<button type="button" class="pm-item" role="menuitem" data-recheck>Refresh Verification</button>') +
      '<button type="button" class="pm-item danger" role="menuitem" data-logout>Logout</button>';
    authSlot.appendChild(menu);
    wireAvatars(menu);
    pill.classList.add('is-open');
    pill.setAttribute('aria-expanded', 'true');
    const acc = menu.querySelector('[data-account-settings]');
    if (acc) acc.addEventListener('click', () => { closeProfileMenu(); openAccountModal(); });
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
    if (document.body.dataset.page === 'apply' || document.body.dataset.page === 'feedback' || document.body.dataset.page === 'incoming') {
      writeSession(K_RETURN, location.pathname + location.search);
    }
    const state = (window.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    writeSession(K_STATE, state);
    location.assign(authorizeUrl(state));
  }

  function logout() {
    discordRole = '';
    reqOwner = false;
    reqAdmin = false;
    reqDeleteId = '';
    auth = { state: OUT, user: null, token: '' };
    saveAuth();
    renderAuth();
    renderAccess();
    if (modalId) openModal(modalId);
    toast({ title: 'Logged out', sub: 'Discord session cleared from this browser.', icon: ICON.x });
  }

  function setDiscordRole(isOwner, customRole) {
    let role = '';
    if (auth.state === VERIFIED) {
      if (customRole) role = customRole.toLowerCase();
      else role = isOwner === true ? 'owner' : 'member';
    }
    if (role !== 'owner') reqOwner = false;
    if (auth.user) auth.user.role = customRole || (isOwner ? 'Owner' : 'Member');
    if (role === discordRole) return;
    discordRole = role;
    const menuOpen = Boolean(authSlot.querySelector('.profile-menu'));
    renderAuth();
    if (menuOpen) toggleProfileMenu($('#profileBtn'));
  }

  async function refreshDiscordRole() {
    const token = auth.token;
    if (!token) return;
    try {
      const res = await fetch(AUTH_WORKER_URL + '/verify', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }), credentials: 'omit'
      });
      const data = await res.json();
      if (auth.token !== token) return;
      if (res.status === 401) { logout(); return; }
      if (!res.ok) throw new Error('Discord role verification failed.');
      const state = data.in_server ? VERIFIED : LOGGED;
      const stateChanged = auth.state !== state;
      auth.state = state;
      if (auth.user) {
        auth.user.role = data.role || (data.is_owner ? 'Owner' : 'Member');
        auth.user.is_owner = Boolean(data.is_owner);
      }
      saveAuth();
      setDiscordRole(data.is_owner, data.role);
      if (stateChanged) renderAuth();
      renderAccess();
    } catch {
      if (auth.token === token) {
        discordRole = '';
        renderAuth();
      }
    }
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
      if (auth.user) {
        auth.user.role = data.role || (data.is_owner ? 'Owner' : 'Member');
        auth.user.is_owner = Boolean(data.is_owner);
      }
      auth = { state: member ? VERIFIED : LOGGED, user: auth.user, token: data.token || auth.token };
      setDiscordRole(data.is_owner, data.role);
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

    if (accessStrip) accessStrip.innerHTML =
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
    /* On the incoming page, signing in or out changes the waitlist gate and the
       owner's early-access controls, so both repaint with the new session. */
    if ($('#earlyAccessSection')) { loadEarlyAccess(); loadIncomingReleases(); }
  }

  /* ========================= directory rendering ======================== */
  /* Millisecond timestamps where the source has one (cloud uploads carry
     `created`), so two listings added the same day still land newest first. */
  function addedStamp(r) {
    const ts = Number(r.addedTs);
    if (ts) return ts;
    const day = Date.parse(String(r.added || '') + 'T00:00:00Z');
    return Number.isFinite(day) ? day : 0;
  }

  function byNewest(a, b) {
    const d = addedStamp(b) - addedStamp(a);
    return d !== 0 ? d : String(b.version || '').localeCompare(String(a.version || ''), undefined, { numeric: true });
  }

  /* Two shelves per OS page: the editor itself under Software, everything that
     runs inside it under Tools. A listing with no kind is a tool, because that
     is what the vault actually hands out today. */
  function kindOf(r) {
    if (r.kind === 'software') return 'software';
    if (r.kind === 'course' || String(r.category || '').trim().toLowerCase() === 'course') return 'course';
    return 'tool';
  }

  function listFor(b, kind) {
    let list = resources.slice();
    if (b.osValue) list = list.filter(r => (r.os || []).indexOf(b.osValue) !== -1);
    if (b.kindValue) list = list.filter(r => kindOf(r) === b.kindValue);
    if (b.cats) list = list.filter(r => b.cats.indexOf(r.category) !== -1);
    if (b.free) list = list.filter(r => r.price === 0);
    if (kind) list = list.filter(r => kindOf(r) === kind);
    if (b.sort === 'newest') list = list.sort(byNewest);

    // Pin AppleFX and SaaSor Plus to the top of the tools list
    const pinnedIds = ['applefx', 'saasor'];
    list.sort((a, b) => {
      const aPin = pinnedIds.indexOf(a.id);
      const bPin = pinnedIds.indexOf(b.id);
      if (aPin !== -1 && bPin !== -1) return aPin - bPin;
      if (aPin !== -1) return -1;
      if (bPin !== -1) return 1;
      return 0;
    });

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

  function userIsOwner() {
    // Owner status is decided by the auth worker, never by the browser.
    // Role strings, user ids and localStorage can all be edited from DevTools,
    // so the only trusted source is the server-verified is_owner flag that
    // /verify rewrites on every session refresh.
    return auth.state === VERIFIED && Boolean(auth.user && auth.user.is_owner === true);
  }

  function platformLabel(r) {
    return (r.os || []).map(o => o === 'windows' ? 'Windows' : o === 'macos' ? 'macOS' : o).join(' & ');
  }

  function fileSize(r) {
    const f = (r.files || []).find(x => x && x.size);
    return (f && f.size) || r.size || '';
  }

  function hostLabel(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
  }

  function cardHTML(r, i) {
    const isSaved = saved.has(r.id);
    const locked = isLocked(r);
    const isOwner = userIsOwner();
    const course = kindOf(r) === 'course';
    const exts = (r.files || [{ ext: r.format }]).map(f => String(f.ext || '').toUpperCase().replace('.', '')).filter(Boolean).join(' · ');
    const version = !course && r.version ? '<span class="version-chip mono">' + esc(r.version) + '</span>' : '';
    const ae = !course && r.aeMin ? '<span class="chip">AE ' + esc(r.aeMin) + '+</span>' : '';
    const platform = !course && platformLabel(r) ? '<span class="chip">' + esc(platformLabel(r)) + '</span>' : '';
    const size = !course && fileSize(r) ? '<span class="chip">' + esc(fileSize(r)) + '</span>' : '';
    const sourceName = r.creator || r.credits || (r.source_url ? hostLabel(r.source_url) : '');
    const source = sourceName
      ? '<span class="chip">' + (course ? 'By ' : '') + esc(sourceName) + '</span>'
      : '';
    const courseFacts = course
      ? [r.level || r.skill_level, r.duration, r.language, r.category].filter(Boolean)
          .map(v => '<span class="chip">' + esc(v) + '</span>').join('')
      : '';
    const shot = (r.gallery || []).filter(Boolean)[0];
    const thumb = shot ? '<div class="card-thumb"><img src="' + esc(shot) + '" alt="" loading="lazy" decoding="async" /></div>' : '';
    const ownerTools = isOwner ? `
      <div class="card-owner-tools" style="display:inline-flex;gap:4px;margin-left:auto;">
        <button type="button" class="btn btn-ghost btn-sm" data-card-edit="${esc(r.id)}" title="Edit Resource" style="padding:2px 8px;font-size:0.75rem;height:24px;">Edit</button>
        <button type="button" class="btn btn-danger btn-sm" data-card-delete="${esc(r.id)}" title="Delete Resource" style="padding:2px 8px;font-size:0.75rem;height:24px;">Delete</button>
      </div>
    ` : '';
    return (
      '<article class="software-card" data-id="' + esc(r.id) + '" tabindex="0" role="button" aria-label="Inspect ' + esc(r.title) + '" style="animation-delay:' + (i * 50) + 'ms">' +
        thumb +
        '<div class="card-top">' +
          '<h3 class="card-title card-title--row">' + esc(r.title) + '</h3>' +
          version +
          ownerTools +
          '<span class="arrow" aria-hidden="true">→</span>' +
        '</div>' +
        '<p class="card-desc" title="' + esc(r.desc) + '">' + esc(r.desc) + '</p>' +
        '<div class="card-meta">' +
          (course ? '' : '<span class="chip"><b>' + full(downloadCount(r)) + '</b> ' + (downloadCount(r) === 1 ? 'download' : 'downloads') + '</span>') +
          ae +
          platform +
          size +
          source +
          courseFacts +
          (!course && exts ? '<span class="chip">' + esc(exts) + '</span>' : '') +
          (locked ? '<span class="chip chip-soon mono">' + ICON.clock + 'COMING SOON</span>' : '') +
          priceBadge(r) +
        '</div>' +
        '<div class="card-foot">' +
          '<button class="save-btn' + (isSaved ? ' is-saved' : '') + '" data-save="' + esc(r.id) + '" aria-pressed="' + isSaved + '" aria-label="Save ' + esc(r.title) + '">' + ICON.bookmark + '</button>' +
          '<button class="btn btn-primary" data-inspect>' + (locked ? ICON.clock + 'Coming Soon' : course ? ICON.course + 'Open course' : ICON.download + 'Inspect &amp; Download') + '</button>' +
        '</div>' +
      '</article>'
    );
  }

  /* One shelf: rendered only where its own grid exists, which is the two OS
     pages. The vault page has no lists at all, so both calls just return. */
  /* Some cloud preview URLs expire. Drop a broken thumbnail rather than
     leaving a broken-image icon on the card — no invented artwork. */
  function wireCardThumbs(grid) {
    grid.querySelectorAll('.card-thumb img').forEach(img => {
      const drop = () => { const box = img.closest('.card-thumb'); if (box) box.remove(); };
      img.addEventListener('error', drop);
      if (img.complete && img.naturalWidth === 0) drop();
    });
  }

  function renderSection(grid, note, empty, b, kind) {
    if (!grid) return;
    let list = listFor(b, kind);
    if (kind === 'course') list = list.filter(courseMatches);
    grid.innerHTML = list.map(cardHTML).join('');
    wireCardThumbs(grid);
    if (note) {
      note.textContent = '· ' + (list.length ? list.length + (list.length === 1 ? ' item' : ' items') : 'coming soon');
    }
    if (empty) empty.hidden = list.length > 0;
  }

  function renderSoftware() {
    const b = currentView();
    renderSection(softwareGrid, softwareNote, softwareEmpty, b, 'software');
    renderSection(toolsGrid, toolsNote, toolsEmpty, b, 'tool');
    renderSection(coursesGrid, coursesNote, coursesEmpty, b, 'course');
    /* Home page: three real listings, newest first, with their own previews.
       AppleFX is skipped here because the row underneath is its permanent slot. */
    if (recentGrid) {
      recentGrid.innerHTML = resources
        .filter(r => !/^applefx\b/i.test(String(r.title || '')))
        .sort(byNewest).slice(0, 3).map(cardHTML).join('');
      wireCardThumbs(recentGrid);
    }
    renderApplefxRow();
  }

  /* One thin full-width row under Recently added for AppleFX, built from the
     newest AppleFX listing on the vault so a re-upload updates its version and
     text without a code change. Deliberately compact — it sits below the newest
     listings, not in front of them. */
  function renderApplefxRow() {
    if (!applefxRow) return;
    const r = resources.filter(x => /^applefx\b/i.test(String(x.title || ''))).sort(byNewest)[0];
    if (!r) { applefxRow.hidden = true; applefxRow.removeAttribute('data-resource'); return; }
    applefxRow.hidden = false;
    applefxRow.dataset.resource = r.id;
    /* Prefer a picture the site ships itself. A cloud listing's gallery points at
       a Discord CDN link that expires, which would leave this row blank for
       everyone arriving later. */
    const localShots = resources
      .filter(x => /^applefx\b/i.test(String(x.title || '')))
      .flatMap(x => (x.gallery || []).filter(Boolean))
      .filter(src => !/^https?:/i.test(String(src)));
    const shot = localShots[0] || '/assets/applefx-panel.webp';
    applefxRow.innerHTML =
      '<span class="applefx-thumb">' + (shot
        ? '<img src="' + esc(shot) + '" alt="" loading="lazy" decoding="async" />'
        : ICON.apple) + '</span>' +
      '<span class="applefx-copy">' +
        '<span class="applefx-title">' + esc(r.title) + '</span>' +
        '<span class="applefx-sub">' + esc(r.desc) + '</span>' +
      '</span>' +
      '<span class="applefx-cta">View' + ICON.arrow + '</span>';
    /* A cloud picture can expire; the row falls back to the Apple mark rather
       than showing a broken image. */
    const img = applefxRow.querySelector('.applefx-thumb img');
    if (img) img.addEventListener('error', () => { img.replaceWith(document.createRange().createContextualFragment(ICON.apple)); }, { once: true });
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

  /* Flush browse grid. Four cells, four pages, clean paths like keyfla.me:
     /windows and /macos list the software, /courses the video courses and
     /guide is the written start-here. */
  const BROWSE = [
    { id: 'windows', osValue: 'windows', icon: 'windows', page: '/windows', title: 'Windows',
      desc: 'Software, tools, and plugins for Windows editors.' },
    { id: 'macos', osValue: 'macos', icon: 'apple', page: '/macos', title: 'macOS',
      desc: 'Software, tools, and plugins for Mac editors.' },
    { id: 'courses', page: '/courses', icon: 'course', title: 'Courses', kindValue: 'course',
      desc: 'Guided video courses that take you from first cut to pro editor.' },
    { id: 'guide', page: '/guide', noCount: true, title: 'Beginner\'s Guide',
      desc: 'Start here for After Effects setup, plugins, composition settings, and shortcuts.' }
  ];

  function categoryHref(b) {
    return b.page;
  }

  function wireCourseFilters() {
    const input = $('#courseSearch');
    const chips = $('#courseFilters');
    if (!input && !chips) return;
    if (input) input.addEventListener('input', () => {
      courseQuery = input.value;
      renderSoftware();
    });
    if (chips) chips.addEventListener('click', e => {
      const chip = e.target.closest('[data-course-os]');
      if (!chip) return;
      coursePlatform = chip.dataset.courseOs;
      chips.querySelectorAll('[data-course-os]').forEach(c => {
        const on = c === chip;
        c.classList.toggle('is-current', on);
        c.setAttribute('aria-pressed', String(on));
      });
      renderSoftware();
    });
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

  /* ---------------------- Incoming Releases (Community Approval) ---------- */
  let incomingReleases = [];

  async function loadIncomingReleases() {
    const grid = $('#incomingGrid');
    const empty = $('#incomingEmpty');
    const countNote = $('#incomingCountNote');
    if (!grid) return;

    try {
      const headers = { Accept: 'application/json' };
      if (auth.token) headers.Authorization = 'Bearer ' + auth.token;
      const res = await fetch(AUTH_WORKER_URL + '/vault/incoming', {
        headers,
        credentials: 'omit'
      });
      if (!res.ok) return;
      const data = await res.json();
      incomingReleases = Array.isArray(data.incoming) ? data.incoming : [];

      if (countNote) {
        countNote.textContent = '· ' + (incomingReleases.length ? `${incomingReleases.length} ${incomingReleases.length === 1 ? 'release' : 'releases'}` : '0 releases');
      }

      if (!incomingReleases.length) {
        grid.innerHTML = '';
        if (empty) empty.hidden = false;
        return;
      }
      if (empty) empty.hidden = true;

      const isOwner = userIsOwner();

      grid.innerHTML = incomingReleases.map(item => {
        const votes = Number(item.votes || 0);
        const limit = Number(item.vote_limit || 5);
        const pct = Math.min(100, Math.max(0, Math.round((votes / limit) * 100)));
        const isReleased = Boolean(item.released || votes >= limit);
        const userVote = Number(item.userVote || 0);
        const earlyAccess = Boolean(item.early_access) && !isReleased;
        const earlyLocked = Boolean(item.early_locked) && !isReleased;

        const statusBadge = isReleased
          ? '<span class="badge badge-free mono" style="font-size:0.75rem;padding:2px 8px;">Just Dropped</span>'
          : earlyAccess
            ? '<span class="badge mono" style="font-size:0.75rem;padding:2px 8px;background:rgba(245,158,11,0.15);color:#f59e0b;border:1px solid rgba(245,158,11,0.4);">Early Access</span>'
            : '<span class="badge badge-pro mono" style="font-size:0.75rem;padding:2px 8px;">Voting In Progress</span>' +
              (isOwner && earlyLocked ? ' <span class="badge mono" title="Early-access passes do not unlock this build" style="font-size:0.72rem;padding:2px 8px;background:rgba(239,68,68,0.12);color:#fca5a5;border:1px solid rgba(239,68,68,0.35);">EA held back</span>' : '');

        const thumb = item.image_url
          ? `<img src="${esc(item.image_url)}" alt="${esc(item.title)}" loading="lazy" decoding="async" style="width:100%;height:140px;object-fit:cover;border-radius:8px 8px 0 0;" />`
          : `<img src="/assets/incoming-preview.png" alt="${esc(item.title)} — coming to the Vault" loading="lazy" decoding="async" style="width:100%;height:140px;object-fit:cover;border-radius:8px 8px 0 0;" />`;

        return `
          <div class="software-card" data-incoming-id="${esc(item.id)}" style="display:flex;flex-direction:column;border-radius:10px;overflow:hidden;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);transition:transform 0.2s, border-color 0.2s;">
            ${thumb}
            <div style="padding:14px;display:flex;flex-direction:column;flex:1;gap:8px;">
              <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:6px;">
                <div>
                  <h4 style="color:#fff;font-size:1.05rem;font-weight:700;margin:0 0 2px 0;">${esc(item.title)}</h4>
                  <div style="color:var(--dim);font-size:0.75rem;">Platform: <span style="color:#38bdf8;">${esc(item.os)}</span> · By: <strong>${esc(item.by_username || 'Staff')}</strong></div>
                </div>
                ${statusBadge}
              </div>

              <p style="color:#cbd5e1;font-size:0.83rem;margin:4px 0 8px 0;line-height:1.4;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;">
                ${esc(item.details || 'Community approval build. Vote to bring this tool live to the Vault!')}
              </p>

              <!-- Community Approval Vote Progress Bar -->
              <div style="margin-top:auto;background:rgba(0,0,0,0.35);padding:10px;border-radius:8px;border:1px solid rgba(255,255,255,0.05);">
                <div style="display:flex;justify-content:space-between;align-items:center;font-size:0.78rem;margin-bottom:6px;">
                  <span style="color:var(--dim);font-weight:600;">Community Goal:</span>
                  <strong style="color:${isReleased ? '#10b981' : '#38bdf8'};font-family:inherit;">
                    ${votes} / ${limit} votes (${pct}%)
                  </strong>
                </div>
                <div style="height:6px;width:100%;background:rgba(255,255,255,0.08);border-radius:999px;overflow:hidden;">
                  <div style="height:100%;width:${pct}%;background:${isReleased ? 'linear-gradient(90deg, #10b981, #34d399)' : 'linear-gradient(90deg, #38bdf8, #818cf8)'};border-radius:999px;transition:width 0.4s ease;"></div>
                </div>
              </div>

              ${earlyAccess && item.pass ? `
                <div class="mono" style="font-size:0.75rem;color:#f59e0b;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.25);border-radius:6px;padding:6px 8px;">Archive password: <strong>${esc(item.pass)}</strong></div>
              ` : ''}

              <!-- Community Vote Actions -->
              <div style="display:flex;gap:8px;align-items:center;margin-top:4px;">
                ${isReleased ? `
                  <a href="#${esc(item.slug)}" class="btn btn-primary btn-sm" style="flex:1;justify-content:center;text-decoration:none;">
                    Now Live · Get Resource ↗
                  </a>
                ` : earlyAccess && safeHref(item.download_url) ? `
                  <a href="${esc(safeHref(item.download_url))}" target="_blank" rel="noopener noreferrer" class="btn btn-primary btn-sm" style="flex:1;justify-content:center;text-decoration:none;background:linear-gradient(90deg,#f59e0b,#fbbf24);border-color:#f59e0b;color:#1a1205;">
                    Early Access · Download ↗
                  </a>
                ` : `
                  <button type="button" class="btn btn-sm ${userVote === 1 ? 'btn-primary' : 'btn-ghost'}" data-vote-action="1" data-id="${esc(item.id)}" style="flex:1;justify-content:center;font-size:0.8rem;gap:4px;">
                    Speed It Up (+1)
                  </button>
                  <button type="button" class="btn btn-sm ${userVote === -1 ? 'btn-danger' : 'btn-ghost'}" data-vote-action="-1" data-id="${esc(item.id)}" style="flex:1;justify-content:center;font-size:0.8rem;gap:4px;">
                    Hold Off (-1)
                  </button>
                `}
                ${isOwner ? `
                  ${!isReleased ? `
                    <button type="button" class="btn btn-primary btn-sm" data-incoming-release="${esc(item.id)}" title="Release this item to the Vault right now" style="padding:4px 10px;background:linear-gradient(90deg,#10b981,#34d399);border-color:#10b981;color:#06251a;">
                      ⚡ Release Now
                    </button>
                  ` : ''}
                  <button type="button" class="btn btn-ghost btn-sm" data-incoming-edit="${esc(item.id)}" title="Edit votes, goal and details" style="padding:4px 8px;color:#38bdf8;">
                    ✎
                  </button>
                  <button type="button" class="btn btn-ghost btn-sm" data-incoming-delete="${esc(item.id)}" title="Delete incoming item" style="padding:4px 8px;color:#ef4444;">
                    ✕
                  </button>
                ` : ''}
              </div>
            </div>
          </div>
        `;
      }).join('');

      // Wire Vote Buttons
      grid.querySelectorAll('[data-vote-action]').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (auth.state === OUT) {
            toast({ title: 'Sign In Required', sub: 'Sign in with Discord to vote on releases.', icon: ICON.lock });
            return;
          }
          const id = btn.dataset.id;
          const delta = parseInt(btn.dataset.voteAction, 10);
          btn.disabled = true;
          try {
            const res = await fetch(AUTH_WORKER_URL + '/vault/incoming/vote', {
              method: 'POST',
              headers: { 'content-type': 'application/json', authorization: 'Bearer ' + auth.token },
              body: JSON.stringify({ id, delta }),
              credentials: 'omit'
            });
            const data = await res.json();
            if (res.ok) {
              toast({
                title: delta > 0 ? 'Vote Recorded!' : 'Feedback Noted',
                sub: data.released ? 'Community goal reached! Item is now live!' : `Current votes: ${data.votes}`,
                icon: ICON.check
              });
              loadIncomingReleases();
              if (data.released) loadPublicVaultItems();
            } else {
              toast({ title: 'Vote failed', sub: data.error || 'Server error', icon: ICON.x });
            }
          } catch (err) {
            toast({ title: 'Error', sub: err.message, icon: ICON.x });
          } finally {
            btn.disabled = false;
          }
        });
      });

      // Wire Owner Edit for incoming (votes, goal, copy, links)
      if (isOwner) {
        grid.querySelectorAll('[data-incoming-edit]').forEach(btn => {
          btn.addEventListener('click', () => openIncomingEditor(btn.dataset.incomingEdit));
        });
        // Release directly: skips the community vote and pushes it to the Vault.
        grid.querySelectorAll('[data-incoming-release]').forEach(btn => {
          btn.addEventListener('click', async () => {
            const id = btn.dataset.incomingRelease;
            const item = incomingReleases.find(r => r.id === id);
            if (!item || !confirm(`Release "${item.title}" to the Vault right now, skipping the vote?`)) return;
            btn.disabled = true;
            try {
              const res = await fetch(AUTH_WORKER_URL + '/vault/incoming', {
                method: 'PATCH',
                headers: { 'content-type': 'application/json', authorization: 'Bearer ' + auth.token },
                body: JSON.stringify({ id, released: true }),
                credentials: 'omit'
              });
              const data = await res.json().catch(() => ({}));
              if (res.ok && data.item && data.item.released) {
                toast({ title: 'Released to the Vault', sub: `"${item.title}" is now live.`, icon: ICON.check });
                loadIncomingReleases();
                loadPublicVaultItems();
              } else {
                toast({ title: 'Release failed', sub: data.error || 'Server error', icon: ICON.x });
                btn.disabled = false;
              }
            } catch (err) {
              toast({ title: 'Error', sub: err.message, icon: ICON.x });
              btn.disabled = false;
            }
          });
        });
      }

      // Wire Owner Delete for incoming
      if (isOwner) {
        grid.querySelectorAll('[data-incoming-delete]').forEach(btn => {
          btn.addEventListener('click', async () => {
            if (!confirm('Are you sure you want to delete this incoming release?')) return;
            const id = btn.dataset.incomingDelete;
            btn.disabled = true;
            try {
              const res = await fetch(AUTH_WORKER_URL + '/vault/incoming', {
                method: 'DELETE',
                headers: { 'content-type': 'application/json', authorization: 'Bearer ' + auth.token },
                body: JSON.stringify({ id }),
                credentials: 'omit'
              });
              const data = await res.json().catch(() => ({}));
              if (res.ok && data.deleted) {
                toast({ title: 'Incoming item removed', sub: 'Removed from the website and the Discord announcement.', icon: ICON.check });
                loadIncomingReleases();
              } else if (res.ok) {
                toast({ title: 'Nothing to delete', sub: 'That incoming item was already gone.', icon: ICON.check });
                loadIncomingReleases();
              } else {
                toast({ title: 'Delete failed', sub: data.error || 'Server error', icon: ICON.x });
              }
            } catch (err) {
              toast({ title: 'Error', sub: err.message, icon: ICON.x });
            }
          });
        });
      }
    } catch (e) {
      console.warn('Failed to load incoming releases:', e);
    }
  }

  /* Owner editor for an incoming card. Votes are absolute, so the owner can
     set a believable number even when the server has only a handful of members. */
  function openIncomingEditor(id) {
    const item = incomingReleases.find(release => release.id === id);
    if (!item) return;

    const overlay = document.createElement('div');
    overlay.className = 'overlay overlay-top';
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-label="Edit incoming release" style="padding:22px;width:min(680px,100%);">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:16px;">
          <div>
            <p class="section-label" style="margin-bottom:4px;">Owner tools</p>
            <h3 style="margin:0;font-size:1.2rem;">Edit incoming release</h3>
          </div>
          <button type="button" class="btn btn-ghost btn-sm" data-inc-close aria-label="Close" style="padding:4px 9px;">✕</button>
        </div>

        <div style="display:grid;gap:12px;">
          <label class="field">
            <span class="field-label">Title</span>
            <input class="field-input" id="incEditTitle" maxlength="120" value="${esc(item.title || '')}" />
          </label>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
            <label class="field">
              <span class="field-label">Votes shown</span>
              <input class="field-input" id="incEditVotes" type="number" min="0" max="1000000000" step="1" value="${Number(item.votes || 0)}" />
            </label>
            <label class="field">
              <span class="field-label">Vote goal</span>
              <input class="field-input" id="incEditLimit" type="number" min="1" max="1000000000" step="1" value="${Number(item.vote_limit || 5)}" />
            </label>
          </div>
          <p style="margin:-4px 0 0;color:var(--dim);font-size:0.78rem;">Votes are an absolute number. Set this to whatever the card should display.</p>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
            <label class="field">
              <span class="field-label">Platform</span>
              <select class="field-input" id="incEditOs">
                <option value="windows"${item.os === 'windows' ? ' selected' : ''}>Windows</option>
                <option value="macos"${item.os === 'macos' ? ' selected' : ''}>macOS</option>
                <option value="both"${item.os === 'both' ? ' selected' : ''}>Windows &amp; macOS</option>
              </select>
            </label>
            <label class="field">
              <span class="field-label">Category</span>
              <input class="field-input" id="incEditCategory" maxlength="60" value="${esc(item.category || '')}" />
            </label>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
            <label class="field">
              <span class="field-label">Size</span>
              <input class="field-input" id="incEditSize" maxlength="40" value="${esc(item.size || '')}" />
            </label>
            <label class="field">
              <span class="field-label">Creator</span>
              <input class="field-input" id="incEditCreator" maxlength="60" value="${esc(item.creator || item.by_username || '')}" />
            </label>
          </div>

          <label class="field">
            <span class="field-label">Preview image URL</span>
            <input class="field-input" id="incEditImage" placeholder="https://…" value="${esc(item.image_url || '')}" />
          </label>
          <div style="display:flex;align-items:center;gap:10px;margin-top:-8px;flex-wrap:wrap;">
            <label class="btn btn-ghost btn-sm" style="cursor:pointer;display:inline-flex;">
              Upload a picture instead
              <input type="file" id="incEditImageFile" accept="image/*" style="display:none;" />
            </label>
            <span style="color:var(--dim);font-size:0.78rem;" id="incEditImageStatus">The uploaded picture replaces the Kyro banner on the card.</span>
          </div>
          <label class="field">
            <span class="field-label">Download URL</span>
            <input class="field-input" id="incEditDownload" placeholder="https://…" value="${esc(item.download_url || '')}" />
          </label>
          <label class="field">
            <span class="field-label">Archive password</span>
            <input class="field-input" id="incEditPassword" maxlength="60" value="${esc(item.pass || '')}" />
          </label>
          <label class="field">
            <span class="field-label">Description / notes</span>
            <textarea class="field-input" id="incEditDetails" rows="4" maxlength="1500">${esc(item.details || '')}</textarea>
          </label>
        </div>

        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:18px;">
          <button type="button" class="btn btn-ghost btn-sm" data-inc-close>Cancel</button>
          <button type="button" class="btn btn-primary btn-sm" id="incEditSave">Save changes</button>
        </div>
      </div>`;

    const close = () => overlay.remove();
    overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
    overlay.querySelectorAll('[data-inc-close]').forEach(button => button.addEventListener('click', close));
    const onKey = event => { if (event.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);

    // Owners can drop the real screenshot straight into an existing card — no
    // CDN URL hunting, and no chance of saving a card that still shows the banner.
    const imageFile = overlay.querySelector('#incEditImageFile');
    const imageField = overlay.querySelector('#incEditImage');
    const imageStatus = overlay.querySelector('#incEditImageStatus');
    if (imageFile) imageFile.addEventListener('change', async () => {
      const file = imageFile.files && imageFile.files[0];
      if (!file) return;
      if (!file.type.startsWith('image/')) {
        toast({ title: 'Not an image', sub: 'Pick a PNG, JPG, GIF or WebP picture.', icon: ICON.x });
        return;
      }
      if (file.size > 8 * 1024 * 1024) {
        toast({ title: 'Image too large', sub: 'Pictures must be under 8 MB.', icon: ICON.x });
        return;
      }
      if (imageStatus) imageStatus.textContent = 'Uploading…';
      try {
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error('Could not read that file.'));
          reader.readAsDataURL(file);
        });
        const res = await fetch(AUTH_WORKER_URL + '/vault/upload-image', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + auth.token },
          body: JSON.stringify({ image: dataUrl, filename: file.name || 'screenshot.png' }),
          credentials: 'omit'
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.url) {
          if (imageStatus) imageStatus.textContent = 'Upload failed — try a smaller picture or paste a direct image URL.';
          toast({ title: 'Image upload failed', sub: data.error || 'The image could not be stored.', icon: ICON.x });
          return;
        }
        imageField.value = data.url;
        if (imageStatus) imageStatus.textContent = 'Uploaded ✓ — press Save changes to put it on the card.';
        toast({ title: 'Image uploaded', sub: 'Save changes to replace the Kyro banner.', icon: ICON.check });
      } catch (err) {
        if (imageStatus) imageStatus.textContent = 'Upload failed — try again.';
        toast({ title: 'Image upload failed', sub: err.message || 'Network error while storing the image.', icon: ICON.x });
      }
    });

    const save = overlay.querySelector('#incEditSave');
    save.addEventListener('click', async () => {
      const payload = {
        id: item.id,
        title: overlay.querySelector('#incEditTitle').value.trim(),
        votes: Math.max(0, parseInt(overlay.querySelector('#incEditVotes').value, 10) || 0),
        vote_limit: Math.max(1, parseInt(overlay.querySelector('#incEditLimit').value, 10) || 1),
        os: overlay.querySelector('#incEditOs').value,
        category: overlay.querySelector('#incEditCategory').value.trim(),
        size: overlay.querySelector('#incEditSize').value.trim(),
        creator: overlay.querySelector('#incEditCreator').value.trim(),
        image_url: overlay.querySelector('#incEditImage').value.trim(),
        download_url: overlay.querySelector('#incEditDownload').value.trim(),
        password: overlay.querySelector('#incEditPassword').value.trim(),
        details: overlay.querySelector('#incEditDetails').value.trim()
      };
      save.disabled = true;
      try {
        const res = await fetch(AUTH_WORKER_URL + '/vault/incoming', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + auth.token },
          body: JSON.stringify(payload),
          credentials: 'omit'
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast({ title: 'Update failed', sub: data.error || 'Server error', icon: ICON.x });
          return;
        }
        close();
        toast({
          title: 'Incoming release updated',
          sub: data.item?.released ? 'Goal reached — published to the Vault!' : `Now showing ${payload.votes} / ${payload.vote_limit} votes.`,
          icon: ICON.check
        });
        await loadIncomingReleases();
        if (data.item?.released) loadPublicVaultItems();
      } catch (err) {
        toast({ title: 'Error', sub: err.message, icon: ICON.x });
      } finally {
        save.disabled = false;
      }
    });
  }


  /* ---------------------- Early Access (owner-managed) -------------------- */
  async function loadEarlyAccess() {
    const section = $('#earlyAccessSection');
    if (!section) return;
    if (auth.state !== VERIFIED) { section.innerHTML = ''; return; }
    let data;
    try {
      const res = await fetch(AUTH_WORKER_URL + '/early-access', { headers: reqHeaders(), credentials: 'omit' });
      if (!res.ok) { section.innerHTML = ''; return; }
      data = await res.json();
    } catch { section.innerHTML = ''; return; }

    const bolt = '<span style="display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:9px;background:rgba(245,158,11,0.18);border:1px solid rgba(245,158,11,0.4);color:#f59e0b;flex-shrink:0;"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12z"/></svg></span>';

    if (data.is_owner) {
      const users = Array.isArray(data.users) ? data.users : [];
      const releases = Array.isArray(data.releases) ? data.releases : [];
      const excluded = new Set((Array.isArray(data.excluded) ? data.excluded : []).map(value => String(value).toLowerCase()));
      const isBlocked = release => excluded.has(String(release.id || '').toLowerCase()) || excluded.has(String(release.slug || '').toLowerCase());
      const excludeRows = releases.length
        ? releases.map(r => '<label style="display:flex;align-items:center;gap:9px;padding:7px 10px;background:rgba(0,0,0,0.25);border:1px solid rgba(255,255,255,0.06);border-radius:8px;cursor:pointer;font-size:0.82rem;color:#e2e8f0;">' +
            '<input type="checkbox" data-ea-exclude="' + esc(r.id) + '"' + (isBlocked(r) ? ' checked' : '') + ' style="width:15px;height:15px;cursor:pointer;" />' +
            '<span style="flex:1;">' + esc(r.title || r.id) +
              (r.released ? ' <span class="mono" style="color:var(--dim);font-size:0.72rem;">· already live</span>' : '') +
            '</span></label>').join('')
        : '<p class="mono" style="color:var(--dim);font-size:0.8rem;margin:4px 0;">No incoming releases yet.</p>';
      const rows = users.length
        ? users.map(u => '<li style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;background:rgba(0,0,0,0.25);border:1px solid rgba(255,255,255,0.06);border-radius:8px;">' +
            '<span class="mono" style="font-size:0.82rem;color:#e2e8f0;">' + esc(u.username || u.id) + ' <span style="color:var(--dim);">· ' + esc(u.id) + '</span></span>' +
            '<button type="button" class="btn btn-ghost btn-sm" data-ea-revoke="' + esc(u.id) + '" style="padding:3px 9px;color:#ef4444;">Revoke</button>' +
          '</li>').join('')
        : '<li class="mono" style="color:var(--dim);font-size:0.82rem;padding:6px 2px;">No members have early access yet.</li>';
      section.innerHTML =
        '<div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:16px;">' +
          '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">' +
            '<span class="badge mono" style="background:rgba(245,158,11,0.15);color:#f59e0b;border:1px solid rgba(245,158,11,0.4);font-size:0.7rem;padding:2px 8px;">OWNER</span>' +
            '<h3 style="margin:0;color:#fff;font-size:1rem;font-weight:700;">Early Access</h3>' +
          '</div>' +
          '<p style="color:var(--dim);font-size:0.82rem;margin:0 0 12px;">Grant members a pass to skip the incoming waitlist and download builds directly, before the community vote goal is reached.</p>' +
          '<form id="eaGrantForm" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;">' +
            '<input type="text" id="eaUserId" class="input input-sm" placeholder="Discord user ID (17–20 digits)" inputmode="numeric" autocomplete="off" style="flex:1;min-width:200px;" />' +
            '<input type="text" id="eaUserName" class="input input-sm" placeholder="Label (optional)" autocomplete="off" style="flex:1;min-width:140px;" />' +
            '<button type="submit" class="btn btn-primary btn-sm" id="eaGrantBtn">Grant Access</button>' +
          '</form>' +
          '<ul style="list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px;">' + rows + '</ul>' +
          '<div style="margin-top:14px;border-top:1px solid rgba(255,255,255,0.08);padding-top:12px;">' +
            '<strong style="color:#fff;font-size:0.86rem;display:block;margin-bottom:3px;">Releases early access must not unlock</strong>' +
            '<p style="color:var(--dim);font-size:0.78rem;margin:0 0 8px;">A pass skips the waitlist for everything except the builds you tick here — those stay behind the community vote goal. Only the Owner can change this.</p>' +
            '<div style="display:flex;flex-direction:column;gap:6px;max-height:210px;overflow-y:auto;">' + excludeRows + '</div>' +
            '<div class="mono" id="eaExcludeStatus" style="color:var(--dim);font-size:0.76rem;margin-top:6px;"></div>' +
          '</div>' +
        '</div>';
      const form = $('#eaGrantForm');
      if (form) form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const id = ($('#eaUserId')?.value || '').trim();
        const username = ($('#eaUserName')?.value || '').trim();
        if (!/^\d{17,20}$/.test(id)) { toast({ title: 'Invalid user ID', sub: 'Enter a Discord user ID (17–20 digits).', icon: ICON.x }); return; }
        const btn = $('#eaGrantBtn'); if (btn) { btn.disabled = true; btn.textContent = 'Granting…'; }
        try {
          const res = await fetch(AUTH_WORKER_URL + '/early-access', { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, reqHeaders()), credentials: 'omit', body: JSON.stringify({ id, username }) });
          const out = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(out.error || 'Server error');
          toast({ title: 'Early access granted', sub: (username || id) + ' can skip the waitlist.', icon: ICON.check });
          loadEarlyAccess();
        } catch (err) { toast({ title: 'Grant failed', sub: err.message, icon: ICON.x }); }
        finally { if (btn) { btn.disabled = false; btn.textContent = 'Grant Access'; } }
      });
      section.querySelectorAll('[data-ea-exclude]').forEach(box => box.addEventListener('change', async () => {
        const ids = [...section.querySelectorAll('[data-ea-exclude]')].filter(input => input.checked).map(input => input.dataset.eaExclude);
        const status = $('#eaExcludeStatus');
        if (status) status.textContent = 'Saving…';
        try {
          const res = await fetch(AUTH_WORKER_URL + '/early-access', { method: 'PATCH', headers: Object.assign({ 'content-type': 'application/json' }, reqHeaders()), credentials: 'omit', body: JSON.stringify({ excluded: ids }) });
          const out = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(out.error || 'Server error');
          if (status) status.textContent = ids.length ? 'Saved — ' + ids.length + ' release' + (ids.length === 1 ? '' : 's') + ' held back from early access.' : 'Saved — early access covers every release again.';
          toast({ title: ids.length ? 'Early access restricted' : 'Early access restriction cleared', sub: ids.length ? 'Only the releases you left unticked unlock before the vote goal.' : 'Pass holders skip the waitlist again.', icon: ICON.check });
          loadIncomingReleases();
        } catch (err) {
          box.checked = !box.checked;
          if (status) status.textContent = 'Could not save: ' + err.message;
          toast({ title: 'Could not save restriction', sub: err.message, icon: ICON.x });
        }
      }));
      section.querySelectorAll('[data-ea-revoke]').forEach(btn => btn.addEventListener('click', async () => {
        const id = btn.dataset.eaRevoke;
        btn.disabled = true;
        try {
          const res = await fetch(AUTH_WORKER_URL + '/early-access', { method: 'DELETE', headers: Object.assign({ 'content-type': 'application/json' }, reqHeaders()), credentials: 'omit', body: JSON.stringify({ id }) });
          const out = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(out.error || 'Server error');
          toast({ title: 'Early access revoked', sub: id + ' is back on the waitlist.', icon: ICON.check });
          loadEarlyAccess();
          loadIncomingReleases();
        } catch (err) { toast({ title: 'Revoke failed', sub: err.message, icon: ICON.x }); btn.disabled = false; }
      }));
      return;
    }

    if (data.earlyAccess) {
      section.innerHTML =
        '<div style="display:flex;align-items:center;gap:12px;background:linear-gradient(90deg,rgba(245,158,11,0.12),rgba(251,191,36,0.04));border:1px solid rgba(245,158,11,0.35);border-radius:12px;padding:14px 16px;">' +
          bolt +
          '<div><strong style="color:#f59e0b;font-size:0.92rem;">You have Early Access</strong>' +
          '<p style="margin:2px 0 0;color:#cbd5e1;font-size:0.82rem;">Skip the waitlist — incoming builds below show a direct download link just for you.</p></div>' +
        '</div>';
    } else {
      section.innerHTML = '';
    }
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
    if (!discordCard) return;
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
        ? '<img class="vault-shot" src="' + esc(r.gallery[0]) + '" alt="" loading="lazy" decoding="async" />'
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
      const anyOpen = [drawer, requestsDrawer, $('#feedbackDrawer')].some(el => el && el.classList.contains('is-open'));
      if (!anyOpen) drawerScrim.hidden = true;
    }, 320);
  }

  const REQ_STATUS_LABEL = {
    open: 'OPEN', planned: 'PLANNED', in_progress: 'IN PROGRESS', shipped: 'SHIPPED'
  };
  const REQ_STATUS_CLASS = {
    open: 'badge', planned: 'badge badge-pro', in_progress: 'badge badge-pro', shipped: 'badge badge-free'
  };
  const REQ_CATEGORY_OPTIONS = [
    ['extension', 'Extension'], ['script', 'Script'], ['preset', 'Preset'],
    ['project', 'Project'], ['soundfx', 'Sound FX'], ['other', 'Other']
  ];

  let requests = [];
  let reqError = '';
  let reqBusy = false;
  let reqCategory = 'extension';
  let reqOs = DETECTED_OS || 'both';
  let reqVersions = new Set(['any']);
  let reqSort = 'top';
  let reqFilter = 'all';
  let reqComposeOpen = false;
  let reqLoaded = false;
  let reqAdmin = false;
  let reqOwner = false;
  let reqDeleteId = '';

  function reqHeaders() {
    const h = { Accept: 'application/json' };
    /* A header, not a query string: tokens in URLs end up in access logs. */
    if (auth.token) h.Authorization = 'Bearer ' + auth.token;
    return h;
  }

  async function loadRequests() {
    const token = auth.token;
    try {
      const res = await fetch(AUTH_WORKER_URL + '/requests', { headers: reqHeaders(), credentials: 'omit' });
      const data = await res.json().catch(() => ({}));
      if (auth.token !== token) return;
      if (!res.ok) throw new Error('requests responded ' + res.status + (data.error ? ': ' + data.error : ''));
      requests = Array.isArray(data.requests) ? data.requests : [];
      reqAdmin = Boolean(data.is_admin);
      reqOwner = data.is_owner === true;
      if (auth.token) setDiscordRole(data.is_owner);
      reqLoaded = true;
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
        if (data.code === 'duplicate_request' || data.code === 'not_the_owner' || data.code === 'not_an_admin') await loadRequests();
        toast({
          title: 'Request not changed',
          sub: data.error || 'The requests board responded ' + res.status + '.',
          icon: ICON.x, warn: true, ttl: 6500
        });
        return null;
      }
      if (Array.isArray(data.requests)) requests = data.requests;
      reqAdmin = Boolean(data.is_admin);
      reqOwner = data.is_owner === true;
      if (auth.token) setDiscordRole(data.is_owner);
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

  function referenceURL(value) {
    try {
      const url = new URL(value);
      return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
    } catch { return ''; }
  }

  function requestCardHTML(r) {
    const voted = Boolean(r.you_voted);
    const status = REQ_STATUS_LABEL[r.status] || REQ_STATUS_LABEL.open;
    const day = String(r.created || '').slice(0, 10);
    const reference = referenceURL(r.reference);
    const versions = Array.isArray(r.ae_versions) ? r.ae_versions : [];
    const admin = reqAdmin && auth.state === VERIFIED;
    return '<article class="req-item' + (voted ? ' is-voted' : '') + '" data-request-id="' + esc(r.id) + '">' +
        '<button type="button" class="vote-btn mono" data-vote="' + esc(r.id) + '" aria-pressed="' + voted + '"' +
          (reqBusy ? ' disabled' : '') + ' aria-label="' + (voted ? 'Remove your vote from ' : 'Upvote ') + esc(r.title) + '">' +
          '<span class="vote-caret" aria-hidden="true">' + (voted ? '▲' : '△') + '</span>' +
          '<span class="vote-num">' + (Number(r.votes) || 0) + '</span>' +
        '</button>' +
        '<div class="req-main">' +
          '<p class="req-title">' + esc(r.title) + '</p>' +
          (r.desc ? '<p class="req-desc">' + esc(r.desc) + '</p>' : '') +
          (reference ? '<a class="req-reference mono" href="' + esc(reference) + '" target="_blank" rel="noopener noreferrer">REFERENCE ↗</a>' : '') +
          '<p class="req-meta">' +
            '<span class="' + (REQ_STATUS_CLASS[r.status] || 'badge') + '">' + status + '</span>' +
            (r.starter ? '<span class="req-cat mono">STARTER IDEA</span>' : '') +
            (r.author_name ? '<span class="req-cat mono">' + esc(r.author_name) + '</span>' : '') +
            (r.author_role === 'owner' ? '<span class="badge badge-free mono" title="Discord server owner at submission">OWNER</span>' : '') +
            (r.priority ? '<span class="badge badge-pro mono" title="Submitted through the EasyKyro extension">⚡ PRIORITY</span>' : '') +
            '<span class="req-cat mono">' + esc((window.KYRO_CATEGORY_LABEL[r.category] || 'Other').toUpperCase()) + '</span>' +
            (r.os ? '<span class="req-cat mono">' + esc(r.os.toUpperCase()) + '</span>' : '') +
            (versions.length ? '<span class="req-cat mono">AE ' + esc(versions.join(' / ').toUpperCase()) + '</span>' : '') +
            (day ? '<span class="req-day mono">' + esc(day) + '</span>' : '') +
          '</p>' +
          (admin ? '<select class="field-input req-status-select mono" data-req-status="' + esc(r.id) + '" aria-label="Status for ' + esc(r.title) + '"' + (reqBusy ? ' disabled' : '') + '>' +
            Object.entries(REQ_STATUS_LABEL).map(([value, label]) => '<option value="' + value + '"' + (r.status === value ? ' selected' : '') + '>' + label + '</option>').join('') + '</select>' : '') +
          (reqOwner && auth.state === VERIFIED ? '<div class="req-delete-actions">' +
            (reqDeleteId === r.id ? '<span class="req-desc">Delete this request and all its votes?</span><button type="button" class="btn btn-danger btn-sm" data-req-delete="' + esc(r.id) + '"' + (reqBusy ? ' disabled' : '') + '>Confirm Delete</button><button type="button" class="btn btn-ghost btn-sm" data-req-delete-cancel' + (reqBusy ? ' disabled' : '') + '>Cancel</button>' :
              '<button type="button" class="btn btn-ghost btn-sm" data-req-delete="' + esc(r.id) + '"' + (reqBusy ? ' disabled' : '') + '>Delete Request</button>') + '</div>' : '') +
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
      reqCategories.querySelectorAll('[data-cat]').forEach(chip => chip.setAttribute('aria-pressed', String(chip === btn)));
    }));
  }

  function syncReqFields() {
    requestsDrawer.querySelectorAll('[data-req-os]').forEach(btn => btn.setAttribute('aria-pressed', String(btn.dataset.reqOs === reqOs)));
    requestsDrawer.querySelectorAll('[data-req-ae]').forEach(btn => btn.setAttribute('aria-pressed', String(reqVersions.has(btn.dataset.reqAe))));
  }

  function renderSimilarRequest() {
    const query = reqTitle.value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const words = query.split(' ').filter(word => word.length > 2);
    const matches = query.length < 3 ? [] : requests.map(row => {
      const title = row.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
      const titleWords = new Set(title.split(' '));
      const overlap = words.filter(word => titleWords.has(word)).length;
      const score = title === query ? 2 : words.length >= 2 && overlap >= 2 ? overlap / words.length : 0;
      return { row, score };
    }).filter(match => match.score >= 0.6).sort((a, b) => b.score - a.score || b.row.votes - a.row.votes);
    const match = matches[0] && matches[0].row;
    reqSimilar.hidden = !match;
    reqSimilar.innerHTML = match ? '<span>Similar request exists: <b>' + esc(match.title) + '</b> — ' + (Number(match.votes) || 0) + ' votes</span>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-similar-vote="' + esc(match.id) + '"' + (reqBusy || match.you_voted ? ' disabled' : '') + '>' + (match.you_voted ? 'Upvoted' : 'Upvote') + '</button>' : '';
    const button = reqSimilar.querySelector('[data-similar-vote]');
    if (button) button.addEventListener('click', () => voteRequest(button.dataset.similarVote));
  }

  function renderRequests() {
    if (!requestList) return;
    const verified = auth.state === VERIFIED;
    const expanded = verified && reqComposeOpen;
    requestCompose.classList.toggle('is-open', expanded);
    requestCompose.inert = !expanded;
    reqNewRequest.setAttribute('aria-expanded', String(reqComposeOpen));
    reqNewRequest.textContent = reqComposeOpen ? '− Close Form' : '+ New Request';
    requestGate.hidden = verified || !reqComposeOpen;
    if (!requestGate.hidden) requestGate.innerHTML = reqGateHTML();
          requestCount.textContent = reqError ? 'Requests unavailable right now' : !reqLoaded ? 'Loading requests…' : requests.length + (requests.length === 1 ? ' request' : ' requests') + (verified && !reqAdmin ? ' · yours' : '');

    let rows = requests.filter(row => (reqFilter === 'all' || row.category === reqFilter) && (reqSort !== 'added' || row.status === 'shipped'));
    rows.sort(reqSort === 'top' ? (a, b) => Number(Boolean(b.priority)) - Number(Boolean(a.priority)) || b.votes - a.votes || String(b.created).localeCompare(String(a.created)) : (a, b) => String(b.created).localeCompare(String(a.created)));
    requestList.innerHTML = reqError ? '<p class="req-empty">' + esc(reqError) + '</p>' : !reqLoaded ? '<p class="req-empty">Loading the board…</p>' : rows.length ? rows.map(requestCardHTML).join('') :
      '<p class="req-empty">' + (reqSort === 'added' ? 'No shipped requests yet.' : requests.length ? 'No requests match this category.' : (verified && !reqAdmin ? 'You have not posted any requests yet. Use + New Request to add one.' : 'Nothing on the board yet. Post the first request.')) + '</p>';
    requestList.querySelectorAll('[data-vote]').forEach(btn => btn.addEventListener('click', () => voteRequest(btn.dataset.vote)));
    requestList.querySelectorAll('[data-req-status]').forEach(select => select.addEventListener('change', () => {
      reqWrite('/requests/status', { token: auth.token, id: select.dataset.reqStatus, status: select.value });
    }));
    requestList.querySelectorAll('[data-req-delete]').forEach(btn => btn.addEventListener('click', () => {
      const id = btn.dataset.reqDelete;
      if (reqDeleteId !== id) { reqDeleteId = id; renderRequests(); return; }
      reqWrite('/requests/delete', { id }).then(data => {
        if (!data) return;
        reqDeleteId = '';
        renderRequests();
        toast({ title: 'Request deleted', sub: 'Removed from the board with its votes.', icon: ICON.check });
      });
    }));
    requestList.querySelectorAll('[data-req-delete-cancel]').forEach(btn => btn.addEventListener('click', () => { reqDeleteId = ''; renderRequests(); }));
    requestsDrawer.querySelectorAll('[data-req-sort]').forEach(btn => btn.setAttribute('aria-pressed', String(btn.dataset.reqSort === reqSort)));
    requestsDrawer.querySelectorAll('[data-req-filter]').forEach(btn => btn.setAttribute('aria-pressed', String(btn.dataset.reqFilter === reqFilter)));
    const rl = $('#reqLogin');
    if (rl) rl.addEventListener('click', startLogin);
    const rr = $('#reqRecheck');
    if (rr) rr.addEventListener('click', recheckMembership);
    reqSubmit.disabled = reqBusy || !reqLoaded || Boolean(reqError);
    reqSubmit.textContent = reqBusy ? 'Saving…' : 'Submit Request';
    syncReqFields();
    renderSimilarRequest();
  }

  function voteRequest(id) {
    if (reqBusy) return;
    reqWrite('/requests/vote', { token: auth.token, id });
  }

  function submitRequest(event) {
    event.preventDefault();
    const title = reqTitle.value.trim();
    const rawReference = reqReference.value.trim();
    const reference = rawReference ? referenceURL(rawReference) : '';
    if (title.length < 3 || (rawReference && !reference)) {
      (title.length < 3 ? reqTitle : reqReference).focus();
      toast({ title: 'Check the form', sub: title.length < 3 ? 'The title needs at least 3 characters.' : 'Use an HTTP or HTTPS product/demo link without login details.', icon: ICON.x, warn: true });
      return;
    }
    reqWrite('/requests', {
      token: auth.token, title, category: reqCategory, os: reqOs,
      ae_versions: Array.from(reqVersions), reference, desc: reqDesc.value.trim()
    }).then((data) => {
      if (!data) return;
      reqTitle.value = '';
      reqReference.value = '';
      reqDesc.value = '';
      reqCategory = 'extension';
      reqOs = DETECTED_OS || 'both';
      reqVersions = new Set(['any']);
      reqComposeOpen = false;
      reqSort = 'newest';
      reqFilter = 'all';
      renderReqCategories();
      renderRequests();
      reqNewRequest.focus({ preventScroll: true });
      toast({ title: 'Request posted', sub: data.notification === 'queued' ? 'Saved to the board. Discord notification queued.' : 'Saved to the board. Discord notification is unavailable.', icon: ICON.check });
    });
  }

  function wireRequestControls() {
    if (!requestsDrawer) return;
    $('#reqForm').addEventListener('submit', submitRequest);
    reqTitle.addEventListener('input', renderSimilarRequest);
    reqNewRequest.addEventListener('click', () => {
      reqComposeOpen = !reqComposeOpen;
      renderRequests();
      if (reqComposeOpen && auth.state === VERIFIED) reqTitle.focus({ preventScroll: true });
    });
    requestsDrawer.querySelectorAll('[data-req-os]').forEach(btn => btn.addEventListener('click', () => { reqOs = btn.dataset.reqOs; syncReqFields(); }));
    requestsDrawer.querySelectorAll('[data-req-ae]').forEach(btn => btn.addEventListener('click', () => {
      const version = btn.dataset.reqAe;
      if (version === 'any') reqVersions = new Set(['any']);
      else {
        reqVersions.delete('any');
        if (reqVersions.has(version)) reqVersions.delete(version); else reqVersions.add(version);
        if (!reqVersions.size) reqVersions.add('any');
      }
      syncReqFields();
    }));
    requestsDrawer.querySelectorAll('[data-req-sort]').forEach(btn => btn.addEventListener('click', () => { reqSort = btn.dataset.reqSort; renderRequests(); }));
    requestsDrawer.querySelectorAll('[data-req-filter]').forEach(btn => btn.addEventListener('click', () => { reqFilter = btn.dataset.reqFilter; renderRequests(); }));
    syncReqFields();
  }

  function openRequests() {
    if (!requestsDrawer) return;
    if (drawer.classList.contains('is-open')) hide(drawer);
    reqComposeOpen = false;
    reqAdmin = false;
    reqOwner = false;
    reqDeleteId = '';
    renderRequests();
    openScrim();
    requestsDrawer.classList.add('is-open');
    requestsDrawer.setAttribute('aria-hidden', 'false');
    loadRequests();
    const focusTo = reqNewRequest;
    if (focusTo) focusTo.focus({ preventScroll: true });
  }
  function closeRequests() {
    if (!requestsDrawer) return;
    hide(requestsDrawer);
    closeScrim();
  }

  /* ------------------------------ feedback drawer ------------------------
     The board is public to verified members: everyone reads every review,
     answers it, and may edit or delete their own (admins: anyone's). A review
     may carry one screenshot, shrunk in the browser before it is sent.
     ---------------------------------------------------------------------- */
  const feedbackDrawer = $('#feedbackDrawer');
  const feedbackCompose = $('#feedbackCompose');
  const feedbackGate = $('#feedbackGate');
  const feedbackList = $('#feedbackList');
  const feedbackCount = $('#feedbackCount');
  const feedbackNewBtn = $('#feedbackNewBtn');
  const feedbackForm = $('#feedbackForm');
  const feedbackText = $('#feedbackText');
  const feedbackImprovements = $('#feedbackImprovements');
  const feedbackAnonymous = $('#feedbackAnonymous');

  let feedbackRating = 5;
  let feedbackEditRating = 5;
  let feedbackItems = [];
  let feedbackLoading = false;
  let feedbackComposeOpen = false;
  let feedbackAdmin = false;
  let feedbackEditingId = '';
  let feedbackReplyOpenId = '';
  let feedbackImageData = '';

  function setFeedbackRating(val) {
    feedbackRating = Math.max(1, Math.min(5, Number(val) || 5));
    if (!feedbackDrawer) return;
    feedbackDrawer.querySelectorAll('#feedbackRatingGroup [data-rating]').forEach(btn => {
      btn.setAttribute('aria-pressed', String(Number(btn.dataset.rating) === feedbackRating));
    });
  }

  /* ------------------------- screenshot attachment ---------------------- */
  function ensureFeedbackImageField() {
    if (!feedbackForm || feedbackForm.querySelector('#feedbackImage')) return;
    const wrap = document.createElement('div');
    wrap.className = 'field fb-attach-field';
    wrap.innerHTML =
      '<span class="field-label mono">Attach a screenshot (optional)</span>' +
      '<label class="fb-attach">' +
        '<input type="file" id="feedbackImage" accept="image/png,image/jpeg,image/gif,image/webp" hidden />' +
        '<span class="fb-attach-btn">+ Add image</span>' +
        '<span class="fb-attach-note" id="feedbackImageNote">PNG, JPG, GIF or WebP · up to 8 MB</span>' +
      '</label>' +
      '<div class="fb-attach-preview" id="feedbackImagePreview" hidden></div>';
    const submit = feedbackForm.querySelector('#feedbackSubmit');
    if (submit) feedbackForm.insertBefore(wrap, submit);
    else feedbackForm.appendChild(wrap);

    const picker = wrap.querySelector('#feedbackImage');
    picker.addEventListener('change', async () => {
      const file = picker.files && picker.files[0];
      if (!file) return;
      const note = document.getElementById('feedbackImageNote');
      if (note) note.textContent = 'Preparing…';
      try {
        feedbackImageData = await shrinkImage(file);
        renderFeedbackImagePreview();
      } catch (err) {
        feedbackImageData = '';
        renderFeedbackImagePreview();
        toast({ title: 'Image not added', sub: err.message, icon: ICON.x, warn: true });
      } finally {
        if (note) note.textContent = 'PNG, JPG, GIF or WebP · up to 8 MB';
        picker.value = '';
      }
    });
  }

  function renderFeedbackImagePreview() {
    const box = document.getElementById('feedbackImagePreview');
    if (!box) return;
    if (!feedbackImageData) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    box.innerHTML = '<img src="' + feedbackImageData + '" alt="Screenshot attached to this review" />' +
      '<button type="button" class="fb-attach-remove" id="feedbackImageRemove">Remove image</button>';
    const remove = document.getElementById('feedbackImageRemove');
    if (remove) remove.addEventListener('click', () => { feedbackImageData = ''; renderFeedbackImagePreview(); });
  }

  /* Screenshots are downscaled and re-encoded so a 6 MB PNG does not become an
     8 MB request body. Anything unreadable falls back to the original bytes. */
  function shrinkImage(file, maxEdge = 1600, quality = 0.82) {
    return new Promise((resolve, reject) => {
      if (!file.type || !/^image\//.test(file.type)) { reject(new Error('Pick a PNG, JPG, GIF or WebP picture.')); return; }
      if (file.size > 8 * 1024 * 1024) { reject(new Error('Pictures must be 8 MB or smaller.')); return; }
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Could not read that file.'));
      reader.onload = () => {
        const dataUrl = String(reader.result || '');
        if (!/^data:image\/(png|jpeg|gif|webp)/i.test(dataUrl)) { resolve(dataUrl); return; }
        const img = new Image();
        img.onerror = () => resolve(dataUrl);
        img.onload = () => {
          const longest = Math.max(img.width || 0, img.height || 0);
          const scale = longest > maxEdge ? maxEdge / longest : 1;
          if (scale === 1 && dataUrl.length < 900000) { resolve(dataUrl); return; }
          try {
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round((img.width || maxEdge) * scale));
            canvas.height = Math.max(1, Math.round((img.height || maxEdge) * scale));
            canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL('image/jpeg', quality));
          } catch { resolve(dataUrl); }
        };
        img.src = dataUrl;
      };
      reader.readAsDataURL(file);
    });
  }

  /* ------------------------------ rendering ----------------------------- */
  function feedbackStars(n) {
    const value = Math.max(0, Math.min(5, Number(n) || 0));
    return '★'.repeat(value) + '☆'.repeat(5 - value);
  }

  function feedbackWhen(iso) {
    const t = Date.parse(iso || '');
    if (isNaN(t)) return '';
    return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function feedbackCardHTML(item) {
    const editing = feedbackEditingId === item.id;
    const replying = feedbackReplyOpenId === item.id;
    const canEdit = item.mine || feedbackAdmin;
    const avatar = item.anonymous || !item.author_avatar
      ? '<span class="fb-avatar" aria-hidden="true">?</span>'
      : '<img class="fb-avatar" src="' + esc(item.author_avatar) + '" alt="" width="32" height="32" />';
    const name = item.anonymous ? 'Anonymous Editor' : esc(item.author_name);
    const shot = item.image_url
      ? '<a class="fb-shot" href="' + esc(item.image_url) + '" target="_blank" rel="noopener noreferrer">' +
        '<img src="' + esc(item.image_url) + '" alt="Screenshot attached to this review" loading="lazy" decoding="async" /></a>'
      : '';
    const improv = item.improvements
      ? '<div class="fb-improvements"><span class="mono">Requested improvements</span>' + esc(item.improvements) + '</div>'
      : '';
    const edited = item.updated ? '<span class="fb-edited mono">edited</span>' : '';
    const body = editing
      ? '<div class="fb-edit">' +
          '<div class="cat-row" role="radiogroup" aria-label="Edit rating">' +
            [5, 4, 3, 2, 1].map(n => '<button type="button" class="cat-chip mono" data-fb-rate="' + n + '" aria-pressed="' + (n === feedbackEditRating) + '">' + feedbackStars(n) + '</button>').join('') +
          '</div>' +
          '<textarea class="field-input" data-fb-text rows="3" maxlength="1000" aria-label="Your review">' + esc(item.feedback) + '</textarea>' +
          '<textarea class="field-input" data-fb-improvements rows="2" maxlength="1000" aria-label="Requested improvements">' + esc(item.improvements || '') + '</textarea>' +
          '<p class="fb-edit-note mono">Markdown is not parsed — plain text is fine.</p>' +
          '<div class="fb-edit-actions">' +
            '<button type="button" class="btn btn-primary btn-sm" data-fb-save="' + esc(item.id) + '">Save changes</button>' +
            '<button type="button" class="btn btn-ghost btn-sm" data-fb-cancel="1">Cancel</button>' +
          '</div>' +
        '</div>'
      : '<p class="fb-text">' + esc(item.feedback) + '</p>' + improv + shot;

    const replies = item.replies.length
      ? '<div class="fb-replies">' + item.replies.map(reply =>
          '<div class="fb-reply">' +
            '<div class="fb-reply-head"><span class="fb-reply-name mono">' + esc(reply.author_name) + '</span>' +
            '<span class="fb-reply-date mono">' + esc(feedbackWhen(reply.created)) + '</span></div>' +
            '<p class="fb-reply-text">' + esc(reply.text) + '</p>' +
          '</div>').join('') + '</div>'
      : '';

    const replyForm = replying
      ? '<form class="fb-reply-form" data-fb-reply-form="' + esc(item.id) + '">' +
          '<input class="field-input" name="text" maxlength="500" autocomplete="off" placeholder="Reply to ' + (item.anonymous ? 'this review' : esc(item.author_name)) + '…" />' +
          '<button type="submit" class="btn btn-primary btn-sm">Post reply</button>' +
        '</form>'
      : '';

    const actions = editing ? '' :
      '<div class="fb-actions">' +
        '<button type="button" class="fb-action" data-fb-reply="' + esc(item.id) + '">' +
          (replying ? 'Close' : 'Reply' + (item.replies.length ? ' · ' + item.replies.length : '')) + '</button>' +
        (canEdit
          ? '<button type="button" class="fb-action" data-fb-edit="' + esc(item.id) + '">Edit</button>' +
            '<button type="button" class="fb-action fb-action--danger" data-fb-delete="' + esc(item.id) + '">Delete</button>'
          : '') +
      '</div>';

    return '<article class="req-card fb-card" data-feedback-id="' + esc(item.id) + '">' +
      '<div class="fb-head">' +
        '<div class="fb-who">' + avatar +
          '<span class="fb-name mono">' + name + '</span>' +
          (item.mine ? '<span class="fb-you mono">you</span>' : '') +
        '</div>' +
        '<span class="fb-stars mono" aria-label="' + Number(item.rating) + ' out of 5">' + feedbackStars(item.rating) + '</span>' +
      '</div>' +
      body + replies + replyForm + actions +
      '<div class="fb-foot mono">' + esc(feedbackWhen(item.created)) + edited + '</div>' +
    '</article>';
  }

  function renderFeedback() {
    if (!feedbackDrawer) return;
    feedbackCount.textContent = feedbackLoading
      ? 'Loading feedback…'
      : (feedbackItems.length + (feedbackItems.length === 1 ? ' review' : ' reviews') + ' · community board');
    if (feedbackNewBtn) {
      feedbackNewBtn.setAttribute('aria-expanded', String(feedbackComposeOpen));
      feedbackNewBtn.textContent = feedbackComposeOpen ? 'Cancel' : '+ Give Feedback';
    }
    if (feedbackCompose) {
      feedbackCompose.inert = !feedbackComposeOpen;
      feedbackCompose.classList.toggle('is-open', feedbackComposeOpen);
    }

    const verified = auth.state === VERIFIED;
    if (!verified) {
      feedbackGate.hidden = false;
      feedbackGate.innerHTML =
        '<div class="req-gate-card">' +
          '<div class="req-gate-title">Discord verification required</div>' +
          '<div class="req-gate-sub">Sign in with Discord to read the community board and share your own review.</div>' +
          '<button type="button" class="btn btn-discord btn-sm mono" id="feedbackGateLogin">' +
            ICON.discord + ' Sign in with Discord' +
          '</button>' +
        '</div>';
      const gateBtn = $('#feedbackGateLogin');
      if (gateBtn) gateBtn.addEventListener('click', startLogin);
      feedbackList.innerHTML = '';
      return;
    }

    feedbackGate.hidden = true;
    feedbackGate.innerHTML = '';

    if (feedbackLoading) {
      feedbackList.innerHTML = '<div class="req-empty mono">Loading feedback…</div>';
      return;
    }

    if (!feedbackItems.length) {
      feedbackList.innerHTML = '<div class="req-empty mono">No reviews yet — use + Give Feedback to be the first.</div>';
      return;
    }

    feedbackList.innerHTML = feedbackItems.map(feedbackCardHTML).join('');
  }

  async function loadFeedback() {
    if (auth.state !== VERIFIED) {
      feedbackLoading = false;
      renderFeedback();
      return;
    }
    feedbackLoading = true;
    renderFeedback();
    try {
      const headers = { 'Accept': 'application/json' };
      if (auth.token) headers['Authorization'] = 'Bearer ' + auth.token;
      const res = await fetch(AUTH_WORKER_URL + '/feedback', { headers, credentials: 'omit' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load feedback');
      feedbackItems = Array.isArray(data.feedback) ? data.feedback : [];
      feedbackAdmin = Boolean(data.is_admin);
    } catch (err) {
      toast({ title: 'Could not load feedback', sub: err.message, icon: ICON.x });
      feedbackItems = [];
    } finally {
      feedbackLoading = false;
      renderFeedback();
    }
  }

  async function submitFeedback(e) {
    e.preventDefault();
    if (auth.state !== VERIFIED) {
      toast({ title: 'Sign in required', sub: 'Log in with Discord first.', icon: ICON.lock });
      return;
    }
    const text = feedbackText.value.trim();
    if (text.length < 5) {
      toast({ title: 'Feedback too short', sub: 'Write at least 5 characters.', icon: ICON.x });
      return;
    }
    const improv = feedbackImprovements.value.trim();
    const anon = feedbackAnonymous.checked;
    const submitBtn = $('#feedbackSubmit');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Posting…'; }

    try {
      const headers = { 'Content-Type': 'application/json' };
      if (auth.token) headers['Authorization'] = 'Bearer ' + auth.token;
      const res = await fetch(AUTH_WORKER_URL + '/feedback', {
        method: 'POST',
        headers,
        credentials: 'omit',
        body: JSON.stringify({
          rating: feedbackRating,
          feedback: text,
          improvements: improv,
          anonymous: anon,
          image: feedbackImageData || undefined
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to submit feedback');
      feedbackItems = Array.isArray(data.feedback) ? data.feedback : feedbackItems;
      feedbackAdmin = Boolean(data.is_admin);
      feedbackForm.reset();
      feedbackImageData = '';
      renderFeedbackImagePreview();
      setFeedbackRating(5);
      feedbackComposeOpen = false;
      renderFeedback();
      toast({ title: 'Thank you!', sub: 'Your feedback has been posted.', icon: ICON.check });
    } catch (err) {
      toast({ title: 'Could not post feedback', sub: err.message, icon: ICON.x });
    } finally {
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Post Feedback'; }
    }
  }

  /* One delegated click handler covers every card, including cards painted
     after an edit, a reply or a delete — nothing is rebound per render. */
  async function onFeedbackListClick(e) {
    const rate = e.target.closest('[data-fb-rate]');
    if (rate) {
      feedbackEditRating = Math.max(1, Math.min(5, Number(rate.dataset.fbRate) || 5));
      const group = rate.parentNode;
      if (group) group.querySelectorAll('[data-fb-rate]').forEach(b => b.setAttribute('aria-pressed', String(b === rate)));
      return;
    }
    const replyBtn = e.target.closest('[data-fb-reply]');
    if (replyBtn) {
      const id = replyBtn.dataset.fbReply;
      feedbackReplyOpenId = feedbackReplyOpenId === id ? '' : id;
      feedbackEditingId = '';
      renderFeedback();
      const field = feedbackList.querySelector('[data-fb-reply-form="' + id + '"] input');
      if (field) field.focus();
      return;
    }
    const editBtn = e.target.closest('[data-fb-edit]');
    if (editBtn) {
      const item = feedbackItems.find(x => x.id === editBtn.dataset.fbEdit);
      feedbackEditRating = item ? Number(item.rating) || 5 : 5;
      feedbackEditingId = editBtn.dataset.fbEdit;
      feedbackReplyOpenId = '';
      renderFeedback();
      return;
    }
    if (e.target.closest('[data-fb-cancel]')) {
      feedbackEditingId = '';
      renderFeedback();
      return;
    }
    const saveBtn = e.target.closest('[data-fb-save]');
    if (saveBtn) { await saveFeedbackEntry(saveBtn.dataset.fbSave); return; }
    const delBtn = e.target.closest('[data-fb-delete]');
    if (delBtn) { await deleteFeedbackEntry(delBtn.dataset.fbDelete); }
  }

  async function saveFeedbackEntry(id) {
    const card = feedbackList.querySelector('[data-feedback-id="' + id + '"]');
    if (!card) return;
    const text = card.querySelector('[data-fb-text]');
    const improv = card.querySelector('[data-fb-improvements]');
    const btn = card.querySelector('[data-fb-save]');
    if (!text) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      const res = await fetch(AUTH_WORKER_URL + '/feedback', {
        method: 'PATCH',
        headers: Object.assign({ 'content-type': 'application/json' }, reqHeaders()),
        credentials: 'omit',
        body: JSON.stringify({
          id,
          rating: feedbackEditRating,
          feedback: text.value.trim(),
          improvements: improv ? improv.value.trim() : ''
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not save that review.');
      feedbackItems = Array.isArray(data.feedback) ? data.feedback : feedbackItems;
      feedbackAdmin = Boolean(data.is_admin);
      feedbackEditingId = '';
      renderFeedback();
      toast({ title: 'Review updated', sub: 'The board shows your change now.', icon: ICON.check });
    } catch (err) {
      if (btn) { btn.disabled = false; btn.textContent = 'Save changes'; }
      toast({ title: 'Could not save', sub: err.message, icon: ICON.x, warn: true });
    }
  }

  async function deleteFeedbackEntry(id) {
    const item = feedbackItems.find(x => x.id === id);
    if (!confirm('Delete this review for good?' + (item && item.replies.length ? ' Its replies go with it.' : ''))) return;
    try {
      const res = await fetch(AUTH_WORKER_URL + '/feedback', {
        method: 'DELETE',
        headers: Object.assign({ 'content-type': 'application/json' }, reqHeaders()),
        credentials: 'omit',
        body: JSON.stringify({ id })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not delete that review.');
      feedbackItems = Array.isArray(data.feedback) ? data.feedback : feedbackItems.filter(x => x.id !== id);
      feedbackAdmin = Boolean(data.is_admin);
      renderFeedback();
      toast({ title: 'Review deleted', icon: ICON.check });
    } catch (err) {
      toast({ title: 'Could not delete', sub: err.message, icon: ICON.x, warn: true });
    }
  }

  async function onFeedbackReplySubmit(e) {
    const form = e.target.closest('[data-fb-reply-form]');
    if (!form) return;
    e.preventDefault();
    const id = form.dataset.fbReplyForm;
    const input = form.querySelector('input[name="text"]');
    const text = (input ? input.value : '').trim();
    if (text.length < 2) {
      toast({ title: 'Reply is too short', sub: 'Write at least 2 characters.', icon: ICON.x });
      return;
    }
    const btn = form.querySelector('button[type="submit"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Posting…'; }
    try {
      const res = await fetch(AUTH_WORKER_URL + '/feedback/reply', {
        method: 'POST',
        headers: Object.assign({ 'content-type': 'application/json' }, reqHeaders()),
        credentials: 'omit',
        body: JSON.stringify({ id, text })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not post that reply.');
      feedbackItems = Array.isArray(data.feedback) ? data.feedback : feedbackItems;
      feedbackAdmin = Boolean(data.is_admin);
      feedbackReplyOpenId = '';
      renderFeedback();
      toast({ title: 'Reply posted', icon: ICON.check });
    } catch (err) {
      if (btn) { btn.disabled = false; btn.textContent = 'Post reply'; }
      toast({ title: 'Could not reply', sub: err.message, icon: ICON.x, warn: true });
    }
  }

  function initFeedbackDrawer() {
    if (!feedbackDrawer) return;
    ensureFeedbackImageField();
    if (feedbackNewBtn) {
      feedbackNewBtn.addEventListener('click', () => {
        if (auth.state !== VERIFIED) {
          startLogin();
          return;
        }
        feedbackComposeOpen = !feedbackComposeOpen;
        renderFeedback();
        if (feedbackComposeOpen && feedbackText) feedbackText.focus();
      });
    }
    if (feedbackForm) feedbackForm.addEventListener('submit', submitFeedback);
    feedbackDrawer.querySelectorAll('#feedbackRatingGroup [data-rating]').forEach(btn => {
      btn.addEventListener('click', () => setFeedbackRating(btn.dataset.rating));
    });
    feedbackList.addEventListener('click', onFeedbackListClick);
    feedbackList.addEventListener('submit', onFeedbackReplySubmit);
  }

  function openFeedback() {
    if (!feedbackDrawer) return;
    if (drawer.classList.contains('is-open')) hide(drawer);
    if (requestsDrawer && requestsDrawer.classList.contains('is-open')) hide(requestsDrawer);
    feedbackComposeOpen = false;
    feedbackEditingId = '';
    feedbackReplyOpenId = '';
    renderFeedback();
    openScrim();
    feedbackDrawer.classList.add('is-open');
    feedbackDrawer.setAttribute('aria-hidden', 'false');
    loadFeedback();
  }

  function closeFeedback() {
    if (!feedbackDrawer) return;
    hide(feedbackDrawer);
    closeScrim();
  }

  /* --------------------------- Account Settings Modal -------------------- */
  const K_DOWNLOAD_HISTORY = 'kyro.download_history.v1';
  let downloadHistory = read(K_DOWNLOAD_HISTORY, []);

  function recordDownloadHistory(r, file) {
    if (!r) return;
    const item = {
      id: r.id,
      title: r.title,
      ext: (file && file.ext) || 'zip',
      size: (file && file.size) || '',
      date: new Date().toISOString()
    };
    downloadHistory = [item, ...downloadHistory.filter(h => h.id !== r.id)].slice(0, 30);
    write(K_DOWNLOAD_HISTORY, downloadHistory);
  }

  const accountModalOverlay = $('#accountModalOverlay');
  const accountModalClose = $('#accountModalClose');

  function openAccountModal(tab = 'applications') {
    if (!accountModalOverlay) return;
    renderAccountProfile();
    switchAccountTab(tab);
    accountModalOverlay.hidden = false;
  }

  function closeAccountModal() {
    if (accountModalOverlay) accountModalOverlay.hidden = true;
  }

  function renderAccountProfile() {
    const avatarEl = $('#accUserAvatar');
    const nameEl = $('#accUserName');
    const metaEl = $('#accUserMeta');
    const uploadsTab = $('#accUploadsTab');
    if (!avatarEl || !nameEl || !metaEl) return;

    if (auth.state !== OUT && auth.user) {
      avatarEl.innerHTML = avatarHTML(auth.user);
      wireAvatars(avatarEl);
      nameEl.textContent = auth.user.username;
      const roleBadge = auth.user.role || (discordRole ? discordRole.toUpperCase() : (auth.state === VERIFIED ? 'Member' : 'Guest'));
      metaEl.textContent = '@' + auth.user.username + ' · ' + roleBadge + (auth.state === VERIFIED ? ' · Verified' : '');

      const isContributorOrOwner = roleBadge.toLowerCase() === 'owner' || roleBadge.toLowerCase() === 'contributor' || roleBadge.toLowerCase() === 'mod+' || auth.user.is_owner === true;
      if (uploadsTab) uploadsTab.style.display = isContributorOrOwner ? 'flex' : 'none';
      checkUnreadNotifications();
    } else {
      avatarEl.innerHTML = 'K';
      nameEl.textContent = 'Guest';
      metaEl.textContent = '@guest · Not signed in with Discord';
      if (uploadsTab) uploadsTab.style.display = 'none';
    }
  }

  const publishingBox = $('#accPublishingStatus');
  if (publishingBox) {
    publishingBox.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-pub-action]');
      if (!btn) return;
      const action = btn.dataset.pubAction;
      const slug = btn.dataset.slug;
      const endpoint = action === 'retry' ? '/vault/discord/publish' : '/vault/virustotal';
      btn.disabled = true;
      btn.textContent = 'Working…';
      try {
        const res = await fetch(AUTH_WORKER_URL + endpoint, {
          method: 'POST',
          headers: { authorization: 'Bearer ' + auth.token, 'content-type': 'application/json' },
          credentials: 'omit',
          body: JSON.stringify({ slug, action })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'That action was refused.');
        toast({ title: action === 'release' ? 'Hold released' : 'Discord updated', sub: action === 'retry' ? 'Checked Discord and updated the existing announcement.' : 'Status refreshed below.', icon: ICON.check });
      } catch (err) {
        toast({ title: 'Action failed', sub: err && err.message ? err.message : 'Try again in a moment.', icon: ICON.x });
      }
      renderPublishingStatus();
    });
  }

  function switchAccountTab(tabKey) {
    const tabs = $$('[data-acc-tab]');
    tabs.forEach(t => t.classList.toggle('is-active', t.dataset.accTab === tabKey));

    const panels = {
      applications: $('#accPanelApplications'),
      requests: $('#accPanelRequests'),
      vault: $('#accPanelVault'),
      downloads: $('#accPanelDownloads'),
      settings: $('#accPanelSettings'),
      uploads: $('#accPanelUploads'),
      notifications: $('#accPanelNotifications')
    };

    Object.entries(panels).forEach(([k, el]) => {
      if (!el) return;
      el.classList.toggle('is-active', k === tabKey);
    });

    if (tabKey === 'applications') renderAccountApplications();
    else if (tabKey === 'requests') renderAccountRequests();
    else if (tabKey === 'vault') renderAccountVault();
    else if (tabKey === 'downloads') renderAccountDownloads();
    else if (tabKey === 'uploads') renderAccountUploads();
    else if (tabKey === 'notifications') renderAccountNotifications();
  }

  async function checkUnreadNotifications() {
    if (auth.state === OUT || !auth.token) return;
    try {
      const res = await fetch(AUTH_WORKER_URL + '/vault/notifications', {
        headers: { authorization: 'Bearer ' + auth.token },
        credentials: 'omit'
      });
      if (!res.ok) return;
      const data = await res.json();
      const notifs = data.notifications || [];
      const unread = notifs.filter(n => !n.read).length;
      const badge = $('#accNotifsCount');
      if (badge) {
        if (unread > 0) {
          badge.textContent = String(unread);
          badge.style.display = 'inline-block';
        } else {
          badge.style.display = 'none';
        }
      }
    } catch {}
  }

  async function renderAccountNotifications() {
    const list = $('#accNotifsContent');
    if (!list) return;
    if (auth.state === OUT || !auth.token) {
      list.innerHTML = '<div class="acc-row-sub">Please sign in with Discord to view notifications.</div>';
      return;
    }
    list.innerHTML = '<div class="acc-row-sub">Loading notifications…</div>';
    try {
      const res = await fetch(AUTH_WORKER_URL + '/vault/notifications', {
        headers: { authorization: 'Bearer ' + auth.token },
        credentials: 'omit'
      });
      const data = await res.json();
      const notifs = data.notifications || [];
      if (!notifs.length) {
        list.innerHTML = '<div class="acc-empty-box"><p class="acc-empty-text">No notifications yet. When you submit or review uploads, updates will appear here.</p></div>';
        return;
      }

      list.innerHTML = notifs.map(n => {
        const isApproved = n.type === 'approved';
        const isPending = n.type === 'pending';
        const isRequest = n.type === 'request';
        const color = isApproved ? '#10b981' : isPending ? '#f59e0b' : isRequest ? '#38bdf8' : '#94a3b8';
        const timeAgo = n.created ? n.created.replace('T', ' ').slice(0, 16) : '';
        return `
          <div class="acc-row-item" style="flex-direction:column;align-items:stretch;gap:6px;padding:12px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-left:3px solid ${color};border-radius:8px;">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <strong style="color:#fff;font-size:0.92rem;">${esc(n.title)}</strong>
              <span style="font-size:0.75rem;color:var(--dim);">${esc(timeAgo)}</span>
            </div>
            <div style="font-size:0.85rem;color:#cbd5e1;line-height:1.4;">${esc(n.message)}</div>
          </div>
        `;
      }).join('');

      // Mark as read in background
      fetch(AUTH_WORKER_URL + '/vault/notifications', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + auth.token, 'content-type': 'application/json' },
        body: JSON.stringify({}),
        credentials: 'omit'
      }).then(() => {
        const badge = $('#accNotifsCount');
        if (badge) badge.style.display = 'none';
      }).catch(() => {});
    } catch {
      list.innerHTML = '<div class="acc-row-sub">Failed to load notifications.</div>';
    }
  }

  async function renderAccountApplications() {
    const target = $('#accApplicationsContent');
    if (!target) return;
    if (auth.state === OUT || !auth.token) {
      target.innerHTML =
        '<div class="acc-empty-box">' +
          '<p class="acc-empty-text">Sign in with Discord to view your staff and contributor applications.</p>' +
          '<button type="button" class="acc-action-pill" id="accAppLogin">Sign in with Discord</button>' +
        '</div>';
      $('#accAppLogin')?.addEventListener('click', () => { closeAccountModal(); startLogin(); });
      return;
    }

    target.innerHTML = '<div class="acc-empty-box"><p class="acc-empty-text">Checking your applications…</p></div>';
    try {
      const res = await fetch(AUTH_WORKER_URL + '/applications', {
        headers: { 'authorization': 'Bearer ' + auth.token },
        credentials: 'omit'
      });
      const data = await res.json();
      const apps = (data && Array.isArray(data.applications)) ? data.applications : [];
      if (!apps.length) {
        target.innerHTML =
          '<div class="acc-empty-box">' +
            '<p class="acc-empty-text">You haven\'t applied yet.</p>' +
            '<a class="acc-action-pill" href="/apply">Browse application forms →</a>' +
          '</div>';
        return;
      }
      target.innerHTML = apps.map(app => {
        const isDeclined = app.status === 'declined';
        return '<div class="acc-row-item" style="flex-direction:column;align-items:stretch;gap:8px;">' +
          '<div style="display:flex;align-items:center;justify-content:space-between;width:100%;">' +
            '<div class="acc-row-info">' +
              '<div class="acc-row-title">' + esc(app.role ? app.role.toUpperCase() : 'APPLICATION') + '</div>' +
              '<div class="acc-row-sub">Status: <span style="color:' + (isDeclined ? '#ef4444' : app.status === 'approved' ? '#10b981' : '#60a5fa') + ';font-weight:600;">' + esc(app.status.replace(/_/g, ' ')) + '</span> · Submitted ' + (app.created ? app.created.slice(0, 10) : '') + '</div>' +
            '</div>' +
            '<a class="btn btn-ghost btn-sm" href="/apply?application=' + encodeURIComponent(app.id) + '">View Receipt</a>' +
          '</div>' +
          (isDeclined && app.decline_reason ? '<div style="background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.25);border-radius:8px;padding:8px 12px;font-size:0.85rem;color:#fca5a5;"><strong style="display:block;margin-bottom:2px;color:#f87171;">Reason for rejection:</strong>' + esc(app.decline_reason) + '</div>' : '') +
        '</div>';
      }).join('');
    } catch {
      target.innerHTML =
        '<div class="acc-empty-box">' +
          '<p class="acc-empty-text">You haven\'t applied yet.</p>' +
          '<a class="acc-action-pill" href="/apply">Browse application forms →</a>' +
        '</div>';
    }
  }

  function renderAccountRequests() {
    const target = $('#accRequestsContent');
    if (!target) return;
    const userId = (auth.user && auth.user.id) || '';
    const myRequests = (reqItems || []).filter(r => r.by === userId);

    if (!myRequests.length) {
      target.innerHTML =
        '<div class="acc-empty-box">' +
          '<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" style="margin-bottom:12px;opacity:0.6;"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>' +
          '<p class="acc-empty-text">No requests submitted yet.</p>' +
          '<button type="button" class="acc-action-pill" id="accGoRequests">Browse requests</button>' +
        '</div>';
      $('#accGoRequests')?.addEventListener('click', () => { closeAccountModal(); openRequests(); });
      return;
    }

    target.innerHTML = myRequests.map(r =>
      '<div class="acc-row-item">' +
        '<div class="acc-row-info">' +
          '<div class="acc-row-title">' + esc(r.title) + '</div>' +
          '<div class="acc-row-sub">' + esc(r.category ? r.category.toUpperCase() : 'TOOL') + ' · ' + (r.votes || 0) + ' votes · Status: ' + esc(r.status || 'open') + '</div>' +
        '</div>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-acc-open-req="' + esc(r.id) + '">View on board</button>' +
      '</div>'
    ).join('');

    target.querySelectorAll('[data-acc-open-req]').forEach(btn => btn.addEventListener('click', () => {
      closeAccountModal();
      openRequests();
    }));
  }

  function renderAccountVault() {
    const list = $('#accVaultList');
    if (!list) return;
    const items = resources.filter(r => saved.has(r.id));
    if (!items.length) {
      list.innerHTML =
        '<div class="acc-empty-box">' +
          '<p class="acc-empty-text">Your saved vault is empty. Click the bookmark icon on any tool to save it.</p>' +
        '</div>';
      return;
    }
    list.innerHTML = items.map(r =>
      '<div class="vault-item" data-acc-vault-id="' + esc(r.id) + '">' +
        '<div class="vault-thumb">' + Preview.thumb(r) + '</div>' +
        '<div class="vault-info">' +
          '<div class="v-title">' + esc(r.title) + '</div>' +
          '<div class="v-meta"><span class="mono">' + (r.version || 'build') + '</span><span>' + (r.category || 'tool') + '</span></div>' +
        '</div>' +
        '<button type="button" class="btn btn-primary btn-sm">Open</button>' +
      '</div>'
    ).join('');

    list.querySelectorAll('[data-acc-vault-id]').forEach(el => el.addEventListener('click', () => {
      closeAccountModal();
      openModal(el.dataset.accVaultId);
    }));
  }

  function renderAccountDownloads() {
    const list = $('#accDownloadsList');
    if (!list) return;
    if (!downloadHistory.length) {
      list.innerHTML =
        '<div class="acc-empty-box">' +
          '<p class="acc-empty-text">No downloads recorded in this browser session yet.</p>' +
        '</div>';
      return;
    }
    list.innerHTML = downloadHistory.map(d =>
      '<div class="vault-item" data-acc-dl-id="' + esc(d.id) + '">' +
        '<div class="vault-info">' +
          '<div class="v-title">' + esc(d.title) + '</div>' +
          '<div class="v-meta"><span class="mono">' + esc(d.ext ? d.ext.toUpperCase() : 'FILE') + '</span><span>' + (d.size || '') + '</span><span>' + (d.date ? d.date.slice(0, 10) : '') + '</span></div>' +
        '</div>' +
        '<button type="button" class="btn btn-ghost btn-sm">Download Again</button>' +
      '</div>'
    ).join('');

    list.querySelectorAll('[data-acc-dl-id]').forEach(el => el.addEventListener('click', () => {
      closeAccountModal();
      openModal(el.dataset.accDlId);
    }));
  }

  /* Staff-only status panel. It only renders after both admin endpoints
     accept the session, so it never exposes queue data to ordinary members. */
  async function renderPublishingStatus() {
    const group = $('#accPublishingGroup');
    const box = $('#accPublishingStatus');
    if (!group || !box) return;
    if (auth.state === OUT || !auth.token) { group.style.display = 'none'; return; }
    const headers = { authorization: 'Bearer ' + auth.token };
    try {
      const [pubRes, scanRes] = await Promise.all([
        fetch(AUTH_WORKER_URL + '/vault/discord/publish', { headers, credentials: 'omit' }),
        fetch(AUTH_WORKER_URL + '/vault/virustotal', { headers, credentials: 'omit' })
      ]);
      if (!pubRes.ok || !scanRes.ok) { group.style.display = 'none'; return; }
      const pub = ((await pubRes.json()) || {}).publish || {};
      const scanDoc = await scanRes.json();
      const scans = scanDoc.scans || {};
      const slugs = Array.from(new Set(Object.keys(pub).concat(Object.keys(scans))));
      group.style.display = 'block';
      if (!slugs.length) {
        box.innerHTML = '<div class="acc-row-sub">No Discord announcements or scans recorded yet.</div>';
        return;
      }
      const warning = scanDoc.proof_channel_configured === false
        ? '<div style="background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.3);border-radius:8px;padding:8px 10px;font-size:0.78rem;color:#fcd34d;">No <strong>#proof</strong> channel is configured, so scan results cannot be posted. An admin needs to set <code>DISCORD_PROOF_CHANNEL_ID</code>.</div>'
        : '';
      const rows = slugs.map(slug => {
        const post = pub[slug] || {};
        const scan = scans[slug] || {};
        const title = (post.snapshot && post.snapshot.title) || scan.title || slug;
        const pStatus = post.status || 'not posted';
        const pColor = pStatus === 'posted' || pStatus === 'updated' ? '#34d399' : pStatus === 'failed' ? '#f87171' : pStatus === 'removed' ? '#94a3b8' : '#fbbf24';
        const scanLabel = scan.status ? scan.status + (scan.gated ? ' · held for review' : '') : 'no scan';
        const scanColor = scan.flagged ? '#f87171' : scan.status === 'completed' ? '#34d399' : scan.status === 'failed' || scan.status === 'unavailable' ? '#fbbf24' : '#94a3b8';
        const actions = ['<button type="button" class="acc-action-pill" data-pub-action="retry" data-slug="' + esc(slug) + '">Retry post</button>'];
        if (scan.status === 'pending') actions.push('<button type="button" class="acc-action-pill" data-pub-action="refresh" data-slug="' + esc(slug) + '">Check scan</button>');
        if (scan.gated) actions.push('<button type="button" class="acc-action-pill" data-pub-action="release" data-slug="' + esc(slug) + '">Release hold</button>');
        return '<div style="border:1px solid rgba(255,255,255,0.07);border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:6px;">' +
          '<div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;"><strong style="font-size:0.86rem;color:#e2e8f0;">' + esc(title) + '</strong>' +
          '<span style="font-size:0.74rem;color:' + pColor + ';">Discord: ' + esc(pStatus) + '</span></div>' +
          '<div style="font-size:0.75rem;color:' + scanColor + ';">Scan: ' + esc(scanLabel) + (scan.result ? ' — ' + esc(scan.result) : '') + '</div>' +
          (post.error || scan.proof_error || scan.error ? '<div style="font-size:0.73rem;color:#fca5a5;">' + esc(post.error || scan.proof_error || scan.error) + '</div>' : '') +
          '<div style="display:flex;gap:6px;flex-wrap:wrap;">' + actions.join('') + '</div></div>';
      }).join('');
      box.innerHTML = warning + rows;
    } catch {
      group.style.display = 'none';
    }
  }

  async function renderAccountUploads() {
    renderPublishingStatus();
    const list = $('#vUpListContent');
    const title = $('#vUpListTitle');
    if (!list) return;
    if (auth.state === OUT || !auth.token) {
      list.innerHTML = '<div class="acc-row-sub">Please sign in with Discord.</div>';
      return;
    }

    list.innerHTML = '<div class="acc-row-sub">Loading submissions…</div>';
    try {
      const res = await fetch(AUTH_WORKER_URL + '/vault/submissions', {
        headers: { authorization: 'Bearer ' + auth.token },
        credentials: 'omit'
      });
      const data = await res.json();
      const subs = data.submissions || [];
      const isOwner = Boolean(data.is_owner);

      if (title) title.textContent = isOwner ? 'All Submissions (Owner Review Queue)' : 'Your Vault Contributions';

      if (!subs.length) {
        list.innerHTML = '<div class="acc-row-sub">No submissions found. Submit your first resource above!</div>';
        return;
      }

      list.innerHTML = subs.map(s => {
        const isPending = s.status === 'pending';
        const isApproved = s.status === 'approved';
        const statusColor = isApproved ? '#10b981' : isPending ? '#f59e0b' : '#ef4444';
        const statusBadge = `<span style="background:rgba(255,255,255,0.08);color:${statusColor};padding:2px 8px;border-radius:6px;font-size:0.75rem;font-weight:600;text-transform:uppercase;">${esc(s.status)}</span>`;

        return `
          <div class="acc-row-item" id="vSubItem-${esc(s.id)}" style="flex-direction:column;align-items:stretch;gap:10px;padding:12px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:10px;">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <div>
                <strong style="color:#fff;font-size:0.95rem;">${esc(s.title)}</strong>
                <div style="color:var(--dim);font-size:0.8rem;margin-top:2px;">
                  By <strong>${esc(s.by_username || 'Contributor')}</strong> · Platform: <code>${esc(s.os)}</code> · Slug: <code>${esc(s.slug)}</code> · ${s.created ? s.created.slice(0, 10) : ''}
                  ${s.pass ? ` · Password: <code style="color:#38bdf8;">${esc(s.pass)}</code>` : ''}
                </div>
              </div>
              <div style="display:flex;align-items:center;gap:8px;">
                ${statusBadge}
                ${isOwner ? `
                  <button type="button" class="btn btn-ghost btn-sm" data-sub-edit="${esc(s.id)}" title="Edit submission" style="padding:3px 8px;font-size:0.75rem;">Edit</button>
                  <button type="button" class="btn btn-danger btn-sm" data-sub-delete="${esc(s.id)}" title="Delete submission" style="padding:3px 8px;font-size:0.75rem;">Delete</button>
                ` : ''}
              </div>
            </div>
            ${s.details ? `<div style="font-size:0.82rem;color:#cbd5e1;background:rgba(0,0,0,0.25);padding:8px 10px;border-radius:6px;">${esc(s.details)}</div>` : ''}
            <div style="display:flex;align-items:center;justify-content:space-between;margin-top:4px;">
              <span style="font-size:0.8rem;color:var(--dim);">Download: ${safeHref(s.download_url) ? `<a href="${esc(safeHref(s.download_url))}" target="_blank" rel="noopener noreferrer" style="color:#60a5fa;">${esc(s.download_url)}</a>` : esc(s.download_url || '—')}</span>
              ${isOwner && isPending ? `
                <div style="display:flex;gap:8px;">
                  <button type="button" class="btn btn-primary btn-sm" data-sub-approve="${esc(s.id)}">✓ Approve &amp; Publish</button>
                  <button type="button" class="btn btn-danger btn-sm" data-sub-reject="${esc(s.id)}">✕ Reject</button>
                </div>
              ` : ''}
            </div>
            <!-- Owner inline edit form (hidden by default) -->
            <div id="vSubEditForm-${esc(s.id)}" style="display:none;background:rgba(0,0,0,0.35);padding:12px;border-radius:8px;border:1px solid rgba(255,255,255,0.08);margin-top:6px;">
              <div style="font-size:0.85rem;font-weight:700;color:#38bdf8;margin-bottom:8px;">Edit Resource Details</div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">
                <div>
                  <label style="font-size:0.75rem;color:var(--dim);display:block;margin-bottom:2px;">Title</label>
                  <input type="text" class="input input-sm" id="editTitle-${esc(s.id)}" value="${esc(s.title)}" style="width:100%;">
                </div>
                <div>
                  <label style="font-size:0.75rem;color:var(--dim);display:block;margin-bottom:2px;">Archive Password (Optional)</label>
                  <input type="text" class="input input-sm" id="editPass-${esc(s.id)}" value="${esc(s.pass || '')}" style="width:100%;">
                </div>
              </div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">
                <div>
                  <label style="font-size:0.75rem;color:var(--dim);display:block;margin-bottom:2px;">Download URL</label>
                  <input type="url" class="input input-sm" id="editUrl-${esc(s.id)}" value="${esc(s.download_url || '')}" style="width:100%;">
                </div>
                <div>
                  <label style="font-size:0.75rem;color:var(--dim);display:block;margin-bottom:2px;">Banner / Image URL</label>
                  <input type="url" class="input input-sm" id="editImg-${esc(s.id)}" value="${esc(s.image_url || '')}" style="width:100%;">
                </div>
              </div>
              <div style="margin-bottom:8px;">
                <label style="font-size:0.75rem;color:var(--dim);display:block;margin-bottom:2px;">Description / Effects</label>
                <textarea class="input input-sm" id="editDetails-${esc(s.id)}" rows="2" style="width:100%;resize:vertical;">${esc(s.details || '')}</textarea>
              </div>
              <div style="display:flex;gap:8px;justify-content:flex-end;">
                <button type="button" class="btn btn-ghost btn-sm" data-edit-cancel="${esc(s.id)}">Cancel</button>
                <button type="button" class="btn btn-primary btn-sm" data-edit-save="${esc(s.id)}">Save &amp; Sync to Discord</button>
              </div>
            </div>
          </div>
        `;
      }).join('');

      // Wire owner approval buttons
      if (isOwner) {
        list.querySelectorAll('[data-sub-approve]').forEach(btn => {
          btn.addEventListener('click', async () => {
            btn.disabled = true;
            btn.textContent = 'Publishing…';
            try {
              const appRes = await fetch(AUTH_WORKER_URL + '/vault/submissions/review', {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: 'Bearer ' + auth.token },
                body: JSON.stringify({ id: btn.dataset.subApprove, decision: 'approve' }),
                credentials: 'omit'
              });
              if (appRes.ok) {
                toast({ title: 'Resource Approved!', sub: 'Published to Vault & Discord channels.', icon: ICON.check });
                renderAccountUploads();
              } else {
                toast({ title: 'Approval failed', sub: 'Server error', icon: ICON.x });
              }
            } catch (err) {
              toast({ title: 'Error', sub: err.message, icon: ICON.x });
            }
          });
        });

        list.querySelectorAll('[data-sub-reject]').forEach(btn => {
          btn.addEventListener('click', async () => {
            btn.disabled = true;
            try {
              const rejRes = await fetch(AUTH_WORKER_URL + '/vault/submissions/review', {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: 'Bearer ' + auth.token },
                body: JSON.stringify({ id: btn.dataset.subReject, decision: 'reject' }),
                credentials: 'omit'
              });
              if (rejRes.ok) {
                toast({ title: 'Resource Rejected', sub: 'Status updated.', icon: ICON.check });
                renderAccountUploads();
              }
            } catch (err) {
              toast({ title: 'Error', sub: err.message, icon: ICON.x });
            }
          });
        });

        // Wire owner Edit & Delete buttons
        list.querySelectorAll('[data-sub-edit]').forEach(btn => {
          btn.addEventListener('click', () => {
            const id = btn.dataset.subEdit;
            const formEl = document.getElementById(`vSubEditForm-${id}`);
            if (formEl) formEl.style.display = formEl.style.display === 'none' ? 'block' : 'none';
          });
        });

        list.querySelectorAll('[data-edit-cancel]').forEach(btn => {
          btn.addEventListener('click', () => {
            const id = btn.dataset.editCancel;
            const formEl = document.getElementById(`vSubEditForm-${id}`);
            if (formEl) formEl.style.display = 'none';
          });
        });

        list.querySelectorAll('[data-edit-save]').forEach(btn => {
          btn.addEventListener('click', async () => {
            const id = btn.dataset.editSave;
            const titleVal = document.getElementById(`editTitle-${id}`)?.value.trim();
            const passVal = document.getElementById(`editPass-${id}`)?.value.trim();
            const urlVal = document.getElementById(`editUrl-${id}`)?.value.trim();
            const imgVal = document.getElementById(`editImg-${id}`)?.value.trim();
            const detailsVal = document.getElementById(`editDetails-${id}`)?.value.trim();

            if (!titleVal) {
              toast({ title: 'Validation error', sub: 'Title cannot be empty', icon: ICON.x });
              return;
            }

            btn.disabled = true;
            btn.textContent = 'Saving…';
            try {
              const editRes = await fetch(AUTH_WORKER_URL + '/vault/submissions/manage', {
                method: 'PUT',
                headers: { 'content-type': 'application/json', authorization: 'Bearer ' + auth.token },
                body: JSON.stringify({
                  id,
                  title: titleVal,
                  password: passVal,
                  download_url: urlVal,
                  image_url: imgVal,
                  details: detailsVal
                }),
                credentials: 'omit'
              });
              if (editRes.ok) {
                toast({ title: 'Resource Updated', sub: 'Changes synced to Vault & Discord.', icon: ICON.check });
                renderAccountUploads();
              } else {
                const errData = await editRes.json().catch(() => ({}));
                toast({ title: 'Update failed', sub: errData.error || 'Server error', icon: ICON.x });
              }
            } catch (err) {
              toast({ title: 'Error', sub: err.message, icon: ICON.x });
            } finally {
              btn.disabled = false;
              btn.textContent = 'Save & Sync to Discord';
            }
          });
        });

        list.querySelectorAll('[data-sub-delete]').forEach(btn => {
          btn.addEventListener('click', async () => {
            if (!confirm('Are you sure you want to permanently delete this resource from the Vault?')) return;
            btn.disabled = true;
            try {
              const delRes = await fetch(AUTH_WORKER_URL + '/vault/submissions/manage', {
                method: 'DELETE',
                headers: { 'content-type': 'application/json', authorization: 'Bearer ' + auth.token },
                body: JSON.stringify({ id: btn.dataset.subDelete }),
                credentials: 'omit'
              });
              if (delRes.ok) {
                toast({ title: 'Resource Deleted', sub: 'Removed from Vault & Discord.', icon: ICON.check });
                renderAccountUploads();
              } else {
                toast({ title: 'Delete failed', sub: 'Server error', icon: ICON.x });
              }
            } catch (err) {
              toast({ title: 'Error', sub: err.message, icon: ICON.x });
            }
          });
        });
      }
    } catch (e) {
      list.innerHTML = '<div class="acc-row-sub">Failed to load submissions.</div>';
    }
  }

  function wireVaultUploadForm() {
    const form = $('#vaultUploadForm');
    const btn = $('#vUpSubmitBtn');
    const dropzone = $('#vUpDropzone');
    const fileInput = $('#vUpFileInput');
    const imgPreview = $('#vUpImgPreview');
    const previewWrap = $('#vUpPreviewWrap');
    const removeImgBtn = $('#vUpRemoveImg');
    const imageUrlInput = $('#vUpImageUrl');
    const dropzoneText = $('#vUpDropzoneText');
    if (!form || !btn) return;

    let stagedImageBase64 = null;

    async function uploadImageFile(file) {
      if (!file || !file.type.startsWith('image/')) {
        toast({ title: 'Invalid file', sub: 'Please select an image file (PNG, JPG, WEBP).', icon: ICON.x });
        return;
      }
      if (file.size > 8 * 1024 * 1024) {
        toast({ title: 'Image too large', sub: 'Image must be under 8MB.', icon: ICON.x });
        return;
      }

      const reader = new FileReader();
      reader.onload = async (e) => {
        stagedImageBase64 = e.target.result;
        if (imgPreview && previewWrap && dropzoneText) {
          imgPreview.src = stagedImageBase64;
          previewWrap.style.display = 'flex';
          dropzoneText.style.display = 'none';
        }

        // Upload to server to get permanent Discord CDN URL
        toast({ title: 'Uploading image…', sub: 'Storing screenshot to CDN.', icon: ICON.shield });
        try {
          const upRes = await fetch(AUTH_WORKER_URL + '/vault/upload-image', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: 'Bearer ' + auth.token
            },
            body: JSON.stringify({
              image: stagedImageBase64,
              filename: file.name || 'screenshot.png'
            }),
            credentials: 'omit'
          });
          const upData = await upRes.json();
          if (upRes.ok && upData.url) {
            if (imageUrlInput) imageUrlInput.value = upData.url;
            toast({ title: 'Image uploaded!', sub: 'Saved to Kyro media network.', icon: ICON.check });
          } else {
            console.warn('CDN upload response:', upData);
            toast({ title: 'Image upload failed', sub: upData.error || 'The image could not be stored. Try again, or paste a direct image URL.', icon: ICON.x });
          }
        } catch (err) {
          console.warn('Image upload failed:', err);
          toast({ title: 'Image upload failed', sub: err.message || 'Network error while storing the image.', icon: ICON.x });
        }
      };
      reader.readAsDataURL(file);
    }

    if (dropzone && fileInput) {
      dropzone.addEventListener('click', (e) => {
        if (e.target === removeImgBtn) return;
        fileInput.click();
      });

      fileInput.addEventListener('change', () => {
        if (fileInput.files && fileInput.files[0]) {
          uploadImageFile(fileInput.files[0]);
        }
      });

      // Drag and drop handlers
      ['dragenter', 'dragover'].forEach(name => {
        dropzone.addEventListener(name, (e) => {
          e.preventDefault();
          dropzone.style.borderColor = '#38bdf8';
          dropzone.style.background = 'rgba(56,189,248,0.06)';
        });
      });

      ['dragleave', 'drop'].forEach(name => {
        dropzone.addEventListener(name, (e) => {
          e.preventDefault();
          dropzone.style.borderColor = 'rgba(255,255,255,0.15)';
          dropzone.style.background = 'rgba(255,255,255,0.02)';
        });
      });

      dropzone.addEventListener('drop', (e) => {
        const files = e.dataTransfer?.files;
        if (files && files[0]) {
          uploadImageFile(files[0]);
        }
      });
    }

    // Paste handler across modal / form
    form.addEventListener('paste', (e) => {
      const items = (e.clipboardData || e.originalEvent?.clipboardData)?.items;
      if (!items) return;
      for (const item of items) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          e.preventDefault();
          const file = item.getAsFile();
          uploadImageFile(file);
          toast({ title: 'Screenshot pasted!', sub: 'Image added from clipboard.', icon: ICON.check });
          break;
        }
      }
    });

    if (removeImgBtn) {
      removeImgBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        stagedImageBase64 = null;
        if (fileInput) fileInput.value = '';
        if (imageUrlInput) imageUrlInput.value = '';
        if (previewWrap) previewWrap.style.display = 'none';
        if (dropzoneText) dropzoneText.style.display = 'flex';
        toast({ title: 'Image removed', sub: 'Upload reset.', icon: ICON.x });
      });
    }

    // Auto-clean slug if user pasted a full URL
    const slugInput = $('#vUpSlug');
    if (slugInput) {
      slugInput.addEventListener('blur', () => {
        let val = slugInput.value.trim();
        if (/^https?:\/\//i.test(val)) {
          try {
            const u = new URL(val);
            const pathParts = u.pathname.split('/').filter(Boolean);
            val = pathParts[pathParts.length - 1] || u.hostname.replace(/\./g, '-');
          } catch {}
        }
        val = val.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        slugInput.value = val;
      });
    }

    // Release mode: publish straight to the Vault, or hold it in Incoming.
    const modeRadios = $$('input[name="vUpMode"]');
    const incomingOptions = $('#vUpIncomingOptions');
    const isIncomingChosen = () => {
      const picked = $('input[name="vUpMode"]:checked');
      return Boolean(picked && picked.value === 'incoming');
    };
    const paintMode = () => {
      const incoming = isIncomingChosen();
      if (incomingOptions) incomingOptions.style.display = incoming ? 'grid' : 'none';
      if (btn) btn.textContent = incoming ? 'Send to Incoming' : 'Release directly to the Vault';
    };
    modeRadios.forEach(radio => radio.addEventListener('change', paintMode));
    paintMode();

    /* Course submissions must name their original source and confirm the
       contributor may share or link it; both are re-checked by the worker. */
    const kindSelect = $('#vUpKind');
    const courseFields = $('#vUpCourseFields');
    const paintCourseFields = () => {
      const isCourse = Boolean(kindSelect && kindSelect.value === 'course');
      if (courseFields) courseFields.hidden = !isCourse;
      const rights = $('#vUpRights');
      if (rights) rights.required = isCourse;
    };
    if (kindSelect) kindSelect.addEventListener('change', paintCourseFields);
    paintCourseFields();

    /* Optional VirusTotal scan: consent text stays hidden until the uploader
       ticks the box, and the box starts unchecked on every page load. */
    const scanCheck = $('#vUpScan');
    const scanNote = $('#vUpScanNote');
    if (scanCheck && scanNote) {
      const paintScan = () => { scanNote.hidden = !scanCheck.checked; };
      scanCheck.addEventListener('change', paintScan);
      paintScan();
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!auth.token) {
        toast({ title: 'Not signed in', sub: 'Sign in with Discord first.', icon: ICON.lock });
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Submitting…';

      let rawSlug = $('#vUpSlug')?.value.trim() || '';
      let cleanSlug = rawSlug;
      if (/^https?:\/\//i.test(cleanSlug)) {
        try {
          const u = new URL(cleanSlug);
          const parts = u.pathname.split('/').filter(Boolean);
          cleanSlug = parts[parts.length - 1] || u.hash.replace(/^#\/?/, '') || u.hostname.replace(/\./g, '-');
        } catch {}
      }
      cleanSlug = cleanSlug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      if (!cleanSlug && $('#vUpTitle')?.value) {
        cleanSlug = $('#vUpTitle').value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      }

      const isIncoming = isIncomingChosen();
      const voteLimit = parseInt($('#vUpVoteLimit')?.value, 10) || 5;
      const releaseAtVal = $('#vUpReleaseAt')?.value ? new Date($('#vUpReleaseAt').value).toISOString() : null;

      // A staged picture that never reached storage would silently publish the
      // Kyro banner again, so say so instead of submitting without an image.
      if (stagedImageBase64 && !$('#vUpImageUrl')?.value.trim()) {
        toast({ title: 'Image is not stored yet', sub: 'Wait for the upload to finish, or retry the picture — otherwise the card shows the Kyro banner.', icon: ICON.x });
        btn.disabled = false;
        btn.textContent = isIncoming ? 'Send to Incoming' : 'Release directly to the Vault';
        return;
      }

      const uploadKind = $('#vUpKind')?.value || 'tool';
      const sourceUrl = uploadKind === 'course' ? ($('#vUpSourceUrl')?.value.trim() || '') : '';
      const rightsConfirmed = uploadKind === 'course' && Boolean($('#vUpRights')?.checked);
      if (uploadKind === 'course' && !sourceUrl) {
        toast({ title: 'Source link needed', sub: 'Courses need a link to the creator’s original page, even when you are also sharing a copy.', icon: ICON.x });
        btn.disabled = false;
        btn.textContent = isIncoming ? 'Send to Incoming' : 'Release directly to the Vault';
        return;
      }
      if (uploadKind === 'course' && !rightsConfirmed) {
        toast({ title: 'Permission not confirmed', sub: 'Tick the box confirming you can share or link this course.', icon: ICON.x });
        btn.disabled = false;
        btn.textContent = isIncoming ? 'Send to Incoming' : 'Release directly to the Vault';
        return;
      }
      const payload = {
        title: $('#vUpTitle')?.value.trim(),
        slug: cleanSlug,
        kind: uploadKind,
        os: $('#vUpOs')?.value || 'windows',
        category: $('#vUpCategory')?.value.trim() || (uploadKind === 'course' ? 'Course' : 'Adobe After Effects'),
        size: $('#vUpSize')?.value.trim() || 'Vault Build',
        download_url: $('#vUpDownloadUrl')?.value.trim(),
        password: $('#vUpPassword')?.value.trim() || '',
        image_url: $('#vUpImageUrl')?.value.trim(),
        details: $('#vUpDetails')?.value.trim(),
        source_url: sourceUrl || undefined,
        rights_confirmed: rightsConfirmed || undefined,
        scan_requested: Boolean($('#vUpScan')?.checked) || undefined,
        release_at: releaseAtVal,
        vote_limit: voteLimit
      };

      try {
        const endpoint = isIncoming ? '/vault/incoming' : '/vault/submissions';
        const res = await fetch(AUTH_WORKER_URL + endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + auth.token },
          body: JSON.stringify(payload),
          credentials: 'omit'
        });
        const data = await res.json();
        if (res.ok) {
          if (isIncoming) {
            toast({
              title: 'Incoming Release Posted!',
              sub: 'Live in "Ready to Release" and posted to the community channel for voting!',
              icon: ICON.check
            });
            loadIncomingReleases();
          } else {
            const isApproved = data.submission?.status === 'approved';
            toast({
              title: isApproved ? 'Resource Published!' : 'Submitted for Approval!',
              sub: isApproved ? 'Live on Vault and posted to Discord!' : 'Owner will review your submission before public release.',
              icon: ICON.check
            });
          }
          form.reset();
          if (modeRadios[0]) modeRadios[0].checked = true;
          paintMode();
          if (removeImgBtn) removeImgBtn.click();
          renderAccountUploads();
        } else {
          toast({ title: 'Submission failed', sub: data.error || 'Check fields and try again', icon: ICON.x });
        }
      } catch (err) {
        toast({ title: 'Network error', sub: err.message, icon: ICON.x });
      } finally {
        btn.disabled = false;
        paintMode();
      }
    });
  }

  function wireAccountModal() {
    if (!accountModalOverlay) return;
    accountModalClose?.addEventListener('click', closeAccountModal);
    accountModalOverlay.addEventListener('click', (e) => {
      if (e.target === accountModalOverlay) closeAccountModal();
    });

    $$('[data-acc-tab]').forEach(btn => {
      btn.addEventListener('click', () => switchAccountTab(btn.dataset.accTab));
    });

    $('#accOpenRequestsBtn')?.addEventListener('click', () => {
      closeAccountModal();
      openRequests();
    });

    $('#accSyncDiscord')?.addEventListener('click', () => {
      recheckMembership();
      toast({ title: 'Discord synced', sub: 'Verification status refreshed.', icon: ICON.check });
    });

    $('#accResetCookies')?.addEventListener('click', () => {
      $('#prefFunctional').checked = true;
      $('#prefAnalytics').checked = true;
      toast({ title: 'Cookie preferences reset', sub: 'All preferences set to default active state.', icon: ICON.check });
    });

    $('#accExportData')?.addEventListener('click', () => {
      toast({ title: 'Export request submitted', sub: 'Your data package request has been queued.', icon: ICON.check });
    });

    wireVaultUploadForm();
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

  /* Resource facts, only the ones the catalogue actually holds. Missing
     values are omitted rather than guessed at, and the review block below
     says "Not provided" wherever the vault has no review data. */
  function specHTML(r) {
    const files = (r.files && r.files.length ? r.files : [{ ext: r.format }])
      .map(f => String(f.ext || '').toLowerCase())
      .filter(Boolean)
      .filter((ext, i, all) => all.indexOf(ext) === i);
    const group = (label, badges) => badges.length
      ? '<div class="spec"><span class="spec-label mono">' + label + '</span>' +
        '<span class="spec-badges">' + badges.join('') + '</span></div>'
      : '';

    const course = kindOf(r) === 'course';
    const facts = [];
    const fact = (label, value) => {
      if (value) facts.push('<div class="safety-row"><dt>' + label + '</dt><dd>' + esc(value) + '</dd></div>');
    };
    fact('Platform', platformLabel(r));
    fact('Version', r.version);
    fact('File size', fileSize(r));
    fact('Contributor / source', r.creator || r.credits);
    fact('Category', r.category && r.category !== 'software' ? r.category.charAt(0).toUpperCase() + r.category.slice(1) : '');
    fact('Added', r.added);
    if (course) {
      fact('Skill level', r.level || r.skill_level);
      fact('Estimated duration', r.duration);
      fact('Language', r.language);
      fact('Licence / source', r.license || r.source_type);
      const sourceHref = safeHref(r.source_url);
      if (sourceHref) {
        facts.push('<div class="safety-row"><dt>Original source</dt><dd><a class="prose-link" href="' +
          esc(sourceHref) + '" target="_blank" rel="noopener noreferrer">' +
          esc(hostLabel(sourceHref) || sourceHref) + '</a></dd></div>');
      }
    }

    /* Never invent a review, a reviewer or a scan. Only real fields render;
       everything else is honestly labelled as not provided. */
    const reviewedBy = r.reviewed_by || r.reviewer || '';
    const reviewedAt = r.reviewed_at || r.reviewedAt || '';
    const checks = Array.isArray(r.checks) ? r.checks.filter(Boolean) : (r.checks ? [r.checks] : []);
    const safetyRows =
      '<div class="safety-row"><dt>Reviewed by</dt><dd>' + esc(reviewedBy || 'Not provided') + '</dd></div>' +
      '<div class="safety-row"><dt>Review date</dt><dd>' + esc(reviewedAt || 'Not provided') + '</dd></div>' +
      '<div class="safety-row"><dt>Checks performed</dt><dd>' + esc(checks.length ? checks.join(', ') : 'Not provided') + '</dd></div>' +
      '<div class="safety-row"><dt>Download access</dt><dd>Kyro Discord membership required</dd></div>';

    return '<div class="spec-row">' +
      group('AE Compatibility', r.aeMin
        ? ['<span class="badge badge-spec">AE ' + esc(r.aeMin) + '+</span>'] : []) +
      group('Platform', OS_BADGES.filter(b => (r.os || []).includes(b.value)).map(b =>
        '<span class="badge badge-spec' + (b.value === os ? ' is-current' : '') + '">' + esc(b.label + (r.architecture ? ' · ' + r.architecture : '')) + '</span>')) +
      group('File format', files.map(ext => '<span class="badge badge-format">' + esc(ext) + '</span>')) +
      '</div>' +
      '<section class="safety-block" aria-label="Resource details and safety">' +
        '<p class="section-label section-label--tight">Details &amp; safety</p>' +
        '<dl class="safety-list">' + facts.join('') + safetyRows + '</dl>' +
        '<p class="safety-note">We list a review only when the vault actually has one. Scan every download before opening it — unsigned After Effects extensions and scripts often trigger antivirus warnings, and no file here is guaranteed clean.' +
        (course ? ' Courses credit the creator and link their original page where one was supplied. If a listing should not be here, report it in the Kyro Discord and it will be reviewed.' : '') +
        '</p>' +
      '</section>';
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

  /* Guides write the install path with [Version] instead of a hard-coded
     release, because nobody's After Effects folder is called the same thing —
     and a guide that names 2026 breaks the moment someone runs 2025 (or an old
     CS6 build). The note below is the read-me line that explains the token. */
  const VERSION_NOTE =
    '<p class="install-note"><b>Read me:</b> where a path shows <code>[Version]</code>, replace it with the After Effects version you actually have — for example <code>2026</code>, <code>2025</code> or <code>CS6</code>. Include the word “After Effects” only if it is already in the path, and never keep the square brackets. Check yours in <b>Help → About After Effects</b> (Windows) or <b>After Effects → About After Effects</b> (macOS).</p>';

  function installHTML(r) {
    const guide = window.KYRO_INSTALL[r.id]
      ? installBlock(r.id)
      : (r.files && r.files.length ? r.files : [{ ext: r.format, label: '' }])
          .map(f => installBlock(f.ext, f.label)).filter(Boolean).join('');
    if (!guide) return '<p class="m-desc">No install guide on file for this format.</p>';
    return guide.indexOf('[Version]') === -1 ? guide : VERSION_NOTE + guide;
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
        : (f.gated || f.url)
          /* The archive lives on an external host. Its URL is not in the page:
             the worker hands it over with the member token on click. */
          ? '<button type="button" class="btn btn-primary btn-sm" data-gated="' + esc(f.name || f.ext || '') +
            '">' + ICON.download + 'Download</button>'
          : '<button type="button" class="btn btn-primary btn-sm" data-file="' + esc(f.ext) +
            '" style="position:relative">' + ICON.download + 'Download<span class="ring"></span></button>';
      return (
      '<div class="file-row ' + (unlocked ? 'is-unlocked' : 'is-locked') + '">' +
        (f.ext ? '<span class="file-ico mono">' + esc(String(f.ext).replace('.', '')).toUpperCase() + '</span>' : '') +
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
  function checksumHTML(r) {
    const sha = String(r.sha256 || '').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha)) return '';
    return '<section class="checksum-box" aria-label="File checksum">' +
      '<div class="checksum-head"><span class="checksum-title mono">SHA-256 CHECKSUM</span>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-checksum-copy="' + sha + '">' + ICON.copy + 'Copy</button></div>' +
      '<code class="checksum-value">' + sha + '</code>' +
      '<p class="checksum-help">Verify the downloaded file, then compare the result:<br>Windows<code>certutil -hashfile &lt;file&gt; SHA256</code>macOS<code>shasum -a 256 &lt;file&gt;</code></p></section>';
  }

  /* The archive password is part of the worker's download answer, never part
     of this bundle, so there is nothing to render before the click. */
  function passwordHTML() { return ''; }

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
    zone.querySelectorAll('[data-gated]').forEach(btn =>
      btn.addEventListener('click', () => requestLink(r, btn.dataset.gated, btn)));
  }

  function copyText(btn, text, title = 'Password copied', sub = 'Paste it when the archive asks.') {
    const done = () => {
      btn.classList.add('is-done');
      setTimeout(() => btn.classList.remove('is-done'), 1600);
      toast({ title, sub });
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => toast({ title: 'Copy failed', sub: 'Select the value and copy it manually.', icon: ICON.lock, warn: true }));
    } else {
      toast({ title: 'Clipboard unavailable', sub: 'Select the value and copy it manually.', icon: ICON.lock, warn: true });
    }
  }

  function gateBannerHTML(r) {
    const a = access();
    if (auth.state === OUT) {
      return '<div class="gate-banner gate-out"><span class="g-icon">' + ICON.lock + '</span>' +
        '<span class="g-text"><b>Downloads need a Kyro Discord membership.</b><br/>Browsing and previews stay open — sign in whenever you want to download.</span>' +
        '<button type="button" class="btn btn-discord btn-sm" id="gateLogin">' + ICON.discord + 'Sign in with Discord</button></div>';
    }
    if (auth.state === LOGGED) {
      return '<div class="gate-banner gate-denied"><span class="g-icon">' + ICON.shield + '</span>' +
        '<span class="g-text"><b>You are signed in, but not a Kyro member yet.</b><br/>Join the server, then refresh verification to unlock downloads.</span>' +
        '<a class="btn btn-danger btn-sm" href="' + INVITE_URL + '" target="_blank" rel="noopener noreferrer">' + ICON.discord + 'Join the Kyro Discord</a>' +
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
      '<img class="m-shot" id="modalShot" src="' + esc(gal[0]) + '" alt="' + esc(r.title) + ' preview" decoding="async" />' +
      '<span class="preview-chip mono">PRODUCT IMAGES</span>' + badgeRow +
      '<div class="m-thumbs">' + gal.map((src, i) =>
        '<button type="button" class="m-thumb' + (i === 0 ? ' is-active' : '') + '" data-shot="' + esc(src) +
        '" aria-pressed="' + (i === 0) + '" aria-label="Show preview ' + (i + 1) + ' of ' + gal.length + '">' +
        '<img src="' + esc(src) + '" alt="" loading="lazy" decoding="async" /></button>').join('') + '</div>' +
      '</div>';
  }

  function openModal(id) {
    const r = resources.find(x => x.id === id);
    if (!r) return;
    modalId = id;
    const isSaved = saved.has(id);
    const isOwner = userIsOwner();
    const version = r.version ? '<span class="m-version mono">' + esc(r.version) + '</span>' : '';
    const by = r.creator ? '<span>by ' + esc(r.creator) + '</span>' : '';
    const ownerModalActions = isOwner ? `
      <button type="button" class="btn btn-ghost btn-sm" id="modalOwnerEditBtn" style="color:#38bdf8;border-color:rgba(56,189,248,0.3);">⚙️ Edit Post</button>
      <button type="button" class="btn btn-danger btn-sm" id="modalOwnerDeleteBtn">🗑️ Delete Post</button>
    ` : '';
    modalBox.innerHTML =
      '<button class="close-x modal-close" aria-label="Close"></button>' +
      stageHTML(r) +
      '<div class="m-body">' +
        '<div class="m-title-row"><h2 class="m-title">' + esc(r.title) + '</h2>' + version + '</div>' +
        '<p class="m-desc">' + esc(r.desc) + '</p>' +
        /* Downloads first: the file rows must be reachable without scrolling
           past the tabs, so nobody hunts for the button below the fold. */
        '<section class="dl-block">' +
          '<p class="section-label section-label--tight">Downloads</p>' +
          '<p class="dl-note">' + (auth.state === VERIFIED
            ? 'Downloads are unlocked for your verified account.'
            : 'Browsing is open to everyone. Sign in with Discord and join the Kyro server to unlock the download buttons.') + '</p>' +
          '<div class="dl-zone"></div>' +
        '</section>' +
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
        checksumHTML(r) +
        '<div class="m-actions">' +
          '<button class="save-btn' + (isSaved ? ' is-saved' : '') + '" data-save="' + esc(r.id) + '" aria-pressed="' + isSaved + '" aria-label="Save to vault">' + ICON.bookmark + '</button>' +
          '<a class="btn btn-ghost" href="' + INVITE_URL + '" target="_blank" rel="noopener noreferrer">' + ICON.discord + 'Server</a>' +
          ownerModalActions +
        '</div>' +
      '</div>';

    // tabs
    modalBox.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => {
      modalTab = tab.dataset.tab;
      syncTabs();
    }));
    modalBox.querySelector('.modal-close').addEventListener('click', closeModal);
    modalBox.querySelector('.save-btn').addEventListener('click', (e) => toggleSave(r.id, e.currentTarget));

    if (isOwner) {
      modalBox.querySelector('#modalOwnerEditBtn')?.addEventListener('click', () => {
        closeModal();
        openOwnerEditModal(r.id);
      });
      modalBox.querySelector('#modalOwnerDeleteBtn')?.addEventListener('click', () => {
        handleOwnerCardDelete(r.id);
      });
    }

    wireDownloads(r);
    const checksumCopy = modalBox.querySelector('[data-checksum-copy]');
    if (checksumCopy) checksumCopy.addEventListener('click', () => copyText(checksumCopy, checksumCopy.dataset.checksumCopy, 'Checksum copied', 'Compare it with your local SHA-256 result.'));

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

    // Update URL hash without jumping so link is always copyable and shareable
    try {
      history.replaceState(null, '', '#' + r.id);
    } catch {}
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
    try {
      if (location.hash && location.hash !== '#login') {
        history.replaceState(null, '', location.pathname + location.search);
      }
    } catch {}
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
    [softwareGrid, toolsGrid, coursesGrid, recentGrid].forEach(grid => {
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
        title: 'Sign in to download',
        sub: access().prompt,
        icon: ICON.lock, warn: true, ttl: 7000,
        actions: [
          { label: 'Sign in with Discord', onClick: startLogin },
          { label: 'Join the Kyro Discord', href: INVITE_URL }
        ]
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
        sub: 'Downloads need a Kyro Discord membership. Join the server, then refresh verification.',
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

  /* Asks the worker for the real archive URL. Only a verified member gets an
     answer, and a staged incoming release is refused until it is released. */
  async function requestLink(r, name, btn) {
    if (btn.disabled) return;
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = ICON.download + 'Preparing…';
    try {
      const res = await fetch(AUTH_WORKER_URL + '/vault/link', {
        method: 'POST',
        headers: Object.assign({ 'content-type': 'application/json' }, reqHeaders()),
        credentials: 'omit',
        body: JSON.stringify({ id: r.id, name })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.url) {
        toast({
          title: res.status === 403 ? 'Not live yet' : 'Link unavailable',
          sub: data.error || 'Try again in a moment.', icon: ICON.lock, warn: true, ttl: 6500
        });
        return;
      }
      const openUrl = safeHref(data.url);
      if (!openUrl) {
        toast({ title: 'Link unavailable', sub: 'That download link is not valid.', icon: ICON.lock, warn: true });
        return;
      }
      countDownload(r);
      recordDownloadHistory(r, { ext: 'link', name: r.title, size: 'External' });
      if (data.pass) {
        toast({
          title: 'Archive password: ' + data.pass,
          sub: 'Paste it when the archive asks.', icon: ICON.check, ttl: 10000,
          actions: [{ label: 'Copy password', onClick: () => navigator.clipboard && navigator.clipboard.writeText(data.pass) }]
        });
      }
      window.open(openUrl, '_blank', 'noopener,noreferrer');
    } catch (err) {
      toast({ title: 'Link unavailable', sub: 'Check your connection and try again.', icon: ICON.lock, warn: true });
    } finally {
      btn.disabled = false;
      btn.innerHTML = original;
    }
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
        recordDownloadHistory(r, file);
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
      const href = safeHref(a.href);
      const b = href
        ? Object.assign(document.createElement('a'), { href, target: '_blank', rel: 'noopener noreferrer' })
        : Object.assign(document.createElement('button'), { type: 'button' });
      b.className = 'btn btn-sm ' + (href ? 'btn-discord' : 'btn-ghost');
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
    const drawerOpen = [drawer, requestsDrawer, feedbackDrawer].some(d => d && d.classList.contains('is-open'));
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

  const ownerEditModalOverlay = $('#ownerEditModalOverlay');
  const ownerEditModalClose = $('#ownerEditModalClose');
  const ownerEditModalForm = $('#ownerEditModalForm');
  const oemCancelBtn = $('#oemCancelBtn');
  const oemSaveBtn = $('#oemSaveBtn');

  function openOwnerEditModal(resourceId) {
    const r = resources.find(x => x.id === resourceId);
    if (!r) return;
    const oemId = $('#oemId');
    const oemTitle = $('#oemTitle');
    const oemSize = $('#oemSize');
    const oemCategory = $('#oemCategory');
    const oemDownloadUrl = $('#oemDownloadUrl');
    const oemPassword = $('#oemPassword');
    const oemImageUrl = $('#oemImageUrl');
    const oemDetails = $('#oemDetails');
    const oemReleaseAt = $('#oemReleaseAt');

    if (oemId) oemId.value = r.cloud_id || r.id;
    if (oemTitle) oemTitle.value = r.title || '';
    if (oemSize) oemSize.value = (r.files && r.files[0] && r.files[0].size) || r.size || '';
    if (oemCategory) oemCategory.value = r.category || '';
    if (oemDownloadUrl) oemDownloadUrl.value = (r.files && r.files[0] && r.files[0].url) || '';
    if (oemPassword) oemPassword.value = (r.files && r.files[0] && r.files[0].pass) || '';
    if (oemImageUrl) oemImageUrl.value = (r.gallery && r.gallery[0]) || '';
    if (oemDetails) oemDetails.value = r.desc || '';
    if (oemReleaseAt) {
      if (r.releaseAt) {
        try {
          const d = new Date(r.releaseAt);
          // Format as YYYY-MM-DDTHH:mm for datetime-local
          const pad = n => String(n).padStart(2, '0');
          oemReleaseAt.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
        } catch {
          oemReleaseAt.value = '';
        }
      } else {
        oemReleaseAt.value = '';
      }
    }

    if (ownerEditModalOverlay) showOverlay(ownerEditModalOverlay);
  }

  function closeOwnerEditModal() {
    if (ownerEditModalOverlay) hideOverlay(ownerEditModalOverlay);
  }

  ownerEditModalClose?.addEventListener('click', closeOwnerEditModal);
  oemCancelBtn?.addEventListener('click', closeOwnerEditModal);
  ownerEditModalOverlay?.addEventListener('click', (e) => {
    if (e.target === ownerEditModalOverlay) closeOwnerEditModal();
  });

  // Countdown adjust buttons in Owner Edit Modal
  $('#oemClearCountdown')?.addEventListener('click', () => {
    const inp = $('#oemReleaseAt');
    if (inp) inp.value = '';
  });

  document.querySelectorAll('[data-oem-adjust]').forEach(btn => {
    btn.addEventListener('click', () => {
      const inp = $('#oemReleaseAt');
      if (!inp) return;
      const deltaSec = parseInt(btn.dataset.oemAdjust, 10) || 0;
      let currentMs = inp.value ? new Date(inp.value).getTime() : Date.now();
      if (isNaN(currentMs)) currentMs = Date.now();
      const nextDate = new Date(currentMs + deltaSec * 1000);
      const pad = n => String(n).padStart(2, '0');
      inp.value = `${nextDate.getFullYear()}-${pad(nextDate.getMonth() + 1)}-${pad(nextDate.getDate())}T${pad(nextDate.getHours())}:${pad(nextDate.getMinutes())}`;
    });
  });

  ownerEditModalForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!userIsOwner()) return;
    const id = $('#oemId')?.value;
    const title = $('#oemTitle')?.value.trim();
    const size = $('#oemSize')?.value.trim();
    const category = $('#oemCategory')?.value.trim();
    const download_url = $('#oemDownloadUrl')?.value.trim();
    const password = $('#oemPassword')?.value.trim();
    const image_url = $('#oemImageUrl')?.value.trim();
    const details = $('#oemDetails')?.value.trim();
    const release_at = $('#oemReleaseAt')?.value ? new Date($('#oemReleaseAt').value).toISOString() : null;

    if (!id || !title) {
      toast({ title: 'Validation error', sub: 'Title and resource ID are required.', icon: ICON.x });
      return;
    }

    if (oemSaveBtn) {
      oemSaveBtn.disabled = true;
      oemSaveBtn.textContent = 'Saving…';
    }

    try {
      const res = await fetch(AUTH_WORKER_URL + '/vault/submissions/manage', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + auth.token },
        body: JSON.stringify({
          id,
          title,
          size,
          category,
          download_url,
          password,
          image_url,
          details,
          release_at
        }),
        credentials: 'omit'
      });
      if (res.ok) {
        toast({ title: 'Resource Updated', sub: 'Post modifications saved and synced to Discord.', icon: ICON.check });
        closeOwnerEditModal();
        await loadPublicVaultItems();
        if (modalId) openModal(modalId);
      } else {
        const err = await res.json().catch(() => ({}));
        toast({ title: 'Update failed', sub: err.error || 'Server error', icon: ICON.x });
      }
    } catch (err) {
      toast({ title: 'Error', sub: err.message, icon: ICON.x });
    } finally {
      if (oemSaveBtn) {
        oemSaveBtn.disabled = false;
        oemSaveBtn.textContent = 'Save & Update Live Post';
      }
    }
  });

  async function handleOwnerCardDelete(resourceId) {
    if (!userIsOwner()) return;
    const r = resources.find(x => x.id === resourceId);
    const title = r ? r.title : resourceId;
    if (!confirm(`Are you sure you want to permanently delete "${title}" from the Kyro Vault website and Discord?`)) return;

    const t = toast({ title: 'Deleting resource…', sub: title, progress: true, ttl: 0 });
    try {
      const res = await fetch(AUTH_WORKER_URL + '/vault/submissions/manage', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + auth.token },
        body: JSON.stringify({ id: (r && r.cloud_id) || resourceId, title, catalogue: !r || !r.cloud_id }),
        credentials: 'omit'
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.deleted) {
        if (modalId === resourceId) closeModal();
        // Hide locally immediately. The worker also stores a tombstone so the
        // seed catalogue cannot put the card back on the next refresh.
        hiddenResources.add(String(resourceId).toLowerCase());
        if (r && r.cloud_id) hiddenResources.add(String(r.cloud_id).toLowerCase());
        resources = resources.filter(x => x.id !== resourceId && (!r || !r.cloud_id || x.cloud_id !== r.cloud_id));
        renderSoftware();
        renderCategoryHead();
        renderBrowse();
        await loadPublicVaultItems();
        t.finish(
          'Resource Deleted',
          data.catalogue
            ? `"${title}" has been removed from the website.`
            : `"${title}" has been removed from the website and Discord.`
        );
      } else {
        t.finish('Delete failed', data.error || (res.ok ? 'That resource was not found.' : 'Could not delete resource.'));
      }
    } catch (err) {
      t.finish('Error', err.message);
    }
  }

  /* ------------------------------ global events ------------------------- */
  /* Both shelves behave identically; the vault page has neither, so the list
     it binds is simply empty there. */
  [softwareGrid, toolsGrid, coursesGrid, recentGrid].forEach(grid => {
    if (!grid) return;
    grid.addEventListener('click', (e) => {
      const editBtn = e.target.closest('[data-card-edit]');
      if (editBtn) {
        e.stopPropagation();
        e.preventDefault();
        openOwnerEditModal(editBtn.dataset.cardEdit);
        return;
      }
      const delBtn = e.target.closest('[data-card-delete]');
      if (delBtn) {
        e.stopPropagation();
        e.preventDefault();
        handleOwnerCardDelete(delBtn.dataset.cardDelete);
        return;
      }
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

  /* The compact AppleFX row below Recently added opens the same listing modal
     as its card, so downloads, previews and guides stay in one place. */
  if (applefxRow) {
    applefxRow.addEventListener('click', () => {
      const id = applefxRow.dataset.resource;
      if (id) openModal(id);
    });
  }

  const requestsBtn = $('#requestsOpen');
  if (requestsBtn) {
    requestsBtn.addEventListener('click', () =>
      requestsDrawer.classList.contains('is-open') ? closeRequests() : openRequests());
  }
  const requestsCloseBtn = $('#requestsClose');
  if (requestsCloseBtn) requestsCloseBtn.addEventListener('click', closeRequests);

  const feedbackBtn = $('#feedbackOpen');
  if (feedbackBtn) {
    feedbackBtn.addEventListener('click', () =>
      feedbackDrawer.classList.contains('is-open') ? closeFeedback() : openFeedback());
  }
  const feedbackCloseBtn = $('#feedbackClose');
  if (feedbackCloseBtn) feedbackCloseBtn.addEventListener('click', closeFeedback);

  drawerScrim.addEventListener('click', () => {
    if (requestsDrawer && requestsDrawer.classList.contains('is-open')) closeRequests();
    else if (feedbackDrawer && feedbackDrawer.classList.contains('is-open')) closeFeedback();
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
      else if (feedbackDrawer && feedbackDrawer.classList.contains('is-open')) closeFeedback();
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
  window.KyroAuth = {
    profile: () => auth.state === OUT ? null : { ...auth.user, verified: auth.state === VERIFIED },
    login: startLogin,
    refresh: recheckMembership,
    invite: INVITE_URL,
    request: (route, options = {}) => {
      const headers = new Headers(options.headers);
      if (auth.token) headers.set('authorization', 'Bearer ' + auth.token);
      return fetch(AUTH_WORKER_URL + route, { ...options, headers, credentials: 'omit' });
    }
  };
  renderAccess();
  wireCourseFilters();
  renderSoftware();
  renderCategoryHead();
  renderBrowse();
  loadIncomingReleases();
  loadEarlyAccess();
  renderReqCategories();
  wireRequestControls();
  initFeedbackDrawer();
  wireAccountModal();
  updateSavedUI();
  startServerStats();
  refreshDiscordRole();

  function checkUrlDeepLink() {
    const hash = location.hash;
    if (hash === '#login') {
      if (auth.state === OUT) startLogin();
      return;
    }
    /* The support bot links here — before this, #feedback opened nothing. */
    if (hash === '#feedback') {
      openFeedback();
      return;
    }
    if (hash) {
      let rawId = decodeURIComponent(hash.replace(/^#(r-)?/, '')).trim().toLowerCase();
      if (rawId) {
        const match = resources.find(r => r.id.toLowerCase() === rawId || r.title.toLowerCase().replace(/[^a-z0-9]+/g, '-') === rawId);
        if (match) openModal(match.id);
      }
    }
  }

  window.addEventListener('hashchange', checkUrlDeepLink);
  checkUrlDeepLink();
})();
