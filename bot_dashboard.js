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
 * one-click setup with verification + tickets, security suite (raid mode,
 * anti-nuke, keyword alerts, warning escalation), engagement (auto role, join
 * DM, starboard, voice role, boosts, AFK, sticky), levels/XP, birthdays,
 * suggestions, scheduled posts, reminders, native polls, live stat channels,
 * role presets/role packs for every server type, utility lookups and embeds.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';
import { KYRO_COMMANDS, COMMANDS_VERSION, registerAllCommands } from './bot-commands.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// An ambient PORT=0 (or a blank value from a launcher) made Node bind a random
// port, so the browser's http://localhost:4000 was refused. Only a real,
// positive port is honoured; otherwise the dashboard always uses 4000.
const CONFIGURED_PORT = Number(process.env.PORT);
const PORT = Number.isInteger(CONFIGURED_PORT) && CONFIGURED_PORT > 0 ? CONFIGURED_PORT : 4000;
const OWNER_ID = process.env.DISCORD_OWNER_ID || '1052909930073567232';
// Administrator (permissions=8) keeps moderation, role and announcement tools
// working on every server the bot joins without per-feature permission drift.
// The invite link must target the app the token belongs to. A hardcoded client
// id invited a different bot, so granting it Administrator changed nothing for
// the bot this dashboard talks to. resolveBotIdentity() replaces this with the
// id Discord reports for the token.
let BOT_CLIENT_ID = String(process.env.DISCORD_CLIENT_ID || '1570702041993711706').trim();
function installUrl(clientId) {
  return `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(clientId)}&permissions=8&scope=bot%20applications.commands`;
}
let BOT_INSTALL_URL = installUrl(BOT_CLIENT_ID);
let BOT_IDENTITY = { id: '', username: 'Kyro Staff' };

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

// One shared in-memory DB: every loadDB() returns the same object so the
// poller and API handlers mutate one state instead of clobbering each other
// with stale disk snapshots. Disk is the persistence layer, not the source.
let dbCache = null;

function loadDB() {
  if (dbCache) return dbCache;
  try {
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        dbCache = parsed.guilds ? parsed : { guilds: parsed };
        return dbCache;
      }
    }
  } catch (e) {
    console.error('[DB] Failed to read state, starting fresh:', e.message);
  }
  dbCache = { guilds: {} };
  return dbCache;
}

function saveDB(db) {
  dbCache = db;
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), 'utf8');
  } catch (e) {
    console.error('[DB] Failed to save state:', e.message);
  }
}

/* Default engagement block, also used to backfill older saved state. */
function defaultEngagement() {
  return {
    autoRole: { enabled: false, roleId: '', knownMembers: [] },
    joinDm: { enabled: false, message: 'Welcome to {server}! Press Open Ticket in the support channel if you need help.' },
    starboard: { enabled: false, channelId: '', threshold: 3, emoji: '⭐', processed: [] },
    voiceRole: { enabled: false, roleId: '', inVoice: [] },
    boosts: { enabled: false, channelId: '', processed: [] },
    afk: { enabled: false, userId: '', reason: '', until: 0, answered: [] },
    sticky: { enabled: false, channelId: '', content: '', messageId: '', lastChat: '' }
  };
}

/* New guilds start with every module present, and existing saved state gets
   backfilled so older dashboard_data.json files keep working. */
function defaultGuild() {
  return {
      automod: { enabled: false, badWords: [], blockInvites: false, maxMentions: 0, maxEmojis: 0, capsPercent: 0, action: 'delete', timeoutSeconds: 300, exemptRoles: [], channels: [], processed: [] },
      welcome: { enabled: false, channelId: '', message: 'Welcome {user} to **{server}**! You are member #{membercount}.', useEmbed: true, embedColor: '#5865f2', dm: false, dmMessage: 'Welcome to {server}!', knownMembers: [], seeded: false },
      leave: { enabled: false, channelId: '', message: '**{username}** just left **{server}**. We are now {membercount} members.', useEmbed: true, embedColor: '#8e8e93', knownNames: {} },
      logging: { enabled: false, channelId: '', events: { moderation: true, giveaways: true, reactionRoles: true, automod: true, welcome: true, joins: true } },
      reactionRoles: [],
      giveaways: [],
      warnings: [],
      tempbans: [],
      engagement: defaultEngagement(),
      schedule: { announcements: [], reminders: [] },
      autoResponses: [],
      suggestions: { enabled: false, channelId: '', processed: [] },
      levels: {
        enabled: false, minXp: 5, maxXp: 15, cooldownSeconds: 60, channelId: '', announce: true,
        channels: [], rewards: [], users: {}, seen: []
      },
      birthdays: { enabled: false, channelId: '', message: '🎂 Happy birthday {user}! Have an amazing day.', users: [], announced: [] },
      statChannels: { enabled: false, memberChannelId: '', botChannelId: '', lastRun: 0 },
      polls: [],
      verification: { enabled: false, channelId: '', roleId: '', gate: false, messageId: '', gatedChannels: [] },
      security: {
        raidMode: false, autoRaid: true, raidThreshold: 10, raidCooldown: 0,
        antiNuke: false, antiNukeThreshold: 3, antiNukeBan: false, nukeCooldown: {},
        keywordAlerts: false, keywords: ['free nitro', 'steamcommun', 'ip grabber', 'self harm', 'kill yourself'],
        warnEscalation: { enabled: true, timeoutAt: 3, timeoutMinutes: 120, kickAt: 5, banAt: 7 },
        raidsSeen: []
      },
      honeypot: {
        enabled: false, channelId: '', action: 'kick', timeoutSeconds: 600,
        reason: 'Honeypot trap triggered', exemptRoles: [], seen: [], total: 0, last_at: 0, last_user: '',
        panelMessageId: ''
      },
      audit: []
    };
}

function guildConfig(db, guildId) {
  if (!db.guilds[guildId]) db.guilds[guildId] = defaultGuild();
  else {
    const def = defaultGuild();
    for (const key of Object.keys(def)) {
      if (db.guilds[guildId][key] === undefined) db.guilds[guildId][key] = def[key];
    }
    const eng = db.guilds[guildId].engagement;
    if (!eng || typeof eng !== 'object') db.guilds[guildId].engagement = def.engagement;
    else for (const key of Object.keys(def.engagement)) if (!eng[key]) eng[key] = def.engagement[key];
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

/* Ask Discord which application this token belongs to, so every invite link on
   the dashboard adds (and re-grants) the bot that is actually running here. */
async function resolveBotIdentity() {
  if (!BOT_TOKEN) return;
  try {
    const me = await discordFetch('/users/@me');
    if (me && me.id) BOT_IDENTITY = { id: me.id, username: me.username || BOT_IDENTITY.username };
  } catch (e) {}
  try {
    const app = await discordFetch('/oauth2/applications/@me');
    if (app && /^\d{15,25}$/.test(String(app.id || ''))) {
      BOT_CLIENT_ID = String(app.id);
      BOT_INSTALL_URL = installUrl(BOT_CLIENT_ID);
    }
  } catch (e) {
    console.error('[Dashboard] Could not resolve the bot application id; invite links use', BOT_CLIENT_ID + '.', e.message);
  }
}

/* Discord only shows slash commands that have been registered with the
   application. The interactions worker handles them, but nothing registered
   them — so /setup verification, /mod, /role and the rest never appeared and
   verification "did not work". Register the full set per-guild (instant,
   idempotent PUT bulk-overwrite) for every server the bot is in. Fail-soft: a
   guild that rejects registration is logged, never fatal. Throttled to once per
   10 minutes unless forced, so the poller can call it cheaply. */
const COMMANDS_STATE = { version: COMMANDS_VERSION, lastRun: 0, results: [] };
async function ensureSlashCommands(force = false) {
  if (!BOT_TOKEN) return { ok: false, error: 'No bot token loaded.' };
  const now = Date.now();
  if (!force && now - COMMANDS_STATE.lastRun < 10 * 60 * 1000) {
    return { ok: true, skipped: true, results: COMMANDS_STATE.results };
  }
  COMMANDS_STATE.lastRun = now;
  let guilds = [];
  try {
    guilds = await discordFetch('/users/@me/guilds');
  } catch (e) {
    return { ok: false, error: 'Could not list guilds: ' + (e.message || e) };
  }
  const ids = (Array.isArray(guilds) ? guilds : []).map((g) => g && g.id).filter(Boolean);
  if (!ids.length) return { ok: true, count: KYRO_COMMANDS.length, results: [], note: 'Bot is not in any guild yet.' };
  const results = await registerAllCommands(discordFetch, BOT_CLIENT_ID, ids);
  COMMANDS_STATE.results = results;
  const okCount = results.filter((r) => r.ok).length;
  console.log(`[Dashboard] Registered ${KYRO_COMMANDS.length} slash commands in ${okCount}/${ids.length} guild(s).`);
  for (const r of results) if (!r.ok) console.warn(`[Dashboard] Command registration failed in ${r.guildId}: ${r.error}`);
  return { ok: okCount === ids.length, count: KYRO_COMMANDS.length, results };
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
// Server setup: auto permissions, verification, one-click preset, tickets
// ---------------------------------------------------------------------------
const PERM = {
  KICK: 1n << 1n, BAN: 1n << 2n, ADMIN: 1n << 3n, MANAGE_CH: 1n << 4n, MANAGE_GUILD: 1n << 5n, REACT: 1n << 6n, AUDIT: 1n << 7n,
  VIEW: 1n << 10n, SEND: 1n << 11n, MANAGE_MSG: 1n << 13n, EMBED: 1n << 14n, ATTACH: 1n << 15n, HISTORY: 1n << 16n,
  MENTION: 1n << 17n, EXTERN: 1n << 18n, CONNECT: 1n << 20n, SPEAK: 1n << 21n, MUTE: 1n << 22n, DEAFEN: 1n << 23n,
  MOVE: 1n << 24n, NICK: 1n << 27n, MANAGE_ROLES: 1n << 28n, APPCMD: 1n << 31n, THREAD_CREATE: 1n << 35n,
  STICKER: 1n << 37n, THREAD_SEND: 1n << 38n, TIMEOUT: 1n << 40n
};

const CHAT_BASICS = PERM.VIEW | PERM.SEND | PERM.REACT | PERM.EMBED | PERM.ATTACH | PERM.HISTORY | PERM.EXTERN | PERM.STICKER | PERM.CONNECT | PERM.SPEAK | PERM.APPCMD | PERM.THREAD_CREATE | PERM.THREAD_SEND;

/* Permission presets by role intent. Order matters: the first match wins, so
   leadership, staff and narrow team roles are checked before generic ones.
   Covers gaming, community, support, creator, education, business, music, art,
   developer, roleplay and 18+ servers out of the box. */
const ROLE_PRESETS = [
  { id: 'admin', group: 'Leadership', label: 'Administrator', desc: 'Full control of the server', match: /(admin|owner|founder|president|ceo|director|management|manager|leadership|boss|co-?owner|high[\s-]?command)/, perms: () => PERM.ADMIN },
  { id: 'head', group: 'Leadership', label: 'senior staff (mod + manage roles/channels)', desc: 'Runs the staff team and role structure', match: /(head|senior|lead|supervisor|chief|vice|deputy|coordinator|officer)/, perms: () => CHAT_BASICS | PERM.KICK | PERM.BAN | PERM.TIMEOUT | PERM.MANAGE_MSG | PERM.MENTION | PERM.MUTE | PERM.DEAFEN | PERM.MOVE | PERM.NICK | PERM.AUDIT | PERM.MANAGE_ROLES | PERM.MANAGE_CH },
  { id: 'security', group: 'Staff', label: 'security team powers', desc: 'Watches raids and handles offenders', match: /(security|guard|protection|raid[\s-]?squad|bouncer|watchdog)/, perms: () => CHAT_BASICS | PERM.KICK | PERM.TIMEOUT | PERM.MANAGE_MSG | PERM.MENTION | PERM.MUTE | PERM.MOVE | PERM.NICK },
  { id: 'moderator', group: 'Staff', label: 'moderation powers', desc: 'Kick, timeout, warn, purge', match: /(\bmod(erator|s)?\b|staff|helper|trial|trainee|crew|enforcer|janitor)/, perms: () => CHAT_BASICS | PERM.KICK | PERM.TIMEOUT | PERM.MANAGE_MSG | PERM.MENTION | PERM.MUTE | PERM.MOVE | PERM.NICK | PERM.AUDIT },
  { id: 'support', group: 'Staff', label: 'support team powers', desc: 'Runs tickets and help channels', match: /(support|modmail|mod\s*mail|ticket|helpdesk|help[\s-]?desk|service|dispatch)/, perms: () => CHAT_BASICS | PERM.MANAGE_MSG | PERM.TIMEOUT },
  { id: 'alumni', group: 'Staff', label: 'alumni (read only)', desc: 'Retired staff who keep read access', match: /(alumni|retired|ex-?staff|former|inactive|on\s*leave|\bloa\b)/, perms: () => PERM.VIEW | PERM.HISTORY },
  { id: 'media', group: 'Teams', label: 'media team (manage messages)', desc: 'Editors, designers, clippers, VFX', match: /(editor|designer|design|gfx|vfx|animator|animation|artist|thumbnail|clipper|clipping|video|media|creative|photographer|illustrator)/, perms: () => CHAT_BASICS | PERM.MANAGE_MSG | PERM.MENTION },
  { id: 'events', group: 'Teams', label: 'events/DJ powers (voice control)', desc: 'Hosts events and runs voice stages', match: /(\bdj\b|music|event|host|raffle|stage|karaoke|party)/, perms: () => CHAT_BASICS | PERM.MUTE | PERM.DEAFEN | PERM.MOVE | PERM.MENTION },
  { id: 'creator', group: 'Teams', label: 'creator perks', desc: 'Streamers, partners and affiliates', match: /(streamer|youtube|youtuber|tiktok|twitch|creator|influencer|partner|affiliate|promoter|content|ambassador|sponsor)/, perms: () => CHAT_BASICS | PERM.MENTION },
  { id: 'dev', group: 'Teams', label: 'developer team (chat basics)', desc: 'Developers, testers and QA', match: /(dev|developer|programmer|engineer|coder|tech|tester|\bqa\b|beta|modder)/, perms: () => CHAT_BASICS },
  { id: 'vip', group: 'Perks', label: 'VIP perks', desc: 'Donors, boosters and premium members', match: /(vip|premium|donator|donor|patron|legend|elite|god|gold|diamond|\bog\b|booster|supporter|subscriber|member\+)/, perms: () => CHAT_BASICS | PERM.MENTION },
  { id: 'muted', group: 'Moderation', label: 'read-only (punishment role)', desc: 'Muted, jailed or quarantined members', match: /(muted|timeout|jail|quarantine|prison|silenced|restricted|grounded|isolation)/, perms: () => PERM.VIEW | PERM.HISTORY },
  { id: 'gaming', group: 'Community', label: 'gaming squad (chat basics)', desc: 'Clans, teams, squads and rosters', match: /(squad|clan|team|roster|party|duo|squadron|guild\s*member|esports|competitive)/, perms: () => CHAT_BASICS },
  { id: 'helper', group: 'Community', label: 'community helper (chat basics)', desc: 'Welcomers, mentors, translators', match: /(welcomer|greeter|mentor|guide|translator|translation|tutor|coach|volunteer)/, perms: () => CHAT_BASICS },
  { id: 'level', group: 'Community', label: 'level role (chat basics)', desc: 'Level, rank and XP rewards', match: /(level|lvl|rank|tier\s*\d|x[lv]?\d)/, perms: () => CHAT_BASICS },
  { id: 'age', group: 'Access', label: 'age-gated access (chat basics)', desc: '18+ / NSFW channel access', match: /(nsfw|18\+|adult|lewd|explicit|hentai|uncensored)/, perms: () => CHAT_BASICS },
  { id: 'region', group: 'Access', label: 'region/language role (chat basics)', desc: 'Language and region pickers', match: /(english|spanish|french|german|portuguese|italian|dutch|arabic|hindi|japanese|korean|chinese|russian|turkish|polish|swedish|norwegian|filipino|indonesian|vietnamese|\bregion\b|\bcountry\b)/, perms: () => CHAT_BASICS },
  { id: 'ping', group: 'Access', label: 'ping role (no extra permissions)', desc: 'Announcement / giveaway / event pings', match: /(ping|pings|notif|updates?|news|announcement|bulletin|follower)/, perms: () => 0n },
  { id: 'cosmetic', group: 'Cosmetic', label: 'cosmetic/pronoun role (no extra permissions)', desc: 'Colour, pronoun and personality roles', match: /(pronoun|he\/him|she\/her|they\/them|\bhe\b|\bshe\b|\bthey\b|male|female|nonbinary|non-binary|lgbtq?|color|colour|aesthetic|cosmetic|simp|\bcat\b|\bdog\b)/, perms: () => 0n },
  { id: 'member', group: 'Default', label: 'chat basics', desc: 'Verified members and guests', match: /(member|verified|guest|community|people|explorer|contributor|newcomer|newbie|rookie|regular|veteran|active|loyal|citizen|recruit|cadet|starter|friend|visitor)/, perms: () => CHAT_BASICS }
];

function rolePresetPermissions(name) {
  const n = String(name || '').toLowerCase();
  for (const preset of ROLE_PRESETS) {
    if (preset.match.test(n)) return { perms: String(preset.perms()), label: preset.label, presetId: preset.id };
  }
  // Custom role with no keyword match: explain it by shape and optimise to a safe baseline.
  return { perms: String(CHAT_BASICS), label: 'custom role → safe baseline (chat basics)', presetId: 'baseline' };
}

/* Role packs: a ready-made role tree per server type, so every kind of server
   can be set up in one click instead of inventing its own hierarchy. */
const ROLE_PACKS = [
  {
    id: 'gaming', label: 'Gaming / clan', description: 'Owners, mods, game masters, squads and ping roles.',
    roles: [
      { name: '👑 Owner', color: '#f1c40f', hoist: true, preset: 'admin' },
      { name: '🛡️ Admin', color: '#e74c3c', hoist: true, preset: 'admin' },
      { name: '⚔️ Head Moderator', color: '#e67e22', hoist: true, preset: 'head' },
      { name: '🔨 Moderator', color: '#3498db', hoist: true, preset: 'moderator' },
      { name: '🎮 Game Master', color: '#9b59b6', hoist: true, preset: 'events' },
      { name: '🏆 Competitive', color: '#2ecc71', hoist: false, preset: 'gaming' },
      { name: '🎉 Event Ping', color: '#95a5a6', hoist: false, preset: 'ping' },
      { name: '🎮 Member', color: '#5865f2', hoist: false, preset: 'member' },
      { name: '🤖 Bots', color: '#4f545c', hoist: false, preset: 'ping' }
    ]
  },
  {
    id: 'esports', label: 'Esports team', description: 'Coach, analyst, starting roster, substitutes and scrim pings.',
    roles: [
      { name: '👑 Team Owner', color: '#f1c40f', hoist: true, preset: 'admin' },
      { name: '🧠 Head Coach', color: '#e67e22', hoist: true, preset: 'head' },
      { name: '📊 Analyst', color: '#3498db', hoist: false, preset: 'dev' },
      { name: '🎯 Starting Roster', color: '#2ecc71', hoist: true, preset: 'gaming' },
      { name: '🔁 Substitute', color: '#95a5a6', hoist: false, preset: 'gaming' },
      { name: '📣 Scrim Ping', color: '#9b59b6', hoist: false, preset: 'ping' },
      { name: '🎮 Fan', color: '#5865f2', hoist: false, preset: 'member' }
    ]
  },
  {
    id: 'community', label: 'Community / general', description: 'Classic community hierarchy with verified members and level roles.',
    roles: [
      { name: '👑 Founder', color: '#f1c40f', hoist: true, preset: 'admin' },
      { name: '🛡️ Administrator', color: '#e74c3c', hoist: true, preset: 'admin' },
      { name: '⚔️ Head Moderator', color: '#e67e22', hoist: true, preset: 'head' },
      { name: '🔨 Moderator', color: '#3498db', hoist: true, preset: 'moderator' },
      { name: '🎫 Support Team', color: '#1abc9c', hoist: true, preset: 'support' },
      { name: '💡 Helper', color: '#2ecc71', hoist: false, preset: 'helper' },
      { name: '🚀 Booster', color: '#f47fff', hoist: false, preset: 'vip' },
      { name: '⭐ Level 10', color: '#f39c12', hoist: false, preset: 'level' },
      { name: '📣 Announcement Ping', color: '#95a5a6', hoist: false, preset: 'ping' },
      { name: '✅ Verified', color: '#30d158', hoist: false, preset: 'member' },
      { name: '👋 Guest', color: '#5865f2', hoist: false, preset: 'member' }
    ]
  },
  {
    id: 'support', label: 'Support / helpdesk', description: 'Ticket teams, escalation tiers and read-only alumni.',
    roles: [
      { name: '👑 Owner', color: '#f1c40f', hoist: true, preset: 'admin' },
      { name: '🛡️ Support Lead', color: '#e74c3c', hoist: true, preset: 'head' },
      { name: '🎫 Support Agent', color: '#3498db', hoist: true, preset: 'support' },
      { name: '🕐 On Call', color: '#1abc9c', hoist: false, preset: 'support' },
      { name: '🧪 Trial Agent', color: '#95a5a6', hoist: false, preset: 'moderator' },
      { name: '🎓 Alumni', color: '#7f8c8d', hoist: false, preset: 'alumni' },
      { name: '👤 Customer', color: '#5865f2', hoist: false, preset: 'member' }
    ]
  },
  {
    id: 'creators', label: 'Creator / streamer', description: 'Partners, clippers, editors and subscriber tiers.',
    roles: [
      { name: '👑 Owner', color: '#f1c40f', hoist: true, preset: 'admin' },
      { name: '🛡️ Manager', color: '#e74c3c', hoist: true, preset: 'head' },
      { name: '🔨 Moderator', color: '#3498db', hoist: true, preset: 'moderator' },
      { name: '🎬 Editor', color: '#9b59b6', hoist: true, preset: 'media' },
      { name: '✂️ Clipper', color: '#e67e22', hoist: false, preset: 'media' },
      { name: '🤝 Partner', color: '#2ecc71', hoist: false, preset: 'creator' },
      { name: '⭐ Subscriber', color: '#f39c12', hoist: false, preset: 'vip' },
      { name: '📣 Go Live Ping', color: '#95a5a6', hoist: false, preset: 'ping' },
      { name: '💬 Viewer', color: '#5865f2', hoist: false, preset: 'member' }
    ]
  },
  {
    id: 'music', label: 'Music / radio', description: 'DJs, request queues, stage hosts and listeners.',
    roles: [
      { name: '👑 Station Owner', color: '#f1c40f', hoist: true, preset: 'admin' },
      { name: '🛡️ Station Manager', color: '#e74c3c', hoist: true, preset: 'head' },
      { name: '🎧 DJ', color: '#9b59b6', hoist: true, preset: 'events' },
      { name: '🎤 Host', color: '#e67e22', hoist: true, preset: 'events' },
      { name: '🎵 Producer', color: '#3498db', hoist: false, preset: 'media' },
      { name: '📻 Listener', color: '#5865f2', hoist: false, preset: 'member' },
      { name: '📣 Event Ping', color: '#95a5a6', hoist: false, preset: 'ping' }
    ]
  },
  {
    id: 'art', label: 'Art / design', description: 'Artists, critics, commissions and portfolio access.',
    roles: [
      { name: '👑 Owner', color: '#f1c40f', hoist: true, preset: 'admin' },
      { name: '🔨 Moderator', color: '#3498db', hoist: true, preset: 'moderator' },
      { name: '🎨 Artist', color: '#9b59b6', hoist: true, preset: 'media' },
      { name: '🖌️ Designer', color: '#e67e22', hoist: false, preset: 'media' },
      { name: '💬 Critic', color: '#2ecc71', hoist: false, preset: 'helper' },
      { name: '💰 Commissioner', color: '#f39c12', hoist: false, preset: 'vip' },
      { name: '👀 Viewer', color: '#5865f2', hoist: false, preset: 'member' }
    ]
  },
  {
    id: 'developers', label: 'Developer / tech', description: 'Maintainers, reviewers, contributors and bug reporters.',
    roles: [
      { name: '👑 Maintainer', color: '#f1c40f', hoist: true, preset: 'admin' },
      { name: '🛡️ Core Team', color: '#e74c3c', hoist: true, preset: 'head' },
      { name: '🔍 Reviewer', color: '#3498db', hoist: true, preset: 'dev' },
      { name: '💻 Contributor', color: '#2ecc71', hoist: false, preset: 'dev' },
      { name: '🧪 Tester', color: '#9b59b6', hoist: false, preset: 'dev' },
      { name: '🐛 Bug Hunter', color: '#e67e22', hoist: false, preset: 'helper' },
      { name: '📦 Release Ping', color: '#95a5a6', hoist: false, preset: 'ping' },
      { name: '👥 User', color: '#5865f2', hoist: false, preset: 'member' }
    ]
  },
  {
    id: 'education', label: 'Education / study', description: 'Teachers, tutors, students and course channels.',
    roles: [
      { name: '👑 Principal', color: '#f1c40f', hoist: true, preset: 'admin' },
      { name: '🛡️ Head Teacher', color: '#e74c3c', hoist: true, preset: 'head' },
      { name: '📚 Teacher', color: '#3498db', hoist: true, preset: 'moderator' },
      { name: '🧑‍🏫 Tutor', color: '#1abc9c', hoist: false, preset: 'helper' },
      { name: '🎓 Graduate', color: '#2ecc71', hoist: false, preset: 'level' },
      { name: '📝 Student', color: '#5865f2', hoist: false, preset: 'member' },
      { name: '📣 Class Ping', color: '#95a5a6', hoist: false, preset: 'ping' }
    ]
  },
  {
    id: 'business', label: 'Business / team', description: 'Executives, department heads, contractors and clients.',
    roles: [
      { name: '👑 CEO', color: '#f1c40f', hoist: true, preset: 'admin' },
      { name: '🛡️ Director', color: '#e74c3c', hoist: true, preset: 'admin' },
      { name: '📊 Manager', color: '#e67e22', hoist: true, preset: 'head' },
      { name: '💼 Employee', color: '#3498db', hoist: false, preset: 'member' },
      { name: '📦 Contractor', color: '#9b59b6', hoist: false, preset: 'member' },
      { name: '🤝 Client', color: '#2ecc71', hoist: false, preset: 'vip' },
      { name: '📣 Company Updates', color: '#95a5a6', hoist: false, preset: 'ping' }
    ]
  },
  {
    id: 'roleplay', label: 'Roleplay / story', description: 'GMs, lorekeepers, factions and spectators.',
    roles: [
      { name: '👑 Server Owner', color: '#f1c40f', hoist: true, preset: 'admin' },
      { name: '📖 Game Master', color: '#e74c3c', hoist: true, preset: 'events' },
      { name: '🔨 Moderator', color: '#3498db', hoist: true, preset: 'moderator' },
      { name: '✍️ Lorekeeper', color: '#9b59b6', hoist: false, preset: 'media' },
      { name: '⚔️ Faction Leader', color: '#e67e22', hoist: false, preset: 'gaming' },
      { name: '🧙 Roleplayer', color: '#2ecc71', hoist: false, preset: 'member' },
      { name: '👀 Spectator', color: '#5865f2', hoist: false, preset: 'alumni' }
    ]
  },
  {
    id: 'nsfw18', label: '18+ / adult', description: 'Age-gated community with verification and read-only guests.',
    roles: [
      { name: '👑 Owner', color: '#f1c40f', hoist: true, preset: 'admin' },
      { name: '🛡️ Administrator', color: '#e74c3c', hoist: true, preset: 'admin' },
      { name: '⚔️ Head Moderator', color: '#e67e22', hoist: true, preset: 'head' },
      { name: '🔨 Moderator', color: '#3498db', hoist: true, preset: 'moderator' },
      { name: '🔞 18+ Verified', color: '#eb459e', hoist: false, preset: 'age' },
      { name: '🚀 Booster', color: '#f47fff', hoist: false, preset: 'vip' },
      { name: '📣 Ping', color: '#95a5a6', hoist: false, preset: 'ping' }
    ]
  }
];

function rolePresetById(id) {
  return ROLE_PRESETS.find((p) => p.id === id) || null;
}

/* The bot's own permission set in a guild (from its guild list). */
async function botGuildPermissions(guildId) {
  const guilds = await discordFetch('/users/@me/guilds?with_counts=false');
  const g = (Array.isArray(guilds) ? guilds : []).find((x) => x.id === guildId);
  const listed = BigInt((g && g.permissions) || '0');
  // The guild list can omit (or lag behind) `permissions`. The bot's own member
  // object and the role bitfields are authoritative, so compute those as well and
  // trust them: a freshly granted Administrator was otherwise invisible for up
  // to an hour of Discord cache, which made every setup action look broken.
  let computed = 0n;
  try {
    const botId = await getBotUserId();
    const [member, roles] = await Promise.all([
      discordFetch(`/guilds/${guildId}/members/${botId}`),
      discordFetch(`/guilds/${guildId}/roles`)
    ]);
    const byId = new Map((Array.isArray(roles) ? roles : []).map((r) => [r.id, r]));
    const everyone = byId.get(guildId);
    if (everyone) computed |= BigInt(everyone.permissions || '0');
    for (const rid of (member && member.roles) || []) {
      const role = byId.get(rid);
      if (role) computed |= BigInt(role.permissions || '0');
    }
  } catch (e) {}
  return { perms: computed || listed, inGuild: Boolean(g) };
}

const accessCache = {};

/* What the bot can actually do in a guild. Drives the dashboard's "grant admin"
   prompt so a missing permission is visible before an action fails. */
async function botAccess(guildId) {
  const cached = accessCache[guildId];
  if (cached && Date.now() - cached.at < 20000) return cached.state;
  const required = { 'Manage Roles': PERM.MANAGE_ROLES, 'Manage Channels': PERM.MANAGE_CH, 'Kick Members': PERM.KICK, 'Ban Members': PERM.BAN, 'Manage Messages': PERM.MANAGE_MSG, 'Timeout Members': PERM.TIMEOUT, 'Send Messages': PERM.SEND, 'View Channels': PERM.VIEW };
  let state;
  try {
    const { perms, inGuild } = await botGuildPermissions(guildId);
    const isAdmin = (perms & PERM.ADMIN) === PERM.ADMIN;
    const missing = Object.entries(required).filter(([, bit]) => (perms & bit) !== bit).map(([name]) => name);
    state = { inGuild, isAdmin, permissions: perms.toString(), missing: isAdmin ? [] : missing, inviteUrl: BOT_INSTALL_URL };
  } catch (err) {
    state = { inGuild: false, isAdmin: false, permissions: '0', missing: Object.keys(required), inviteUrl: BOT_INSTALL_URL, error: err.message };
  }
  accessCache[guildId] = { at: Date.now(), state };
  return state;
}

/* Guard used by every setup action: one clear, actionable error when the bot
   lacks Administrator instead of a wall of per-role "Missing Permissions". */
const PERM_LABELS = {
  'Manage Roles': PERM.MANAGE_ROLES,
  'Manage Channels': PERM.MANAGE_CH,
  'Kick Members': PERM.KICK,
  'Ban Members': PERM.BAN,
  'Manage Messages': PERM.MANAGE_MSG,
  'Moderate Members': PERM.TIMEOUT
};

/* Requires exactly the permissions the action needs, not Administrator for
   everything. Administrator still short-circuits; otherwise the error names the
   one permission that is actually missing instead of guessing. */
async function assertBotCan(guildId, bits, action) {
  const access = await botAccess(guildId);
  if (access.isAdmin) return access;
  const perms = BigInt(access.permissions || '0');
  const missing = Object.entries(PERM_LABELS)
    .filter(([, bit]) => (bits & bit) === bit && (perms & bit) !== bit)
    .map(([name]) => name);
  if (!missing.length) return access;
  throw Object.assign(new Error(
    `Kyro Staff needs ${missing.join(' and ')} to run ${action} in this server. ` +
    `In Server Settings → Roles give the **Kyro Bot** role ${missing.join(' and ')} ` +
    `(or Administrator) — the bot already sits above the roles it manages. Invite: ` + BOT_INSTALL_URL
  ), { status: 403, missing, needsAdmin: true, inviteUrl: BOT_INSTALL_URL });
}

async function assertBotAdmin(guildId, action) {
  const access = await botAccess(guildId);
  if (access.isAdmin) return access;
  throw Object.assign(new Error(
    `Kyro Bot doesn't have Administrator in this server, so ${action} can't run. ` +
    `Open the invite link and approve Administrator to fix it in one click.`
  ), { status: 403, needsAdmin: true, inviteUrl: BOT_INSTALL_URL, missing: access.missing });
}

async function applyPermissionPresets(guildId) {
  await assertBotCan(guildId, PERM.MANAGE_ROLES, 'auto permissions');
  const [roles, botId] = await Promise.all([
    discordFetch(`/guilds/${guildId}/roles`),
    getBotUserId()
  ]);
  // The bot can only edit roles strictly below its own highest role.
  let botTop = -1;
  try {
    const me = await discordFetch(`/guilds/${guildId}/members/${botId}`);
    for (const rid of me.roles || []) {
      const r = roles.find((x) => x.id === rid);
      if (r) botTop = Math.max(botTop, r.position);
    }
  } catch (e) {}
  const applied = [], skipped = [];
  for (const role of roles) {
    if (role.managed) { skipped.push(`${role.name} — managed integration role (Discord-owned)`); continue; }
    if (role.name === '@everyone') { skipped.push('@everyone — default role, left as-is (protects verification gates)'); continue; }
    if (/bot/i.test(role.name)) { skipped.push(`${role.name} — bot role`); continue; }
    if (role.position >= botTop) { skipped.push(`${role.name} — above the Kyro Bot role; drag the bot higher in Server Settings → Roles and re-run`); continue; }
    const preset = rolePresetPermissions(role.name);
    try {
      await discordFetch(`/guilds/${guildId}/roles/${role.id}`, {
        method: 'PATCH', headers: { 'X-Audit-Log-Reason': 'Kyro auto permissions' },
        body: JSON.stringify({ permissions: preset.perms })
      });
      applied.push(`${role.name} → ${preset.label}`);
    } catch (e) { skipped.push(`${role.name} — failed: ${e.message}`); }
  }
  return { applied, skipped };
}

/* Apply one named preset to one existing role (used by the preset picker). */
async function applyRolePreset(guildId, roleId, presetId) {
  await assertBotCan(guildId, PERM.MANAGE_ROLES, 'role permission presets');
  const preset = rolePresetById(presetId);
  if (!preset) throw new Error(`Unknown role preset "${presetId}".`);
  const role = (await discordFetch(`/guilds/${guildId}/roles`)).find((r) => r.id === roleId);
  if (!role) throw new Error('That role no longer exists — refresh the page.');
  await discordFetch(`/guilds/${guildId}/roles/${role.id}`, {
    method: 'PATCH', headers: { 'X-Audit-Log-Reason': 'Kyro role preset' },
    body: JSON.stringify({ permissions: String(preset.perms()) })
  });
  await logEvent(guildId, 'security', 'Role preset applied', `**Role:** ${role.name}\n**Preset:** ${preset.label}`, 0x30d158);
  return { role: role.name, preset: preset.label };
}

/* Create a ready-made role tree for a server type. Existing role names are
   reused instead of duplicated, so the pack is safe to re-run. */
async function createRolePack(guildId, packId) {
  await assertBotCan(guildId, PERM.MANAGE_ROLES, 'role packs');
  const pack = ROLE_PACKS.find((p) => p.id === packId);
  if (!pack) throw new Error(`Unknown role pack "${packId}".`);
  const roles = await discordFetch(`/guilds/${guildId}/roles`);
  const existing = new Set((Array.isArray(roles) ? roles : []).map((r) => String(r.name).toLowerCase()));
  const created = [], skipped = [];
  for (const entry of pack.roles) {
    if (existing.has(entry.name.toLowerCase())) { skipped.push(`${entry.name} — already exists`); continue; }
    const preset = rolePresetById(entry.preset) || rolePresetById('member');
    try {
      await discordFetch(`/guilds/${guildId}/roles`, {
        method: 'POST', headers: { 'X-Audit-Log-Reason': `Kyro role pack: ${pack.label}` },
        body: JSON.stringify({
          name: entry.name,
          color: hexToInt(entry.color),
          hoist: Boolean(entry.hoist),
          mentionable: Boolean(entry.mentionable),
          permissions: String(preset.perms())
        })
      });
      created.push(`${entry.name} → ${preset.label}`);
    } catch (err) {
      skipped.push(`${entry.name} — failed: ${err.message}`);
    }
  }
  accessCache[guildId] = null;
  await logEvent(guildId, 'security', 'Role pack created', `**Pack:** ${pack.label}\n**Created:** ${created.length}\n**Skipped:** ${skipped.length}`, 0x2997ff);
  return { pack: pack.label, created, skipped };
}

/* ---------------------------- role cleanup ------------------------------
   Bulk-deletes dead roles. The owner picks how many roles to keep; the busiest
   ones stay and the rest go. These are never deleted, whatever the number:
     - @everyone, managed/integration roles and bot roles
     - roles at or above the bot's own highest role (Discord refuses anyway)
     - roles carrying staff-level permissions or staff-looking names
     - every role the bot's automations depend on (auto-role, voice role,
       verification, level rewards, reaction roles, giveaways)
   Nothing is deleted until the owner previews and confirms the exact plan. */
const ROLE_PROTECT_PERMS =
  0x8n |   // Administrator
  0x2n |   // Kick Members
  0x4n |   // Ban Members
  0x10n |  // Manage Channels
  0x20n |  // Manage Guild
  0x2000n | // Manage Messages
  0x10000000n | // Manage Roles
  0x100000000n; // Moderate Members
const ROLE_PROTECT_NAME = /(owner|admin|moderator|\bmod\b|staff|founder|manager|support|helpdesk|contributor|verified|\bmember\b|muted|jail|bot\b|system|kyro)/i;
const ROLE_CLEANUP_MAX = 200;
const PERM_MANAGE_ROLES = 0x10000000n;
const PERM_MANAGE_CHANNELS = 0x10n;

/* A destructive action needs the exact permission Discord enforces, not just a
   friendly message: Administrator, or the specific bit (Manage Roles for the
   cleanup, Manage Channels for access repair). */
async function requireBotPermission(guildId, bit, label, action) {
  const access = await botAccess(guildId);
  if (access.isAdmin) return access;
  if ((BigInt(access.permissions || '0') & BigInt(bit)) === 0n) {
    throw Object.assign(new Error(
      `Kyro Bot needs the **${label}** permission in this server to run ${action}. ` +
      `Server Settings → Roles → Kyro Bot → enable ${label}, or re-add the bot with Administrator.`
    ), { status: 403, needsAdmin: true, inviteUrl: BOT_INSTALL_URL, missing: [label] });
  }
  return access;
}

function configuredRoleIds(cfg) {
  const ids = new Set();
  const add = (value) => { if (value && /^\d{17,20}$/.test(String(value))) ids.add(String(value)); };
  add(cfg.verification && cfg.verification.roleId);
  const eng = cfg.engagement || {};
  add(eng.autoRole && eng.autoRole.roleId);
  add(eng.voiceRole && eng.voiceRole.roleId);
  for (const reward of (cfg.levels && cfg.levels.rewards) || []) add(reward && reward.roleId);
  for (const rr of cfg.reactionRoles || []) for (const map of rr.mappings || []) add(map.roleId);
  for (const giveaway of cfg.giveaways || []) add(giveaway && giveaway.roleId);
  return ids;
}

async function roleMemberCounts(guildId) {
  const counts = new Map();
  let after = '';
  // Bounded scan: 10 pages is 10k members, enough to rank roles sensibly.
  for (let page = 0; page < 10; page++) {
    const batch = await discordFetch(`/guilds/${guildId}/members?limit=1000${after ? '&after=' + encodeURIComponent(after) : ''}`);
    if (!Array.isArray(batch) || !batch.length) break;
    for (const member of batch) for (const id of member.roles || []) counts.set(id, (counts.get(id) || 0) + 1);
    if (batch.length < 1000) break;
    after = (batch[batch.length - 1].user && batch[batch.length - 1].user.id) || '';
    if (!after) break;
  }
  return counts;
}

async function botTopPosition(guildId, roles) {
  let top = -1;
  try {
    const me = await discordFetch(`/guilds/${guildId}/members/${await getBotUserId()}`);
    for (const id of me.roles || []) {
      const role = roles.find((r) => r.id === id);
      if (role) top = Math.max(top, role.position);
    }
  } catch (e) {}
  return top;
}

/* Give every current member a role — the "set default role" tool. Paginates the
   full member list, skips bots and members who already hold the role, and grants
   it one member at a time through the rate-limited REST helper. Fail-soft per
   member so a single hierarchy/permission error never aborts the whole run. */
async function bulkAssignRole(guildId, roleIdRaw) {
  await requireBotPermission(guildId, PERM_MANAGE_ROLES, 'Manage Roles', 'giving everyone a role');
  const roleId = String(roleIdRaw || '').trim();
  if (!/^\d{17,20}$/.test(roleId)) throw Object.assign(new Error('Pick a role first.'), { status: 400 });
  if (roleId === guildId) throw Object.assign(new Error('The @everyone role cannot be assigned.'), { status: 400 });
  const roles = await discordFetch(`/guilds/${guildId}/roles`);
  const target = (Array.isArray(roles) ? roles : []).find((r) => r.id === roleId);
  if (!target) throw Object.assign(new Error('That role no longer exists.'), { status: 404 });
  if (target.managed) throw Object.assign(new Error('That role is managed by an integration and cannot be assigned manually.'), { status: 400 });
  const botTop = await botTopPosition(guildId, roles);
  if (target.position >= botTop) {
    throw Object.assign(new Error(`Drag the **Kyro Bot** role above **${target.name}** in Server Settings → Roles, then run this again.`), { status: 403 });
  }
  let after = '';
  let total = 0, added = 0, skipped = 0, failed = 0;
  const errors = [];
  for (let page = 0; page < 100; page++) {
    const batch = await discordFetch(`/guilds/${guildId}/members?limit=1000${after ? '&after=' + encodeURIComponent(after) : ''}`);
    if (!Array.isArray(batch) || !batch.length) break;
    for (const member of batch) {
      const user = member.user || {};
      if (user.bot) continue;
      total++;
      if ((member.roles || []).includes(roleId)) { skipped++; continue; }
      try {
        await discordFetch(`/guilds/${guildId}/members/${user.id}/roles/${roleId}`, {
          method: 'PUT', headers: { 'X-Audit-Log-Reason': 'Kyro set default role' }
        });
        added++;
      } catch (err) {
        failed++;
        if (errors.length < 10) errors.push(`${user.username || user.id}: ${err.message}`);
      }
    }
    if (batch.length < 1000) break;
    after = (batch[batch.length - 1].user && batch[batch.length - 1].user.id) || '';
    if (!after) break;
  }
  return { ok: failed === 0, role: target.name, roleId, total, added, skipped, failed, errors };
}

async function roleCleanupPlan(guildId, keepRaw) {
  await requireBotPermission(guildId, PERM_MANAGE_ROLES, 'Manage Roles', 'role cleanup');
  const keep = Math.max(0, Math.min(ROLE_CLEANUP_MAX, Math.trunc(Number(keepRaw)) || 0));
  const db = loadDB();
  const cfg = guildConfig(db, guildId);
  const autoRoles = configuredRoleIds(cfg);

  const roles = await discordFetch(`/guilds/${guildId}/roles`);
  if (!Array.isArray(roles)) throw new Error('Discord did not return the role list.');
  // Member listing needs the privileged Server Members intent. When it is off we
  // still produce a safe plan, ranked by role position instead of usage.
  let usageKnown = true;
  let counts = new Map();
  try { counts = await roleMemberCounts(guildId); } catch { usageKnown = false; }
  const botTop = await botTopPosition(guildId, roles);

  const protectedRoles = [];
  const candidates = [];
  for (const role of roles) {
    const name = String(role.name || '');
    const members = counts.get(role.id) || 0;
    const perms = BigInt(role.permissions || '0');
    let reason = '';
    if (role.id === guildId || name === '@everyone') reason = '@everyone — always kept';
    else if (role.managed) reason = 'managed by Discord or an integration';
    else if (role.id === (role.tags && role.tags.bot_id)) reason = 'bot role';
    else if (role.position >= botTop) reason = 'at or above the Kyro Bot role';
    else if (autoRoles.has(role.id)) reason = 'used by a Kyro automation';
    else if ((perms & ROLE_PROTECT_PERMS) !== 0n) reason = 'has staff-level permissions';
    else if (ROLE_PROTECT_NAME.test(name)) reason = 'staff/bot/system role name';

    if (reason) protectedRoles.push({ id: role.id, name, position: role.position, members, reason });
    else candidates.push({ id: role.id, name, position: role.position, members });
  }

  candidates.sort((a, b) => (b.members - a.members) || (b.position - a.position) || a.name.localeCompare(b.name));
  const kept = candidates.slice(0, keep);
  const remove = candidates.slice(keep).sort((a, b) => (a.members - b.members) || (a.position - b.position));

  return {
    keep,
    usageKnown,
    total: roles.length,
    protectedRoles,
    kept,
    delete: remove.slice(0, ROLE_CLEANUP_MAX),
    overflowing: Math.max(0, remove.length - ROLE_CLEANUP_MAX)
  };
}

async function applyRoleCleanup(guildId, keepRaw, ids) {
  const plan = await roleCleanupPlan(guildId, keepRaw);
  const allowed = new Map(plan.delete.map((role) => [role.id, role]));
  const targets = (Array.isArray(ids) ? ids : [])
    .map((id) => String(id))
    .filter((id) => allowed.has(id))
    .slice(0, ROLE_CLEANUP_MAX);
  if (!targets.length) throw new Error('Nothing left to delete — run the preview again.');

  const deleted = [];
  const failed = [];
  for (const id of targets) {
    const role = allowed.get(id);
    try {
      await discordFetch(`/guilds/${guildId}/roles/${id}`, {
        method: 'DELETE', headers: { 'X-Audit-Log-Reason': 'Kyro role cleanup' }
      });
      deleted.push(role.name);
    } catch (err) {
      failed.push(`${role.name} — ${err.message}`);
    }
    await sleep(220);
  }
  await logEvent(guildId, 'security', 'Role cleanup',
    `**Deleted:** ${deleted.length}\n**Kept:** ${plan.kept.length + plan.protectedRoles.length}${failed.length ? `\n**Failed:** ${failed.join(', ')}` : ''}`,
    deleted.length ? 0xf59e0b : 0x2997ff);
  return { deleted, failed, kept: plan.kept.length + plan.protectedRoles.length };
}

/* ------------------------- channel access repair -------------------------
   The bot posts into channels that sometimes end up unreadable — a member or
   even the owner sees "You do not have permission to view the message history".
   This merges the one overwrite that matters back in: @everyone may view and
   read history, and the bot keeps send/embed/manage so it can maintain its own
   announcements. Nothing else in the channel is touched. */
const PERM_VIEW_CHANNEL = 1024;
const PERM_READ_HISTORY = 65536;
const PERM_SEND_MESSAGES = 2048;
const PERM_EMBED_LINKS = 16384;
const PERM_MANAGE_MESSAGES = 8192;

async function repairChannelAccess(guildId, channelId) {
  if (!channelId) throw new Error('Pick a channel first.');
  await requireBotPermission(guildId, PERM_MANAGE_CHANNELS, 'Manage Channels', 'channel access repair');
  const channel = await discordFetch(`/channels/${channelId}`);
  const botId = await getBotUserId();
  const overwrites = Array.isArray(channel.permission_overwrites) ? channel.permission_overwrites.slice() : [];

  const merge = (id, type, allow, deny) => {
    const existing = overwrites.find((o) => String(o.id) === String(id));
    const allowBits = BigInt(existing ? existing.allow : '0') | BigInt(allow);
    const denyBits = BigInt(existing ? existing.deny : '0') & ~BigInt(deny);
    if (existing) { existing.allow = String(allowBits); existing.deny = String(denyBits); }
    else overwrites.push({ id: String(id), type, allow: String(allowBits), deny: String(denyBits) });
  };

  merge(guildId, 0, PERM_VIEW_CHANNEL | PERM_READ_HISTORY, 0);
  merge(botId, 1, PERM_VIEW_CHANNEL | PERM_READ_HISTORY | PERM_SEND_MESSAGES | PERM_EMBED_LINKS | PERM_MANAGE_MESSAGES, 0);

  await discordFetch(`/channels/${channelId}`, {
    method: 'PATCH', headers: { 'X-Audit-Log-Reason': 'Kyro channel access repair' },
    body: JSON.stringify({ permission_overwrites: overwrites })
  });
  await logEvent(guildId, 'security', 'Channel access repaired',
    `**Channel:** #${channel.name}\n@everyone can now view and read history; the bot can post and manage its messages.`, 0x2997ff);
  return { channel: channel.name, repaired: true };
}

/* Locks a channel down to staff: @everyone loses View Channel, the bot and every
   staff-looking role keep it. Other overwrites are preserved. */
async function makeChannelStaffOnly(guildId, channel) {
  const roles = await discordFetch(`/guilds/${guildId}/roles`);
  const botId = await getBotUserId();
  const staff = (Array.isArray(roles) ? roles : []).filter((r) => {
    if (r.id === guildId || r.managed) return false;
    const p = BigInt(r.permissions || '0');
    if ((p & (PERM.ADMIN | PERM.MANAGE_GUILD | PERM.MANAGE_MSG | PERM.MANAGE_ROLES | PERM.MANAGE_CH)) !== 0n) return true;
    return /(owner|admin|moderator|\bmod\b|staff|support|helpdesk)/i.test(r.name);
  });
  const botAllow = PERM.VIEW | PERM.SEND | PERM.EMBED | PERM.MANAGE_MSG | PERM.HISTORY;
  const existing = Array.isArray(channel.permission_overwrites) ? channel.permission_overwrites : [];
  const previous = new Map(existing.map((o) => [o.id, o]));
  const overwrites = existing
    .filter((o) => o.id !== guildId && o.id !== botId && !staff.some((r) => r.id === o.id));
  overwrites.push({ id: guildId, type: 0, allow: '0', deny: String(PERM.VIEW) });
  overwrites.push({ id: botId, type: 1, allow: String(botAllow), deny: '0' });
  // Staff keep whatever they already had in the channel, plus read access —
  // locking a log channel down must not silence the people who read it.
  for (const r of staff) {
    const before = previous.get(r.id);
    const allow = BigInt((before && before.allow) || '0') | PERM.VIEW | PERM.HISTORY;
    const deny = BigInt((before && before.deny) || '0') & ~(PERM.VIEW | PERM.HISTORY);
    overwrites.push({ id: r.id, type: 0, allow: allow.toString(), deny: deny.toString() });
  }
  await discordFetch(`/channels/${channel.id}`, {
    method: 'PATCH', headers: { 'X-Audit-Log-Reason': 'Kyro staff-only channel' },
    body: JSON.stringify({ permission_overwrites: overwrites })
  });
  return { ...channel, permission_overwrites: overwrites, staffOnly: true };
}

/* Opens a channel to verified members: the Verified role gets the full chat
   bundle, @everyone is denied View so role-less / unverified members must verify
   first (mandatory verification), the bot keeps posting rights, and every other
   overwrite (staff perks, muted read-only) is preserved untouched. If no Verified
   role exists the channel falls back to fully public so nobody is locked out. */
async function makeChannelPublic(guildId, channel, botId, verifiedRoleId) {
  const existing = Array.isArray(channel.permission_overwrites) ? channel.permission_overwrites : [];
  const overwrites = existing.filter((o) =>
    !(o.id === guildId && o.type === 0) &&
    !(o.id === botId && o.type === 1) &&
    !(verifiedRoleId && o.id === verifiedRoleId && o.type === 0));
  if (verifiedRoleId) {
    overwrites.push({ id: guildId, type: 0, allow: '0', deny: String(PERM.VIEW) });
    overwrites.push({ id: verifiedRoleId, type: 0, allow: String(CHAT_BASICS), deny: '0' });
  } else {
    overwrites.push({ id: guildId, type: 0, allow: String(CHAT_BASICS), deny: '0' });
  }
  const botAllow = PERM.VIEW | PERM.SEND | PERM.REACT | PERM.EMBED | PERM.ATTACH | PERM.HISTORY | PERM.MANAGE_MSG | PERM.THREAD_CREATE | PERM.THREAD_SEND;
  overwrites.push({ id: botId, type: 1, allow: String(botAllow), deny: '0' });
  await discordFetch(`/channels/${channel.id}`, {
    method: 'PATCH', headers: { 'X-Audit-Log-Reason': 'Kyro public channel' },
    body: JSON.stringify({ permission_overwrites: overwrites })
  });
  return { ...channel, permission_overwrites: overwrites, public: true };
}

/* The community layout the owner asked for: a fixed list of channels everyone
   can see and use, and a staff hub hidden from regular members. Names are
   matched after stripping every non-alphanumeric character, so emoji prefixes,
   ┃ separators, spaces and hyphens ("📢┃announcements", "general chat",
   "download-links", "incomming") all resolve. The verify channel and private
   ticket channels are never touched. staff-applications stays public for
   submissions — the bot's review replies live in private tickets, not here. */
const PUBLIC_CHANNEL_NAMES = new Set([
  'alert', 'socialmedia', 'partners', 'requests', 'feedback', 'announcements',
  'rules', 'downloadlinks', 'downloadslinks', 'downloads', 'questions', 'suggestions', 'showcase',
  'generalchat', 'general', 'resources', 'flexx', 'incomming', 'incoming', 'help',
  'updates', 'staffapplications'
]);
const STAFF_HUB_NAMES = new Set(['transcriptlogchannel', 'vaultassetstorage', 'updatesformods']);

async function applyChannelVisibility(guildId) {
  await requireBotPermission(guildId, PERM_MANAGE_CHANNELS, 'Manage Channels', 'channel visibility');
  const [channels, roles, botId] = await Promise.all([
    discordFetch(`/guilds/${guildId}/channels`),
    discordFetch(`/guilds/${guildId}/roles`),
    getBotUserId()
  ]);
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const list = Array.isArray(channels) ? channels : [];
  // Public channels are open to the Verified role; resolve it (or create it) so
  // unverified / role-less members stay gated until they press Verify.
  let verifiedRoleId = ((Array.isArray(roles) ? roles : []).find((r) => !r.managed && String(r.name || '').trim().toLowerCase() === 'verified') || {}).id || '';
  if (!verifiedRoleId) {
    try {
      const made = await discordFetch(`/guilds/${guildId}/roles`, {
        method: 'POST', headers: { 'X-Audit-Log-Reason': 'Kyro channel visibility' },
        body: JSON.stringify({ name: 'Verified', color: 0x30d158, permissions: '0', mentionable: false })
      });
      verifiedRoleId = made.id || '';
    } catch (e) {}
  }
  // Any staff category ("Staff for mods+", "Staff Hub") is hidden from members.
  const staffCategoryIds = new Set(list
    .filter((c) => c.type === 4 && /staff/.test(norm(c.name)))
    .map((c) => c.id));
  const db = loadDB();
  const cfg = guildConfig(db, guildId);
  const verifyChannelId = (cfg.verification && cfg.verification.channelId) || '';
  const madePublic = [], madePrivate = [], skipped = [];
  for (const ch of list) {
    if (ch.type === 4) continue; // categories are handled through their children
    if (![0, 2, 5, 15].includes(ch.type)) continue; // text, voice, announcement, forum
    const n = norm(ch.name);
    const underStaff = ch.parent_id && staffCategoryIds.has(ch.parent_id);
    // staff-applications is the one staff-named channel members must still see;
    // everything else inside a staff category stays locked, including a second
    // #general-chat that lives in the staff hub rather than the community one.
    const decide = n === 'staffapplications' ? 'public'
      : (underStaff || STAFF_HUB_NAMES.has(n)) ? 'private'
      : PUBLIC_CHANNEL_NAMES.has(n) ? 'public'
      : 'skip';
    if (decide === 'skip') continue;
    if (decide === 'public' && verifyChannelId && ch.id === verifyChannelId) {
      skipped.push(`${ch.name} — verification channel left as-is`);
      continue;
    }
    try {
      if (decide === 'private') { await makeChannelStaffOnly(guildId, ch); madePrivate.push(ch.name); }
      else { await makeChannelPublic(guildId, ch, botId, verifiedRoleId); madePublic.push(ch.name); }
    } catch (err) { skipped.push(`${ch.name} — ${err.message}`); }
  }
  await logEvent(guildId, 'security', 'Channel visibility applied',
    `**Public:** ${madePublic.length}\n${madePublic.map((n) => '• ' + n).join('\n')}\n**Staff-only:** ${madePrivate.length}\n${madePrivate.map((n) => '• ' + n).join('\n')}`.slice(0, 1900), 0x2997ff);
  return { public: madePublic, private: madePrivate, skipped };
}

async function ensureChannel(guildId, wantedName, options = {}) {
  const clean = wantedName.toLowerCase();
  const channels = await discordFetch(`/guilds/${guildId}/channels`);
  const found = channels.find((c) => c.type === (options.type || 0) && c.name.toLowerCase() === clean);
  if (found) {
    // An existing channel is still repaired when this is meant to be private:
    // a public #mod-log leaks every moderation action to the whole server.
    if (options.private) {
      const everyone = (found.permission_overwrites || []).find((o) => o.id === guildId && o.type === 0);
      const hidden = everyone && (BigInt(everyone.deny || '0') & PERM.VIEW) !== 0n;
      if (!hidden) return { channel: await makeChannelStaffOnly(guildId, found), created: false, locked: true };
    }
    return { channel: found, created: false, locked: Boolean(options.private) };
  }
  const channel = await discordFetch(`/guilds/${guildId}/channels`, {
    method: 'POST', headers: { 'X-Audit-Log-Reason': 'Kyro auto setup' },
    body: JSON.stringify({ name: wantedName, type: options.type || 0, topic: options.topic })
  });
  const ready = options.private ? await makeChannelStaffOnly(guildId, channel) : channel;
  return { channel: ready, created: true, locked: Boolean(options.private) };
}

async function setupVerification(guildId, opts = {}) {
  await assertBotCan(guildId, PERM.MANAGE_ROLES | PERM.MANAGE_CH, 'verification setup');
  const db = loadDB();
  const g = guildConfig(db, guildId);
  g.verification = g.verification || { enabled: false, channelId: '', roleId: '', gate: false, messageId: '', gatedChannels: [] };
  const steps = [];
  // 1. Verified role
  const roles = await discordFetch(`/guilds/${guildId}/roles`);
  let role = roles.find((r) => !r.managed && r.name === 'Verified');
  if (!role) {
    role = await discordFetch(`/guilds/${guildId}/roles`, {
      method: 'POST', headers: { 'X-Audit-Log-Reason': 'Kyro verification setup' },
      body: JSON.stringify({ name: 'Verified', color: 0x30d158, permissions: '0', mentionable: false })
    });
    steps.push('Created role **Verified**');
  } else steps.push('Using existing role **Verified**');
  // 2. Verify channel
  let channel;
  if (opts.channelId) {
    channel = (await discordFetch(`/guilds/${guildId}/channels`)).find((c) => c.id === opts.channelId);
    if (!channel) throw new Error('Selected channel no longer exists.');
    steps.push(`Using <#${channel.id}>`);
  } else {
    const made = await ensureChannel(guildId, '✅┃verify', { topic: 'Press Verify to unlock the server.' });
    channel = made.channel;
    steps.push(made.created ? 'Created channel **✅┃verify**' : `Using existing channel <#${channel.id}>`);
  }
  // 3. Overwrites: @everyone cannot send/react; Verified can
  const overwrites = Array.isArray(channel.permission_overwrites) ? channel.permission_overwrites.slice() : [];
  const upsert = (id, type, allowAdd, denyAdd) => {
    const i = overwrites.findIndex((o) => o.id === id && o.type === type);
    const allow = BigInt(i >= 0 ? (overwrites[i].allow || '0') : '0') | allowAdd;
    const deny = BigInt(i >= 0 ? (overwrites[i].deny || '0') : '0') | denyAdd;
    const entry = { id, type, allow: allow.toString(), deny: deny.toString() };
    if (i >= 0) overwrites[i] = entry; else overwrites.push(entry);
  };
  upsert(guildId, 0, 0n, 2048n | 64n);
  upsert(role.id, 0, 1024n | 2048n | 65536n | 64n, 0n);
  try {
    await discordFetch(`/channels/${channel.id}`, { method: 'PATCH', body: JSON.stringify({ permission_overwrites: overwrites }) });
    steps.push('Locked sending in the verify channel until verified');
  } catch (e) {
    steps.push('⚠️ Could not lock the verify channel (permissions) — the Verify button still works.');
  }
  // 4. Verify message + button (handled by the Kyro applications worker)
  const msg = await discordFetch(`/channels/${channel.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      embeds: [{
        title: '🔒 Verify to unlock the server',
        description: 'Press **Verify** below to prove you are human and unlock every channel.\nThis keeps spammers and raiders out.',
        color: 0x30d158,
        footer: { text: 'Kyro Staff Bot' }
      }],
      components: [{ type: 1, components: [{ type: 2, style: 3, label: '✅ Verify', custom_id: `kyro-verify:${guildId}:${role.id}` }] }]
    })
  });
  steps.push('Posted the **Verify** button message');
  g.verification.enabled = true;
  g.verification.channelId = channel.id;
  g.verification.roleId = role.id;
  g.verification.messageId = msg.id;
  // 5. Mandatory gate: every other channel stays hidden until members verify
  const gated = await gateChannels(guildId, channel.id, role, true);
  g.verification.gate = true;
  g.verification.gatedChannels = gated;
  steps.push(`Gated **${gated.length} channels** — hidden until members verify`);
  saveDB(db);
  await logEvent(guildId, 'moderation', 'Verification setup', steps.map((s) => '• ' + s).join('\n'), 0x30d158);
  return steps;
}

async function gateChannels(guildId, verifyChannelId, verifiedRole, on, onlyIds) {
  const channels = await discordFetch(`/guilds/${guildId}/channels`);
  const roles = await discordFetch(`/guilds/${guildId}/roles`);
  const botId = await getBotUserId();
  const roleIds = new Set(roles.map((r) => r.id));
  const bypassRoles = roles.filter((r) => !r.managed && /(admin|owner|mod|staff|helper|trial|bot)/i.test(r.name));
  const allowRoles = bypassRoles.concat(verifiedRole ? [verifiedRole] : []);
  const only = on ? null : new Set(onlyIds || []);
  const touched = [];
  for (const ch of channels) {
    if (![0, 2, 5, 15].includes(ch.type) || ch.id === verifyChannelId) continue;
    if (only && !only.has(ch.id)) continue;
    let overwrites = Array.isArray(ch.permission_overwrites) ? ch.permission_overwrites.slice() : [];
    // Older gates wrote role allows as member overwrites (type 1) — strip them.
    const hadBad = overwrites.some((o) => o.type === 1 && roleIds.has(o.id));
    overwrites = overwrites.filter((o) => !(o.type === 1 && roleIds.has(o.id)));
    const idx = overwrites.findIndex((o) => o.id === guildId && o.type === 0);
    const allow = BigInt(idx >= 0 ? (overwrites[idx].allow || '0') : '0');
    const deny = BigInt(idx >= 0 ? (overwrites[idx].deny || '0') : '0');
    const nextDeny = on ? (deny | PERM.VIEW) : (deny & ~PERM.VIEW);
    const denyChanged = nextDeny !== deny;
    // Already-hidden channels (staff hub, private tickets) and already-good
    // gates are left alone; only open channels and broken legacy gates change.
    if (!denyChanged && !hadBad) continue;
    if (idx >= 0) overwrites[idx] = { id: guildId, type: 0, allow: (on ? (allow & ~PERM.VIEW) : allow).toString(), deny: nextDeny.toString() };
    else overwrites.push({ id: guildId, type: 0, allow: '0', deny: nextDeny.toString() });
    if (on) {
      for (const r of allowRoles) {
        const bi = overwrites.findIndex((o) => o.id === r.id && o.type === 0);
        const bAllow = BigInt(bi >= 0 ? (overwrites[bi].allow || '0') : '0') | CHAT_BASICS;
        const entry = { id: r.id, type: 0, allow: bAllow.toString(), deny: bi >= 0 ? overwrites[bi].deny : '0' };
        if (bi >= 0) overwrites[bi] = entry; else overwrites.push(entry);
      }
      const botAllow = PERM.VIEW | PERM.SEND | PERM.REACT | PERM.EMBED | PERM.ATTACH | PERM.HISTORY | PERM.MANAGE_MSG | PERM.THREAD_CREATE | PERM.THREAD_SEND;
      const oi = overwrites.findIndex((o) => o.id === botId && o.type === 1);
      const botEntry = { id: botId, type: 1, allow: String(botAllow), deny: '0' };
      if (oi >= 0) overwrites[oi] = botEntry; else overwrites.push(botEntry);
    }
    try {
      await discordFetch(`/channels/${ch.id}`, { method: 'PATCH', body: JSON.stringify({ permission_overwrites: overwrites }) });
      touched.push(ch.id);
    } catch (e) {}
  }
  return touched;
}

async function clearVerificationGate(guildId) {
  const db = loadDB();
  const g = guildConfig(db, guildId);
  const v = g.verification || {};
  const gated = v.gatedChannels || [];
  let role = null;
  if (v.roleId) {
    try { role = (await discordFetch(`/guilds/${guildId}/roles`)).find((r) => r.id === v.roleId); } catch (e) {}
  }
  const touched = await gateChannels(guildId, v.channelId, role, false, gated);
  v.gate = false;
  v.gatedChannels = [];
  v.enabled = false;
  saveDB(db);
  return { gated, touched };
}

/* One-click preset: channels + welcome + logging + automod + verification + permissions */
async function runAutoSetup(guildId, opts = {}) {
  await assertBotCan(guildId, PERM.MANAGE_ROLES | PERM.MANAGE_CH, 'one-click setup');
  const db = loadDB();
  const g = guildConfig(db, guildId);
  const steps = [];
  const warnings = [];
  // Every step is independent: one refused Discord call reports itself and the
  // rest of the setup still runs, instead of the whole button failing with a
  // message that names permissions the bot actually has.
  const step = async (label, work) => {
    try { return await work(); }
    catch (err) {
      const hint = err && err.needsAdmin ? err.message : (err.message || 'unknown error');
      steps.push(`⚠️ ${label} — ${hint}`);
      warnings.push(`${label} — ${hint}`);
      return null;
    }
  };
  // 1. Core channels
  const welcomeCh = await step('Create #welcome', () => ensureChannel(guildId, 'welcome', { topic: 'Welcome messages for new members' }));
  if (welcomeCh) steps.push(welcomeCh.created ? 'Created #welcome' : '#welcome already exists');
  const logCh = await step('Create #mod-log (staff-only)', () => ensureChannel(guildId, 'mod-log', { topic: 'Kyro Staff Bot logging', private: true }));
  if (logCh) {
    steps.push(logCh.created
      ? 'Created #mod-log — staff-only, hidden from @everyone'
      : (logCh.locked ? 'Repaired #mod-log privacy — now staff-only' : '#mod-log ready and staff-only'));
  }
  const annCh = await step('Create #announcements', () => ensureChannel(guildId, 'announcements', { topic: 'Server announcements (Kyro bot)' }));
  if (annCh) steps.push(annCh.created ? 'Created #announcements' : '#announcements already exists');
  let textChannels = [];
  try { textChannels = (await discordFetch(`/guilds/${guildId}/channels`)).filter((c) => c.type === 0); } catch (e) {}
  // 2. Welcome defaults
  g.welcome = g.welcome || {};
  if (welcomeCh) {
    g.welcome.enabled = true;
    g.welcome.channelId = welcomeCh.channel.id;
    g.welcome.useEmbed = true;
    g.welcome.embedColor = '#2997FF';
    g.welcome.message = 'Welcome {user} to **{server}**! You are member #{membercount}.';
    steps.push('Welcome messages enabled → #welcome');
  }
  // 3. Logging defaults
  g.logging = g.logging || { enabled: false, channelId: '', events: {} };
  if (logCh) {
    g.logging.enabled = true;
    g.logging.channelId = logCh.channel.id;
    g.logging.events = { moderation: true, giveaways: true, reactionRoles: true, automod: true, welcome: true, joins: true };
    steps.push('Full logging enabled → #mod-log (staff-only)');
  }
  // 4. AutoMod defaults on all text channels
  g.automod = g.automod || {};
  g.automod.enabled = true;
  g.automod.blockInvites = true;
  g.automod.maxMentions = 5;
  g.automod.maxEmojis = 10;
  g.automod.capsPercent = 80;
  g.automod.action = 'timeout';
  g.automod.timeoutSeconds = 600;
  g.automod.channels = textChannels.map((c) => c.id);
  steps.push(`AutoMod enabled on **${textChannels.length} channels** (timeout, scam/invite/mention filters)`);
  // 5. Security defaults
  g.security = g.security || {};
  g.security.autoRaid = true;
  g.security.raidThreshold = 10;
  g.security.antiNuke = true;
  g.security.antiNukeThreshold = 3;
  g.security.keywordAlerts = true;
  steps.push('Security: auto-raid detection, anti-nuke and keyword alerts enabled');
  // 6. Verification
  saveDB(db);
  const vSteps = await step('Set up verification', () => setupVerification(guildId, {}));
  if (vSteps) steps.push(...vSteps);
  // 7. Optional permission presets
  if (opts.permissions) {
    const res = await step('Apply best-practice permissions', () => applyPermissionPresets(guildId));
    if (res) steps.push(`Permissions: **${res.applied.length} roles updated** (${res.skipped.length} left untouched)`);
  }
  saveDB(db);
  await logEvent(guildId, 'moderation', 'One-click server setup', steps.map((s) => '• ' + s).join('\n').slice(0, 1900), warnings.length ? 0xf59e0b : 0x2997ff);
  return { steps, warnings };
}

/* Global lockdown: deny @everyone send everywhere (raid mode core move). */
async function toggleGlobalLockdown(guildId, on) {
  await assertBotCan(guildId, PERM.MANAGE_CH, 'lockdown');
  const channels = await discordFetch(`/guilds/${guildId}/channels`);
  let touched = 0;
  for (const ch of channels) {
    if (ch.type !== 0) continue;
    const overwrites = Array.isArray(ch.permission_overwrites) ? ch.permission_overwrites.slice() : [];
    const idx = overwrites.findIndex((o) => o.id === guildId && o.type === 0);
    const allow = BigInt(idx >= 0 ? (overwrites[idx].allow || '0') : '0');
    let deny = BigInt(idx >= 0 ? (overwrites[idx].deny || '0') : '0');
    const before = deny;
    if (on) deny |= 2048n; else deny &= ~2048n;
    if (deny === before) continue;
    if (idx >= 0) overwrites[idx] = { id: guildId, type: 0, allow: on ? (allow & ~2048n).toString() : allow.toString(), deny: deny.toString() };
    else overwrites.push({ id: guildId, type: 0, allow: '0', deny: deny.toString() });
    try { await discordFetch(`/channels/${ch.id}`, { method: 'PATCH', body: JSON.stringify({ permission_overwrites: overwrites }) }); touched++; } catch (e) {}
  }
  return touched;
}

async function postTicketEmbed(guildId, channelId, title, description) {
  // Validate the channel against the live guild before posting — this is what
  // turns Discord's bare "Unknown Channel" into a fixable message.
  const cleanId = String(channelId || '').trim();
  // Real Discord ids are snowflakes; test fixtures use short ids. Either way
  // the character allow-list blocks URL path traversal — no '/', '.', ':' or
  // anything non-alphanumeric can ever reach the fetch URL.
  if (!/^(\d{17,20}|[A-Za-z0-9_-]{1,32})$/.test(cleanId)) {
    throw new Error('Pick a channel first — the selected channel id is invalid.');
  }
  const channels = await discordFetch(`/guilds/${guildId}/channels`);
  const target = (Array.isArray(channels) ? channels : []).find((c) => c.id === cleanId);
  if (!target) {
    throw new Error('That channel no longer exists (it may have been deleted) — refresh the page and pick a channel again.');
  }
  if (target.type !== 0 && target.type !== 5 && target.type !== 15) {
    throw new Error(`#${target.name} is not a postable channel (categories and voice channels can't hold buttons) — pick a text channel.`);
  }
  const payload = {
    embeds: [{
      title: title || '🎫 Support Tickets',
      description: description || 'Press **Open Ticket** to get a private channel with the staff team.\nAbuse of tickets leads to a timeout.',
      color: 0x2997ff,
      footer: { text: 'Kyro Staff Bot' }
    }],
    components: [{ type: 1, components: [{ type: 2, style: 1, label: 'Open Ticket', custom_id: `kyro-ticket:open:${guildId}` }] }]
  };
  // Forum channels need a thread name to create the post.
  if (target.type === 15) payload.thread_name = (title || '🎫 Support Tickets').slice(0, 100);
  let msg;
  try {
    msg = await discordFetch(`/channels/${cleanId}/messages`, { method: 'POST', body: JSON.stringify(payload) });
  } catch (err) {
    if (err.status === 404 || err.code === 10003 || /unknown channel/i.test(String(err.message))) {
      throw new Error(`#${target.name} is not reachable — the bot is missing View Channel access there. Check the channel's permission overwrites, then try again.`);
    }
    if (err.status === 403) {
      throw new Error(`The bot can't post in #${target.name} (missing Send Messages / View Channel). Fix the channel permissions and try again.`);
    }
    throw err;
  }
  await logEvent(guildId, 'moderation', 'Ticket system posted', `**Channel:** <#${cleanId}>\n**Message:** ${msg.id}`, 0x2997ff);
  return msg;
}

async function massBan(guildId, ids, reason, deleteDays) {
  const reasonHeader = { 'X-Audit-Log-Reason': String(reason || 'Kyro mass ban').slice(0, 400) };
  const results = { banned: [], failed: [] };
  for (const id of ids) {
    try {
      await dmPunished(guildId, id, 'ban', reason || 'Mass ban', '', { withAppeal: true });
    } catch (e) {}
    try {
      await discordFetch(`/guilds/${guildId}/bans/${id}`, { method: 'PUT', headers: reasonHeader, body: JSON.stringify({ delete_message_seconds: Math.min(Number(deleteDays) || 0, 7) * 86400 }) });
      results.banned.push(id);
    } catch (e) { results.failed.push(id); }
  }
  await logEvent(guildId, 'moderation', 'Mass ban executed', `**Banned:** ${results.banned.length}\n**Failed:** ${results.failed.length}\n**Reason:** ${reason || 'No reason'}`, 0x7f1d1d);
  return results;
}

/* Mod activity leaderboard from the local audit trail. */
function modStats(guildId) {
  const db = loadDB();
  const g = guildConfig(db, guildId);
  const counts = {};
  for (const a of g.audit || []) {
    const who = a.moderator || a.action && a.action !== 'automod' ? a.moderator : null;
    if (!who || who === 'Dashboard') continue;
    counts[who] = counts[who] || { actions: 0, last: a.created_at };
    counts[who].actions++;
    if (a.created_at > counts[who].last) counts[who].last = a.created_at;
  }
  return Object.entries(counts).map(([moderator, s]) => ({ moderator, actions: s.actions, last: s.last })).sort((a, b) => b.actions - a.actions);
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
  if (action === 'softban') {
    // Ban + immediate unban: removes a member and their recent messages without the full ban.
    await dmPunished(guildId, userId, 'ban', `${reason || 'Softban'} (ban will be lifted automatically)`, body.serverName);
    await discordFetch(`/guilds/${guildId}/bans/${userId}`, { method: 'PUT', headers: reasonHeader, body: JSON.stringify({ delete_message_seconds: 86400 }) });
    await discordFetch(`/guilds/${guildId}/bans/${userId}`, { method: 'DELETE', headers: reasonHeader });
    return finish(`Softbanned <@${userId}> — messages purged, they can rejoin.`);
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
    // Warning escalation for big teams: at N warnings the bot punishes automatically.
    const we = (g.security && g.security.warnEscalation) || {};
    if (we.enabled !== false && (we.timeoutAt || we.kickAt || we.banAt)) {
      const count = g.warnings.filter((w) => w.userId === userId).length;
      const name = body.serverName || 'the server';
      try {
        if (we.banAt && count >= Number(we.banAt)) {
          await dmPunished(guildId, userId, 'ban', `Reached ${count} warnings in ${name}.`, name, { withAppeal: true });
          await discordFetch(`/guilds/${guildId}/bans/${userId}`, { method: 'PUT', headers: reasonHeader, body: JSON.stringify({ delete_message_seconds: 0 }) });
          await logEvent(guildId, 'moderation', 'Warning escalation • banned', `<@${userId}> hit **${count} warnings** and was banned automatically.`, 0x7f1d1d);
          return { ok: true, message: `Warned <@${userId}> — **${count} warnings** triggered an automatic ban.` };
        }
        if (we.kickAt && count >= Number(we.kickAt)) {
          await dmPunished(guildId, userId, 'kick', `Reached ${count} warnings in ${name}.`, name);
          await discordFetch(`/guilds/${guildId}/members/${userId}`, { method: 'DELETE', headers: reasonHeader });
          await logEvent(guildId, 'moderation', 'Warning escalation • kicked', `<@${userId}> hit **${count} warnings** and was kicked automatically.`, 0xed4245);
          return { ok: true, message: `Warned <@${userId}> — **${count} warnings** triggered an automatic kick.` };
        }
        if (we.timeoutAt && count >= Number(we.timeoutAt)) {
          const secs = Math.min(Math.max(Number(we.timeoutMinutes) || 120, 1), 40320) * 60;
          await discordFetch(`/guilds/${guildId}/members/${userId}`, { method: 'PATCH', headers: reasonHeader, body: JSON.stringify({ communication_disabled_until: new Date(Date.now() + secs * 1000).toISOString() }) });
          await dmPunished(guildId, userId, 'timeout', `Reached ${count} warnings in ${name}.`, name);
          await logEvent(guildId, 'moderation', 'Warning escalation • timeout', `<@${userId}> hit **${count} warnings** and was timed out automatically.`, 0xed4245);
          return { ok: true, message: `Warned <@${userId}> — **${count} warnings** triggered an automatic timeout.` };
        }
      } catch (e) {}
    }
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
      ? (winnerIds && winnerIds.length
        ? `**Giveaway finished — these are the winners:**\n${winnerIds.map((id) => `<@${id}>`).join(', ')}`
        : '**Giveaway finished — no valid entries.**')
      : `**Ends:** <t:${endsUnix}:R> (<t:${endsUnix}:f>)`,
    '',
    ended ? '🔒 This giveaway is closed.' : 'React with 🎉 to enter!'
  ].filter((x) => x !== null).join('\n');
  return {
    title: `🎉 ${gv.prize}`.slice(0, 256),
    description: desc.slice(0, 4000),
    color: ended ? 0x95a5a6 : 0x57f287,
    footer: { text: `${gv.entrants ? gv.entrants.length : 0} entries • Kyro Giveaways` },
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

/* Adopt giveaway posts that already exist in Discord but are not in the local
   DB (e.g. created before a DB reset). Without this the dashboard shows "no
   giveaways", never recounts entries and never ends the post. Scans recent
   messages of every text-like channel for the bot's own giveaway embeds. */
async function syncGiveawaysFromDiscord(guildId) {
  // The poller holds a DB snapshot for the whole tick and saves it at the end;
  // adopting mid-tick would be clobbered by that stale save. Wait for the tick
  // to finish, then hold the poller flag so no tick starts under us.
  await pollPromise.catch(() => {});
  while (polling) await new Promise((r) => setTimeout(r, 100));
  polling = true;
  try {
    const botId = await getBotUserId();
  const channels = await discordFetch(`/guilds/${guildId}/channels`);
  const db = loadDB();
  const g = guildConfig(db, guildId);
  g.giveaways = g.giveaways || [];
  const tracked = new Set(g.giveaways.map((x) => x.message_id));
  const adopted = [];
  for (const ch of (Array.isArray(channels) ? channels : [])) {
    if (![0, 5, 15].includes(ch.type)) continue;
    let msgs = [];
    try { msgs = await discordFetch(`/channels/${ch.id}/messages?limit=30`); } catch (e) { continue; }
    for (const m of (Array.isArray(msgs) ? msgs : [])) {
      if (!m.author || m.author.id !== botId || tracked.has(m.id)) continue;
      const emb = (m.embeds || [])[0];
      if (!emb) continue;
      const isGv = /GIVEAWAY/i.test(m.content || '') || /Giveaways$/i.test((emb.footer && emb.footer.text) || '');
      if (!isGv) continue;
      const descText = String(emb.description || '');
      const winnersMatch = /\*\*Winners:\*\*\s*(\d+)/.exec(descText);
      const endsAt = emb.timestamp ? Date.parse(emb.timestamp) : Date.now();
      let entrants = [];
      try { entrants = (await getReactionUsers(ch.id, m.id, '🎉')).filter((u) => u.id !== botId).map((u) => u.id); } catch (e) {}
      const gv = {
        id: uid(), channel: ch.id, message_id: m.id,
        prize: String(emb.title || '').replace(/^🎉\s*/, '').trim() || 'Giveaway',
        description: (descText.split('\n')[0] || '').slice(0, 1000),
        winners: winnersMatch ? Math.min(Math.max(parseInt(winnersMatch[1], 10) || 1, 1), 20) : 1,
        ends_at: isNaN(endsAt) ? Date.now() : endsAt,
        ended: /closed|finished|has ended/i.test(descText),
        entrants, winnerIds: [], created_at: m.timestamp || new Date().toISOString()
      };
      g.giveaways.unshift(gv);
      tracked.add(m.id);
      adopted.push(gv.prize);
    }
  }
  saveDB(db);
  return { adopted };
  } finally { polling = false; }
}

/* Host an embed image by uploading it to Discord as a attachment in a private
   storage channel. The returned cdn.discordapp.com URL is public and permanent,
   so embeds render without the owner needing any external image host or URL. */
const EMBED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const EMBED_IMAGE_MAX = 8 * 1024 * 1024;
async function uploadEmbedImage(guildId, opts) {
  if (!BOT_TOKEN) throw Object.assign(new Error('Bot token missing.'), { status: 500 });
  const contentType = String(opts.contentType || '').toLowerCase();
  if (!EMBED_IMAGE_TYPES.has(contentType)) throw Object.assign(new Error('Only PNG, JPEG, GIF or WebP images are supported.'), { status: 400 });
  const buf = Buffer.from(String(opts.dataBase64 || ''), 'base64');
  if (!buf.length) throw Object.assign(new Error('Empty image.'), { status: 400 });
  if (buf.length > EMBED_IMAGE_MAX) throw Object.assign(new Error('Image is larger than 8 MB.'), { status: 400 });
  const channels = await discordFetch(`/guilds/${guildId}/channels`);
  const list = Array.isArray(channels) ? channels : [];
  const host = list.find((c) => c.type === 0 && /asset-storage|vault-asset/.test(c.name))
    || list.find((c) => c.type === 0 && /mod-log|transcript-log/.test(c.name))
    || list.find((c) => c.type === 0);
  if (!host) throw Object.assign(new Error('No channel available to host the image.'), { status: 500 });
  const filename = String(opts.filename || 'image.png').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'image.png';
  const form = new FormData();
  form.append('payload_json', JSON.stringify({ allowed_mentions: { parse: [] } }));
  form.append('files[0]', new Blob([buf], { type: contentType }), filename);
  const res = await fetch(`https://discord.com/api/v10/channels/${host.id}/messages`, {
    method: 'POST', headers: { Authorization: `Bot ${BOT_TOKEN}` }, body: form
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.message || `Discord HTTP ${res.status}`), { status: res.status });
  const url = data.attachments && data.attachments[0] && data.attachments[0].url;
  if (!url) throw Object.assign(new Error('Discord did not return an image URL.'), { status: 502 });
  return { url };
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

/* ----------------------------- honeypot ----------------------------------
   A decoy channel no real member should ever post in. Anything written there
   is treated as bot or spam traffic: the message is deleted and the author is
   kicked, banned or timed out. Staff roles and the exempt list are never
   punished, so a moderator can safely test the trap. Driven by the poller, so
   it needs no gateway connection. */
async function runHoneypot(guildId, g, opts = {}) {
  const hp = g.honeypot;
  if (!hp || !hp.enabled || !hp.channelId) return false;
  hp.seen = Array.isArray(hp.seen) ? hp.seen : [];
  const seen = new Set(hp.seen);
  let msgs = [];
  try { msgs = await discordFetch(`/channels/${hp.channelId}/messages?limit=${opts.limit || 20}`); } catch (e) { return false; }
  if (!Array.isArray(msgs)) return false;

  // Protected roles: the exempt list plus anything staff-level, so the trap
  // cannot punish a moderator who clicks into the channel by accident.
  let protectedRoles = new Set((hp.exemptRoles || []).map(String));
  try {
    const roles = await discordFetch(`/guilds/${guildId}/roles`);
    for (const r of (Array.isArray(roles) ? roles : [])) {
      if (r.id === guildId) continue;
      const p = BigInt(r.permissions || '0');
      if ((p & (PERM.ADMIN | PERM.MANAGE_GUILD | PERM.MANAGE_ROLES | PERM.MANAGE_CH | PERM.BAN | PERM.KICK)) !== 0n) protectedRoles.add(r.id);
      else if (/(owner|admin|moderator|\bmod\b|staff|support|helpdesk)/i.test(r.name)) protectedRoles.add(r.id);
    }
  } catch (e) {}

  const botId = await getBotUserId();
  let changed = false;
  for (const msg of msgs) {
    if (!msg.id || seen.has(msg.id)) continue;
    seen.add(msg.id);
    changed = true;
    if (!msg.author || !msg.author.id) continue;
    if (msg.author.bot || msg.author.id === botId) continue;
    const memberRoles = (msg.member && msg.member.roles) || [];
    if (memberRoles.some((rid) => protectedRoles.has(String(rid)))) continue;

    try { await discordFetch(`/channels/${hp.channelId}/messages/${msg.id}`, { method: 'DELETE', headers: { 'X-Audit-Log-Reason': 'Honeypot: message in a trap channel' } }); } catch (e) {}

    const reason = hp.reason || 'Honeypot trap triggered';
    const action = ['ban', 'kick', 'timeout'].includes(hp.action) ? hp.action : 'kick';
    let done = action;
    try {
      if (action === 'ban') {
        await discordFetch(`/guilds/${guildId}/bans/${msg.author.id}`, {
          method: 'PUT', headers: { 'X-Audit-Log-Reason': 'Honeypot: ' + reason },
          body: JSON.stringify({ delete_message_seconds: 86400 })
        });
      } else if (action === 'kick') {
        await discordFetch(`/guilds/${guildId}/members/${msg.author.id}`, { method: 'DELETE', headers: { 'X-Audit-Log-Reason': 'Honeypot: ' + reason } });
      } else {
        const until = new Date(Date.now() + Math.min(Math.max(Number(hp.timeoutSeconds) || 600, 60), 2419200) * 1000).toISOString();
        await discordFetch(`/guilds/${guildId}/members/${msg.author.id}`, {
          method: 'PATCH', headers: { 'X-Audit-Log-Reason': 'Honeypot: ' + reason },
          body: JSON.stringify({ communication_disabled_until: until })
        });
      }
    } catch (err) {
      done = 'failed (' + (err.message || 'no permission') + ')';
    }
    try { await dmPunished(guildId, msg.author.id, action, reason, g.serverName, action === 'ban'); } catch (e) {}
    hp.total = (Number(hp.total) || 0) + 1;
    hp.last_at = Date.now();
    hp.last_user = msg.author.username || msg.author.id;
    await logEvent(guildId, 'automod', '🍯 Honeypot caught a member',
      `**User:** <@${msg.author.id}> (\`${msg.author.username || msg.author.id}\`)\n**Channel:** <#${hp.channelId}>\n**Action:** ${done}\n**Message:** ${String(msg.content || '[attachment]').slice(0, 300)}`, 0xf59e0b);
  }
  hp.seen = [...seen].slice(-400);
  // Keep the posted explainer/stats panel current — one edit, and only when the
  // trap actually caught somebody.
  if (changed && hp.panelMessageId) {
    try { await postHoneypotPanel(guildId, g); } catch (e) {}
  }
  return changed;
}

/* The honeypot channel carries its own explanation and live counters, so staff
   (and anyone who wanders in) can see what the trap is and how it is doing
   without opening the dashboard. The message is edited in place on every catch. */
function escapeMarkdown(value) {
  return String(value == null ? '' : value).replace(/[*_~`|>\\]/g, (c) => '\\' + c).slice(0, 80);
}

function honeypotPanelPayload(g) {
  const hp = g.honeypot || {};
  const minutes = Math.max(1, Math.round((Number(hp.timeoutSeconds) || 600) / 60));
  const verb = hp.action === 'ban' ? 'banned' : hp.action === 'timeout' ? 'timed out for ' + minutes + ' minutes' : 'kicked';
  const total = Number(hp.total) || 0;
  const channel = hp.channelId ? '<#' + hp.channelId + '>' : 'not set yet';
  const last = hp.last_at
    ? '<t:' + Math.floor(Number(hp.last_at) / 1000) + ':R>' + (hp.last_user ? ' · **' + escapeMarkdown(hp.last_user) + '**' : '')
    : 'Nothing caught yet';
  return {
    embeds: [
      {
        title: '🍯 What is a Honeypot?',
        description: 'A **honeypot** is a channel used to detect unwanted activity.\n\n' +
          'Kyro watches a channel that is visible to members but not intended for normal use. ' +
          'Spam bots and compromised accounts often post in it while scanning or messaging across a server.\n\n' +
          'When a message is sent to ' + channel + ', Kyro deletes it and the author is **' + verb + '**. ' +
          'Staff roles are always exempt, so a moderator can test the trap safely.',
        color: 0xf59e0b
      },
      {
        title: '🍯 Honeypot Statistics',
        fields: [
          { name: 'Server Stats', value: '• Total moderated in this server: **' + total + '**\n• Trap channel: ' + channel + '\n• Action on trigger: **' + verb + '**', inline: false },
          { name: 'Last Trigger', value: last, inline: false },
          { name: 'Trap Settings', value: '• Detection: background scan (no gateway needed)\n• Protected: @everyone with staff permissions, bots and the bot itself\n• Audit reason: ' + escapeMarkdown(hp.reason || 'Honeypot trap triggered'), inline: false }
        ],
        color: 0x2997ff,
        footer: { text: 'Kyro Honeypot · this panel updates automatically' },
        timestamp: new Date().toISOString()
      }
    ],
    allowed_mentions: { parse: [] }
  };
}

async function postHoneypotPanel(guildId, g) {
  const hp = g && g.honeypot;
  if (!hp || !hp.channelId) throw new Error('Pick a honeypot channel first.');
  const payload = honeypotPanelPayload(g);
  if (hp.panelMessageId) {
    try {
      return await discordFetch(`/channels/${hp.channelId}/messages/${hp.panelMessageId}`, {
        method: 'PATCH', body: JSON.stringify(payload)
      });
    } catch (err) {
      // The panel was deleted by hand — post a fresh one instead of failing.
      hp.panelMessageId = '';
    }
  }
  const message = await discordFetch(`/channels/${hp.channelId}/messages`, {
    method: 'POST', body: JSON.stringify(payload)
  });
  hp.panelMessageId = message.id;
  return message;
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

async function sendLeave(guildId, l, member, guildName, memberCount) {
  if (!l || !l.enabled || !l.channelId) return;
  const text = formatWelcome(l.message, member, guildName, memberCount);
  const payload = l.useEmbed
    ? { embeds: [{ description: text.slice(0, 4000), color: hexToInt(l.embedColor), footer: { text: `Member #${memberCount || '?'}` }, timestamp: new Date().toISOString() }] }
    : { content: text.slice(0, 2000) };
  try { await discordFetch(`/channels/${l.channelId}/messages`, { method: 'POST', body: JSON.stringify(payload) }); } catch (e) {}
}

async function runWelcomeGuild(guildId, g) {
  const w = g.welcome;
  const l = g.leave || (g.leave = {});
  if ((!w.enabled || !w.channelId) && (!l.enabled || !l.channelId)) return { joined: 0, left: 0 };
  let guild, members;
  try {
    guild = await discordFetch(`/guilds/${guildId}?with_counts=true`);
    members = await discordFetch(`/guilds/${guildId}/members?limit=1000`);
  } catch (e) {
    // Requires the privileged Server Members intent; degrade quietly if absent.
    return { joined: 0, left: 0, note: `Member list unavailable: ${e.message}. Enable the Server Members intent in the Discord Developer Portal (Bot → Privileged Gateway Intents).` };
  }
  if (!Array.isArray(members)) return { joined: 0, left: 0, note: 'Member list unavailable: unexpected Discord response.' };
  const botId = await getBotUserId();
  const ids = members.filter((m) => m.user && m.user.id !== botId).map((m) => m.user.id);
  l.knownNames = l.knownNames || {};
  for (const m of members) if (m.user && m.user.id !== botId) l.knownNames[m.user.id] = m.user.username || l.knownNames[m.user.id] || 'member';
  if (!w.seeded) {
    w.knownMembers = ids;
    w.seeded = true;
    return { joined: 0, left: 0 };
  }
  const known = new Set(w.knownMembers || []);
  const fresh = ids.filter((id) => !known.has(id));
  for (const userId of fresh) {
    const member = members.find((m) => m.user && m.user.id === userId);
    if (w.enabled && w.channelId) await sendWelcome(guildId, w, member, guild.name, guild.approximate_member_count || ids.length);
    await logEvent(guildId, 'joins', 'Member joined', `**User:** <@${userId}> (${member && member.user ? member.user.username : userId})\n**Member count:** ${guild.approximate_member_count || ids.length}`, 0x57f287);
  }
  // A truncated member list (1000 cap) would look like mass departures, so
  // leave detection only runs when the snapshot is provably complete.
  if (ids.length < 1000) {
    const current = new Set(ids);
    const gone = (w.knownMembers || []).filter((id) => !current.has(id));
    for (const userId of gone) {
      const member = { user: { id: userId, username: l.knownNames[userId] || 'member' } };
      await sendLeave(guildId, l, member, guild.name, guild.approximate_member_count || ids.length);
      await logEvent(guildId, 'welcome', 'Member left', `**User:** ${l.knownNames[userId] || userId} (<@${userId}>)\n**Member count:** ${guild.approximate_member_count || ids.length}`, 0x95a5a6);
      delete l.knownNames[userId];
    }
    w.knownMembers = ids;
    return { joined: fresh.length, left: gone.length };
  }
  w.knownMembers = ids;
  return { joined: fresh.length, left: 0 };
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Big-team security: raid watch, anti-nuke, keyword alerts
// ---------------------------------------------------------------------------
const NUKE_ACTIONS = { 12: 'channel deleted', 32: 'role deleted', 22: 'member banned', 50: 'webhook created', 52: 'webhook deleted' };

/* Sudden join spikes (mass-join raids) trip raid mode: global lockdown + alert. */
async function runRaidWatch(guildId, g) {
  const sec = g.security || (g.security = {});
  if (!sec.autoRaid || sec.raidMode) return;
  const members = await discordFetch(`/guilds/${guildId}/members?limit=1000`);
  const cutoff = Date.now() - 60 * 1000;
  const recentJoins = (Array.isArray(members) ? members : []).filter((m) => m.joined_at && Date.parse(m.joined_at) >= cutoff);
  sec.recentJoins = recentJoins.length;
  if (recentJoins.length < (Number(sec.raidThreshold) || 10)) return;
  if (sec.raidCooldown && Date.now() < sec.raidCooldown) return;
  sec.raidCooldown = Date.now() + 10 * 60 * 1000;
  const touched = await toggleGlobalLockdown(guildId, true);
  sec.raidMode = true;
  await logEvent(guildId, 'security', '🚨 RAID DETECTED — server locked', `**${recentJoins.length} members joined in under a minute** (threshold ${sec.raidThreshold}).\n**Locked:** ${touched} channels.\nTurn *Raid Mode* off in the Security tab to unlock once it is clear.`, 0x7f1d1d);
}

/* Rogue admin detection: strips every role from (and optionally bans) anyone who
   deletes channels/roles, mass-bans members or creates webhooks at attack speed. */
async function runAntiNuke(guildId, g) {
  const sec = g.security || (g.security = {});
  if (!sec.antiNuke) return;
  const [guild, logs] = await Promise.all([
    discordFetch(`/guilds/${guildId}`),
    discordFetch(`/guilds/${guildId}/audit-logs?limit=50`)
  ]);
  const botId = await getBotUserId();
  const cutoff = Date.now() - 5 * 60 * 1000;
  const byUser = {};
  for (const e of logs.audit_log_entries || []) {
    if (!NUKE_ACTIONS[e.action_type] || !e.user_id) continue;
    const who = e.user_id;
    if (who === guild.owner_id || who === botId) continue; // owner and the bot itself are trusted
    const when = Number((BigInt(e.id) >> 22n) + 1420070400000n);
    if (when < cutoff) continue;
    (byUser[who] = byUser[who] || []).push(NUKE_ACTIONS[e.action_type]);
  }
  for (const [who, acts] of Object.entries(byUser)) {
    if (acts.length < (Number(sec.antiNukeThreshold) || 3)) continue;
    const windowKey = Math.floor(Date.now() / (30 * 60 * 1000));
    sec.nukeCooldown = sec.nukeCooldown || {};
    if (sec.nukeCooldown[who] === windowKey) continue;
    sec.nukeCooldown[who] = windowKey;
    let demoted = false, banned = false;
    try {
      const member = await discordFetch(`/guilds/${guildId}/members/${who}`);
      for (const rid of member.roles || []) {
        try { await discordFetch(`/guilds/${guildId}/members/${who}/roles/${rid}`, { method: 'DELETE', headers: { 'X-Audit-Log-Reason': 'Kyro anti-nuke: demotion' } }); } catch (e) {}
      }
      demoted = (member.roles || []).length > 0;
    } catch (e) {}
    if (sec.antiNukeBan) {
      try {
        await dmPunished(guildId, who, 'ban', 'Anti-nuke: repeated destructive actions detected.', '', { withAppeal: true });
        await discordFetch(`/guilds/${guildId}/bans/${who}`, { method: 'PUT', headers: { 'X-Audit-Log-Reason': 'Kyro anti-nuke' }, body: JSON.stringify({ delete_message_seconds: 0 }) });
        banned = true;
      } catch (e) {}
    }
    await logEvent(guildId, 'security', '🛡️ ANTI-NUKE triggered', `**Member:** <@${who}>\n**Suspicious actions (5 min):** ${acts.length} × ${[...new Set(acts)].join(', ')}\n**Taken:** ${demoted ? 'all roles stripped' : 'no roles to strip'}${banned ? ' + **banned**' : ''}`, 0x7f1d1d);
  }
}

/* Sensitive-term alerts (self-harm, scams, doxxing bait) surfaced to #mod-log. */
async function runKeywordAlerts(guildId, g) {
  const sec = g.security || (g.security = {});
  if (!sec.keywordAlerts || !Array.isArray(sec.keywords) || !sec.keywords.length) return;
  const channels = (g.automod && g.automod.channels) || [];
  if (!channels.length) return;
  const logChannelId = g.logging && g.logging.enabled && g.logging.channelId;
  sec.alerted = sec.alerted || [];
  const seen = new Set(sec.alerted.slice(-300));
  let hitAny = false;
  for (const channelId of channels) {
    let msgs = [];
    try { msgs = await discordFetch(`/channels/${channelId}/messages?limit=10`); } catch (e) { continue; }
    for (const msg of msgs) {
      if (!msg.id || seen.has(msg.id)) continue;
      seen.add(msg.id);
      const content = String(msg.content || '');
      const hit = sec.keywords.find((k) => k && content.toLowerCase().includes(String(k).toLowerCase()));
      if (!hit) continue;
      hitAny = true;
      if (logChannelId) {
        try {
          await discordFetch(`/channels/${logChannelId}/messages`, {
            method: 'POST',
            body: JSON.stringify({
              embeds: [{
                title: '🚨 Keyword alert',
                description: `**Channel:** <#${channelId}>\n**Author:** <@${msg.author ? msg.author.id : '?'}> (${msg.author ? msg.author.username : ''})\n**Keyword:** ${hit}\n**Message:** ${content.slice(0, 300)}\n[Jump to message](https://discord.com/channels/${guildId}/${channelId}/${msg.id})`,
                color: 0xff9f0a,
                timestamp: new Date().toISOString()
              }]
            })
          });
        } catch (e) {}
      }
    }
  }
  sec.alerted = [...seen].slice(-300);
  if (hitAny) saveDB(loadDB());
}

// ---------------------------------------------------------------------------
// Engagement suite: auto-role, join DM, starboard, voice role, boosts,
// AFK, sticky messages, auto-responses, scheduled posts, suggestions
// ---------------------------------------------------------------------------
const BOOST_TYPES = new Set([7, 8, 9, 10]);

/* One shared message scan feeding starboard, auto-responses, AFK and boosts. */
async function scanGuildMessages(guildId, g, channelIds) {
  const eng = g.engagement || (g.engagement = {});
  const sb = eng.starboard || {};
  const resp = Array.isArray(g.autoResponses) ? g.autoResponses : [];
  const afk = eng.afk || {};
  const boosts = eng.boosts || {};
  const lv = g.levels || {};
  const sug = g.suggestions || {};
  const starHits = [];
  let hitSomething = false;
  for (const channelId of channelIds) {
    let msgs = [];
    try { msgs = await discordFetch(`/channels/${channelId}/messages?limit=10`); } catch (e) { continue; }
    for (const msg of msgs) {
      if (!msg.id) continue;
      // 1. Starboard: reaction count above threshold on a non-bot message
      if (sb.enabled && sb.channelId && msg.author && !msg.author.bot && !(sb.processed || []).includes(msg.id)) {
        const wanted = String(sb.emoji || '⭐');
        const reaction = (msg.reactions || []).find((r) => r.emoji.name === wanted && !r.me);
        if (reaction && reaction.count >= (Number(sb.threshold) || 3)) {
          starHits.push({ msg, channel: channelId });
          sb.processed = (sb.processed || []).concat(msg.id).slice(-300);
          hitSomething = true;
        }
      }
      // 2. Auto-responses: trigger word → canned reply (once per message)
      if (resp.length && msg.author && !msg.author.bot) {
        const hit = resp.find((r) => r.trigger && new RegExp(`\\b${r.trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(String(msg.content || '')));
        if (hit && !(g.respondedIds || []).includes(msg.id)) {
          try {
            await discordFetch(`/channels/${channelId}/messages`, { method: 'POST', body: JSON.stringify({ content: hit.reply, message_reference: { message_id: msg.id }, allowed_mentions: { parse: [] } }) });
            g.respondedIds = (g.respondedIds || []).concat(msg.id).slice(-200);
            hitSomething = true;
          } catch (e) {}
        }
      }
      // 3. AFK: someone mentions the AFK member → tell them why
      if (afk.enabled && afk.userId && msg.author && msg.author.id !== afk.userId && !(afk.answered || []).includes(msg.id)) {
        const mentions = String(msg.content || '').includes(`<@${afk.userId}>`);
        if (mentions) {
          try {
            await discordFetch(`/channels/${channelId}/messages`, { method: 'POST', body: JSON.stringify({ content: `📭 <@${afk.userId}> is AFK${afk.reason ? `: ${afk.reason}` : ''}.`, allowed_mentions: { parse: [] }, message_reference: { message_id: msg.id } }) });
            afk.answered = (afk.answered || []).concat(msg.id).slice(-200);
            hitSomething = true;
          } catch (e) {}
        }
      }
      // 4. Levels: award XP per new message with a per-member cooldown
      if (lv.enabled && msg.author && !msg.author.bot && msg.id) {
        lv.users = lv.users || {};
        lv.seen = Array.isArray(lv.seen) ? lv.seen : [];
        if (!lv.seen.includes(msg.id)) {
          lv.seen.push(msg.id);
          if (lv.seen.length > 600) lv.seen = lv.seen.slice(-600);
          const who = msg.author.id;
          const st = (lv.users[who] = lv.users[who] || { xp: 0, level: 0, last: 0 });
          if (Date.now() - Number(st.last || 0) >= (Number(lv.cooldownSeconds) || 60) * 1000) {
            st.last = Date.now();
            st.xp = Number(st.xp || 0) + randomBetween(lv.minXp, lv.maxXp);
            hitSomething = true; // persist the new XP even without a level-up
            const newLevel = levelForXp(st.xp);
            if (newLevel > Number(st.level || 0)) {
              st.level = newLevel;
              await announceLevelUp(guildId, g, who, newLevel);
            }
          }
        }
      }
      // 5. Suggestion channel: repost member messages as votable embeds
      if (sug.enabled && sug.channelId === channelId && msg.author && !msg.author.bot && msg.id) {
        sug.processed = Array.isArray(sug.processed) ? sug.processed : [];
        if (!sug.processed.includes(msg.id)) {
          sug.processed.push(msg.id);
          if (sug.processed.length > 300) sug.processed = sug.processed.slice(-300);
          try {
            const posted = await discordFetch(`/channels/${channelId}/messages`, {
              method: 'POST',
              body: JSON.stringify({
                embeds: [{
                  author: { name: msg.author.global_name || msg.author.username || 'Suggestion' },
                  description: String(msg.content || '').slice(0, 3500) || '_(no text)_',
                  color: 0x30d158,
                  footer: { text: '💡 Vote with 👍 / 👎' },
                  timestamp: msg.timestamp
                }]
              })
            });
            for (const emoji of ['👍', '👎']) {
              try { await discordFetch(`/channels/${channelId}/messages/${posted.id}/reactions/${encodeURIComponent(emoji)}/@me`, { method: 'PUT' }); } catch (e) {}
            }
            try { await discordFetch(`/channels/${channelId}/messages/${msg.id}`, { method: 'DELETE' }); } catch (e) {}
            hitSomething = true;
          } catch (e) {}
        }
      }
      // 6. Boost detection in the announcements/welcome channel
      if (boosts.enabled && boosts.channelId && channelId === boosts.channelId && BOOST_TYPES.has(msg.type) && !(boosts.processed || []).includes(msg.id)) {
        try {
          await discordFetch(`/channels/${boosts.channelId}/messages`, {
            method: 'POST',
            body: JSON.stringify({
              embeds: [{
                title: '🚀 New Server Boost!',
                description: `**${msg.author && msg.author.username ? msg.author.username : 'Someone'}** just boosted the server!\nThank you — perks unlocked for everyone 💜`,
                color: 0xf47fff,
                timestamp: new Date().toISOString()
              }]
            })
          });
          boosts.processed = (boosts.processed || []).concat(msg.id).slice(-100);
          hitSomething = true;
        } catch (e) {}
      }
    }
    // 7. Sticky message: re-post after someone chats
    const sticky = eng.sticky;
    if (sticky && sticky.enabled && sticky.channelId === channelId && sticky.content) {
      const latest = msgs[0];
      if (latest && !BOOST_TYPES.has(latest.type)) {
        const botPosted = latest.author && latest.author.id === botUserId && latest.id === sticky.messageId;
        const userChatted = latest.author && latest.author.id !== botUserId;
        if (userChatted && latest.id !== sticky.lastChat) {
          sticky.lastChat = latest.id;
          if (sticky.messageId) { try { await discordFetch(`/channels/${channelId}/messages/${sticky.messageId}`, { method: 'DELETE' }); } catch (e) {} }
          try {
            const posted = await discordFetch(`/channels/${channelId}/messages`, { method: 'POST', body: JSON.stringify({ content: sticky.content, allowed_mentions: { parse: [] } }) });
            sticky.messageId = posted.id;
            hitSomething = true;
          } catch (e) {}
        } else if (botPosted) {
          sticky.lastChat = '';
        }
      }
    }
  }
  // Starboard posts are made after the scan so the embed is one call per hit
  for (const hit of starHits) {
    try {
      await discordFetch(`/channels/${sb.channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          embeds: [{
            author: { name: 'Starboard' },
            title: `⭐ ${hit.msg.reactions.find((r) => r.emoji.name === String(sb.emoji || '⭐')).count} stars`,
            description: `${hit.msg.content ? hit.msg.content.slice(0, 1000) : '_(no text)_'}\n\n[Jump to message](https://discord.com/channels/${guildId}/${hit.channel}/${hit.msg.id})`,
            color: 0xffd700,
            footer: { text: `posted by ${hit.msg.author ? hit.msg.author.username : 'unknown'}` },
            timestamp: hit.msg.timestamp
          }]
        })
      });
    } catch (e) {}
  }
  return hitSomething;
}

/* Auto-role + join DM: watch for members that joined since the last tick. */
async function runEngagementGuild(guildId, g) {
  const eng = g.engagement || (g.engagement = {});
  let touched = false;
  const needsMemberScan = (eng.autoRole && eng.autoRole.enabled) || (eng.joinDm && eng.joinDm.enabled);
  if (needsMemberScan) {
    const members = await discordFetch(`/guilds/${guildId}/members?limit=1000`);
    const cutoff = Date.now() - 15 * 60 * 1000;
    const fresh = (Array.isArray(members) ? members : []).filter((m) => m.joined_at && Date.parse(m.joined_at) >= cutoff);
    for (const m of fresh) {
      if (!m.user || !m.user.id) continue;
      if ((eng.autoRole.knownMembers || []).includes(m.user.id)) continue;
      eng.autoRole.knownMembers = (eng.autoRole.knownMembers || []).concat(m.user.id).slice(-1000);
      touched = true;
      if (eng.autoRole.enabled && eng.autoRole.roleId) {
        try { await discordFetch(`/guilds/${guildId}/members/${m.user.id}/roles/${eng.autoRole.roleId}`, { method: 'PUT', headers: { 'X-Audit-Log-Reason': 'Kyro auto-role' } }); } catch (e) {}
      }
      if (eng.joinDm.enabled && eng.joinDm.message) {
        try {
          const dm = await discordFetch(`/users/${m.user.id}/channels`, { method: 'POST', body: JSON.stringify({ recipient_id: m.user.id }) });
          await discordFetch(`/channels/${dm.id}/messages`, { method: 'POST', body: JSON.stringify({ content: String(eng.joinDm.message).replace('{server}', g._serverName || 'the server').slice(0, 2000) }) });
        } catch (e) {}
      }
    }
  }
  // Voice role: grant while connected, remove when they leave
  const vr = eng.voiceRole;
  if (vr && vr.enabled && vr.roleId) {
    try {
      const states = await discordFetch(`/guilds/${guildId}/voice-states`);
      const connected = (Array.isArray(states) ? states : []).filter((s) => s.channel_id).map((s) => s.user_id);
      const had = vr.inVoice || [];
      for (const uidToAdd of connected) {
        if (had.includes(uidToAdd)) continue;
        try { await discordFetch(`/guilds/${guildId}/members/${uidToAdd}/roles/${vr.roleId}`, { method: 'PUT', headers: { 'X-Audit-Log-Reason': 'Kyro voice role' } }); } catch (e) {}
      }
      for (const uidToClear of had) {
        if (connected.includes(uidToClear)) continue;
        try { await discordFetch(`/guilds/${guildId}/members/${uidToClear}/roles/${vr.roleId}`, { method: 'DELETE', headers: { 'X-Audit-Log-Reason': 'Kyro voice role' } }); } catch (e) {}
      }
      if (connected.length !== had.length || connected.some((x) => !had.includes(x))) {
        vr.inVoice = connected;
        touched = true;
      }
    } catch (e) {}
  }
  return touched;
}

/* Due scheduled announcements + reminders. Returns true when something fired. */
async function runSchedule(db, guildId, g) {
  const sch = g.schedule || (g.schedule = { announcements: [], reminders: [] });
  const now = Date.now();
  let fired = false;
  const dueAnn = (sch.announcements || []).filter((a) => Number(a.at) <= now);
  for (const a of dueAnn) {
    fired = true;
    try {
      await discordFetch(`/channels/${a.channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          content: a.mentionEveryone ? '@everyone' : undefined,
          embeds: [{ title: a.title, description: a.description, color: 0x2997ff, footer: { text: 'Kyro • Scheduled announcement' }, timestamp: new Date().toISOString() }],
          allowed_mentions: { parse: a.mentionEveryone ? ['everyone'] : [] }
        })
      });
      await logEvent(guildId, 'moderation', 'Scheduled announcement sent', `**Channel:** <#${a.channelId}>\n**Title:** ${a.title}`, 0x2997ff);
    } catch (e) {}
  }
  sch.announcements = (sch.announcements || []).filter((a) => Number(a.at) > now);
  const dueRem = (sch.reminders || []).filter((r) => Number(r.at) <= now);
  for (const r of dueRem) {
    fired = true;
    try {
      const dm = await discordFetch(`/users/${r.userId}/channels`, { method: 'POST', body: JSON.stringify({ recipient_id: r.userId }) });
      await discordFetch(`/channels/${dm.id}/messages`, { method: 'POST', body: JSON.stringify({ content: `⏰ **Reminder:** ${r.text}` }) });
    } catch (e) {}
  }
  sch.reminders = (sch.reminders || []).filter((r) => Number(r.at) > now);
  if (fired) saveDB(db);
  return fired;
}

/* ---------------------------------------------------------------------------
   Community suite: levels, birthdays, stat channels, suggestions, polls
   --------------------------------------------------------------------------- */
const randomBetween = (min, max) => {
  const lo = Math.max(1, Number(min) || 5);
  const hi = Math.max(lo, Number(max) || 15);
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
};

/* Quadratic curve: level 1 at 50 XP, level 10 at 5,000 XP, level 100 at 500k. */
const levelForXp = (xp) => Math.floor(Math.sqrt(Math.max(0, Number(xp) || 0) / 50));
const xpForLevel = (level) => Math.max(1, Number(level) || 1) ** 2 * 50;

async function announceLevelUp(guildId, g, userId, level) {
  const lv = g.levels;
  for (const reward of lv.rewards || []) {
    if (Number(reward.level) !== Number(level) || !reward.roleId) continue;
    try {
      await discordFetch(`/guilds/${guildId}/members/${userId}/roles/${reward.roleId}`, {
        method: 'PUT', headers: { 'X-Audit-Log-Reason': `Level ${level} reward` }
      });
    } catch (e) {}
  }
  if (!lv.announce || !lv.channelId) return;
  const st = (lv.users && lv.users[userId]) || { xp: 0 };
  try {
    await discordFetch(`/channels/${lv.channelId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        embeds: [{
          description: `🎉 <@${userId}> just reached **level ${level}**! (${st.xp} XP)`,
          color: 0xf39c12,
          footer: { text: `Next level at ${xpForLevel(level + 1)} XP` }
        }],
        allowed_mentions: { parse: ['users'] }
      })
    });
  } catch (e) {}
}

/* Today's birthdays, announced once per member per year. */
async function runBirthdaysGuild(db, guildId, g) {
  const bd = g.birthdays;
  if (!bd.enabled || !bd.channelId || !Array.isArray(bd.users) || !bd.users.length) return false;
  const now = new Date();
  const today = `${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
  const yearKey = String(now.getUTCFullYear());
  bd.announced = Array.isArray(bd.announced) ? bd.announced : [];
  let fired = false;
  for (const entry of bd.users) {
    if (!entry || !entry.userId || entry.date !== today) continue;
    const key = `${yearKey}:${entry.userId}`;
    if (bd.announced.includes(key)) continue;
    bd.announced.push(key);
    if (bd.announced.length > 500) bd.announced = bd.announced.slice(-500);
    fired = true;
    const text = String(bd.message || '🎂 Happy birthday {user}!').replace(/\{user\}/g, `<@${entry.userId}>`).replace(/\{username\}/g, entry.username || 'member');
    try {
      await discordFetch(`/channels/${bd.channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: text.slice(0, 2000), allowed_mentions: { parse: ['users'] } })
      });
      await logEvent(guildId, 'joins', 'Birthday announced', `**Member:** <@${entry.userId}>`, 0xff9f0a);
    } catch (e) {}
  }
  return fired;
}

/* Rename the configured voice channels to the live member/bot counts. */
async function runStatChannelsGuild(guildId, g) {
  const sc = g.statChannels;
  if (!sc.enabled) return false;
  if (Date.now() - Number(sc.lastRun || 0) < 5 * 60 * 1000) return false;
  sc.lastRun = Date.now();
  let guild;
  try { guild = await discordFetch(`/guilds/${guildId}?with_counts=true`); } catch (e) { return false; }
  let bots = 0;
  try {
    const members = await discordFetch(`/guilds/${guildId}/members?limit=1000`);
    bots = (Array.isArray(members) ? members : []).filter((m) => m.user && m.user.bot).length;
  } catch (e) {}
  const total = Number(guild.approximate_member_count || 0);
  const humans = Math.max(0, total - bots);
  const renames = [
    { id: sc.memberChannelId, name: `👥 Members: ${total}` },
    { id: sc.botChannelId, name: `🤖 Bots: ${bots} · Humans: ${humans}` }
  ];
  let touched = false;
  for (const r of renames) {
    if (!r.id) continue;
    try { await discordFetch(`/channels/${r.id}`, { method: 'PATCH', body: JSON.stringify({ name: r.name }) }); touched = true; } catch (e) {}
  }
  return touched;
}

/* Native Discord poll (no bot gateway needed). */
async function createPoll(guildId, body) {
  const channelId = String(body.channelId || '').trim();
  const question = String(body.question || '').trim();
  const answers = (Array.isArray(body.options) ? body.options : []).map((o) => String(o || '').trim()).filter(Boolean).slice(0, 10);
  if (!channelId) throw new Error('A channel is required.');
  if (!question) throw new Error('A poll question is required.');
  if (answers.length < 2) throw new Error('Add at least two poll options.');
  const hours = Math.min(Math.max(Number(body.hours) || 24, 1), 168);
  const msg = await discordFetch(`/channels/${channelId}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      content: String(body.content || '').slice(0, 2000) || undefined,
      poll: {
        question: { text: question.slice(0, 300) },
        answers: answers.map((text) => ({ poll_media: { text: text.slice(0, 55) } })),
        duration: hours,
        allow_multiselect: Boolean(body.multiple)
      }
    })
  });
  const db = loadDB();
  const g = guildConfig(db, guildId);
  g.polls = Array.isArray(g.polls) ? g.polls : [];
  const poll = { id: uid(), channel: channelId, message_id: msg.id, question, options: answers, hours, multiple: Boolean(body.multiple), created_at: new Date().toISOString() };
  g.polls.unshift(poll);
  g.polls = g.polls.slice(0, 50);
  saveDB(db);
  await logEvent(guildId, 'moderation', 'Poll posted', `**Channel:** <#${channelId}>\n**Question:** ${question}\n**Options:** ${answers.length}`, 0x64d2ff);
  return poll;
}

/* Suggestion channel panel. Members just write in the channel; the poller
   converts each message into a votable embed, so no gateway is required. */
async function postSuggestionPanel(guildId, channelId) {
  const msg = await discordFetch(`/channels/${channelId}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      embeds: [{
        title: '💡 Suggestions',
        description: 'Send a message in this channel with your idea — the bot reposts it with 👍 / 👎 so everyone can vote.\nKeep it short and constructive.',
        color: 0x30d158,
        footer: { text: 'Kyro Staff Bot' }
      }]
    })
  });
  const db = loadDB();
  const g = guildConfig(db, guildId);
  g.suggestions = g.suggestions || { enabled: true, channelId: '', processed: [] };
  g.suggestions.enabled = true;
  g.suggestions.channelId = channelId;
  saveDB(db);
  return msg;
}

/* Channels the engagement/level/suggestion scanners should read: the AutoMod
   channel list plus every channel a feature is explicitly pointed at. */
function scanChannelSet(g) {
  const set = new Set();
  for (const id of (g.automod && g.automod.channels) || []) set.add(id);
  const eng = g.engagement || {};
  if (eng.sticky && eng.sticky.channelId) set.add(eng.sticky.channelId);
  if (g.suggestions && g.suggestions.channelId) set.add(g.suggestions.channelId);
  for (const id of (g.levels && g.levels.channels) || []) set.add(id);
  return [...set].filter(Boolean).slice(0, 30);
}

// Background poller
// ---------------------------------------------------------------------------
const lastRun = { giveaways: 0, reactionRoles: 0, automod: 0, welcome: 0, tempbans: 0, security: 0, engagement: 0, schedule: 0, birthdays: 0, stats: 0 };
let polling = false;
let pollPromise = Promise.resolve();
function pollTick() { pollPromise = pollTickRun(); return pollPromise; }

async function pollTickRun() {
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

    if (now - (lastRun.honeypot || 0) > 10000) {
      lastRun.honeypot = now;
      for (const guildId of guildIds) {
        const g = guildConfig(db, guildId);
        try { if (await runHoneypot(guildId, g)) changed = true; } catch (e) {}
      }
    }

    if (now - lastRun.welcome > 30000) {
      lastRun.welcome = now;
      for (const guildId of guildIds) {
        const g = guildConfig(db, guildId);
        try { await runWelcomeGuild(guildId, g); changed = true; } catch (e) {}
      }
    }

    // Engagement suite: auto-role, join DMs, voice roles, starboard, levels,
    // stickies, auto-responses, AFK, boosts and suggestion voting.
    if (now - lastRun.engagement > 30000) {
      lastRun.engagement = now;
      for (const guildId of guildIds) {
        const g = guildConfig(db, guildId);
        try { if (await runEngagementGuild(guildId, g)) changed = true; } catch (e) {}
        try { if (await scanGuildMessages(guildId, g, scanChannelSet(g))) changed = true; } catch (e) {}
      }
    }

    // Scheduled announcements + reminders.
    if (now - lastRun.schedule > 15000) {
      lastRun.schedule = now;
      for (const guildId of guildIds) {
        const g = guildConfig(db, guildId);
        try { if (await runSchedule(db, guildId, g)) changed = true; } catch (e) {}
      }
    }

    // Birthday announcements (once per member per year).
    if (now - lastRun.birthdays > 60000) {
      lastRun.birthdays = now;
      for (const guildId of guildIds) {
        const g = guildConfig(db, guildId);
        try { if (await runBirthdaysGuild(db, guildId, g)) changed = true; } catch (e) {}
      }
    }

    // Live member/bot counters in voice channel names.
    if (now - lastRun.stats > 60000) {
      lastRun.stats = now;
      for (const guildId of guildIds) {
        const g = guildConfig(db, guildId);
        try {
          await runStatChannelsGuild(guildId, g);
          if (g.statChannels && g.statChannels.enabled) changed = true; // persist the 5-minute throttle
        } catch (e) {}
      }
    }

    // Big-team security suite — heavier checks, run about every 45 seconds.
    if (now - lastRun.security > 45000) {
      lastRun.security = now;
      for (const guildId of guildIds) {
        const g = guildConfig(db, guildId);
        try { await runRaidWatch(guildId, g); } catch (e) {}
        try { await runAntiNuke(guildId, g); } catch (e) {}
        try { await runKeywordAlerts(guildId, g); } catch (e) {}
        changed = true;
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

/* Turns Discord's bare "Missing Permissions" into an actionable explanation. */
function permErrorHint(err) {
  const msg = String((err && err.message) || '');
  if (err && err.needsAdmin) return err.message;
  if (err && (err.status === 403 || /missing permissions|missing perms|permission/i.test(msg))) {
    return 'Discord refused this action: ' + msg + (err.code ? ` (code ${err.code})` : '') + '. On Discord, a role or channel edit needs the **Kyro Bot** role above the target in Server Settings → Roles, plus Manage Roles + Manage Channels (or Administrator): ' + BOT_INSTALL_URL;
  }
  return null;
}

async function handleRequest(req, res) {
  // Loopback admin tool: reject any Host that isn't localhost (DNS-rebinding guard).
  const host = (req.headers.host || '').toLowerCase();
  if (host !== `localhost:${PORT}` && host !== `127.0.0.1:${PORT}` && host !== `[::1]:${PORT}`) {
    return sendJSON(res, 403, { error: 'Forbidden host.' });
  }
  // CSRF guard: this admin API is unauthenticated by design (loopback only), so
  // a page the owner visits must not be able to POST to it. A cross-site form
  // or fetch cannot set JSON content type without a CORS preflight, and the
  // Origin/Sec-Fetch-Site check rejects the rest.
  const localOrigins = [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`, `http://[::1]:${PORT}`];
  const origin = req.headers.origin || '';
  if (origin && !localOrigins.includes(origin)) return sendJSON(res, 403, { error: 'Cross-site request blocked.' });
  const fetchSite = String(req.headers['sec-fetch-site'] || '');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return sendJSON(res, 403, { error: 'Cross-site request blocked.' });
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const contentType = String(req.headers['content-type'] || '');
    if (!/^application\/json\b/i.test(contentType)) {
      return sendJSON(res, 415, { error: 'Send JSON with Content-Type: application/json.' });
    }
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
      return sendJSON(res, 200, {
        ok: true, tokenLoaded: Boolean(BOT_TOKEN), ownerId: OWNER_ID,
        poller: !process.env.DASHBOARD_DISABLE_POLLER,
        installUrl: BOT_INSTALL_URL, clientId: BOT_CLIENT_ID,
        botId: BOT_IDENTITY.id, botName: BOT_IDENTITY.username,
        commandsVersion: COMMANDS_STATE.version,
        commandsRegistered: COMMANDS_STATE.results.filter((r) => r.ok).length
      });
    }

    if (req.method === 'POST' && p === '/api/launch') {
      openLocalDashboard();
      return sendJSON(res, 200, { ok: true });
    }

    if (req.method === 'GET' && p === '/api/commands') {
      return sendJSON(res, 200, {
        version: COMMANDS_STATE.version,
        commands: KYRO_COMMANDS.map((c) => ({ name: c.name, description: c.description })),
        results: COMMANDS_STATE.results
      });
    }

    if (req.method === 'POST' && p === '/api/commands/register') {
      const out = await ensureSlashCommands(true);
      return sendJSON(res, out.ok || out.skipped ? 200 : 502, out);
    }

    // Multi-server selector
    if (req.method === 'GET' && p === '/api/guilds') {
      const guilds = await discordFetch('/users/@me/guilds?with_counts=true');
      const list = (Array.isArray(guilds) ? guilds : []).map((g) => {
        const perms = BigInt(g.permissions || '0');
        return {
          id: g.id, name: g.name, icon: g.icon, owner: g.owner,
          member_count: g.approximate_member_count || null,
          permissions: g.permissions,
          is_admin: (perms & PERM.ADMIN) === PERM.ADMIN,
          invite_url: BOT_INSTALL_URL
        };
      });
      return sendJSON(res, 200, { guilds: list, installUrl: BOT_INSTALL_URL });
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
        automod: g.automod, welcome: g.welcome, leave: g.leave, logging: g.logging,
        reactionRoles: g.reactionRoles, giveaways: g.giveaways,
        warnings: g.warnings, audit: g.audit, tempbans: g.tempbans,
        verification: g.verification, security: g.security,
        engagement: g.engagement, schedule: g.schedule, autoResponses: g.autoResponses,
        suggestions: g.suggestions, levels: g.levels, birthdays: g.birthdays,
        statChannels: g.statChannels, polls: g.polls, honeypot: g.honeypot,
        rolePacks: ROLE_PACKS.map((p) => ({ id: p.id, label: p.label, description: p.description, roles: p.roles.length })),
        installUrl: BOT_INSTALL_URL
      });
    }

    // ---- Bot admin access (invite / re-grant) ----
    if (req.method === 'GET' && p === '/api/bot/access') {
      if (!guildId) return sendJSON(res, 400, { error: 'guild is required' });
      const access = await botAccess(guildId);
      return sendJSON(res, 200, {
        ...access, required: ['Administrator'],
        bot: BOT_IDENTITY, inviteUrl: BOT_INSTALL_URL,
        reason: access.inGuild === false
          ? `${BOT_IDENTITY.username || 'The bot'} is not in this server — add it with the invite link, then re-check.`
          : null
      });
    }

    if (req.method === 'POST' && p === '/api/bot/grant') {
      const body = await readBody(req);
      const gid = body.guild || guildId;
      if (!gid) return sendJSON(res, 400, { error: 'guild is required' });
      accessCache[gid] = null;
      const access = await botAccess(gid);
      return sendJSON(res, 200, {
        ok: true,
        isAdmin: access.isAdmin,
        inGuild: access.inGuild !== false,
        bot: BOT_IDENTITY,
        inviteUrl: BOT_INSTALL_URL,
        message: access.isAdmin
          ? (BOT_IDENTITY.username || 'Kyro Bot') + ' already has Administrator in this server.'
          : access.inGuild === false
            ? (BOT_IDENTITY.username || 'The bot') + ' is not in this server yet. Open the invite link, pick this server and approve Administrator, then press Re-check permissions.'
            : 'Open the invite link, pick this server and approve Administrator — the invite now targets ' + (BOT_IDENTITY.username || 'this bot') + ' (' + BOT_CLIENT_ID + '). Nothing else changes.'
      });
    }

    // ---- Role presets & packs ----
    if (req.method === 'GET' && p === '/api/roles/presets') {
      const presets = ROLE_PRESETS.map((x) => ({ id: x.id, group: x.group, label: x.label, desc: x.desc }));
      let roles = [];
      if (guildId) {
        try {
          const list = await discordFetch(`/guilds/${guildId}/roles`);
          roles = (Array.isArray(list) ? list : []).filter((r) => r.name !== '@everyone' && !r.managed)
            .map((r) => ({ id: r.id, name: r.name, ...rolePresetPermissions(r.name) }));
        } catch (e) {}
      }
      return sendJSON(res, 200, { presets, roles, packs: ROLE_PACKS.map((x) => ({ id: x.id, label: x.label, description: x.description })) });
    }

    if (req.method === 'POST' && p === '/api/roles/presets/apply') {
      const body = await readBody(req);
      const gid = body.guild || guildId;
      if (!gid) return sendJSON(res, 400, { error: 'guild is required' });
      if (!body.roleId) return sendJSON(res, 400, { error: 'roleId is required' });
      const out = await applyRolePreset(gid, body.roleId, body.presetId);
      return sendJSON(res, 200, { ok: true, ...out });
    }

    if (req.method === 'GET' && p === '/api/roles/packs') {
      return sendJSON(res, 200, { packs: ROLE_PACKS });
    }

    if (req.method === 'POST' && p === '/api/roles/packs/create') {
      const body = await readBody(req);
      const gid = body.guild || guildId;
      if (!gid) return sendJSON(res, 400, { error: 'guild is required' });
      const out = await createRolePack(gid, body.packId);
      return sendJSON(res, 200, out);
    }

    // ---- Role cleanup (preview is mandatory, apply uses that exact plan) ----
    if (req.method === 'GET' && p === '/api/roles/cleanup/preview') {
      if (!guildId) return sendJSON(res, 400, { error: 'guild is required' });
      const plan = await roleCleanupPlan(guildId, url.searchParams.get('keep'));
      return sendJSON(res, 200, plan);
    }

    if (req.method === 'POST' && p === '/api/roles/cleanup/apply') {
      const body = await readBody(req);
      const gid = body.guild || guildId;
      if (!gid) return sendJSON(res, 400, { error: 'guild is required' });
      if (body.confirm !== true) return sendJSON(res, 400, { error: 'Preview the cleanup first and confirm the deletion.' });
      if (!Array.isArray(body.ids) || !body.ids.length) return sendJSON(res, 400, { error: 'No roles were selected for deletion.' });
      const result = await applyRoleCleanup(gid, body.keep, body.ids);
      return sendJSON(res, 200, result);
    }

    // ---- Channel access repair (the "cannot view history" fix) ----
    if (req.method === 'POST' && p === '/api/channels/repair') {
      const body = await readBody(req);
      const gid = body.guild || guildId;
      if (!gid) return sendJSON(res, 400, { error: 'guild is required' });
      // Discord ids are snowflakes; the looser pattern keeps local test ids
      // working while still refusing anything that could escape the URL path.
      if (!/^[A-Za-z0-9_-]{3,32}$/.test(String(body.channelId || ''))) return sendJSON(res, 400, { error: 'Pick a valid channel.' });
      const result = await repairChannelAccess(gid, String(body.channelId));
      return sendJSON(res, 200, result);
    }

    if (req.method === 'POST' && p === '/api/channels/visibility') {
      const body = await readBody(req);
      const gid = body.guild || guildId;
      if (!gid) return sendJSON(res, 400, { error: 'guild is required' });
      try {
        const result = await applyChannelVisibility(gid);
        return sendJSON(res, 200, result);
      } catch (err) {
        const hint = permErrorHint(err);
        return sendJSON(res, err.status || (hint ? 403 : 500), { error: hint || (err.message || 'Could not apply channel visibility.'), needsAdmin: Boolean(err.needsAdmin), inviteUrl: BOT_INSTALL_URL });
      }
    }

    // ---- Honeypot trap ----
    if (req.method === 'POST' && p === '/api/honeypot') {
      const body = await readBody(req);
      const gid = body.guild || guildId;
      if (!gid) return sendJSON(res, 400, { error: 'guild is required' });
      const db = loadDB();
      const g = guildConfig(db, gid);
      const hp = g.honeypot;
      const notes = [];
      if (body.createChannel) {
        await assertBotCan(gid, PERM.MANAGE_CH, 'the honeypot channel');
        const made = await ensureChannel(gid, 'honeypot', { topic: '⚠️ Decoy channel — posting here gets you removed.' });
        hp.channelId = made.channel.id;
        notes.push(made.created ? 'Created #honeypot' : 'Using the existing #honeypot');
      } else if (body.channelId !== undefined) {
        if (body.channelId && !/^[A-Za-z0-9_-]{3,32}$/.test(String(body.channelId))) return sendJSON(res, 400, { error: 'Pick a valid channel.' });
        hp.channelId = String(body.channelId || '');
      }
      if (body.enabled !== undefined) hp.enabled = Boolean(body.enabled);
      if (body.action !== undefined) {
        const action = ['ban', 'kick', 'timeout'].includes(body.action) ? body.action : 'kick';
        const bit = action === 'ban' ? PERM.BAN : action === 'kick' ? PERM.KICK : PERM.TIMEOUT;
        const label = action === 'ban' ? 'Ban Members' : action === 'kick' ? 'Kick Members' : 'Moderate Members';
        const access = await botAccess(gid);
        if (!access.isAdmin && (BigInt(access.permissions || '0') & bit) !== bit) {
          return sendJSON(res, 403, {
            error: `Kyro Staff needs ${label} to ${action} a honeypot intruder. Give the **Kyro Bot** role ${label}, or pick another action.`,
            missing: [label], inviteUrl: BOT_INSTALL_URL
          });
        }
        hp.action = action;
      }
      if (body.timeoutSeconds !== undefined) hp.timeoutSeconds = Math.min(Math.max(Number(body.timeoutSeconds) || 600, 60), 2419200);
      if (body.reason !== undefined) hp.reason = String(body.reason || '').slice(0, 200) || 'Honeypot trap triggered';
      if (Array.isArray(body.exemptRoles)) hp.exemptRoles = body.exemptRoles.map(String).slice(0, 25);
      if (hp.enabled && !hp.channelId) return sendJSON(res, 400, { error: 'Choose the honeypot channel first.' });
      saveDB(db);
      let run = null;
      if (body.runNow && hp.enabled) {
        try { await runHoneypot(gid, g, { limit: 25 }); saveDB(db); run = { total: g.honeypot.total, last_at: g.honeypot.last_at }; }
        catch (err) { run = { error: err.message }; }
      }
      // The panel is what makes the trap self-explanatory in Discord. Post it
      // when asked, and refresh it after a manual scan.
      if (hp.channelId && (body.panel || body.createChannel || (body.runNow && run && !run.error))) {
        try {
          await postHoneypotPanel(gid, g);
          saveDB(db);
          notes.push(hp.panelMessageId && body.panel ? 'Honeypot panel posted in #honeypot' : 'Honeypot panel up to date');
        } catch (err) {
          notes.push('Could not post the honeypot panel: ' + (err.message || 'Discord refused it'));
        }
      }
      return sendJSON(res, 200, { ok: true, honeypot: g.honeypot, panelMessageId: g.honeypot.panelMessageId || '', notes, run });
    }

    // ---- Engagement suite ----
    if (req.method === 'POST' && p === '/api/engagement') {
      const body = await readBody(req);
      const gid = body.guild || guildId;
      if (!gid) return sendJSON(res, 400, { error: 'guild is required' });
      const db = loadDB();
      const g = guildConfig(db, gid);
      const eng = g.engagement;
      if (body.autoRole) {
        eng.autoRole = {
          enabled: Boolean(body.autoRole.enabled), roleId: String(body.autoRole.roleId || ''),
          knownMembers: eng.autoRole.knownMembers || []
        };
      }
      if (body.joinDm) {
        eng.joinDm = { enabled: Boolean(body.joinDm.enabled), message: String(body.joinDm.message || '').slice(0, 1500) };
      }
      if (body.starboard) {
        eng.starboard = {
          enabled: Boolean(body.starboard.enabled), channelId: String(body.starboard.channelId || ''),
          threshold: Math.min(Math.max(Number(body.starboard.threshold) || 3, 1), 50),
          emoji: String(body.starboard.emoji || '⭐').slice(0, 16),
          processed: eng.starboard.processed || []
        };
      }
      if (body.voiceRole) {
        eng.voiceRole = {
          enabled: Boolean(body.voiceRole.enabled), roleId: String(body.voiceRole.roleId || ''),
          inVoice: eng.voiceRole.inVoice || []
        };
      }
      if (body.boosts) {
        eng.boosts = { enabled: Boolean(body.boosts.enabled), channelId: String(body.boosts.channelId || ''), processed: eng.boosts.processed || [] };
      }
      if (body.afk) {
        eng.afk = {
          enabled: Boolean(body.afk.enabled), userId: String(body.afk.userId || '').trim(),
          reason: String(body.afk.reason || '').slice(0, 200), until: Number(body.afk.until) || 0,
          answered: eng.afk.answered || []
        };
      }
      if (body.sticky) {
        eng.sticky = {
          enabled: Boolean(body.sticky.enabled), channelId: String(body.sticky.channelId || ''),
          content: String(body.sticky.content || '').slice(0, 2000),
          messageId: body.sticky.channelId === eng.sticky.channelId ? eng.sticky.messageId : '',
          lastChat: ''
        };
      }
      saveDB(db);
      return sendJSON(res, 200, { ok: true, engagement: eng });
    }

    // ---- Levels ----
    if (req.method === 'POST' && p === '/api/levels') {
      const body = await readBody(req);
      const gid = body.guild || guildId;
      if (!gid) return sendJSON(res, 400, { error: 'guild is required' });
      const db = loadDB();
      const g = guildConfig(db, gid);
      const lv = g.levels;
      if (body.enabled !== undefined) lv.enabled = Boolean(body.enabled);
      if (body.minXp !== undefined) lv.minXp = Math.min(Math.max(Number(body.minXp) || 5, 1), 500);
      if (body.maxXp !== undefined) lv.maxXp = Math.max(lv.minXp, Math.min(Number(body.maxXp) || 15, 1000));
      if (body.cooldownSeconds !== undefined) lv.cooldownSeconds = Math.min(Math.max(Number(body.cooldownSeconds) || 60, 0), 86400);
      if (body.channelId !== undefined) lv.channelId = String(body.channelId || '');
      if (body.announce !== undefined) lv.announce = Boolean(body.announce);
      if (Array.isArray(body.channels)) lv.channels = body.channels.map(String).slice(0, 30);
      if (Array.isArray(body.rewards)) {
        lv.rewards = body.rewards
          .filter((r) => r && r.roleId)
          .map((r) => ({ level: Math.min(Math.max(Number(r.level) || 1, 1), 500), roleId: String(r.roleId) }))
          .slice(0, 25);
      }
      saveDB(db);
      return sendJSON(res, 200, { ok: true, levels: { ...lv, users: undefined } });
    }

    if (req.method === 'GET' && p === '/api/levels') {
      if (!guildId) return sendJSON(res, 400, { error: 'guild is required' });
      const db = loadDB();
      const g = guildConfig(db, guildId);
      const lv = g.levels;
      const leaderboard = Object.entries(lv.users || {})
        .map(([userId, st]) => ({ userId, xp: Number(st.xp) || 0, level: Number(st.level) || 0 }))
        .sort((a, b) => b.xp - a.xp)
        .slice(0, 25)
        .map((row) => ({ ...row, nextLevelXp: xpForLevel(row.level + 1) }));
      return sendJSON(res, 200, { levels: { ...lv, users: undefined, rankingSize: Object.keys(lv.users || {}).length }, leaderboard });
    }

    // ---- Birthdays ----
    if (req.method === 'POST' && p === '/api/birthdays') {
      const body = await readBody(req);
      const gid = body.guild || guildId;
      if (!gid) return sendJSON(res, 400, { error: 'guild is required' });
      const db = loadDB();
      const g = guildConfig(db, gid);
      const bd = g.birthdays;
      if (body.enabled !== undefined) bd.enabled = Boolean(body.enabled);
      if (body.channelId !== undefined) bd.channelId = String(body.channelId || '');
      if (body.message !== undefined) bd.message = String(body.message || '').slice(0, 500);
      if (Array.isArray(body.users)) {
        bd.users = body.users
          .filter((u) => u && /^\d{17,20}$/.test(String(u.userId || '')) && /^\d{2}-\d{2}$/.test(String(u.date || '')))
          .map((u) => ({ userId: String(u.userId), date: String(u.date), username: String(u.username || '') }))
          .slice(0, 500);
      }
      saveDB(db);
      return sendJSON(res, 200, { ok: true, birthdays: bd });
    }

    // ---- Live stat channels ----
    if (req.method === 'POST' && p === '/api/stat-channels') {
      const body = await readBody(req);
      const gid = body.guild || guildId;
      if (!gid) return sendJSON(res, 400, { error: 'guild is required' });
      const db = loadDB();
      const g = guildConfig(db, gid);
      g.statChannels = {
        enabled: Boolean(body.enabled),
        memberChannelId: String(body.memberChannelId || ''),
        botChannelId: String(body.botChannelId || ''),
        lastRun: 0
      };
      saveDB(db);
      let note = 'Saved. Counters refresh every ~5 minutes while the bot is running.';
      if (g.statChannels.enabled) {
        try {
          const touched = await runStatChannelsGuild(gid, { ...g, statChannels: { ...g.statChannels, lastRun: 0 } });
          if (touched) note += ' Counters updated now.';
        } catch (e) {}
      }
      return sendJSON(res, 200, { ok: true, statChannels: g.statChannels, note });
    }

    // ---- Polls ----
    if (req.method === 'POST' && p === '/api/poll') {
      const body = await readBody(req);
      const gid = body.guild || guildId;
      if (!gid) return sendJSON(res, 400, { error: 'guild is required' });
      const poll = await createPoll(gid, body);
      return sendJSON(res, 200, { ok: true, poll });
    }

    // ---- Scheduled announcements & reminders ----
    if (req.method === 'POST' && p === '/api/schedule') {
      const body = await readBody(req);
      const gid = body.guild || guildId;
      if (!gid) return sendJSON(res, 400, { error: 'guild is required' });
      const db = loadDB();
      const g = guildConfig(db, gid);
      const sch = g.schedule;
      const at = Date.now() + Math.min(Math.max(Number(body.inMinutes) || 10, 1), 60 * 24 * 60) * 60000;
      if (body.type === 'reminder') {
        const userId = String(body.userId || '').trim();
        const text = String(body.text || '').trim();
        if (!/^[A-Za-z0-9_-]{1,32}$/.test(userId)) return sendJSON(res, 400, { error: 'A valid user ID is required for a reminder.' });
        if (!text) return sendJSON(res, 400, { error: 'Reminder text is required.' });
        sch.reminders = (sch.reminders || []).concat({ id: uid(), userId, text: text.slice(0, 500), at });
      } else {
        const channelId = String(body.channelId || '').trim();
        const title = String(body.title || '').trim();
        const description = String(body.description || '').trim();
        if (!/^[A-Za-z0-9_-]{1,32}$/.test(channelId)) return sendJSON(res, 400, { error: 'Pick a channel for the announcement.' });
        if (!title && !description) return sendJSON(res, 400, { error: 'Add an announcement title or description.' });
        sch.announcements = (sch.announcements || []).concat({
          id: uid(), channelId, title: title.slice(0, 256), description: description.slice(0, 3500),
          mentionEveryone: Boolean(body.mentionEveryone), at
        });
      }
      saveDB(db);
      return sendJSON(res, 200, { ok: true, schedule: sch });
    }

    if (req.method === 'POST' && p === '/api/schedule/delete') {
      const body = await readBody(req);
      const gid = body.guild || guildId;
      if (!gid) return sendJSON(res, 400, { error: 'guild is required' });
      const db = loadDB();
      const g = guildConfig(db, gid);
      g.schedule.announcements = (g.schedule.announcements || []).filter((a) => a.id !== body.id);
      g.schedule.reminders = (g.schedule.reminders || []).filter((r) => r.id !== body.id);
      saveDB(db);
      return sendJSON(res, 200, { ok: true, schedule: g.schedule });
    }

    // ---- Auto-responses ----
    if (req.method === 'POST' && p === '/api/autoresponses') {
      const body = await readBody(req);
      const gid = body.guild || guildId;
      if (!gid) return sendJSON(res, 400, { error: 'guild is required' });
      const db = loadDB();
      const g = guildConfig(db, gid);
      g.autoResponses = (Array.isArray(body.responses) ? body.responses : [])
        .filter((r) => r && String(r.trigger || '').trim() && String(r.reply || '').trim())
        .map((r) => ({ trigger: String(r.trigger).trim().slice(0, 60), reply: String(r.reply).trim().slice(0, 1500) }))
        .slice(0, 40);
      saveDB(db);
      return sendJSON(res, 200, { ok: true, autoResponses: g.autoResponses });
    }

    // ---- Suggestions panel ----
    if (req.method === 'POST' && p === '/api/suggestions/post') {
      const body = await readBody(req);
      const gid = body.guild || guildId;
      const channelId = String(body.channelId || '').trim();
      if (!gid || !channelId) return sendJSON(res, 400, { error: 'guild and channelId are required' });
      const msg = await postSuggestionPanel(gid, channelId);
      return sendJSON(res, 200, { ok: true, message_id: msg.id, note: 'Members just write their idea — the bot reposts it with 👍 / 👎.' });
    }

    if (req.method === 'POST' && p === '/api/suggestions/config') {
      const body = await readBody(req);
      const gid = body.guild || guildId;
      if (!gid) return sendJSON(res, 400, { error: 'guild is required' });
      const db = loadDB();
      const g = guildConfig(db, gid);
      g.suggestions.enabled = Boolean(body.enabled);
      if (body.channelId !== undefined) g.suggestions.channelId = String(body.channelId || '');
      saveDB(db);
      return sendJSON(res, 200, { ok: true, suggestions: g.suggestions });
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
    if (req.method === 'POST' && p === '/api/giveaway/sync') {
      const body = await readBody(req);
      const gid = body.guild || guildId;
      if (!gid) return sendJSON(res, 400, { error: 'guild is required' });
      try {
        const result = await syncGiveawaysFromDiscord(gid);
        return sendJSON(res, 200, result);
      } catch (err) {
        const hint = permErrorHint(err);
        return sendJSON(res, hint ? 403 : 500, { error: hint || (err.message || 'Could not sync giveaways.') });
      }
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
    if (req.method === 'POST' && p === '/api/leave') {
      const body = await readBody(req);
      const gid = body.guild || guildId;
      if (!gid) return sendJSON(res, 400, { error: 'guild is required' });
      const db = loadDB();
      const g = guildConfig(db, gid);
      g.leave = {
        ...g.leave,
        enabled: Boolean(body.enabled),
        channelId: String(body.channelId || ''),
        message: String(body.message || '').slice(0, 1500),
        useEmbed: Boolean(body.useEmbed),
        embedColor: String(body.embedColor || '#8e8e93')
      };
      saveDB(db);
      return sendJSON(res, 200, { ok: true, leave: g.leave });
    }
    if (req.method === 'POST' && p === '/api/leave/test') {
      const body = await readBody(req);
      const gid = body.guild || guildId;
      const db = loadDB();
      const g = guildConfig(db, gid);
      let guild = { name: 'the server' };
      try { guild = await discordFetch(`/guilds/${gid}?with_counts=true`); } catch (e) {}
      const member = { user: { id: OWNER_ID, username: body.username || 'Test Member' } };
      await sendLeave(gid, g.leave, member, guild.name, guild.approximate_member_count || 1);
      return sendJSON(res, 200, { ok: true, message: 'Test leave message sent.' });
    }
    if (req.method === 'POST' && p === '/api/welcome/scan') {
      const body = await readBody(req);
      const gid = body.guild || guildId;
      if (!gid) return sendJSON(res, 400, { error: 'guild is required' });
      const db = loadDB();
      const g = guildConfig(db, gid);
      const result = await runWelcomeGuild(gid, g);
      saveDB(db);
      return sendJSON(res, 200, { ok: true, ...result });
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
      // A logging channel that @everyone can read leaks every moderation action,
      // so lock it down as part of saving logging (and repair it if it drifted).
      let note = '';
      if (g.logging.enabled && g.logging.channelId) {
        try {
          const channel = await discordFetch(`/channels/${g.logging.channelId}`);
          const everyone = (channel.permission_overwrites || []).find((o) => o.id === gid && o.type === 0);
          const hidden = everyone && (BigInt(everyone.deny || '0') & PERM.VIEW) !== 0n;
          if (!hidden) {
            await makeChannelStaffOnly(gid, channel);
            note = `#${channel.name} is now staff-only`;
          } else {
            note = `#${channel.name} is staff-only`;
          }
        } catch (err) {
          note = 'Logging saved, but the channel could not be locked down: ' + (err.message || 'Discord refused it');
        }
      }
      return sendJSON(res, 200, { ok: true, logging: g.logging, note });
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
      } catch (e) { return sendJSON(res, 200, { members: [], note: `Member list unavailable: ${e.message}${e.status ? ` (HTTP ${e.status})` : ''}. If this says Missing Access, enable the Server Members intent in the Discord Developer Portal (Bot → Privileged Gateway Intents).` }); }
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

    if (req.method === 'POST' && p === '/api/embed/image') {
      const body = await readBody(req);
      const gid = body.guild || guildId;
      if (!gid) return sendJSON(res, 400, { error: 'guild is required' });
      try {
        const result = await uploadEmbedImage(gid, body);
        return sendJSON(res, 200, result);
      } catch (err) {
        return sendJSON(res, err.status || 500, { error: err.message || 'Could not upload the image.' });
      }
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

    // ---- Setup & Security endpoints ----
    if (req.method === 'POST' && p === '/api/permissions/apply') {
      const body = await readBody(req);
      const gid = body.guild || guildId;
      if (!gid) return sendJSON(res, 400, { error: 'guild is required' });
      const result = await applyPermissionPresets(gid);
      await logEvent(gid, 'security', 'Auto permissions applied', `**Updated:** ${result.applied.length}\n${result.applied.map((a) => '• ' + a).join('\n')}`.slice(0, 1900), 0x30d158);
      return sendJSON(res, 200, result);
    }

    if (req.method === 'POST' && p === '/api/roles/bulk') {
      const body = await readBody(req);
      const gid = body.guild || guildId;
      if (!gid) return sendJSON(res, 400, { error: 'guild is required' });
      try {
        const result = await bulkAssignRole(gid, body.roleId);
        await logEvent(gid, 'security', 'Default role applied to everyone', `**Role:** ${result.role}\n**Added:** ${result.added} · already had it: ${result.skipped} · failed: ${result.failed}`, 0x30d158);
        return sendJSON(res, 200, result);
      } catch (err) {
        const hint = permErrorHint(err);
        return sendJSON(res, err.status || (hint ? 403 : 500), { error: hint || (err.message || 'Could not assign the role.'), needsAdmin: Boolean(err.needsAdmin), inviteUrl: BOT_INSTALL_URL });
      }
    }

    if (req.method === 'POST' && p === '/api/verify/setup') {
      const body = await readBody(req);
      const gid = body.guild || guildId;
      if (!gid) return sendJSON(res, 400, { error: 'guild is required' });
      try {
        const steps = await setupVerification(gid, { channelId: body.channelId });
        return sendJSON(res, 200, { steps });
      } catch (err) {
        const hint = permErrorHint(err);
        return sendJSON(res, hint ? 403 : 500, { error: hint || (err.message || 'Verification setup failed.'), needsAdmin: Boolean(err.needsAdmin), inviteUrl: BOT_INSTALL_URL });
      }
    }

    if (req.method === 'POST' && p === '/api/verify/remove') {
      const body = await readBody(req);
      const gid = body.guild || guildId;
      if (!gid) return sendJSON(res, 400, { error: 'guild is required' });
      const out = await clearVerificationGate(gid);
      await logEvent(gid, 'security', 'Verification gate removed', `**Un-hidden channels:** ${out.touched.length || 0}`, 0x95a5a6);
      return sendJSON(res, 200, { touched: out.touched.length });
    }

    if (req.method === 'POST' && p === '/api/autosetup') {
      const body = await readBody(req);
      const gid = body.guild || guildId;
      if (!gid) return sendJSON(res, 400, { error: 'guild is required' });
      try {
        const result = await runAutoSetup(gid, { permissions: Boolean(body.permissions) });
        return sendJSON(res, 200, result);
      } catch (err) {
        const hint = permErrorHint(err);
        return sendJSON(res, hint ? 403 : 500, { error: hint || (err.message || 'Auto setup failed.'), needsAdmin: Boolean(err.needsAdmin), inviteUrl: BOT_INSTALL_URL });
      }
    }

    if (req.method === 'POST' && p === '/api/security') {
      const body = await readBody(req);
      const gid = body.guild || guildId;
      if (!gid) return sendJSON(res, 400, { error: 'guild is required' });
      const db = loadDB();
      const g = guildConfig(db, gid);
      const sec = g.security;
      const notes = [];
      if (body.raidMode !== undefined && Boolean(body.raidMode) !== Boolean(sec.raidMode)) {
        const on = Boolean(body.raidMode);
        sec.raidMode = on;
        const touched = await toggleGlobalLockdown(gid, on);
        notes.push(`${on ? '🔒 Raid Mode ON' : '🔓 Raid Mode OFF'} — ${touched} channels ${on ? 'locked' : 'unlocked'}`);
        await logEvent(gid, 'security', on ? 'Raid Mode enabled' : 'Raid Mode disabled', `**Channels touched:** ${touched}`, on ? 0x7f1d1d : 0x30d158);
      }
      for (const key of ['autoRaid', 'antiNuke', 'antiNukeBan', 'keywordAlerts']) {
        if (body[key] !== undefined) sec[key] = Boolean(body[key]);
      }
      if (body.raidThreshold !== undefined) sec.raidThreshold = Math.min(Math.max(Number(body.raidThreshold) || 10, 2), 500);
      if (body.antiNukeThreshold !== undefined) sec.antiNukeThreshold = Math.min(Math.max(Number(body.antiNukeThreshold) || 3, 1), 50);
      if (Array.isArray(body.keywords)) sec.keywords = body.keywords.map((k) => String(k).toLowerCase().trim()).filter(Boolean).slice(0, 30);
      if (body.warnEscalation && typeof body.warnEscalation === 'object') {
        const we = sec.warnEscalation || {};
        const incoming = body.warnEscalation;
        sec.warnEscalation = {
          enabled: incoming.enabled !== undefined ? Boolean(incoming.enabled) : we.enabled !== false,
          timeoutAt: Number(incoming.timeoutAt) || we.timeoutAt || 3,
          timeoutMinutes: Number(incoming.timeoutMinutes) || we.timeoutMinutes || 120,
          kickAt: Number(incoming.kickAt) || we.kickAt || 5,
          banAt: Number(incoming.banAt) || we.banAt || 7
        };
      }
      saveDB(db);
      return sendJSON(res, 200, { ok: true, notes, security: sec });
    }

    if (req.method === 'POST' && p === '/api/lockdown') {
      const body = await readBody(req);
      const gid = body.guild || guildId;
      if (!gid) return sendJSON(res, 400, { error: 'guild is required' });
      const touched = await toggleGlobalLockdown(gid, Boolean(body.on));
      await logEvent(gid, 'security', body.on ? 'Global lockdown ON' : 'Global lockdown OFF', `**Channels touched:** ${touched}`, body.on ? 0x7f1d1d : 0x30d158);
      return sendJSON(res, 200, { touched });
    }

    if (req.method === 'POST' && p === '/api/massban') {
      const body = await readBody(req);
      const gid = body.guild || guildId;
      if (!gid) return sendJSON(res, 400, { error: 'guild is required' });
      const ids = String(body.ids || '').split(/[\s,;]+/).map((s) => s.trim()).filter((s) => /^\d{17,20}$/.test(s)).slice(0, 100);
      if (!ids.length) return sendJSON(res, 400, { error: 'No valid user IDs provided.' });
      const result = await massBan(gid, ids, body.reason, body.deleteDays);
      return sendJSON(res, 200, result);
    }

    if (req.method === 'POST' && p === '/api/tickets/post') {
      const body = await readBody(req);
      const gid = body.guild || guildId;
      const channelId = body.channelId;
      if (!gid || !channelId) return sendJSON(res, 400, { error: 'guild and channelId are required' });
      const msg = await postTicketEmbed(gid, channelId, body.title, body.description);
      return sendJSON(res, 200, { ok: true, message_id: msg.id });
    }

    if (req.method === 'GET' && p === '/api/modstats') {
      if (!guildId) return sendJSON(res, 400, { error: 'guild is required' });
      return sendJSON(res, 200, { stats: modStats(guildId) });
    }

    console.warn(`[Dashboard] No route for ${req.method} ${p} — restart the dashboard if the UI was updated.`);
    return sendJSON(res, 404, {
      error: 'Not found', path: p, method: req.method,
      hint: 'The dashboard server is older than dashboard.html. Restart it with start-dashboard.cmd.'
    });
  } catch (err) {
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    const payload = { error: err.message || 'Server error' };
    if (err.needsAdmin) { payload.needsAdmin = true; payload.inviteUrl = err.inviteUrl || BOT_INSTALL_URL; payload.missing = err.missing || []; }
    return sendJSON(res, status, payload);
  }
}

const server = http.createServer(handleRequest);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[Dashboard] Port ${PORT} is already in use. Open http://localhost:${PORT}`);
  } else {
    console.error('[Dashboard] Server error:', err.message);
  }
  process.exit(1);
});

await resolveBotIdentity();

server.listen(PORT, '127.0.0.1', () => {
  console.log('=======================================================');
  console.log('  Kyro Staff Bot — Multi-Server Command Center');
  console.log(`  http://localhost:${PORT}`);
  console.log(`  Bot token: ${BOT_TOKEN ? 'loaded' : 'MISSING — set DISCORD_BOT_TOKEN in .env'}`);
  if (BOT_TOKEN) console.log(`  Bot app: ${BOT_IDENTITY.username || 'unknown'} (client ${BOT_CLIENT_ID})`);
  console.log('  Features: moderation, giveaways, reaction roles, automod, welcome,');
  console.log('            logging, setup, security, engagement, levels, community,');
  console.log('            scheduler, polls, role packs, utility, embeds');
  console.log('=======================================================');
  if (!process.env.DASHBOARD_DISABLE_POLLER) {
    setInterval(pollTick, 5000);
    console.log('  Background poller active (giveaways / roles / automod / welcome).');
    // Register slash commands on boot and re-check every 10 min so newly joined
    // guilds get them automatically. Fail-soft; never blocks the dashboard.
    ensureSlashCommands(true).catch((e) => console.warn('[Dashboard] Initial command registration failed:', e.message));
    setInterval(() => ensureSlashCommands(false).catch(() => {}), 10 * 60 * 1000);
    // Adopt giveaway posts already live in Discord so they are listed, counted
    // and ended even if the local DB lost them. Fail-soft per guild.
    (async () => {
      try {
        const db = loadDB();
        for (const gid of Object.keys(db.guilds || {})) {
          try { const r = await syncGiveawaysFromDiscord(gid); if (r.adopted.length) console.log(`[Dashboard] Adopted ${r.adopted.length} existing giveaway(s) in ${gid}.`); } catch (e) {}
        }
      } catch (e) {}
    })();
  }
  // /start-kyro runs on Cloudflare, so it can never open a browser on this
  // machine — opening on boot is what makes the dashboard actually appear.
  if (!process.env.DASHBOARD_DISABLE_OPEN) openLocalDashboard();
});

// The server binds the IPv4 loopback only, but `localhost` resolves to ::1
// first on some Windows setups — the browser then shows ERR_CONNECTION_REFUSED
// while the dashboard is running. Serve the same handler on IPv6 loopback too;
// the Host guard still rejects every non-loopback address.
const server6 = http.createServer(handleRequest);
server6.on('error', (err) => {
  if (err.code !== 'EADDRINUSE' && err.code !== 'EADDRNOTAVAIL' && err.code !== 'EAFNOSUPPORT') {
    console.error('[Dashboard] IPv6 loopback listener failed:', err.message);
  }
});
server6.listen(PORT, '::1');

export { server, server6, loadDB, saveDB };