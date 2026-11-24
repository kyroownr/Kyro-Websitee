const DISCORD_API = 'https://discord.com/api/v10';
const ICON = 'https://raw.githubusercontent.com/kyroownr/Kyro-Websitee/main/assets/kyro-icon.png';
const PRONOUNS = ['Prefer not to say', 'They/them', 'She/her', 'He/him', 'Any pronouns', 'Ask me'];
const COMMON_FIELDS = [
  { id: 'handle', label: 'Name / Handle', type: 'text', required: true, minLength: 2, maxLength: 80 },
  { id: 'pronouns', label: 'Pronouns', type: 'select', options: PRONOUNS, required: false },
  { id: 'age', label: 'Age', type: 'number', required: true, max: 120 },
  { id: 'experience', label: 'Previous experience in editing or Discord communities', type: 'textarea', required: true, minLength: 20, maxLength: 1000 },
  { id: 'availability', label: 'Availability / Consistency', type: 'textarea', required: true, minLength: 10, maxLength: 500 }
];
const AGREEMENTS = [
  { id: 'activity', label: 'I actively participate in the Kyro Discord and can contribute consistently.', type: 'checkbox', required: true },
  { id: 'safety', label: 'I agree to follow community rules, protect members’ privacy, and never share malware, unsafe files, or license/access bypasses.', type: 'checkbox', required: true },
  { id: 'questions', label: 'Any questions? (Optional)', type: 'textarea', required: false, maxLength: 600 }
];
const ROLE_IDS = {
  support: '1571073534103527504',
  moderator: '1542090972765360208',
  contributor: '1571073124328276078'
};
const ROLES = [
  { id: 'support', title: 'Community Support', prefix: 'support', description: 'Help editors find resources, understand installations, and get respectful support.', rules: ['Participate regularly in the Kyro Discord.', 'Explain editing and installation steps patiently; never request passwords or private files.'], fields: [{ id: 'scenario', label: 'How would you help an editor whose installation is not working?', type: 'textarea', required: true, minLength: 20, maxLength: 1000 }] },
  { id: 'moderator', title: 'Moderator', prefix: 'mod', description: 'Keep the community welcoming, handle reports, and apply rules consistently.', rules: ['Be active in the server and able to respond consistently.', 'Handle harassment, spam, and disputes calmly; keep reports confidential.'], fields: [{ id: 'scenario', label: 'How would you handle harassment or a disagreement between members?', type: 'textarea', required: true, minLength: 20, maxLength: 1000 }] },
  { id: 'contributor', title: 'Contributor / Uploader', prefix: 'contrib', description: 'Share original or legally redistributable editing resources and clear installation notes.', rules: ['Check uploads for safety and describe compatibility honestly; no cracked software or license bypasses.'], fields: [
    { id: 'scenario', label: 'What resources would you contribute, and how would you check their quality and legitimacy?', type: 'textarea', required: true, minLength: 20, maxLength: 1000 },
    { id: 'portfolio', label: 'Portfolio / Sample Link (Optional)', type: 'url', required: false, maxLength: 500 },
    { id: 'originality', label: 'I own my contributions or have permission to redistribute them, and will credit their creators.', type: 'checkbox', required: true }
  ] }
];
const error = (status, code, message) => Object.assign(new Error(message), { status, code });
const response = (value, status = 200, headers = {}) => Response.json(value, { status, headers: { ...headers, 'cache-control': 'no-store' } });
const snowflake = value => /^\d{17,20}$/.test(String(value || '')) && BigInt(value) < 2n ** 64n;
const safeText = value => value.replace(/[\\`*_{}\[\]()<>|~]/g, '\\$&');
/* Product posts carry an owner-only "Mark as updated" button. Staff who can
   manage the server may use it too, so an admin can announce a hotfix. */
const RESOURCE_OWNER_ID = '1052909930073567232';
function canMarkResourceUpdated(env, member) {
  const id = member?.user?.id || '';
  if (!snowflake(id)) return false;
  if (id === RESOURCE_OWNER_ID) return true;
  let perms = 0n;
  try { perms = BigInt(member?.permissions || '0'); } catch {}
  if ((perms & 0x8n) === 0x8n) return true;
  const roles = member?.roles || [];
  return roles.includes('1539968441094512710') || roles.includes(String(env.DISCORD_MOD_ROLE_ID || ''));
}
const applicationKey = id => 'application:' + id;

export function applicationConfiguration(env) {
  const minAge = Number(env.KYRO_APPLICATION_MIN_AGE || 16);
  const accountDays = Number(env.KYRO_APPLICATION_ACCOUNT_DAYS || 30);
  const validPolicy = Number.isInteger(minAge) && minAge >= 13 && minAge <= 120 && Number.isInteger(accountDays) && accountDays >= 0 && accountDays <= 3650;
  const guildId = String(env.DISCORD_GUILD_ID || env.KYRO_GUILD_ID || '');
  const configured = Boolean(env.DISCORD_BOT_TOKEN && snowflake(guildId) && guildId === String(env.KYRO_GUILD_ID) && snowflake(env.DISCORD_APPLICATIONS_CATEGORY_ID) && snowflake(env.DISCORD_PUBLIC_APPS_CHANNEL_ID) && snowflake(env.DISCORD_MOD_ROLE_ID) && String(env.DISCORD_MOD_ROLE_ID) !== guildId && /^[a-f\d]{64}$/i.test(env.DISCORD_APPLICATION_PUBLIC_KEY || '') && validPolicy && env.KYRO_APPLICATIONS);
  const minimum = validPolicy ? minAge : 16;
  const days = validPolicy ? accountDays : 30;
  return {
    open: configured && env.KYRO_APPLICATIONS_OPEN !== 'false',
    minAge: minimum, accountDays: days,
    roles: ROLES.map(role => ({
      id: role.id, title: role.title, description: role.description,
      requirements: ['Be at least ' + minimum + ' years old.', 'Have a Discord account at least ' + days + ' days old.', 'Be a member of the Kyro Discord.', ...role.rules],
      fields: [...COMMON_FIELDS.map(field => field.id === 'age' ? { ...field, min: minimum } : field), ...role.fields, ...AGREEMENTS]
    }))
  };
}

function accountCreated(id) {
  if (!snowflake(id)) throw error(400, 'invalid_discord_identity', 'Discord did not provide a valid user ID. Sign in again.');
  const timestamp = Number(BigInt(id) >> 22n) + 1420070400000;
  if (timestamp > Date.now()) throw error(400, 'invalid_discord_identity', 'Discord did not provide a valid account creation date.');
  return new Date(timestamp).toISOString();
}

function publicApplication(row, env) {
  if (!row) return null;
  return {
    id: row.id, role: row.role, status: row.status, created: row.created,
    reviewed_at: row.reviewed_at || null,
    decline_reason: row.decline_reason || null,
    reviewed_by: row.reviewed_by || null,
    ...(env.KYRO_APPLICATION_INTERVIEW_ENABLED === 'true' && row.channel_id ? { interview_url: 'https://discord.com/channels/' + String(env.KYRO_GUILD_ID) + '/' + row.channel_id } : {})
  };
}

async function applicationBody(request) {
  if (Number(request.headers.get('content-length') || 0) > 16000) throw error(413, 'body_too_large', 'The application is too large.');
  const text = await request.text();
  if (new TextEncoder().encode(text).length > 16000) throw error(413, 'body_too_large', 'The application is too large.');
  let body;
  try { body = JSON.parse(text); } catch { throw error(400, 'bad_body', 'Send a JSON application.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw error(400, 'bad_body', 'Send a JSON application.');
  return body;
}

function validateAnswers(input, role) {
  if (!input.answers || typeof input.answers !== 'object' || Array.isArray(input.answers)) throw error(400, 'bad_answers', 'Complete the application questions.');
  const answers = {};
  for (const field of role.fields) {
    const value = input.answers[field.id];
    if (field.type === 'checkbox') {
      if (value !== true) throw error(400, 'agreement_required', 'Confirm: ' + field.label);
      answers[field.id] = true;
    } else if (field.type === 'number') {
      if (!Number.isInteger(value) || value < field.min || value > field.max) throw error(400, 'bad_age', 'Age must be between ' + field.min + ' and ' + field.max + '.');
      answers[field.id] = value;
    } else if (field.type === 'select') {
      const selected = value || PRONOUNS[0];
      if (!field.options.includes(selected)) throw error(400, 'bad_pronouns', 'Choose a pronouns option.');
      answers[field.id] = selected;
    } else {
      if (value !== undefined && typeof value !== 'string') throw error(400, 'bad_answer', 'Use text for: ' + field.label);
      const text = (value || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
      if (text.length > field.maxLength || (field.required && text.length < field.minLength)) throw error(400, 'bad_answer', 'Check the length of: ' + field.label);
      if (field.type === 'url' && text) {
        let url;
        try { url = new URL(text); } catch { throw error(400, 'bad_portfolio', 'Use a complete HTTPS portfolio link.'); }
        if (url.protocol !== 'https:' || url.username || url.password) throw error(400, 'bad_portfolio', 'Use an HTTPS portfolio link without login details.');
      }
      answers[field.id] = text;
    }
  }
  return answers;
}

async function storageCall(env, userId, input) {
  const stub = env.KYRO_APPLICATIONS.get(env.KYRO_APPLICATIONS.idFromName(userId));
  return stub.fetch('https://applications.internal', { method: 'POST', body: JSON.stringify(input) });
}

export async function handleApplications(request, env, cors, session) {
  const url = new URL(request.url);
  if (!env.KYRO_APPLICATIONS) throw error(503, 'applications_closed', 'Applications are currently unavailable. Check back soon.');
  if (request.method === 'GET' && url.pathname === '/applications') {
    const created = accountCreated(session.id);
    const stored = await storageCall(env, session.id, { action: 'list' });
    const data = await stored.json();
    return response({ profile: { id: session.id, username: session.username, tag: session.tag || session.username, account_created: created }, applications: data.applications }, stored.status, cors);
  }
  if (request.method === 'GET' && url.pathname === '/applications/status') {
    const id = url.searchParams.get('id') || '';
    if (!/^[a-f\d-]{36}$/i.test(id)) throw error(400, 'bad_id', 'Choose an application.');
    const stored = await storageCall(env, session.id, { action: 'status', id });
    return response(await stored.json(), stored.status, cors);
  }
  if (request.method !== 'POST' || url.pathname !== '/applications') return response({ error: 'Use GET or POST on /applications.' }, 405, cors);
  const config = applicationConfiguration(env);
  if (!config.open) throw error(503, 'applications_closed', 'Applications are currently closed. Check back soon.');
  const input = await applicationBody(request);
  const role = config.roles.find(item => item.id === input.role);
  if (!role) throw error(400, 'bad_role', 'Choose an application role.');
  const created = accountCreated(session.id);
  if (Date.now() - Date.parse(created) < config.accountDays * 86400000) throw error(403, 'account_too_new', 'Your Discord account must be at least ' + config.accountDays + ' days old.');
  const row = {
    id: crypto.randomUUID(), by: session.id, username: session.username, tag: session.tag || session.username,
    account_created: created, role: role.id, answers: validateAnswers(input, role),
    status: 'queued', created: new Date().toISOString(), fields: role.fields
  };
  const stored = await storageCall(env, session.id, { action: 'create', row });
  return response(await stored.json(), stored.status, cors);
}

async function botCall(env, route, method = 'GET', body, extraHeaders) {
  let result;
  try {
    result = await fetch(DISCORD_API + route, {
      method, headers: { authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'content-type': 'application/json', ...(extraHeaders || {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'manual', signal: AbortSignal.timeout(8000)
    });
  } catch { throw Object.assign(error(502, 'discord_uncertain', 'Discord delivery needs staff attention.'), { uncertain: true }); }
  const data = await result.json().catch(() => ({}));
  if (result.status === 429) {
    const seconds = [data.retry_after, result.headers.get('retry-after'), result.headers.get('x-ratelimit-reset-after')].filter(value => value !== null && value !== undefined).map(Number).filter(value => Number.isFinite(value) && value >= 0);
    throw Object.assign(error(502, 'discord_rate_limit', 'Discord is busy. The application remains queued.'), { retryAfter: seconds.length ? Math.max(1, Math.ceil(Math.max(...seconds) * 1000)) : 30000 });
  }
  if (!result.ok) {
    // Keep the real Discord status and message: "needs staff attention" alone
    // hides whether it was a permission, a bad payload or a deleted channel.
    const detail = `${result.status}${data.code ? ' code ' + data.code : ''}${data.message ? ': ' + data.message : ''}`;
    throw Object.assign(error(502, 'discord_' + result.status, 'Discord delivery needs staff attention (' + detail + ').'), { ...(result.status >= 500 ? { retryAfter: 5000, uncertain: method === 'POST' } : {}), discordStatus: result.status, discordMessage: data.message || '' });
  }
  return data;
}

/* ---------------- Kyro staff moderation (/mod, /whois, unban appeals) ---------------- */
/* Mods get timeout / untimeout / kick / slowmode / purge. Ban, unban and lockdown
   stay owner/admin only. Every punishment DMs the member with the reason, and a
   ban DM carries a "Request Unban" button that opens a private owner ticket. */
const MOD_ACTIONS = ['timeout', 'untimeout', 'kick', 'ban', 'unban', 'purge', 'slowmode', 'lockdown'];
const OWNER_ONLY_MOD_ACTIONS = ['ban', 'unban', 'lockdown'];
const VIEW_OR_SEND = '68608'; // 1024 view + 2048 send + 65536 read history
const KYRO_ICON_URL = ICON;

function dmPayload(env, guildName, action, reason, moderator, appeal) {
  const labels = {
    timeout: ['⏳ You have been timed out', 'You can no longer speak until the timeout expires.'],
    kick: ['👢 You have been kicked', 'You can rejoin with a new invite if you follow the rules.'],
    ban: ['🚫 You have been banned', 'If you believe this was a mistake, use the button below to request an unban.'],
    unban: ['✅ You have been unbanned', 'Welcome back — please follow the rules this time.'],
    warn: ['⚠️ You have been warned', 'Further violations may lead to a timeout or ban.']
  };
  const [title, sub] = labels[action] || ['📢 Moderation notice', ''];
  const data = {
    embeds: [{
      author: { name: 'Kyro Moderation', icon_url: KYRO_ICON_URL },
      title,
      description: `**Server:** ${guildName}\n**Reason:** ${reason || 'No reason provided'}\n**Moderator:** ${moderator || 'Kyro Staff'}\n\n${sub}`,
      color: action === 'unban' ? 0x10b981 : 0xed4245,
      timestamp: new Date().toISOString()
    }]
  };
  if (appeal) {
    data.components = [{
      type: 1,
      components: [{ type: 2, style: 3, label: 'Request Unban', custom_id: `kyro-appeal:request:${appeal.guildId}:${appeal.userId}` }]
    }];
  }
  return data;
}

async function dmMember(env, userId, payload) {
  const dm = await botCall(env, `/users/${userId}/channels`, 'POST', { recipient_id: userId });
  return botCall(env, `/channels/${dm.id}/messages`, 'POST', payload);
}

async function highestRolePosition(env, guildId, userId, positions) {
  const member = await botCall(env, `/guilds/${guildId}/members/${userId}`);
  let top = -1;
  (member.roles || []).forEach(id => { top = Math.max(top, positions.get(id) ?? -1); });
  return { top, member };
}

/* Block punishing someone at or above the invoker unless the invoker owns the guild. */
async function assertTargetBelow(env, guildId, invokerId, targetId, isGuildOwner) {
  if (isGuildOwner || invokerId === targetId) return;
  const positions = new Map((await botCall(env, `/guilds/${guildId}/roles`)).map(r => [r.id, r.position]));
  const invoker = await highestRolePosition(env, guildId, invokerId, positions);
  const target = await highestRolePosition(env, guildId, targetId, positions);
  if (target.top >= invoker.top) throw new Error('That member has an equal or higher role than you.');
}

async function runModAction(env, guildId, guildName, action, targetUserId, opts) {
  const reasonHeader = opts.reason ? { 'X-Audit-Log-Reason': String(opts.reason).slice(0, 400) } : {};
  const audit = opts.moderator ? { 'X-Audit-Log-Reason': `By ${opts.moderator}: ${opts.reason || 'no reason'}`.slice(0, 400) } : reasonHeader;

  if (action === 'timeout') {
    const seconds = Math.min(Math.max(Number(opts.minutes) || 60, 1), 2419200) * 60;
    await botCall(env, `/guilds/${guildId}/members/${targetUserId}`, 'PATCH', { communication_disabled_until: new Date(Date.now() + seconds * 1000).toISOString() }, reasonHeader);
    try { await dmMember(env, targetUserId, dmPayload(env, guildName, 'timeout', opts.reason, opts.moderator)); } catch {}
    return `⏳ Timed out <@${targetUserId}> for ${Math.round(seconds / 60)} minutes. They have been DM'd the reason.`;
  }
  if (action === 'untimeout') {
    await botCall(env, `/guilds/${guildId}/members/${targetUserId}`, 'PATCH', { communication_disabled_until: null }, reasonHeader);
    return `✅ Removed timeout for <@${targetUserId}>.`;
  }
  if (action === 'kick') {
    try { await dmMember(env, targetUserId, dmPayload(env, guildName, 'kick', opts.reason, opts.moderator)); } catch {}
    await botCall(env, `/guilds/${guildId}/members/${targetUserId}`, 'DELETE', undefined, audit);
    return `👢 Kicked <@${targetUserId}>. They have been DM'd the reason.`;
  }
  if (action === 'ban') {
    // DM arrives before the ban so the appeal button keeps working afterwards.
    try { await dmMember(env, targetUserId, dmPayload(env, guildName, 'ban', opts.reason, opts.moderator, { guildId, userId: targetUserId })); } catch {}
    await botCall(env, `/guilds/${guildId}/bans/${targetUserId}`, 'PUT', { delete_message_seconds: Math.min(Math.max(Number(opts.deleteDays) || 0, 0), 7) * 86400 }, audit);
    return `🚫 Banned <@${targetUserId}>. Their DM includes a **Request Unban** button that opens a ticket with you.`;
  }
  if (action === 'unban') {
    await botCall(env, `/guilds/${guildId}/bans/${targetUserId}`, 'DELETE', undefined, audit);
    try { await dmMember(env, targetUserId, dmPayload(env, guildName, 'unban', opts.reason, opts.moderator)); } catch {}
    return `✅ Unbanned <@${targetUserId}>.`;
  }
  if (action === 'purge') {
    const amount = Math.min(Math.max(Number(opts.amount) || 10, 1), 100);
    const msgs = await botCall(env, `/channels/${opts.channelId}/messages?limit=${amount}`);
    const ids = (Array.isArray(msgs) ? msgs : []).map(m => m.id);
    if (!ids.length) return 'Nothing to purge — the channel is already clean.';
    if (ids.length === 1) await botCall(env, `/channels/${opts.channelId}/messages/${ids[0]}`, 'DELETE', undefined, audit);
    else await botCall(env, `/channels/${opts.channelId}/messages/bulk-delete`, 'POST', { messages: ids }, audit);
    return `🧹 Purged ${ids.length} messages from <#${opts.channelId}>.`;
  }
  if (action === 'slowmode') {
    const seconds = Math.min(Math.max(Number(opts.seconds) || 0, 0), 21600);
    await botCall(env, `/channels/${opts.channelId}`, 'PATCH', { rate_limit_per_user: seconds }, reasonHeader);
    return seconds ? `🐢 Slowmode set to ${seconds}s in <#${opts.channelId}>.` : `⚡ Slowmode removed in <#${opts.channelId}>.`;
  }
  if (action === 'lockdown') {
    const channel = await botCall(env, `/channels/${opts.channelId}`);
    const overwrites = Array.isArray(channel.permission_overwrites) ? channel.permission_overwrites.slice() : [];
    const everyone = { id: guildId, type: 0 };
    const idx = overwrites.findIndex(o => o.id === guildId && o.type === 0);
    const deny = BigInt(idx >= 0 ? (overwrites[idx].deny || '0') : '0');
    const nextDeny = opts.lockdownOn ? (deny | 2048n) : (deny & ~2048n);
    const entry = { ...everyone, allow: String(idx >= 0 ? (overwrites[idx].allow || '0') : '0'), deny: nextDeny.toString() };
    if (idx >= 0) overwrites[idx] = entry; else overwrites.push(entry);
    await botCall(env, `/channels/${opts.channelId}`, 'PATCH', { permission_overwrites: overwrites }, reasonHeader);
    return opts.lockdownOn ? `🔒 Locked <#${opts.channelId}> — @everyone can no longer send messages.` : `🔓 Unlocked <#${opts.channelId}>.`;
  }
  throw new Error('Unknown moderation action.');
}

/* /whois — profile picture and info by user pick or username search. */
async function whoisEmbed(env, guildId, targetUserId, query) {
  let user = null, member = null;
  if (targetUserId) {
    user = await botCall(env, `/users/${targetUserId}`);
    try { member = await botCall(env, `/guilds/${guildId}/members/${targetUserId}`); } catch {}
  } else {
    const found = await botCall(env, `/guilds/${guildId}/members/search?query=${encodeURIComponent(query || '')}&limit=5`);
    if (!Array.isArray(found) || !found.length) throw new Error(`No member matching "${query}".`);
    if (found.length > 1) {
      const list = found.map(m => `• <@${m.user.id}> — \`${m.user.username}\``).join('\n');
      return { ambiguity: `Multiple matches for "${query}":\n${list}\nPick one or paste their ID instead.` };
    }
    member = found[0];
    user = member.user;
  }
  const avatar = user.avatar
    ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=512`
    : `https://cdn.discordapp.com/embed/avatars/${(Number(user.discriminator) || 0) % 5}.png`;
  const created = new Date(Number(BigInt(user.id) >> 22n) + 1420070400000).toISOString().slice(0, 10);
  const roles = member && Array.isArray(member.roles) && member.roles.length
    ? member.roles.map(r => `<@&${r}>`).join(' ')
    : 'None';
  const fields = [
    { name: 'Discord ID', value: `\`${user.id}\``, inline: true },
    { name: 'Account created', value: created, inline: true },
    { name: 'Bot', value: user.bot ? 'Yes' : 'No', inline: true }
  ];
  if (member) {
    fields.push({ name: 'Roles', value: roles.slice(0, 1024), inline: false });
    if (member.joined_at) fields.push({ name: 'Joined server', value: member.joined_at.slice(0, 10), inline: true });
  }
  return {
    embed: {
      author: { name: `${user.username} — profile lookup`, icon_url: avatar },
      title: user.username,
      thumbnail: { url: avatar },
      image: { url: avatar },
      color: 0x38bdf8,
      fields,
      footer: { text: 'Kyro™ Website | Resource Monitor', icon_url: KYRO_ICON_URL },
      timestamp: new Date().toISOString()
    }
  };
}

/* ---------------- Owner server setup: permission presets & verification ---------------- */
const PERM = {
  KICK: 1n << 1n, AUDIT: 1n << 7n, REACT: 1n << 6n, VIEW: 1n << 10n, SEND: 1n << 11n, MANAGE_MSG: 1n << 13n,
  EMBED: 1n << 14n, ATTACH: 1n << 15n, HISTORY: 1n << 16n, MENTION: 1n << 17n, EXTERN: 1n << 18n,
  CONNECT: 1n << 20n, SPEAK: 1n << 21n, MUTE: 1n << 22n, MOVE: 1n << 24n, NICK: 1n << 27n,
  APPCMD: 1n << 31n, THREAD_CREATE: 1n << 35n, STICKER: 1n << 37n, THREAD_SEND: 1n << 38n, TIMEOUT: 1n << 40n
};
/* Best-practice permission set per role name. Roles that match nothing get a
   safe baseline so every role ends up optimised. */
function rolePreset(name) {
  const n = String(name || '').toLowerCase();
  const base = PERM.VIEW | PERM.SEND | PERM.REACT | PERM.EMBED | PERM.ATTACH | PERM.HISTORY | PERM.EXTERN | PERM.STICKER | PERM.CONNECT | PERM.SPEAK | PERM.APPCMD | PERM.THREAD_CREATE | PERM.THREAD_SEND;
  if (/(admin|owner|founder)/.test(n)) return { perms: '8', label: 'Administrator' };
  if (/(muted|jail|quarantine|prison)/.test(n)) return { perms: String(PERM.VIEW | PERM.HISTORY), label: 'read-only (punishment role)' };
  if (/(mod|staff|helper|trial)/.test(n)) return { perms: String(base | PERM.KICK | PERM.TIMEOUT | PERM.MANAGE_MSG | PERM.MENTION | PERM.MUTE | PERM.MOVE | PERM.NICK | PERM.AUDIT), label: 'moderation powers' };
  if (/(support|modmail|ticket)/.test(n)) return { perms: String(base | PERM.MANAGE_MSG | PERM.TIMEOUT), label: 'support team powers' };
  if (/(editor)/.test(n)) return { perms: String(base | PERM.MANAGE_MSG | PERM.MENTION), label: 'editor powers (manage messages)' };
  if (/(vip|booster|premium|donator|legend)/.test(n)) return { perms: String(base | PERM.MENTION), label: 'VIP perks' };
  if (/(member|verified|guest|community|contributor|explorer|people)/.test(n)) return { perms: String(base), label: 'chat basics' };
  return { perms: String(base), label: 'custom role → safe baseline (chat basics)' };
}

/* /setup permissions — rewrite every known role to its preset. */
async function applyRolePresets(env, guildId) {
  const [roles, me] = await Promise.all([
    botCall(env, `/guilds/${guildId}/roles`),
    botCall(env, `/users/@me`)
  ]);
  // The bot can only edit roles strictly below its own highest role.
  let botTop = -1;
  try {
    const member = await botCall(env, `/guilds/${guildId}/members/${me.id}`);
    for (const rid of member.roles || []) {
      const r = roles.find((x) => x.id === rid);
      if (r) botTop = Math.max(botTop, r.position);
    }
  } catch (err) {}
  const applied = [], skipped = [];
  for (const role of roles) {
    if (role.managed) { skipped.push(`${role.name} — managed integration role`); continue; }
    if (role.name === '@everyone') { skipped.push('@everyone — default role, left as-is (protects verification gates)'); continue; }
    if (/bot/i.test(role.name)) { skipped.push(`${role.name} — bot role`); continue; }
    if (role.position >= botTop) { skipped.push(`${role.name} — above the Kyro Bot role; drag the bot higher and re-run`); continue; }
    const preset = rolePreset(role.name);
    try {
      await botCall(env, `/guilds/${guildId}/roles/${role.id}`, 'PATCH', { permissions: preset.perms }, { 'X-Audit-Log-Reason': 'Kyro auto permissions' });
      applied.push(`${role.name} → ${preset.label}`);
    } catch (err) { skipped.push(`${role.name} — failed: ${err.message || 'unknown error'}`); }
  }
  return { applied, skipped };
}

/* /setup verification — ensure a Verified role + verify channel with a working button. */
async function setupVerificationInChannel(env, guildId, channelId) {
  const roles = await botCall(env, `/guilds/${guildId}/roles`);
  let role = roles.find(r => !r.managed && r.name === 'Verified');
  let created = false;
  if (!role) {
    role = await botCall(env, `/guilds/${guildId}/roles`, 'POST',
      { name: 'Verified', color: 0x30D158, permissions: '0', mentionable: false },
      { 'X-Audit-Log-Reason': 'Kyro verification setup' });
    created = true;
  }
  let channel = null;
  if (channelId) { try { channel = await botCall(env, `/channels/${channelId}`); } catch {} }
  if (!channel || channel.guild_id !== guildId) {
    const channels = await botCall(env, `/guilds/${guildId}/channels`);
    channel = channels.find(c => c.type === 0 && /verify/i.test(c.name)) || null;
    if (!channel) {
      channel = await botCall(env, `/guilds/${guildId}/channels`, 'POST',
        { name: '✅┃verify', type: 0, topic: 'Press Verify to unlock the server.' },
        { 'X-Audit-Log-Reason': 'Kyro verification setup' });
    }
  }
  const overwrites = Array.isArray(channel.permission_overwrites) ? channel.permission_overwrites.slice() : [];
  const upsert = (id, type, allowAdd, denyAdd) => {
    const i = overwrites.findIndex(o => o.id === id && o.type === type);
    const allow = BigInt(i >= 0 ? (overwrites[i].allow || '0') : '0') | allowAdd;
    const deny = BigInt(i >= 0 ? (overwrites[i].deny || '0') : '0') | denyAdd;
    const entry = { id, type, allow: allow.toString(), deny: deny.toString() };
    if (i >= 0) overwrites[i] = entry; else overwrites.push(entry);
  };
  upsert(guildId, 0, 0n, 2048n | 64n);                  // @everyone: no send / react until verified
  upsert(role.id, 0, 1024n | 2048n | 65536n | 64n, 0n); // Verified: view / send / history / react
  await botCall(env, `/channels/${channel.id}`, 'PATCH', { permission_overwrites: overwrites }, { 'X-Audit-Log-Reason': 'Kyro verification setup' });
  await botCall(env, `/channels/${channel.id}/messages`, 'POST', {
    embeds: [{
      title: '🔒 Verify to unlock the server',
      description: 'Press **Verify** below to prove you are human and unlock every channel.\nThis keeps spammers and raiders out.',
      color: 0x30D158,
      footer: { text: 'Kyro Staff Bot', icon_url: KYRO_ICON_URL }
    }],
    components: [{ type: 1, components: [{ type: 2, style: 3, label: '✅ Verify', custom_id: `kyro-verify:${guildId}:${role.id}` }] }]
  }, { 'X-Audit-Log-Reason': 'Kyro verification setup' });
  const gated = await gateUntilVerified(env, guildId, channel.id, role);
  return { channelId: channel.id, roleId: role.id, created, gated };
}

/* Mandatory verification: every channel except the verify channel is hidden
   from @everyone and opened to the Verified role (plus staff bypass roles).
   Channels already hidden (staff hub, private tickets) are left untouched, and
   legacy gates that wrote role allows as member overwrites (type 1) are repaired. */
async function gateUntilVerified(env, guildId, verifyChannelId, verifiedRole) {
  const [channels, me, roles] = await Promise.all([
    botCall(env, `/guilds/${guildId}/channels`),
    botCall(env, `/users/@me`),
    botCall(env, `/guilds/${guildId}/roles`)
  ]);
  const roleIds = new Set((Array.isArray(roles) ? roles : []).map(r => r.id));
  const chat = PERM.VIEW | PERM.SEND | PERM.REACT | PERM.EMBED | PERM.ATTACH | PERM.HISTORY | PERM.EXTERN | PERM.STICKER | PERM.CONNECT | PERM.SPEAK | PERM.APPCMD | PERM.THREAD_CREATE | PERM.THREAD_SEND;
  const allowRoles = (Array.isArray(roles) ? roles : [])
    .filter(r => !r.managed && /(admin|owner|mod|staff|helper|trial|bot)/i.test(r.name))
    .concat([verifiedRole]);
  let gated = 0;
  for (const ch of Array.isArray(channels) ? channels : []) {
    if (![0, 2, 5, 15].includes(ch.type) || ch.id === verifyChannelId) continue;
    let overwrites = Array.isArray(ch.permission_overwrites) ? ch.permission_overwrites.slice() : [];
    const hadBad = overwrites.some(o => o.type === 1 && roleIds.has(o.id));
    overwrites = overwrites.filter(o => !(o.type === 1 && roleIds.has(o.id)));
    const idx = overwrites.findIndex(o => o.id === guildId && o.type === 0);
    const allow = BigInt(idx >= 0 ? (overwrites[idx].allow || '0') : '0');
    const deny = BigInt(idx >= 0 ? (overwrites[idx].deny || '0') : '0');
    if ((deny & PERM.VIEW) !== 0n && !hadBad) continue;
    const entry = { id: guildId, type: 0, allow: (allow & ~PERM.VIEW).toString(), deny: (deny | PERM.VIEW).toString() };
    if (idx >= 0) overwrites[idx] = entry; else overwrites.push(entry);
    for (const r of allowRoles) {
      const bi = overwrites.findIndex(o => o.id === r.id && o.type === 0);
      const bAllow = BigInt(bi >= 0 ? (overwrites[bi].allow || '0') : '0') | chat;
      const e = { id: r.id, type: 0, allow: bAllow.toString(), deny: bi >= 0 ? overwrites[bi].deny : '0' };
      if (bi >= 0) overwrites[bi] = e; else overwrites.push(e);
    }
    const botAllow = PERM.VIEW | PERM.SEND | PERM.REACT | PERM.EMBED | PERM.ATTACH | PERM.HISTORY | PERM.MANAGE_MSG | PERM.THREAD_CREATE | PERM.THREAD_SEND;
    const oi = overwrites.findIndex(o => o.id === me.id && o.type === 1);
    const botEntry = { id: me.id, type: 1, allow: String(botAllow), deny: '0' };
    if (oi >= 0) overwrites[oi] = botEntry; else overwrites.push(botEntry);
    try {
      await botCall(env, `/channels/${ch.id}`, 'PATCH', { permission_overwrites: overwrites }, { 'X-Audit-Log-Reason': 'Kyro verification gate' });
      gated++;
    } catch {}
  }
  return gated;
}

/* Support / modmail tickets: a member presses "Open Ticket" and gets a private
   channel with the staff team. No gateway or storage needed — the member's id
   lives in the channel topic and the button custom_id, so the Close button can
   verify ownership statelessly. */
async function openTicketChannel(env, guildId, userId) {
  const guild = await botCall(env, `/guilds/${guildId}`);
  const user = await botCall(env, `/users/${userId}`);
  const channels = await botCall(env, `/guilds/${guildId}/channels`);
  const existing = (Array.isArray(channels) ? channels : [])
    .find(c => c.type === 0 && String(c.topic || '').includes('Support ticket for') && String(c.topic || '').includes(userId));
  if (existing) return { existingId: existing.id };
  const overwrites = [
    { id: guildId, type: 0, allow: '0', deny: '1024' },
    { id: userId, type: 1, allow: VIEW_OR_SEND, deny: '0' },
    { id: guild.owner_id, type: 1, allow: VIEW_OR_SEND, deny: '0' }
  ];
  // type 0 is a ROLE overwrite; a role id sent as type 1 (member) makes Discord
  // reject the whole channel with 400, which is what broke Open Ticket.
  const modRoleId = String(env.DISCORD_MOD_ROLE_ID || '');
  const hasModRole = /^\d{17,20}$/.test(modRoleId);
  if (hasModRole) overwrites.push({ id: modRoleId, type: 0, allow: VIEW_OR_SEND, deny: '0' });
  const payload = {
    name: ('support-' + String(user.username || 'member').toLowerCase().replace(/[^a-z0-9]+/g, '-')).slice(0, 90),
    type: 0,
    topic: `Support ticket for ${userId}`,
    permission_overwrites: overwrites
  };
  let channel;
  try {
    channel = await botCall(env, `/guilds/${guildId}/channels`, 'POST', payload, { 'X-Audit-Log-Reason': 'Kyro support ticket' });
  } catch (first) {
    // A stale/invalid mod role must never cost a member their ticket.
    if (!hasModRole) throw first;
    payload.permission_overwrites = overwrites.filter(o => o.id !== modRoleId);
    channel = await botCall(env, `/guilds/${guildId}/channels`, 'POST', payload, { 'X-Audit-Log-Reason': 'Kyro support ticket' });
  }
  // Ping the owner and the mod role so staff know a ticket is waiting even if
  // they are not watching the channel list.
  const staffMentions = [`<@${guild.owner_id}>`];
  if (hasModRole) staffMentions.push(`<@&${modRoleId}>`);
  await botCall(env, `/channels/${channel.id}/messages`, 'POST', {
    content: `<@${userId}> ${staffMentions.join(' ')} — a new support ticket is open.`,
    allowed_mentions: { parse: ['users', 'roles'] },
    embeds: [{
      author: { name: 'Kyro Support', icon_url: KYRO_ICON_URL },
      description: `Hey <@${userId}>, welcome to Kyro Support!\n\nA member of our staff team has been notified and will be with you shortly. While you wait, please share the following details so we can help you faster:\n• Issue or Question: Clearly describe what you need assistance with.\n• Screenshots / Proof: Paste any relevant screenshots (ss) for reference.\n\nOnce your issue is resolved, we’d appreciate it if you could leave a review on our website using the Leave Feedback button below.\n\nYou can close this ticket anytime using the Close Ticket button.`,
      color: 0x2997FF,
      timestamp: new Date().toISOString()
    }],
    components: [{ type: 1, components: [
      { type: 2, style: 3, label: 'Claim Ticket', custom_id: `kyro-ticket:claim:${guildId}:${userId}` },
      { type: 2, style: 4, label: 'Close Ticket', custom_id: `kyro-ticket:close:${guildId}:${userId}` },
      { type: 2, style: 5, label: 'Leave Feedback ↗', url: 'https://kyro.new.tg#feedback' }
    ] }]
  });
  return { channelId: channel.id, guildName: guild.name };
}

/* Appeal button in the ban DM opens a private ticket only the owner can decide on. */
async function openAppealTicket(env, guildId, requesterId, applicationId) {
  const guild = await botCall(env, `/guilds/${guildId}`);
  let banInfo = {};
  try { banInfo = await botCall(env, `/guilds/${guildId}/bans/${requesterId}`); } catch { return { alreadyUnbanned: true }; }
  const requester = await botCall(env, `/users/${requesterId}`);
  const channel = await botCall(env, `/guilds/${guildId}/channels`, 'POST', {
    name: ('unban-appeal-' + (requester.username || 'member').toLowerCase().replace(/[^a-z0-9]+/g, '-')).slice(0, 90),
    type: 0,
    permission_overwrites: [
      { id: guildId, type: 0, deny: '1024', allow: '0' },
      { id: guild.owner_id, type: 1, allow: VIEW_OR_SEND, deny: '0' },
      { id: applicationId, type: 1, allow: VIEW_OR_SEND, deny: '0' },
      { id: requesterId, type: 1, allow: VIEW_OR_SEND, deny: '0' }
    ]
  });
  const message = await botCall(env, `/channels/${channel.id}/messages`, 'POST', {
    content: `<@${guild.owner_id}> — unban request from <@${requesterId}>`,
    allowed_mentions: { parse: ['users'] },
    embeds: [{
      author: { name: 'Kyro Unban Appeal', icon_url: KYRO_ICON_URL },
      title: `Request from ${requester.username}`,
      description: `**User:** <@${requesterId}> (\`${requesterId}\`)\n**Ban reason:** ${banInfo.reason || 'No reason recorded'}`,
      color: 0xf59e0b,
      timestamp: new Date().toISOString()
    }],
    components: [{
      type: 1,
      components: [
        { type: 2, style: 3, label: 'Approve Unban', custom_id: `kyro-appeal:accept:${guildId}:${requesterId}` },
        { type: 2, style: 4, label: 'Keep Banned', custom_id: `kyro-appeal:deny:${guildId}:${requesterId}` }
      ]
    }]
  });
  return { channelId: channel.id, messageId: message.id, ownerId: guild.owner_id, guildName: guild.name };
}

function disableAppealButtons(guildId, userId) {
  return [{
    type: 1,
    components: [
      { type: 2, style: 3, label: 'Approve Unban', custom_id: `kyro-appeal:accept:${guildId}:${userId}`, disabled: true },
      { type: 2, style: 4, label: 'Keep Banned', custom_id: `kyro-appeal:deny:${guildId}:${userId}`, disabled: true }
    ]
  }];
}


function applicationMessage(row) {
  const role = ROLES.find(item => item.id === row.role);
  const label = row.status === 'approved' ? 'Approved' : row.status === 'declined' ? 'Declined' : 'Pending review';
  const fields = [
    { name: 'Applicant’s Discord tag', value: safeText(row.tag), inline: true },
    { name: 'Discord User ID', value: row.by, inline: true },
    { name: 'Account Creation Date (UTC)', value: row.account_created.slice(0, 10), inline: true },
    { name: 'Applied Role', value: role.title, inline: true },
    { name: 'Status', value: label, inline: true }
  ];
  for (const field of row.fields) {
    const value = safeText(String(row.answers[field.id] === true ? 'Agreed' : row.answers[field.id] || 'Not provided'));
    for (let offset = 0; offset < value.length; offset += 1000) fields.push({ name: field.label + (offset ? ' (continued)' : ''), value: value.slice(offset, offset + 1000), inline: false });
  }
    const claiming = row.claimed_by ? ' (Claimed by <@' + row.claimed_by + '>)' : '';
    fields.push({ name: 'Reviewed By', value: (row.reviewed_by ? '<@' + row.reviewed_by + '>' : 'Not reviewed') + claiming, inline: true });
    if (row.claimed_by && !row.reviewed_by) fields.push({ name: 'Claimed By', value: '<@' + row.claimed_by + '>', inline: true });
    if (row.decline_reason) fields.push({ name: 'Rejection Reason', value: safeText(row.decline_reason), inline: false });
  const embeds = [];
  let current, length = 0;
  for (const field of fields) {
    if (!current || current.fields.length === 25 || length + field.name.length + Math.max(40, field.value.length) > 5400) {
      current = { title: role.title + ' application' + (embeds.length ? ' — continued' : ''), author: { name: 'Kyro Applications', icon_url: ICON }, color: row.status === 'approved' ? 0x10b981 : row.status === 'declined' ? 0xef4444 : 0x5865f2, fields: [], footer: { text: 'Private staff review · ' + row.id }, timestamp: row.created };
      embeds.push(current); length = 200;
    }
    current.fields.push(field); length += field.name.length + Math.max(40, field.value.length);
  }
  return embeds.map((embed, index) => ({
    embeds: [embed], allowed_mentions: { parse: [], users: [], roles: [] },
    components: index === embeds.length - 1 ? [
      {
        type: 1,
        components: [
          {
            type: 3,
            custom_id: 'kyro-app:role:' + row.by + ':' + row.id,
            placeholder: 'Choose role to grant upon approval...',
            disabled: row.status !== 'pending',
            options: [
              { label: 'Grant Support Role', value: ROLE_IDS.support, description: 'Assigns @Support role', default: row.role === 'support' },
              { label: 'Grant Contributor Role', value: ROLE_IDS.contributor, description: 'Assigns @Contributor role', default: row.role === 'contributor' },
              { label: 'Grant Mod+ Role', value: ROLE_IDS.moderator, description: 'Assigns @Mod+ role', default: row.role === 'moderator' },
              { label: 'Do not assign a role', value: 'none', description: 'Approve without granting Discord role' }
            ]
          }
        ]
      },
      {
        type: 1,
        components: [
          { type: 2, style: 3, label: 'Approve', custom_id: 'kyro-app:approved:' + row.by + ':' + row.id, disabled: row.status !== 'pending' },
          { type: 2, style: 4, label: 'Decline', custom_id: 'kyro-app:declined:' + row.by + ':' + row.id, disabled: row.status !== 'pending' },
          { type: 2, style: 1, label: row.claimed_by ? 'Claimed' : 'Claim Ticket', custom_id: 'kyro-app:claim:' + row.by + ':' + row.id, disabled: Boolean(row.claimed_by) || row.status !== 'pending' },
          { type: 2, style: 2, label: 'Close Ticket', custom_id: 'kyro-app:close:' + row.by + ':' + row.id }
        ]
      }
    ] : []
  }));
}

export class KyroApplications {
  constructor(state, env) { this.state = state; this.env = env; }

  async fetch(request) {
    try {
      const input = await request.json();
      const storage = this.state.storage;
      if (input.action === 'list') {
        const ids = await storage.list({ prefix: 'latest:' });
        const applications = [];
        for (const id of ids.values()) applications.push(publicApplication(await storage.get(applicationKey(id)), this.env));
        return response({ applications });
      }
      if (input.action === 'status') {
        const row = await storage.get(applicationKey(input.id));
        if (!row) throw error(404, 'application_not_found', 'Application not found.');
        return response({ application: publicApplication(row, this.env) });
      }
      if (input.action === 'select_role') {
        return await storage.transaction(async tx => {
          const row = await tx.get(applicationKey(input.id));
          if (!row) throw error(404, 'application_not_found', 'Application not found.');
          row.selected_role_id = input.roleId;
          await tx.put(applicationKey(row.id), row);
          return response({ ok: true, roleId: input.roleId });
        });
      }
      if (input.action === 'claim') {
        const guild = await botCall(this.env, '/guilds/' + (this.env.DISCORD_GUILD_ID || this.env.KYRO_GUILD_ID));
        if (guild.owner_id !== input.reviewer) {
          const member = await botCall(this.env, '/guilds/' + (this.env.DISCORD_GUILD_ID || this.env.KYRO_GUILD_ID) + '/members/' + input.reviewer);
          if (!member.roles?.includes(String(this.env.DISCORD_MOD_ROLE_ID))) throw error(403, 'not_a_reviewer', 'Only the server owner or configured moderator role can claim applications.');
        }
        return await storage.transaction(async tx => {
          const row = await tx.get(applicationKey(input.id));
          if (!row) throw error(404, 'application_not_found', 'Application not found.');
          row.claimed_by = input.reviewer;
          await tx.put(applicationKey(row.id), row);
          await tx.put('job:' + row.id, { id: row.id, stage: 'review', attempts: 0 });
          if (await tx.getAlarm() === null) await tx.setAlarm(Date.now());
          return response({ ok: true, claimed_by: input.reviewer });
        });
      }
      if (input.action === 'close') {
        const guild = await botCall(this.env, '/guilds/' + (this.env.DISCORD_GUILD_ID || this.env.KYRO_GUILD_ID));
        if (guild.owner_id !== input.reviewer) {
          const member = await botCall(this.env, '/guilds/' + (this.env.DISCORD_GUILD_ID || this.env.KYRO_GUILD_ID) + '/members/' + input.reviewer);
          if (!member.roles?.includes(String(this.env.DISCORD_MOD_ROLE_ID))) throw error(403, 'not_a_reviewer', 'Only the server owner or configured moderator role can close applications.');
        }
        const row = await storage.get(applicationKey(input.id));
        if (row) {
          if (row.notice_channel_id && row.notice_message_id) {
            try { await botCall(this.env, '/channels/' + row.notice_channel_id + '/messages/' + row.notice_message_id, 'DELETE'); } catch {}
          }
          if (row.channel_id) {
            try { await botCall(this.env, '/channels/' + row.channel_id, 'DELETE'); } catch {}
          }
          await storage.delete('job:' + row.id);
          await storage.delete('auto_close:' + row.id);
        }
        return response({ ok: true });
      }
      if (input.action === 'reset_all') {
        await storage.deleteAll();
        return response({ ok: true, message: 'All applications cleared.' });
      }
      if (input.action === 'create') {
        return await storage.transaction(async tx => {
          const active = await tx.get('active:' + input.row.role);
          if (active) return response({ error: 'You already have an active application for this role.', code: 'duplicate_application', application: publicApplication(await tx.get(applicationKey(active)), this.env) }, 409);
          await tx.put(applicationKey(input.row.id), input.row);
          await tx.put('active:' + input.row.role, input.row.id);
          await tx.put('latest:' + input.row.role, input.row.id);
          await tx.put('job:' + input.row.id, { id: input.row.id, stage: 'create', attempts: 0 });
          if (await tx.getAlarm() === null) await tx.setAlarm(Date.now());
          return response({ application: publicApplication(input.row, this.env) }, 201);
        });
      }
      if (input.action === 'review') {
        const guild = await botCall(this.env, '/guilds/' + (this.env.DISCORD_GUILD_ID || this.env.KYRO_GUILD_ID));
        if (guild.owner_id !== input.reviewer) {
          const member = await botCall(this.env, '/guilds/' + (this.env.DISCORD_GUILD_ID || this.env.KYRO_GUILD_ID) + '/members/' + input.reviewer);
          if (!member.roles?.includes(String(this.env.DISCORD_MOD_ROLE_ID))) throw error(403, 'not_a_reviewer', 'Only the server owner or configured moderator role can review applications.');
        }
        return await storage.transaction(async tx => {
          const row = await tx.get(applicationKey(input.id));
          if (!row || row.channel_id !== input.channelId || (input.messageId && row.message_id !== input.messageId)) throw error(404, 'application_not_found', 'Application not found in this channel.');
          if (row.status !== 'pending') throw error(409, 'already_reviewed', 'This application is already reviewed or is not ready for review.');
          row.status = input.status; row.reviewed_by = input.reviewer; row.reviewed_at = new Date().toISOString();
          if (input.reason) row.decline_reason = input.reason;
          await tx.put(applicationKey(row.id), row);
          await tx.delete('active:' + row.role);
          await tx.put('job:' + row.id, { id: row.id, stage: 'review', attempts: 0 });
          if (await tx.getAlarm() === null) await tx.setAlarm(Date.now());
          return response({ application: publicApplication(row, this.env) });
        });
      }
      throw error(400, 'bad_action', 'Unknown application action.');
    } catch (err) { return response({ error: err.message, code: err.code || 'application_error' }, err.status || 500); }
  }

  async alarm() {
    await this.state.blockConcurrencyWhile(() => this.deliver());
  }

  async deliver() {
    const storage = this.state.storage;

    // Check auto_close tickets
    const autoCloseEntries = await storage.list({ prefix: 'auto_close:', limit: 5 });
    for (const [key, item] of autoCloseEntries) {
      if (Date.now() >= (item.closeAt || 0)) {
        const row = await storage.get(applicationKey(item.id));
        if (row) {
          if (row.notice_channel_id && row.notice_message_id) {
            try { await botCall(this.env, '/channels/' + row.notice_channel_id + '/messages/' + row.notice_message_id, 'DELETE'); } catch {}
          }
          if (row.channel_id) {
            try { await botCall(this.env, '/channels/' + row.channel_id, 'DELETE'); } catch {}
          }
        }
        await storage.delete(key);
      }
    }

    const jobs = await storage.list({ prefix: 'job:', limit: 1 });
    const entry = jobs.entries().next().value;
    if (!entry) return;
    const [key, job] = entry;
    const row = await storage.get(applicationKey(job.id));
    let channelAttempted = false;
    try {
      if (!applicationConfiguration(this.env).open && job.stage !== 'review') throw error(503, 'applications_closed', 'Applications are closed.');
      if (job.stage === 'create') {
        const guildId = String((this.env.DISCORD_GUILD_ID || this.env.KYRO_GUILD_ID));
        const [bot, category, roles, publicChannel, guild] = await Promise.all([
          botCall(this.env, '/users/@me'), botCall(this.env, '/channels/' + this.env.DISCORD_APPLICATIONS_CATEGORY_ID), botCall(this.env, '/guilds/' + guildId + '/roles'),
          botCall(this.env, '/channels/' + this.env.DISCORD_PUBLIC_APPS_CHANNEL_ID), botCall(this.env, '/guilds/' + guildId)
        ]);
        if (!bot.bot || !snowflake(bot.id) || category.type !== 4 || category.guild_id !== guildId || !roles.some(role => role.id === String(this.env.DISCORD_MOD_ROLE_ID)) || publicChannel.type !== 0 || publicChannel.guild_id !== guildId || !snowflake(guild.owner_id)) throw error(502, 'discord_configuration', 'Check the bot, category, public text channel, and moderator role configuration.');
        row.notice_channel_id = publicChannel.id;
        row.owner_id = guild.owner_id;
        const role = ROLES.find(item => item.id === row.role);
        const username = row.username.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}-]/gu, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || row.by;
        await storage.transaction(async tx => {
          await tx.put(applicationKey(row.id), row);
          await tx.put(key, { ...job, stage: 'reconcile' });
          await tx.setAlarm(Date.now() + 10000);
        });
        channelAttempted = true;
        const channel = await botCall(this.env, '/guilds/' + guildId + '/channels', 'POST', {
          name: (role.prefix + '-' + username).slice(0, 100), type: 0, parent_id: String(this.env.DISCORD_APPLICATIONS_CATEGORY_ID), topic: 'Kyro application ' + row.id,
          permission_overwrites: [
            { id: guildId, type: 0, deny: '1024', allow: '0' },
            { id: String(this.env.DISCORD_MOD_ROLE_ID), type: 0, allow: '68608', deny: '0' },
            { id: bot.id, type: 1, allow: '68608', deny: '0' },
            // Staff-only review by default; the applicant joins only when an
            // interview is enabled, so private review stays private otherwise.
            ...(this.env.KYRO_APPLICATION_INTERVIEW_ENABLED === 'true' ? [{ id: row.by, type: 1, allow: '68608', deny: '0' }] : [])
          ]
        });
        if (!snowflake(channel.id)) throw Object.assign(error(502, 'discord_uncertain', 'Discord channel creation needs staff attention.'), { uncertain: true });
        row.channel_id = channel.id;
        await storage.transaction(async tx => {
          await tx.put(applicationKey(row.id), row);
          await tx.put(key, { id: row.id, stage: 'message', index: 0, attempts: 0 });
          await tx.setAlarm(Date.now());
        });
        return;
      }
      if (job.stage === 'reconcile') {
        const channels = await botCall(this.env, '/guilds/' + (this.env.DISCORD_GUILD_ID || this.env.KYRO_GUILD_ID) + '/channels');
        const matches = channels.filter(channel => channel.topic === 'Kyro application ' + row.id && channel.parent_id === String(this.env.DISCORD_APPLICATIONS_CATEGORY_ID) && channel.type === 0);
        if (matches.length !== 1) throw error(502, 'discord_uncertain', 'Channel creation needs staff attention; no duplicate channel was created.');
        row.channel_id = matches[0].id;
        await storage.transaction(async tx => {
          await tx.put(applicationKey(row.id), row);
          await tx.put(key, { id: row.id, stage: 'message', index: 0, attempts: 0 });
          await tx.setAlarm(Date.now());
        });
        return;
      }
      if (job.stage === 'notice') {
        job.started ||= Date.now();
        if (Date.now() - job.started >= 240000) throw error(502, 'discord_nonce_expired', 'Public notice delivery needs staff attention.');
        await storage.transaction(async tx => { await tx.put(key, job); await tx.setAlarm(Date.now() + 10000); });
        const message = await botCall(this.env, '/channels/' + row.notice_channel_id + '/messages', 'POST', {
          content: 'A staff application ticket is ready for private review.\nTicket: <#' + row.channel_id + '>\nReviewers: <@' + row.owner_id + '> and <@&' + this.env.DISCORD_MOD_ROLE_ID + '>.\nApplication answers are visible only in the private ticket.',
          allowed_mentions: { parse: [], users: [], roles: [] },
          nonce: row.id.replace(/-/g, '').slice(0, 20) + '-pub', enforce_nonce: true
        });
        if (!snowflake(message.id)) throw Object.assign(error(502, 'discord_bad_message', 'Discord did not confirm the public notice.'), { uncertain: true });
        row.notice_message_id = message.id;
        row.status = 'pending';
        await storage.transaction(async tx => {
          await tx.put(applicationKey(row.id), row);
          await tx.delete(key);
          if ((await tx.list({ prefix: 'job:', limit: 1 })).size) await tx.setAlarm(Date.now());
        });
        return;
      }
      if (job.stage === 'message' || job.stage === 'review') {
        const parts = applicationMessage(job.stage === 'message' ? { ...row, status: 'pending' } : row);
        const index = job.index || 0;
        if (job.stage === 'message') {
          job.started ||= Date.now();
          if (Date.now() - job.started >= 240000) throw error(502, 'discord_nonce_expired', 'Message delivery needs staff attention.');
          await storage.transaction(async tx => { await tx.put(key, job); await tx.setAlarm(Date.now() + 10000); });
          const message = await botCall(this.env, '/channels/' + row.channel_id + '/messages', 'POST', { ...parts[index], nonce: row.id.replace(/-/g, '').slice(0, 20) + '-' + index, enforce_nonce: true });
          if (!snowflake(message.id)) throw Object.assign(error(502, 'discord_bad_message', 'Discord did not confirm the review message.'), { uncertain: true });
          row.message_ids ||= [];
          row.message_ids[index] = message.id;
          if (index === parts.length - 1) { row.message_id = message.id; }
        } else {
          await botCall(this.env, '/channels/' + row.channel_id + '/messages/' + row.message_ids[index], 'PATCH', parts[index]);
          if (row.status === 'approved' && row.selected_role_id !== 'none') {
            const roleToAssign = row.selected_role_id || ROLE_IDS[row.role];
            if (roleToAssign && snowflake(roleToAssign)) {
              try {
                const guildId = String((this.env.DISCORD_GUILD_ID || this.env.KYRO_GUILD_ID));
                await botCall(this.env, '/guilds/' + guildId + '/members/' + row.by + '/roles/' + roleToAssign, 'PUT');
              } catch (roleErr) {
                console.warn('[kyro-applications] Role assignment failed on approval:', roleErr);
              }
            }
          }
        }
        await storage.transaction(async tx => {
          await tx.put(applicationKey(row.id), row);
          if (index < parts.length - 1) await tx.put(key, { id: row.id, stage: job.stage, index: index + 1, attempts: 0 });
          else if (job.stage === 'message') await tx.put(key, { id: row.id, stage: 'notice', attempts: 0 });
          else {
            await tx.delete(key);
            if (row.status === 'approved' || row.status === 'declined') {
              await tx.put('auto_close:' + row.id, { id: row.id, closeAt: Date.now() + 5 * 60 * 1000 });
              await tx.setAlarm(Date.now() + 5 * 60 * 1000);
            }
          }
          if ((await tx.list({ prefix: 'job:', limit: 1 })).size) await tx.setAlarm(Date.now());
        });
      }
    } catch (err) {
      if (channelAttempted && (err.uncertain || !err.code)) {
        await storage.put(key, { id: job.id, stage: 'reconcile', attempts: 0 });
        await storage.setAlarm(Date.now() + 5000);
      } else if ((err.retryAfter !== undefined || err.uncertain) && job.attempts < 4 && (!['message', 'notice'].includes(job.stage) || Date.now() + (err.retryAfter || 5000) - job.started < 240000)) {
        await storage.put(key, { ...job, attempts: job.attempts + 1 });
        await storage.setAlarm(Date.now() + (err.retryAfter || 5000));
      } else {
        if (job.stage !== 'review') { row.status = 'needs_attention'; await storage.put(applicationKey(row.id), row); }
        await storage.delete(key);
        if ((await storage.list({ prefix: 'job:', limit: 1 })).size) await storage.setAlarm(Date.now());
        console.warn('[kyro-applications] ' + row.id + ': ' + (err.code || 'delivery_failed'));
      }
    }
  }
}

const hexBytes = hex => Uint8Array.from(hex.match(/.{2}/g), byte => parseInt(byte, 16));
export async function handleApplicationInteractions(request, env, ctx) {
  if (request.method !== 'POST') return response({ error: 'Use POST.' }, 405);
  const signature = request.headers.get('x-signature-ed25519') || '';
  const timestamp = request.headers.get('x-signature-timestamp') || '';
  if (!/^[a-f\d]{128}$/i.test(signature) || !/^\d{10}$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 || !/^[a-f\d]{64}$/i.test(env.DISCORD_APPLICATION_PUBLIC_KEY || '')) return response({ error: 'Invalid interaction signature.' }, 401);
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > 32000) return response({ error: 'Interaction too large.' }, 413);
  const key = await crypto.subtle.importKey('raw', hexBytes(env.DISCORD_APPLICATION_PUBLIC_KEY), 'Ed25519', false, ['verify']);
  if (!await crypto.subtle.verify('Ed25519', key, hexBytes(signature), new TextEncoder().encode(timestamp + raw))) return response({ error: 'Invalid interaction signature.' }, 401);
  let interaction;
  try { interaction = JSON.parse(raw); } catch { return response({ error: 'Invalid interaction.' }, 400); }
  if (!interaction || typeof interaction !== 'object' || Array.isArray(interaction)) return response({ error: 'Invalid interaction.' }, 400);
  if (interaction.type === 1) return response({ type: 1 });

  // Slash commands (Interaction Type 2)
  if (interaction.type === 2) {
    const cmdName = interaction.data?.name;
    const guildId = interaction.guild_id;
    const member = interaction.member;
    const memberRoles = member?.roles || [];
    // Dynamic permission check: Administrator (0x8) or Manage Server (0x20)
    const permissions = BigInt(member?.permissions || '0');
    const hasAdminPerm = (permissions & BigInt(0x8)) === BigInt(0x8) || (permissions & BigInt(0x20)) === BigInt(0x20);
    const isKyroOwner = member?.user?.id === '1052909930073567232' || memberRoles.includes('1539968441094512710');
    const isModOrOwner = isKyroOwner || hasAdminPerm || memberRoles.includes(String(env.DISCORD_MOD_ROLE_ID));

    if (cmdName === 'invite') {
      return response({
        type: 4,
        data: {
          content: `Here is the official invite link for Kyro:\nhttps://discord.gg/N3KJBSWrkR\nWebsite: https://kyro.new.tg`,
          flags: 64
        }
      });
    }

    if (cmdName === 'stats') {
      return response({
        type: 4,
        data: {
          content: `**Kyro Community & Vault**\n• Website: https://kyro.new.tg\n• Operating Systems: Windows & macOS\n• Free & verified builds: .zxp, .jsxbin, .ffx presets, and video tools.\n• Community: 90+ verified editors.`,
          flags: 64
        }
      });
    }

    if (cmdName === 'sync') {
      return response({
        type: 4,
        data: {
          content: `Your profile has been synchronized with the Kyro database. If you downloaded assets or applied for staff, refresh verification at https://kyro.new.tg`,
          flags: 64
        }
      });
    }

    if (cmdName === 'start-kyro') {
      const canLaunch = isKyroOwner || hasAdminPerm;
      if (!canLaunch) {
        return response({
          type: 4,
          data: { content: '❌ Only Server Owners or Administrators can launch the Bot Control Center.', flags: 64 }
        });
      }

      ctx.waitUntil((async () => {
        try {
          // Send signal to localhost dashboard if running
          await fetch('http://127.0.0.1:4000/api/launch', { method: 'POST', signal: AbortSignal.timeout(2000) }).catch(() => {});
        } catch (e) {}

        // Wait 3 seconds, then delete the original ephemeral confirmation so no traces remain
        await new Promise(r => setTimeout(r, 3000));
        try {
          await fetch(DISCORD_API + '/webhooks/' + interaction.application_id + '/' + interaction.token + '/messages/@original', {
            method: 'DELETE'
          });
        } catch (delErr) {
          console.warn('[kyro-bot] Failed to delete /start-kyro message:', delErr);
        }
      })());

      return response({
        type: 4,
        data: {
          content: '⚡ **Kyro Staff Bot Dashboard opening on Localhost:**\n👉 http://localhost:4000\n*(This confirmation message will self-delete in 3 seconds)*',
          flags: 64
        }
      });
    }

    if (cmdName === 'role') {
      if (!isModOrOwner) {
        return response({
          type: 4,
          data: { content: '❌ You must be a Mod+ or Server Owner to manage member roles.', flags: 64 }
        });
      }

      const subCommand = interaction.data?.options?.[0]?.name;
      const opts = interaction.data?.options?.[0]?.options || [];
      const targetUserId = opts.find(o => o.name === 'user')?.value;
      const targetRoleId = opts.find(o => o.name === 'role')?.value;

      if (!targetUserId || !targetRoleId) {
        return response({
          type: 4,
          data: { content: '❌ Missing required user or role parameters.', flags: 64 }
        });
      }

      ctx.waitUntil((async () => {
        let reply = '';
        try {
          if (subCommand === 'add') {
            await botCall(env, `/guilds/${guildId}/members/${targetUserId}/roles/${targetRoleId}`, 'PUT');
            reply = `✅ Successfully added <@&${targetRoleId}> to <@${targetUserId}>!`;
          } else if (subCommand === 'remove') {
            await botCall(env, `/guilds/${guildId}/members/${targetUserId}/roles/${targetRoleId}`, 'DELETE');
            reply = `✅ Successfully removed <@&${targetRoleId}> from <@${targetUserId}>!`;
          } else {
            reply = '❌ Unknown sub-command.';
          }
        } catch (err) {
          reply = `❌ Failed to update role: ${err.message || 'Discord permission or hierarchy error'}.\n` +
            `• Drag the **Kyro** role above <@&${targetRoleId}> in Server Settings → Roles.\n` +
            `• If permissions are missing, re-grant Administrator: <https://discord.com/oauth2/authorize?client_id=1570702041993711706&permissions=8&scope=bot%20applications.commands>`;
        }

        try {
          await fetch(DISCORD_API + '/webhooks/' + interaction.application_id + '/' + interaction.token + '/messages/@original', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ content: reply }),
            redirect: 'manual'
          });
        } catch (postErr) {
          console.warn('[kyro-bot] command followup failed:', postErr);
        }
      })());

      return response({ type: 5, data: { flags: 64 } });
    }

    if (cmdName === 'mod') {
      const isOwnerAdmin = isKyroOwner || hasAdminPerm;
      if (!isModOrOwner) {
        return response({ type: 4, data: { content: '❌ Mods and Server Owners only.', flags: 64 } });
      }
      const sub = interaction.data?.options?.[0]?.name;
      const opts = interaction.data?.options?.[0]?.options || [];
      const value = name => opts.find(o => o.name === name)?.value;
      const targetUserId = value('user');
      const reason = value('reason') || '';
      if (OWNER_ONLY_MOD_ACTIONS.includes(sub) && !isOwnerAdmin) {
        return response({ type: 4, data: { content: `❌ \`${sub}\` is owner/administrator only. Mods can use timeout, untimeout, kick, slowmode and purge.`, flags: 64 } });
      }
      if (MOD_ACTIONS.includes(sub) && ['timeout', 'untimeout', 'kick', 'ban', 'unban'].includes(sub) && !targetUserId) {
        return response({ type: 4, data: { content: '❌ A member is required.', flags: 64 } });
      }

      ctx.waitUntil((async () => {
        let reply = '';
        try {
          if (!String(env.DISCORD_BOT_TOKEN || '')) throw new Error('Bot token missing on the worker.');
          const guild = await botCall(env, `/guilds/${guildId}`);
          const guildName = guild.name || 'the server';
          if (['timeout', 'untimeout', 'kick'].includes(sub)) {
            await assertTargetBelow(env, guildId, interaction.member.user.id, targetUserId, Boolean(guild.owner_id === interaction.member.user.id));
          }
          reply = await runModAction(env, guildId, guildName, sub, targetUserId, {
            reason,
            minutes: value('minutes'),
            deleteDays: value('delete_days'),
            amount: value('amount'),
            channelId: value('channel') || interaction.channel_id,
            seconds: value('seconds'),
            lockdownOn: value('state') !== 'off',
            moderator: interaction.member.user.username
          });
        } catch (err) {
          reply = '❌ ' + (err.message || 'Moderation action failed.') +
            (String(err.message).includes('permission') || String(err.message).includes('Missing') ? `\n• Re-grant Administrator: <https://discord.com/oauth2/authorize?client_id=${interaction.application_id}&permissions=8&scope=bot%20applications.commands>` : '');
        }
        try {
          await fetch(DISCORD_API + '/webhooks/' + interaction.application_id + '/' + interaction.token + '/messages/@original', {
            method: 'PATCH', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ content: reply, allowed_mentions: { parse: [] } }), redirect: 'manual', signal: AbortSignal.timeout(8000)
          });
        } catch (postErr) { console.warn('[kyro-bot] mod followup failed:', postErr); }
      })());

      return response({ type: 5, data: { flags: 64 } });
    }

    if (cmdName === 'whois') {
      if (!isModOrOwner) {
        return response({ type: 4, data: { content: '❌ Mods and Server Owners only.', flags: 64 } });
      }
      const opts = interaction.data?.options?.[0]?.options || [];
      const targetUserId = opts.find(o => o.name === 'user')?.value;
      const query = String(opts.find(o => o.name === 'query')?.value || '');
      if (!targetUserId && !query) {
        return response({ type: 4, data: { content: '❌ Pick a user or type a username.', flags: 64 } });
      }
      ctx.waitUntil((async () => {
        let payload;
        try {
          const out = await whoisEmbed(env, guildId, targetUserId, query);
          payload = out.ambiguity ? { content: out.ambiguity, allowed_mentions: { parse: [] } } : { embeds: [out.embed], allowed_mentions: { parse: [] } };
        } catch (err) {
          payload = { content: '❌ ' + (err.message || 'Lookup failed.'), allowed_mentions: { parse: [] } };
        }
        try {
          await fetch(DISCORD_API + '/webhooks/' + interaction.application_id + '/' + interaction.token + '/messages/@original', {
            method: 'PATCH', headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload), redirect: 'manual', signal: AbortSignal.timeout(8000)
          });
        } catch (postErr) { console.warn('[kyro-bot] whois followup failed:', postErr); }
      })());
      return response({ type: 5 });
    }

    if (cmdName === 'setup') {
      if (!isModOrOwner) {
        return response({ type: 4, data: { content: '❌ Mods and Server Owners only.', flags: 64 } });
      }
      const sub = interaction.data?.options?.[0]?.name;
      const subOpts = interaction.data?.options?.[0]?.options || [];
      ctx.waitUntil((async () => {
        let payload;
        try {
          if (sub === 'permissions') {
            const result = await applyRolePresets(env, guildId);
            payload = {
              content: `🛡️ **Auto permissions applied.**\n${result.applied.length ? result.applied.map(r => '• ' + r).join('\n') : 'No roles matched a preset.'}\n\n_Left untouched: ${result.skipped.length} role(s) without a preset (custom roles are never auto-changed)._`,
              allowed_mentions: { parse: [] }
            };
          } else if (sub === 'verification') {
            const out = await setupVerificationInChannel(env, guildId, subOpts.find(o => o.name === 'channel')?.value || interaction.channel_id);
            payload = {
              content: `✅ **Verification is live** in <#${out.channelId}>.\nMembers press **Verify** and get <@&${out.roleId}>${out.created ? ' (created just now)' : ''}.\n**${out.gated} channels** are hidden until members verify.`,
              allowed_mentions: { parse: [] }
            };
          } else {
            payload = { content: 'Unknown setup option.', allowed_mentions: { parse: [] } };
          }
        } catch (err) {
          payload = {
            content: '❌ ' + (err.message || 'Setup failed.') +
              (String(err.message).toLowerCase().includes('permission') || String(err.message).toLowerCase().includes('missing') ? `\n• Re-grant Administrator: <https://discord.com/oauth2/authorize?client_id=${interaction.application_id}&permissions=8&scope=bot%20applications.commands>` : ''),
            allowed_mentions: { parse: [] }
          };
        }
        try {
          await fetch(DISCORD_API + '/webhooks/' + interaction.application_id + '/' + interaction.token + '/messages/@original', {
            method: 'PATCH', headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload), redirect: 'manual', signal: AbortSignal.timeout(8000)
          });
        } catch (postErr) { console.warn('[kyro-bot] setup followup failed:', postErr); }
      })());
      return response({ type: 5 });
    }

    return response({ type: 4, data: { content: 'Unknown command.', flags: 64 } });
  }

  // Modal submissions (Interaction Type 5)
  if (interaction.type === 5) {
    const modalCustomId = interaction.data?.custom_id || '';
    const resourceUpdateModal = /^kyro-upd-modal:([a-z0-9-]{1,85})$/.exec(modalCustomId);
    if (resourceUpdateModal) {
      if (!canMarkResourceUpdated(env, interaction.member)) {
        return response({ type: 4, data: { content: '❌ Only the Server Owner or an administrator can mark a resource updated.', flags: 64 } });
      }
      const rows = interaction.data?.components || [];
      const version = String(rows[0]?.components?.[0]?.value || '').trim();
      const note = String(rows[1]?.components?.[0]?.value || '').trim();
      ctx.waitUntil((async () => {
        let content;
        try {
          const secret = String(env.BOT_PUBLISH_SECRET || '');
          if (!secret) throw new Error('BOT_PUBLISH_SECRET is not set on the worker.');
          const res = await fetch(new URL('/vault/discord/update', request.url), {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-kyro-bot': secret },
            body: JSON.stringify({ slug: resourceUpdateModal[1], version, note, by: interaction.member?.user?.id || '' }),
            signal: AbortSignal.timeout(15000)
          });
          const data = await res.json().catch(() => ({}));
          content = res.ok
            ? `🔄 ${data.title ? '**' + data.title + '** ' : 'Resource '}marked as updated${data.version ? ' to `' + data.version + '`' : ''} — the post was edited and #announcements now says it just got updated.`
            : '❌ ' + (data.error || 'Discord did not accept the update.');
        } catch (err) {
          content = '❌ Could not update that post: ' + (err.message || 'try again later.');
        }
        try {
          await fetch(DISCORD_API + '/webhooks/' + interaction.application_id + '/' + interaction.token + '/messages/@original', {
            method: 'PATCH', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ content, allowed_mentions: { parse: [] } }), redirect: 'manual', signal: AbortSignal.timeout(8000)
          });
        } catch {}
      })());
      return response({ type: 5, data: { flags: 64 } });
    }
    const declineModalMatch = /^kyro-app:decline_modal:(\d{17,20}):([a-f\d-]{36})$/.exec(modalCustomId);
    if (declineModalMatch) {
      const applicantId = declineModalMatch[1];
      const appId = declineModalMatch[2];
      const reasonVal = interaction.data?.components?.[0]?.components?.[0]?.value || 'Application requirements not met';
      ctx.waitUntil((async () => {
        let content;
        try {
          const result = await storageCall(env, applicantId, {
            action: 'review',
            id: appId,
            status: 'declined',
            reviewer: interaction.member?.user?.id,
            reason: reasonVal,
            channelId: interaction.channel_id
          });
          const data = await result.json();
          content = result.ok
            ? `❌ Application declined by <@${interaction.member?.user?.id}>.\n**Reason:** ${reasonVal}\nTicket will automatically close in 5 minutes.`
            : (data.error || 'Failed to decline application.');
        } catch (err) {
          content = 'Action could not be completed: ' + err.message;
        }

        try {
          await fetch(DISCORD_API + '/webhooks/' + interaction.application_id + '/' + interaction.token + '/messages/@original', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ content }),
            redirect: 'manual'
          });
        } catch (postErr) {
          console.warn('[kyro-applications] Decline modal followup failed:', postErr);
        }
      })());

      return response({ type: 5, data: { flags: 64 } });
    }
  }

  const selectMatch = /^kyro-app:role:(\d{17,20}):([a-f\d-]{36})$/.exec(interaction.data?.custom_id || '');
  if (interaction.type === 3 && selectMatch) {
    const selectedRole = interaction.data?.values?.[0] || 'none';
    ctx.waitUntil((async () => {
      try {
        await storageCall(env, selectMatch[1], { action: 'select_role', id: selectMatch[2], roleId: selectedRole });
      } catch (err) { console.warn('[kyro-applications] Failed to save role selection:', err); }
    })());
    return response({ type: 4, data: { content: selectedRole === 'none' ? 'Set to: Do not assign role on approval.' : `Set role to assign on approval: <@&${selectedRole}>`, flags: 64 } });
  }

  // "Open Ticket" button posted by the dashboard's ticket system.
  const ticketOpenMatch = /^kyro-ticket:open:(\d{17,20})$/.exec(interaction.data?.custom_id || '');
  if (interaction.type === 3 && ticketOpenMatch) {
    const [, ticketGuildId] = ticketOpenMatch;
    if (!interaction.member?.user?.id) {
      return response({ type: 4, data: { content: 'Tickets work inside the server only.', flags: 64 } });
    }
    ctx.waitUntil((async () => {
      let ack;
      try {
        const t = await openTicketChannel(env, ticketGuildId, interaction.member.user.id);
        ack = t.existingId ? `📋 You already have an open ticket: <#${t.existingId}>` : `📋 Your ticket is open: <#${t.channelId}>`;
      } catch (err) {
        console.warn('[kyro-ticket] open failed:', err);
        ack = '❌ Could not open your ticket: ' + (err.message || 'try again later.');
      }
      try {
        await fetch(DISCORD_API + '/webhooks/' + interaction.application_id + '/' + interaction.token + '/messages/@original', {
          method: 'PATCH', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: ack, allowed_mentions: { parse: [] } }), redirect: 'manual', signal: AbortSignal.timeout(8000)
        });
      } catch {}
    })());
    return response({ type: 5, data: { flags: 64 } });
  }

  // "Close Ticket" — only the opener or staff can close it.
  const ticketCloseMatch = /^kyro-ticket:close:(\d{17,20}):(\d{17,20})$/.exec(interaction.data?.custom_id || '');
  if (interaction.type === 3 && ticketCloseMatch) {
    const [, ticketGuildId, ticketOwnerId] = ticketCloseMatch;
    const closerId = interaction.member?.user?.id || '';
    let allowed = closerId === ticketOwnerId;
    if (!allowed && closerId) {
      const closerPerms = BigInt(interaction.member?.permissions || '0');
      allowed = (closerPerms & BigInt(0x8)) === BigInt(0x8) || (interaction.member.roles || []).includes(String(env.DISCORD_MOD_ROLE_ID));
    }
    if (!allowed) {
      return response({ type: 4, data: { content: 'Only the ticket opener or staff can close it.', flags: 64 } });
    }
    ctx.waitUntil((async () => {
      try {
        try { await botCall(env, `/channels/${interaction.channel_id}/messages/${interaction.message.id}`, 'PATCH', { components: [] }); } catch {}
        await botCall(env, `/channels/${interaction.channel_id}`, 'DELETE', undefined, { 'X-Audit-Log-Reason': `Ticket closed by ${closerId}` });
      } catch (err) { console.warn('[kyro-ticket] close failed:', err); }
    })());
    return response({ type: 4, data: { content: '🔒 Closing this ticket…', flags: 64 } });
  }

  // "Claim Ticket" — staff-only. The claim is stored in the channel topic and
  // sending is locked to the claimer so two mods never answer at once.
  const ticketClaimMatch = /^kyro-ticket:claim:(\d{17,20}):(\d{17,20})$/.exec(interaction.data?.custom_id || '');
  if (interaction.type === 3 && ticketClaimMatch) {
    const [, ticketGuildId, ticketOwnerId] = ticketClaimMatch;
    const claimerId = interaction.member?.user?.id || '';
    const claimerPerms = BigInt(interaction.member?.permissions || '0');
    const isStaff = (claimerPerms & BigInt(0x8)) === BigInt(0x8) || (interaction.member?.roles || []).includes(String(env.DISCORD_MOD_ROLE_ID));
    if (!isStaff) {
      return response({ type: 4, data: { content: 'Only staff can claim tickets.', flags: 64 } });
    }
    if (claimerId === ticketOwnerId) {
      return response({ type: 4, data: { content: 'You opened this ticket — a staff member claims it to help you.', flags: 64 } });
    }
    ctx.waitUntil((async () => {
      let ack;
      try {
        const channel = await botCall(env, `/channels/${interaction.channel_id}`);
        const topic = String(channel.topic || '');
        const claimed = /claimed by (\d{17,20})/.exec(topic);
        if (claimed) {
          ack = claimed[1] === claimerId ? '🙋 You already claimed this ticket.' : `🔒 This ticket is already claimed by <@${claimed[1]}>.`;
        } else {
          const SEND = BigInt(2048);
          const overwrites = (channel.permission_overwrites || []).map((o) => ({ ...o }));
          const modRoleId = String(env.DISCORD_MOD_ROLE_ID || '');
          for (const o of overwrites) {
            if (o.type === 0 && o.id === modRoleId) {
              o.allow = String(BigInt(o.allow || '0') & ~SEND);
              o.deny = String(BigInt(o.deny || '0') | SEND);
            }
          }
          const mine = overwrites.find((o) => o.type === 1 && o.id === claimerId);
          if (mine) {
            mine.allow = String(BigInt(mine.allow || '0') | BigInt(VIEW_OR_SEND));
            mine.deny = String(BigInt(mine.deny || '0') & ~BigInt(VIEW_OR_SEND));
          } else {
            overwrites.push({ id: claimerId, type: 1, allow: VIEW_OR_SEND, deny: '0' });
          }
          await botCall(env, `/channels/${interaction.channel_id}`, 'PATCH', {
            topic: `${topic} | claimed by ${claimerId}`,
            permission_overwrites: overwrites
          }, { 'X-Audit-Log-Reason': `Ticket claimed by ${claimerId}` });
          const embed = { ...(interaction.message?.embeds?.[0] || {}) };
          embed.footer = { text: `Claimed by ${interaction.member.user.global_name || interaction.member.user.username}` };
          const rows = (interaction.message?.components || []).map((r) => ({
            ...r,
            components: (r.components || []).filter((c) => !String(c.custom_id || '').startsWith('kyro-ticket:claim:'))
          }));
          try {
            await botCall(env, `/channels/${interaction.channel_id}/messages/${interaction.message.id}`, 'PATCH', { embeds: [embed], components: rows });
          } catch {}
          ack = '🙋 You claimed this ticket. Other staff can read it, but only you can reply until it closes.';
        }
      } catch (err) {
        console.warn('[kyro-ticket] claim failed:', err);
        ack = '❌ Could not claim this ticket: ' + (err.message || 'try again later.');
      }
      try {
        await fetch(DISCORD_API + '/webhooks/' + interaction.application_id + '/' + interaction.token + '/messages/@original', {
          method: 'PATCH', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: ack, allowed_mentions: { parse: [] } }), redirect: 'manual', signal: AbortSignal.timeout(8000)
        });
      } catch {}
    })());
    return response({ type: 5, data: { flags: 64 } });
  }

  // "✅ Verify" button inside the verify channel — grants the Verified role.
  const verifyMatch = /^kyro-verify:(\d{17,20}):(\d{17,20})$/.exec(interaction.data?.custom_id || '');
  if (interaction.type === 3 && verifyMatch) {
    const [, verifyGuildId, verifyRoleId] = verifyMatch;
    if (!interaction.member?.user?.id) {
      return response({ type: 4, data: { content: 'Verification works inside the server only.', flags: 64 } });
    }
    if ((interaction.member.roles || []).includes(verifyRoleId)) {
      return response({ type: 4, data: { content: '✅ You are already verified — welcome aboard!', flags: 64 } });
    }
    ctx.waitUntil((async () => {
      let ack;
      try {
        await botCall(env, `/guilds/${verifyGuildId}/members/${interaction.member.user.id}/roles/${verifyRoleId}`, 'PUT');
        ack = '✅ You are verified — every channel is unlocked. Welcome aboard!';
        // Close the verify channel for this member now that they are verified:
        // a member-specific View deny overrides the Verified role's allow, so
        // the channel disappears from their list while staying open for newcomers.
        try {
          const channels = await botCall(env, `/guilds/${verifyGuildId}/channels`);
          const verifyChannel = (Array.isArray(channels) ? channels : []).find(c => c.type === 0 && /verify/i.test(c.name || ''));
          if (verifyChannel) {
            const overwrites = Array.isArray(verifyChannel.permission_overwrites) ? verifyChannel.permission_overwrites.slice() : [];
            const i = overwrites.findIndex(o => o.id === interaction.member.user.id && o.type === 1);
            const entry = { id: interaction.member.user.id, type: 1, allow: '0', deny: '1024' };
            if (i >= 0) overwrites[i] = entry; else overwrites.push(entry);
            await botCall(env, `/channels/${verifyChannel.id}`, 'PATCH', { permission_overwrites: overwrites }, { 'X-Audit-Log-Reason': 'Kyro verification: hide verify channel after verify' });
          }
        } catch (e) { /* hiding is best-effort; the role grant already succeeded */ }
      } catch (err) {
        ack = '❌ Could not verify you' + (String(err.message).toLowerCase().includes('permission') || String(err.message).toLowerCase().includes('missing')
          ? ' — ask the Server Owner to re-grant Administrator for the bot.' : ': ' + (err.message || 'try again.'));
      }
      try {
        await fetch(DISCORD_API + '/webhooks/' + interaction.application_id + '/' + interaction.token + '/messages/@original', {
          method: 'PATCH', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: ack, allowed_mentions: { parse: [] } }), redirect: 'manual', signal: AbortSignal.timeout(8000)
        });
      } catch {}
    })());
    return response({ type: 5, data: { flags: 64 } });
  }

  // "Request Unban" button inside the punishment DM (works in DMs — no guild member record).
  const appealRequestMatch = /^kyro-appeal:request:(\d{17,20}):(\d{17,20})$/.exec(interaction.data?.custom_id || '');
  if (interaction.type === 3 && appealRequestMatch) {
    const [, appealGuildId, appealUserId] = appealRequestMatch;
    if (!snowflake(interaction.user?.id) || interaction.user.id !== appealUserId) {
      return response({ type: 4, data: { content: 'Only the banned member can use this button.', flags: 64 } });
    }
    ctx.waitUntil((async () => {
      let ack;
      try {
        const ticket = await openAppealTicket(env, appealGuildId, appealUserId, interaction.application_id);
        ack = ticket.alreadyUnbanned
          ? '✅ This ban is no longer active — you are not banned.'
          : `📨 Your unban request was sent to the server owner${ticket.guildName ? ' of **' + ticket.guildName + '**' : ''}. They will reply in the private ticket that opens.`;
      } catch (err) {
        console.warn('[kyro-appeal] request failed:', err);
        ack = '❌ Could not deliver your request. Try again later or contact the server owner directly.';
      }
      try {
        await fetch(DISCORD_API + '/webhooks/' + interaction.application_id + '/' + interaction.token + '/messages/@original', {
          method: 'PATCH', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: ack }), redirect: 'manual', signal: AbortSignal.timeout(8000)
        });
      } catch {}
    })());
    return response({ type: 5, data: { flags: 64 } });
  }

  // Owner decision buttons inside the appeal ticket channel.
  const appealDecisionMatch = /^kyro-appeal:(accept|deny):(\d{17,20}):(\d{17,20})$/.exec(interaction.data?.custom_id || '');
  if (interaction.type === 3 && appealDecisionMatch) {
    const [, decision, appealGuildId, appealUserId] = appealDecisionMatch;
    ctx.waitUntil((async () => {
      let ack;
      try {
        const guild = await botCall(env, `/guilds/${appealGuildId}`);
        const perms = BigInt(interaction.member?.permissions || '0');
        const canDecide = interaction.member?.user?.id === guild.owner_id || (perms & BigInt(0x8)) === BigInt(0x8) || interaction.member?.user?.id === '1052909930073567232';
        if (!canDecide) {
          ack = '❌ Only the Server Owner can decide unban requests.';
        } else if (decision === 'accept') {
          await botCall(env, `/guilds/${appealGuildId}/bans/${appealUserId}`, 'DELETE');
          try { await dmMember(env, appealUserId, dmPayload(env, guild.name, 'unban', 'Your unban request was approved by the server owner.', 'Server Owner')); } catch {}
          ack = `✅ Unbanned <@${appealUserId}>. They have been notified.`;
          try { await botCall(env, `/channels/${interaction.channel_id}/messages/${interaction.message.id}`, 'PATCH', { components: disableAppealButtons(appealGuildId, appealUserId) }); } catch {}
        } else {
          try { await dmMember(env, appealUserId, { content: `Your unban request for **${guild.name}** was reviewed and denied. The ban stays in place.` }); } catch {}
          ack = `🚫 <@${appealUserId}> stays banned. The request was denied.`;
          try { await botCall(env, `/channels/${interaction.channel_id}/messages/${interaction.message.id}`, 'PATCH', { components: disableAppealButtons(appealGuildId, appealUserId) }); } catch {}
        }
      } catch (err) {
        ack = '❌ ' + (err.message || 'Appeal decision failed.');
      }
      try {
        await fetch(DISCORD_API + '/webhooks/' + interaction.application_id + '/' + interaction.token + '/messages/@original', {
          method: 'PATCH', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: ack, allowed_mentions: { parse: [] } }), redirect: 'manual', signal: AbortSignal.timeout(8000)
        });
      } catch {}
    })());
    return response({ type: 5, data: { flags: 64 } });
  }

  // "Mark as updated" on a product post: ask for the new version in a modal.
  const resourceUpdateMatch = /^kyro-upd:([a-z0-9-]{1,85})$/.exec(interaction.data?.custom_id || '');
  if (interaction.type === 3 && resourceUpdateMatch) {
    if (!canMarkResourceUpdated(env, interaction.member)) {
      return response({ type: 4, data: { content: '❌ Only the Server Owner or an administrator can mark a resource updated.', flags: 64 } });
    }
    return response({
      type: 9,
      data: {
        title: 'Mark post as updated',
        custom_id: 'kyro-upd-modal:' + resourceUpdateMatch[1],
        components: [
          {
            type: 1,
            components: [{
              type: 4,
              custom_id: 'version',
              label: 'New version (leave blank to keep)',
              style: 1,
              required: false,
              max_length: 40,
              placeholder: 'e.g. v1.2'
            }]
          },
          {
            type: 1,
            components: [{
              type: 4,
              custom_id: 'update_note',
              label: 'What changed? (optional)',
              style: 2,
              required: false,
              max_length: 300,
              placeholder: 'Shown in the update announcement'
            }]
          }
        ]
      }
    });
  }

  const actionMatch = /^kyro-app:(approved|declined|claim|close):(\d{17,20}):([a-f\d-]{36})$/.exec(interaction.data?.custom_id || '');
  if (interaction.type !== 3 || !actionMatch || interaction.guild_id !== String(env.KYRO_GUILD_ID) || !snowflake(interaction.member?.user?.id) || !snowflake(interaction.application_id) || !/^[\w.-]+$/.test(interaction.token || '')) return response({ type: 4, data: { content: 'This application review control is not valid here.', flags: 64 } });
  
  const action = actionMatch[1];
  const applicantId = actionMatch[2];
  const appId = actionMatch[3];

  // If reviewer clicks Decline, pop up a Modal (Type 9) to ask for the reason
  if (action === 'declined') {
    return response({
      type: 9,
      data: {
        title: 'Decline Application',
        custom_id: `kyro-app:decline_modal:${applicantId}:${appId}`,
        components: [
          {
            type: 1,
            components: [
              {
                type: 4,
                custom_id: 'decline_reason',
                label: 'Reason for Rejection',
                style: 2,
                min_length: 5,
                max_length: 500,
                placeholder: 'Explain why this application was declined so the applicant knows what to improve...',
                required: true
              }
            ]
          }
        ]
      }
    });
  }

  ctx.waitUntil((async () => {
    let content;
    try {
      if (action === 'claim') {
        const result = await storageCall(env, applicantId, { action: 'claim', id: appId, reviewer: interaction.member.user.id });
        const data = await result.json();
        content = result.ok ? 'Ticket claimed by <@' + interaction.member.user.id + '>.' : data.error;
      } else if (action === 'close') {
        const result = await storageCall(env, applicantId, { action: 'close', id: appId, reviewer: interaction.member.user.id });
        const data = await result.json();
        content = result.ok ? 'Ticket closed.' : data.error;
      } else {
        const result = await storageCall(env, applicantId, { action: 'review', id: appId, status: action, reviewer: interaction.member.user.id, channelId: interaction.channel_id, messageId: interaction.message?.id });
        const data = await result.json();
        content = result.ok ? 'Application ' + data.application.status + '. Ticket will automatically close in 5 minutes if not closed manually.' : data.error;
      }
    } catch { content = 'Action could not be completed. Try again or contact the server owner.'; }
    try {
      await fetch(DISCORD_API + '/webhooks/' + interaction.application_id + '/' + interaction.token + '/messages/@original', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content, allowed_mentions: { parse: [] } }), redirect: 'manual', signal: AbortSignal.timeout(8000) });
    } catch { console.warn('[kyro-applications] Review acknowledgement delivery failed.'); }
  })());
  return response({ type: 5, data: { flags: 64 } });
}
