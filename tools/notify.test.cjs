/* Verifies incoming + release announcements ping the Verified role (not the
   deleted "Members" role and not @everyone), with allowed_mentions locked to
   that role. Runs the real worker in Miniflare with a mocked Discord REST API.
   Run: node tools/notify.test.cjs */
const assert = require('node:assert/strict');
const path = require('node:path');
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const source = require('esbuild').buildSync({ entryPoints: [path.join(__dirname, '..', 'worker.js')], bundle: true, write: false, format: 'esm', platform: 'browser' }).outputFiles[0].text;

const OWNER = '200000000000000001';
const VERIFIED = '999999999999999999';
const DELETED_MEMBERS = '1542127783440818226';
const INCOMING_CHANNEL = '1539962334729211934';
const ANNOUNCE_CHANNEL = '1539961971422658571';

const posted = [];
const patched = [];

const mf = new Miniflare(convertV4MiniflareOptions({
  modules: true,
  script: source,
  compatibilityDate: '2025-09-01',
  kvNamespaces: ['KYRO_DATA'],
  durableObjects: { KYRO_REQUESTS: { className: 'KyroRequests', useSQLite: true } },
  bindings: {
    KYRO_GUILD_ID: 'guild', KYRO_OWNER_ID: OWNER,
    DISCORD_BOT_TOKEN: 'test-bot-token',
    DISCORD_CLIENT_ID: 'test-client', DISCORD_CLIENT_SECRET: 'test-secret'
  },
  outboundService: async request => {
    const url = new URL(request.url);
    if (url.hostname !== 'discord.com') throw new Error('Unexpected outbound host ' + url.hostname);
    const p = url.pathname;
    if (p === '/api/users/@me') return Response.json({ id: OWNER, username: 'owner', avatar: null });
    if (p === '/api/users/@me/guilds') return Response.json([{ id: 'guild', owner: true, permissions: '8' }]);
    if (p === '/api/v10/guilds/guild/roles') return Response.json([
      { id: VERIFIED, name: 'Verified', position: 1 },
      { id: 'guild', name: '@everyone', position: 0 }
    ]);
    const post = p.match(/^\/api\/v10\/channels\/(\d+)\/messages$/);
    if (post && request.method === 'POST') {
      const body = await request.json();
      posted.push({ channel: post[1], body });
      return Response.json({ id: 'msg_' + posted.length });
    }
    const patch = p.match(/^\/api\/v10\/channels\/(\d+)\/messages\/(\d+)$/);
    if (patch && request.method === 'PATCH') {
      const body = await request.json();
      patched.push({ channel: patch[1], id: patch[2], body });
      return Response.json({ id: patch[2] });
    }
    if (/^\/api\/v10\/guilds\/guild\/members\//.test(p)) return Response.json({ user: { id: OWNER }, roles: [] });
    return Response.json({});
  }
}));

async function main() {
  let checks = 0;
  const expect = (value, label) => { assert.ok(value, label); checks++; };
  const call = async (route, body, method) => {
    const headers = { origin: 'http://localhost:4173', authorization: 'Bearer owner' };
    const m = method || (body === undefined ? 'GET' : 'POST');
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await mf.dispatchFetch('http://localhost' + route, { method: m, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, data: await res.json() };
  };

  try {
    // Incoming drop announcement.
    const inc = await call('/vault/incoming', { title: 'Notify Test Drop', slug: 'notify-test-drop', os: 'windows', download_url: 'https://example.com/file.zip' });
    expect(inc.status === 201, 'owner creates an incoming release');
    const incMsg = posted.find((m) => m.channel === INCOMING_CHANNEL);
    expect(incMsg, 'incoming announcement posted to #incomming');
    expect(typeof incMsg.body.content === 'string' && incMsg.body.content.includes('<@&' + VERIFIED + '>'), 'incoming announcement pings the Verified role');
    expect(!incMsg.body.content.includes('@everyone'), 'incoming announcement does not ping @everyone');
    expect(!incMsg.body.content.includes(DELETED_MEMBERS), 'incoming announcement does not ping the deleted Members role');
    expect(Array.isArray(incMsg.body.allowed_mentions.roles) && incMsg.body.allowed_mentions.roles.length === 1 && incMsg.body.allowed_mentions.roles[0] === VERIFIED, 'incoming allowed_mentions locked to the Verified role');
    expect(Array.isArray(incMsg.body.allowed_mentions.parse) && incMsg.body.allowed_mentions.parse.length === 0, 'incoming allowed_mentions.parse empty (no everyone/user escalation)');

    // Direct vault release announcement.
    const pub = await call('/api/vault/publish', { name: 'Notify Test Resource', slug: 'notify-test-resource', os: 'windows' });
    expect(pub.status === 200, 'owner publishes a vault resource');
    const pubMsg = posted.find((m) => m.channel === ANNOUNCE_CHANNEL);
    expect(pubMsg, 'release announcement posted to #announcements');
    expect(pubMsg.body.content.includes('<@&' + VERIFIED + '>'), 'release announcement pings the Verified role');
    expect(!pubMsg.body.content.includes('@everyone') && !pubMsg.body.content.includes(DELETED_MEMBERS), 'release announcement avoids @everyone and the deleted Members role');
    expect(pubMsg.body.allowed_mentions.roles.length === 1 && pubMsg.body.allowed_mentions.roles[0] === VERIFIED, 'release allowed_mentions locked to the Verified role');
    expect(pubMsg.body.allowed_mentions.parse.length === 0, 'release allowed_mentions.parse empty');

    // No announcement anywhere pinged the deleted role or @everyone.
    expect(posted.every((m) => !String(m.body.content || '').includes(DELETED_MEMBERS)), 'no posted message references the deleted Members role');
    expect(posted.every((m) => !String(m.body.content || '').includes('@everyone')), 'no posted message pings @everyone');

    console.log(`notify.test: ${checks} checks passed`);
    await mf.dispose();
    process.exit(0);
  } catch (err) {
    console.error('notify.test FAILED:', err.message);
    await mf.dispose();
    process.exit(1);
  }
}
main();