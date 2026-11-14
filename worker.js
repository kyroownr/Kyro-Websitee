/**
 * Kyro — Discord OAuth2 worker (Cloudflare Workers, ES module).
 *
 * Routes
 *   GET  /callback   Discord redirect target: exchanges the code for a token,
 *                    reads the profile + guild list, then 302s back to the site
 *                    with ?token=&username=&id=&avatar=&in_server=&state=
 *   POST /verify     { token }  →  { in_server, username, guild_id }
 *   GET  /verify     ?token=…   →  same payload (handy for curl)
 *   GET  /requests   ?token=…   →  { requests } wishlist board, ordered by votes.
 *                                  token is optional; with it each row carries
 *                                  you_voted for that member only.
 *   POST /requests   { token, title, category, os, ae_versions, reference, desc }
 *   POST /requests/vote   { token, id }   → toggle one vote, returns the board
 *   POST /requests/status { token, id, status } → server owner or KYRO_ADMIN_IDS
 *   POST /requests/delete { token, id } → Discord server owner only
 *   GET  /downloads  →  { counts } live download totals, one per asset id.
 *   POST /downloads  { token, id }  →  records one download for that member;
 *                                      repeat clicks by the same member are
 *                                      counted once, the way a person is
 *                                      counted once.
 *
 * Bindings:
 *   KYRO_DATA       Workers KV for download counters and the legacy board import.
 *   KYRO_REQUESTS   SQLite Durable Object with transactional requests and votes.
 *
 * Plain vars:
 *   KYRO_ADMIN_IDS  comma separated Discord user ids allowed to move a request
 *                   between OPEN / PLANNED / IN PROGRESS / SHIPPED.
 *
 * Secrets (Settings → Variables; a plain text var is fine, the encrypted
 * "secret" type is better):
 *   DISCORD_CLIENT_ID      1570702041993711706  (same id that is public in js/app.js)
 *   DISCORD_CLIENT_SECRET  from the Discord app — never committed, never shipped
 *   DISCORD_REQUESTS_WEBHOOK_URL  encrypted secret for request notifications.
 *   KYRO_GUILD_ID          1539961184323772498  (numeric snowflake, Server
 *                          Settings → Widgets; matches js/app.js)
 *
 * Plain vars:
 *   KYRO_ALLOWED_ORIGINS   comma separated. Set it to
 *                          https://kyro.new.tg on the deployed worker to drop
 *                          the localhost entries the default allows.
 *   KYRO_SITE_URL          https://kyro.new.tg — where /callback redirects to.
 *                          Defaults to the calling origin when it is allow-listed.
 *   KYRO_REDIRECT_URI      optional. Only needed if the worker is reached on a
 *                          hostname other than the one registered with Discord
 *                          (a preview deploy, for example). Must match the
 *                          authorize redirect_uri byte for byte.
 *
 * Register https://kyro-auth.kyro-ownr.workers.dev/callback as an OAuth2
 * redirect in the Discord app, byte for byte.
 */

/* Both localhost spellings are allowed so tools/serve.js works whichever host
   the browser typed; override the whole list with KYRO_ALLOWED_ORIGINS. */
import { applicationConfiguration, handleApplications, handleApplicationInteractions, KyroApplications } from './applications-worker.js';
export { KyroApplications };

const DEFAULT_ORIGINS = 'https://kyro.new.tg,http://localhost:4173,http://127.0.0.1:4173';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    try {
      if (url.pathname === '/api/discord/interactions' || url.pathname === '/applications/interactions') return await handleApplicationInteractions(request, env, ctx);
      if (url.pathname === '/applications/config' && request.method === 'GET') return json(applicationConfiguration(env), 200, { ...cors, 'cache-control': 'no-store' });
      if (url.pathname === '/applications' || url.pathname === '/applications/status') {
        const token = (request.headers.get('authorization') || '').match(/^Bearer\s+(\S+)$/i)?.[1] || '';
        const session = await requireMember(token, env);
        return await handleApplications(request, env, cors, session);
      }
      if (url.pathname === '/callback') return await handleCallback(request, url, env);
      if (url.pathname === '/verify') return await handleVerify(request, url, env, cors);
      if (url.pathname === '/requests') return await handleRequests(request, url, env, cors);
      if (url.pathname === '/requests/vote') return await handleVote(request, env, cors);
      if (url.pathname === '/requests/status') return await handleStatus(request, env, cors);
      if (url.pathname === '/requests/delete') return await handleDelete(request, env, cors);
      if (url.pathname === '/downloads') return await handleDownloads(request, url, env, cors);
      if (url.pathname === '/feedback') return await handleFeedback(request, url, env, cors);
      return json({ error: 'Unknown route. Use /callback, /verify, /requests, /feedback or /downloads.' }, 404, cors);
    } catch (err) {
      const message = (err && err.message) || String(err);
      // A callback failure belongs in the URL, not in a JSON body the browser cannot render.
      if (url.pathname === '/callback') {
        return Response.redirect(target(redirectBase(request, env), {
          error: (err && err.code) || 'auth_failed',
          error_description: message,
          state: url.searchParams.get('state') || ''
        }), 302);
      }
      return json({ error: message, code: (err && err.code) || 'server_error' }, (err && err.status) || 500, cors);
    }
  }
};

/* --------------------------------- routes -------------------------------- */

async function handleCallback(request, url, env) {
  const base = redirectBase(request, env);
  const state = url.searchParams.get('state') || '';
  const failure = url.searchParams.get('error');

  // Discord's own error + description travel on, never replaced by a generic one.
  if (failure) {
    return Response.redirect(target(base, {
      error: failure,
      error_description: url.searchParams.get('error_description') || '',
      state
    }), 302);
  }

  const code = url.searchParams.get('code');
  if (!code) {
    return Response.redirect(target(base, {
      error: 'missing_code',
      error_description: 'Discord redirected back without an authorization code.',
      state
    }), 302);
  }

  const accessToken = await exchangeCode(code, request, env);
  const session = await readSession(accessToken, env);

  // The token rides in the query because the spec asks for it; the site strips
  // it with history.replaceState() on first paint.
  return Response.redirect(target(base, {
    token: accessToken,
    username: session.username,
    id: session.id,
    avatar: session.avatar,
    in_server: session.inServer,
    state
  }), 302);
}

async function handleVerify(request, url, env, cors) {
  let token = url.searchParams.get('token') || '';
  if (request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    token = body.token || token;
  }
  if (!token) return json({ error: 'Missing token.', code: 'missing_token' }, 400, cors);

  const session = await readSession(token, env);
  return json({
    in_server: session.inServer,
    is_owner: session.isOwner,
    username: session.username,
    id: session.id,
    avatar: session.avatar,
    guild_id: String(env.KYRO_GUILD_ID || '')
  }, 200, cors);
}

/* ------------------------------ requests board ---------------------------- */

const REQ_KEY = 'kyro.requests.v1';
const REQ_STATUSES = ['open', 'planned', 'in_progress', 'shipped'];
const REQ_CATEGORIES = ['extension', 'script', 'preset', 'project', 'soundfx', 'other'];
const REQ_OS = ['windows', 'macos', 'both'];
const REQ_AE = ['2024', '2025', '2026', 'any'];

function fail(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

async function jsonBody(request) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail(400, 'bad_body', 'Send a JSON object.');
  return body;
}

/* Control characters and newline runs have no business in a one-line card. */
function cleanText(value, max) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

async function readDoc(env, key, fallback) {
  if (!env.KYRO_DATA) {
    throw fail(500, 'kv_unbound', 'The KYRO_DATA KV namespace is not bound to this worker.');
  }
  const got = await env.KYRO_DATA.getWithMetadata(key, { type: 'json' });
  return { value: got.value == null ? fallback : got.value };
}

async function mutateDoc(env, key, fallback, fn) {
  const { value } = await readDoc(env, key, fallback);
  const next = fn(value);
  await env.KYRO_DATA.put(key, JSON.stringify(next));
  return next;
}

function requestTitleKey(title) {
  return title.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function starterRequests() {
  const created = new Date().toISOString();
  return [
    ['starter-bounce', 'Inertial bounce & graph helper', 'script', 'Apply adjustable bounce expressions and tidy easing curves without rebuilding them by hand.'],
    ['starter-glow', 'Optical glow preset pack', 'preset', 'Reusable soft glow, bloom, and highlight presets for clean text and footage edits.'],
    ['starter-render', 'Batch render utility', 'script', 'Queue multiple compositions with consistent output names and export locations.'],
    ['starter-whoosh', 'Transition whoosh sound pack', 'soundfx', 'A compact collection of clean whooshes and impacts for motion transitions.']
  ].map(([id, title, category, desc]) => ({
    id, title, category, desc, os: 'both', ae_versions: ['any'], reference: '',
    status: 'open', created, starter: true, voters: []
  }));
}

export class KyroRequests {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    state.blockConcurrencyWhile(async () => {
      if (await state.storage.get('board') !== undefined) return;
      const legacy = await env.KYRO_DATA.get(REQ_KEY, { type: 'json' });
      if (legacy !== null && !Array.isArray(legacy)) throw new Error('The existing requests board is not an array.');
      const rows = (legacy || []).map(row => ({
        ...row,
        status: row.status === 'added_to_vault' ? 'shipped' : row.status === 'under_review' ? 'open' : REQ_STATUSES.includes(row.status) ? row.status : 'open',
        os: REQ_OS.includes(row.os) ? row.os : 'both',
        ae_versions: row.ae_versions || (row.ae ? [row.ae] : ['any']),
        reference: row.reference || '',
        voters: row.voters || []
      }));
      await state.storage.put('board', rows.length ? rows : starterRequests());
    });
  }

  async fetch(request) {
    try {
      const input = await request.json();
      if (input.action === 'read') return json({ rows: await this.state.storage.get('board') }, 200, {});
      const rows = await this.state.storage.transaction(async storage => {
        const all = await storage.get('board');
        let next;
        if (input.action === 'create') {
          const duplicate = all.find(row => requestTitleKey(row.title) === requestTitleKey(input.row.title));
          if (duplicate) throw fail(409, 'duplicate_request', 'This request already exists. Upvote "' + duplicate.title + '" instead.');
          const number = (await storage.get('requestNumber') || all.reduce((max, row) => Math.max(max, row.number || 0), 0)) + 1;
          const row = { ...input.row, number };
          next = all.concat([row]);
          await storage.put('requestNumber', number);
          if (this.env.DISCORD_REQUESTS_WEBHOOK_URL) {
            await storage.put('notification:' + row.id, { row, attempts: 0 });
            if (await storage.getAlarm() === null) await storage.setAlarm(Date.now());
          }
        } else {
          const row = all.find(item => item.id === input.id);
          if (!row) throw fail(404, 'unknown_request', 'That request no longer exists.');
          if (input.action === 'vote') {
            const voters = row.voters.includes(input.viewerId) ? row.voters.filter(id => id !== input.viewerId) : row.voters.concat([input.viewerId]);
            next = all.map(item => item.id === input.id ? { ...item, voters } : item);
          } else if (input.action === 'status') {
            next = all.map(item => item.id === input.id ? { ...item, status: input.status } : item);
          } else if (input.action === 'delete') {
            next = all.filter(item => item.id !== input.id);
          } else throw fail(400, 'bad_action', 'Unknown requests operation.');
        }
        await storage.put('board', next);
        return next;
      });
      return json({ rows }, 200, {});
    } catch (err) {
      return json({ error: err.message, code: err.code || 'board_error' }, err.status || 500, {});
    }
  }

  async alarm() {
    const storage = this.state.storage;
    const pending = await storage.list({ prefix: 'notification:', limit: 1 });
    const entry = pending.entries().next().value;
    if (!entry) return;
    const [key, job] = entry;
    const result = await notifyRequest(job.row, this.env);
    await storage.transaction(async tx => {
      const current = await tx.get(key);
      if (!current) return;
      const attempts = current.attempts + 1;
      if (!result.sent && result.retryAfter !== undefined && attempts < 5) {
        await tx.put(key, { ...current, attempts });
        await tx.setAlarm(Date.now() + result.retryAfter);
      } else {
        await tx.delete(key);
        if (!result.sent) console.warn('[kyro-requests] Discord notification failed for request #' + job.row.number + '.');
        if (result.retryAfter !== undefined || (await tx.list({ prefix: 'notification:', limit: 1 })).size) await tx.setAlarm(Date.now() + (result.retryAfter || 0));
      }
    });
  }
}

async function requestBoard(env, input) {
  if (!env.KYRO_REQUESTS) throw fail(500, 'board_unbound', 'The KYRO_REQUESTS Durable Object is not bound to this worker.');
  const board = env.KYRO_REQUESTS.get(env.KYRO_REQUESTS.idFromName('community'));
  const response = await board.fetch('https://requests.internal/', { method: 'POST', body: JSON.stringify(input) });
  const data = await response.json();
  if (!response.ok) throw fail(response.status, data.code, data.error);
  return data.rows;
}

function isAdmin(session, env) {
  return Boolean(session && session.inServer && (session.isOwner || String(env.KYRO_ADMIN_IDS || '').split(',').map(id => id.trim()).includes(session.id)));
}

function requestReference(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.length > 500) throw fail(400, 'bad_reference', 'The reference link must be 500 characters or fewer.');
  try {
    const url = new URL(raw);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error();
    if (url.href.length > 500) throw new Error();
    return url.href;
  } catch { throw fail(400, 'bad_reference', 'Use an HTTP or HTTPS reference link of 500 characters or fewer without login details.'); }
}

const KYRO_ICON_URL = 'https://raw.githubusercontent.com/kyroownr/Kyro-Websitee/main/assets/kyro-icon.png';
const REQUEST_CATEGORY_LABELS = { extension: 'Extension', script: 'Script', preset: 'Preset', project: 'Project', soundfx: 'Sound FX', other: 'Other' };
const REQUEST_OS_LABELS = { windows: 'Windows', macos: 'macOS', both: 'Both' };
const REQUEST_DISCORD_STATUSES = {
  open: { label: '⏳ PENDING', color: 0x5865f2 },
  planned: { label: '📋 PLANNED', color: 0xf0b232 },
  in_progress: { label: '🛠️ IN PROGRESS', color: 0x3498db },
  shipped: { label: '✅ SHIPPED', color: 0x23a55a }
};

function discordText(value) {
  return value.replace(/[\\`*_{}\[\]()<>|~]/g, '\\$&');
}

function requestWebhookPayload(row, env) {
  const status = REQUEST_DISCORD_STATUSES[row.status];
  const site = env.KYRO_SITE_URL || 'https://kyro.new.tg';
  const buttons = [{ type: 2, style: 5, label: 'View Kyro', url: site }];
  if (row.reference) buttons.push({ type: 2, style: 5, label: 'View Reference', url: row.reference });
  const votes = row.voters.length;
  return {
    username: 'Kyro Request Monitor', avatar_url: KYRO_ICON_URL,
    allowed_mentions: { parse: [], users: [], roles: [], replied_user: false },
    embeds: [{
      author: { name: 'Kyro Request Monitor', icon_url: KYRO_ICON_URL, url: site },
      thumbnail: { url: KYRO_ICON_URL },
      title: discordText(row.title), ...(row.reference ? { url: row.reference } : {}),
      description: '**Details**\n' + discordText(row.desc || 'No description supplied.'),
      color: status.color,
      fields: [
        { name: 'Product / Category', value: REQUEST_CATEGORY_LABELS[row.category], inline: true },
        { name: 'Requested By', value: discordText(row.author_name) + (row.author_role === 'owner' ? '\n✅ OWNER · verified server owner' : ''), inline: true },
        { name: 'Status', value: status.label, inline: true },
        { name: 'AE Version', value: row.ae_versions.includes('any') ? 'Any AE version' : 'AE ' + row.ae_versions.join(' / '), inline: true },
        { name: 'OS Target', value: REQUEST_OS_LABELS[row.os], inline: true },
        { name: 'Request ID', value: '#' + row.number, inline: true }
      ],
      footer: { text: 'Kyro Requests · 👍 ' + votes + (votes === 1 ? ' vote' : ' votes') + ' at submission · React to discuss', icon_url: KYRO_ICON_URL },
      timestamp: row.created
    }],
    components: [{ type: 1, components: buttons }]
  };
}

function discordRetryAfter(response, data = {}) {
  const seconds = [response.headers.get('retry-after'), response.headers.get('x-ratelimit-reset-after'), data.retry_after]
    .filter(value => value !== null && value !== undefined && value !== '')
    .map(Number).filter(value => Number.isFinite(value) && value >= 0);
  return seconds.length ? Math.max(1, Math.ceil(Math.max(...seconds) * 1000)) : 30000;
}

async function notifyRequest(row, env) {
  try {
    const url = new URL(env.DISCORD_REQUESTS_WEBHOOK_URL);
    if (url.protocol !== 'https:' || url.hostname !== 'discord.com' || url.port || url.username || url.password || !/^\/api(?:\/v\d+)?\/webhooks\/\d+\/[\w-]+$/.test(url.pathname)) throw new Error();
    url.searchParams.set('wait', 'true');
    url.searchParams.set('with_components', 'true');
    const response = await fetch(url.href, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(8000), redirect: 'manual',
      body: JSON.stringify(requestWebhookPayload(row, env))
    });
    if (response.status === 429) return { sent: false, retryAfter: discordRetryAfter(response, await response.json().catch(() => ({}))) };
    if (response.status >= 500) return { sent: false, retryAfter: 5000 };
    if (!response.ok) return { sent: false };
    return { sent: true, ...(response.headers.get('x-ratelimit-remaining') === '0' ? { retryAfter: discordRetryAfter(response) } : {}) };
  } catch (err) {
    console.warn('[kyro-requests] Discord send error: ' + err.name);
    // A timed-out send may already exist in Discord; retrying can duplicate it.
    return { sent: false };
  }
}

/* Voter ids never leave the worker: the board exposes a count and, for the
   caller only, whether that caller is among them. */
function project(rows, viewerId) {
  return rows
    .map(r => ({
      id: r.id,
      number: r.number || null,
      title: r.title,
      category: r.category,
      os: r.os,
      ae_versions: r.ae_versions,
      reference: r.reference,
      starter: Boolean(r.starter),
      author_name: r.author_name || '',
      author_role: r.author_role === 'owner' ? 'owner' : 'member',
      desc: r.desc,
      status: REQ_STATUSES.includes(r.status) ? r.status : 'open',
      created: r.created,
      votes: (r.voters || []).length,
      you_voted: Boolean(viewerId) && (r.voters || []).indexOf(viewerId) !== -1
    }))
    .sort((a, b) => b.votes - a.votes || String(b.created).localeCompare(String(a.created)));
}

/* Shared by the board and the counters: both belong to members, and the copy
   has to stay true whichever route called it. */
async function requireMember(token, env) {
  if (!token) throw fail(401, 'missing_token', 'Sign in with Discord to use the Kyro community features.');
  const session = await readSession(token, env);
  if (!session.inServer) {
    throw fail(403, 'not_a_member', 'Join the Kyro Discord server to use the Kyro community features.');
  }
  return session;
}

/* A bearer token belongs in a header, not in a URL that analytics and worker
   logs happily keep. ?token= still works for curl and for the OAuth hand-off. */
function bearerToken(request, url) {
  const header = request.headers.get('authorization') || '';
  const match = header.match(/^Bearer\s+(\S+)$/i);
  return (match && match[1]) || url.searchParams.get('token') || '';
}

async function handleRequests(request, url, env, cors) {
  if (request.method === 'GET') {
    let session = null;
    const token = bearerToken(request, url);
    if (token) {
      try { session = await readSession(token, env); } catch { session = null; }
    }
    const rows = await requestBoard(env, { action: 'read' });
    return json({ requests: project(rows, session && session.inServer ? session.id : ''), is_admin: isAdmin(session, env), is_owner: Boolean(session && session.isOwner) }, 200, cors);
  }
  if (request.method !== 'POST') return json({ error: 'Use GET or POST.' }, 405, cors);
  const input = await jsonBody(request);
  const session = await requireMember(bearerToken(request, url) || input.token, env);
  if (typeof input.title !== 'string') throw fail(400, 'bad_title', 'Give the request a title.');
  const title = cleanText(input.title, 90);
  if (title.length < 3) throw fail(400, 'bad_title', 'Give the request a title of at least 3 characters.');
  if (!REQ_CATEGORIES.includes(input.category)) throw fail(400, 'bad_category', 'Choose a request category.');
  if (!REQ_OS.includes(input.os)) throw fail(400, 'bad_os', 'Choose Windows, macOS, or Both.');
  if (!Array.isArray(input.ae_versions) || !input.ae_versions.length || input.ae_versions.length > 3 || input.ae_versions.some(version => !REQ_AE.includes(version))) {
    throw fail(400, 'bad_ae_versions', 'Choose AE 2024, 2025, 2026, or Any.');
  }
  const versions = [...new Set(input.ae_versions)].sort();
  if (versions.includes('any') && versions.length > 1) throw fail(400, 'bad_ae_versions', 'Any cannot be combined with a specific AE version.');
  const row = {
    id: crypto.randomUUID(), title, category: input.category, os: input.os,
    ae_versions: versions, reference: requestReference(input.reference), desc: cleanText(input.desc, 280),
    status: 'open', created: new Date().toISOString(), by: session.id, voters: [session.id],
    author_name: session.username, author_role: session.isOwner ? 'owner' : 'member'
  };
  const written = await requestBoard(env, { action: 'create', row });
  const notification = env.DISCORD_REQUESTS_WEBHOOK_URL ? 'queued' : 'not_configured';
  return json({ id: row.id, requests: project(written, session.id), is_admin: isAdmin(session, env), is_owner: Boolean(session && session.isOwner), notification }, 201, cors);
}

async function handleVote(request, env, cors) {
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405, cors);
  const input = await jsonBody(request);
  const session = await requireMember(bearerToken(request, new URL(request.url)) || input.token, env);
  const id = cleanText(input.id, 60);
  if (!id) throw fail(400, 'bad_id', 'Missing request id.');

  const written = await requestBoard(env, { action: 'vote', id, viewerId: session.id });
  return json({ requests: project(written, session.id), is_admin: isAdmin(session, env), is_owner: Boolean(session && session.isOwner) }, 200, cors);
}

async function handleStatus(request, env, cors) {
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405, cors);
  const input = await jsonBody(request);
  const session = await requireMember(bearerToken(request, new URL(request.url)) || input.token, env);

  if (!isAdmin(session, env)) throw fail(403, 'not_an_admin', 'Only the Discord server owner or Kyro admins can change a request status.');

  const status = cleanText(input.status, 20);
  if (REQ_STATUSES.indexOf(status) === -1) {
    throw fail(400, 'bad_status', 'Status must be one of ' + REQ_STATUSES.join(', ') + '.');
  }

  const id = cleanText(input.id, 60);
  if (!id) throw fail(400, 'bad_id', 'Missing request id.');
  const written = await requestBoard(env, { action: 'status', id, status });
  return json({ requests: project(written, session.id), is_admin: true, is_owner: session.isOwner }, 200, cors);
}

async function handleDelete(request, env, cors) {
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405, cors);
  const input = await jsonBody(request);
  const session = await requireMember(bearerToken(request, new URL(request.url)) || input.token, env);
  if (!session.isOwner) throw fail(403, 'not_the_owner', 'Only the Discord server owner can delete a request.');
  const id = cleanText(input.id, 60);
  if (!id) throw fail(400, 'bad_id', 'Missing request id.');
  const written = await requestBoard(env, { action: 'delete', id });
  return json({ requests: project(written, session.id), is_admin: true, is_owner: true }, 200, cors);
}

/* ------------------------------ feedback board ---------------------------- */
const FEEDBACK_KEY = 'kyro.feedback.v1';

async function handleFeedback(request, url, env, cors) {
  if (request.method === 'GET') {
    const token = bearerToken(request, url);
    await requireMember(token, env);
    const doc = (await readDoc(env, FEEDBACK_KEY, { items: [] })).value || { items: [] };
    const items = (Array.isArray(doc.items) ? doc.items : []).map(item => {
      if (item.anonymous) {
        return {
          id: item.id,
          rating: item.rating,
          feedback: item.feedback,
          improvements: item.improvements || '',
          anonymous: true,
          author_name: 'Anonymous Editor',
          author_avatar: '',
          created: item.created
        };
      }
      return {
        id: item.id,
        rating: item.rating,
        feedback: item.feedback,
        improvements: item.improvements || '',
        anonymous: false,
        author_name: item.author_name || 'Member',
        author_avatar: item.author_avatar || '',
        created: item.created
      };
    });
    return json({ feedback: items }, 200, cors);
  }

  if (request.method !== 'POST') return json({ error: 'Use GET or POST.' }, 405, cors);

  const input = await jsonBody(request);
  const session = await requireMember(bearerToken(request, url) || input.token, env);

  const rating = Number(input.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw fail(400, 'bad_rating', 'Rating must be an integer between 1 and 5 stars.');
  }

  const feedback = cleanText(input.feedback, 1000);
  if (!feedback || feedback.length < 5) {
    throw fail(400, 'bad_feedback', 'Please share feedback of at least 5 characters.');
  }

  const improvements = cleanText(input.improvements, 1000);
  const anonymous = Boolean(input.anonymous);

  const entry = {
    id: crypto.randomUUID(),
    rating,
    feedback,
    improvements,
    anonymous,
    author_id: session.id,
    author_name: session.username,
    author_avatar: session.avatar ? `https://cdn.discordapp.com/avatars/${session.id}/${session.avatar}.png?size=64` : '',
    created: new Date().toISOString()
  };

  const written = await mutateDoc(env, FEEDBACK_KEY, { items: [] }, current => {
    const items = Array.isArray(current?.items) ? current.items : [];
    return { items: [entry, ...items].slice(0, 200) };
  });

  if (env.DISCORD_FEEDBACK_WEBHOOK_URL) {
    const starText = '★'.repeat(entry.rating) + '☆'.repeat(5 - entry.rating);
    const authorField = entry.anonymous ? 'Anonymous Editor' : `${session.username} (<@${session.id}>)`;
    const fields = [
      { name: 'Rating', value: `${starText} (${entry.rating}/5)`, inline: true },
      { name: 'Author', value: authorField, inline: true },
      { name: 'Feedback', value: entry.feedback, inline: false }
    ];
    if (entry.improvements) {
      fields.push({ name: 'Requested Improvements', value: entry.improvements, inline: false });
    }
    const payload = {
      embeds: [{
        title: '⭐ New Community Feedback',
        color: entry.rating >= 4 ? 0x10b981 : entry.rating === 3 ? 0xf59e0b : 0xef4444,
        fields,
        author: {
          name: entry.anonymous ? 'Anonymous Editor' : session.username,
          icon_url: entry.anonymous || !entry.author_avatar ? 'https://raw.githubusercontent.com/kyroownr/Kyro-Websitee/main/assets/kyro-icon.png' : entry.author_avatar
        },
        timestamp: entry.created
      }]
    };
    try {
      await fetch(env.DISCORD_FEEDBACK_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } catch (e) {
      console.warn('[kyro-feedback] Discord webhook failed:', e);
    }
  }

  const responseItems = (written.items || []).map(item => {
    if (item.anonymous) {
      return {
        id: item.id,
        rating: item.rating,
        feedback: item.feedback,
        improvements: item.improvements || '',
        anonymous: true,
        author_name: 'Anonymous Editor',
        author_avatar: '',
        created: item.created
      };
    }
    return {
      id: item.id,
      rating: item.rating,
      feedback: item.feedback,
      improvements: item.improvements || '',
      anonymous: false,
      author_name: item.author_name || 'Member',
      author_avatar: item.author_avatar || '',
      created: item.created
    };
  });

  return json({ feedback: responseItems }, 201, cors);
}

/* ------------------------------ download counts -------------------------- */

/* A counter, not a log: the ids of the members who already counted are kept
   only so a person is tallied once, never twice, however many times they
   click. Nothing that leaves the worker identifies them. */
const DL_KEY = 'kyro.downloads.v1';

function countsDoc(value) {
  const v = value && typeof value === 'object' ? value : {};
  return {
    counts: v.counts && typeof v.counts === 'object' ? v.counts : {},
    by: v.by && typeof v.by === 'object' ? v.by : {}
  };
}

async function handleDownloads(request, url, env, cors) {
  const doc = countsDoc((await readDoc(env, DL_KEY, { counts: {}, by: {} })).value);

  if (request.method === 'GET') return json({ counts: doc.counts }, 200, cors);
  if (request.method !== 'POST') return json({ error: 'Use GET or POST.' }, 405, cors);

  const input = await jsonBody(request);
  const session = await requireMember(bearerToken(request, new URL(request.url)) || input.token, env);
  const id = cleanText(input.id, 60);
  if (!id) throw fail(400, 'bad_id', 'Missing asset id.');

  const written = await mutateDoc(env, DL_KEY, { counts: {}, by: {} }, (current) => {
    const d = countsDoc(current);
    const seen = Array.isArray(d.by[session.id]) ? d.by[session.id] : [];
    if (seen.indexOf(id) !== -1) return d;
    d.by[session.id] = seen.concat([id]);
    d.counts[id] = (Number(d.counts[id]) || 0) + 1;
    return d;
  });

  return json({ id, downloads: Number(written.counts[id]) || 0, counts: written.counts }, 200, cors);
}

/* ------------------------------ discord calls ---------------------------- */

/* Discord answers a bad exchange with 400 + { error, error_description }.
   Both travel on to the site: masking them is what makes OAuth bugs unreadable. */
async function exchangeCode(code, request, env) {
  if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET) {
    throw Object.assign(
      new Error('The worker has no DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET set.'),
      { status: 500, code: 'worker_misconfigured' }
    );
  }

  const form = new URLSearchParams({
    client_id: String(env.DISCORD_CLIENT_ID),
    client_secret: String(env.DISCORD_CLIENT_SECRET),
    grant_type: 'authorization_code',
    code,
    // Must match the redirect_uri the site sent, byte for byte.
    redirect_uri: redirectUri(request, env),
    scope: 'identify guilds'
  });

  const res = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    const detail = data.error_description || data.error || ('Discord replied HTTP ' + res.status);
    throw Object.assign(
      new Error(detail),
      { status: res.status === 401 ? 401 : 400, code: data.error || 'token_exchange_failed' }
    );
  }
  return data.access_token;
}

/* The exchange is rejected unless this equals the authorize redirect_uri.
   A preview deploy runs on a different hostname, so allow an explicit override. */
function redirectUri(request, env) {
  return String(env.KYRO_REDIRECT_URI || (new URL(request.url).origin + '/callback'));
}

async function readSession(accessToken, env) {
  const user = await discord('https://discord.com/api/users/@me', accessToken);
  const guilds = await discord('https://discord.com/api/users/@me/guilds', accessToken);
  const guildId = String(env.KYRO_GUILD_ID || '');
  const guild = guildId ? guilds.find(g => String(g.id) === guildId) : undefined;
  return {
    username: user.username,
    tag: user.discriminator && user.discriminator !== '0' ? user.username + '#' + user.discriminator : user.username,
    id: String(user.id),
    avatar: user.avatar || '',
    inServer: Boolean(guild),
    isOwner: Boolean(guild && guild.owner === true)
  };
}

async function discord(href, accessToken) {
  const res = await fetch(href, { headers: { authorization: 'Bearer ' + accessToken } });
  // 401 must stay 401: the site keys its "sign in again" path off that status.
  if (res.status === 401) throw Object.assign(
    new Error('Discord rejected this session (401). Sign in again.'), { status: 401, code: 'invalid_token' }
  );
  if (!res.ok) throw Object.assign(
    new Error('Discord API error ' + res.status), { status: 502, code: 'discord_api_error' }
  );
  return res.json();
}

/* -------------------------------- plumbing ------------------------------- */

function allowedOrigins(env) {
  return String(env.KYRO_ALLOWED_ORIGINS || DEFAULT_ORIGINS).split(',').map(o => o.trim().replace(/\/$/, '')).filter(Boolean);
}

function corsHeaders(request, env) {
  const origin = request.headers.get('origin') || '';
  const headers = {
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-max-age': '600',
    vary: 'Origin'
  };
  if (allowedOrigins(env).includes(origin.replace(/\/$/, ''))) {
    headers['access-control-allow-origin'] = origin;
  }
  return headers;
}

/* Where /callback sends the visitor: KYRO_SITE_URL, or the calling origin when
   that origin is allow-listed. Never an unvalidated header — that is an open
   redirect. */
function redirectBase(request, env) {
  if (env.KYRO_SITE_URL) return String(env.KYRO_SITE_URL).replace(/\/$/, '');
  const origin = (request.headers.get('origin') || '').replace(/\/$/, '');
  if (allowedOrigins(env).includes(origin)) return origin;
  return allowedOrigins(env)[0];
}

function target(base, params) {
  const url = new URL(base + '/');
  for (const [key, value] of Object.entries(params)) {
    if (value === '' || value === null || value === undefined) continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function json(payload, status, cors) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, cors)
  });
}
