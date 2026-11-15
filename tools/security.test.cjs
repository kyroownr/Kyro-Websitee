const assert = require('node:assert/strict');
const path = require('node:path');
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const source = require('esbuild').buildSync({ entryPoints: [path.join(__dirname, '..', 'worker.js')], bundle: true, write: false, format: 'esm', platform: 'browser' }).outputFiles[0].text;

const SAPPHIRE = '678344927997853742';
const ALERT = '1570713380778541147';
const AUDIT = '1571403237788221611';
const BOT = '1571036271839682601';
const OWNER = '1052909930073567232';

let alertMessages = [];
const presentMembers = new Set(['owner']);
const bans = [];
const reactions = [];
const auditPosts = [];

const make = () => new Miniflare(convertV4MiniflareOptions({
  modules: true,
  script: source,
  compatibilityDate: '2025-09-01',
  kvNamespaces: ['KYRO_DATA'],
  durableObjects: { KYRO_REQUESTS: { className: 'KyroRequests', useSQLite: true } },
  bindings: {
    KYRO_GUILD_ID: 'guild', DISCORD_GUILD_ID: 'guild', DISCORD_BOT_TOKEN: 'test-bot',
    DISCORD_CLIENT_ID: 'test-client', DISCORD_CLIENT_SECRET: 'test-secret'
  },
  outboundService: async request => {
    const url = new URL(request.url);
    if (url.hostname !== 'discord.com') throw new Error('Unexpected outbound host: ' + url.hostname);
    const p = url.pathname;
    if (p === '/api/users/@me') return Response.json({ id: 'owner', username: 'owner-editor', avatar: null });
    if (p === '/api/users/@me/guilds') return Response.json([{ id: 'guild', owner: true, permissions: '8' }]);
    if (p === `/api/v10/channels/${ALERT}/messages` && request.method === 'GET') return Response.json(alertMessages);
    if (p === `/api/v10/channels/${AUDIT}/messages` && request.method === 'POST') { auditPosts.push(await request.json()); return new Response(null, { status: 200 }); }
    const member = p.match(/^\/api\/v10\/guilds\/guild\/members\/([^/]+)$/);
    if (member) return presentMembers.has(member[1]) ? Response.json({ roles: [] }) : new Response('{}', { status: 404 });
    const ban = p.match(/^\/api\/v10\/guilds\/guild\/bans\/([^/]+)$/);
    if (ban && request.method === 'PUT') { bans.push(ban[1]); return new Response(null, { status: 204 }); }
    const reaction = p.match(/^\/api\/v10\/channels\/([^/]+)\/messages\/([^/]+)\/reactions\/([^/]+)\/@me$/);
    if (reaction) { reactions.push({ method: request.method, msg: reaction[2], emoji: decodeURIComponent(reaction[3]) }); return new Response(null, { status: 204 }); }
    throw new Error('Unexpected Discord endpoint: ' + request.method + ' ' + p);
  }
}));

const msg = (id, authorId, targetId, emoji) => ({
  id, author: { id: authorId, bot: authorId === SAPPHIRE || authorId === BOT },
  mentions: targetId ? [{ id: targetId, username: 'user-' + targetId, bot: targetId === BOT }] : [],
  reactions: emoji ? [{ emoji: { name: emoji }, me: true }] : []
});

async function main() {
  const mf = make();
  let checks = 0;
  const expect = (value, label) => { assert.ok(value, label); checks++; };
  const trigger = () => mf.dispatchFetch('http://localhost/dashboard/alert-monitor', {
    method: 'POST', headers: { authorization: 'Bearer owner', origin: 'https://kyro.new.tg' }
  });
  const corsFor = async origin => {
    const res = await mf.dispatchFetch('http://localhost/requests', { method: 'OPTIONS', headers: origin ? { origin } : {} });
    return res.headers.get('access-control-allow-origin');
  };
  try {
    // --- CORS: only exact allow-listed origins may be echoed ---
    expect(await corsFor('https://kyro.new.tg') === 'https://kyro.new.tg', 'legit production origin echoed');
    expect(await corsFor('http://localhost:4173') === 'http://localhost:4173', 'legit dev origin echoed');
    for (const hostile of ['https://localhost.evil.example', 'https://evil.new.tg', 'https://127.0.0.1.evil.com', 'https://kyro.new.tg.evil.com', 'http://localhost.attacker.test']) {
      expect(await corsFor(hostile) === null, 'hostile origin rejected: ' + hostile);
    }

    // --- Auto-ban: a Sapphire join alert for a member who left is banned ---
    bans.length = 0; reactions.length = 0; auditPosts.length = 0;
    presentMembers.clear(); presentMembers.add('owner');
    alertMessages = [msg('m-leaver', SAPPHIRE, 'leaver', '✅')];
    let res = await trigger();
    expect(res.status === 200, 'owner can trigger monitor');
    expect(bans.includes('leaver'), 'Sapphire join alert + left member => ban');
    expect(reactions.some(r => r.method === 'PUT' && r.emoji === '❌'), 'left member marked ❌');
    expect(auditPosts.length === 1, 'ban audited to private channel');

    // --- Auto-ban: a non-Sapphire message must NEVER trigger a ban ---
    bans.length = 0; reactions.length = 0; auditPosts.length = 0;
    alertMessages = [msg('m-stray', '999999999999999999', 'innocent', '✅')];
    res = await trigger();
    expect(res.status === 200, 'monitor runs with stray message');
    expect(!bans.includes('innocent'), 'non-Sapphire mention never banned');
    expect(reactions.length === 0 && auditPosts.length === 0, 'non-Sapphire message untouched');

    // --- Auto-ban: a Sapphire alert for a member still present is never banned ---
    bans.length = 0; reactions.length = 0; auditPosts.length = 0;
    presentMembers.add('stayer');
    alertMessages = [msg('m-stayer', SAPPHIRE, 'stayer', null)];
    res = await trigger();
    expect(!bans.includes('stayer'), 'present member never banned');
    expect(reactions.some(r => r.method === 'PUT' && r.emoji === '✅'), 'present member marked ✅');

    // --- Auto-ban: the bot and the owner are never banned even if mentioned ---
    bans.length = 0; reactions.length = 0; auditPosts.length = 0;
    alertMessages = [msg('m-bot', SAPPHIRE, BOT, '✅'), msg('m-owner', SAPPHIRE, OWNER, '✅')];
    res = await trigger();
    expect(!bans.includes(BOT) && !bans.includes(OWNER), 'bot and owner excluded from enforcement');

    console.log(JSON.stringify({ checks, cors: 'exact-match allow-list', autoBan: 'Sapphire-only, owner/bot excluded, present members safe', result: 'passed' }));
  } finally { await mf.dispose(); }
}
main().catch(err => { console.error(err); process.exitCode = 1; });