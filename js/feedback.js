(function () {
  'use strict';

  const AUTH_WORKER_URL = 'https://kyro-auth.kyro-ownr.workers.dev';
  const K_AUTH = 'kyro.auth.v1';
  const K_STATE = 'kyro.oauth.state.v1';
  const K_RETURN = 'kyro.oauth.return.v1';
  const OUT = 0, LOGGED = 1, VERIFIED = 2;

  function captureOAuthCallback() {
    try {
      const q = new URLSearchParams(location.search);
      if (!q.has('token') && !q.has('username')) return;

      const returned = q.get('state');
      const expected = sessionStorage.getItem(K_STATE);
      sessionStorage.removeItem(K_STATE);

      // Save credentials into localStorage
      const username = q.get('username') || 'editor';
      const inServer = q.get('in_server');
      const authData = {
        state: inServer === 'true' ? VERIFIED : LOGGED,
        user: {
          username,
          id: q.get('id') || '',
          avatar: q.get('avatar') || '',
          initials: username.slice(0, 1).toUpperCase()
        },
        token: q.get('token') || ''
      };
      localStorage.setItem(K_AUTH, JSON.stringify(authData));
      window.history.replaceState({}, '', location.pathname);
    } catch (e) {
      console.warn('[feedback-auth]', e);
    }
  }
  captureOAuthCallback();

  function readAuth() {
    try {
      const raw = localStorage.getItem(K_AUTH);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch { return null; }
  }

  let auth = readAuth();
  let isVerified = Boolean(auth && (auth.state === VERIFIED || auth.state === 2 || auth.verified === true));

  const gate = document.querySelector('#feedbackGate');
  const container = document.querySelector('#feedbackContainer');
  const gateLoginBtn = document.querySelector('#gateLoginBtn');
  const authSlot = document.querySelector('#authSlot');
  const fbForm = document.querySelector('#fbForm');
  const fbText = document.querySelector('#fbText');
  const fbImprovements = document.querySelector('#fbImprovements');
  const fbAnonymous = document.querySelector('#fbAnonymous');
  const fbSubmitBtn = document.querySelector('#fbSubmitBtn');
  const fbReviewsList = document.querySelector('#fbReviewsList');
  const fbListCount = document.querySelector('#fbListCount');
  const ratingBtns = document.querySelectorAll('#fbRatingBtns [data-stars]');

  let currentStars = 5;

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function startLogin() {
    sessionStorage.setItem(K_RETURN, location.href);
    const state = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
    sessionStorage.setItem(K_STATE, state);
    const clientId = '1570702041993711706';
    const redirectUri = encodeURIComponent(AUTH_WORKER_URL + '/callback');
    const scope = encodeURIComponent('identify guilds');
    location.assign('https://discord.com/api/oauth2/authorize?client_id=' + clientId +
      '&redirect_uri=' + redirectUri +
      '&response_type=code&scope=' + scope +
      '&state=' + encodeURIComponent(state));
  }

  if (gateLoginBtn) gateLoginBtn.addEventListener('click', startLogin);

  // Render top right auth button
  function renderNavAuth() {
    if (!authSlot) return;
    if (auth && auth.user && isVerified) {
      const avatarUrl = auth.user.avatar
        ? 'https://cdn.discordapp.com/avatars/' + auth.user.id + '/' + auth.user.avatar + '.png?size=32'
        : '';
      const avatarEl = avatarUrl
        ? '<img src="' + escapeHtml(avatarUrl) + '" alt="" style="width:20px;height:20px;border-radius:50%;object-fit:cover;" />'
        : '';
      authSlot.innerHTML =
        '<div class="auth-pill" style="display:flex;align-items:center;gap:6px;padding:4px 10px;background:var(--panel);border:1px solid var(--line);font-size:0.75rem;">' +
          avatarEl +
          '<span class="mono">' + escapeHtml(auth.user.username) + '</span>' +
          '<span class="badge badge-free" style="font-size:0.55rem;padding:1px 4px;">VERIFIED</span>' +
        '</div>';
    } else {
      authSlot.innerHTML =
        '<button type="button" class="btn btn-discord btn-sm mono" id="topNavLogin">' +
          'Sign in with Discord' +
        '</button>';
      const topBtn = document.querySelector('#topNavLogin');
      if (topBtn) topBtn.addEventListener('click', startLogin);
    }
  }

  // Star selector
  ratingBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      currentStars = Number(btn.dataset.stars) || 5;
      ratingBtns.forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.stars) === currentStars)));
    });
  });

  // Render Reviews
  function renderReviews(items) {
    if (!fbListCount || !fbReviewsList) return;
    fbListCount.textContent = items.length + (items.length === 1 ? ' review' : ' reviews');

    if (!items.length) {
      fbReviewsList.innerHTML = '<div class="req-empty mono" style="padding:40px;background:var(--panel);border:1px solid var(--line);text-align:center;color:var(--dim);">No reviews yet. Be the first to share your thoughts!</div>';
      return;
    }

    const starStr = (r) => '★'.repeat(r) + '☆'.repeat(5 - r);
    fbReviewsList.innerHTML = items.map(item => {
      const avatarHtml = item.anonymous || !item.author_avatar
        ? '<div class="fb-avatar">?</div>'
        : '<img class="fb-avatar" src="' + escapeHtml(item.author_avatar) + '" alt="" />';
      const name = item.anonymous ? 'Anonymous Editor' : escapeHtml(item.author_name);
      const stars = starStr(item.rating);
      const date = item.created ? new Date(item.created).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
      const improvementsHtml = item.improvements
        ? '<div class="fb-improvements">' +
            '<span class="fb-improvements-label mono">Requested Improvements:</span>' +
            escapeHtml(item.improvements) +
          '</div>'
        : '';

      return '<article class="fb-item">' +
        '<div class="fb-item-head">' +
          '<div class="fb-user">' +
            avatarHtml +
            '<span class="mono" style="font-weight:600;font-size:0.85rem;color:var(--white);">' + name + '</span>' +
          '</div>' +
          '<div style="text-align:right;">' +
            '<div class="fb-stars">' + stars + '</div>' +
            '<div class="fb-date mono">' + date + '</div>' +
          '</div>' +
        '</div>' +
        '<p class="fb-text">' + escapeHtml(item.feedback) + '</p>' +
        improvementsHtml +
      '</article>';
    }).join('');
  }

  // Load reviews from Cloudflare Worker
  async function loadFeedback() {
    auth = readAuth();
    isVerified = Boolean(auth && (auth.state === VERIFIED || auth.state === 2 || auth.verified === true));
    renderNavAuth();
    if (!isVerified) {
      gate.hidden = false;
      container.hidden = true;
      return;
    }

    gate.hidden = true;
    container.hidden = false;
    fbReviewsList.innerHTML = '<div class="req-empty mono" style="padding:20px;color:var(--dim);">Loading feedback…</div>';

    try {
      const headers = { 'Accept': 'application/json' };
      if (auth.token) headers['Authorization'] = 'Bearer ' + auth.token;
      const res = await fetch(AUTH_WORKER_URL + '/feedback', { headers, credentials: 'omit' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load feedback');
      renderReviews(Array.isArray(data.feedback) ? data.feedback : []);
    } catch (err) {
      fbReviewsList.innerHTML = '<div class="req-empty mono" style="padding:20px;color:#ef4444;">Error loading reviews: ' + escapeHtml(err.message) + '</div>';
    }
  }

  // Submit new review
  if (fbForm) {
    fbForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!isVerified) {
        startLogin();
        return;
      }

      const text = fbText.value.trim();
      if (text.length < 5) {
        alert('Please provide feedback of at least 5 characters.');
        return;
      }

      const improvements = fbImprovements.value.trim();
      const anonymous = fbAnonymous.checked;

      if (fbSubmitBtn) {
        fbSubmitBtn.disabled = true;
        fbSubmitBtn.textContent = 'Posting review…';
      }

      try {
        const headers = {
          'Content-Type': 'application/json'
        };
        if (auth.token) headers['Authorization'] = 'Bearer ' + auth.token;
        const res = await fetch(AUTH_WORKER_URL + '/feedback', {
          method: 'POST',
          headers,
          credentials: 'omit',
          body: JSON.stringify({
            rating: currentStars,
            feedback: text,
            improvements,
            anonymous
          })
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to post feedback');

        fbForm.reset();
        currentStars = 5;
        ratingBtns.forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.stars) === 5)));
        renderReviews(Array.isArray(data.feedback) ? data.feedback : []);
      } catch (err) {
        alert('Could not post feedback: ' + err.message);
      } finally {
        if (fbSubmitBtn) {
          fbSubmitBtn.disabled = false;
          fbSubmitBtn.textContent = 'Post Review';
        }
      }
    });
  }

  // Footer live timestamp
  const two = (n) => String(n).padStart(2, '0');
  const stamp = document.querySelector('#siteUpdated');
  if (stamp) {
    function tick() {
      const d = new Date();
      stamp.textContent = d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()) +
        ' ' + two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds());
    }
    tick();
    setInterval(tick, 1000);
  }

  loadFeedback();
})();
