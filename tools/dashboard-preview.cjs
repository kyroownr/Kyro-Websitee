/* Fixture-backed dashboard preview for UI verification (no real Discord calls).
   Boots bot_dashboard.js on http://localhost:4198 with mocked REST + seeded state.
   Run: node tools/dashboard-preview.cjs  (Ctrl+C to stop) */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');

const PORT = 4198;
const DATA = path.join(os.tmpdir(), `kyro-dashboard-preview-${Date.now()}.json`);
process.env.PORT = String(PORT);
process.env.DASHBOARD_DISABLE_POLLER = '1';
process.env.DASHBOARD_DISABLE_OPEN = '1';
process.env.DISCORD_BOT_TOKEN = 'preview-token';
process.env.DISCORD_OWNER_ID = '1052909930073567232';
process.env.DASHBOARD_DATA_FILE = DATA;

const now = Date.now();
fs.writeFileSync(DATA, JSON.stringify({
  guilds: {
    guild1: {
      automod: { enabled: true, badWords: ['spamword', 'badlink'], blockInvites: true, maxMentions: 5, maxEmojis: 12, capsPercent: 80, action: 'timeout', timeoutSeconds: 600, exemptRoles: ['role2'], channels: ['chan1'], processed: [] },
      welcome: { enabled: true, channelId: 'chan3', message: 'Welcome {user} to **{server}**! You are member #{membercount}.', useEmbed: true, embedColor: '#3ba55d', dm: true, dmMessage: 'Welcome to {server}! Read the rules.', knownMembers: [], seeded: false },
      logging: { enabled: true, channelId: 'chan4', events: { moderation: true, giveaways: true, reactionRoles: true, automod: true, welcome: true, joins: true } },
      reactionRoles: [
        { id: 'rr1', channel: 'chan2', message_id: 'msg1', mode: 'normal', title: 'Pick your roles', mappings: [{ emoji: '🎮', roleId: 'role1' }, { emoji: '🎬', roleId: 'role2' }], state: {}, created_at: new Date(now - 86400000).toISOString() }
      ],
      giveaways: [
        { id: 'gv1', channel: 'chan2', message_id: 'msg1', prize: 'Nitro Classic', description: 'Monthly community giveaway', winners: 1, ends_at: now + 3600000, ended: false, entrants: ['200000000000000003', '200000000000000004'], winnerIds: [], created_at: new Date(now - 600000).toISOString() },
        { id: 'gv2', channel: 'chan2', message_id: 'msg2', prize: 'Spotify Premium', description: '', winners: 2, ends_at: now - 3600000, ended: true, entrants: ['200000000000000003'], winnerIds: ['200000000000000003'], created_at: new Date(now - 7200000).toISOString() }
      ],
      warnings: [
        { id: 'w1', userId: '200000000000000004', moderator: 'Dashboard', reason: 'Advertising in general', created_at: new Date(now - 3600000).toISOString() },
        { id: 'w2', userId: '200000000000000003', moderator: 'Dashboard', reason: 'Caps spam', created_at: new Date(now - 7200000).toISOString() }
      ],
      tempbans: [],
      audit: [
        { id: 'a1', type: 'moderation', title: 'Moderation • timeout', description: 'User: <@200000000000000004>\nReason: spam', created_at: new Date(now - 1800000).toISOString() },
        { id: 'a2', type: 'giveaways', title: 'Giveaway created', description: 'Prize: Nitro Classic', created_at: new Date(now - 600000).toISOString() },
        { id: 'a3', type: 'joins', title: 'Member joined', description: 'User: alice', created_at: new Date(now - 300000).toISOString() }
      ]
    }
  }
}, null, 2));

const realFetch = global.fetch;
const BOT_ID = 'bot0000000000000001';
function jsonRes(obj, status) {
  const s = status || 200;
  if (s === 204 || s === 205 || s === 304) return Promise.resolve(new Response(null, { status: s }));
  return Promise.resolve(new Response(JSON.stringify(obj), { status: s, headers: { 'content-type': 'application/json' } }));
}
global.fetch = async (url, opts) => {
  const u = String(url);
  if (!u.startsWith('https://discord.com/api/v10')) return realFetch(url, opts);
  const method = (opts && opts.method) || 'GET';
  const p = u.replace('https://discord.com/api/v10', '').split('?')[0];
  if (p === '/users/@me') return jsonRes({ id: BOT_ID, username: 'UtilityBot' });
  if (p === '/users/@me/guilds') return jsonRes([
    { id: 'guild1', name: 'Kyro Community', icon: null, owner: true, approximate_member_count: 1248, permissions: '8' },
    { id: 'guild2', name: 'Editing Hub', icon: null, owner: false, approximate_member_count: 372, permissions: '8' }
  ]);
  if (/^\/guilds\/guild1$/.test(p)) return jsonRes({ id: 'guild1', name: 'Kyro Community', icon: null, owner_id: '1052909930073567232', approximate_member_count: 1248, approximate_presence_count: 214, verification_level: 2, premium_tier: 2 });
  if (p === '/guilds/guild1/channels') return jsonRes([
    { id: 'chan1', name: 'general', type: 0, position: 1, permission_overwrites: [] },
    { id: 'chan2', name: 'giveaways', type: 0, position: 2 },
    { id: 'chan3', name: 'welcome', type: 0, position: 3 },
    { id: 'chan4', name: 'mod-logs', type: 0, position: 4 },
    { id: 'chan5', name: 'resources', type: 0, position: 5 },
    { id: 'vc1', name: 'Lounge', type: 2, position: 6 }
  ]);
  if (p === '/guilds/guild1/roles') return jsonRes([
    { id: 'guild1', name: '@everyone', color: 0, position: 0, managed: false },
    { id: 'role1', name: 'Member', color: 5793266, position: 1, managed: false },
    { id: 'role2', name: 'VIP', color: 15844367, position: 2, managed: false },
    { id: 'role3', name: 'Moderator', color: 15158332, position: 3, managed: false },
    { id: 'role4', name: 'Editor', color: 3066993, position: 4, managed: false }
  ]);
  if (p === '/guilds/guild1/members') return jsonRes([
    { user: { id: '200000000000000003', username: 'alice', global_name: 'Alice', avatar: null, bot: false }, nick: null, roles: ['role1'] },
    { user: { id: '200000000000000004', username: 'bob', global_name: 'Bob', avatar: null, bot: false }, nick: 'Bobby', roles: ['role1', 'role4'] }
  ]);
  if (p === '/guilds/guild1/members/search') return jsonRes([
    { user: { id: '200000000000000003', username: 'alice', global_name: 'Alice', avatar: null, bot: false }, nick: null, roles: ['role1'] }
  ]);
  if (p === '/guilds/guild1/members/200000000000000003') return jsonRes({ user: { id: '200000000000000003', username: 'alice' }, nick: 'Ally', roles: ['role1', 'role4'], joined_at: '2026-01-01T00:00:00.000Z', communication_disabled_until: null });
  if (/^\/guilds\/guild1\/members\/[^/]+\/roles\/[^/]+$/.test(p)) return jsonRes({}, 204);
  if (/^\/guilds\/guild1\/members\/[^/]+$/.test(p)) return jsonRes({}, 204);
  if (/^\/guilds\/guild1\/bans\/[^/]+$/.test(p)) return jsonRes({}, 204);
  if (p === '/users/200000000000000003') return jsonRes({ id: '200000000000000003', username: 'alice', global_name: 'Alice', avatar: null, discriminator: '0', bot: false });
  if (p === '/users/200000000000000003/channels') return jsonRes({ id: 'dm1' });
  if (/^\/channels\/[^/]+$/.test(p) && method === 'GET') return jsonRes({ id: p.split('/')[2], permission_overwrites: [] });
  if (/^\/channels\/[^/]+$/.test(p) && method === 'PATCH') return jsonRes({ id: p.split('/')[2] });
  if (/^\/channels\/[^/]+\/messages$/.test(p) && method === 'GET') return jsonRes([{ id: 'm1', content: 'hello', author: { id: '200000000000000003', bot: false }, mentions: [], member: { roles: [] } }]);
  if (/^\/channels\/[^/]+\/messages$/.test(p) && method === 'POST') return jsonRes({ id: 'msg1' });
  if (/^\/channels\/[^/]+\/messages\/bulk-delete$/.test(p)) return jsonRes({}, 204);
  if (/^\/channels\/[^/]+\/messages\/[^/]+$/.test(p)) return jsonRes({ id: 'msg1' });
  if (/\/reactions\/.+\/@me$/.test(p)) return jsonRes({}, 204);
  if (/\/reactions\/.+$/.test(p)) return jsonRes([{ id: '200000000000000003', username: 'alice' }, { id: '200000000000000004', username: 'bob' }, { id: BOT_ID, username: 'UtilityBot' }]);
  if (p === '/channels/dm1/messages') return jsonRes({ id: 'dmsg1' });
  return jsonRes({}, 200);
};

import(pathToFileURL(path.join(__dirname, '..', 'bot_dashboard.js')).href).then(() => {
  console.log(`[preview] Dashboard UI ready at http://localhost:${PORT} (mocked Discord, seeded state)`);
}).catch((e) => { console.error(e); process.exit(1); });