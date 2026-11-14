const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const root = path.join(__dirname, '..');
const source = require('esbuild').buildSync({ entryPoints: [path.join(root, 'worker.js')], bundle: true, write: false, format: 'esm', platform: 'browser' }).outputFiles[0].text;
const guild = '1539961184323772498';
const category = '1539961184323772499';
const mod = '1539961184323772500';
const bot = '1539961184323772501';
const userId = token => String((BigInt(Date.now() - (token === 'new' ? 86400000 : 90 * 86400000) - 1420070400000) / 86400000n * 86400000n << 22n) + BigInt(Array.from(token).reduce((sum, c) => sum * 31 + c.charCodeAt(0), 0)));
const answers = { handle: 'Editor handle', pronouns: 'They/them', age: 20, experience: 'I help editors with installation and troubleshooting.', availability: 'Every evening for two hours.', scenario: 'I would ask for the error message and help explain the correct steps.', activity: true, safety: true, questions: '' };
const waitFor = async predicate => {
  const deadline = Date.now() + 15000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('Application delivery timed out');
    await new Promise(resolve => setTimeout(resolve, 15));
  }
};

async function main() {
  const module = await import(pathToFileURL(path.join(root, 'applications-worker.js')));
  const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', keys.publicKey)).toString('hex');
  const env = { KYRO_GUILD_ID: guild, DISCORD_GUILD_ID: guild, DISCORD_PUBLIC_APPS_CHANNEL_ID: '1542135796369457182', DISCORD_BOT_TOKEN: 'dummy-bot-secret', DISCORD_APPLICATIONS_CATEGORY_ID: category, DISCORD_MOD_ROLE_ID: mod, DISCORD_APPLICATION_PUBLIC_KEY: publicKey };
  const channels = [], messages = [], patches = [], nonces = new Map();
  let rateLimit = false, uncertainChannel = false, invalidCategory = false, uncertainNotice = false, invalidPublicChannel = false;
  let channelPosts = 0;
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: source, compatibilityDate: '2025-09-01', kvNamespaces: ['KYRO_DATA'],
    durableObjects: { KYRO_REQUESTS: { className: 'KyroRequests', useSQLite: true }, KYRO_APPLICATIONS: { className: 'KyroApplications', useSQLite: true } },
    bindings: env,
    outboundService: async request => {
      const url = new URL(request.url);
      assert.equal(url.hostname, 'discord.com');
      const auth = request.headers.get('authorization');
      if (url.pathname === '/api/users/@me') {
        const token = auth.replace('Bearer ', '');
        return token === 'expired' ? Response.json({}, { status: 401 }) : Response.json({ id: userId(token), username: token + '-editor', discriminator: '0' });
      }
      if (url.pathname === '/api/users/@me/guilds') return Response.json(auth === 'Bearer outsider' ? [] : [{ id: guild, owner: false }]);
      assert.equal(auth, 'Bot dummy-bot-secret');
      if (url.pathname === '/api/v10/channels/' + env.DISCORD_PUBLIC_APPS_CHANNEL_ID) return Response.json({ id: env.DISCORD_PUBLIC_APPS_CHANNEL_ID, type: 0, guild_id: invalidPublicChannel ? category : guild });
      if (url.pathname === '/api/v10/guilds/' + guild) return Response.json({ owner_id: userId('owner') });
      if (url.pathname === '/api/v10/users/@me') return Response.json({ id: bot, bot: true });
      if (url.pathname === '/api/v10/channels/' + category) return Response.json({ id: category, type: invalidCategory ? 0 : 4, guild_id: guild });
      if (url.pathname === '/api/v10/guilds/' + guild + '/roles') return Response.json([{ id: mod }]);
      if (url.pathname === '/api/v10/guilds/' + guild + '/channels') {
        if (request.method === 'GET') return Response.json(channels);
        channelPosts++;
        const data = await request.json();
        const channel = { ...data, id: String(BigInt(category) + 100n + BigInt(channels.length)) };
        channels.push(channel);
        if (uncertainChannel) { uncertainChannel = false; return Response.json({}, { status: 503 }); }
        return Response.json(channel);
      }
      if (/^\/api\/v10\/channels\/\d+\/messages$/.test(url.pathname)) {
        const data = await request.json();
        if (rateLimit) { rateLimit = false; return Response.json({ retry_after: 0.025 }, { status: 429, headers: { 'retry-after': '0.025' } }); }
        assert.equal(data.enforce_nonce, true);
        assert.ok(data.nonce.length <= 25);
        if (nonces.has(data.nonce)) return Response.json(nonces.get(data.nonce));
        const message = { ...data, id: String(BigInt(bot) + 1000n + BigInt(messages.length)) };
        nonces.set(data.nonce, message); messages.push(message);
        if (uncertainNotice && data.nonce.endsWith('-pub')) { uncertainNotice = false; return Response.json({}, { status: 503 }); }
        return Response.json(message);
      }
      if (/^\/api\/v10\/channels\/\d+\/messages\/\d+$/.test(url.pathname) && request.method === 'PATCH') { patches.push(await request.json()); return Response.json({}); }
      throw new Error('Unexpected Discord endpoint: ' + url.pathname);
    }
  }));
  const call = async (route, token, body) => {
    const result = await mf.dispatchFetch('http://localhost' + route, { method: body === undefined ? 'GET' : 'POST', headers: { origin: 'http://localhost:4173', ...(token ? { authorization: 'Bearer ' + token } : {}), 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: result.status, data: await result.json(), headers: result.headers };
  };
  const status = async (id, token = 'member') => (await call('/applications/status?id=' + id, token)).data.application;
  let checks = 0;
  const check = (value, label) => { assert.ok(value, label); checks++; };
  try {
    const config = await call('/applications/config');
    check(config.status === 200 && config.data.open && config.data.roles.length === 3 && config.data.minAge === 16 && config.data.accountDays === 30, 'public configuration');
    check(!JSON.stringify(config.data).includes('dummy-bot-secret') && !JSON.stringify(config.data).includes(category), 'configuration privacy');
    check(config.headers.get('cache-control') === 'no-store', 'private data never cached');
    check((await call('/applications')).status === 401, 'anonymous denied');
    check((await call('/applications?token=member')).status === 401, 'query token denied');
    check((await call('/applications', 'outsider')).status === 403, 'nonmember denied');
    check((await call('/applications', 'expired')).status === 401, 'expired token denied');
    check((await call('/applications', 'new', { role: 'support', answers })).status === 403, 'young account denied');
    for (const body of [null, [], { role: 'invalid', answers }, { role: 'support', answers: null }, { role: 'support', answers: { ...answers, age: 15 } }, { role: 'support', answers: { ...answers, age: 20.5 } }, { role: 'support', answers: { ...answers, safety: false } }, { role: 'support', answers: { ...answers, activity: false } }, { role: 'support', answers: { ...answers, pronouns: 'invented' } }, { role: 'support', answers: { ...answers, scenario: '<short>' } }, { role: 'support', answers: { ...answers, experience: 'x'.repeat(1001) } }, { role: 'contributor', answers: { ...answers, originality: true, portfolio: 'javascript:alert(1)' } }, { role: 'contributor', answers: { ...answers, originality: true, portfolio: 'https://name:pass@example.com' } }]) check((await call('/applications', 'member', body)).status === 400, 'input boundary');
    check((await call('/applications', 'member', { role: 'support', answers: { ...answers, questions: 'x'.repeat(17000) } })).status === 413, 'body limit');
    const profile = (await call('/applications', 'member')).data.profile;
    check(profile.id === userId('member') && profile.tag === 'member-editor' && /^\d{4}-\d{2}-\d{2}T/.test(profile.account_created), 'server-derived identity');
    rateLimit = true;
    const race = await Promise.all(Array.from({ length: 8 }, () => call('/applications', 'member', { role: 'support', answers, by: 'attacker', username: 'forged' })));
    check(race.filter(r => r.status === 201).length === 1 && race.filter(r => r.status === 409).length === 7, 'atomic same-role duplicate prevention');
    const id = race.find(r => r.status === 201).data.application.id;
    check(!JSON.stringify(race).includes('Editor handle'), 'submission response excludes answers');
    await waitFor(async () => (await status(id))?.status === 'pending');
    check(channels.length === 1 && channels[0].name === 'support-member-editor' && channels[0].parent_id === category, 'private category channel');
    const overwrites = channels[0].permission_overwrites;
    check(overwrites.length === 3 && overwrites[0].id === guild && overwrites[0].deny === '1024', 'everyone denied view');
    check(overwrites[1].id === mod && overwrites[1].type === 0 && overwrites[1].allow === '68608' && overwrites[2].id === bot && overwrites[2].type === 1 && overwrites[2].allow === '68608', 'configured mod and bot grants');
    check(!overwrites.some(o => o.id === profile.id), 'applicant excluded by default');
    check(messages[0].embeds[0].fields.some(f => f.name === 'Discord User ID' && f.value === profile.id), 'forged identity ignored');
    check(messages[0].components[0].components.every(b => !b.disabled), 'ready review controls');
    const notice = messages.find(message => message.nonce.endsWith('-pub'));
    check(notice && notice.content.includes('<#' + channels[0].id + '>') && notice.content.includes('<@&' + mod + '>') && notice.content.includes('<@' + userId('owner') + '>'), 'public notice links private ticket and reviewers');
    check(!notice.embeds && !notice.components && !notice.content.includes(profile.id) && !notice.content.includes(answers.handle) && notice.allowed_mentions.parse.length === 0, 'public notice excludes identity answers and review controls');
    const ping = await signed({ type: 1 });
    const pingResult = await mf.dispatchFetch('http://localhost/api/discord/interactions', { method: 'POST', headers: ping.headers, body: await ping.text() });
    check(pingResult.status === 200 && (await pingResult.json()).type === 1, 'new interaction endpoint verifies signed PING');
    check((await call('/applications/status?id=' + id, 'other')).status === 404, 'cross-account status denied');
    const publicRow = await status(id);
    check(!('answers' in publicRow) && !('channel_id' in publicRow) && !('interview_url' in publicRow), 'status privacy');
    const large = { ...answers, experience: '*'.repeat(1000), scenario: '_'.repeat(1000), availability: '`'.repeat(500), questions: '*'.repeat(600), originality: true, portfolio: 'https://example.com/portfolio' };
    const out = await call('/applications', 'long', { role: 'contributor', answers: large });
    await waitFor(async () => (await status(out.data.application.id, 'long'))?.status === 'pending');
    const parts = messages.filter(m => m.embeds?.[0].footer.text.includes(out.data.application.id));
    check(parts.length > 1, 'long full answers split across messages');
    for (const part of parts) {
      const embed = part.embeds[0];
      const size = embed.title.length + embed.author.name.length + embed.footer.text.length + embed.fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0);
      check(part.embeds.length === 1 && size <= 6000 && embed.fields.length <= 25 && embed.fields.every(f => f.name.length <= 256 && f.value.length <= 1024), 'Discord field and aggregate limits');
      check(part.allowed_mentions.parse.length === 0, 'mentions disabled');
    }
    check(parts.slice(0, -1).every(part => part.components.length === 0) && parts.at(-1).components.length === 1, 'controls appear only after complete answers');
    check(parts.flatMap(p => p.embeds[0].fields).filter(f => f.name.startsWith('Previous experience')).map(f => f.value).join('') === '\\*'.repeat(1000), 'full escaped answer retained');
    uncertainChannel = true;
    const uncertain = await call('/applications', 'uncertain', { role: 'moderator', answers });
    await waitFor(async () => (await status(uncertain.data.application.id, 'uncertain'))?.status === 'pending');
    check(channelPosts === 3 && channels.filter(c => c.topic.endsWith(uncertain.data.application.id)).length === 1, 'uncertain channel creation reconciles without duplicate');
    invalidCategory = true;
    const invalid = await call('/applications', 'badconfig', { role: 'support', answers });
    await waitFor(async () => (await status(invalid.data.application.id, 'badconfig'))?.status === 'needs_attention');
    check((await call('/applications', 'badconfig', { role: 'support', answers })).status === 409, 'failed delivery retains active guard');
    check(channels.length === 3, 'misconfigured category creates no channel');
    invalidCategory = false;
    invalidPublicChannel = true;
    const foreignChannel = await call('/applications', 'fc', { role: 'support', answers });
    await waitFor(async () => (await status(foreignChannel.data.application.id, 'fc'))?.status === 'needs_attention');
    check(channels.length === 3, 'foreign public channel rejected before ticket creation');
    invalidPublicChannel = false;
    uncertainNotice = true;
    const retried = await call('/applications', 'nr', { role: 'support', answers });
    await waitFor(async () => (await status(retried.data.application.id, 'nr'))?.status === 'pending');
    const nonce = retried.data.application.id.replace(/-/g, '').slice(0, 20) + '-pub';
    check(messages.filter(message => message.nonce === nonce).length === 1, 'uncertain public notice retries without duplicate');
  } finally { await mf.dispose(); }

  check(!module.applicationConfiguration({ ...env, KYRO_APPLICATIONS: {} , DISCORD_BOT_TOKEN: undefined }).open, 'missing bot closes applications');
  check(!module.applicationConfiguration({ ...env, KYRO_APPLICATIONS: {}, DISCORD_MOD_ROLE_ID: guild }).open, 'everyone cannot be review role');
  check(!module.applicationConfiguration({ ...env, KYRO_APPLICATIONS: {}, DISCORD_GUILD_ID: category }).open, 'guild mismatch closes applications');
  check(!module.applicationConfiguration({ ...env, KYRO_APPLICATIONS: {}, KYRO_APPLICATIONS_OPEN: 'false' }).open, 'manual closed flag');
  await assert.rejects(() => module.handleApplications(new Request('https://local/applications'), {}, {}, { id: userId('member') }), e => e.status === 503);
  checks++;

  async function signed(body, timestamp = String(Math.floor(Date.now() / 1000))) {
    const raw = JSON.stringify(body);
    const signature = Buffer.from(await crypto.subtle.sign('Ed25519', keys.privateKey, new TextEncoder().encode(timestamp + raw))).toString('hex');
    return new Request('https://local/applications/interactions', { method: 'POST', headers: { 'x-signature-ed25519': signature, 'x-signature-timestamp': timestamp }, body: raw });
  };
  check((await module.handleApplicationInteractions(await signed({ type: 1 }), env, {})).status === 200, 'signed Discord PING');
  check((await module.handleApplicationInteractions(await signed(null), env, {})).status === 400, 'signed null rejected');
  check((await module.handleApplicationInteractions(await signed({ type: 1 }, String(Math.floor(Date.now() / 1000) - 600)), env, {})).status === 401, 'expired signature rejected');
  const tampered = await signed({ type: 1 });
  check((await module.handleApplicationInteractions(new Request(tampered.url, { method: 'POST', headers: tampered.headers, body: '{"type":3}' }), env, {})).status === 401, 'tampered body rejected');
  check((await module.handleApplicationInteractions(new Request('https://local/applications/interactions', { method: 'POST', body: '{}' }), env, {})).status === 401, 'unsigned request rejected');

  const originalFetch = global.fetch;
  const interactionCalls = [], deferred = [];
  const interactionEnv = { ...env, KYRO_APPLICATIONS: { idFromName: id => id, get: id => ({ fetch: async (url, init) => { interactionCalls.push({ id, input: JSON.parse(init.body) }); return Response.json({ application: { status: 'approved' } }); } }) } };
  try {
    global.fetch = async (url, options) => { check(url.includes('/webhooks/') && options.method === 'PATCH', 'deferred interaction acknowledgement'); return Response.json({}); };
    const button = { type: 3, application_id: bot, token: 'dummy-interaction-token', guild_id: guild, channel_id: category, member: { user: { id: userId('owner') } }, message: { id: bot }, data: { custom_id: 'kyro-app:approved:' + userId('member') + ':' + crypto.randomUUID() } };
    const result = await module.handleApplicationInteractions(await signed(button), interactionEnv, { waitUntil: work => deferred.push(work) });
    check((await result.json()).type === 5, 'signed button acknowledged immediately');
    await Promise.all(deferred);
    check(interactionCalls[0].id === userId('member') && interactionCalls[0].input.reviewer === userId('owner'), 'signed identity routes review to actual applicant');
    const foreign = await module.handleApplicationInteractions(await signed({ ...button, guild_id: category }), interactionEnv, { waitUntil: work => deferred.push(work) });
    check((await foreign.json()).type === 4 && interactionCalls.length === 1, 'foreign guild button denied');
  } finally { global.fetch = originalFetch; }
  const rows = new Map();
  let alarm = null, owner = userId('owner'), allowMod = true, patchRateLimit = true;
  const storage = {
    get: async key => structuredClone(rows.get(key)), put: async (key, value) => rows.set(key, structuredClone(value)), delete: async key => rows.delete(key),
    list: async ({ prefix, limit = Infinity }) => new Map([...rows].filter(([key]) => key.startsWith(prefix)).slice(0, limit)),
    getAlarm: async () => alarm, setAlarm: async value => { alarm = value; }, transaction: async callback => callback(storage)
  };
  const role = module.applicationConfiguration({ ...env, KYRO_APPLICATIONS: {} }).roles[0];
  const id = crypto.randomUUID();
  const row = { id, by: userId('member'), username: 'member-editor', tag: 'member-editor', account_created: new Date(Date.now() - 90 * 86400000).toISOString(), role: 'support', fields: role.fields, answers, status: 'pending', created: '2026-01-01T00:00:00.000Z', channel_id: category, message_id: bot, message_ids: [bot] };
  rows.set('application:' + id, row); rows.set('active:support', id);
  const object = new module.KyroApplications({ storage, blockConcurrencyWhile: async callback => callback() }, { ...env, KYRO_APPLICATIONS: {} });
  const review = async (reviewer, extra = {}) => {
    const res = await object.fetch(new Request('https://internal', { method: 'POST', body: JSON.stringify({ action: 'review', id, status: 'approved', reviewer, channelId: category, messageId: bot, ...extra }) }));
    return { status: res.status, data: await res.json() };
  };
  try {
    global.fetch = async (url, options) => {
      if (url.endsWith('/guilds/' + guild)) return Response.json({ owner_id: owner });
      if (url.includes('/members/')) return Response.json({ roles: allowMod && url.endsWith(userId('mod')) ? [mod] : [] });
      if (options.method === 'PATCH') {
        if (patchRateLimit) { patchRateLimit = false; return Response.json({ retry_after: 0.025 }, { status: 429 }); }
        patches.push(JSON.parse(options.body)); return Response.json({});
      }
      throw new Error('Unexpected direct bot request');
    };
    check((await review(userId('member'))).status === 403, 'member cannot review');
    check((await review(owner, { channelId: guild })).status === 404, 'wrong review channel denied');
    owner = userId('newowner');
    check((await review(userId('owner'))).status === 403, 'former owner denied');
    check((await review(owner)).status === 200, 'actual current owner may review');
    check(!rows.has('active:support') && rows.get('application:' + id).status === 'approved', 'review atomically releases duplicate guard');
    check((await review(owner)).status === 409, 'replayed review cannot change decision');
    await object.alarm();
    check(rows.has('job:' + id) && alarm > Date.now() - 50, 'old application review PATCH retries safely');
    await object.alarm();
    check(!rows.has('job:' + id) && patches.at(-1).components[0].components.every(button => button.disabled), 'review updates embed and disables controls');
    rows.set('application:' + id, row); rows.set('active:support', id);
    check((await review(userId('mod'), { status: 'declined' })).status === 200, 'configured mod may decline');
    rows.set('application:' + id, row); rows.set('active:support', id); allowMod = false;
    check((await review(userId('mod'))).status === 403, 'removed mod role denied');
    const interviewObject = new module.KyroApplications({ storage }, { ...env, KYRO_APPLICATION_INTERVIEW_ENABLED: 'true' });
    const interview = await interviewObject.fetch(new Request('https://internal', { method: 'POST', body: JSON.stringify({ action: 'status', id }) }));
    check((await interview.json()).application.interview_url === 'https://discord.com/channels/' + guild + '/' + category, 'interview access link opt-in');
  } finally { global.fetch = originalFetch; }
  console.log(JSON.stringify({ checks, runtime: 'SQLite Durable Objects + signed Ed25519 interactions', discord: 'mocked only', duplicateRace: '1 saved / 7 rejected', result: 'passed' }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
