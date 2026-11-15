/**
 * Utility Bot — Multi-Server Command Center
 * A Carl-bot / Sapphire-style local dashboard for any server the bot is in.
 *
 * Runs locally on http://localhost:4000 (loopback only, Host-guarded).
 * Talks to the Discord REST API with the bot token; a background poller drives
 * giveaways, reaction roles, automod, welcomes and temp-ban expiry.
 *
 * Features: server selector, moderation (ban/kick/timeout/warn/purge/slowmode/
 * lock), giveaways, reaction roles, automod, welcome messages, logging,
 * utility lookups and a generic embed sender. No server-specific publishing.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 4000);
const OWNER_ID = process.env.DISCORD_OWNER_ID || '1052909930073567232';
// Administrator (permissions=8) keeps moderation, role and announcement tools
// working on every server the bot joins without per-feature permission drift.
const BOT_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '1570702041993711706';
const BOT_INSTALL_URL = `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(BOT_CLIENT_ID)}&permissions=8&scope=bot%20applications.commands`;

// Bot token from environment or local .env (gitignored). BOM-safe; `require`
// is undefined in ES modules so the imported fs/path are used directly.
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || (() => {
  try {
    const envPath = path.join(__dirname, '.env');
    if (fs.existsSync(envPath)) {
      const raw = fs.readFileSync(envPath, 'utf8').replace(/^\uFEFF/, '');
      const match = raw.match(/^\s*DISCORD_BOT_TOKEN\s*=\s*([^\r\n]+)/m);
      if (match) return match[1].trim().replace(/^["']|["']$/g, '');
    }
  } catch (e) {}
  return '';
})();

// ---------------------------------------------------------------------------
// Local per-guild state
// ---------------------------------------------------------------------------
const DATA_FILE = process.env.DASHBOARD_DATA_FILE || path.join(__dirname, 'dashboard_data.json');

function loadDB() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (parsed && typeof parsed === 'object') return parsed.guilds ? parsed : { guilds: parsed };
    }
  } catch (e) {
    console.error('[DB] Failed to read state, starting fresh:', e.message);
  }
  return { guilds: {} };
}

function saveDB(db) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), 'utf8');
  } catch (e) {
    console.error('[DB] Failed to save state:', e.message);
  }
}

function guildConfig(db, guildId) {
  if (!db.guilds[guildId]) {
    db.guilds[guildId] = {
      automod: { enabled: false, badWords: [], blockInvites: false, maxMentions: 0, maxEmojis: 0, capsPercent: 0, action: 'delete', timeoutSeconds: 300, exemptRoles: [], channels: [], processed: [] },
      welcome: { enabled: false, channelId: '', message: 'Welcome {user} to **{server}**! You are member #{membercount}.', useEmbed: true, embedColor: '#5865f2', dm: false, dmMessage: 'Welcome to {server}!', knownMembers: [], seeded: false },
      logging: { enabled: false, channelId: '', events: { moderation: true, giveaways: true, reactionRoles: true, automod: true, welcome: true, joins: true } },
      reactionRoles: [],
      giveaways: [],
      warnings: [],
      tempbans: [],
      audit: []
    };
  }
  return db.guilds[guildId];
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Rate-limited Discord REST client (serialised, 429-aware)
// ---------------------------------------------------------------------------
let lastRequest = 0;
let chain = Promise.resolve();
let botUserId = '';

function discordFetch(endpoint, options = {}) {
  const task = async () => {
    if (!BOT_TOKEN) throw new Error('Bot token missing — set DISCORD_BOT_TOKEN in .env');
    for (let attempt = 0; attempt < 5; attempt++) {
      const gap = 150 - (Date.now() - lastRequest);
      if (gap > 0) await sleep(gap);
      lastRequest = Date.now();
      let res;
      try {
        res = await fetch(`https://discord.com/api/v10${endpoint}`, {
          ...options,
          headers: {
            Authorization: `Bot ${BOT_TOKEN}`,
            'Content-Type': 'application/json',
            ...(options.headers || {})
          }
        });
      } catch (netErr) {
        if (attempt < 4) { await sleep(400); continue; }
        throw new Error('Network error reaching Discord: ' + netErr.message);
      }
      if (res.status === 429) {
        const d = await res.json().catch(() => ({}));
        await sleep(Math.ceil((d.retry_after || 1) * 1000) + 150);
        continue;
      }
      if (res.status === 204) return {};
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(data.message || `Discord HTTP ${res.status}`);
        err.status = res.status;
        err.code = data.code;
        throw err;
      }
      return data;
    }
    throw new Error('Discord rate limit: retries exhausted');
  };
  chain = chain.then(task, task);
  return chain;
}

async function getBotUserId() {
  if (botUserId) return botUserId;
  try {
    const me = await discordFetch('/users/@me');
    botUserId = me.id || '';
  } catch (e) {}
  return botUserId;
}

async function getReactionUsers(channelId, messageId, emoji) {
  const enc = encodeURIComponent(emoji);
  let users = [];
  let after = '';
  for (let page = 0; page < 10; page++) {
    const qs = `?limit=100${after ? `&after=${after}` : ''}`;
    const batch = await discordFetch(`/channels/${channelId}/messages/${messageId}/reactions/${enc}${qs}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    users = users.concat(batch);
    after = batch[batch.length - 1].id;
    if (batch.length < 100) break;
  }
  return users;
}

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------
function pushAudit(g, entry) {
  g.audit.unshift({ id: uid(), created_at: new Date().toISOString(), ...entry });
  if (g.audit.length > 250) g.audit.length = 250;
}

async function logEvent(guildId, type, title, description, color) {
  const db = loadDB();
  const g = guildConfig(db, guildId);
  pushAudit(g, { type, title, description });
  saveDB(db);
  const log = g.logging;
  if (!log.enabled || !log.channelId || !log.events[type]) return;
  try {
    await discordFetch(`/channels/${log.channelId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        embeds: [{
          title: title.slice(0, 256),
          description: (description || '').slice(0, 4000),
          color: color || 0x5865f2,
          footer: { text: 'Utility Bot • Logging' },
          timestamp: new Date().toISOString()
        }]
      })
    });
  } catch (e) {
    console.error(`[Logging] ${type} failed:`, e.message);
  }
}

const hexToInt = (hex) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  return m ? parseInt(m[1], 16) : 0x5865f2;
};

/* Every punishment DMs the member the reason. A ban DM also carries a
   "Request Unban" button whose interaction is handled by the applications
   worker, so the appeal keeps working even after the member leaves. */
async function dmPunished(guildId, userId, action, reason, serverName, withAppeal) {
  const labels = {
    timeout: ['⏳ You have been timed out', 'You can no longer speak until the timeout expires.'],
    kick: ['👢 You have been kicked', 'You can rejoin with a new invite if you follow the rules.'],
    ban: ['🚫 You have been banned', 'If you believe this was a mistake, use the button below to request an unban.'],
    unban: ['✅ You have been unbanned', 'Welcome back — please follow the rules this time.'],
    tempban: ['🚫 You have been temporarily banned', 'The ban expires automatically. If this was a mistake, use the button below.']
  };
  const [title, sub] = labels[action] || ['📢 Moderation notice', ''];
  const payload = {
    embeds: [{
      title,
      description: `**Server:** ${serverName || 'the server'}\n**Reason:** ${reason || 'No reason provided'}\n\n${sub}`,
      color: action === 'unban' ? 0x10b981 : 0xed4245,
      timestamp: new Date().toISOString()
    }]
  };
  if (withAppeal) {
    payload.components = [{ type: 1, components: [{ type: 2, style: 3, label: 'Request Unban', custom_id: `kyro-appeal:request:${guildId}:${userId}` }] }];
  }
  try {
    const dm = await discordFetch(`/users/${userId}/channels`, { method: 'POST', body: JSON.stringify({ recipient_id: userId }) });
    await discordFetch(`/channels/${dm.id}/messages`, { method: 'POST', body: JSON.stringify(payload) });
    return true;
  } catch (e) { return false; }
}

// ---------------------------------------------------------------------------
// Moderation
// ---------------------------------------------------------------------------
async function moderate(guildId, body) {
  const { action, userId, reason } = body;
  const duration = Number(body.duration) || 0;
  const reasonHeader = reason ? { 'X-Audit-Log-Reason': String(reason).slice(0, 400) } : {};
  const db = loadDB();
  const g = guildConfig(db, guildId);
  const moderator = body.moderator || 'Dashboard';

  const finish = async (message) => {
    pushAudit(g, { type: 'moderation', action, userId, reason, moderator });
    saveDB(db);
    await logEvent(guildId, 'moderation', `Moderation • ${action}`, `**User:** <@${userId}> (\`${userId}\`)\n**Moderator:** ${moderator}\n**Reason:** ${reason || 'No reason provided'}`, 0xed4245);
    return { ok: true, message };
  };

  if (action === 'timeout') {
    const seconds = duration || 3600;
    const until = new Date(Date.now() + seconds * 1000).toISOString();
    await discordFetch(`/guilds/${guildId}/members/${userId}`, { method: 'PATCH', headers: reasonHeader, body: JSON.stringify({ communication_disabled_until: until }) });
    await dmPunished(guildId, userId, 'timeout', reason, body.serverName);
    return finish(`Timed out <@${userId}> for ${Math.round(seconds / 60)} minutes.`);
  }
  if (action === 'untimeout') {
    await discordFetch(`/guilds/${guildId}/members/${userId}`, { method: 'PATCH', headers: reasonHeader, body: JSON.stringify({ communication_disabled_until: null }) });
    return finish(`Removed timeout for <@${userId}>.`);
  }
  if (action === 'ban') {
    await dmPunished(guildId, userId, 'ban', reason, body.serverName, { withAppeal: true }); // DM before the ban so the appeal button survives it
    await discordFetch(`/guilds/${guildId}/bans/${userId}`, { method: 'PUT', headers: reasonHeader, body: JSON.stringify({ delete_message_seconds: Number(body.deleteDays) || 0 }) });
    return finish(`Banned <@${userId}>. Their DM includes a Request Unban button.`);
  }
  if (action === 'tempban') {
    const seconds = duration || 3600;
    await dmPunished(guildId, userId, 'tempban', reason, body.serverName, { withAppeal: true });
    await discordFetch(`/guilds/${guildId}/bans/${userId}`, { method: 'PUT', headers: reasonHeader, body: JSON.stringify({ delete_message_seconds: 0 }) });
    g.tempbans = g.tempbans.filter((t) => t.userId !== userId);
    g.tempbans.push({ userId, unban_at: Date.now() + seconds * 1000 });
    saveDB(db);
    return finish(`Temp-banned <@${userId}> for ${Math.round(seconds / 60)} minutes.`);
  }
  if (action === 'unban') {
    await discordFetch(`/guilds/${guildId}/bans/${userId}`, { method: 'DELETE', headers: reasonHeader });
    g.tempbans = g.tempbans.filter((t) => t.userId !== userId);
    saveDB(db);
    await dmPunished(guildId, userId, 'unban', reason, body.serverName);
    return finish(`Unbanned <@${userId}>.`);
  }
  if (action === 'kick') {
    await dmPunished(guildId, userId, 'kick', reason, body.serverName);
    await discordFetch(`/guilds/${guildId}/members/${userId}`, { method: 'DELETE', headers: reasonHeader });
    return finish(`Kicked <@${userId}>.`);
  }
  if (action === 'warn') {
    if (!reason) throw new Error('A reason is required to warn a member.');
    g.warnings.unshift({ id: uid(), userId, moderator, reason, created_at: new Date().toISOString() });
    saveDB(db);
    if (body.dm !== false) {
      try {
        const dm = await discordFetch(`/users/${userId}/channels`, { method: 'POST', body: JSON.stringify({ recipient_id: userId }) });
        await discordFetch(`/channels/${dm.id}/messages`, { method: 'POST', body: JSON.stringify({ content: `You were warned in **${body.serverName || 'the server'}**: ${reason}` }) });
      } catch (e) {}
    }
    await logEvent(guildId, 'moderation', 'Moderation • warn', `**User:** <@${userId}>\n**Moderator:** ${moderator}\n**Reason:** ${reason}\n**Total warnings:** ${g.warnings.filter((w) => w.userId === userId).length}`, 0xfee75c);
    return { ok: true, message: `Warned <@${userId}>. Total warnings: ${g.warnings.filter((w) => w.userId === userId).length}.` };
  }
  if (action === 'purge') {
    const channelId = body.channelId;
    const amount = Math.min(Math.max(Number(body.amount) || 10, 1), 100);
    if (!channelId) throw new Error('A channel is required to purge messages.');
    const msgs = await discordFetch(`/channels/${channelId}/messages?limit=${amount}`);
    const ids = (Array.isArray(msgs) ? msgs : []).map((m) => m.id);
    if (ids.length === 0) return { ok: true, message: 'No messages to purge.' };
    if (ids.length === 1) {
      await discordFetch(`/channels/${channelId}/messages/${ids[0]}`, { method: 'DELETE', headers: reasonHeader });
    } else {
      await discordFetch(`/channels/${channelId}/messages/bulk-delete`, { method: 'POST', headers: reasonHeader, body: JSON.stringify({ messages: ids }) });
    }
    pushAudit(g, { type: 'moderation', action: 'purge', channelId, count: ids.length, moderator });
    saveDB(db);
    await logEvent(guildId, 'moderation', 'Moderation • purge', `**Channel:** <#${channelId}>\n**Messages deleted:** ${ids.length}\n**Moderator:** ${moderator}`, 0xfee75c);
    return { ok: true, message: `Purged ${ids.length} messages.` };
  }
  if (action === 'slowmode') {
    const channelId = body.channelId;
    const seconds = Math.min(Math.max(Number(body.seconds) || 0, 0), 21600);
    if (!channelId) throw new Error('A channel is required to set slowmode.');
    await discordFetch(`/channels/${channelId}`, { method: 'PATCH', headers: reasonHeader, body: JSON.stringify({ rate_limit_per_user: seconds }) });
    return finish(`Slowmode set to ${seconds}s in <#${channelId}>.`);
  }
  if (action === 'lock' || action === 'unlock') {
    const channelId = body.channelId;
    if (!channelId) throw new Error('A channel is required.');
    const channel = await discordFetch(`/channels/${channelId}`);
    const overwrites = Array.isArray(channel.permission_overwrites) ? channel.permission_overwrites.slice() : [];
    const everyoneId = guildId; // @everyone role id equals the guild id
    const idx = overwrites.findIndex((o) => o.id === everyoneId);
    const SEND = 1n << 11n;
    let deny = BigInt(idx >= 0 ? (overwrites[idx].deny || '0') : '0');
    if (action === 'lock') deny |= SEND; else deny &= ~SEND;
    const entry = { id: everyoneId, type: 0, allow: String(idx >= 0 ? (overwrites[idx].allow || '0') : '0'), deny: deny.toString() };
    if (idx >= 0) overwrites[idx] = entry; else overwrites.push(entry);
    await discordFetch(`/channels/${channelId}`, { method: 'PATCH', headers: reasonHeader, body: JSON.stringify({ permission_overwrites: overwrites }) });
    return finish(`${action === 'lock' ? 'Locked' : 'Unlocked'} <#${channelId}>.`);
  }
  if (action === 'addrole' || action === 'removerole') {
    const roleId = body.roleId;
    if (!roleId || !userId) throw new Error('User and role are required.');
    await discordFetch(`/guilds/${guildId}/members/${userId}/roles/${roleId}`, { method: action === 'addrole' ? 'PUT' : 'DELETE', headers: reasonHeader });
    return finish(`${action === 'addrole' ? 'Added' : 'Removed'} role <@&${roleId}> ${action === 'addrole' ? 'to' : 'from'} <@${userId}>.`);
  }
  throw new Error('Invalid moderation action.');
}

// ---------------------------------------------------------------------------
// Giveaways
// ---------------------------------------------------------------------------
function giveawayEmbed(gv, ended, winnerIds) {
  const endsUnix = Math.floor(gv.ends_at / 1000);
  const desc = [
    gv.description || '',
    '',
    `**Winners:** ${gv.winners}`,
    ended
      ? (winnerIds && winnerIds.length ? `**Winner(s):** ${winnerIds.map((id) => `<@${id}>`).join(', ')}` : '**No valid entries.**')
      : `**Ends:** <t:${endsUnix}:R> (<t:${endsUnix}:f>)`,
    '',
    ended ? 'This giveaway has ended.' : 'React with 🎉 to enter!'
  ].filter((x) => x !== null).join('\n');
  return {
    title: `🎉 ${gv.prize}`.slice(0, 256),
    description: desc.slice(0, 4000),
    color: ended ? 0x95a5a6 : 0x57f287,
    footer: { text: `${gv.entrants ? gv.entrants.length : 0} entries • Utility Bot Giveaways` },
    timestamp: new Date(gv.ends_at).toISOString()
  };
}

async function createGiveaway(guildId, body) {
  const prize = String(body.prize || '').trim();
  const channelId = body.channelId;
  const winners = Math.min(Math.max(Number(body.winners) || 1, 1), 20);
  const minutes = Math.min(Math.max(Number(body.minutes) || 60, 1), 60 * 24 * 30);
  if (!prize) throw new Error('A prize is required.');
  if (!channelId) throw new Error('A channel is required.');
  const gv = {
    id: uid(), channel: channelId, message_id: '', prize,
    description: String(body.description || '').trim().slice(0, 1000),
    winners, ends_at: Date.now() + minutes * 60000, ended: false,
    entrants: [], winnerIds: [], created_at: new Date().toISOString()
  };
  const msg = await discordFetch(`/channels/${channelId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: '🎉 **GIVEAWAY** 🎉', embeds: [giveawayEmbed(gv, false)] })
  });
  gv.message_id = msg.id;
  try { await discordFetch(`/channels/${channelId}/messages/${msg.id}/reactions/${encodeURIComponent('🎉')}/@me`, { method: 'PUT' }); } catch (e) {}
  const db = loadDB();
  const g = guildConfig(db, guildId);
  g.giveaways.unshift(gv);
  saveDB(db);
  await logEvent(guildId, 'giveaways', 'Giveaway created', `**Prize:** ${prize}\n**Channel:** <#${channelId}>\n**Winners:** ${winners}\n**Ends:** <t:${Math.floor(gv.ends_at / 1000)}:R>`, 0x57f287);
  return gv;
}

function pickWinners(entrants, count) {
  const pool = entrants.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.min(count, pool.length));
}

async function finishGiveaway(guildId, gv, reroll) {
  const botId = await getBotUserId();
  try {
    const users = await getReactionUsers(gv.channel, gv.message_id, '🎉');
    gv.entrants = users.filter((u) => u.id !== botId).map((u) => u.id);
  } catch (e) {}
  const winners = pickWinners(gv.entrants, gv.winners);
  gv.winnerIds = winners;
  gv.ended = true;
  try {
    await discordFetch(`/channels/${gv.channel}/messages/${gv.message_id}`, { method: 'PATCH', body: JSON.stringify({ embeds: [giveawayEmbed(gv, true, winners)] }) });
  } catch (e) {}
  const content = winners.length
    ? `🎉 ${reroll ? 'New winner(s)' : 'Congratulations'} ${winners.map((id) => `<@${id}>`).join(', ')}! You won **${gv.prize}**!"`
    : `The giveaway for **${gv.prize}** ended with no valid entries.`;
  try {
    await discordFetch(`/channels/${gv.channel}/messages`, { method: 'POST', body: JSON.stringify({ content: content.slice(0, 2000), allowed_mentions: { parse: ['users'] } }) });
  } catch (e) {}
  const db = loadDB();
  saveDB(db);
  await logEvent(guildId, 'giveaways', reroll ? 'Giveaway rerolled' : 'Giveaway ended', `**Prize:** ${gv.prize}\n**Entries:** ${gv.entrants.length}\n**Winner(s):** ${winners.length ? winners.map((id) => `<@${id}>`).join(', ') : 'none'}`, 0x57f287);
  return gv;
}

// ---------------------------------------------------------------------------
// Reaction roles
// ---------------------------------------------------------------------------
async function createReactionRole(guildId, body) {
  const channelId = body.channelId;
  const mappings = Array.isArray(body.mappings) ? body.mappings.filter((m) => m.emoji && m.roleId) : [];
  if (!channelId) throw new Error('A channel is required.');
  if (mappings.length === 0) throw new Error('At least one emoji → role mapping is required.');
  const mode = body.mode === 'unique' ? 'unique' : 'normal';
  const title = String(body.title || 'Reaction Roles').trim().slice(0, 256);
  const description = String(body.description || mappings.map((m) => `${m.emoji} → <@&${m.roleId}>`).join('\n')).trim().slice(0, 4000);
  const msg = await discordFetch(`/channels/${channelId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ embeds: [{ title, description, color: hexToInt(body.color), footer: { text: 'React to claim your roles • Utility Bot' } }] })
  });
  for (const m of mappings) {
    try { await discordFetch(`/channels/${channelId}/messages/${msg.id}/reactions/${encodeURIComponent(m.emoji)}/@me`, { method: 'PUT' }); } catch (e) {}
  }
  const rr = { id: uid(), channel: channelId, message_id: msg.id, mode, title, mappings, state: {}, created_at: new Date().toISOString() };
  const db = loadDB();
  const g = guildConfig(db, guildId);
  g.reactionRoles.unshift(rr);
  saveDB(db);
  await logEvent(guildId, 'reactionRoles', 'Reaction roles created', `**Channel:** <#${channelId}>\n**Mappings:** ${mappings.length}\n**Mode:** ${mode}`, 0x5865f2);
  return rr;
}

async function syncReactionRole(guildId, rr) {
  const botId = await getBotUserId();
  const current = {};
  for (const m of rr.mappings) {
    let users = [];
    try { users = await getReactionUsers(rr.channel, rr.message_id, m.emoji); } catch (e) { continue; }
    for (const u of users) {
      if (u.id === botId) continue;
      (current[u.id] = current[u.id] || []).push(m.emoji);
    }
  }
  const prev = rr.state || {};
  const allUsers = new Set([...Object.keys(current), ...Object.keys(prev)]);
  const roleIds = rr.mappings.map((m) => m.roleId);
  for (const userId of allUsers) {
    const nowEmojis = current[userId] || [];
    const prevEmojis = prev[userId] || [];
    for (const emoji of nowEmojis) {
      if (prevEmojis.includes(emoji)) continue;
      const mapping = rr.mappings.find((m) => m.emoji === emoji);
      if (!mapping) continue;
      if (rr.mode === 'unique') {
        for (const rid of roleIds) {
          if (rid === mapping.roleId) continue;
          try { await discordFetch(`/guilds/${guildId}/members/${userId}/roles/${rid}`, { method: 'DELETE', headers: { 'X-Audit-Log-Reason': 'Reaction roles (unique)' } }); } catch (e) {}
        }
      }
      try { await discordFetch(`/guilds/${guildId}/members/${userId}/roles/${mapping.roleId}`, { method: 'PUT', headers: { 'X-Audit-Log-Reason': 'Reaction roles' } }); } catch (e) {}
    }
    for (const emoji of prevEmojis) {
      if (nowEmojis.includes(emoji)) continue;
      const mapping = rr.mappings.find((m) => m.emoji === emoji);
      if (!mapping) continue;
      try { await discordFetch(`/guilds/${guildId}/members/${userId}/roles/${mapping.roleId}`, { method: 'DELETE', headers: { 'X-Audit-Log-Reason': 'Reaction roles' } }); } catch (e) {}
    }
  }
  rr.state = current;
}

// ---------------------------------------------------------------------------
// AutoMod
// ---------------------------------------------------------------------------
const INVITE_RE = /(discord\.gg\/|discord\.com\/invite\/|discordapp\.com\/invite\/)/i;
const EMOJI_RE = /<a?:\w+:\d+>|[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;
/* Classic nitro-steam-robux scams and fake-gift spoofs get caught even without
   the invite filter, and the repeat-offender ban escalates them. */
const SCAM_RE = /free\s*(nitro|robux|vbucks|skins|gift)|steamcommun[il1]ty|discor[d|l]s?-?(gift|nitro|app)\b|nitro\s*(giveaway|gift)|\.gift\/\S+/i;

function checkAutomod(msg, am) {
  const content = String(msg.content || '');
  const lower = content.toLowerCase();
  if (SCAM_RE.test(lower)) return 'scam / phishing message';
  if (am.badWords && am.badWords.length) {
    for (const w of am.badWords) {
      if (w && lower.includes(String(w).toLowerCase())) return `blocked word "${w}"`;
    }
  }
  if (am.blockInvites && INVITE_RE.test(content)) return 'invite link';
  if (am.maxMentions > 0) {
    const mentions = (msg.mentions ? msg.mentions.length : 0) + (msg.mention_roles ? msg.mention_roles.length : 0);
    if (mentions > am.maxMentions) return `mention spam (${mentions})`;
  }
  if (am.maxEmojis > 0) {
    const count = (content.match(EMOJI_RE) || []).length;
    if (count > am.maxEmojis) return `emoji spam (${count})`;
  }
  if (am.capsPercent > 0 && content.length >= 8) {
    const letters = content.replace(/[^a-zA-Z]/g, '');
    if (letters.length >= 8) {
      const upper = letters.replace(/[^A-Z]/g, '').length;
      if ((upper / letters.length) * 100 >= am.capsPercent) return 'excessive caps';
    }
  }
  return null;
}

async function runAutomodGuild(guildId, g) {
  const am = g.automod;
  if (!am.enabled || !am.channels || am.channels.length === 0) return;
  am.processed = am.processed || [];
  const processed = new Set(am.processed);
  const botId = await getBotUserId();
  for (const channelId of am.channels) {
    let msgs = [];
    try { msgs = await discordFetch(`/channels/${channelId}/messages?limit=15`); } catch (e) { continue; }
    if (!Array.isArray(msgs)) continue;
    for (const msg of msgs) {
      if (!msg.id || processed.has(msg.id)) continue;
      processed.add(msg.id);
      if (msg.author && (msg.author.bot || msg.author.id === botId)) continue;
      const memberRoles = (msg.member && msg.member.roles) || [];
      if (am.exemptRoles && am.exemptRoles.some((r) => memberRoles.includes(r))) continue;
      const violation = checkAutomod(msg, am);
      if (!violation) continue;
      try { await discordFetch(`/channels/${channelId}/messages/${msg.id}`, { method: 'DELETE', headers: { 'X-Audit-Log-Reason': 'AutoMod: ' + violation } }); } catch (e) {}
      // Repeat offenders (3 violations in 10 minutes) get banned — spammers,
      // hackers and spoofers don't get to ride timeouts forever.
      const now = Date.now();
      am.hits = am.hits || {};
      const hits = (am.hits[msg.author.id] || []).filter(ts => now - ts < 10 * 60 * 1000);
      hits.push(now);
      am.hits[msg.author.id] = hits;
      const escalate = hits.length >= 3;
      if (msg.author && (am.action === 'ban' || escalate)) {
        try {
          await dmPunished(guildId, msg.author.id, 'ban', `AutoMod: ${violation}${escalate ? ' (repeated violations)' : ''}`, g.serverName, { withAppeal: true });
        } catch (e) {}
        try {
          await discordFetch(`/guilds/${guildId}/bans/${msg.author.id}`, {
            method: 'PUT',
            headers: { 'X-Audit-Log-Reason': 'AutoMod: ' + violation },
            body: JSON.stringify({ delete_message_seconds: 86400 })
          });
        } catch (e) {}
        am.hits[msg.author.id] = [];
        await logEvent(guildId, 'automod', 'AutoMod banned a member', `**User:** <@${msg.author.id}>\n**Violations:** ${hits.length} in 10 minutes\n**Latest:** ${violation}\nTheir DM includes an unban-request button.`, 0x7f1d1d);
        continue;
      }
      if (am.action === 'timeout' && msg.author) {
        const until = new Date(Date.now() + (Number(am.timeoutSeconds) || 300) * 1000).toISOString();
        try { await discordFetch(`/guilds/${guildId}/members/${msg.author.id}`, { method: 'PATCH', headers: { 'X-Audit-Log-Reason': 'AutoMod: ' + violation }, body: JSON.stringify({ communication_disabled_until: until }) }); } catch (e) {}
        try { await dmPunished(guildId, msg.author.id, 'timeout', `AutoMod: ${violation}`, g.serverName); } catch (e) {}
      }
      await logEvent(guildId, 'automod', 'AutoMod action', `**User:** <@${msg.author ? msg.author.id : '?'}>\n**Channel:** <#${channelId}>\n**Violation:** ${violation}\n**Action:** ${am.action}\n**Strikes (10 min):** ${hits.length}/3`, 0xed4245);
    }
  }
  am.processed = [...processed].slice(-500);
}

// ---------------------------------------------------------------------------
// Welcome
// ---------------------------------------------------------------------------
function formatWelcome(template, member, guildName, memberCount) {
  const user = member && member.user ? member.user : { id: '0', username: 'new member' };
  return String(template || '')
    .replace(/\{user\}/g, `<@${user.id}>`)
    .replace(/\{username\}/g, user.username || 'member')
    .replace(/\{mention\}/g, `<@${user.id}>`)
    .replace(/\{server\}/g, guildName || 'the server')
    .replace(/\{membercount\}/g, String(memberCount || 0));
}

async function sendWelcome(guildId, w, member, guildName, memberCount) {
  const text = formatWelcome(w.message, member, guildName, memberCount);
  if (w.channelId) {
    const payload = w.useEmbed
      ? { embeds: [{ description: text.slice(0, 4000), color: hexToInt(w.embedColor), footer: { text: `Member #${memberCount || '?'}` }, timestamp: new Date().toISOString() }] }
      : { content: text.slice(0, 2000) };
    try { await discordFetch(`/channels/${w.channelId}/messages`, { method: 'POST', body: JSON.stringify(payload) }); } catch (e) {}
  }
  if (w.dm && member && member.user) {
    try {
      const dm = await discordFetch(`/users/${member.user.id}/channels`, { method: 'POST', body: JSON.stringify({ recipient_id: member.user.id }) });
      await discordFetch(`/channels/${dm.id}/messages`, { method: 'POST', body: JSON.stringify({ content: formatWelcome(w.dmMessage, member, guildName, memberCount).slice(0, 2000) }) });
    } catch (e) {}
  }
}

async function runWelcomeGuild(guildId, g) {
  const w = g.welcome;
  if (!w.enabled || !w.channelId) return;
  let guild, members;
  try {
    guild = await discordFetch(`/guilds/${guildId}?with_counts=true`);
    members = await discordFetch(`/guilds/${guildId}/members?limit=1000`);
  } catch (e) {
    // Requires the privileged Server Members intent; degrade quietly if absent.
    return;
  }
  if (!Array.isArray(members)) return;
  const botId = await getBotUserId();
  const ids = members.filter((m) => m.user && m.user.id !== botId).map((m) => m.user.id);
  if (!w.seeded) {
    w.knownMembers = ids;
    w.seeded = true;
    return;
  }
  const known = new Set(w.knownMembers || []);
  const fresh = ids.filter((id) => !known.has(id));
  for (const userId of fresh) {
    const member = members.find((m) => m.user && m.user.id === userId);
    await sendWelcome(guildId, w, member, guild.name, guild.approximate_member_count || ids.length);
    await logEvent(guildId, 'joins', 'Member joined', `**User:** <@${userId}> (${member && member.user ? member.user.username : userId})\n**Member count:** ${guild.approximate_member_count || ids.length}`, 0x57f287);
  }
  w.knownMembers = ids;
}

// ---------------------------------------------------------------------------
// Background poller
// ---------------------------------------------------------------------------
const lastRun = { giveaways: 0, reactionRoles: 0, automod: 0, welcome: 0, tempbans: 0 };
let polling = false;

async function pollTick() {
  if (polling || !BOT_TOKEN) return;
  polling = true;
  try {
    const now = Date.now();
    const db = loadDB();
    let changed = false;
    const guildIds = Object.keys(db.guilds);

    if (now - lastRun.tempbans > 15000) {
      lastRun.tempbans = now;
      for (const guildId of guildIds) {
        const g = guildConfig(db, guildId);
        const due = (g.tempbans || []).filter((t) => t.unban_at <= now);
        for (const t of due) {
          try { await discordFetch(`/guilds/${guildId}/bans/${t.userId}`, { method: 'DELETE', headers: { 'X-Audit-Log-Reason': 'Temp-ban expired' } }); } catch (e) {}
          await logEvent(guildId, 'moderation', 'Temp-ban expired', `**User:** <@${t.userId}>`, 0x95a5a6);
        }
        if (due.length) { g.tempbans = (g.tempbans || []).filter((t) => t.unban_at > now); changed = true; }
      }
    }

    if (now - lastRun.giveaways > 20000) {
      lastRun.giveaways = now;
      for (const guildId of guildIds) {
        const g = guildConfig(db, guildId);
        for (const gv of g.giveaways || []) {
          if (gv.ended) continue;
          try {
            const botId = await getBotUserId();
            const users = await getReactionUsers(gv.channel, gv.message_id, '🎉');
            gv.entrants = users.filter((u) => u.id !== botId).map((u) => u.id);
            changed = true;
            if (now >= gv.ends_at) { await finishGiveaway(guildId, gv, false); changed = true; }
            else {
              try { await discordFetch(`/channels/${gv.channel}/messages/${gv.message_id}`, { method: 'PATCH', body: JSON.stringify({ embeds: [giveawayEmbed(gv, false)] }) }); } catch (e) {}
            }
          } catch (e) {}
        }
      }
    }

    if (now - lastRun.reactionRoles > 15000) {
      lastRun.reactionRoles = now;
      for (const guildId of guildIds) {
        const g = guildConfig(db, guildId);
        for (const rr of g.reactionRoles || []) {
          try { await syncReactionRole(guildId, rr); changed = true; } catch (e) {}
        }
      }
    }

    if (now - lastRun.automod > 10000) {
      lastRun.automod = now;
      for (const guildId of guildIds) {
        const g = guildConfig(db, guildId);
        try { await runAutomodGuild(guildId, g); changed = true; } catch (e) {}
      }
    }

    if (now - lastRun.welcome > 30000) {
      lastRun.welcome = now;
      for (const guildId of guildIds) {
        const g = guildConfig(db, guildId);
        try { await runWelcomeGuild(guildId, g); changed = true; } catch (e) {}
      }
    }

    if (changed) saveDB(db);
  } catch (e) {
    console.error('[Poller] tick error:', e.message);
  } finally {
    polling = false;
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) { reject(new Error('Payload too large')); req.destroy(); return; }
      body += chunk;
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function sendJSON(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function openLocalDashboard() {
  const url = `http://localhost:${PORT}`;
  const startCmd = process.platform === 'win32' ? `start ${url}` : process.platform === 'darwin' ? `open ${url}` : `xdg-open ${url}`;
  exec(startCmd, (err) => { if (err) console.error('Failed to auto-open browser:', err.message); });
}

const server = http.createServer(async (req, res) => {
  // Loopback admin tool: reject any Host that isn't localhost (DNS-rebinding guard).
  const host = (req.headers.host || '').toLowerCase();
  if (host !== `localhost:${PORT}` && host !== `127.0.0.1:${PORT}` && host !== `[::1]:${PORT}`) {
    return sendJSON(res, 403, { error: 'Forbidden host.' });
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  const guildId = url.searchParams.get('guild') || '';

  try {
    if (req.method === 'GET' && p === '/') {
      const html = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }

    if (req.method === 'GET' && p === '/api/status') {
      return sendJSON(res, 200, { ok: true, tokenLoaded: Boolean(BOT_TOKEN), ownerId: OWNER_ID, poller: !process.env.DASHBOARD_DISABLE_POLLER, installUrl: BOT_INSTALL_URL });
    }

    if (req.method === 'POST' && p === '/api/launch') {
      openLocalDashboard();
      return sendJSON(res, 200, { ok: true });
    }

    // Multi-server selector
    if (req.method === 'GET' && p === '/api/guilds') {
      const guilds = await discordFetch('/users/@me/guilds?with_counts=true');
      const list = (Array.isArray(guilds) ? guilds : []).map((g) => ({
        id: g.id, name: g.name, icon: g.icon, owner: g.owner,
        member_count: g.approximate_member_count || null,
        permissions: g.permissions
      }));
      return sendJSON(res, 200, { guilds: list });
    }

    if (req.method === 'GET' && p === '/api/guild') {
      if (!guildId) return sendJSON(res, 400, { error: 'guild is required' });
      const [guild, channels, roles] = await Promise.all([
        discordFetch(`/guilds/${guildId}?with_counts=true`),
        discordFetch(`/guilds/${guildId}/channels`),
        discordFetch(`/guilds/${guildId}/roles`)
      ]);
      return sendJSON(res, 200, {
        guild: {
          id: guild.id, name: guild.name, icon: guild.icon, owner_id: guild.owner_id,
          member_count: guild.approximate_member_count || null,
          presence_count: guild.approximate_presence_count || null,
          verification_level: guild.verification_level, premium_tier: guild.premium_tier
        },
        channels: (Array.isArray(channels) ? channels : []).map((c) => ({ id: c.id, name: c.name, type: c.type, parent_id: c.parent_id })).sort((a, b) => (a.position || 0) - (b.position || 0)),
        roles: (Array.isArray(roles) ? roles : []).map((r) => ({ id: r.id, name: r.name, color: r.color, managed: r.managed, position: r.position })).sort((a, b) => b.position - a.position)
      });
    }

    if (req.method === 'GET' && p === '/api/config') {
      if (!guildId) return sendJSON(res, 400, { error: 'guild is required' });
      const db = loadDB();
      const g = guildConfig(db, guildId);
      saveDB(db);
      return sendJSON(res, 200, {
        automod: g.automod, welcome: g.welcome, logging: g.logging,
        reactionRoles: g.reactionRoles, giveaways: g.giveaways,
        warnings: g.warnings, audit: g.audit, tempbans: g.tempbans
      });
    }

    if (req.method === 'POST' && p === '/api/moderate') {
      const body = await readBody(req);
      const gid = body.guild || guildId;
      if (!gid) return sendJSON(res, 400, { error: 'guild is required' });
      if (!body.userId && !['purge', 'slowmode', 'lock', 'unlock'].includes(body.action)) return sendJSON(res, 400, { error: 'userId is required' });
      const out = await moderate(gid, body);
      return sendJSON(res, 200, out);
    }

    if (req.method === 'POST' && p === '/api/giveaway/create') {
      const body = await readBody(req);
      const gid = body.guild || guildId;
      if (!gid) return sendJSON(res, 400, { error: 'guild is required' });
      const gv = await createGiveaway(gid, body);
      return sendJSON(res, 200, { ok: true, giveaway: gv });
    }
    if (req.method === 'POST' && p === '/api/giveaway/end') {
      const body = await readBody(req);
      const gid = body.guild || guildId;
      const db = loadDB();
      const g = guildConfig(db, gid);
      const gv = g.giveaways.find((x) => x.id === body.id);
      if (!gv) return sendJSON(res, 404, { error: 'Giveaway not found' });
      await finishGiveaway(gid, gv, false);
      saveDB(db);
      return sendJSON(res, 200, { ok: true, giveaway: gv });
    }
    if (req.method === 'POST' && p === '/api/giveaway/reroll') {
      const body = await readBody(req);
      const gid = body.guild || guildId;
      const db = loadDB();
      const g = guildConfig(db, gid);
      const gv = g.giveaways.find((x) => x.id === body.id);
      if (!gv) return sendJSON(res, 404, { error: 'Giveaway not found' });
      await finishGiveaway(gid, gv, true);
      saveDB(db);
      return sendJSON(res, 200, { ok: true, giveaway: gv });
    }
    if (req.method === 'POST' && p === '/api/giveaway/delete') {
      const body = await readBody(req);
      const gid = body.guild || guildId;
      const db = loadDB();
      const g = guildConfig(db, gid);
      const gv = g.giveaways.find((x) => x.id === body.id);
      if (gv) { try { await discordFetch(`/channels/${gv.channel}/messages/${gv.message_id}`, { method: 'DELETE' }); } catch (e) {} }
      g.giveaways = g.giveaways.filter((x) => x.id !== body.id);
      saveDB(db);
      return sendJSON(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/reactionroles/create') {
      const body = await readBody(req);
      const gid = body.guild || guildId;
      if (!gid) return sendJSON(res, 400, { error: 'guild is required' });
      const rr = await createReactionRole(gid, body);
      return sendJSON(res, 200, { ok: true, reactionRole: rr });
    }
    if (req.method === 'POST' && p === '/api/reactionroles/delete') {
      const body = await readBody(req);
      const gid = body.guild || guildId;
      const db = loadDB();
      const g = guildConfig(db, gid);
      const rr = g.reactionRoles.find((x) => x.id === body.id);
      if (rr) { try { await discordFetch(`/channels/${rr.channel}/messages/${rr.message_id}`, { method: 'DELETE' }); } catch (e) {} }
      g.reactionRoles = g.reactionRoles.filter((x) => x.id !== body.id);
      saveDB(db);
      return sendJSON(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/automod') {
      const body = await readBody(req);
      const gid = body.guild || guildId;
      if (!gid) return sendJSON(res, 400, { error: 'guild is required' });
      const db = loadDB();
      const g = guildConfig(db, gid);
      g.automod = {
        enabled: Boolean(body.enabled),
        badWords: Array.isArray(body.badWords) ? body.badWords.map((w) => String(w).trim()).filter(Boolean).slice(0, 100) : [],
        blockInvites: Boolean(body.blockInvites),
        maxMentions: Number(body.maxMentions) || 0,
        maxEmojis: Number(body.maxEmojis) || 0,
        capsPercent: Number(body.capsPercent) || 0,
        action: body.action === 'timeout' ? 'timeout' : 'delete',
        timeoutSeconds: Number(body.timeoutSeconds) || 300,
        exemptRoles: Array.isArray(body.exemptRoles) ? body.exemptRoles : [],
        channels: Array.isArray(body.channels) ? body.channels : [],
        processed: g.automod.processed || []
      };
      saveDB(db);
      return sendJSON(res, 200, { ok: true, automod: g.automod });
    }

    if (req.method === 'POST' && p === '/api/welcome') {
      const body = await readBody(req);
      const gid = body.guild || guildId;
      if (!gid) return sendJSON(res, 400, { error: 'guild is required' });
      const db = loadDB();
      const g = guildConfig(db, gid);
      g.welcome = {
        ...g.welcome,
        enabled: Boolean(body.enabled),
        channelId: String(body.channelId || ''),
        message: String(body.message || '').slice(0, 1500),
        useEmbed: Boolean(body.useEmbed),
        embedColor: String(body.embedColor || '#5865f2'),
        dm: Boolean(body.dm),
        dmMessage: String(body.dmMessage || '').slice(0, 1500)
      };
      saveDB(db);
      return sendJSON(res, 200, { ok: true, welcome: g.welcome });
    }
    if (req.method === 'POST' && p === '/api/welcome/test') {
      const body = await readBody(req);
      const gid = body.guild || guildId;
      const db = loadDB();
      const g = guildConfig(db, gid);
      let guild = { name: 'the server' };
      try { guild = await discordFetch(`/guilds/${gid}?with_counts=true`); } catch (e) {}
      const member = { user: { id: OWNER_ID, username: body.username || 'Test Member' } };
      await sendWelcome(gid, g.welcome, member, guild.name, guild.approximate_member_count || 1);
      return sendJSON(res, 200, { ok: true, message: 'Test welcome sent.' });
    }

    if (req.method === 'POST' && p === '/api/logging') {
      const body = await readBody(req);
      const gid = body.guild || guildId;
      if (!gid) return sendJSON(res, 400, { error: 'guild is required' });
      const db = loadDB();
      const g = guildConfig(db, gid);
      g.logging = {
        enabled: Boolean(body.enabled),
        channelId: String(body.channelId || ''),
        events: {
          moderation: body.events ? Boolean(body.events.moderation) : true,
          giveaways: body.events ? Boolean(body.events.giveaways) : true,
          reactionRoles: body.events ? Boolean(body.events.reactionRoles) : true,
          automod: body.events ? Boolean(body.events.automod) : true,
          welcome: body.events ? Boolean(body.events.welcome) : true,
          joins: body.events ? Boolean(body.events.joins) : true
        }
      };
      saveDB(db);
      return sendJSON(res, 200, { ok: true, logging: g.logging });
    }

    if (req.method === 'GET' && p === '/api/userinfo') {
      const userId = url.searchParams.get('user') || '';
      if (!guildId || !userId) return sendJSON(res, 400, { error: 'guild and user are required' });
      const user = await discordFetch(`/users/${userId}`);
      let member = null;
      try { member = await discordFetch(`/guilds/${guildId}/members/${userId}`); } catch (e) {}
      return sendJSON(res, 200, {
        user: { id: user.id, username: user.username, global_name: user.global_name, avatar: user.avatar, discriminator: user.discriminator, bot: user.bot, created_at: user.id ? new Date(Number((BigInt(user.id) >> 22n) + 1420070400000n)).toISOString() : null },
        member: member ? { nick: member.nick, roles: member.roles, joined_at: member.joined_at, premium_since: member.premium_since, communication_disabled_until: member.communication_disabled_until } : null
      });
    }

    if (req.method === 'GET' && p === '/api/members') {
      if (!guildId) return sendJSON(res, 400, { error: 'guild is required' });
      const q = url.searchParams.get('q') || '';
      let members = [];
      try {
        members = q
          ? await discordFetch(`/guilds/${guildId}/members/search?query=${encodeURIComponent(q)}&limit=25`)
          : await discordFetch(`/guilds/${guildId}/members?limit=50`);
      } catch (e) { return sendJSON(res, 200, { members: [], note: 'Server Members intent may be required.' }); }
      return sendJSON(res, 200, {
        members: (Array.isArray(members) ? members : []).map((m) => ({ id: m.user.id, username: m.user.username, global_name: m.user.global_name, avatar: m.user.avatar, nick: m.nick, bot: m.user.bot, roles: m.roles }))
      });
    }

    if (req.method === 'GET' && p === '/api/warnings') {
      if (!guildId) return sendJSON(res, 400, { error: 'guild is required' });
      const db = loadDB();
      const g = guildConfig(db, guildId);
      const userId = url.searchParams.get('user') || '';
      const list = userId ? g.warnings.filter((w) => w.userId === userId) : g.warnings;
      return sendJSON(res, 200, { warnings: list });
    }
    if (req.method === 'POST' && p === '/api/warnings/clear') {
      const body = await readBody(req);
      const gid = body.guild || guildId;
      const db = loadDB();
      const g = guildConfig(db, gid);
      g.warnings = body.userId ? g.warnings.filter((w) => w.userId !== body.userId) : [];
      saveDB(db);
      return sendJSON(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/embed') {
      const body = await readBody(req);
      const gid = body.guild || guildId;
      const channelId = body.channelId;
      if (!gid || !channelId) return sendJSON(res, 400, { error: 'guild and channelId are required' });
      const embed = {
        title: String(body.title || '').slice(0, 256) || undefined,
        description: String(body.description || '').slice(0, 4000) || undefined,
        color: hexToInt(body.color),
        url: /^https?:\/\//.test(body.url || '') ? body.url : undefined,
        author: body.author ? { name: String(body.author).slice(0, 256), icon_url: /^https?:\/\//.test(body.authorIcon || '') ? body.authorIcon : undefined } : undefined,
        footer: body.footer ? { text: String(body.footer).slice(0, 2048), icon_url: /^https?:\/\//.test(body.footerIcon || '') ? body.footerIcon : undefined } : undefined,
        image: /^https?:\/\//.test(body.image || '') ? { url: body.image } : undefined,
        thumbnail: /^https?:\/\//.test(body.thumbnail || '') ? { url: body.thumbnail } : undefined,
        timestamp: body.timestamp ? new Date().toISOString() : undefined
      };
      if (Array.isArray(body.fields)) {
        embed.fields = body.fields.filter((f) => f && f.name && f.value).slice(0, 25).map((f) => ({ name: String(f.name).slice(0, 256), value: String(f.value).slice(0, 1024), inline: Boolean(f.inline) }));
      }
      if (!embed.title && !embed.description) return sendJSON(res, 400, { error: 'An embed title or description is required.' });
      const msg = await discordFetch(`/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: String(body.content || '').slice(0, 2000) || undefined, embeds: [embed] })
      });
      await logEvent(gid, 'moderation', 'Embed sent', `**Channel:** <#${channelId}>\n**Title:** ${embed.title || '(no title)'}`, 0x5865f2);
      return sendJSON(res, 200, { ok: true, message_id: msg.id });
    }

    return sendJSON(res, 404, { error: 'Not found' });
  } catch (err) {
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    return sendJSON(res, status, { error: err.message || 'Server error' });
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[Dashboard] Port ${PORT} is already in use. Open http://localhost:${PORT}`);
  } else {
    console.error('[Dashboard] Server error:', err.message);
  }
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('=======================================================');
  console.log('  Kyro Staff Bot — Multi-Server Command Center');
  console.log(`  http://localhost:${PORT}`);
  console.log(`  Bot token: ${BOT_TOKEN ? 'loaded' : 'MISSING — set DISCORD_BOT_TOKEN in .env'}`);
  console.log('  Features: moderation, giveaways, reaction roles,');
  console.log('            automod, welcome, logging, utility, embeds');
  console.log('=======================================================');
  if (!process.env.DASHBOARD_DISABLE_POLLER) {
    setInterval(pollTick, 5000);
    console.log('  Background poller active (giveaways / roles / automod / welcome).');
  }
  // /start-kyro runs on Cloudflare, so it can never open a browser on this
  // machine — opening on boot is what makes the dashboard actually appear.
  if (!process.env.DASHBOARD_DISABLE_OPEN) openLocalDashboard();
});

export { server };