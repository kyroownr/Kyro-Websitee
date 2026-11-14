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
const applicationKey = id => 'application:' + id;

export function applicationConfiguration(env) {
  const minAge = Number(env.KYRO_APPLICATION_MIN_AGE || 16);
  const accountDays = Number(env.KYRO_APPLICATION_ACCOUNT_DAYS || 30);
  const validPolicy = Number.isInteger(minAge) && minAge >= 13 && minAge <= 120 && Number.isInteger(accountDays) && accountDays >= 0 && accountDays <= 3650;
  const guildId = String(env.DISCORD_GUILD_ID || env.KYRO_GUILD_ID || '');
  const configured = Boolean(env.DISCORD_BOT_TOKEN && snowflake(guildId) && guildId === String(env.KYRO_GUILD_ID) && snowflake(env.DISCORD_APPLICATIONS_CATEGORY_ID) && snowflake(env.DISCORD_MOD_ROLE_ID) && String(env.DISCORD_MOD_ROLE_ID) !== guildId && /^[a-f\d]{64}$/i.test(env.DISCORD_PUBLIC_KEY || '') && validPolicy && env.KYRO_APPLICATIONS);
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

async function botCall(env, route, method = 'GET', body) {
  let result;
  try {
    result = await fetch(DISCORD_API + route, {
      method, headers: { authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'manual', signal: AbortSignal.timeout(8000)
    });
  } catch { throw Object.assign(error(502, 'discord_uncertain', 'Discord delivery needs staff attention.'), { uncertain: true }); }
  const data = await result.json().catch(() => ({}));
  if (result.status === 429) {
    const seconds = [data.retry_after, result.headers.get('retry-after'), result.headers.get('x-ratelimit-reset-after')].filter(value => value !== null && value !== undefined).map(Number).filter(value => Number.isFinite(value) && value >= 0);
    throw Object.assign(error(502, 'discord_rate_limit', 'Discord is busy. The application remains queued.'), { retryAfter: seconds.length ? Math.max(1, Math.ceil(Math.max(...seconds) * 1000)) : 30000 });
  }
  if (!result.ok) throw Object.assign(error(502, 'discord_' + result.status, 'Discord delivery needs staff attention.'), { ...(result.status >= 500 ? { retryAfter: 5000, uncertain: method === 'POST' } : {}) });
  return data;
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
  fields.push({ name: 'Reviewed By', value: row.reviewed_by || 'Not reviewed', inline: true });
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
    components: index === embeds.length - 1 ? [{ type: 1, components: [
      { type: 2, style: 3, label: 'Approve', custom_id: 'kyro-app:approved:' + row.by + ':' + row.id, disabled: row.status !== 'pending' },
      { type: 2, style: 4, label: 'Decline', custom_id: 'kyro-app:declined:' + row.by + ':' + row.id, disabled: row.status !== 'pending' }
    ] }] : []
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
        const guild = await botCall(this.env, '/guilds/' + this.env.KYRO_GUILD_ID);
        if (guild.owner_id !== input.reviewer) {
          const member = await botCall(this.env, '/guilds/' + this.env.KYRO_GUILD_ID + '/members/' + input.reviewer);
          if (!member.roles?.includes(String(this.env.DISCORD_MOD_ROLE_ID))) throw error(403, 'not_a_reviewer', 'Only the server owner or configured moderator role can review applications.');
        }
        return await storage.transaction(async tx => {
          const row = await tx.get(applicationKey(input.id));
          if (!row || row.channel_id !== input.channelId || row.message_id !== input.messageId) throw error(404, 'application_not_found', 'Application not found in this channel.');
          if (row.status !== 'pending') throw error(409, 'already_reviewed', 'This application is already reviewed or is not ready for review.');
          row.status = input.status; row.reviewed_by = input.reviewer; row.reviewed_at = new Date().toISOString();
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
    const jobs = await storage.list({ prefix: 'job:', limit: 1 });
    const entry = jobs.entries().next().value;
    if (!entry) return;
    const [key, job] = entry;
    const row = await storage.get(applicationKey(job.id));
    let channelAttempted = false;
    try {
      if (!applicationConfiguration(this.env).open && job.stage !== 'review') throw error(503, 'applications_closed', 'Applications are closed.');
      if (job.stage === 'create') {
        const guildId = String(this.env.KYRO_GUILD_ID);
        const [bot, category, roles] = await Promise.all([
          botCall(this.env, '/users/@me'), botCall(this.env, '/channels/' + this.env.DISCORD_APPLICATIONS_CATEGORY_ID), botCall(this.env, '/guilds/' + guildId + '/roles')
        ]);
        if (!bot.bot || !snowflake(bot.id) || category.type !== 4 || category.guild_id !== guildId || !roles.some(role => role.id === String(this.env.DISCORD_MOD_ROLE_ID))) throw error(502, 'discord_configuration', 'Check the bot, category, and moderator role configuration.');
        const role = ROLES.find(item => item.id === row.role);
        const username = row.username.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}-]/gu, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || row.by;
        await storage.transaction(async tx => {
          await tx.put(key, { ...job, stage: 'reconcile' });
          await tx.setAlarm(Date.now() + 10000);
        });
        channelAttempted = true;
        const channel = await botCall(this.env, '/guilds/' + guildId + '/channels', 'POST', {
          name: (role.prefix + '-' + username).slice(0, 100), type: 0, parent_id: String(this.env.DISCORD_APPLICATIONS_CATEGORY_ID), topic: 'Kyro application ' + row.id,
          permission_overwrites: [
            { id: guildId, type: 0, deny: '1024', allow: '0' },
            { id: String(this.env.DISCORD_MOD_ROLE_ID), type: 0, allow: '3072', deny: '0' },
            { id: bot.id, type: 1, allow: '3072', deny: '0' },
            ...(this.env.KYRO_APPLICATION_INTERVIEW_ENABLED === 'true' ? [{ id: row.by, type: 1, allow: '3072', deny: '0' }] : [])
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
        const channels = await botCall(this.env, '/guilds/' + this.env.KYRO_GUILD_ID + '/channels');
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
          if (index === parts.length - 1) { row.message_id = message.id; row.status = 'pending'; }
        } else {
          await botCall(this.env, '/channels/' + row.channel_id + '/messages/' + row.message_ids[index], 'PATCH', parts[index]);
        }
        await storage.transaction(async tx => {
          await tx.put(applicationKey(row.id), row);
          if (index < parts.length - 1) await tx.put(key, { id: row.id, stage: job.stage, index: index + 1, attempts: 0 });
          else await tx.delete(key);
          if ((await tx.list({ prefix: 'job:', limit: 1 })).size) await tx.setAlarm(Date.now());
        });
      }
    } catch (err) {
      if (channelAttempted && (err.uncertain || !err.code)) {
        await storage.put(key, { id: job.id, stage: 'reconcile', attempts: 0 });
        await storage.setAlarm(Date.now() + 5000);
      } else if ((err.retryAfter !== undefined || err.uncertain) && job.attempts < 4 && (job.stage !== 'message' || Date.now() + (err.retryAfter || 5000) - job.started < 240000)) {
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
  if (!/^[a-f\d]{128}$/i.test(signature) || !/^\d{10}$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 || !/^[a-f\d]{64}$/i.test(env.DISCORD_PUBLIC_KEY || '')) return response({ error: 'Invalid interaction signature.' }, 401);
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > 32000) return response({ error: 'Interaction too large.' }, 413);
  const key = await crypto.subtle.importKey('raw', hexBytes(env.DISCORD_PUBLIC_KEY), 'Ed25519', false, ['verify']);
  if (!await crypto.subtle.verify('Ed25519', key, hexBytes(signature), new TextEncoder().encode(timestamp + raw))) return response({ error: 'Invalid interaction signature.' }, 401);
  let interaction;
  try { interaction = JSON.parse(raw); } catch { return response({ error: 'Invalid interaction.' }, 400); }
  if (!interaction || typeof interaction !== 'object' || Array.isArray(interaction)) return response({ error: 'Invalid interaction.' }, 400);
  if (interaction.type === 1) return response({ type: 1 });
  const match = /^kyro-app:(approved|declined):(\d{17,20}):([a-f\d-]{36})$/.exec(interaction.data?.custom_id || '');
  if (interaction.type !== 3 || !match || interaction.guild_id !== String(env.KYRO_GUILD_ID) || !snowflake(interaction.member?.user?.id) || !snowflake(interaction.application_id) || !/^[\w.-]+$/.test(interaction.token || '')) return response({ type: 4, data: { content: 'This application review control is not valid here.', flags: 64 } });
  ctx.waitUntil((async () => {
    let content;
    try {
      const result = await storageCall(env, match[2], { action: 'review', id: match[3], status: match[1], reviewer: interaction.member.user.id, channelId: interaction.channel_id, messageId: interaction.message?.id });
      const data = await result.json();
      content = result.ok ? 'Application ' + data.application.status + '. This does not automatically assign a staff role.' : data.error;
    } catch { content = 'Review could not be completed. Try again or contact the server owner.'; }
    try {
      await fetch(DISCORD_API + '/webhooks/' + interaction.application_id + '/' + interaction.token + '/messages/@original', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content, allowed_mentions: { parse: [] } }), redirect: 'manual', signal: AbortSignal.timeout(8000) });
    } catch { console.warn('[kyro-applications] Review acknowledgement delivery failed.'); }
  })());
  return response({ type: 5, data: { flags: 64 } });
}
