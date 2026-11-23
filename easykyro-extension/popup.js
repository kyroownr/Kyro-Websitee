/* EasyKyro popup controller.
 *
 * One field does the work:
 *   1. read the page the user is on (title, meta, heading, selection, text);
 *   2. ask Gemini, with the user's own key, to write the request details;
 *   3. POST to the same Kyro worker endpoint the website uses, with the same
 *      Discord token, so the request lands on the board and in the Discord
 *      requests channel exactly like a website submission.
 *
 * The model is never chosen by hand: the popup discovers the cheapest usable
 * Gemini model for the key and caches it next to the key.
 */

const WORKER = 'https://kyro-auth.kyro-ownr.workers.dev';
const SITE = 'https://kyro.new.tg';
const INVITE = 'https://discord.gg/N3KJBSWrkR';
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';

const CATEGORIES = [
  ['extension', 'Extension'],
  ['script', 'Script'],
  ['preset', 'Preset'],
  ['project', 'Project'],
  ['soundfx', 'Sound FX'],
  ['other', 'Other']
];
const OSES = [
  ['windows', 'Windows'],
  ['macos', 'macOS'],
  ['both', 'Both']
];
const AE_VERSIONS = ['2024', '2025', '2026', 'any'];
const DEFAULT_SETTINGS = { geminiKey: '', model: '' };

/* Used only if the models list cannot be ranked — still the cheapest tier. */
const FALLBACK_MODELS = ['gemini-2.5-flash-lite', 'gemini-2.0-flash-lite', 'gemini-2.0-flash'];
const KEY_PATTERN = /^AIza[0-9A-Za-z_-]{20,}$/;

const AI_SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING' },
    category: { type: 'STRING', enum: CATEGORIES.map(([value]) => value) },
    os: { type: 'STRING', enum: OSES.map(([value]) => value) },
    ae_versions: { type: 'ARRAY', items: { type: 'STRING', enum: AE_VERSIONS } },
    reference: { type: 'STRING' },
    description: { type: 'STRING' }
  },
  required: ['title', 'category', 'os', 'ae_versions', 'reference', 'description']
};

const $ = (id) => document.getElementById(id);
const el = {
  settingsBtn: $('settingsBtn'),
  settingsPanel: $('settingsPanel'),
  closeSettings: $('closeSettings'),
  geminiKey: $('geminiKey'),
  toggleKey: $('toggleKey'),
  keyStatus: $('keyStatus'),
  disconnectBtn: $('disconnectBtn'),
  accountText: $('accountText'),
  connDot: $('connDot'),
  connText: $('connText'),
  connectBtn: $('connectBtn'),
  mainPanel: $('mainPanel'),
  pageCard: $('pageCard'),
  pageFavicon: $('pageFavicon'),
  pageTitle: $('pageTitle'),
  pageUrl: $('pageUrl'),
  refreshPage: $('refreshPage'),
  pageNote: $('pageNote'),
  form: $('reqForm'),
  title: $('title'),
  titleCount: $('titleCount'),
  similar: $('similar'),
  similarText: $('similarText'),
  similarVote: $('similarVote'),
  detailsToggle: $('detailsToggle'),
  detailsPanel: $('detailsPanel'),
  categoryChips: $('categoryChips'),
  osChips: $('osChips'),
  aeChips: $('aeChips'),
  reference: $('reference'),
  referenceNote: $('referenceNote'),
  description: $('description'),
  descCount: $('descCount'),
  draftCard: $('draftCard'),
  draftBadge: $('draftBadge'),
  draftMeta: $('draftMeta'),
  draftDesc: $('draftDesc'),
  draftState: $('draftState'),
  draftHint: $('draftHint'),
  aiBtn: $('aiBtn'),
  aiBtnText: $('aiBtnText'),
  submitBtn: $('submitBtn'),
  status: $('status'),
  successPanel: $('successPanel'),
  successCopy: $('successCopy'),
  viewBoard: $('viewBoard'),
  newRequest: $('newRequest')
};

const state = {
  auth: null,
  settings: { ...DEFAULT_SETTINGS },
  page: null,
  /* The details that will be posted: { category, os, ae[], reference, description, source } */
  ai: null,
  /* What the right-click menu saved: { url, text, at } */
  hint: null,
  busy: false,
  verifying: false,
  keyTimer: null,
  keyToken: 0,
  aiTimer: null,
  lastAiSignature: '',
  /* Detail fields the user edited by hand: the AI must not overwrite them. */
  touched: new Set(),
  board: [],
  boardLoaded: false,
  similarId: '',
  similarTimer: null,
  draftTimer: null,
  detectedOs: 'both'
};

/* ------------------------------- helpers -------------------------------- */

const escapeHtml = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const clamp = (value, max) => String(value == null ? '' : value)
  .replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, max);

function safeReference(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 500) return '';
    return url.href;
  } catch {
    return '';
  }
}

const osLabel = (value) => ({ windows: 'Windows', macos: 'macOS', both: 'Both' })[value] || 'Both';
const categoryLabel = (value) => (CATEGORIES.find(([key]) => key === value) || CATEGORIES[CATEGORIES.length - 1])[1];

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'link'; }
}

async function send(message) {
  try { return await chrome.runtime.sendMessage(message); } catch { return null; }
}

const isOffline = () => typeof navigator.onLine === 'boolean' && !navigator.onLine;

function setStatus(kind, message) {
  el.status.hidden = false;
  el.status.className = 'status ' + kind;
  el.status.innerHTML = message;
}

function clearStatus() {
  el.status.hidden = true;
  el.status.textContent = '';
  el.status.className = 'status';
}

function setKeyStatus(message, kind = '') {
  el.keyStatus.textContent = message || '';
  el.keyStatus.className = 'hint key-status' + (kind ? ' ' + kind : '');
}

function setDraftState(message) {
  el.draftState.hidden = !message;
  el.draftState.textContent = message || '';
}

function renderCount() {
  el.titleCount.textContent = el.title.value.trim().length + '/90';
}

/* --------------------------- website-parity fields ----------------------- */

function chipButton(value, label, active, onPick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'chip' + (active ? ' is-on' : '');
  button.setAttribute('aria-pressed', String(active));
  button.textContent = label;
  button.addEventListener('click', onPick);
  return button;
}

/* The five fields the website's request form submits, kept in sync with the
 * AI draft so the user can correct anything before it is posted. */
function renderDetails() {
  if (!el.detailsPanel) return;
  const draft = state.ai || pageFallback();
  const ae = Array.isArray(draft.ae) && draft.ae.length ? draft.ae : ['any'];

  el.categoryChips.replaceChildren(...CATEGORIES.map(([value, label]) =>
    chipButton(value, label, draft.category === value, () => editDetail('category', value))));
  el.osChips.replaceChildren(...OSES.map(([value, label]) =>
    chipButton(value, label, draft.os === value, () => editDetail('os', value))));
  el.aeChips.replaceChildren(...AE_VERSIONS.map((value) =>
    chipButton(value, value === 'any' ? 'Any' : value, ae.includes(value), () => editAe(value))));

  if (document.activeElement !== el.description) el.description.value = draft.description || '';
  el.descCount.textContent = (draft.description || '').length + '/280';
}

function editDetail(key, value) {
  if (!state.ai) state.ai = pageFallback();
  state.ai[key] = value;
  state.touched.add(key);
  renderDraft();
  saveDraft();
}

function editAe(value) {
  if (!state.ai) state.ai = pageFallback();
  const current = new Set(state.ai.ae);
  if (value === 'any') {
    current.clear();
    current.add('any');
  } else {
    current.delete('any');
    if (current.has(value)) current.delete(value); else current.add(value);
    if (!current.size) current.add('any');
  }
  state.ai.ae = current.has('any') ? ['any'] : [...current].sort().slice(0, 3);
  state.touched.add('ae');
  renderDraft();
  saveDraft();
}

/* The website only accepts absolute http(s) links without login details. */
function referenceValue() {
  const raw = el.reference.value.trim();
  if (!raw) {
    el.reference.classList.remove('invalid');
    el.referenceNote.hidden = true;
    return '';
  }
  const safe = safeReference(raw);
  el.reference.classList.toggle('invalid', !safe);
  el.referenceNote.hidden = Boolean(safe);
  el.referenceNote.textContent = safe ? '' : 'Use a full http:// or https:// link without login details.';
  return safe;
}

function toggleDetails(force) {
  const open = typeof force === 'boolean' ? force : el.detailsPanel.hidden;
  el.detailsPanel.hidden = !open;
  el.detailsToggle.setAttribute('aria-expanded', String(open));
  el.detailsToggle.textContent = open ? 'Hide details' : 'Fine-tune details';
}

/* ------------------------------- page read ------------------------------ */

/* Injected into the active tab. Must stay self-contained: Chrome serialises
 * this function into the page, so it cannot close over anything above. */
function capturePage() {
  const meta = (selector) => {
    const node = document.querySelector(selector);
    return node ? String(node.getAttribute('content') || '').trim() : '';
  };
  const text = (selector) => {
    const node = document.querySelector(selector);
    return node ? String(node.textContent || '').replace(/\s+/g, ' ').trim() : '';
  };
  const selection = String(window.getSelection ? window.getSelection() : '').trim();
  const body = String((document.body && document.body.innerText) || '').replace(/\s+/g, ' ').trim();
  let favicon = '';
  try {
    const link = document.querySelector('link[rel~="icon"]');
    if (link && link.href) favicon = link.href;
  } catch { /* ignore */ }
  return {
    url: location.href,
    title: document.title || '',
    host: location.hostname,
    description: meta('meta[name="description"]') || meta('meta[property="og:description"]'),
    ogTitle: meta('meta[property="og:title"]'),
    h1: text('h1'),
    selection: selection.slice(0, 1200),
    body: body.slice(0, 2200),
    favicon,
    lang: document.documentElement.lang || ''
  };
}

function hintIsFresh() {
  return Boolean(state.hint && Date.now() - Number(state.hint.at || 0) < 2 * 60 * 1000);
}

/* What the right-click menu recorded: the link the user pointed at and any
 * selected text, so a link or selection submission still has context. */
function applyHint(page) {
  if (!page || !hintIsFresh()) return page;
  if (!page.selection && state.hint.text) page.selection = String(state.hint.text).slice(0, 1200);
  const link = safeReference(state.hint.url);
  if (link && link !== page.url) page.link = link;
  return page;
}

async function readPage() {
  el.pageTitle.textContent = 'Reading this page…';
  el.pageUrl.textContent = '';
  el.pageNote.hidden = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id || !/^https?:/i.test(tab.url || '')) throw new Error('restricted');
    const [injection] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: capturePage });
    state.page = injection && injection.result ? injection.result : null;
    if (!state.page) throw new Error('empty');
    if (!state.page.title) state.page.title = tab.title || state.page.host;
    applyHint(state.page);
  } catch {
    const link = hintIsFresh() ? safeReference(state.hint.url) : '';
    if (link) {
      state.page = applyHint({
        url: link,
        title: '',
        host: hostOf(link),
        description: '',
        h1: '',
        selection: String(state.hint.text || '').slice(0, 1200),
        body: '',
        favicon: '',
        lang: ''
      });
      el.pageNote.hidden = false;
      el.pageNote.textContent = 'This page is protected, so EasyKyro works from the link you sent. Type a title and the details come from that link.';
    } else {
      state.page = null;
      el.pageNote.hidden = false;
      el.pageNote.textContent = 'This page is protected, so EasyKyro cannot read it. You can still type a title and submit — the details use your OS and the page URL.';
    }
  }
  renderPage();
  if (!state.ai) state.ai = pageFallback();
  el.reference.value = state.ai.reference || '';
  renderDraft();
  saveDraft();
}

function renderPage() {
  if (!state.page) {
    el.pageTitle.textContent = 'Page not readable';
    el.pageUrl.textContent = '';
    el.pageFavicon.textContent = '◎';
    return;
  }
  el.pageTitle.textContent = state.page.ogTitle || state.page.title || state.page.host || 'Current page';
  el.pageUrl.textContent = state.page.url;
  el.pageFavicon.textContent = '◎';
  const icon = state.page.favicon;
  if (icon && /^https?:/i.test(icon)) {
    const img = document.createElement('img');
    img.alt = '';
    img.src = icon;
    img.addEventListener('error', () => {
      img.remove();
      el.pageFavicon.textContent = '◎';
    });
    el.pageFavicon.textContent = '';
    el.pageFavicon.appendChild(img);
  }
}

/* Everything that is posted when the AI has not run (or has no key yet). */
function pageFallback() {
  const page = state.page;
  if (!page) {
    return { category: 'other', os: state.detectedOs, ae: ['any'], reference: '', description: '', source: 'page' };
  }
  return {
    category: guessCategory(page),
    os: state.detectedOs,
    ae: guessAe(page),
    reference: safeReference(page.link) || (/^https?:/i.test(page.url) ? page.url : ''),
    description: clamp(page.description || page.h1 || page.title, 280),
    source: 'page'
  };
}

function guessCategory(page) {
  const text = [page.title, page.description, page.h1, page.body].join(' ').toLowerCase();
  if (/\b(sound ?fx|sfx|audio|sound effects?)\b/.test(text)) return 'soundfx';
  if (/\b(preset|\.ffx|motion presets?)\b/.test(text)) return 'preset';
  if (/\b(template|project file|\.aep|after effects project)\b/.test(text)) return 'project';
  if (/\b(extension|plugin|add-?on|\.zxp)\b/.test(text)) return 'extension';
  if (/\b(script|\.jsx(bin)?|expression)\b/.test(text)) return 'script';
  return 'other';
}

function guessAe(page) {
  const text = [page.title, page.description, page.h1, page.body].join(' ');
  const found = ['2024', '2025', '2026'].filter((version) => new RegExp('\\b' + version + '\\b').test(text));
  return found.length ? found : ['any'];
}

/* -------------------------------- draft --------------------------------- */

/* Refresh the read-only draft card without touching the editable fields, so a
 * keystroke in Fine-tune updates the card instead of resetting the textarea. */
function renderDraftPreview() {
  const draft = state.ai;
  if (!draft) return;
  const chips = [categoryLabel(draft.category), osLabel(draft.os)];
  chips.push(draft.ae.includes('any') ? 'AE any' : 'AE ' + draft.ae.join(' / '));
  if (draft.reference) chips.push(hostOf(draft.reference));
  el.draftMeta.innerHTML = chips
    .map((chip, index) => '<span class="meta-chip' + (index === 0 ? ' key' : '') + '">' + escapeHtml(chip) + '</span>')
    .join('');
  el.draftDesc.textContent = draft.description || 'No description yet — press Generate to write one from this page.';
  el.draftDesc.classList.toggle('empty', !draft.description);
}

function renderDraft() {
  const draft = state.ai;
  if (!draft) {
    el.draftCard.hidden = true;
    el.draftHint.hidden = false;
    renderDetails();
    return;
  }
  el.draftCard.hidden = false;
  el.draftHint.hidden = true;

  const isAi = draft.source === 'ai';
  el.draftBadge.textContent = isAi ? 'AI' : 'Page';
  el.draftBadge.className = 'draft-badge mono' + (isAi ? ' ai' : ' page');

  renderDraftPreview();

  if (!state.busy) el.aiBtnText.textContent = isAi ? 'Regenerate' : 'Generate';
  renderDetails();
}

/* --------------------------------- auth --------------------------------- */

function renderAuth() {
  const auth = state.auth;
  if (!auth || !auth.token) {
    el.connDot.className = 'dot';
    el.connText.textContent = 'Not connected';
    el.connectBtn.textContent = 'Connect Discord';
    el.connectBtn.classList.add('accent');
    el.accountText.textContent = 'Not connected.';
    return;
  }
  const user = auth.user || {};
  const inServer = user.inServer !== false;
  el.connDot.className = 'dot ' + (inServer ? 'on' : 'warn');
  el.connText.innerHTML = 'Connected as <strong>@' + escapeHtml(user.username || 'editor') + '</strong>' + (inServer ? '' : ' · not in server');
  el.connectBtn.textContent = inServer ? 'Recheck' : 'Join server';
  el.connectBtn.classList.toggle('accent', !inServer);
  el.accountText.innerHTML = 'Signed in as <strong>@' + escapeHtml(user.username || 'editor') + '</strong>' +
    (inServer ? ' · Kyro member' : ' · not a Kyro member yet');
}

/* Pull the session the website stored in a kyro.new.tg tab. This is what makes
 * "I signed in on the site" show up here without a second login. */
async function syncSession() {
  const response = await send({ type: 'EASYKYRO_SYNC' });
  if (!response || !response.ok || !response.auth || !response.auth.token) return false;
  state.auth = response.auth;
  renderAuth();
  return true;
}

async function verifyAuth({ silent = false } = {}) {
  if (!state.auth || !state.auth.token) return;
  try {
    const response = await fetch(WORKER + '/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: state.auth.token })
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) {
      await disconnect();
      if (!silent) setStatus('error', 'Your Discord session expired. Connect again.');
      return;
    }
    if (!response.ok) return;
    state.auth.user = {
      id: String(data.id || ''),
      username: data.username || (state.auth.user && state.auth.user.username) || 'editor',
      avatar: data.avatar || '',
      inServer: Boolean(data.in_server),
      isOwner: Boolean(data.is_owner),
      role: data.role || 'Member'
    };
    await chrome.storage.local.set({ auth: state.auth }).catch(() => {});
    renderAuth();
    if (!silent) {
      setStatus(
        data.in_server ? 'ok' : 'info',
        data.in_server
          ? 'Discord connected as @' + escapeHtml(data.username || 'editor') + '.'
          : 'You are signed in, but not in the Kyro server yet. <a href="' + INVITE + '" target="_blank" rel="noopener">Join the Discord</a>, then press Recheck.'
      );
    }
  } catch {
    /* Network hiccup: keep the stored session and try again next open. */
  }
}

async function disconnect() {
  state.auth = null;
  await chrome.storage.local.remove('auth').catch(() => {});
  renderAuth();
}

async function openLogin() {
  await syncSession();
  const response = await send({ type: 'EASYKYRO_OPEN_LOGIN' });
  if (!response || !response.ok) {
    setStatus('error', escapeHtml((response && response.error) || 'Could not open Kyro.'));
    return;
  }
  setStatus('info', 'Sign in with Discord in the new tab, then open EasyKyro again — the session is picked up automatically.');
}

/* ---------------------------- similar requests -------------------------- */

const normaliseTitle = (value) => String(value || '').toLowerCase().normalize('NFKC')
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/* The board is what the website shows: a member sees their own requests and an
 * admin sees everything, so this is the same set the site would compare. */
async function loadBoard() {
  if (!state.auth || !state.auth.token || isOffline()) return;
  try {
    const response = await fetch(WORKER + '/requests', {
      headers: { authorization: 'Bearer ' + state.auth.token }
    });
    if (!response.ok) return;
    const data = await response.json().catch(() => ({}));
    state.board = Array.isArray(data.requests) ? data.requests : [];
    state.boardLoaded = true;
    findSimilar();
  } catch {
    /* Offline or a hiccup: the worker still rejects real duplicates on submit. */
  }
}

function hideSimilar() {
  state.similarId = '';
  el.similar.hidden = true;
  el.similarText.textContent = '';
}

/* Same match the website makes before you post: an existing request with a
 * near-identical title is worth an upvote instead of a duplicate. */
function findSimilar() {
  const query = normaliseTitle(el.title.value);
  const words = query.split(' ').filter((word) => word.length > 2);
  if (query.length < 3 || !state.boardLoaded) {
    hideSimilar();
    return;
  }

  let match = null;
  let best = 0;
  state.board.forEach((row) => {
    const title = normaliseTitle(row.title);
    if (!title) return;
    const titleWords = new Set(title.split(' '));
    const overlap = words.filter((word) => titleWords.has(word)).length;
    const score = title === query ? 2 : words.length >= 2 && overlap >= 2 ? overlap / words.length : 0;
    if (score > best) {
      best = score;
      match = row;
    }
  });

  if (!match || best < 0.6) {
    hideSimilar();
    return;
  }

  state.similarId = match.id;
  const votes = Number(match.votes) || 0;
  el.similarText.innerHTML = 'Already requested: <strong>' + escapeHtml(match.title) + '</strong> · ' +
    votes + (votes === 1 ? ' vote' : ' votes');
  el.similar.hidden = false;
  el.similarVote.textContent = match.you_voted ? 'Upvoted' : 'Upvote instead';
  el.similarVote.disabled = Boolean(match.you_voted);
}

async function upvoteSimilar() {
  const id = state.similarId;
  if (!id || !state.auth || !state.auth.token) return;
  el.similarVote.disabled = true;
  el.similarVote.textContent = 'Voting…';
  try {
    const response = await fetch(WORKER + '/requests/vote', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: state.auth.token, id })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(errorCopy(response.status, data));
    state.board = Array.isArray(data.requests) ? data.requests : state.board;
    setStatus('ok', 'Upvoted — no duplicate request needed.');
    findSimilar();
  } catch (err) {
    el.similarVote.disabled = false;
    el.similarVote.textContent = 'Upvote instead';
    setStatus('error', escapeHtml(err.message || 'Could not vote on that request.'));
  }
}

/* ------------------------------- settings ------------------------------- */

function renderSettings() {
  el.geminiKey.value = state.settings.geminiKey || '';
  if (state.settings.geminiKey && state.settings.model) {
    setKeyStatus('Saved and verified. Using ' + state.settings.model + ' — the cheapest Gemini model.', 'ok');
  } else {
    setKeyStatus('Paste a key — it is checked instantly and saved. The cheapest Gemini model is used automatically.');
  }
}

function toggleSettings(force) {
  const open = typeof force === 'boolean' ? force : el.settingsPanel.hidden;
  el.settingsPanel.hidden = !open;
  el.settingsBtn.setAttribute('aria-expanded', String(open));
  if (open) {
    renderSettings();
    el.geminiKey.focus();
    el.geminiKey.select();
  }
}

/* Rank the models the key can use: lite tiers are the cheapest, newest first. */
function isTextModel(id) {
  if (!id || !/^gemini/.test(id)) return false;
  return !/(embedding|aqa|imagen|veo|tts|image|audio|live|native)/.test(id);
}

function rankModel(id) {
  let score = 0;
  if (/lite/.test(id)) score += 1000;
  else if (/flash/.test(id)) score += 500;
  const match = id.match(/gemini-(\d+)\.(\d+)/);
  if (match) score += Number(match[1] + '.' + match[2]) * 10;
  if (/(preview|exp|experimental)/.test(id)) score -= 200;
  if (/-\d{3}$/.test(id)) score -= 50;
  return score;
}

function pickModel(ids) {
  const usable = ids.filter(isTextModel);
  if (!usable.length) return FALLBACK_MODELS[0];
  usable.sort((a, b) => rankModel(b) - rankModel(a) || a.localeCompare(b));
  return usable[0];
}

/* One call does both jobs: it proves the key works and returns the cheapest
 * text model the key is allowed to use. Nothing for the user to choose. */
async function discoverModel(key) {
  const response = await fetch(GEMINI + '/models?pageSize=200&key=' + encodeURIComponent(key));
  if (response.status === 400 || response.status === 403) {
    throw Object.assign(new Error('Google rejected that key. Copy it again from AI Studio.'), { invalidKey: true });
  }
  if (response.status === 429) throw new Error('Google is rate-limiting this key right now. Try again in a minute.');
  if (!response.ok) throw new Error('Google returned HTTP ' + response.status + '.');
  const data = await response.json().catch(() => ({}));
  const ids = (data.models || [])
    .filter((model) => !Array.isArray(model.supportedGenerationMethods) || model.supportedGenerationMethods.includes('generateContent'))
    .map((model) => String(model.name || '').replace(/^models\//, ''));
  return pickModel(ids);
}

async function verifyKey({ closeOnSuccess = true } = {}) {
  const key = el.geminiKey.value.trim();
  clearTimeout(state.keyTimer);
  if (!key) {
    setKeyStatus('Paste your free Google AI key to turn on AI-written requests.');
    return;
  }
  if (!KEY_PATTERN.test(key)) {
    setKeyStatus('That does not look like a Google AI key — they start with AIza.', 'error');
    return;
  }
  if (key === state.settings.geminiKey && state.settings.model) {
    setKeyStatus('Saved and verified. Using ' + state.settings.model + ' — the cheapest Gemini model.', 'ok');
    return;
  }

  const token = ++state.keyToken;
  state.verifying = true;
  setKeyStatus('Checking your key with Google…', 'checking');
  try {
    const model = await discoverModel(key);
    if (token !== state.keyToken) return;
    state.settings = { geminiKey: key, model };
    await chrome.storage.local.set({ settings: state.settings }).catch(() => {});
    setKeyStatus('Verified. Using ' + model + ' — the cheapest Gemini model.', 'ok');
    clearStatus();
    if (closeOnSuccess) {
      state.keyTimer = setTimeout(() => {
        if (token !== state.keyToken) return;
        toggleSettings(false);
        if (el.title.value.trim().length >= 3) generate(false);
      }, 900);
    }
  } catch (err) {
    if (token !== state.keyToken) return;
    setKeyStatus(err.message || 'That key could not be verified.', 'error');
  } finally {
    if (token === state.keyToken) state.verifying = false;
  }
}

/* --------------------------------- AI ----------------------------------- */

function buildPrompt() {
  const page = state.page || {};
  const context = [
    'Page URL: ' + (page.url || '(unknown)'),
    'Page title: ' + (page.title || '(unknown)'),
    'Site: ' + (page.host || '(unknown)'),
    page.description ? 'Meta description: ' + page.description : '',
    page.h1 ? 'Page heading: ' + page.h1 : '',
    page.link ? 'Link the user pointed at: ' + page.link : '',
    page.selection ? 'Text the user selected: ' + page.selection : '',
    page.body ? 'Page text excerpt: ' + page.body : '',
    'User OS: ' + osLabel(state.detectedOs),
    'Title the user typed: ' + (el.title.value.trim() || '(empty — write one)'),
    'Today: ' + new Date().toISOString().slice(0, 10)
  ].filter(Boolean).join('\n');

  return [
    'You are EasyKyro, an assistant that files feature requests for Kyro, a vault of After Effects extensions, scripts, presets, projects and sound effects.',
    'The user is on a web page and wants to request something related to what they are viewing. Use the page context to write the request for them.',
    '',
    'Rules:',
    '- title: 3-90 characters, name the thing they want added. If the user typed a title, keep its intent.',
    '- category: one of extension, script, preset, project, soundfx, other. Choose from what the page shows.',
    '- os: windows, macos, or both. Use "both" when the page does not say.',
    '- ae_versions: array using 2024, 2025, 2026, or any. Use ["any"] unless the page clearly targets a specific After Effects version.',
    '- reference: the page URL only when it is a product, demo, store or video page showing what they want; otherwise an empty string. Never invent a URL.',
    '- description: at most 280 characters, one or two sentences. Say what it should do and why it is useful, in the user\'s voice. Do not mention AI, the page title, or "the user".',
    '',
    'Return only the JSON object.',
    '',
    context
  ].join('\n');
}

async function callGemini() {
  const key = (state.settings.geminiKey || '').trim();
  if (!key) throw Object.assign(new Error('Add your free Google AI key in Settings first.'), { needsKey: true });
  const model = state.settings.model || await discoverModel(key);
  const response = await fetch(
    GEMINI + '/models/' + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(key),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: buildPrompt() }] }],
        generationConfig: {
          temperature: 0.35,
          maxOutputTokens: 700,
          responseMimeType: 'application/json',
          responseSchema: AI_SCHEMA
        }
      })
    }
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 400 || response.status === 403) {
      state.settings = { geminiKey: key, model: '' };
      await chrome.storage.local.set({ settings: state.settings }).catch(() => {});
      throw Object.assign(new Error('That Google AI key was rejected. Paste a fresh one in Settings.'), { invalidKey: true });
    }
    if (response.status === 429) throw new Error('Your free Gemini quota is used up for now. Try again later.');
    throw new Error((data.error && data.error.message) || ('Gemini returned HTTP ' + response.status));
  }
  const text = (data.candidates && data.candidates[0] && data.candidates[0].content &&
    data.candidates[0].content.parts || []).map((part) => part.text || '').join('');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Gemini sent an unexpected answer. Try again.');
  }
  return parsed;
}

function applyAi(result) {
  if (!result || typeof result !== 'object') return;
  const fallback = pageFallback();
  const base = state.ai || fallback;
  const versions = Array.isArray(result.ae_versions)
    ? result.ae_versions.filter((value) => AE_VERSIONS.includes(value)).slice(0, 3)
    : [];
  const keep = (key, next) => (state.touched.has(key) ? base[key] : next);

  state.ai = {
    category: keep('category', CATEGORIES.some(([value]) => value === result.category) ? result.category : fallback.category),
    os: keep('os', OSES.some(([value]) => value === result.os) ? result.os : fallback.os),
    ae: keep('ae', versions.length ? (versions.includes('any') ? ['any'] : versions) : ['any']),
    reference: keep('reference', safeReference(result.reference) || fallback.reference),
    description: keep('description', clamp(result.description, 280)),
    source: 'ai'
  };

  if (!el.title.value.trim()) {
    const title = clamp(result.title, 90);
    if (title.length >= 3) el.title.value = title;
  }
  el.reference.value = state.ai.reference || '';
  renderDraft();
  saveDraft();
}

function aiSignature() {
  return [state.page ? state.page.url : 'manual', el.title.value.trim()].join('|');
}

function scheduleAi() {
  if (!(state.settings.geminiKey || '').trim()) return;
  if (el.title.value.trim().length < 3) return;
  const signature = aiSignature();
  if (signature === state.lastAiSignature) return;
  clearTimeout(state.aiTimer);
  state.aiTimer = setTimeout(() => generate(false), 900);
}

async function generate(manual) {
  if (state.busy) return;
  if (isOffline()) {
    if (manual) setStatus('error', 'You are offline. Reconnect, then let Gemini write the details.');
    return;
  }
  if (!(state.settings.geminiKey || '').trim()) {
    if (manual) {
      toggleSettings(true);
      setKeyStatus('Add your free Google AI key to write the request details.', 'error');
      el.geminiKey.focus();
    }
    return;
  }
  if (el.title.value.trim().length < 3) {
    if (manual) {
      el.title.classList.add('invalid');
      el.title.focus();
      setStatus('error', 'Type a title first — the AI writes the rest from it and this page.');
    }
    return;
  }

  state.busy = true;
  el.aiBtn.classList.add('is-loading');
  el.aiBtn.disabled = true;
  /* Submitting now would post the fallback details instead of the ones that
     are one request away, so the submit stays disabled until this resolves. */
  el.submitBtn.disabled = true;
  el.aiBtnText.textContent = 'Generating…';
  setDraftState('Writing the details with Gemini…');
  clearStatus();
  try {
    const result = await callGemini();
    applyAi(result);
    // applyAi can rewrite the title, so record the signature of the form as it
    // now stands — otherwise the debounce fires a second, identical AI call.
    state.lastAiSignature = aiSignature();
    setDraftState('');
    if (manual) setStatus('ok', 'Details written from this page. Check them, then submit.');
  } catch (err) {
    setDraftState('');
    if (err.needsKey || err.invalidKey) toggleSettings(true);
    setStatus('error', escapeHtml(err.message || 'AI generation failed.'));
  } finally {
    state.busy = false;
    el.aiBtn.classList.remove('is-loading');
    el.aiBtn.disabled = false;
    if (!el.submitBtn.dataset.submitting) el.submitBtn.disabled = false;
    renderDraft();
  }
}

/* -------------------------------- drafts -------------------------------- */

function saveDraft() {
  clearTimeout(state.draftTimer);
  state.draftTimer = setTimeout(() => {
    chrome.storage.local.set({
      draft: {
        url: state.page ? state.page.url : 'manual',
        title: el.title.value,
        ai: state.ai,
        touched: [...state.touched]
      }
    }).catch(() => {});
  }, 350);
}

function restoreDraft(draft) {
  if (!draft) return;
  const url = state.page ? state.page.url : 'manual';
  if (draft.url !== url) return;
  if (typeof draft.title === 'string') el.title.value = draft.title;
  renderCount();
  if (draft.ai && typeof draft.ai === 'object') {
    /* A stored draft can be old or edited by hand; never restore AE values the
       worker would reject (empty, mixed "any", or more than three). */
    const storedAe = Array.isArray(draft.ai.ae)
      ? [...new Set(draft.ai.ae.filter((value) => AE_VERSIONS.includes(value)))]
      : [];
    const ae = !storedAe.length || storedAe.includes('any') ? ['any'] : storedAe.slice(0, 3);
    state.ai = {
      category: CATEGORIES.some(([value]) => value === draft.ai.category) ? draft.ai.category : 'other',
      os: OSES.some(([value]) => value === draft.ai.os) ? draft.ai.os : state.detectedOs,
      ae,
      reference: safeReference(draft.ai.reference),
      description: clamp(draft.ai.description, 280),
      source: draft.ai.source === 'ai' ? 'ai' : 'page'
    };
  }
  if (Array.isArray(draft.touched)) {
    state.touched = new Set(draft.touched.filter((key) => ['category', 'os', 'ae', 'reference', 'description'].includes(key)));
  }
  el.reference.value = state.ai.reference || '';
  renderDraft();
}

function clearDraft() {
  clearTimeout(state.draftTimer);
  chrome.storage.local.remove('draft').catch(() => {});
}

/* -------------------------------- submit -------------------------------- */

function errorCopy(status, data) {
  const code = data && data.code;
  const message = data && data.error;
  if (status === 401) return 'Your Discord session expired. Reconnect Discord.';
  if (status === 403 && code === 'not_a_member') return 'Join the Kyro Discord server first, then reconnect.';
  if (status === 409) return message || 'That request already exists — upvote it on the board instead.';
  if (status === 429) return 'You are posting too fast. Try again in a few minutes.';
  if (status === 400) return message || 'Check the form and try again.';
  return message || ('Kyro returned HTTP ' + status + '.');
}

async function submit(event) {
  event.preventDefault();
  if (state.busy) {
    setStatus('info', 'Hold on — the details are still being written.');
    return;
  }
  clearStatus();
  el.title.classList.remove('invalid');

  if (!state.auth || !state.auth.token) {
    setStatus('error', 'Connect Discord first — requests need a Kyro member.');
    el.connectBtn.focus();
    return;
  }

  const title = el.title.value.trim();
  if (title.length < 3) {
    el.title.classList.add('invalid');
    el.title.focus();
    setStatus('error', 'The title needs at least 3 characters.');
    return;
  }

  if (isOffline()) {
    setStatus('error', 'You are offline — reconnect and submit again. Your draft is saved.');
    return;
  }

  const details = state.ai || pageFallback();
  const reference = referenceValue();
  if (el.reference.value.trim() && !reference) {
    el.reference.focus();
    setStatus('error', 'The reference link needs to be a full http:// or https:// address without login details.');
    return;
  }

  state.busy = true;
  el.submitBtn.disabled = true;
  el.submitBtn.dataset.submitting = '1';
  el.aiBtn.disabled = true;
  el.submitBtn.textContent = 'Submitting…';
  try {
    const response = await fetch(WORKER + '/requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: state.auth.token,
        title,
        category: details.category,
        os: details.os,
        ae_versions: details.ae,
        reference: referenceValue(),
        desc: details.description,
        /* Marks the request as a priority submission on the board and in the
           Discord requests channel, so it is never a plain manual entry. */
        source: 'easykyro'
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) await disconnect();
      throw new Error(errorCopy(response.status, data));
    }
    clearDraft();
    showSuccess(title, data);
  } catch (err) {
    setStatus('error', escapeHtml(err.message || 'Could not post the request.'));
  } finally {
    state.busy = false;
    delete el.submitBtn.dataset.submitting;
    el.submitBtn.disabled = false;
    el.aiBtn.disabled = false;
    el.submitBtn.textContent = 'Submit Request';
  }
}

function showSuccess(title, data) {
  el.form.hidden = true;
  hideSimilar();
  clearStatus();
  const row = data && Array.isArray(data.requests) ? data.requests.find((entry) => entry.id === data.id) : null;
  const priority = Boolean(row && row.priority);
  el.successCopy.innerHTML = '<strong>' + escapeHtml(title) + '</strong> is on the requests board' +
    (priority ? ' as a priority request.' : '.') +
    (data && data.notification === 'queued'
      ? ' The Discord requests channel has been notified.'
      : ' It will appear on the board for the Kyro team.');
  el.successPanel.hidden = false;
}

function resetForm() {
  el.title.value = '';
  renderCount();
  state.ai = pageFallback();
  state.lastAiSignature = '';
  state.touched.clear();
  el.reference.value = state.ai.reference || '';
  el.reference.classList.remove('invalid');
  el.referenceNote.hidden = true;
  hideSimilar();
  toggleDetails(false);
  el.successPanel.hidden = true;
  el.form.hidden = false;
  renderDraft();
  clearStatus();
  clearDraft();
  el.title.focus();
}

/* --------------------------------- boot --------------------------------- */

function detectOs() {
  const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
  const source = platform + ' ' + (navigator.userAgent || '');
  state.detectedOs = /mac/i.test(source) ? 'macos' : /win/i.test(source) ? 'windows' : 'both';
}

function bindEvents() {
  el.settingsBtn.addEventListener('click', () => toggleSettings());
  el.closeSettings.addEventListener('click', () => toggleSettings(false));
  el.toggleKey.addEventListener('click', () => {
    const show = el.geminiKey.type === 'password';
    el.geminiKey.type = show ? 'text' : 'password';
    el.toggleKey.setAttribute('aria-pressed', String(show));
    el.toggleKey.title = show ? 'Hide key' : 'Show key';
    el.toggleKey.setAttribute('aria-label', show ? 'Hide key' : 'Show key');
  });

  /* The key saves itself: paste or type it and it is verified and closed. */
  el.geminiKey.addEventListener('input', () => {
    const value = el.geminiKey.value.trim();
    clearTimeout(state.keyTimer);
    if (!value) {
      setKeyStatus('Paste your free Google AI key to turn on AI-written requests.');
      return;
    }
    if (!KEY_PATTERN.test(value)) {
      setKeyStatus('Keys start with AIza and are about 39 characters.', 'error');
      return;
    }
    clearTimeout(state.keyTimer);
    state.keyTimer = setTimeout(() => verifyKey(), 600);
  });
  el.geminiKey.addEventListener('paste', () => {
    setTimeout(() => {
      if (KEY_PATTERN.test(el.geminiKey.value.trim())) verifyKey();
    }, 40);
  });
  el.geminiKey.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      verifyKey();
    }
  });

  el.disconnectBtn.addEventListener('click', async () => {
    await disconnect();
    setKeyStatus('Discord disconnected.');
    setTimeout(() => setKeyStatus(''), 1800);
  });

  el.connectBtn.addEventListener('click', async () => {
    if (!state.auth || !state.auth.token) {
      openLogin();
      return;
    }
    if (state.auth.user && state.auth.user.inServer === false) {
      chrome.tabs.create({ url: INVITE }).catch(() => {});
      return;
    }
    await verifyAuth();
  });

  el.refreshPage.addEventListener('click', () => {
    readPage();
    clearStatus();
  });
  el.form.addEventListener('submit', submit);
  el.aiBtn.addEventListener('click', () => generate(true));
  el.title.addEventListener('input', () => {
    el.title.classList.remove('invalid');
    renderCount();
    saveDraft();
    scheduleAi();
    clearTimeout(state.similarTimer);
    state.similarTimer = setTimeout(findSimilar, 300);
  });

  el.detailsToggle.addEventListener('click', () => toggleDetails());
  el.reference.addEventListener('input', () => {
    state.touched.add('reference');
    if (!state.ai) state.ai = pageFallback();
    state.ai.reference = safeReference(el.reference.value.trim());
    referenceValue();
    renderDraftPreview();
    saveDraft();
  });
  el.reference.addEventListener('blur', () => {
    const safe = referenceValue();
    if (safe) el.reference.value = safe;
  });
  el.description.addEventListener('input', () => {
    state.touched.add('description');
    if (!state.ai) state.ai = pageFallback();
    state.ai.description = clamp(el.description.value, 280);
    el.descCount.textContent = el.description.value.length + '/280';
    renderDraftPreview();
    saveDraft();
  });
  el.similarVote.addEventListener('click', upvoteSimilar);
  el.viewBoard.addEventListener('click', () => chrome.tabs.create({ url: SITE }).catch(() => {}));
  el.newRequest.addEventListener('click', resetForm);
  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === 'EASYKYRO_AUTH_CHANGED' && message.auth) {
      state.auth = message.auth;
      renderAuth();
      loadBoard();
    }
  });
}

async function boot() {
  const stored = await chrome.storage.local.get(['auth', 'settings', 'draft', 'hint']).catch(() => ({}));
  state.auth = (stored && stored.auth) || null;
  state.settings = { ...DEFAULT_SETTINGS, ...((stored && stored.settings) || {}) };
  state.hint = (stored && stored.hint) || null;
  if (state.hint) chrome.storage.local.remove('hint').catch(() => {});

  detectOs();
  renderCount();
  renderAuth();
  renderSettings();
  bindEvents();
  toggleSettings(false);
  toggleDetails(false);

  await readPage();
  if (stored && stored.draft) restoreDraft(stored.draft);
  if (!state.ai) {
    state.ai = pageFallback();
    renderDraft();
  }

  if (!state.auth || !state.auth.token) {
    // The website may already have a session: pick it up silently.
    const synced = await syncSession();
    if (synced) verifyAuth({ silent: true });
    else if (!(state.settings.geminiKey || '').trim()) {
      setStatus('info', 'Sign in with Discord on kyro.new.tg — EasyKyro picks it up here automatically.');
    }
  } else {
    verifyAuth({ silent: true });
  }

  loadBoard();

  if (el.title.value.trim().length >= 3 && (state.settings.geminiKey || '').trim()) {
    state.lastAiSignature = '';
    scheduleAi();
  }
}

boot().catch((err) => {
  setStatus('error', 'EasyKyro could not start: ' + escapeHtml(err.message || err));
});
