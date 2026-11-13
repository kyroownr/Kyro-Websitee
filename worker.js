/**
 * Kyro — Discord OAuth2 worker (Cloudflare Workers, ES module).
 *
 * Routes
 *   GET  /callback   Discord redirect target: exchanges the code for a token,
 *                    reads the profile + guild list, then 302s back to the site
 *                    with ?token=&username=&id=&avatar=&in_server=&state=
 *   POST /verify     { token }  →  { in_server, username, guild_id }
 *   GET  /verify     ?token=…   →  same payload (handy for curl)
 *
 * Secrets (Settings → Variables; a plain text var is fine, the encrypted
 * "secret" type is better):
 *   DISCORD_CLIENT_ID      1570702041993711706  (same id that is public in js/app.js)
 *   DISCORD_CLIENT_SECRET  from the Discord app — never committed, never shipped
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
const DEFAULT_ORIGINS = 'https://kyro.new.tg,http://localhost:4173,http://127.0.0.1:4173';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    try {
      if (url.pathname === '/callback') return await handleCallback(request, url, env);
      if (url.pathname === '/verify') return await handleVerify(request, url, env, cors);
      return json({ error: 'Unknown route. Use /callback or /verify.' }, 404, cors);
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
    username: session.username,
    id: session.id,
    avatar: session.avatar,
    guild_id: String(env.KYRO_GUILD_ID || '')
  }, 200, cors);
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
  return {
    username: user.username,
    id: String(user.id),
    avatar: user.avatar || '',
    inServer: guildId !== '' && guilds.some(g => String(g.id) === guildId)
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
    'access-control-allow-headers': 'content-type',
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
