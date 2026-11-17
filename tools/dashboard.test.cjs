/* Multi-server dashboard API tests.
   Mocks the Discord REST API, boots bot_dashboard.js on a test port with the
   poller disabled, and exercises the local HTTP endpoints end to end.
   Run: node tools/dashboard.test.cjs */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { pathToFileURL } = require('url');

const PORT = 4199;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP_DATA = path.join(os.tmpdir(), `kyro-dashboard-test-${Date.now()}.json`);

process.env.PORT = String(PORT);
process.env.DASHBOARD_DISABLE_POLLER = '1';
process.env.DASHBOARD_DISABLE_OPEN = '1';
process.env.DISCORD_BOT_TOKEN = 'test-bot-token';
process.env.DISCORD_OWNER_ID = '1052909930073567232';
process.env.DASHBOARD_DATA_FILE = TMP_DATA;

const realFetch = global.fetch;
const calls = [];
const BOT_ID = 'bot0000000000000001';
let failRoleCreation = false;
// Flipped to '0' to simulate a server where the bot was invited without
// Administrator; the dashboard must then ask for admin instead of failing.
let adminPermissions = '8';
// Simulates Discord's guild list still reporting 0 permissions right after
// Administrator was granted: the bot's member roles are the source of truth.
let staleGuildListAdmin = false;

function jsonRes(obj, status) {
  const s = status || 200;
  if (s === 204 || s === 205 || s === 304) return Promise.resolve(new Response(null, { status: s }));
  return Promise.resolve(new Response(JSON.stringify(obj), { status: s, headers: { 'content-type': 'application/json' } }));
}

// Discord REST mock router.
const mockOverwrites = { chan1: [], chan2: [] };
// When set, the channel-visibility test serves this fixture instead of the
// default three-channel list. Reset to null afterwards so nothing else changes.
let extraChannels = null;
// Giveaway-sync and image-upload fixtures. Empty/null = fall through to the
// default mock behaviour so earlier assertions are unaffected.
let giveawayScan = {};
let reactionFixture = null;
// Mutable so the honeypot test can add a staff member and a bot message to the
// same channel without disturbing the earlier automod assertions.
let chan1Messages = [
  { id: 'm1', content: 'hello world', author: { id: '200000000000000003', bot: false }, mentions: [], member: { roles: [] } }
];
// Mutable so the role-cleanup test can add unused/staff roles after the earlier
// assertions have already expected the original five-role fixture.
let guild1Roles = [
  { id: 'guild1', name: '@everyone', color: 0, position: 0, managed: false },
  { id: 'role1', name: 'Member', color: 5793266, position: 1, managed: false },
  { id: 'role2', name: 'VIP', color: 15844367, position: 2, managed: false },
  { id: 'role3', name: 'Owner', color: 0, position: 20, managed: false },
  { id: 'role_bot', name: 'Kyro Bot', color: 0, position: 10, managed: false }
];
let guild1Members = [
  { user: { id: '200000000000000003', username: 'alice', global_name: 'Alice', avatar: null, bot: false }, nick: null, roles: ['role1'], joined_at: '2026-01-01T00:00:00.000Z' }
];
global.fetch = async (url, opts) => {
  const u = String(url);
  if (!u.startsWith('https://discord.com/api/v10')) return realFetch(url, opts);
  const method = (opts && opts.method) || 'GET';
  const p = u.replace('https://discord.com/api/v10', '').split('?')[0];
  let body = null;
  try { body = opts && opts.body ? JSON.parse(opts.body) : null; } catch (e) {}
  calls.push({ method, path: p, body });

  const msgChan = /^\/channels\/([^/]+)\/messages$/.exec(p);
  if (method === 'GET' && msgChan && giveawayScan[msgChan[1]]) return jsonRes(giveawayScan[msgChan[1]]);
  if (method === 'GET' && /\/reactions\//.test(p) && reactionFixture) return jsonRes(reactionFixture);
  if (method === 'POST' && msgChan && opts.body && typeof opts.body.append === 'function') {
    return jsonRes({ id: 'msg_up', attachments: [{ url: 'https://cdn.discordapp.com/attachments/1/2/image.png' }] });
  }

  if (p === '/users/@me') return jsonRes({ id: BOT_ID, username: 'UtilityBot' });
  // The invite must target the app this token belongs to, even though the
  // dashboard used to hardcode a different client id.
  if (p === '/oauth2/applications/@me') return jsonRes({ id: '1571036271839682601', name: 'Kyro Bot' });
  if (p === '/users/@me/guilds') return jsonRes([
    { id: 'guild1', name: 'Test Server', icon: null, owner: true, approximate_member_count: 100, permissions: adminPermissions },
    { id: 'guild2', name: 'Second Server', icon: null, owner: false, approximate_member_count: 42, permissions: adminPermissions }
  ]);
  if (/^\/guilds\/guild1$/.test(p)) return jsonRes({ id: 'guild1', name: 'Test Server', icon: null, owner_id: '1052909930073567232', approximate_member_count: 100, approximate_presence_count: 20, verification_level: 2, premium_tier: 1 });
  if (p === '/guilds/guild1/channels') {
    if (method === 'POST') return jsonRes({ id: 'chan_new_' + (body && body.name || 'x').replace(/[^a-z0-9]/g, ''), name: body && body.name, type: body && body.type || 0, permission_overwrites: [] });
    if (extraChannels) return jsonRes(extraChannels);
    return jsonRes([
      { id: 'chan1', name: 'general', type: 0, position: 1, permission_overwrites: mockOverwrites.chan1 },
      { id: 'chan2', name: 'giveaways', type: 0, position: 2, permission_overwrites: mockOverwrites.chan2 },
      { id: 'chan_forum', name: 'help', type: 15, position: 3, permission_overwrites: [] }
    ]);
  }
  if ((p === '/channels/chan1' || p === '/channels/chan2') && method === 'PATCH') {
    if (body && body.permission_overwrites) mockOverwrites[p.split('/').pop()] = body.permission_overwrites;
    return jsonRes({ id: p.split('/').pop() });
  }
  if (p === '/guilds/guild1/roles') {
    if (method === 'POST') {
      if (failRoleCreation) return jsonRes({ message: 'Missing Permissions' }, 403);
      return jsonRes({ id: 'role_new_' + String(body && body.name || 'x').replace(/[^a-z0-9]/g, ''), name: body && body.name, managed: false, position: 5 });
    }
    return jsonRes(guild1Roles);
  }
  if (/^\/guilds\/guild1\/roles\/[^/]+$/.test(p) && method === 'DELETE') return jsonRes({}, 204);
  if (p === '/guilds/guild1/members/bot0000000000000001') return jsonRes({ user: { id: BOT_ID, username: 'UtilityBot' }, roles: ['role_bot'] });
  if (p === '/guilds/guild2/members/bot0000000000000001') return jsonRes({ user: { id: BOT_ID, username: 'UtilityBot' }, roles: staleGuildListAdmin ? ['role_stale_admin'] : ['role_stale_member'] });
  if (p === '/guilds/guild2/roles') return jsonRes([
    { id: 'guild2', name: '@everyone', managed: false, permissions: '0' },
    { id: 'role_stale_admin', name: 'Kyro Bot', managed: false, permissions: '8' },
    { id: 'role_stale_member', name: 'Member', managed: false, permissions: '0' }
  ]);
  if (/^\/guilds\/guild1\/roles\/[^/]+$/.test(p) && method === 'PATCH') return jsonRes({ id: p.split('/').pop(), permissions: body && body.permissions });
  if (p === '/guilds/guild1/members') return jsonRes(guild1Members);
  if (p === '/guilds/guild1/members/search') return jsonRes([
    { user: { id: '200000000000000003', username: 'alice', global_name: 'Alice', avatar: null, bot: false }, nick: null, roles: ['role1'] }
  ]);
  if (p === '/guilds/guild1/members/200000000000000003') return jsonRes({ user: { id: '200000000000000003', username: 'alice' }, nick: 'Ally', roles: ['role1'], joined_at: '2026-01-01T00:00:00.000Z', communication_disabled_until: null });
  if (/^\/guilds\/guild1\/members\/200000000000000003\/roles\/role1$/.test(p)) return jsonRes({}, 204);
  if (/^\/guilds\/guild1\/members\/[^/]+$/.test(p)) return jsonRes({}, 204); // PATCH timeout / DELETE kick
  if (/^\/guilds\/guild1\/bans\/[^/]+$/.test(p)) return jsonRes({}, 204); // PUT ban / DELETE unban
  if (p === '/users/200000000000000003') return jsonRes({ id: '200000000000000003', username: 'alice', global_name: 'Alice', avatar: null, discriminator: '0', bot: false });
  if (p === '/users/200000000000000003/channels') return jsonRes({ id: 'dm1' });
  if (p === '/channels/chan1' && method === 'GET') return jsonRes({ id: 'chan1', name: 'general', permission_overwrites: mockOverwrites.chan1 });
  if (p === '/channels/chan1/messages' && method === 'GET') return jsonRes(chan1Messages);
  if (p === '/channels/chan1/messages' && method === 'POST') return jsonRes({ id: 'msg1' });
  if (p === '/channels/chan1/messages/bulk-delete') return jsonRes({}, 204);
  if (/^\/channels\/chan1\/messages\/msg1$/.test(p)) return jsonRes({ id: 'msg1' }); // PATCH edit / DELETE
  if (/^\/channels\/chan1\/messages\/m1$/.test(p)) return jsonRes({}, 204);
  if (/^\/channels\/chan1\/messages\/msg1\/reactions\/.+\/@me$/.test(p)) return jsonRes({}, 204);
  if (/^\/channels\/chan1\/messages\/msg1\/reactions\/.+$/.test(p)) return jsonRes([
    { id: '200000000000000003', username: 'alice' }, { id: '200000000000000004', username: 'bob' }, { id: BOT_ID, username: 'UtilityBot' }
  ]);
  if (p === '/channels/dm1/messages') return jsonRes({ id: 'dmsg1' });
  if (p === '/channels/chan_forum/messages' && method === 'POST') return jsonRes({ id: 'msg1' });
  return jsonRes({}, 200);
};

let passed = 0;
let serverHandle = null;
function ok(cond, label) {
  if (!cond) throw new Error('FAIL: ' + label);
  passed++;
}
function shutdown(code) {
  try { if (serverHandle) { serverHandle.closeAllConnections(); serverHandle.close(); } } catch (e) {}
  try { if (serverHandle && serverHandle.ipv6) { serverHandle.ipv6.closeAllConnections(); serverHandle.ipv6.close(); } } catch (e) {}
  try { if (serverHandle && serverHandle.servers) serverHandle.servers.forEach((s) => { try { s.close(); } catch (e) {} }); } catch (e) {}
  try { fs.unlinkSync(TMP_DATA); } catch (e) {}
  setTimeout(() => process.exit(code), 50);
}
function rawHostRequest(hostHeader) {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: '/api/status', method: 'GET', headers: { Host: hostHeader } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    r.on('error', () => resolve(0));
    r.end();
  });
}
async function req(method, p, body) {
  const res = await realFetch(BASE + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
function lastCall(pred) { for (let i = calls.length - 1; i >= 0; i--) if (pred(calls[i])) return calls[i]; return null; }

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { const r = await realFetch(BASE + '/api/status'); if (r.ok) return; } catch (e) {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Dashboard server did not start');
}

(async () => {
  const mod = await import(pathToFileURL(path.join(__dirname, '..', 'bot_dashboard.js')).href);
  serverHandle = mod.server;
  // Keep the IPv6 loopback twin reachable for shutdown.
  serverHandle.servers = [mod.server, mod.server6].filter(Boolean);
  serverHandle.ipv6 = mod.server6;
  await waitForServer();

  // Status + HTML
  const status = await req('GET', '/api/status');
  ok(status.status === 200 && status.data.tokenLoaded === true, 'status reports token loaded');
  ok(status.data.clientId === '1571036271839682601', 'invite client id is taken from the bot token');
  ok(String(status.data.installUrl || '').includes('client_id=1571036271839682601'), 'install URL targets the running bot, not a hardcoded app');
  ok(status.data.botName === 'UtilityBot', 'status reports the bot identity');
  const html = await realFetch(BASE + '/');
  const htmlText = await html.text();
  ok(html.status === 200 && /Kyro Staff Bot/.test(htmlText) && /Giveaways/.test(htmlText), 'serves dashboard HTML');
  ok(!/Publish Kyro Vault/.test(htmlText) && !/Kyro Live Preview/.test(htmlText), 'no Kyro publisher/preview in UI');

  // Host guard (raw http so the Host header is honoured)
  const rebindingStatus = await rawHostRequest('evil.example.com');
  ok(rebindingStatus === 403, 'DNS-rebinding Host rejected');
  const loopbackStatus = await rawHostRequest(`127.0.0.1:${PORT}`);
  ok(loopbackStatus === 200, 'loopback Host allowed');

  // Multi-server selector
  const guilds = await req('GET', '/api/guilds');
  ok(guilds.status === 200 && guilds.data.guilds.length === 2, 'lists bot guilds (multi-server)');
  ok(guilds.data.guilds[0].member_count === 100, 'guild member counts present');

  // Guild detail
  const guild = await req('GET', '/api/guild?guild=guild1');
  ok(guild.status === 200 && guild.data.guild.name === 'Test Server', 'guild detail loads');
  ok(guild.data.channels.length === 3 && guild.data.roles.length === 5, 'channels and roles load');

  // Config defaults
  const config = await req('GET', '/api/config?guild=guild1');
  ok(config.status === 200 && config.data.automod && config.data.welcome && config.data.logging, 'per-guild config defaults');

  // Moderation: ban targets the selected guild
  const ban = await req('POST', '/api/moderate', { guild: 'guild1', action: 'ban', userId: '200000000000000003', reason: 'spam' });
  ok(ban.status === 200 && ban.data.ok, 'ban succeeds');
  ok(lastCall((c) => c.method === 'PUT' && c.path === '/guilds/guild1/bans/200000000000000003'), 'ban PUT to correct guild');

  // Timeout
  const timeout = await req('POST', '/api/moderate', { guild: 'guild1', action: 'timeout', userId: '200000000000000003', duration: 300, reason: 'cool off' });
  ok(timeout.status === 200, 'timeout succeeds');
  ok(lastCall((c) => c.method === 'PATCH' && c.path === '/guilds/guild1/members/200000000000000003' && c.body.communication_disabled_until), 'timeout PATCH sets until');

  // Warn stores locally + DMs
  const warn = await req('POST', '/api/moderate', { guild: 'guild1', action: 'warn', userId: '200000000000000003', reason: 'be nice', serverName: 'Test Server' });
  ok(warn.status === 200 && /Total warnings: 1/.test(warn.data.message), 'warn records count');
  ok(lastCall((c) => c.path === '/channels/dm1/messages'), 'warn DMs the member');
  const warns = await req('GET', '/api/warnings?guild=guild1');
  ok(warns.data.warnings.length === 1, 'warnings listed');

  // Purge
  const purge = await req('POST', '/api/moderate', { guild: 'guild1', action: 'purge', channelId: 'chan1', amount: 5 });
  ok(purge.status === 200 && /Purged 1/.test(purge.data.message), 'purge deletes messages');

  // Slowmode + lock
  const slow = await req('POST', '/api/moderate', { guild: 'guild1', action: 'slowmode', channelId: 'chan1', seconds: 10 });
  ok(slow.status === 200 && lastCall((c) => c.method === 'PATCH' && c.path === '/channels/chan1' && c.body.rate_limit_per_user === 10), 'slowmode patches channel');
  const lock = await req('POST', '/api/moderate', { guild: 'guild1', action: 'lock', channelId: 'chan1' });
  ok(lock.status === 200 && lastCall((c) => c.method === 'PATCH' && c.path === '/channels/chan1' && Array.isArray(c.body.permission_overwrites)), 'lock sets overwrites');

  // Role add
  const addrole = await req('POST', '/api/moderate', { guild: 'guild1', action: 'addrole', userId: '200000000000000003', roleId: 'role2' });
  ok(addrole.status === 200 && lastCall((c) => c.method === 'PUT' && c.path === '/guilds/guild1/members/200000000000000003/roles/role2'), 'addrole PUT');

  // Giveaway create -> posts message + reaction, stores
  const gv = await req('POST', '/api/giveaway/create', { guild: 'guild1', prize: 'Nitro', channelId: 'chan1', winners: 1, minutes: 60 });
  ok(gv.status === 200 && gv.data.giveaway.message_id === 'msg1', 'giveaway created with message');
  ok(lastCall((c) => c.method === 'PUT' && /reactions\/.+\/@me/.test(c.path)), 'giveaway seeds 🎉 reaction');
  const gvList = await req('GET', '/api/config?guild=guild1');
  ok(gvList.data.giveaways.length === 1 && gvList.data.giveaways[0].prize === 'Nitro', 'giveaway stored');

  // Giveaway end -> collects entrants (excludes bot), picks winner, announces
  const ended = await req('POST', '/api/giveaway/end', { guild: 'guild1', id: gv.data.giveaway.id });
  ok(ended.status === 200 && ended.data.giveaway.ended === true, 'giveaway ended');
  ok(ended.data.giveaway.entrants.length === 2 && !ended.data.giveaway.entrants.includes(BOT_ID), 'entrants exclude bot');
  ok(ended.data.giveaway.winnerIds.length === 1, 'one winner picked');
  ok(lastCall((c) => c.method === 'POST' && c.path === '/channels/chan1/messages' && /Congratulations/.test(c.body.content)), 'winner announced');

  // Reroll
  const reroll = await req('POST', '/api/giveaway/reroll', { guild: 'guild1', id: gv.data.giveaway.id });
  ok(reroll.status === 200 && /New winner/.test(lastCall((c) => c.method === 'POST' && c.path === '/channels/chan1/messages').body.content), 'reroll announces new winner');

  // Reaction roles create -> posts + seeds reactions
  const rr = await req('POST', '/api/reactionroles/create', { guild: 'guild1', channelId: 'chan1', mode: 'unique', title: 'Roles', mappings: [{ emoji: '🎮', roleId: 'role1' }, { emoji: '🎬', roleId: 'role2' }] });
  ok(rr.status === 200 && rr.data.reactionRole.mappings.length === 2, 'reaction roles created');
  ok(calls.filter((c) => c.method === 'PUT' && /reactions\/.+\/@me/.test(c.path)).length >= 3, 'reaction roles seed emojis');

  // AutoMod config
  const am = await req('POST', '/api/automod', { guild: 'guild1', enabled: true, badWords: ['badword'], blockInvites: true, maxMentions: 5, action: 'timeout', timeoutSeconds: 600, channels: ['chan1'], exemptRoles: ['role2'] });
  ok(am.status === 200 && am.data.automod.enabled && am.data.automod.badWords[0] === 'badword', 'automod config saved');

  // Welcome config + test
  const w = await req('POST', '/api/welcome', { guild: 'guild1', enabled: true, channelId: 'chan1', message: 'Hi {user} welcome to {server}!', useEmbed: true, embedColor: '#3ba55d', dm: false });
  ok(w.status === 200 && w.data.welcome.enabled, 'welcome config saved');
  const wt = await req('POST', '/api/welcome/test', { guild: 'guild1', username: 'Tester' });
  ok(wt.status === 200, 'welcome test sends');

  // Logging config
  const lg = await req('POST', '/api/logging', { guild: 'guild1', enabled: true, channelId: 'chan1', events: { moderation: true, giveaways: true, reactionRoles: false, automod: true, welcome: true, joins: true } });
  ok(lg.status === 200 && lg.data.logging.events.reactionRoles === false, 'logging config saved');
  ok(/staff-only/.test(lg.data.note), 'logging save reports the channel is staff-only');
  const logLock = lastCall((c) => c.method === 'PATCH' && c.path === '/channels/chan1' && c.body.permission_overwrites);
  ok(logLock && logLock.body.permission_overwrites.some((o) => o.id === 'guild1' && o.type === 0 && (BigInt(o.deny) & 1024n) !== 0n), 'a public log channel is locked down on save');
  ok(!logLock.body.permission_overwrites.some((o) => o.id === 'guild1' && o.type === 0 && (BigInt(o.allow || '0') & 1024n) !== 0n), '@everyone loses view on the log channel');

  // Utility userinfo
  const ui = await req('GET', '/api/userinfo?guild=guild1&user=200000000000000003');
  ok(ui.status === 200 && ui.data.user.username === 'alice' && ui.data.member.nick === 'Ally', 'userinfo returns user + member');
  ok(ui.data.user.created_at, 'userinfo computes account creation');

  // Member search
  const ms = await req('GET', '/api/members?guild=guild1&q=ali');
  ok(ms.status === 200 && ms.data.members.length === 1, 'member search works');

  // Embed sender
  const em = await req('POST', '/api/embed', { guild: 'guild1', channelId: 'chan1', title: 'Hello', description: 'World', color: '#ff0000', fields: [{ name: 'F', value: 'V', inline: true }] });
  ok(em.status === 200 && em.data.message_id === 'msg1', 'embed sent');
  const emCall = calls.find((c) => c.method === 'POST' && c.path === '/channels/chan1/messages' && c.body.embeds && c.body.embeds[0].title === 'Hello');
  ok(emCall && emCall.body.embeds[0].color === 0xff0000 && emCall.body.embeds[0].fields.length === 1, 'embed payload correct');

  // Embed validation
  const emBad = await req('POST', '/api/embed', { guild: 'guild1', channelId: 'chan1' });
  ok(emBad.status === 400, 'embed requires title or description');

  // Second guild isolation
  const g2cfg = await req('GET', '/api/config?guild=guild2');
  ok(g2cfg.status === 200 && g2cfg.data.giveaways.length === 0, 'second guild config isolated');

  // Cleanup warnings
  const cw = await req('POST', '/api/warnings/clear', { guild: 'guild1' });
  ok(cw.status === 200, 'warnings cleared');

  // ---- Setup & Security suite ----
  // Auto permissions: Member -> chat basics, VIP -> safe baseline, protected roles skipped
  const perms = await req('POST', '/api/permissions/apply', { guild: 'guild1' });
  ok(perms.status === 200 && perms.data.applied.length === 2, 'two roles optimised');
  ok(perms.data.applied.some((s) => s.startsWith('Member') && s.includes('chat basics')), 'Member gets chat basics');
  ok(perms.data.applied.some((s) => s.startsWith('VIP') && s.includes('VIP perks')), 'VIP role optimised to perks tier');
  ok(perms.data.skipped.some((s) => s.startsWith('@everyone')), '@everyone protected');
  ok(perms.data.skipped.some((s) => s.startsWith('Owner') && s.includes('above the Kyro Bot')), 'roles above the bot skipped with explanation');
  ok(perms.data.skipped.some((s) => s.startsWith('Kyro Bot')), 'bot roles skipped');
  ok(lastCall((c) => c.method === 'PATCH' && c.path === '/guilds/guild1/roles/role1' && c.body.permissions), 'Member role permissions PATCHed');

  // Verification setup (no gate) — creates role, channel and posts the button
  const vf = await req('POST', '/api/verify/setup', { guild: 'guild1' });
  ok(vf.status === 200 && vf.data.steps.length >= 3, 'verification setup steps');
  ok(lastCall((c) => c.method === 'POST' && c.path === '/guilds/guild1/channels' && c.body.name === '✅┃verify'), 'verify channel created');
  const vfMsg = lastCall((c) => c.method === 'POST' && /\/messages$/.test(c.path) && c.body.components);
  ok(vfMsg && /kyro-verify:guild1:/.test(vfMsg.body.components[0].components[0].custom_id), 'verify button custom_id correct');
  const vfcfg = await req('GET', '/api/config?guild=guild1');
  ok(vfcfg.data.verification.enabled === true && vfcfg.data.verification.roleId, 'verification state saved');

  // Verification with gate — hides the other text channels
  const vfGate = await req('POST', '/api/verify/setup', { guild: 'guild1', gate: true });
  ok(vfGate.status === 200 && /Gated/.test(vfGate.data.steps.join(' ')), 'gate enabled step reported');
  const gatedPatch = lastCall((c) => c.method === 'PATCH' && c.path === '/channels/chan1' && c.body.permission_overwrites);
  ok(gatedPatch && gatedPatch.body.permission_overwrites.some((o) => o.id === 'guild1' && (BigInt(o.deny) & 1024n) !== 0n), 'gate denies @everyone view on other channels');

  // Un-hide
  const ungate = await req('POST', '/api/verify/remove', { guild: 'guild1' });
  ok(ungate.status === 200 && ungate.data.touched >= 1, 'gate removed');
  const ungatedPatch = lastCall((c) => c.method === 'PATCH' && c.path === '/channels/chan1' && c.body.permission_overwrites);
  ok(ungatedPatch && (BigInt(ungatedPatch.body.permission_overwrites.find((o) => o.id === 'guild1').deny) & 1024n) === 0n, 'un-gate clears view deny');

  // One-click auto setup
  const asr = await req('POST', '/api/autosetup', { guild: 'guild1', gate: false, permissions: true });
  ok(asr.status === 200 && asr.data.steps.some((s) => /#welcome/.test(s)) && asr.data.steps.some((s) => /AutoMod/.test(s)), 'one-click setup steps');
  ok(asr.data.steps.some((s) => /staff-only/.test(s)), 'one-click setup reports the private #mod-log');
  ok(Array.isArray(asr.data.warnings) && asr.data.warnings.length === 0, 'clean one-click setup has no warnings');
  const ascfg = await req('GET', '/api/config?guild=guild1');
  ok(ascfg.data.welcome.enabled && ascfg.data.logging.enabled && ascfg.data.automod.enabled, 'auto setup enabled welcome/logging/automod');
  ok(ascfg.data.security.antiNuke === true, 'auto setup enabled anti-nuke');

  // Ticket button post
  const tk = await req('POST', '/api/tickets/post', { guild: 'guild1', channelId: 'chan1' });
  ok(tk.status === 200 && tk.data.message_id === 'msg1', 'ticket button posted');
  const tkCall = lastCall((c) => c.method === 'POST' && c.path === '/channels/chan1/messages' && c.body.components);
  ok(tkCall && tkCall.body.components[0].components[0].custom_id === 'kyro-ticket:open:guild1', 'ticket open button custom_id');

  // Ticket button to a forum channel (#help) — creates the post with a thread name
  const tkForum = await req('POST', '/api/tickets/post', { guild: 'guild1', channelId: 'chan_forum', title: 'Tickets' });
  ok(tkForum.status === 200 && tkForum.data.message_id === 'msg1', 'ticket button posted to forum channel');
  const tkForumCall = lastCall((c) => c.method === 'POST' && c.path === '/channels/chan_forum/messages' && c.body.components);
  ok(tkForumCall && tkForumCall.body.thread_name === 'Tickets', 'forum post carries thread_name');

  // Ticket button to a deleted / unknown channel explains instead of "Unknown Channel"
  const tkGone = await req('POST', '/api/tickets/post', { guild: 'guild1', channelId: '999999999999999999' });
  ok(tkGone.status === 500 && /no longer exists/.test(tkGone.data.error), 'unknown channel gives an actionable error');

  // Ticket button with a malformed channel id is rejected
  const tkBad = await req('POST', '/api/tickets/post', { guild: 'guild1', channelId: '<script>alert(1)</script>' });
  ok(tkBad.status === 500 && /invalid/.test(tkBad.data.error), 'malformed channel id rejected');

  // Security settings save
  const sec = await req('POST', '/api/security', { guild: 'guild1', antiNuke: true, antiNukeBan: true, antiNukeThreshold: 2, raidThreshold: 5, keywords: ['free nitro', 'ip grabber'] });
  ok(sec.status === 200 && sec.data.security.raidThreshold === 5 && sec.data.security.keywords.length === 2, 'security settings saved');
  const seccfg = await req('GET', '/api/config?guild=guild1');
  ok(seccfg.data.security.antiNuke === true && seccfg.data.security.antiNukeThreshold === 2, 'security settings persisted');

  // Global lockdown
  const gl = await req('POST', '/api/lockdown', { guild: 'guild1', on: true });
  ok(gl.status === 200 && gl.data.touched >= 1, 'global lockdown touches channels');
  const glPatch = lastCall((c) => c.method === 'PATCH' && c.path === '/channels/chan1' && c.body.permission_overwrites);
  ok(glPatch && (BigInt(glPatch.body.permission_overwrites.find((o) => o.id === 'guild1').deny) & 2048n) !== 0n, 'lockdown denies send on channels');
  const glOff = await req('POST', '/api/lockdown', { guild: 'guild1', on: false });
  ok(glOff.status === 200, 'global unlock');

  // Mass ban
  const mb = await req('POST', '/api/massban', { guild: 'guild1', ids: '300000000000000001, not-an-id, 300000000000000002', reason: 'raid' });
  ok(mb.status === 200 && mb.data.banned.length === 2 && mb.data.failed.length === 0, 'mass ban bans valid ids only');

  // Softban = ban + unban
  const sb = await req('POST', '/api/moderate', { guild: 'guild1', action: 'softban', userId: '200000000000000003', reason: 'cleanup' });
  ok(sb.status === 200 && sb.data.ok, 'softban executes');
  ok(lastCall((c) => c.method === 'DELETE' && c.path === '/guilds/guild1/bans/200000000000000003'), 'softban unbans right after ban');

  // Warning escalation: threshold reached -> auto timeout
  const weSave = await req('POST', '/api/security', { guild: 'guild1', warnEscalation: { enabled: true, timeoutAt: 2, timeoutMinutes: 60, kickAt: 5, banAt: 7 } });
  ok(weSave.status === 200, 'escalation config saved');
  await req('POST', '/api/moderate', { guild: 'guild1', action: 'warn', userId: '200000000000000003', reason: 'warn one', serverName: 'Test Server' });
  const warn2 = await req('POST', '/api/moderate', { guild: 'guild1', action: 'warn', userId: '200000000000000003', reason: 'warn two', serverName: 'Test Server' });
  ok(/automatic timeout/.test(warn2.data.message), 'escalation auto-times-out at threshold');
  ok(lastCall((c) => c.method === 'PATCH' && c.path === '/guilds/guild1/members/200000000000000003' && c.body.communication_disabled_until), 'escalation timeout applied');

  // Mod stats leaderboard
  const ms2 = await req('GET', '/api/modstats?guild=guild1');
  ok(ms2.status === 200 && Array.isArray(ms2.data.stats), 'mod stats endpoint');

  // Verification permission failure explains the fix instead of bare "Missing Permissions"
  failRoleCreation = true;
  const vfFail = await req('POST', '/api/verify/setup', { guild: 'guild1' });
  ok(vfFail.status === 403 && /oauth2\/authorize/.test(vfFail.data.error), 'verification permission error explains the fix');
  failRoleCreation = false;

  // ---- Admin access gate ----
  const access = await req('GET', '/api/bot/access?guild=guild1');
  ok(access.status === 200 && access.data.isAdmin === true, 'admin access reported for an admin bot');
  ok(access.data.bot && access.data.bot.id === BOT_ID, 'access reports which bot the dashboard is running');
  const absent = await req('GET', '/api/bot/access?guild=guild3');
  ok(absent.status === 200 && absent.data.inGuild === false && /not in this server/.test(absent.data.reason || ''), 'a server the bot is not in is reported clearly');

  adminPermissions = '0';
  const accessDenied = await req('GET', '/api/bot/access?guild=guild2');
  ok(accessDenied.status === 200 && accessDenied.data.isAdmin === false, 'missing admin detected');
  ok(accessDenied.data.missing.includes('Manage Roles') && accessDenied.data.missing.includes('Ban Members'), 'missing permissions listed');
  const deniedSetup = await req('POST', '/api/permissions/apply', { guild: 'guild2' });
  ok(deniedSetup.status === 403 && deniedSetup.data.needsAdmin === true, 'setup blocked when the bot lacks admin');
  ok(/oauth2\/authorize/.test(deniedSetup.data.inviteUrl || ''), 'blocked setup links the admin invite');
  const grant = await req('POST', '/api/bot/grant', { guild: 'guild2' });
  ok(grant.status === 200 && grant.data.isAdmin === false && /invite link/.test(grant.data.message), 'grant endpoint explains the invite');
  adminPermissions = '8';
  const grantOk = await req('POST', '/api/bot/grant', { guild: 'guild2' });
  ok(grantOk.status === 200 && grantOk.data.isAdmin === true, 'grant re-check reports admin after the invite');

  // Discord caches the guild list, so a freshly granted Administrator can still
  // read as 0 there. The bot's own member roles must win, or setup keeps saying
  // the bot is missing permissions it actually has.
  adminPermissions = '0';
  staleGuildListAdmin = true;
  await req('POST', '/api/bot/grant', { guild: 'guild2' }); // bust the access cache
  const stale = await req('GET', '/api/bot/access?guild=guild2');
  ok(stale.status === 200 && stale.data.isAdmin === true, 'freshly granted Administrator is detected even when the guild list is stale');
  staleGuildListAdmin = false;
  adminPermissions = '8';
  await req('POST', '/api/bot/grant', { guild: 'guild1' }); // restore the admin cache

  // ---- Role packs & presets ----
  const packs = await req('GET', '/api/roles/packs');
  ok(packs.status === 200 && packs.data.packs.length >= 12, 'role packs catalogue for many server types');
  ok(packs.data.packs.some((p) => p.id === 'gaming') && packs.data.packs.some((p) => p.id === 'business'), 'gaming and business packs present');
  const packCreate = await req('POST', '/api/roles/packs/create', { guild: 'guild1', packId: 'gaming' });
  ok(packCreate.status === 200 && packCreate.data.created.length >= 8, 'role pack creates the whole hierarchy');
  const packRoleCall = lastCall((c) => c.method === 'POST' && c.path === '/guilds/guild1/roles' && /Owner/.test(c.body.name));
  ok(packRoleCall && packRoleCall.body.permissions === '8' && packRoleCall.body.hoist === true, 'pack roles carry preset permissions and hoisting');
  const badPack = await req('POST', '/api/roles/packs/create', { guild: 'guild1', packId: 'nope' });
  ok(badPack.status === 500 && /Unknown role pack/.test(badPack.data.error), 'unknown role pack rejected');

  const presets = await req('GET', '/api/roles/presets?guild=guild1');
  ok(presets.status === 200 && presets.data.presets.length >= 18, 'role preset catalogue');
  ok(presets.data.roles.some((r) => r.name === 'VIP' && r.presetId === 'vip'), 'existing roles mapped to presets');
  const presetApply = await req('POST', '/api/roles/presets/apply', { guild: 'guild1', roleId: 'role2', presetId: 'moderator' });
  ok(presetApply.status === 200 && /moderation/.test(presetApply.data.preset), 'single role preset applied');
  const presetPatch = lastCall((c) => c.method === 'PATCH' && c.path === '/guilds/guild1/roles/role2');
  ok(presetPatch && (BigInt(presetPatch.body.permissions) & 8192n) !== 0n, 'preset grants manage messages');
  const presetBad = await req('POST', '/api/roles/presets/apply', { guild: 'guild1', roleId: 'role2', presetId: 'nope' });
  ok(presetBad.status === 500 && /Unknown role preset/.test(presetBad.data.error), 'unknown preset rejected');

  // ---- Engagement suite ----
  const eng = await req('POST', '/api/engagement', { guild: 'guild1', autoRole: { enabled: true, roleId: 'role1' }, starboard: { enabled: true, channelId: 'chan1', threshold: 2, emoji: '⭐' }, sticky: { enabled: true, channelId: 'chan1', content: 'Read the rules' }, voiceRole: { enabled: true, roleId: 'role2' } });
  ok(eng.status === 200 && eng.data.engagement.autoRole.enabled && eng.data.engagement.starboard.threshold === 2, 'engagement settings saved');
  const cfgEng = await req('GET', '/api/config?guild=guild1');
  ok(cfgEng.data.engagement.sticky.content === 'Read the rules' && cfgEng.data.engagement.voiceRole.roleId === 'role2', 'engagement persisted');

  // ---- Levels / birthdays / suggestions / stats / polls / schedule ----
  const lvSave = await req('POST', '/api/levels', { guild: 'guild1', enabled: true, minXp: 5, maxXp: 10, cooldownSeconds: 0, channelId: 'chan1', rewards: [{ level: 5, roleId: 'role2' }] });
  ok(lvSave.status === 200 && lvSave.data.levels.rewards.length === 1, 'leveling config saved');
  const lvBoard = await req('GET', '/api/levels?guild=guild1');
  ok(lvBoard.status === 200 && Array.isArray(lvBoard.data.leaderboard), 'levels leaderboard endpoint');

  const bd = await req('POST', '/api/birthdays', { guild: 'guild1', enabled: true, channelId: 'chan1', message: 'Happy {user}', users: [{ userId: '200000000000000003', date: '04-18' }, { userId: 'nope', date: 'zz' }, { userId: '200000000000000004', date: '04-18' }] });
  ok(bd.status === 200 && bd.data.birthdays.users.length === 2, 'birthdays validate and store members');

  const sg = await req('POST', '/api/suggestions/post', { guild: 'guild1', channelId: 'chan1' });
  ok(sg.status === 200 && sg.data.message_id === 'msg1', 'suggestion panel posted');
  const sgCfg = await req('GET', '/api/config?guild=guild1');
  ok(sgCfg.data.suggestions.enabled === true && sgCfg.data.suggestions.channelId === 'chan1', 'suggestions configured');
  const sgOff = await req('POST', '/api/suggestions/config', { guild: 'guild1', enabled: false });
  ok(sgOff.status === 200 && sgOff.data.suggestions.enabled === false, 'suggestions can be disabled');

  const stc = await req('POST', '/api/stat-channels', { guild: 'guild1', enabled: true, memberChannelId: 'chan1', botChannelId: '' });
  ok(stc.status === 200 && stc.data.statChannels.memberChannelId === 'chan1', 'stat channels saved');
  ok(lastCall((c) => c.method === 'PATCH' && c.path === '/channels/chan1' && /Members:/.test(c.body.name || '')), 'stat channel renamed with the live count');

  const poll = await req('POST', '/api/poll', { guild: 'guild1', channelId: 'chan1', question: 'Best game?', options: ['Valorant', 'Minecraft'], hours: 24, multiple: false });
  ok(poll.status === 200 && poll.data.poll.question === 'Best game?', 'poll created');
  const pollCall = lastCall((c) => c.method === 'POST' && c.path === '/channels/chan1/messages' && c.body && c.body.poll);
  ok(pollCall && pollCall.body.poll.answers.length === 2 && pollCall.body.poll.duration === 24, 'native poll payload correct');
  const pollBad = await req('POST', '/api/poll', { guild: 'guild1', channelId: 'chan1', question: 'Only one?', options: ['solo'] });
  ok(pollBad.status === 500 && /two poll options/.test(pollBad.data.error), 'poll requires two options');

  const scAdd = await req('POST', '/api/schedule', { guild: 'guild1', channelId: 'chan1', title: 'Movie night', description: '8pm', inMinutes: 30 });
  ok(scAdd.status === 200 && scAdd.data.schedule.announcements.length === 1, 'announcement scheduled');
  const scId = scAdd.data.schedule.announcements[0].id;
  const scRem = await req('POST', '/api/schedule', { guild: 'guild1', type: 'reminder', userId: '200000000000000003', text: 'Send your entry', inMinutes: 5 });
  ok(scRem.status === 200 && scRem.data.schedule.reminders.length === 1, 'reminder scheduled');
  const scBad = await req('POST', '/api/schedule', { guild: 'guild1', type: 'reminder', userId: '../etc/passwd', text: 'x' });
  ok(scBad.status === 400, 'reminder validates the member id');
  const scDel = await req('POST', '/api/schedule/delete', { guild: 'guild1', id: scId });
  ok(scDel.status === 200 && scDel.data.schedule.announcements.length === 0, 'scheduled announcement cancelled');

  const ac = await req('POST', '/api/autoresponses', { guild: 'guild1', responses: [{ trigger: 'ping', reply: 'pong' }, { trigger: '', reply: 'ignored' }] });
  ok(ac.status === 200 && ac.data.autoResponses.length === 1, 'auto-responses saved and filtered');
  const acCfg = await req('GET', '/api/config?guild=guild1');
  ok(acCfg.data.autoResponses[0].trigger === 'ping' && acCfg.data.rolePacks.length >= 12, 'config exposes new modules');

  // ---- CSRF guard: a random site must not be able to drive this admin API ----
  const csrf = await realFetch(BASE + '/api/roles/cleanup/apply', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{"confirm":true}'
  });
  ok(csrf.status === 403, 'cross-site POST is blocked');
  const plainPost = await realFetch(BASE + '/api/engagement', {
    method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"guild":"guild1"}'
  });
  ok(plainPost.status === 415, 'non-JSON content type is refused');

  // ---- Role cleanup: preview, protection, confirm gate, exact deletion ----
  guild1Roles = guild1Roles.concat([
    { id: 'role_unused_a', name: 'Old Event', color: 0, position: 3, managed: false, permissions: '0' },
    { id: 'role_unused_b', name: 'Color Blue', color: 0, position: 4, managed: false, permissions: '0' },
    { id: 'role_helper', name: 'Helper', color: 0, position: 6, managed: false, permissions: '0' },
    { id: 'role_admin2', name: 'Ops Team', color: 0, position: 8, managed: false, permissions: '8' },
    { id: 'role_managed', name: 'YouTube', color: 0, position: 7, managed: true, permissions: '0' }
  ]);
  guild1Members = [
    { user: { id: '200000000000000003' }, roles: ['role1', 'role_helper'] },
    { user: { id: '200000000000000004' }, roles: ['role_helper'] },
    { user: { id: '200000000000000006' }, roles: [] }
  ];
  const rcPreview = await req('GET', '/api/roles/cleanup/preview?guild=guild1&keep=1');
  ok(rcPreview.status === 200, 'role cleanup preview responds');
  const deleteIds = rcPreview.data.delete.map((r) => r.id);
  ok(deleteIds.includes('role_unused_a') && deleteIds.includes('role_unused_b'), 'unused roles queued for deletion');
  ok(!deleteIds.includes('role_admin2') && rcPreview.data.protectedRoles.some((r) => r.id === 'role_admin2' && /staff-level/.test(r.reason)), 'admin role protected by its permissions');
  ok(!deleteIds.includes('role_managed') && rcPreview.data.protectedRoles.some((r) => r.id === 'role_managed'), 'managed integration role protected');
  ok(!deleteIds.includes('role_bot') && rcPreview.data.protectedRoles.some((r) => r.id === 'role_bot'), 'bot role protected');
  ok(!deleteIds.includes('guild1') && rcPreview.data.protectedRoles.some((r) => r.id === 'guild1'), '@everyone protected');
  ok(!deleteIds.includes('role3'), 'owner role above the bot protected');
  ok(!deleteIds.includes('role1'), 'member role protected by name');
  ok(!deleteIds.includes('role_helper'), 'the busiest role survives the keep count');
  const rcNoConfirm = await req('POST', '/api/roles/cleanup/apply', { guild: 'guild1', keep: 1, ids: deleteIds });
  ok(rcNoConfirm.status === 400, 'apply refuses without confirmation');
  const rcApply = await req('POST', '/api/roles/cleanup/apply', { guild: 'guild1', keep: 1, ids: deleteIds.concat(['role_admin2', 'role3']), confirm: true });
  ok(rcApply.status === 200 && rcApply.data.deleted.length === deleteIds.length, 'apply deletes exactly the previewed roles');
  ok(!calls.some((c) => c.method === 'DELETE' && (c.path === '/guilds/guild1/roles/role_admin2' || c.path === '/guilds/guild1/roles/role3')), 'protected roles are never requested for deletion');

  // ---- Channel access repair (the "cannot view history" symptom) ----
  mockOverwrites.chan1 = [{ id: 'someone', type: 0, allow: '1024', deny: '0' }];
  const rep = await req('POST', '/api/channels/repair', { guild: 'guild1', channelId: 'chan1' });
  ok(rep.status === 200 && rep.data.channel === 'general', 'channel access repaired');
  const patched = lastCall((c) => c.method === 'PATCH' && c.path === '/channels/chan1' && c.body && c.body.permission_overwrites);
  const everyoneOw = patched.body.permission_overwrites.find((o) => o.id === 'guild1');
  ok((BigInt(everyoneOw.allow) & 65536n) !== 0n, '@everyone can read message history');
  const botOw = patched.body.permission_overwrites.find((o) => o.id === BOT_ID);
  ok((BigInt(botOw.allow) & 2048n) !== 0n, 'the bot can post in the channel');
  ok(patched.body.permission_overwrites.some((o) => o.id === 'someone'), 'unrelated overwrites are preserved');
  const repBad = await req('POST', '/api/channels/repair', { guild: 'guild1', channelId: '../etc' });
  ok(repBad.status === 400, 'invalid channel id rejected');

  // ---- Honeypot trap ----
  const hpNoChannel = await req('POST', '/api/honeypot', { guild: 'guild1', enabled: true });
  ok(hpNoChannel.status === 400 && /channel/i.test(hpNoChannel.data.error), 'honeypot refuses to enable without a channel');
  adminPermissions = '0';
  await req('POST', '/api/bot/grant', { guild: 'guild2' }); // bust the 20s access cache
  const hpNoPerm = await req('POST', '/api/honeypot', { guild: 'guild2', enabled: true, channelId: 'chan1', action: 'ban' });
  ok(hpNoPerm.status === 403 && /Ban Members/.test(hpNoPerm.data.error), 'honeypot names the ban permission it is missing');
  adminPermissions = '8';
  const hpSaved = await req('POST', '/api/honeypot', { guild: 'guild1', enabled: true, channelId: 'chan1', action: 'kick', timeoutSeconds: 900, reason: 'trap' });
  ok(hpSaved.status === 200 && hpSaved.data.honeypot.enabled === true && hpSaved.data.honeypot.timeoutSeconds === 900, 'honeypot settings saved');

  // Staff and bot posts inside the trap must never be punished.
  chan1Messages = [
    { id: 'm1', content: 'hello world', author: { id: '200000000000000003', bot: false }, mentions: [], member: { roles: [] } },
    { id: 'hp_staff', content: 'testing the trap', author: { id: '200000000000000009', bot: false }, mentions: [], member: { roles: ['role_admin2'] } },
    { id: 'hp_bot', content: 'beep', author: { id: BOT_ID, bot: true }, mentions: [], member: { roles: [] } }
  ];
  const hpRun = await req('POST', '/api/honeypot', { guild: 'guild1', enabled: true, channelId: 'chan1', action: 'kick', runNow: true });
  ok(hpRun.status === 200 && hpRun.data.run && hpRun.data.run.total === 1, 'honeypot run catches the intruder exactly once');
  ok(lastCall((c) => c.method === 'DELETE' && c.path === '/channels/chan1/messages/m1'), 'honeypot deletes the trap message');
  ok(lastCall((c) => c.method === 'DELETE' && c.path === '/guilds/guild1/members/200000000000000003'), 'honeypot kicks the intruder');
  ok(!calls.some((c) => c.method === 'DELETE' && (c.path === '/guilds/guild1/members/200000000000000009' || c.path === '/guilds/guild1/members/' + BOT_ID)), 'staff and bots are never punished');
  ok(!calls.some((c) => c.method === 'DELETE' && c.path === '/channels/chan1/messages/hp_staff'), 'staff messages are left in place');
  const hpAgain = await req('POST', '/api/honeypot', { guild: 'guild1', enabled: true, channelId: 'chan1', action: 'kick', runNow: true });
  ok(hpAgain.data.run.total === 1, 'the same message is never punished twice');
  const hpCfg = await req('GET', '/api/config?guild=guild1');
  ok(hpCfg.data.honeypot.total === 1 && hpCfg.data.honeypot.last_user === '200000000000000003', 'honeypot stats persisted in the config');
  const hpCreate = await req('POST', '/api/honeypot', { guild: 'guild1', createChannel: true, enabled: false });
  ok(hpCreate.status === 200 && /honeypot/.test(hpCreate.data.honeypot.channelId), 'honeypot channel created when missing');

  // The Discord panel explains the trap and carries live statistics.
  const hpPanel = await req('POST', '/api/honeypot', { guild: 'guild1', panel: true });
  ok(hpPanel.status === 200 && hpPanel.data.panelMessageId === 'msg1', 'honeypot panel posted');
  const panelCall = lastCall((c) => c.method === 'POST' && /\/messages$/.test(c.path) && c.body.embeds && c.body.embeds[0].title === '🍯 What is a Honeypot?');
  ok(panelCall, 'panel carries the "What is a Honeypot?" explainer');
  ok(panelCall.body.embeds[1].title === '🍯 Honeypot Statistics' && panelCall.body.embeds[1].fields.some((f) => /Total moderated in this server/.test(f.value)), 'panel carries server statistics');
  ok(panelCall.body.allowed_mentions.parse.length === 0, 'panel never pings anyone');
  const panelRefresh = await req('POST', '/api/honeypot', { guild: 'guild1', enabled: true, action: 'kick', runNow: true });
  ok(panelRefresh.status === 200 && /up to date/.test(panelRefresh.data.notes.join(' ')), 'panel is refreshed after a scan');

  // A bot with Manage Roles + Manage Channels (no Administrator) must still be
  // able to run setup — the old code claimed both were missing.
  adminPermissions = String((1n << 28n) | (1n << 4n) | (1n << 11n) | (1n << 10n));
  await req('POST', '/api/bot/grant', { guild: 'guild1' });
  const accessNoAdmin = await req('GET', '/api/bot/access?guild=guild1');
  ok(accessNoAdmin.status === 200 && accessNoAdmin.data.isAdmin === false, 'access reports no Administrator honestly');
  ok(!accessNoAdmin.data.missing.includes('Manage Roles') && !accessNoAdmin.data.missing.includes('Manage Channels'), 'access does not claim Manage Roles/Channels are missing when they are granted');
  const asNoAdmin = await req('POST', '/api/autosetup', { guild: 'guild1', gate: false, permissions: false });
  ok(asNoAdmin.status === 200, 'one-click setup runs without Administrator when the needed bits are present');
  ok(Array.isArray(asNoAdmin.data.warnings), 'one-click setup reports per-step warnings');
  adminPermissions = '8';
  await req('POST', '/api/bot/grant', { guild: 'guild1' });

  // Slash-command registration: the fix for "verification + commands don't work".
  const cmdList = await req('GET', '/api/commands');
  ok(cmdList.status === 200 && Array.isArray(cmdList.data.commands) && cmdList.data.commands.length === 8, 'GET /api/commands lists all 8 commands');
  ok(cmdList.data.commands.some((c) => c.name === 'setup') && cmdList.data.commands.some((c) => c.name === 'mod'), 'command list includes setup and mod');
  const reg = await req('POST', '/api/commands/register', {});
  ok(reg.status === 200 && reg.data.ok === true, 'POST /api/commands/register succeeds');
  ok(Array.isArray(reg.data.results) && reg.data.results.length === 2, 'registration returns one result per guild');
  ok(reg.data.results.every((r) => r.ok === true), 'both guilds registered ok');
  const put1 = lastCall((c) => c.method === 'PUT' && c.path === '/applications/1571036271839682601/guilds/guild1/commands');
  const put2 = lastCall((c) => c.method === 'PUT' && c.path === '/applications/1571036271839682601/guilds/guild2/commands');
  ok(put1 && put2, 'PUT bulk-overwrite issued for every guild the bot is in');
  ok(Array.isArray(put1.body) && put1.body.length === 8, 'registration body carries the full 8-command schema');
  ok(put1.body.some((c) => c.name === 'setup' && c.options.some((o) => o.name === 'verification')), 'registered setup includes the verification subcommand');
  const statusAfter = await req('GET', '/api/status');
  ok(statusAfter.data.commandsRegistered === 2, 'status reports 2 guilds with commands registered');

  // Bulk "set default role": give every current member a role. Reset the role and
  // member fixtures (earlier cleanup tests mutated them) so this is self-contained.
  // Role ids are numeric snowflakes, as Discord returns in production.
  guild1Roles = [
    { id: 'guild1', name: '@everyone', color: 0, position: 0, managed: false, permissions: '0' },
    { id: '111111111111111111', name: 'Member', color: 0, position: 1, managed: false, permissions: '0' },
    { id: '222222222222222222', name: 'VIP', color: 0, position: 2, managed: false, permissions: '0' },
    { id: 'role_bot', name: 'Kyro Bot', color: 0, position: 10, managed: false, permissions: '8' }
  ];
  guild1Members = [
    { user: { id: '200000000000000003', username: 'alice', bot: false }, roles: ['111111111111111111'] },
    { user: { id: '200000000000000004', username: 'bob', bot: false }, roles: ['111111111111111111', '222222222222222222'] }
  ];
  const bulk = await req('POST', '/api/roles/bulk', { guild: 'guild1', roleId: '222222222222222222' });
  ok(bulk.status === 200 && bulk.data.ok === true, 'bulk role assign succeeds');
  ok(bulk.data.added === 1 && bulk.data.skipped === 1 && bulk.data.failed === 0, 'bulk assign adds only the member lacking the role');
  ok(bulk.data.role === 'VIP', 'bulk assign reports the role name');
  ok(lastCall((c) => c.method === 'PUT' && c.path === '/guilds/guild1/members/200000000000000003/roles/222222222222222222'), 'bulk assign PUT the role onto the member');
  const bulkSkip = await req('POST', '/api/roles/bulk', { guild: 'guild1', roleId: '111111111111111111' });
  ok(bulkSkip.status === 200 && bulkSkip.data.skipped === 2 && bulkSkip.data.added === 0, 'bulk assign skips members who already have the role');
  const bulkEveryone = await req('POST', '/api/roles/bulk', { guild: 'guild1', roleId: 'guild1' });
  ok(bulkEveryone.status === 400, 'bulk assign refuses the @everyone role');
  const bulkBad = await req('POST', '/api/roles/bulk', { guild: 'guild1', roleId: 'nope' });
  ok(bulkBad.status === 400, 'bulk assign refuses a malformed role id');

  // Channel visibility: open the community channels, lock the staff hub. A
  // self-contained fixture with decorative names, a staff category, a forum, the
  // verify channel and a private ticket that must all be handled correctly.
  guild1Roles = guild1Roles.concat([{ id: '333333333333333333', name: 'Mod', color: 0, position: 5, managed: false, permissions: '0' }]);
  guild1Roles = guild1Roles.concat([{ id: '444444444444444444', name: 'Verified', color: 0, position: 2, managed: false, permissions: '0' }]);
  extraChannels = [
    { id: 'cat_staff', name: 'Staff for mods+', type: 4, position: 0 },
    { id: 'ch_transcript', name: 'transcript-log-channel', type: 0, parent_id: 'cat_staff', permission_overwrites: [] },
    { id: 'ch_vault', name: 'vault-asset-storage', type: 0, parent_id: 'cat_staff', permission_overwrites: [] },
    { id: 'ch_updates', name: 'updates-for-mods', type: 0, parent_id: 'cat_staff', permission_overwrites: [] },
    { id: 'ch_ann', name: '📢┃announcements', type: 0, permission_overwrites: [{ id: 'guild1', type: 0, allow: '0', deny: '1024' }] },
    { id: 'ch_general', name: 'general chat', type: 0, permission_overwrites: [] },
    { id: 'ch_download', name: 'downloads-links', type: 0, permission_overwrites: [] },
    { id: 'ch_incoming', name: 'incomming', type: 0, permission_overwrites: [] },
    { id: 'ch_flexx', name: 'flexx', type: 0, permission_overwrites: [] },
    { id: 'ch_staffapp', name: 'staff applications', type: 0, parent_id: 'cat_staff', permission_overwrites: [] },
    { id: 'ch_staffgeneral', name: 'general-chat', type: 0, parent_id: 'cat_staff', permission_overwrites: [] },
    { id: 'ch_help', name: 'help', type: 15, permission_overwrites: [] },
    { id: 'ch_verify', name: '✅┃verify', type: 0, permission_overwrites: [] },
    { id: 'ch_ticket', name: 'ticket-0001', type: 0, permission_overwrites: [] },
    { id: 'ch_memes', name: 'memes', type: 0, permission_overwrites: [] }
  ];
  const cv = await req('POST', '/api/channels/visibility', { guild: 'guild1' });
  ok(cv.status === 200, 'channel visibility applies');
  ok(cv.data.public.length === 7, 'seven community channels opened');
  ok(cv.data.public.includes('📢┃announcements') && cv.data.public.includes('general chat') && cv.data.public.includes('downloads-links') && cv.data.public.includes('incomming') && cv.data.public.includes('flexx') && cv.data.public.includes('help'), 'decorated, spaced, hyphenated and typo names all resolve');
  ok(cv.data.private.length === 4 && cv.data.private.includes('transcript-log-channel') && cv.data.private.includes('vault-asset-storage') && cv.data.private.includes('updates-for-mods'), 'the staff hub is locked to staff');
  ok(cv.data.public.includes('staff applications') && !cv.data.private.includes('staff applications'), 'staff-applications stays public even under the staff category');
  ok(cv.data.public.includes('general chat') && cv.data.private.includes('general-chat') && !cv.data.public.includes('general-chat'), 'the community general-chat opens but the staff-hub namesake stays locked');
  const annPatch = lastCall((c) => c.method === 'PATCH' && c.path === '/channels/ch_ann');
  const annEveryone = annPatch.body.permission_overwrites.find((o) => o.id === 'guild1' && o.type === 0);
  ok((BigInt(annEveryone.deny) & 1024n) !== 0n && (BigInt(annEveryone.allow) & 1024n) === 0n, 'opened channels stay hidden from unverified @everyone (mandatory verification)');
  ok(annPatch.body.permission_overwrites.some((o) => o.id === '444444444444444444' && o.type === 0 && (BigInt(o.allow) & 1024n) !== 0n), 'the Verified role gets full view access to opened channels');
  ok(annPatch.body.permission_overwrites.some((o) => o.id === BOT_ID && o.type === 1 && (BigInt(o.allow) & 1024n) !== 0n), 'the bot keeps posting rights in public channels');
  const trPatch = lastCall((c) => c.method === 'PATCH' && c.path === '/channels/ch_transcript');
  const trEveryone = trPatch.body.permission_overwrites.find((o) => o.id === 'guild1' && o.type === 0);
  ok((BigInt(trEveryone.deny) & 1024n) !== 0n, 'a staff-hub channel hides from @everyone');
  ok(trPatch.body.permission_overwrites.some((o) => o.id === '333333333333333333' && (BigInt(o.allow) & 1024n) !== 0n), 'staff keep view access to the locked hub');
  ok(!calls.some((c) => c.method === 'PATCH' && c.path === '/channels/ch_verify'), 'the verify channel is left untouched');
  ok(!calls.some((c) => c.method === 'PATCH' && c.path === '/channels/ch_ticket'), 'private ticket channels are left untouched');
  ok(!calls.some((c) => c.method === 'PATCH' && c.path === '/channels/ch_memes'), 'channels outside the list are left untouched');
  extraChannels = null;

  // Giveaway sync: adopt a giveaway post that lives in Discord but not the DB,
  // recount its entries from reactions, then end it into a closed-with-winners post.
  extraChannels = [{ id: 'gvchan', name: 'giveaways', type: 0, permission_overwrites: [] }];
  giveawayScan = { gvchan: [{
    id: 'gvmsg1', author: { id: BOT_ID }, content: '🎉 **GIVEAWAY** 🎉', timestamp: new Date().toISOString(),
    embeds: [{ title: '🎉 5 downloads', description: 'Anything u want\n\n**Winners:** 10\n\nReact with 🎉 to enter!', footer: { text: '0 entries • Utility Bot Giveaways' }, timestamp: new Date(Date.now() - 3600e3).toISOString() }]
  }] };
  reactionFixture = [{ id: BOT_ID }, { id: '200000000000000003' }, { id: '200000000000000004' }];
  const sync = await req('POST', '/api/giveaway/sync', { guild: 'guild1' });
  ok(sync.status === 200 && sync.data.adopted.length === 1, 'sync adopts the untracked Discord giveaway');
  const cfgAfterSync = await req('GET', '/api/config?guild=guild1');
  const adopted = (cfgAfterSync.data.giveaways || []).find((x) => x.message_id === 'gvmsg1');
  ok(Boolean(adopted), 'the adopted giveaway is listed in the dashboard');
  ok(adopted && adopted.entrants.length === 2, 'adopted giveaway counts real reaction entries (bot excluded)');
  ok(adopted && adopted.winners === 10, 'adopted giveaway keeps its winner count');
  const endAdopted = await req('POST', '/api/giveaway/end', { guild: 'guild1', id: adopted.id });
  ok(endAdopted.status === 200, 'the adopted giveaway can be ended');
  const endPatch = lastCall((c) => c.method === 'PATCH' && c.path === '/channels/gvchan/messages/gvmsg1');
  ok(endPatch && /Giveaway finished — these are the winners:/.test(endPatch.body.embeds[0].description), 'the original post is edited to announce the winners');
  ok(endPatch && /🔒 This giveaway is closed\./.test(endPatch.body.embeds[0].description), 'the original post is marked closed');
  ok(endPatch && /2 entries • Kyro Giveaways/.test(endPatch.body.embeds[0].footer.text), 'the footer shows real entries and Kyro branding');
  giveawayScan = {}; reactionFixture = null; extraChannels = null;

  // Embed image upload: a pasted/uploaded file is hosted and a CDN URL returned.
  const up = await req('POST', '/api/embed/image', { guild: 'guild1', filename: 'a.png', contentType: 'image/png', dataBase64: Buffer.from('fake-png').toString('base64') });
  ok(up.status === 200 && up.data.url === 'https://cdn.discordapp.com/attachments/1/2/image.png', 'image upload returns a public CDN url');
  ok(lastCall((c) => c.method === 'POST' && c.path === '/channels/chan1/messages' && c.body === null), 'the image was posted to Discord as a multipart attachment');
  const upBadType = await req('POST', '/api/embed/image', { guild: 'guild1', filename: 'a.html', contentType: 'text/html', dataBase64: Buffer.from('x').toString('base64') });
  ok(upBadType.status === 400, 'non-image uploads are rejected');
  const upEmpty = await req('POST', '/api/embed/image', { guild: 'guild1', filename: 'a.png', contentType: 'image/png', dataBase64: '' });
  ok(upEmpty.status === 400, 'empty image uploads are rejected');

  console.log(JSON.stringify({ checks: passed, multiServer: 'guild selector + per-guild isolation', features: 'moderation, giveaways, reaction roles, automod, welcome, logging, setup, security, honeypot, utility, embed, engagement, levels, birthdays, suggestions, polls, scheduler, stat channels, role packs, admin gate, slash-command registration, bulk default role, channel visibility, giveaway sync, embed image upload', discord: 'mocked REST', result: 'passed' }));
  shutdown(0);
})().catch((err) => { console.error('TEST ERROR:', err.message || err); shutdown(1); });