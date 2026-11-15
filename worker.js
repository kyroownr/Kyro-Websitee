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

const DEFAULT_ORIGINS = 'https://kyro.new.tg,http://localhost:4173,http://127.0.0.1:4173,http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000,http://127.0.0.1:3000,http://localhost:8080,http://127.0.0.1:8080,http://localhost:8000,http://127.0.0.1:8000,http://localhost:4000,http://127.0.0.1:4000';

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
      if (url.pathname === '/invite') return await handleInvite(request, url, env, cors);
      if (url.pathname === '/vault/upload-image') return await handleVaultImageUpload(request, url, env, cors);
      if (url.pathname === '/vault/submissions') return await handleVaultSubmissions(request, url, env, cors);
      if (url.pathname === '/vault/submissions/review') return await handleVaultSubmissionReview(request, url, env, cors);
      if (url.pathname === '/vault/submissions/manage') return await handleVaultSubmissionManage(request, url, env, cors);
      if (url.pathname === '/vault/notifications') return await handleVaultNotifications(request, url, env, cors);
      if (url.pathname === '/vault/public') return await handleVaultPublic(request, url, env, cors);
      if (url.pathname === '/vault/incoming') return await handleIncomingReleases(request, url, env, cors);
      if (url.pathname === '/vault/incoming/vote') return await handleIncomingVote(request, url, env, cors);
      if (url.pathname === '/early-access') return await handleEarlyAccess(request, url, env, cors);
      if (url.pathname === '/api/vault/publish') return await handleVaultPublish(request, url, env, cors);
      if (url.pathname === '/dashboard/settings') return await handleDashboardSettings(request, url, env, cors);
      if (url.pathname === '/dashboard/embed') return await handleDashboardEmbed(request, url, env, cors);
      if (url.pathname === '/dashboard/lockdown') return await handleDashboardLockdown(request, url, env, cors);
      if (url.pathname === '/dashboard/moderate') return await handleDashboardModerate(request, url, env, cors);
      if (url.pathname === '/dashboard/alert-monitor') return await handleAlertMonitorTrigger(request, url, env, cors);
      if (url.pathname === '/dashboard/audit') return await handleDashboardAudit(request, url, env, cors);
      return json({ error: 'Unknown route. Use /callback, /verify, /requests, /feedback, /invite, /downloads or /dashboard/*.' }, 404, cors);
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
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAlertSectionMemberMonitor(env));
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
    role: session.role || 'Member',
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
    role: session.role || (session.isOwner ? 'Owner' : 'Member'),
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

/* A member manages only the requests they posted; the owner and admins keep the
   whole board for moderation. Signed-out visitors still see the public showcase. */
function projectForViewer(rows, session, env) {
  const viewerId = session && session.inServer ? session.id : '';
  const visible = viewerId && !isAdmin(session, env) ? rows.filter(r => r.by === viewerId) : rows;
  return project(visible, viewerId);
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
    return json({ requests: projectForViewer(rows, session, env), is_admin: isAdmin(session, env), is_owner: Boolean(session && session.isOwner) }, 200, cors);
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
  return json({ id: row.id, requests: projectForViewer(written, session, env), is_admin: isAdmin(session, env), is_owner: Boolean(session && session.isOwner), notification }, 201, cors);
}

async function handleVote(request, env, cors) {
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405, cors);
  const input = await jsonBody(request);
  const session = await requireMember(bearerToken(request, new URL(request.url)) || input.token, env);
  const id = cleanText(input.id, 60);
  if (!id) throw fail(400, 'bad_id', 'Missing request id.');

  const written = await requestBoard(env, { action: 'vote', id, viewerId: session.id });
  return json({ requests: projectForViewer(written, session, env), is_admin: isAdmin(session, env), is_owner: Boolean(session && session.isOwner) }, 200, cors);
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
  return json({ requests: projectForViewer(written, session, env), is_admin: true, is_owner: session.isOwner }, 200, cors);
}

async function handleDelete(request, env, cors) {
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405, cors);
  const input = await jsonBody(request);
  const session = await requireMember(bearerToken(request, new URL(request.url)) || input.token, env);
  if (!session.isOwner) throw fail(403, 'not_the_owner', 'Only the Discord server owner can delete a request.');
  const id = cleanText(input.id, 60);
  if (!id) throw fail(400, 'bad_id', 'Missing request id.');
  const written = await requestBoard(env, { action: 'delete', id });
  return json({ requests: projectForViewer(written, session, env), is_admin: true, is_owner: true }, 200, cors);
}

/* ------------------------------ feedback board ---------------------------- */
const FEEDBACK_KEY = 'kyro.feedback.v1';

/* Author ids never leave the worker; anonymous entries lose their identity for
   everyone but the person who wrote them (the list is already filtered to them). */
function feedbackView(items) {
  return items.map(item => item.anonymous
    ? {
        id: item.id, rating: item.rating, feedback: item.feedback,
        improvements: item.improvements || '', anonymous: true,
        author_name: 'Anonymous Editor', author_avatar: '', created: item.created
      }
    : {
        id: item.id, rating: item.rating, feedback: item.feedback,
        improvements: item.improvements || '', anonymous: false,
        author_name: item.author_name || 'Member', author_avatar: item.author_avatar || '', created: item.created
      });
}

async function handleFeedback(request, url, env, cors) {
  if (request.method === 'GET') {
    const token = bearerToken(request, url);
    const session = await requireMember(token, env);
    const admin = isAdmin(session, env);
    const doc = (await readDoc(env, FEEDBACK_KEY, { items: [] })).value || { items: [] };
    const all = Array.isArray(doc.items) ? doc.items : [];
    const visible = admin ? all : all.filter(item => item.author_id === session.id);
    return json({ feedback: feedbackView(visible), is_admin: admin, is_owner: Boolean(session.isOwner) }, 200, cors);
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

  const admin = isAdmin(session, env);
  const responseItems = feedbackView((written.items || []).filter(item => admin || item.author_id === session.id));

  return json({ feedback: responseItems, is_admin: admin, is_owner: Boolean(session.isOwner) }, 201, cors);
}

async function handleInvite(request, url, env, cors) {
  if (request.method !== 'GET' && request.method !== 'POST') return json({ error: 'Use GET or POST.' }, 405, cors);

  const token = bearerToken(request, url);
  if (!token) {
    return json({ invite_url: 'https://discord.gg/5ch7XeNg98', code: '5ch7XeNg98' }, 200, cors);
  }

  let session = null;
  try {
    session = await readSession(token, env);
  } catch {
    return json({ invite_url: 'https://discord.gg/5ch7XeNg98', code: '5ch7XeNg98' }, 200, cors);
  }

  if (!session || !session.id) {
    return json({ invite_url: 'https://discord.gg/5ch7XeNg98', code: '5ch7XeNg98' }, 200, cors);
  }

  // Check KV cache for user's personal invite
  const cacheKey = 'user_invite:' + session.id;
  const cached = await env.KYRO_DATA.get(cacheKey);
  if (cached) {
    return json({ invite_url: `https://discord.gg/${cached}`, code: cached }, 200, cors);
  }

  // Look for any existing invite created by this user first
  if (env.DISCORD_BOT_TOKEN) {
    try {
      const guildId = String(env.DISCORD_GUILD_ID || env.KYRO_GUILD_ID);
      const listRes = await fetch(`https://discord.com/api/v10/guilds/${guildId}/invites`, {
        headers: { authorization: 'Bot ' + env.DISCORD_BOT_TOKEN }
      });
      if (listRes.ok) {
        const invites = await listRes.json();
        const existing = invites.find(i => i.inviter && i.inviter.id === session.id);
        if (existing && existing.code) {
          await env.KYRO_DATA.put(cacheKey, existing.code, { expirationTtl: 86400 * 30 });
          return json({ invite_url: `https://discord.gg/${existing.code}`, code: existing.code }, 200, cors);
        }
      }

      // If user is owner sxii123, return the official 5ch7XeNg98
      if (session.id === '1052909930073567232') {
        return json({ invite_url: 'https://discord.gg/5ch7XeNg98', code: '5ch7XeNg98' }, 200, cors);
      }

      // Otherwise generate a fresh invite for this user
      const channelId = env.DISCORD_PUBLIC_APPS_CHANNEL_ID || '1542135796369457182';
      const invRes = await fetch(`https://discord.com/api/v10/channels/${channelId}/invites`, {
        method: 'POST',
        headers: {
          authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          max_age: 0,
          max_uses: 0,
          unique: true
        })
      });

      const invData = await invRes.json();
      if (invData && invData.code) {
        await env.KYRO_DATA.put(cacheKey, invData.code, { expirationTtl: 86400 * 30 });
        return json({ invite_url: `https://discord.gg/${invData.code}`, code: invData.code }, 200, cors);
      }
    } catch (invErr) {
      console.warn('[kyro-invite] Failed to create personal invite:', invErr);
    }
  }

  return json({ invite_url: 'https://discord.gg/5ch7XeNg98', code: '5ch7XeNg98' }, 200, cors);
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

async function sha256(text) {
  const bytes = new TextEncoder().encode(String(text));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

async function readSession(accessToken, env) {
  if (!accessToken) throw fail(401, 'missing_token', 'No access token provided.');

  // Cache only the stable identity; membership/owner/role are resolved live so
  // a transferred owner or demoted moderator loses access immediately.
  const cacheKey = 'kyro.identity_cache.' + (await sha256(accessToken)).slice(0, 32);
  let user = null;
  if (env.KYRO_DATA) {
    try {
      const cached = await env.KYRO_DATA.get(cacheKey, 'json');
      if (cached && cached.id && cached.username) user = cached;
    } catch {}
  }
  if (!user) {
    user = await discord('https://discord.com/api/users/@me', accessToken);
    if (env.KYRO_DATA) {
      try {
        await env.KYRO_DATA.put(cacheKey, JSON.stringify({ id: user.id, username: user.username, discriminator: user.discriminator, avatar: user.avatar }), { expirationTtl: 300 });
      } catch {}
    }
  }

  const guilds = await discord('https://discord.com/api/users/@me/guilds', accessToken);
  const guildId = String(env.KYRO_GUILD_ID || '');
  const guild = guildId ? guilds.find(g => String(g.id) === guildId) : undefined;
  
  let roleName = 'Member';
  let isOwner = Boolean(guild && guild.owner === true);
  if (user.id === '1052909930073567232') {
    isOwner = true;
    roleName = 'Owner';
  } else if (guild && env.DISCORD_BOT_TOKEN) {
    try {
      const memberRes = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members/${user.id}`, {
        headers: { authorization: 'Bot ' + env.DISCORD_BOT_TOKEN }
      });
      if (memberRes.ok) {
        const member = await memberRes.json();
        const mRoles = member.roles || [];
        if (mRoles.includes('1539968441094512710')) roleName = 'Owner';
        else if (mRoles.includes('1542090972765360208')) roleName = 'Mod+';
        else if (mRoles.includes('1571073124328276078')) roleName = 'Contributor';
        else if (mRoles.includes('1571073534103527504')) roleName = 'Support';
        else if (mRoles.includes('1542127783440818226')) roleName = 'Member';
        else if (mRoles.includes('1542128056439799839')) roleName = 'Editor';
        else if (mRoles.includes('1542128525509927003')) roleName = 'Explorer';
        else if (mRoles.includes('1548284444270395416')) roleName = 'Gumroad';
      }
    } catch (e) {
      console.warn('[kyro-auth] Guild member lookup failed:', e);
    }
  }

  const session = {
    username: user.username,
    tag: user.discriminator && user.discriminator !== '0' ? user.username + '#' + user.discriminator : user.username,
    id: String(user.id),
    avatar: user.avatar || '',
    inServer: Boolean(guild),
    isOwner,
    role: roleName
  };

  return session;
}

async function discord(href, accessToken) {
  let res = await fetch(href, { headers: { authorization: 'Bearer ' + accessToken } });

  // Handle 429 Too Many Requests with retry
  if (res.status === 429) {
    const rateLimitData = await res.json().catch(() => ({}));
    const retryAfter = Math.min(3, Number(rateLimitData.retry_after) || 1);
    await new Promise(r => setTimeout(r, retryAfter * 1000));
    res = await fetch(href, { headers: { authorization: 'Bearer ' + accessToken } });
  }

  // 401 must stay 401: the site keys its "sign in again" path off that status.
  if (res.status === 401) throw Object.assign(
    new Error('Discord rejected this session (401). Sign in again.'), { status: 401, code: 'invalid_token' }
  );
  if (!res.ok) {
    if (res.status === 429) {
      throw Object.assign(
        new Error('Discord rate limit reached. Please wait a few seconds and try again.'),
        { status: 429, code: 'rate_limited' }
      );
    }
    throw Object.assign(
      new Error('Discord API error ' + res.status), { status: 502, code: 'discord_api_error' }
    );
  }
  return res.json();
}

/* ----------------------- Vault Submissions (Contributor & Owner) ------------------------ */
const VAULT_SUBMISSIONS_KEY = 'kyro.vault_submissions.v1';
const VAULT_PUBLIC_ITEMS_KEY = 'kyro.vault_approved_items.v1';
/* Catalogue entries live in js/data.js, so deleting one cannot remove a KV
   record. Tombstones keep them hidden after a refresh instead of letting the
   seed file put the card straight back. */
const HIDDEN_RESOURCES_KEY = 'kyro.hidden_resources.v1';
const INCOMING_PREVIEW_URL = 'https://kyro.new.tg/assets/incoming-preview.png';

async function handleVaultImageUpload(request, url, env, cors) {
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405, cors);
  const token = bearerToken(request, url);
  const session = await requireMember(token, env);
  const role = (session.role || '').toLowerCase();
  const isContributor = session.isOwner || session.id === '1052909930073567232' || role === 'owner' || role === 'contributor' || role === 'mod+';
  if (!isContributor) throw fail(403, 'forbidden', 'Only Contributors or the Server Owner can upload images.');

  if (!env.DISCORD_BOT_TOKEN) throw fail(500, 'no_bot_token', 'Discord bot token is not configured.');

  const contentType = request.headers.get('content-type') || '';
  let imageBlob = null;
  let filename = 'resource_image.png';

  if (contentType.includes('application/json')) {
    const body = await jsonBody(request);
    if (!body.image) throw fail(400, 'no_image', 'No base64 image data provided.');
    const match = body.image.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
    if (!match) throw fail(400, 'bad_base64', 'Invalid image data URI.');
    const mime = match[1];
    const b64 = match[2];
    const binary = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    imageBlob = new Blob([binary], { type: mime });
    filename = body.filename || `image_${Date.now()}.${mime.split('/')[1] || 'png'}`;
  } else if (contentType.includes('multipart/form-data')) {
    const formData = await request.formData();
    const file = formData.get('file') || formData.get('image');
    if (!file) throw fail(400, 'no_file', 'No file found in form data.');
    imageBlob = file;
    filename = file.name || 'uploaded_image.png';
  } else {
    throw fail(400, 'bad_content_type', 'Send JSON base64 or multipart form data.');
  }

  // Upload silently to hidden backend storage channel (1571185513401159720) to generate permanent Discord CDN attachment URL
  const channelId = env.DISCORD_MEDIA_CHANNEL_ID || '1571185513401159720';
  const discordForm = new FormData();
  discordForm.append('files[0]', imageBlob, filename);

  const uploadRes = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST',
    headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN },
    body: discordForm
  });

  if (!uploadRes.ok) {
    const errText = await uploadRes.text();
    throw fail(uploadRes.status, 'discord_upload_failed', `Discord upload rejected: ${errText}`);
  }

  const msgData = await uploadRes.json();
  const attachmentUrl = msgData.attachments?.[0]?.url;
  if (!attachmentUrl) throw fail(500, 'no_attachment_returned', 'Discord did not return attachment URL.');

  return json({ ok: true, url: attachmentUrl }, 200, cors);
}

async function handleVaultPublic(request, url, env, cors) {
  if (request.method !== 'GET') return json({ error: 'Use GET.' }, 405, cors);
  const [doc, hiddenDoc] = await Promise.all([
    readDoc(env, VAULT_PUBLIC_ITEMS_KEY, { items: [] }),
    readDoc(env, HIDDEN_RESOURCES_KEY, { ids: [] })
  ]);
  const hidden = hiddenTokens(hiddenDoc?.value?.ids);
  const hiddenSet = new Set(hidden);
  const items = (Array.isArray(doc?.value?.items) ? doc.value.items : [])
    .filter(item => !hiddenSet.has(String(item.id || '').toLowerCase()) && !hiddenSet.has(String(item.slug || '').toLowerCase()));
  return json({ items, hidden }, 200, cors);
}

function hiddenTokens(input) {
  const list = Array.isArray(input) ? input : [input];
  return [...new Set(list.map(value => String(value == null ? '' : value).trim().toLowerCase()).filter(Boolean))];
}

async function hideVaultResources(env, input) {
  const tokens = hiddenTokens(input);
  if (!tokens.length) return [];
  let added = [];
  await mutateDoc(env, HIDDEN_RESOURCES_KEY, { ids: [] }, curr => {
    const ids = hiddenTokens(curr?.ids);
    const set = new Set(ids);
    tokens.forEach(token => {
      if (!set.has(token)) { set.add(token); added.push(token); }
    });
    // Keep the list bounded; old tombstones are the least useful.
    return { ids: [...set].slice(-500) };
  });
  return added;
}

async function restoreVaultResources(env, input) {
  const tokens = hiddenTokens(input);
  if (!tokens.length) return;
  await mutateDoc(env, HIDDEN_RESOURCES_KEY, { ids: [] }, curr => {
    const remove = new Set(tokens);
    return { ids: hiddenTokens(curr?.ids).filter(token => !remove.has(token)) };
  });
}

async function handleVaultSubmissions(request, url, env, cors) {
  const token = bearerToken(request, url);
  const session = await requireMember(token, env);
  const role = (session.role || '').toLowerCase();
  const isOwner = session.isOwner || session.id === '1052909930073567232' || role === 'owner';
  const isContributor = isOwner || role === 'contributor' || role === 'mod+';

  if (!isContributor) throw fail(403, 'forbidden', 'Only Contributors or the Server Owner can upload resources to the Kyro Vault.');

  if (request.method === 'GET') {
    const doc = (await readDoc(env, VAULT_SUBMISSIONS_KEY, { submissions: [] })).value;
    const all = doc.submissions || [];
    // Owner sees all, contributor sees their own
    const visible = isOwner ? all : all.filter(s => s.by === session.id);
    return json({ submissions: visible, is_owner: isOwner }, 200, cors);
  }

  if (request.method === 'POST') {
    const input = await jsonBody(request);
    const title = cleanText(input.title || input.name, 120);
    let rawSlug = cleanText(input.slug || title.toLowerCase().replace(/[^a-z0-9]+/g, '-'), 80).replace(/^-|-$/g, '');
    if (/^https?:\/\//i.test(rawSlug)) {
      try {
        const u = new URL(rawSlug);
        const parts = u.pathname.split('/').filter(Boolean);
        rawSlug = parts[parts.length - 1] || u.hash.replace(/^#\/?/, '') || u.hostname.replace(/\./g, '-');
      } catch {}
    }
    const slug = rawSlug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    if (!title || title.length < 3) throw fail(400, 'bad_title', 'Provide a valid resource title.');
    if (!slug) throw fail(400, 'bad_slug', 'Provide a URL slug.');

    const kind = input.kind === 'software' ? 'software' : 'tool';
    const os = ['windows', 'macos', 'both'].includes(input.os) ? input.os : 'windows';
    const category = cleanText(input.category || 'Adobe After Effects', 60);
    const downloadUrl = cleanText(input.download_url, 500);
    const imageUrl = cleanText(input.image_url, 500);
    const size = cleanText(input.size || 'Vault Build', 40);
    const creator = cleanText(input.creator || session.username, 60);
    const details = cleanText(input.details || input.desc, 2000);
    const version = cleanText(input.version || '1.0', 40);
    const password = cleanText(input.password || input.pass, 60);
    const releaseAt = input.release_at || input.releaseAt || null;

    const submission = {
      id: crypto.randomUUID(),
      title,
      slug,
      kind,
      os,
      category,
      download_url: downloadUrl,
      image_url: imageUrl,
      size,
      creator,
      details,
      version,
      pass: password || undefined,
      releaseAt: releaseAt || undefined,
      by: session.id,
      by_username: session.username,
      created: new Date().toISOString(),
      status: isOwner ? 'approved' : 'pending' // Owner submissions auto-approve; Contributor requires owner review
    };

    await restoreVaultResources(env, [slug, submission.id]);
    await mutateDoc(env, VAULT_SUBMISSIONS_KEY, { submissions: [] }, curr => {
      const submissions = Array.isArray(curr?.submissions) ? curr.submissions : [];
      return { submissions: [submission, ...submissions] };
    });

    if (isOwner) {
      // Add directly to public items & dispatch announcement
      await mutateDoc(env, VAULT_PUBLIC_ITEMS_KEY, { items: [] }, curr => {
        const items = Array.isArray(curr?.items) ? curr.items : [];
        return { items: [submission, ...items.filter(i => i.slug !== submission.slug)] };
      });
      // Post to Discord
      await dispatchKyroDiscordPublish(submission, env);
      await createNotification(env, session.id, 'Resource Published Directly', `Your resource "${submission.title}" is live on the Vault and posted to Discord!`, 'approved');
    } else {
      // User notification: Upload submitted waiting for confirmation
      await createNotification(env, session.id, 'Upload Submitted', `Your resource "${submission.title}" has been submitted and is waiting for owner approval.`, 'pending');

      // Owner notification: New request accept or deny
      const ownerId = '1052909930073567232';
      await createNotification(env, ownerId, 'New Resource Request', `New submission: "${submission.title}" by ${session.username}. Review it in Vault Uploads.`, 'request');

      // Notify Owner in Discord via Direct Message or staff channel
      if (env.DISCORD_BOT_TOKEN) {
        try {
          // Send DM to Owner
          const dmRes = await fetch('https://discord.com/api/v10/users/@me/channels', {
            method: 'POST',
            headers: { authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'content-type': 'application/json' },
            body: JSON.stringify({ recipient_id: ownerId })
          });
          if (dmRes.ok) {
            const dmChannel = await dmRes.json();
            await fetch(`https://discord.com/api/v10/channels/${dmChannel.id}/messages`, {
              method: 'POST',
              headers: { authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'content-type': 'application/json' },
              body: JSON.stringify({
                content: `📥 **New Contributor Resource Pending Review!**`,
                embeds: [{
                  title: `Review Required: ${submission.title}`,
                  description: `**Uploader:** <@${session.id}> (${session.username})\n**Category:** ${category}\n**Platform:** ${os.toUpperCase()}\n**Download URL:** ${downloadUrl || 'In details'}\n${password ? `**Password:** \`${password}\`\n` : ''}\n${details}`,
                  color: 0xf59e0b,
                  footer: { text: `Submission ID: ${submission.id} · Log into website or dashboard to Accept/Deny.` },
                  timestamp: submission.created
                }]
              })
            });
          }
        } catch (e) {
          console.warn('[submissions] Discord owner alert failed:', e);
        }
      }
    }

    await logBotAudit(
      env,
      isOwner ? 'Resource Published Directly' : 'Contributor Resource Submitted',
      session,
      `Resource "${submission.title}" (${submission.status})`
    );

    return json({ ok: true, submission }, 201, cors);
  }

  return json({ error: 'Use GET or POST.' }, 405, cors);
}

async function handleVaultSubmissionReview(request, url, env, cors) {
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405, cors);
  const token = bearerToken(request, url);
  const session = await requireMember(token, env);
  const isOwner = session.isOwner || session.id === '1052909930073567232' || (session.role || '').toLowerCase() === 'owner';
  if (!isOwner) throw fail(403, 'forbidden', 'Only the Kyro Server Owner can approve or reject contributor submissions.');

  const input = await jsonBody(request);
  const subId = input.id;
  const decision = input.decision; // 'approve' or 'reject'
  if (!subId || !['approve', 'reject'].includes(decision)) throw fail(400, 'bad_input', 'Provide submission ID and decision.');

  let reviewedSub = null;
  await mutateDoc(env, VAULT_SUBMISSIONS_KEY, { submissions: [] }, curr => {
    const list = Array.isArray(curr?.submissions) ? curr.submissions : [];
    const found = list.find(s => s.id === subId);
    if (found) {
      found.status = decision === 'approve' ? 'approved' : 'rejected';
      found.reviewed_by = session.username;
      found.reviewed_at = new Date().toISOString();
      reviewedSub = found;
    }
    return { submissions: list };
  });

  if (!reviewedSub) throw fail(404, 'not_found', 'Submission not found.');

  if (decision === 'approve') {
    // Add to public approved vault items
    await mutateDoc(env, VAULT_PUBLIC_ITEMS_KEY, { items: [] }, curr => {
      const items = Array.isArray(curr?.items) ? curr.items : [];
      return { items: [reviewedSub, ...items.filter(i => i.slug !== reviewedSub.slug)] };
    });
    // Publish automatically to Discord channels
    await dispatchKyroDiscordPublish(reviewedSub, env);

    // Notify uploader: approval accepted thanks for sharing
    if (reviewedSub.by) {
      await createNotification(
        env,
        reviewedSub.by,
        'Resource Approved! 🎉',
        `Approval accepted! Your resource "${reviewedSub.title}" is now published on the Vault and Discord. Thanks for sharing!`,
        'approved'
      );
    }
  } else {
    // Notify uploader: rejected
    if (reviewedSub.by) {
      await createNotification(
        env,
        reviewedSub.by,
        'Submission Update',
        `Your submission "${reviewedSub.title}" was not approved by the owner at this time.`,
        'rejected'
      );
    }
  }

  await logBotAudit(
    env,
    decision === 'approve' ? 'Contributor Resource Approved' : 'Contributor Resource Rejected',
    session,
    `Submission "${reviewedSub.title}" by ${reviewedSub.by_username}`
  );

  return json({ ok: true, submission: reviewedSub }, 200, cors);
}

async function createNotification(env, userId, title, message, type = 'info') {
  if (!userId) return;
  const notif = {
    id: crypto.randomUUID(),
    user_id: String(userId),
    title: String(title),
    message: String(message),
    type: String(type),
    read: false,
    created: new Date().toISOString()
  };
  try {
    await mutateDoc(env, NOTIFICATIONS_KEY, { notifications: [] }, curr => {
      const list = Array.isArray(curr?.notifications) ? curr.notifications : [];
      return { notifications: [notif, ...list].slice(0, 300) };
    });
  } catch (err) {
    console.warn('[notifications] Failed to persist notification:', err);
  }
}

async function handleVaultNotifications(request, url, env, cors) {
  const token = bearerToken(request, url);
  const session = await requireMember(token, env);

  if (request.method === 'GET') {
    const doc = (await readDoc(env, NOTIFICATIONS_KEY, { notifications: [] })).value;
    const all = Array.isArray(doc.notifications) ? doc.notifications : [];
    const userNotifs = all.filter(n => String(n.user_id) === String(session.id));
    return json({ notifications: userNotifs }, 200, cors);
  }

  if (request.method === 'POST') {
    // Mark as read
    const input = await jsonBody(request).catch(() => ({}));
    const targetId = input.id;
    await mutateDoc(env, NOTIFICATIONS_KEY, { notifications: [] }, curr => {
      const list = Array.isArray(curr?.notifications) ? curr.notifications : [];
      list.forEach(n => {
        if (String(n.user_id) === String(session.id) && (!targetId || n.id === targetId)) {
          n.read = true;
        }
      });
      return { notifications: list };
    });
    return json({ ok: true }, 200, cors);
  }

  return json({ error: 'Use GET or POST.' }, 405, cors);
}

/* -------------------------- Incoming Releases (Community Approval) -------------------------- */
async function handleIncomingReleases(request, url, env, cors) {
  if (request.method === 'GET') {
    const doc = (await readDoc(env, INCOMING_RELEASES_KEY, { items: [] })).value;
    const items = Array.isArray(doc.items) ? doc.items : [];
    
    // Resolve the viewer: owner/admin and early-access members skip the waitlist.
    let viewerId = '';
    let canBypass = false;
    try {
      const token = bearerToken(request, url);
      if (token) {
        const session = await readSession(token, env);
        if (session && session.inServer) {
          viewerId = session.id;
          canBypass = isAdmin(session, env) || await hasEarlyAccess(env, session.id);
        }
      }
    } catch {}

    const projected = items.map(item => {
      const voters = item.voters || {};
      const userVote = viewerId ? (voters[viewerId] || 0) : 0;
      const unlocked = Boolean(item.released) || canBypass;
      return {
        ...item,
        userVote,
        voters: undefined, // keep privacy
        early_access: canBypass && !item.released,
        // The direct link stays hidden until the goal is reached or the viewer
        // holds an early-access pass, so the waitlist is a real gate.
        download_url: unlocked ? item.download_url : undefined,
        pass: unlocked ? item.pass : undefined
      };
    });

    return json({ incoming: projected, earlyAccess: canBypass }, 200, cors);
  }

  if (request.method === 'POST') {
    // Create new incoming release (Contributor or Owner)
    const token = bearerToken(request, url);
    const session = await requireMember(token, env);
    const role = (session.role || '').toLowerCase();
    const isOwner = session.isOwner || session.id === '1052909930073567232' || role === 'owner';
    const isContributor = isOwner || role === 'contributor' || role === 'mod+';
    if (!isContributor) throw fail(403, 'forbidden', 'Only Contributors or the Server Owner can add Incoming releases.');

    const input = await jsonBody(request);
    const title = cleanText(input.title, 120);
    if (!title) throw fail(400, 'bad_input', 'Title is required.');
    let rawSlug = input.slug || title;
    const slug = rawSlug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || ('incoming-' + Date.now().toString(36));
    const kind = input.kind === 'software' ? 'software' : 'tool';
    const os = ['windows', 'macos', 'both'].includes(input.os) ? input.os : 'both';
    const category = cleanText(input.category || 'Adobe After Effects', 60);
    const downloadUrl = String(input.download_url || '').trim();
    const imageUrl = String(input.image_url || '').trim();
    const size = cleanText(input.size || 'Vault Build', 40);
    const creator = cleanText(input.creator || session.username, 60);
    const details = cleanText(input.details || '', 1500);
    const password = cleanText(input.password || input.pass, 60);
    const voteLimit = Math.max(1, Math.min(1000, parseInt(input.vote_limit, 10) || 5));

    const item = {
      id: crypto.randomUUID(),
      title,
      slug,
      kind,
      os,
      category,
      download_url: downloadUrl,
      image_url: imageUrl,
      size,
      creator,
      details,
      pass: password || undefined,
      votes: 0,
      voters: {}, // userId -> 1 or -1
      vote_limit: voteLimit,
      released: false,
      by: session.id,
      by_username: session.username,
      created: new Date().toISOString()
    };

    // Post to Discord channel #incomming (ID: 1539962334729211934 in category Special 1539962304701931643)
    let discordMsgId = null;
    if (env.DISCORD_BOT_TOKEN) {
      try {
        const incommingChannel = '1539962334729211934';
        const osLabel = os === 'both' ? 'Windows & macOS' : os === 'macos' ? 'macOS' : 'Windows';
        const embed = {
          author: { name: 'Kyro Incoming Release · Community Approval', icon_url: KYRO_ICON },
          title: `⏳ INCOMING: ${title.toUpperCase()}`,
          url: `https://kyro.new.tg#incoming`,
          description: `**Section Tagline:** *"Items waiting for community approval. Vote to bring them live."*\n\n` +
            (details ? `${details}\n\n` : '') +
            `• **Creator:** \`${creator}\`\n• **Platform:** \`${osLabel}\`\n• **Size:** \`${size}\`\n• **Category:** \`${category}\`\n\n` +
            `🎯 **Goal:** \`0 / ${voteLimit}\` Votes to Push Live!`,
          color: 0x38bdf8,
          image: imageUrl && /^https?:\/\//i.test(imageUrl) ? { url: imageUrl } : { url: INCOMING_PREVIEW_URL },
          footer: { text: 'Vote on kyro.new.tg to bring this item live!' },
          timestamp: item.created
        };

        const postRes = await fetch(`https://discord.com/api/v10/channels/${incommingChannel}/messages`, {
          method: 'POST',
          headers: { authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'content-type': 'application/json' },
          body: JSON.stringify({
            content: `🚀 **New Incoming Resource Waiting for Approval!** — @everyone`,
            allowed_mentions: { parse: ['everyone'] },
            embeds: [embed],
            components: [
              {
                type: 1,
                components: [
                  { type: 2, style: 5, label: 'Vote to Release ↗', url: 'https://kyro.new.tg#incoming' },
                  { type: 2, style: 5, label: 'Kyro Vault ↗', url: 'https://kyro.new.tg' }
                ]
              }
            ]
          })
        });
        if (postRes.ok) {
          const postData = await postRes.json();
          discordMsgId = postData.id;
        }
      } catch (err) {
        console.warn('[incoming] Discord announcement error:', err);
      }
    }

    item.discord_msg_id = discordMsgId;

    await mutateDoc(env, INCOMING_RELEASES_KEY, { items: [] }, curr => {
      const list = Array.isArray(curr?.items) ? curr.items : [];
      return { items: [item, ...list] };
    });

    await logBotAudit(env, 'Incoming Release Created', session, `"${title}" waiting for community approval (${voteLimit} votes required).`);
    return json({ ok: true, item }, 201, cors);
  }

  // Owner-only edit of an incoming release: vote count, goal, media and copy.
  if (request.method === 'PATCH') {
    const token = bearerToken(request, url);
    const session = await requireMember(token, env);
    const isOwner = session.isOwner || session.id === '1052909930073567232' || (session.role || '').toLowerCase() === 'owner';
    if (!isOwner) throw fail(403, 'forbidden', 'Only the Server Owner can edit incoming releases.');

    const input = await jsonBody(request);
    const id = String(input.id || '').trim();
    if (!id) throw fail(400, 'bad_input', 'Incoming release ID is required.');

    let targetItem = null;
    let reachedGoal = false;

    await mutateDoc(env, INCOMING_RELEASES_KEY, { items: [] }, curr => {
      const list = Array.isArray(curr?.items) ? curr.items : [];
      const found = list.find(item => item.id === id);
      if (!found) return { items: list };

      if (input.title !== undefined) {
        const nextTitle = cleanText(input.title, 120);
        if (nextTitle) found.title = nextTitle;
      }
      if (input.details !== undefined) found.details = cleanText(input.details, 1500);
      if (input.kind !== undefined) found.kind = input.kind === 'software' ? 'software' : 'tool';
      if (input.os !== undefined) found.os = ['windows', 'macos', 'both'].includes(input.os) ? input.os : found.os || 'both';
      if (input.category !== undefined) found.category = cleanText(input.category, 60) || found.category;
      if (input.size !== undefined) found.size = cleanText(input.size, 40) || found.size;
      if (input.creator !== undefined) found.creator = cleanText(input.creator, 60) || found.creator;
      if (input.image_url !== undefined) {
        const nextImage = String(input.image_url || '').trim();
        found.image_url = /^https?:\/\//i.test(nextImage) ? nextImage : '';
      }
      if (input.download_url !== undefined) found.download_url = String(input.download_url || '').trim();
      if (input.password !== undefined || input.pass !== undefined) {
        found.pass = cleanText(input.password !== undefined ? input.password : input.pass, 60) || undefined;
      }
      if (input.vote_limit !== undefined) {
        found.vote_limit = Math.max(1, Math.min(1000000000, parseInt(input.vote_limit, 10) || 5));
      }
      if (input.votes !== undefined) {
        found.votes = Math.max(0, Math.min(1000000000, parseInt(input.votes, 10) || 0));
      }
      if (input.released !== undefined) {
        found.released = Boolean(input.released);
        if (found.released) found.released_at = found.released_at || new Date().toISOString();
        else delete found.released_at;
      }
      if (input.votes !== undefined || input.vote_limit !== undefined) {
        if (!found.released && Number(found.votes || 0) >= Number(found.vote_limit || 5)) {
          found.released = true;
          found.released_at = new Date().toISOString();
          reachedGoal = true;
        }
      }

      found.updated_at = new Date().toISOString();
      targetItem = found;
      return { items: list };
    });

    if (!targetItem) throw fail(404, 'not_found', 'Incoming release item not found.');

    if (reachedGoal) await publishIncomingRelease(env, targetItem);
    else await syncIncomingDiscordEmbed(env, targetItem);

    await logBotAudit(
      env,
      'Incoming Release Edited',
      session,
      `Owner updated "${targetItem.title}" (${targetItem.votes} / ${targetItem.vote_limit} votes).`
    );
    return json({ ok: true, item: targetItem }, 200, cors);
  }

  // Delete an incoming release (Owner only)
  if (request.method === 'DELETE') {
    const token = bearerToken(request, url);
    const session = await requireMember(token, env);
    const isOwner = session.isOwner || session.id === '1052909930073567232' || (session.role || '').toLowerCase() === 'owner';
    if (!isOwner) throw fail(403, 'forbidden', 'Only Server Owner can delete incoming items.');

    const input = await jsonBody(request);
    const id = input.id;
    let deleted = null;
    await mutateDoc(env, INCOMING_RELEASES_KEY, { items: [] }, curr => {
      const list = Array.isArray(curr?.items) ? curr.items : [];
      deleted = list.find(i => i.id === id);
      return { items: list.filter(i => i.id !== id) };
    });

    if (deleted && deleted.discord_msg_id && env.DISCORD_BOT_TOKEN) {
      fetch(`https://discord.com/api/v10/channels/1539962334729211934/messages/${deleted.discord_msg_id}`, {
        method: 'DELETE',
        headers: { authorization: 'Bot ' + env.DISCORD_BOT_TOKEN }
      }).catch(() => {});
    }

    return json({ ok: true, deleted: Boolean(deleted) }, 200, cors);
  }

  return json({ error: 'Use GET, POST, PATCH, or DELETE.' }, 405, cors);
}

async function handleIncomingVote(request, url, env, cors) {
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405, cors);
  const token = bearerToken(request, url);
  const session = await requireMember(token, env);
  const input = await jsonBody(request);
  const id = input.id;
  const delta = Number(input.delta) || 1; // 1 for "Speed It Up (+1)", -1 for "Hold Off (-1)"
  if (!id) throw fail(400, 'bad_id', 'Resource ID is required.');

  let targetItem = null;
  let reachedGoal = false;

  await mutateDoc(env, INCOMING_RELEASES_KEY, { items: [] }, curr => {
    const list = Array.isArray(curr?.items) ? curr.items : [];
    const found = list.find(i => i.id === id);
    if (!found) return { items: list };

    found.voters = found.voters || {};
    const prev = found.voters[session.id] || 0;

    if (prev === delta) {
      // Toggle vote off if clicking same button again
      delete found.voters[session.id];
      found.votes = (found.votes || 0) - delta;
    } else {
      // Switch or apply vote
      found.voters[session.id] = delta;
      found.votes = (found.votes || 0) - prev + delta;
    }

    // Check if vote limit reached
    if (!found.released && found.votes >= (found.vote_limit || 5)) {
      found.released = true;
      found.released_at = new Date().toISOString();
      reachedGoal = true;
    }

    targetItem = found;
    return { items: list };
  });

  if (!targetItem) throw fail(404, 'not_found', 'Incoming release item not found.');

  // If goal reached, automatically publish resource to Public Vault & Discord!
  if (reachedGoal) await publishIncomingRelease(env, targetItem);

  return json({
    ok: true,
    votes: targetItem.votes,
    released: targetItem.released,
    userVote: (targetItem.voters || {})[session.id] || 0
  }, 200, cors);
}

/* Move a released incoming item into the public vault and refresh its Discord
   announcement. Shared by community votes and owner vote edits. */
async function publishIncomingRelease(env, item) {
  const vaultItem = { ...item, status: 'approved', created: new Date().toISOString() };
  await mutateDoc(env, VAULT_PUBLIC_ITEMS_KEY, { items: [] }, curr => {
    const items = Array.isArray(curr?.items) ? curr.items : [];
    return { items: [vaultItem, ...items.filter(i => i.slug !== vaultItem.slug)] };
  });
  await restoreVaultResources(env, [vaultItem.slug, vaultItem.id]);

  // Publish automatically to announcements & downloads
  await dispatchKyroDiscordPublish(vaultItem, env);

  // Update the Discord message in #incomming to show "Now Live"
  if (item.discord_msg_id && env.DISCORD_BOT_TOKEN) {
    try {
      const incommingChannel = '1539962334729211934';
      await fetch(`https://discord.com/api/v10/channels/${incommingChannel}/messages/${item.discord_msg_id}`, {
        method: 'PATCH',
        headers: { authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({
          content: `🎉 **COMMUNITY GOAL REACHED — NOW LIVE!** — @everyone`,
          allowed_mentions: { parse: ['everyone'] },
          embeds: [{
            author: { name: 'Kyro Incoming Release · Community Approval', icon_url: KYRO_ICON },
            title: `✅ JUST DROPPED: ${item.title.toUpperCase()}`,
            url: `https://kyro.new.tg#${item.slug}`,
            description: `**Status Badge:** \`Now Live / Just Dropped\`\n\n` +
              `Community vote goal of **${item.vote_limit}** votes reached! This item has been unlocked and published directly to the Kyro Vault!`,
            color: 0x10b981,
            image: item.image_url && /^https?:\/\//i.test(item.image_url) ? { url: item.image_url } : { url: INCOMING_PREVIEW_URL },
            footer: { text: 'Available now on kyro.new.tg' },
            timestamp: new Date().toISOString()
          }],
          components: [
            {
              type: 1,
              components: [
                { type: 2, style: 5, label: 'Download Now ↗', url: `https://kyro.new.tg#${item.slug}` }
              ]
            }
          ]
        })
      });
    } catch (e) {}
  }

  // Create notifications for the uploader
  if (item.by) {
    await createNotification(
      env,
      item.by,
      'Community Goal Reached! 🎉',
      `Your incoming item "${item.title}" reached ${item.vote_limit} community votes and is now live on Kyro!`,
      'approved'
    );
  }
}

/* Keep the #incomming announcement in step with owner edits without pinging
   everyone again. */
async function syncIncomingDiscordEmbed(env, item) {
  if (!item.discord_msg_id || !env.DISCORD_BOT_TOKEN) return;
  const osLabel = item.os === 'both' ? 'Windows & macOS' : item.os === 'macos' ? 'macOS' : 'Windows';
  try {
    await fetch(`https://discord.com/api/v10/channels/1539962334729211934/messages/${item.discord_msg_id}`, {
      method: 'PATCH',
      headers: { authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          author: { name: 'Kyro Incoming Release · Community Approval', icon_url: KYRO_ICON },
          title: `⏳ INCOMING: ${item.title.toUpperCase()}`,
          url: `https://kyro.new.tg#incoming`,
          description: `**Section Tagline:** *"Items waiting for community approval. Vote to bring them live."*\n\n` +
            (item.details ? `${item.details}\n\n` : '') +
            `• **Creator:** \`${item.creator || item.by_username || 'Kyro'}\`\n• **Platform:** \`${osLabel}\`\n• **Size:** \`${item.size || 'Vault Build'}\`\n• **Category:** \`${item.category || 'Adobe After Effects'}\`\n\n` +
            `🎯 **Goal:** \`${Number(item.votes || 0)} / ${Number(item.vote_limit || 5)}\` Votes to Push Live!`,
          color: 0x38bdf8,
          image: item.image_url && /^https?:\/\//i.test(item.image_url) ? { url: item.image_url } : { url: INCOMING_PREVIEW_URL },
          footer: { text: 'Vote on kyro.new.tg to bring this item live!' },
          timestamp: new Date().toISOString()
        }]
      })
    });
  } catch (e) {}
}

async function handleVaultSubmissionManage(request, url, env, cors) {
  const token = bearerToken(request, url);
  const session = await requireMember(token, env);
  const isOwner = session.isOwner || session.id === '1052909930073567232' || (session.role || '').toLowerCase() === 'owner';
  if (!isOwner) throw fail(403, 'forbidden', 'Only the Kyro Server Owner can edit or delete vault uploads.');

  if (request.method === 'DELETE') {
    const input = await jsonBody(request);
    const subId = cleanText(input.id, 120);
    if (!subId) throw fail(400, 'bad_input', 'Missing submission ID.');
    const claimsCatalogue = Boolean(input.catalogue);

    let deletedSub = null;
    await mutateDoc(env, VAULT_SUBMISSIONS_KEY, { submissions: [] }, curr => {
      const list = Array.isArray(curr?.submissions) ? curr.submissions : [];
      deletedSub = list.find(s => s.id === subId || s.slug === subId);
      return { submissions: list.filter(s => s.id !== subId && s.slug !== subId) };
    });

    // Also remove from public items (match by id or slug)
    let deletedPublic = null;
    await mutateDoc(env, VAULT_PUBLIC_ITEMS_KEY, { items: [] }, curr => {
      const items = Array.isArray(curr?.items) ? curr.items : [];
      deletedPublic = items.find(i => i.id === subId || i.slug === subId);
      return { items: items.filter(i => i.id !== subId && i.slug !== subId && (!deletedSub || i.slug !== deletedSub.slug)) };
    });

    const targetSub = deletedSub || deletedPublic;
    // Nothing in KV matched and the caller did not name a built-in catalogue
    // entry: report the miss without writing a tombstone or an audit line.
    if (!targetSub && !claimsCatalogue) {
      return json({ ok: true, deleted: false, catalogue: false, title: cleanText(input.title, 120) || subId }, 200, cors);
    }

    // Built-in catalogue entries are seeded from js/data.js, so removing them
    // from KV is not enough. A tombstone keeps them gone on the next load.
    const tombstones = [subId];
    if (targetSub) tombstones.push(targetSub.id, targetSub.slug);
    await hideVaultResources(env, tombstones);

    if (targetSub) {
      // If Discord messages were recorded, remove or edit them
      const vaultItemsDoc = (await readDoc(env, VAULT_ITEMS_KEY, { items: {} })).value;
      const meta = vaultItemsDoc.items && vaultItemsDoc.items[targetSub.slug];
      if (meta && env.DISCORD_BOT_TOKEN) {
        if (meta.announcement_msg_id) {
          fetch(`https://discord.com/api/v10/channels/1539961971422658571/messages/${meta.announcement_msg_id}`, {
            method: 'DELETE',
            headers: { authorization: 'Bot ' + env.DISCORD_BOT_TOKEN }
          }).catch(() => {});
        }
        if (meta.downloads_msg_id) {
          fetch(`https://discord.com/api/v10/channels/1539961998601756722/messages/${meta.downloads_msg_id}`, {
            method: 'DELETE',
            headers: { authorization: 'Bot ' + env.DISCORD_BOT_TOKEN }
          }).catch(() => {});
        }
        await mutateDoc(env, VAULT_ITEMS_KEY, { items: {} }, curr => {
          const items = curr?.items && typeof curr.items === 'object' ? { ...curr.items } : {};
          delete items[targetSub.slug];
          return { items };
        });
      }
    }

    const title = cleanText(input.title, 120) || targetSub?.title || subId;
    await logBotAudit(
      env,
      'Vault Resource Deleted',
      session,
      targetSub
        ? `Owner deleted "${title}" from the Vault and Discord.`
        : `Owner hid catalogue entry "${title}" from the Vault.`
    );
    return json({ ok: true, deleted: true, catalogue: !targetSub, title }, 200, cors);
  }

  if (request.method === 'PUT' || request.method === 'PATCH') {
    const input = await jsonBody(request);
    const subId = input.id;
    if (!subId) throw fail(400, 'bad_input', 'Missing submission ID.');

    let updatedSub = null;
    await mutateDoc(env, VAULT_SUBMISSIONS_KEY, { submissions: [] }, curr => {
      const list = Array.isArray(curr?.submissions) ? curr.submissions : [];
      const found = list.find(s => s.id === subId || s.slug === subId);
      if (found) {
        if (input.title) found.title = cleanText(input.title, 120);
        if (input.details !== undefined) found.details = cleanText(input.details, 1500);
        if (input.download_url) found.download_url = String(input.download_url).trim();
        if (input.password !== undefined) found.pass = cleanText(input.password, 100);
        if (input.size) found.size = cleanText(input.size, 30);
        if (input.category) found.category = cleanText(input.category, 60);
        if (input.image_url) found.image_url = String(input.image_url).trim();
        if (input.release_at !== undefined || input.releaseAt !== undefined) {
          found.releaseAt = input.release_at || input.releaseAt || undefined;
        }
        found.updated_at = new Date().toISOString();
        updatedSub = found;
      }
      return { submissions: list };
    });

    // Update in public items if approved (or if public item exists even if submission record was missing)
    let updatedPublic = null;
    await mutateDoc(env, VAULT_PUBLIC_ITEMS_KEY, { items: [] }, curr => {
      const items = Array.isArray(curr?.items) ? curr.items : [];
      const found = items.find(i => i.id === subId || i.slug === subId);
      if (found) {
        if (input.title) found.title = cleanText(input.title, 120);
        if (input.details !== undefined) found.details = cleanText(input.details, 1500);
        if (input.download_url) found.download_url = String(input.download_url).trim();
        if (input.password !== undefined) found.pass = cleanText(input.password, 100);
        if (input.size) found.size = cleanText(input.size, 30);
        if (input.category) found.category = cleanText(input.category, 60);
        if (input.image_url) found.image_url = String(input.image_url).trim();
        if (input.release_at !== undefined || input.releaseAt !== undefined) {
          found.releaseAt = input.release_at || input.releaseAt || undefined;
        }
        found.updated_at = new Date().toISOString();
        updatedPublic = found;
        return { items: [found, ...items.filter(i => i !== found)] };
      } else if (updatedSub && updatedSub.status === 'approved') {
        return { items: [updatedSub, ...items.filter(i => i.id !== subId && i.slug !== updatedSub.slug)] };
      }
      return { items };
    });

    const activeItem = updatedSub || updatedPublic;
    if (!activeItem) throw fail(404, 'not_found', 'Resource not found.');

    // Synchronize modified details with Discord embeds
    await syncModifiedDiscordEmbed(activeItem, env);

    await logBotAudit(env, 'Vault Resource Modified', session, `Owner edited submission "${activeItem.title}".`);
    return json({ ok: true, submission: activeItem }, 200, cors);
  }

  return json({ error: 'Use PUT, PATCH, or DELETE.' }, 405, cors);
}

async function syncModifiedDiscordEmbed(item, env) {
  if (!env.DISCORD_BOT_TOKEN) return;
  const slug = item.slug;
  const vaultItemsDoc = (await readDoc(env, VAULT_ITEMS_KEY, { items: {} })).value;
  const meta = vaultItemsDoc.items && vaultItemsDoc.items[slug];
  if (!meta) return;

  const os = (item.os || 'windows').toLowerCase();
  const pageUrl = (os === 'macos') ? `https://kyro.new.tg/macos#${slug}` : `https://kyro.new.tg/windows#${slug}`;
  const creator = item.by_username || item.creator || 'Kyro Vault';
  const size = item.size || 'Vault Build';
  const category = item.category || 'Adobe After Effects';
  const osLabel = os === 'both' ? 'Windows & macOS' : os === 'macos' ? 'macOS' : 'Windows';
  const vaultId = item.id_code || ('#' + Math.floor(100000 + Math.random() * 900000));
  const tier = item.tier || 'Free';
  const password = item.pass || item.password;

  const embed = {
    author: {
      name: item.author_tag || 'Kyro Vault',
      icon_url: item.author_icon || KYRO_ICON
    },
    title: '🔄 UPDATE: ' + item.title.toUpperCase(),
    url: pageUrl,
    description: (item.details || `${item.title} is now available in the Kyro Vault. Free resources and tools for verified editors.`) +
      (password ? `\n\n🔑 **Archive Password:** \`${password}\`` : '') +
      `\n\n**Website Link:** ${pageUrl}`,
    color: 0x1f232b,
    fields: [
      {
        name: 'Information',
        value: `• **Creator:** \`${creator}\`\n• **ID:** \`${vaultId}\`\n• **Size:** \`${size}\`\n• **Category:** \`${category}\`\n• **Platform:** \`${osLabel}\``,
        inline: true
      },
      {
        name: 'Membership',
        value: `• **Tier:** \`${tier}\`\n• **Status:** \`Updated\``,
        inline: true
      }
    ],
    footer: {
      text: 'Kyro™ Website | Resource Monitor',
      icon_url: KYRO_ICON
    },
    timestamp: new Date().toISOString()
  };

  if (item.image_url && /^https?:\/\//.test(item.image_url)) {
    embed.image = { url: item.image_url };
  }

  const components = [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 5,
          label: 'View Resource ↗',
          url: pageUrl
        },
        {
          type: 2,
          style: 5,
          label: 'Browse Vault ↗',
          url: 'https://kyro.new.tg'
        }
      ]
    }
  ];

  // 1. Announcements
  if (meta.announcement_msg_id) {
    try {
      await fetch(`https://discord.com/api/v10/channels/1539961971422658571/messages/${meta.announcement_msg_id}`, {
        method: 'PATCH',
        headers: { authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({
          content: '📢 **Vault Resource Updated** — <@&1542127783440818226>',
          embeds: [embed],
          components
        })
      });
    } catch (e) {}
  }

  // 2. Downloads-links
  if (meta.downloads_msg_id) {
    try {
      await fetch(`https://discord.com/api/v10/channels/1539961998601756722/messages/${meta.downloads_msg_id}`, {
        method: 'PATCH',
        headers: { authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({ embeds: [embed], components })
      });
    } catch (e) {}
  }
}

async function dispatchKyroDiscordPublish(item, env) {
  if (!env.DISCORD_BOT_TOKEN) return;
  let rawSlug = item.slug || '';
  if (/^https?:\/\//i.test(rawSlug)) {
    try {
      const u = new URL(rawSlug);
      const parts = u.pathname.split('/').filter(Boolean);
      rawSlug = parts[parts.length - 1] || u.hash.replace(/^#\/?/, '') || u.hostname.replace(/\./g, '-');
    } catch {}
  }
  const slug = rawSlug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || item.id;
  const os = (item.os || 'windows').toLowerCase();
  const pageUrl = (os === 'macos') ? `https://kyro.new.tg/macos#${slug}` : `https://kyro.new.tg/windows#${slug}`;

  const vaultDoc = (await readDoc(env, VAULT_ITEMS_KEY, { items: {} })).value;
  const existing = vaultDoc.items && vaultDoc.items[slug];
  const isUpdate = Boolean(existing);
  const password = item.pass || item.password;

  const creator = item.by_username || item.creator || 'Kyro Vault';
  const size = item.size || 'Vault Build';
  const category = item.category || 'Adobe After Effects';
  const osLabel = os === 'both' ? 'Windows & macOS' : os === 'macos' ? 'macOS' : 'Windows';
  const vaultId = '#' + Math.floor(100000 + Math.random() * 900000);

  const embed = {
    author: { name: 'Kyro Vault', icon_url: KYRO_ICON },
    title: (isUpdate ? '🔄 UPDATE: ' : '') + item.title.toUpperCase(),
    url: pageUrl,
    description: (item.details || `${item.title} is now live in the Kyro Vault.`) +
      (password ? `\n\n🔑 **Archive Password:** \`${password}\`` : '') +
      `\n\n**Website Link:** ${pageUrl}`,
    color: 0x1f232b,
    fields: [
      {
        name: 'Information',
        value: `• **Creator:** \`${creator}\`\n• **ID:** \`${vaultId}\`\n• **Size:** \`${size}\`\n• **Category:** \`${category}\`\n• **Platform:** \`${osLabel}\``,
        inline: true
      },
      {
        name: 'Membership',
        value: `• **Tier:** \`Free\`\n• **Status:** \`${isUpdate ? 'Updated' : 'Verified'}\``,
        inline: true
      }
    ],
    footer: { text: 'Kyro™ Website | Resource Monitor', icon_url: KYRO_ICON },
    timestamp: new Date().toISOString()
  };

  if (item.image_url && /^https?:\/\//.test(item.image_url)) embed.image = { url: item.image_url };

  const components = [
    {
      type: 1,
      components: [
        { type: 2, style: 5, label: 'View Resource ↗', url: pageUrl },
        { type: 2, style: 5, label: 'Browse Vault ↗', url: 'https://kyro.new.tg' }
      ]
    }
  ];

  let announcementMsgId = null;
  let downloadsMsgId = null;
  try {
    // 1. Announcements
    const annRes = await fetch('https://discord.com/api/v10/channels/1539961971422658571/messages', {
      method: 'POST',
      headers: { authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({
        content: isUpdate ? '📢 **Vault Update Alert** — <@&1542127783440818226>' : '🚀 **New Vault Resource Released** — <@&1542127783440818226>',
        embeds: [embed],
        components
      })
    });
    if (annRes.ok) {
      const annData = await annRes.json();
      announcementMsgId = annData.id;
    }
  } catch (e) {}

  try {
    // 2. Downloads-links
    const dlRes = await fetch('https://discord.com/api/v10/channels/1539961998601756722/messages', {
      method: 'POST',
      headers: { authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ embeds: [embed], components })
    });
    if (dlRes.ok) {
      const dlData = await dlRes.json();
      downloadsMsgId = dlData.id;
    }
  } catch (e) {}

  let showcaseThreadId = existing?.thread_id || null;
  try {
    // 3. Showcase forum
    if (isUpdate && existing?.thread_id) {
      await fetch(`https://discord.com/api/v10/channels/${existing.thread_id}/messages`, {
        method: 'POST',
        headers: { authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({
          content: `🔄 **New Update Released** for **${item.title}**!`,
          embeds: [embed],
          components
        })
      });
    } else {
      const scRes = await fetch('https://discord.com/api/v10/channels/1541775088901292042/threads', {
        method: 'POST',
        headers: { authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({
          name: (isUpdate ? '[UPDATE] ' : '') + item.title,
          applied_tags: ['1541775995395379310'],
          message: { embeds: [embed], components }
        })
      });
      if (scRes.ok) {
        const scData = await scRes.json();
        showcaseThreadId = scData.id;
      }
    }
  } catch (e) {}

  try {
    await mutateDoc(env, VAULT_ITEMS_KEY, { items: {} }, curr => {
      const items = curr?.items || {};
      items[slug] = {
        name: item.title,
        slug,
        thread_id: showcaseThreadId,
        announcement_msg_id: announcementMsgId,
        downloads_msg_id: downloadsMsgId,
        version: item.version || '1.0'
      };
      return { items };
    });
  } catch (e) {}
}
const VAULT_ITEMS_KEY = 'kyro.vault_items.v1';
const DASHBOARD_CONFIG_KEY = 'kyro.dashboard_config.v1';
const DASHBOARD_AUDIT_KEY = 'kyro.dashboard_audit.v1';
const NOTIFICATIONS_KEY = 'kyro.notifications.v1';
const INCOMING_RELEASES_KEY = 'kyro.incoming_releases.v1';
const EARLY_ACCESS_KEY = 'kyro.early_access.v1';

/* Owner-granted pass: these members skip the incoming waitlist and pull the
   download link directly, before the community vote goal is reached. */
async function earlyAccessUsers(env) {
  const doc = (await readDoc(env, EARLY_ACCESS_KEY, { users: {} })).value || {};
  return doc.users && typeof doc.users === 'object' ? doc.users : {};
}

async function hasEarlyAccess(env, userId) {
  if (!userId) return false;
  const users = await earlyAccessUsers(env);
  return Boolean(users[userId]);
}

async function handleEarlyAccess(request, url, env, cors) {
  const token = bearerToken(request, url);
  const session = await requireMember(token, env);
  const isOwner = session.isOwner || session.id === '1052909930073567232' || (session.role || '').toLowerCase() === 'owner';

  if (request.method === 'GET') {
    const users = await earlyAccessUsers(env);
    const payload = {
      earlyAccess: isOwner || isAdmin(session, env) || Boolean(users[session.id]),
      is_owner: isOwner
    };
    if (isOwner) payload.users = Object.entries(users).map(([id, meta]) => ({ id, ...(meta || {}) }));
    return json(payload, 200, cors);
  }

  if (!isOwner) throw fail(403, 'forbidden', 'Only the Server Owner can manage early access.');

  if (request.method === 'POST') {
    const input = await jsonBody(request);
    const id = cleanText(input.id, 40);
    if (!/^\d{17,20}$/.test(id)) throw fail(400, 'bad_id', 'Enter a valid Discord user ID (17–20 digits).');
    const username = cleanText(input.username || '', 60);
    const meta = { username: username || undefined, granted_by: session.id, granted_at: new Date().toISOString() };
    await mutateDoc(env, EARLY_ACCESS_KEY, { users: {} }, curr => {
      const users = curr && curr.users && typeof curr.users === 'object' ? curr.users : {};
      return { users: { ...users, [id]: meta } };
    });
    await logBotAudit(env, 'Early Access Granted', session, `Granted early access to ${username || id} (${id}).`);
    return json({ ok: true, id }, 200, cors);
  }

  if (request.method === 'DELETE') {
    const input = await jsonBody(request);
    const id = cleanText(input.id, 40);
    if (!id) throw fail(400, 'bad_id', 'Missing user ID.');
    let removed = false;
    await mutateDoc(env, EARLY_ACCESS_KEY, { users: {} }, curr => {
      const users = curr && curr.users && typeof curr.users === 'object' ? { ...curr.users } : {};
      removed = Boolean(users[id]);
      delete users[id];
      return { users };
    });
    if (removed) await logBotAudit(env, 'Early Access Revoked', session, `Revoked early access from ${id}.`);
    return json({ ok: true, removed }, 200, cors);
  }

  return json({ error: 'Use GET, POST, or DELETE.' }, 405, cors);
}
const KYRO_ICON = 'https://raw.githubusercontent.com/kyroownr/Kyro-Websitee/main/assets/kyro-icon.png';

async function handleVaultPublish(request, url, env, cors) {
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405, cors);
  const token = bearerToken(request, url);
  const session = await requireMember(token, env);
  
  // Owner only can publish directly from website
  const isOwner = session.isOwner || session.id === '1052909930073567232' || (session.role || '').toLowerCase() === 'owner';
  if (!isOwner) throw fail(403, 'forbidden', 'Only the Kyro Server Owner can publish resources to Discord.');

  const item = await jsonBody(request);
  if (!item.name || !item.slug) throw fail(400, 'bad_input', 'Resource name and slug are required.');

  let rawSlug = item.slug.toLowerCase().trim().replace(/^\/+|\/+$/g, '');
  if (/^https?:\/\//i.test(rawSlug)) {
    try {
      const u = new URL(rawSlug);
      const parts = u.pathname.split('/').filter(Boolean);
      rawSlug = parts[parts.length - 1] || u.hash.replace(/^#\/?/, '') || u.hostname.replace(/\./g, '-');
    } catch {}
  }
  const slug = rawSlug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'resource';
  const os = (item.os || 'windows').toLowerCase();
  const pageUrl = (os === 'macos') ? `https://kyro.new.tg/macos#${slug}` : `https://kyro.new.tg/windows#${slug}`;

  // Read existing published items to detect update
  const vaultDoc = (await readDoc(env, VAULT_ITEMS_KEY, { items: {} })).value;
  const existing = vaultDoc.items && vaultDoc.items[slug];
  const isUpdate = Boolean(existing);

  const creator = item.by_username || item.creator || 'Kyro Vault';
  const size = item.size || 'Vault Build';
  const category = item.category || 'Adobe After Effects';
  const osLabel = os === 'both' ? 'Windows & macOS' : os === 'macos' ? 'macOS' : 'Windows';
  const vaultId = item.id_code || ('#' + Math.floor(100000 + Math.random() * 900000));
  const tier = item.tier || 'Free';

  const embed = {
    author: {
      name: 'Kyro Vault',
      icon_url: KYRO_ICON
    },
    title: (isUpdate ? '🔄 UPDATE: ' : '') + item.name.toUpperCase(),
    url: pageUrl,
    description: (item.details || `${item.name} is now available in the Kyro Vault. Free resources and tools for verified editors.`) +
      `\n\n**Website Link:** ${pageUrl}`,
    color: 0x1f232b,
    fields: [
      {
        name: 'Information',
        value: `• **Creator:** \`${creator}\`\n• **ID:** \`${vaultId}\`\n• **Size:** \`${size}\`\n• **Category:** \`${category}\`\n• **Platform:** \`${osLabel}\``,
        inline: true
      },
      {
        name: 'Membership',
        value: `• **Tier:** \`${tier}\`\n• **Status:** \`${isUpdate ? 'Updated' : 'Verified'}\``,
        inline: true
      }
    ],
    footer: {
      text: 'Kyro™ Website | Resource Monitor',
      icon_url: KYRO_ICON
    },
    timestamp: new Date().toISOString()
  };

  if (item.image_url && /^https?:\/\//.test(item.image_url)) {
    embed.image = { url: item.image_url };
  }

  const components = [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 5,
          label: 'View Resource ↗',
          url: pageUrl
        },
        {
          type: 2,
          style: 5,
          label: 'Browse Vault ↗',
          url: 'https://kyro.new.tg'
        }
      ]
    }
  ];

  const outcomes = { announcements: false, downloads_links: false, showcase: false, isUpdate, pageUrl };

  if (env.DISCORD_BOT_TOKEN) {
    // 1. Announcements
    try {
      await fetch('https://discord.com/api/v10/channels/1539961971422658571/messages', {
        method: 'POST',
        headers: { authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({
          content: isUpdate ? '📢 **Vault Update Alert** — <@&1542127783440818226>' : '🚀 **New Vault Resource Released** — <@&1542127783440818226>',
          embeds: [embed],
          components
        })
      });
      outcomes.announcements = true;
    } catch (e) {
      console.warn('[publish] Announcements error:', e);
    }

    // 2. Downloads-links
    try {
      await fetch('https://discord.com/api/v10/channels/1539961998601756722/messages', {
        method: 'POST',
        headers: { authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({ embeds: [embed], components })
      });
      outcomes.downloads_links = true;
    } catch (e) {
      console.warn('[publish] Downloads-links error:', e);
    }

    // 3. Showcase forum (tag 1541775995395379310)
    if (isUpdate && existing?.thread_id) {
      try {
        await fetch(`https://discord.com/api/v10/channels/${existing.thread_id}/messages`, {
          method: 'POST',
          headers: { authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'content-type': 'application/json' },
          body: JSON.stringify({
            content: `🔄 **New Update Released** for **${item.name}**!`,
            embeds: [embed],
            components
          })
        });
        outcomes.showcase = true;
      } catch (e) {}
    }

    if (!outcomes.showcase) {
      try {
        const scRes = await fetch('https://discord.com/api/v10/channels/1541775088901292042/threads', {
          method: 'POST',
          headers: { authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'content-type': 'application/json' },
          body: JSON.stringify({
            name: (isUpdate ? '[UPDATE] ' : '') + item.name,
            applied_tags: ['1541775995395379310'],
            message: { embeds: [embed], components }
          })
        });
        if (scRes.ok) {
          const scData = await scRes.json();
          await mutateDoc(env, VAULT_ITEMS_KEY, { items: {} }, curr => {
            const items = curr?.items || {};
            items[slug] = { name: item.name, slug, thread_id: scData.id, version: item.version || '1.0' };
            return { items };
          });
          outcomes.showcase = true;
        }
      } catch (e) {
        console.warn('[publish] Showcase error:', e);
      }
    }
  }

  await logBotAudit(env, isUpdate ? 'Vault Resource Updated' : 'New Vault Resource Published', session, `Published "${item.name}" -> ${pageUrl}`);
  return json(outcomes, 200, cors);
}

// Channels
const AUDIT_UPDATES_CHANNEL_ID = '1571403237788221611'; // #updates in category "Staff for mods+"

async function logBotAudit(env, action, byUser, details) {
  const entry = {
    id: crypto.randomUUID(),
    action,
    by: byUser.username,
    by_id: byUser.id,
    details: details || '',
    timestamp: new Date().toISOString()
  };
  await mutateDoc(env, DASHBOARD_AUDIT_KEY, { logs: [] }, curr => {
    const logs = Array.isArray(curr?.logs) ? curr.logs : [];
    return { logs: [entry, ...logs].slice(0, 100) };
  });

  // Post audit logs to private staff #updates channel
  if (env.DISCORD_BOT_TOKEN) {
    try {
      const channelId = env.DISCORD_AUDIT_CHANNEL_ID || AUDIT_UPDATES_CHANNEL_ID;
      await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: 'POST',
        headers: { authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({
          embeds: [{
            title: `🛡️ Kyro Bot Audit: ${action}`,
            description: details || 'Administrative event logged from Web Dashboard.',
            color: action.includes('Lockdown') ? 0xef4444 : 0x5865f2,
            fields: [{ name: 'Staff Member', value: `<@${byUser.id}> (${byUser.username})`, inline: true }],
            timestamp: entry.timestamp
          }]
        })
      });
    } catch (e) {
      console.warn('[kyro-audit] Discord notification error:', e);
    }
  }
}

function checkAdminOrOwner(session) {
  if (!session || !session.inServer) throw fail(401, 'unauthorized', 'Sign in with Discord to access Kyro dashboard.');
  const role = (session.role || '').toLowerCase();
  const allowed = session.isOwner || session.id === '1052909930073567232' || role === 'owner' || role === 'mod+';
  if (!allowed) throw fail(403, 'forbidden', 'Only Mod+ or the Server Owner have access to the Kyro Bot Dashboard.');
}

async function handleDashboardSettings(request, url, env, cors) {
  const token = bearerToken(request, url);
  const session = await requireMember(token, env);
  checkAdminOrOwner(session);

  const defaultConfig = {
    modules: {
      applications: true,
      requests_board: true,
      anti_raid: true,
      welcome_cards: true,
      audit_logging: true,
      custom_embeds: true
    },
    anti_raid: {
      emergency_lockdown: false,
      mass_join_protection: true,
      spam_filter: true
    },
    welcome: {
      channel_id: '1542135796369457182',
      message: 'Welcome to Kyro! Check out free builds and presets on https://kyro.new.tg'
    }
  };

  if (request.method === 'GET') {
    const doc = (await readDoc(env, DASHBOARD_CONFIG_KEY, defaultConfig)).value;
    return json({ config: doc, user: { username: session.username, role: session.role } }, 200, cors);
  }

  if (request.method === 'POST') {
    const input = await jsonBody(request);
    const updated = await mutateDoc(env, DASHBOARD_CONFIG_KEY, defaultConfig, curr => {
      return {
        ...curr,
        modules: { ...curr.modules, ...(input.modules || {}) },
        anti_raid: { ...curr.anti_raid, ...(input.anti_raid || {}) },
        welcome: { ...curr.welcome, ...(input.welcome || {}) }
      };
    });

    await logBotAudit(env, 'Module Settings Updated', session, 'Updated module toggles and anti-raid configurations.');
    return json({ ok: true, config: updated }, 200, cors);
  }

  return json({ error: 'Use GET or POST.' }, 405, cors);
}

async function handleDashboardLockdown(request, url, env, cors) {
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405, cors);
  const token = bearerToken(request, url);
  const session = await requireMember(token, env);
  checkAdminOrOwner(session);

  const input = await jsonBody(request);
  const lockdownState = Boolean(input.lockdown);

  await mutateDoc(env, DASHBOARD_CONFIG_KEY, {}, curr => ({
    ...curr,
    anti_raid: { ...(curr.anti_raid || {}), emergency_lockdown: lockdownState }
  }));

  // Adjust @everyone SEND_MESSAGES permission if lockdown is toggled
  if (env.DISCORD_BOT_TOKEN) {
    try {
      const guildId = String(env.DISCORD_GUILD_ID || env.KYRO_GUILD_ID);
      // @everyone role id equals guildId
      const SEND_MESSAGES = 1n << 11n;
      const everyoneRes = await fetch(`https://discord.com/api/v10/guilds/${guildId}/roles/${guildId}`, {
        headers: { authorization: 'Bot ' + env.DISCORD_BOT_TOKEN }
      });
      if (everyoneRes.ok) {
        const roleData = await everyoneRes.json();
        let bits = BigInt(roleData.permissions);
        if (lockdownState) bits = bits & ~SEND_MESSAGES; // revoke chat
        else bits = bits | SEND_MESSAGES; // grant chat back
        await fetch(`https://discord.com/api/v10/guilds/${guildId}/roles/${guildId}`, {
          method: 'PATCH',
          headers: { authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'content-type': 'application/json' },
          body: JSON.stringify({ permissions: bits.toString() })
        });
      }
    } catch (err) {
      console.warn('[kyro-lockdown] Permission adjust error:', err);
    }
  }

  await logBotAudit(
    env,
    lockdownState ? '🚨 Emergency Lockdown Activated' : '✅ Emergency Lockdown Lifted',
    session,
    lockdownState ? 'Chat permissions disabled for @everyone role.' : 'Chat permissions restored for @everyone role.'
  );

  return json({ ok: true, lockdown: lockdownState }, 200, cors);
}

async function handleDashboardEmbed(request, url, env, cors) {
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405, cors);
  const token = bearerToken(request, url);
  const session = await requireMember(token, env);
  checkAdminOrOwner(session);

  const input = await jsonBody(request);
  const channelId = input.channel_id || env.DISCORD_PUBLIC_APPS_CHANNEL_ID || '1542135796369457182';
  const embed = {
    title: cleanText(input.title, 250) || 'Kyro Announcement',
    description: cleanText(input.description, 4000) || '',
    color: Number(input.color) || 0x5865f2,
    footer: { text: 'Sent via Kyro Bot Web Dashboard · kyro.new.tg' },
    timestamp: new Date().toISOString()
  };

  if (input.image_url && /^https?:\/\//.test(input.image_url)) {
    embed.image = { url: input.image_url };
  }

  if (env.DISCORD_BOT_TOKEN) {
    const postRes = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({
        content: input.content ? cleanText(input.content, 2000) : undefined,
        embeds: [embed]
      })
    });
    if (!postRes.ok) {
      const errText = await postRes.text();
      throw fail(postRes.status, 'discord_post_failed', `Failed to send embed: ${errText}`);
    }
  }

  await logBotAudit(env, 'Visual Embed Broadcasted', session, `Posted embed "${embed.title}" to channel <#${channelId}>.`);
  return json({ ok: true, message: 'Embed sent successfully!' }, 200, cors);
}

async function handleDashboardAudit(request, url, env, cors) {
  const token = bearerToken(request, url);
  const session = await requireMember(token, env);
  checkAdminOrOwner(session);

  const doc = (await readDoc(env, DASHBOARD_AUDIT_KEY, { logs: [] })).value;
  return json({ logs: doc.logs || [] }, 200, cors);
}

/* -------------------------------- Bot Moderation (Ban, Temp Ban, Unban, Timeout, Kick) ------------------------------- */
async function handleDashboardModerate(request, url, env, cors) {
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405, cors);
  const token = bearerToken(request, url);
  const session = await requireMember(token, env);
  checkAdminOrOwner(session);

  if (!env.DISCORD_BOT_TOKEN) throw fail(500, 'no_bot_token', 'Discord bot token is not configured.');

  const input = await jsonBody(request);
  const action = String(input.action || '').toLowerCase(); // ban, tempban, unban, timeout, untimeout, kick
  const userId = cleanText(input.user_id || input.userId, 40);
  const reason = cleanText(input.reason || `Moderation action (${action}) via Kyro Dashboard by ${session.username}`, 200);
  const duration = parseInt(input.duration, 10) || 3600; // seconds for tempban / timeout
  const guildId = String(env.DISCORD_GUILD_ID || env.KYRO_GUILD_ID);

  if (!userId || !/^\d{17,20}$/.test(userId)) {
    throw fail(400, 'bad_user_id', 'Provide a valid Discord User ID.');
  }

  const reasonHeader = {
    authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
    'X-Audit-Log-Reason': encodeURIComponent(reason)
  };

  if (action === 'ban' || action === 'tempban') {
    const banRes = await fetch(`https://discord.com/api/v10/guilds/${guildId}/bans/${userId}`, {
      method: 'PUT',
      headers: { ...reasonHeader, 'content-type': 'application/json' },
      body: JSON.stringify({ delete_message_seconds: 0 })
    });
    if (!banRes.ok) {
      const errText = await banRes.text();
      throw fail(banRes.status, 'discord_ban_failed', `Ban request rejected: ${errText}`);
    }

    if (action === 'tempban') {
      // Store tempban expiration in KV
      const tempbanKey = `kyro.tempban.${userId}`;
      if (env.KYRO_DATA) {
        await env.KYRO_DATA.put(tempbanKey, JSON.stringify({
          userId,
          guildId,
          expiresAt: Date.now() + duration * 1000,
          reason
        }), { expirationTtl: duration + 3600 });
      }
    }

    await logBotAudit(env, action === 'tempban' ? `🔨 Temp Ban (${Math.round(duration / 60)}m)` : '🔨 Ban Member', session, `Target: <@${userId}> · Reason: ${reason}`);
    return json({ ok: true, message: action === 'tempban' ? `User <@${userId}> temp-banned for ${Math.round(duration / 60)} minutes.` : `User <@${userId}> permanently banned.` }, 200, cors);
  }

  if (action === 'unban') {
    const unbanRes = await fetch(`https://discord.com/api/v10/guilds/${guildId}/bans/${userId}`, {
      method: 'DELETE',
      headers: reasonHeader
    });
    if (!unbanRes.ok) {
      const errText = await unbanRes.text();
      throw fail(unbanRes.status, 'discord_unban_failed', `Unban request rejected: ${errText}`);
    }
    await logBotAudit(env, '🕊️ Unban Member', session, `Unbanned: <@${userId}> · Reason: ${reason}`);
    return json({ ok: true, message: `User <@${userId}> has been unbanned.` }, 200, cors);
  }

  if (action === 'timeout') {
    const until = new Date(Date.now() + duration * 1000).toISOString();
    const toRes = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members/${userId}`, {
      method: 'PATCH',
      headers: { ...reasonHeader, 'content-type': 'application/json' },
      body: JSON.stringify({ communication_disabled_until: until })
    });
    if (!toRes.ok) {
      const errText = await toRes.text();
      throw fail(toRes.status, 'discord_timeout_failed', `Timeout rejected: ${errText}`);
    }
    await logBotAudit(env, `⏱️ Timeout Member (${Math.round(duration / 60)}m)`, session, `Target: <@${userId}> · Reason: ${reason}`);
    return json({ ok: true, message: `User <@${userId}> timed out for ${Math.round(duration / 60)} minutes.` }, 200, cors);
  }

  if (action === 'untimeout') {
    const untoRes = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members/${userId}`, {
      method: 'PATCH',
      headers: { ...reasonHeader, 'content-type': 'application/json' },
      body: JSON.stringify({ communication_disabled_until: null })
    });
    if (!untoRes.ok) {
      const errText = await untoRes.text();
      throw fail(untoRes.status, 'discord_untimeout_failed', `Remove timeout rejected: ${errText}`);
    }
    await logBotAudit(env, '⏱️ Timeout Removed', session, `Target: <@${userId}>`);
    return json({ ok: true, message: `Timeout removed for user <@${userId}>.` }, 200, cors);
  }

  if (action === 'kick') {
    const kickRes = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members/${userId}`, {
      method: 'DELETE',
      headers: reasonHeader
    });
    if (!kickRes.ok) {
      const errText = await kickRes.text();
      throw fail(kickRes.status, 'discord_kick_failed', `Kick rejected: ${errText}`);
    }
    await logBotAudit(env, '👢 Kick Member', session, `Kicked: <@${userId}> · Reason: ${reason}`);
    return json({ ok: true, message: `User <@${userId}> kicked from server.` }, 200, cors);
  }

  throw fail(400, 'bad_action', 'Unknown moderation action. Use ban, tempban, unban, timeout, untimeout, or kick.');
}

/* -------------------------------- Automatic Alert Section Member Monitor (Join ✅ / Leave ❌ Ban) ------------------------------- */
const ALERT_CHANNEL_ID = '1570713380778541147'; // #alert channel
const SAPPHIRE_BOT_ID = '678344927997853742'; // Sapphire join/leave alert author
const CHECK_EMOJI = '%E2%9C%85'; // ✅
const CROSS_EMOJI = '%E2%9D%8C'; // ❌

async function runAlertSectionMemberMonitor(env) {
  if (!env.DISCORD_BOT_TOKEN) return { processed: 0 };
  const guildId = String(env.DISCORD_GUILD_ID || env.KYRO_GUILD_ID);

  try {
    // 1. Fetch recent join alert messages from Sapphire in #alert
    const msgsRes = await fetch(`https://discord.com/api/v10/channels/${ALERT_CHANNEL_ID}/messages?limit=25`, {
      headers: { authorization: 'Bot ' + env.DISCORD_BOT_TOKEN }
    });
    if (!msgsRes.ok) return { error: 'Failed to read alert channel' };
    const msgs = await msgsRes.json();
    if (!Array.isArray(msgs)) return { processed: 0 };

    let actedCount = 0;

    for (const msg of msgs) {
      // Only Sapphire's own join/leave alerts drive enforcement; a stray
      // mention from anyone else in #alert must never trigger a ban.
      if (msg.author?.id !== SAPPHIRE_BOT_ID) continue;
      const targetUser = msg.mentions?.[0];
      if (!targetUser || !targetUser.id) continue;
      // Do not ban bot or server owner
      if (targetUser.id === '1052909930073567232' || targetUser.id === '1571036271839682601' || targetUser.bot) continue;

      const reactions = msg.reactions || [];
      const hasCross = reactions.some(r => r.emoji.name === '❌');
      const hasCheck = reactions.some(r => r.emoji.name === '✅');

      // Check if user is still in guild
      const memberRes = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members/${targetUser.id}`, {
        headers: { authorization: 'Bot ' + env.DISCORD_BOT_TOKEN }
      });

      if (memberRes.ok) {
        // User is IN server: ensure ✅ is added if not yet reacted
        const myCheck = reactions.find(r => r.emoji.name === '✅')?.me;
        if (!myCheck) {
          await fetch(`https://discord.com/api/v10/channels/${ALERT_CHANNEL_ID}/messages/${msg.id}/reactions/${CHECK_EMOJI}/@me`, {
            method: 'PUT',
            headers: { authorization: 'Bot ' + env.DISCORD_BOT_TOKEN }
          });
          actedCount++;
        }
      } else if (memberRes.status === 404) {
        // User has LEFT server!
        // Per server rule: "Don't join and leave this bot for resources, you will get banned."
        if (!hasCross) {
          // Remove ✅ reaction if present
          await fetch(`https://discord.com/api/v10/channels/${ALERT_CHANNEL_ID}/messages/${msg.id}/reactions/${CHECK_EMOJI}/@me`, {
            method: 'DELETE',
            headers: { authorization: 'Bot ' + env.DISCORD_BOT_TOKEN }
          }).catch(() => {});

          // Add ❌ reaction
          await fetch(`https://discord.com/api/v10/channels/${ALERT_CHANNEL_ID}/messages/${msg.id}/reactions/${CROSS_EMOJI}/@me`, {
            method: 'PUT',
            headers: { authorization: 'Bot ' + env.DISCORD_BOT_TOKEN }
          });

          // Ban user for leaving per server rule
          const banRes = await fetch(`https://discord.com/api/v10/guilds/${guildId}/bans/${targetUser.id}`, {
            method: 'PUT',
            headers: {
              authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
              'content-type': 'application/json',
              'X-Audit-Log-Reason': encodeURIComponent('Server Rule: Left server after joining for resources. Automatic ban.')
            },
            body: JSON.stringify({ delete_message_seconds: 0 })
          });

          // Log to private audit channel
          const auditChannel = '1571403237788221611';
          await fetch(`https://discord.com/api/v10/channels/${auditChannel}/messages`, {
            method: 'POST',
            headers: { authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'content-type': 'application/json' },
            body: JSON.stringify({
              embeds: [{
                title: '🛡️ Auto-Enforcement: Member Banned for Leaving',
                description: `User **${targetUser.username}** (<@${targetUser.id}>) left the server after joining.\nMarked with ❌ in <#${ALERT_CHANNEL_ID}> and automatically banned per server rule.`,
                color: 0xef4444,
                timestamp: new Date().toISOString()
              }]
            })
          });

          actedCount++;
        }
      }
    }

    // 2. Check and lift expired temp-bans if any
    if (env.KYRO_DATA) {
      const tempbansDoc = await env.KYRO_DATA.list({ prefix: 'kyro.tempban.' });
      for (const key of tempbansDoc.keys || []) {
        try {
          const raw = await env.KYRO_DATA.get(key.name);
          if (raw) {
            const tb = JSON.parse(raw);
            if (Date.now() >= tb.expiresAt) {
              await fetch(`https://discord.com/api/v10/guilds/${guildId}/bans/${tb.userId}`, {
                method: 'DELETE',
                headers: { authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'X-Audit-Log-Reason': 'Temp-ban duration expired' }
              });
              await env.KYRO_DATA.delete(key.name);
            }
          }
        } catch {}
      }
    }

    return { ok: true, actedCount };
  } catch (err) {
    console.warn('[alert-monitor] Error running monitor:', err);
    return { error: err.message };
  }
}

async function handleAlertMonitorTrigger(request, url, env, cors) {
  const token = bearerToken(request, url);
  const session = await requireMember(token, env);
  checkAdminOrOwner(session);

  const res = await runAlertSectionMemberMonitor(env);
  return json(res, 200, cors);
}

/* -------------------------------- plumbing ------------------------------- */

function allowedOrigins(env) {
  return String(env.KYRO_ALLOWED_ORIGINS || DEFAULT_ORIGINS).split(',').map(o => o.trim().replace(/\/$/, '')).filter(Boolean);
}

function corsHeaders(request, env) {
  const origin = request.headers.get('origin') || '';
  const headers = {
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-max-age': '600',
    vary: 'Origin'
  };
  const allowed = allowedOrigins(env);
  // Exact origin match only. Substring ("localhost") or wildcard ("*.new.tg")
  // checks let hostile hosts like localhost.evil.com or any shared new.tg
  // subdomain read authenticated responses cross-origin.
  if (allowed.includes(origin.replace(/\/$/, ''))) {
    headers['access-control-allow-origin'] = origin;
  } else if (!origin) {
    headers['access-control-allow-origin'] = '*';
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
