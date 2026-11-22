/* Auth state for the static pages (EasyKyro, Guide, About).
   These pages do not load js/app.js, so the nav used to keep saying
   "Login with Discord" even for a member who is signed in on the vault.
   The session app.js writes to localStorage is the same on every path of the
   origin, so the nav can read it here and swap the login link for the profile
   pill. Nothing is trusted beyond the display name and avatar; membership and
   role stay the vault's business. */
(function () {
  'use strict';

  var KEY = 'kyro.auth.v1';

  function readSession() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return null;
      var v = JSON.parse(raw);
      if (!v || (v.state !== 'logged' && v.state !== 'verified')) return null;
      var user = v.user && v.user.username
        ? { username: v.user.username, id: v.user.id || '', avatar: v.user.avatar || '', initials: v.user.initials || '' }
        : { username: 'editor', id: '', avatar: '', initials: 'E' };
      return { state: v.state, user: user };
    } catch (e) {
      return null;
    }
  }

  function esc(value) {
    return String(value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* Same two shapes the vault accepts: a Discord avatar hash needs the user id
     in the CDN path, a full URL is used as-is. */
  function avatarHTML(user) {
    var initials = esc(user.initials || '\u00b7');
    var src = '';
    if (user.avatar) {
      if (/^https?:\/\//i.test(user.avatar)) src = user.avatar;
      else if (user.id) src = 'https://cdn.discordapp.com/avatars/' + encodeURIComponent(user.id) + '/' +
        encodeURIComponent(user.avatar) + '.png?size=64';
    }
    return src
      ? '<img class="avatar-img" src="' + esc(src) + '" alt="" data-initials="' + initials + '">'
      : initials;
  }

  function render() {
    var session = readSession();
    if (!session) return;
    var slot = document.getElementById('authSlot');
    var loginLink = document.querySelector('.nav-right .login-btn') || document.querySelector('.login-btn');
    var verified = session.state === 'verified';

    var pill = document.createElement('a');
    pill.className = 'profile-pill';
    pill.href = '/';
    pill.title = 'Signed in as ' + session.user.username + (verified ? ' \u00b7 verified member' : '') + ' \u2014 open the vault';
    pill.setAttribute('aria-label', 'Signed in as ' + session.user.username + '. Open the vault.');
    pill.innerHTML =
      '<span class="avatar">' + avatarHTML(session.user) +
        '<i class="status-dot' + (verified ? ' is-verified' : '') + '" aria-hidden="true"></i></span>' +
      '<span class="profile-name">' + esc(session.user.username) + '</span>';

    var img = pill.querySelector('.avatar-img');
    if (img) {
      img.addEventListener('error', function () {
        img.replaceWith(document.createTextNode(img.dataset.initials || '\u00b7'));
      }, { once: true });
    }

    if (slot) {
      slot.innerHTML = '';
      slot.appendChild(pill);
    } else if (loginLink) {
      loginLink.replaceWith(pill);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render);
  else render();
})();
