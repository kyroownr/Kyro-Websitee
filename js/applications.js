(function () {
  'use strict';
  const auth = window.KyroAuth;
  const status = document.querySelector('#applicationsStatus');
  const trigger = document.querySelector('#applyOpen');
  const view = document.querySelector('#applyView');
  const tabs = document.querySelector('#applyRoles');
  const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const profileKey = () => { const profile = auth.profile(); return profile ? profile.id + ':' + profile.verified : ''; };
  let config, selected, generation = 0, currentProfile = profileKey();

  async function request(route, options) {
    const result = await auth.request(route, options);
    const data = await result.json().catch(() => ({}));
    if (!result.ok) throw Object.assign(new Error(data.error || 'Could not load applications. Try again.'), { status: result.status, code: data.code, application: data.application });
    return data;
  }

  if (trigger) {
    trigger.addEventListener('click', async () => {
      status.showModal();
      const message = document.querySelector('#applicationsStatusText');
      message.textContent = 'Checking application status…';
      try {
        const data = await request('/applications/config');
        message.textContent = data.open ? 'Applications are open! Fill out the form to apply.' : 'Applications are currently closed. Check back soon.';
      } catch { message.textContent = 'Application status is unavailable. Please check back soon.'; }
    });
    status.addEventListener('click', event => {
      const bounds = status.getBoundingClientRect();
      if (event.target === status && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) status.close();
    });
  }
  if (!view) return;

  function urlState(values, push = false) {
    const url = new URL(location.href);
    url.search = '';
    url.searchParams.set('role', selected.id);
    for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value);
    history[push ? 'pushState' : 'replaceState']({}, '', url.pathname + url.search);
  }

  function renderTabs() {
    tabs.innerHTML = config.roles.map(role => '<button type="button" class="application-role application-pill" data-role="' + role.id + '" aria-pressed="' + (role.id === selected.id) + '">' + escape(role.title) + '</button>').join('');
  }

  function requirements() {
    generation++;
    renderTabs();
    view.innerHTML = '<section class="application-card" aria-labelledby="applicationRoleTitle"><p class="section-label">Requirements</p><h2 id="applicationRoleTitle">' + escape(selected.title) + '</h2><p class="application-lede">' + escape(selected.description) + '</p><ul class="application-requirements">' + selected.requirements.map(rule => '<li>' + escape(rule) + '</li>').join('') + '</ul>' + (!config.open ? '<p class="application-note" role="status">Applications are currently closed. Check back soon.</p>' : '') + '<div class="application-actions"><button type="button" class="btn btn-primary application-pill" id="applyNow"' + (!config.open ? ' disabled' : '') + '>Apply Now -&gt;</button><a class="application-back" href="/">&lt;- Back to home</a></div></section>';
    document.querySelector('#applyNow').addEventListener('click', () => { urlState({ form: '1' }, true); renderForm(); });
  }

  function gate(message, login) {
    view.innerHTML = '<section class="application-card"><p class="section-label">' + escape(selected.title) + '</p><h2>Verify with Discord</h2><p class="application-lede">' + escape(message) + '</p><div class="application-actions">' + (login ? '<button type="button" class="btn btn-primary application-pill" id="applicationLogin">Login with Discord</button>' : '<a class="btn btn-primary application-pill" href="' + escape(auth.invite) + '" target="_blank" rel="noopener noreferrer">Join the Kyro Discord</a><button type="button" class="btn btn-ghost application-pill" id="applicationRefresh">Refresh Verification</button>') + '<button type="button" class="application-back" data-requirements>&lt;- Back to requirements</button></div></section>';
    document.querySelector('#applicationLogin')?.addEventListener('click', auth.login);
    document.querySelector('#applicationRefresh')?.addEventListener('click', async () => { await auth.refresh(); renderForm(); });
  }

  function fieldMarkup(field, profile) {
    const label = escape(field.label);
    const name = escape(field.id);
    const required = field.required ? ' required' : '';
    const id = 'application-' + name;
    if (field.type === 'checkbox') return '<label class="application-agreement"><input type="checkbox" name="' + name + '" id="' + id + '" required /><span>' + label + '</span></label>';
    const attributes = ' class="field-input" name="' + name + '" id="' + id + '"' + required + (field.minLength ? ' minlength="' + field.minLength + '"' : '') + (field.maxLength ? ' maxlength="' + field.maxLength + '"' : '');
    let input;
    if (field.type === 'textarea') input = '<textarea' + attributes + ' rows="4"></textarea>';
    else if (field.type === 'select') input = '<select' + attributes + '>' + field.options.map(option => '<option value="' + escape(option) + '">' + escape(option) + '</option>').join('') + '</select>';
    else input = '<input' + attributes + ' type="' + escape(field.type) + '"' + (field.type === 'number' ? ' min="' + field.min + '" max="' + field.max + '" step="1" inputmode="numeric"' : '') + (field.id === 'handle' ? ' value="' + escape(profile.username) + '" autocomplete="nickname"' : '') + ' />';
    return '<label class="field" for="' + id + '"><span class="field-label mono">' + label + (field.required ? ' *' : '') + '</span>' + input + '</label>';
  }

  async function renderForm() {
    const current = ++generation;
    renderTabs();
    if (!config.open) { requirements(); return; }
    if (!auth.profile()) { gate('Sign in to verify your real Discord username, User ID, and server membership before applying.', true); return; }
    view.innerHTML = '<p class="application-note" role="status">Verifying your Discord account…</p>';
    try {
      const data = await request('/applications');
      if (current !== generation) return;
      const accountAge = Date.now() - Date.parse(data.profile.account_created);
      if (accountAge < config.accountDays * 86400000) {
        view.innerHTML = '<section class="application-card"><h2>Your Discord account is too new</h2><p class="application-lede">Your account must be at least ' + config.accountDays + ' days old to apply.</p><button type="button" class="application-back" data-requirements>&lt;- Back to requirements</button></section>';
        return;
      }
      const existing = data.applications.find(application => application.role === selected.id && ['queued', 'pending', 'needs_attention'].includes(application.status));
      if (existing) { urlState({ application: existing.id }); receipt(existing); return; }
      view.innerHTML = '<section class="application-card"><p class="section-label">Application</p><h2>' + escape(selected.title) + '</h2><div class="application-identity"><span class="section-label">Verified Discord account</span><strong>' + escape(data.profile.tag) + '</strong><span class="mono">User ID: ' + escape(data.profile.id) + '</span><span>Account created: ' + escape(data.profile.account_created.slice(0, 10)) + ' (UTC)</span></div><p class="application-note">Use a handle, not a legal name. Do not include passwords, private documents, or other people’s personal information. Your answers are shared with permitted Discord staff, not published on the website.</p><form class="application-fields" id="applicationForm">' + selected.fields.map(field => fieldMarkup(field, data.profile)).join('') + '<p class="application-error" id="applicationError" role="alert" hidden></p><div class="application-actions"><button type="submit" class="btn btn-primary application-pill" id="applicationSubmit">Submit Application</button><button type="button" class="application-back" data-requirements>&lt;- Back to requirements</button></div></form></section>';
      document.querySelector('#applicationForm').addEventListener('submit', submit);
    } catch (err) {
      if (current !== generation) return;
      if (err.status === 401) gate('Your Discord session expired. Sign in again to apply.', true);
      else if (err.status === 403) gate('Join the Kyro Discord server, then refresh your verification.', false);
      else failure(err.message, renderForm);
    }
  }

  async function submit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const button = document.querySelector('#applicationSubmit');
    const message = document.querySelector('#applicationError');
    const current = generation;
    const role = selected.id;
    const answers = {};
    for (const field of selected.fields) {
      const input = form.elements.namedItem(field.id);
      answers[field.id] = field.type === 'checkbox' ? input.checked : field.type === 'number' ? Number(input.value) : input.value.trim();
    }
    button.disabled = true; button.textContent = 'Submitting…'; message.hidden = true;
    try {
      const data = await request('/applications', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role, answers }) });
      if (current !== generation) return;
      urlState({ application: data.application.id });
      receipt(data.application);
    } catch (err) {
      if (current !== generation) return;
      if (err.code === 'duplicate_application' && err.application) { urlState({ application: err.application.id }); receipt(err.application); return; }
      message.textContent = err.message; message.hidden = false;
      button.disabled = false; button.textContent = 'Submit Application';
    }
  }

  function receiptMarkup(application) {
    const labels = { queued: ['Application received', 'Your application is saved. Your private review channel is being prepared.'], pending: ['Application submitted', 'Your application is in private review. It is not published on the website.'], approved: ['Application approved', 'Staff have approved your application. Approval does not automatically assign a Discord role.'], declined: ['Application declined', 'Staff have reviewed your application and declined it.'], needs_attention: ['Application saved', 'Discord delivery needs staff attention. Do not submit another application for this role.'] };
    const copy = labels[application.status] || labels.queued;
    return '<section class="application-card application-receipt" aria-live="polite"><p class="section-label">' + escape(selected.title) + '</p><span class="application-badge mono">' + escape(application.status.replace(/_/g, ' ')) + '</span><h2>' + copy[0] + '</h2><p class="application-lede">' + copy[1] + '</p><p class="application-reference mono">Reference: ' + escape(application.id) + '</p><div class="application-actions"><button type="button" class="btn btn-ghost application-pill" id="applicationCheck">Check Status</button>' + (application.interview_url ? '<a class="btn btn-primary application-pill" href="' + escape(application.interview_url) + '" target="_blank" rel="noopener noreferrer">Open Discord Interview</a>' : '') + '<a class="application-back" href="/">&lt;- Back to home</a></div><p class="application-error" id="applicationStatusError" role="alert" hidden></p></section>';
  }

  function receipt(application) {
    const current = ++generation;
    renderTabs();
    view.innerHTML = receiptMarkup(application);
    document.querySelector('#applicationCheck').addEventListener('click', () => checkStatus(application.id, current));
    if (application.status === 'queued') {
      (async () => {
        for (let attempt = 0; attempt < 6 && current === generation; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 3000));
          if (current !== generation) return;
          const updated = await checkStatus(application.id, current);
          if (!updated || updated.status !== 'queued') return;
        }
      })();
    }
  }

  async function checkStatus(id, current) {
    try {
      const data = await request('/applications/status?id=' + encodeURIComponent(id));
      if (current !== generation) return null;
      if (data.application.status !== 'queued') receipt(data.application);
      return data.application;
    } catch (err) {
      if (current !== generation) return null;
      const message = document.querySelector('#applicationStatusError');
      message.textContent = err.message; message.hidden = false;
      return null;
    }
  }

  function failure(message, retry) {
    view.innerHTML = '<section class="application-card"><h2>Applications unavailable</h2><p class="application-lede" role="alert">' + escape(message) + '</p><button type="button" class="btn btn-ghost application-pill" id="applicationRetry">Try Again</button></section>';
    document.querySelector('#applicationRetry').addEventListener('click', retry);
  }

  async function restore() {
    generation++;
    const parameters = new URLSearchParams(location.search);
    selected = config.roles.find(role => role.id === parameters.get('role')) || config.roles[0];
    renderTabs();
    const applicationId = parameters.get('application');
    if (applicationId) {
      if (!auth.profile()) { gate('Sign in with the Discord account used for this application to check its status.', true); return; }
      const current = ++generation;
      try {
        const data = await request('/applications/status?id=' + encodeURIComponent(applicationId));
        if (current === generation) receipt(data.application);
      } catch (err) { if (current === generation) failure(err.message, restore); }
    } else if (parameters.get('form') === '1') renderForm();
    else requirements();
  }

  tabs.addEventListener('click', event => {
    const button = event.target.closest('[data-role]');
    if (!button) return;
    selected = config.roles.find(role => role.id === button.dataset.role);
    urlState({}); requirements();
  });
  view.addEventListener('click', event => {
    if (event.target.closest('[data-requirements]')) { urlState({}); requirements(); }
  });
  window.addEventListener('popstate', () => { if (config) restore(); });
  window.addEventListener('kyro:auth', () => {
    const nextProfile = profileKey();
    if (nextProfile === currentProfile) return;
    currentProfile = nextProfile;
    if (config && (new URLSearchParams(location.search).has('form') || new URLSearchParams(location.search).has('application'))) restore();
  });
  async function boot() {
    view.innerHTML = '<p class="application-note" role="status">Loading application roles…</p>';
    try { config = await request('/applications/config'); await restore(); }
    catch (err) { failure(err.message, boot); }
  }
  boot();
})();
