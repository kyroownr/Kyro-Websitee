(function () {
  'use strict';

  const auth = window.KyroAuth;
  const gate = document.querySelector('#feedbackGate');
  const container = document.querySelector('#feedbackContainer');
  const gateLoginBtn = document.querySelector('#gateLoginBtn');
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

  if (gateLoginBtn) gateLoginBtn.addEventListener('click', () => auth && auth.login());

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

  // Load reviews using KyroAuth
  async function loadFeedback() {
    const profile = auth && auth.profile();
    const isVerified = Boolean(profile && profile.verified);

    if (!isVerified) {
      gate.hidden = false;
      container.hidden = true;
      return;
    }

    gate.hidden = true;
    container.hidden = false;
    fbReviewsList.innerHTML = '<div class="req-empty mono" style="padding:20px;color:var(--dim);">Loading feedback…</div>';

    try {
      const res = await auth.request('/feedback');
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
      const profile = auth && auth.profile();
      if (!profile || !profile.verified) {
        auth && auth.login();
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
        const res = await auth.request('/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
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

  // React to auth updates from app.js
  window.addEventListener('kyro:auth', loadFeedback);

  loadFeedback();
})();
