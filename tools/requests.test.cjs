const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const source = fs.readFileSync(path.join(__dirname, '..', 'worker.js'), 'utf8');
let webhookFailure = false;
let ownerUser = 'owner';
const deliveries = [];
const make = (webhook = true, admins = 'admin') => new Miniflare(convertV4MiniflareOptions({
  modules: true,
  script: source,
  compatibilityDate: '2025-09-01',
  kvNamespaces: ['KYRO_DATA'],
  durableObjects: { KYRO_REQUESTS: { className: 'KyroRequests', useSQLite: true } },
  bindings: {
    KYRO_GUILD_ID: 'guild', KYRO_ADMIN_IDS: admins,
    DISCORD_CLIENT_ID: 'test-client', DISCORD_CLIENT_SECRET: 'test-secret',
    ...(webhook ? { DISCORD_REQUESTS_WEBHOOK_URL: 'https://discord.com/api/webhooks/123/testtoken' } : {})
  },
  outboundService: async request => {
    const url = new URL(request.url);
    if (url.hostname !== 'discord.com') throw new Error('Unexpected outbound request');
    if (url.pathname.startsWith('/api/webhooks/')) {
      deliveries.push(await request.json());
      return new Response(null, { status: webhookFailure ? 503 : 204 });
    }
    if (url.pathname === '/api/oauth2/token') return Response.json({ access_token: 'member' });
    const id = (request.headers.get('authorization') || '').replace('Bearer ', '');
    if (id === 'expired') return new Response('{}', { status: 401 });
    if (url.pathname === '/api/users/@me') return Response.json({ id, username: id + '-editor', avatar: null });
    if (url.pathname === '/api/users/@me/guilds') return Response.json(id === 'outsider' ? [] : [
      { id: 'guild', owner: id === ownerUser, permissions: id === 'admin' ? '8' : '0' },
      { id: 'other-guild', owner: id === 'foreign-owner' }
    ]);
    throw new Error('Unexpected Discord endpoint');
  }
}));

async function main() {
  const mf = make();
  let checks = 0;
  const call = async (route, body, token) => {
    const headers = { origin: 'http://localhost:4173' };
    if (token) headers.authorization = 'Bearer ' + token;
    const res = await mf.dispatchFetch('http://localhost' + route, {
      method: body === undefined ? 'GET' : 'POST', headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: res.status, data: await res.json(), headers: res.headers };
  };
  const expect = (value, label) => { assert.ok(value, label); checks++; };
  const base = {
    title: 'Motion easing helper', category: 'script', os: 'macos', ae_versions: ['2024', '2026'],
    reference: 'https://example.com/demo', desc: 'User-supplied description <script>alert(1)</script> @everyone'
  };
  try {
    let out = await call('/requests');
    expect(out.status === 200 && out.data.requests.length === 4, 'starter count');
    expect(out.data.requests.every(r => r.starter && r.votes === 0 && r.status === 'open'), 'honest starters');
    expect(out.data.is_admin === false && !JSON.stringify(out.data).includes('testtoken'), 'public response privacy');
    expect(out.headers.get('access-control-allow-origin') === 'http://localhost:4173', 'CORS');
    expect((await call('/requests', base)).status === 401, 'missing token');
    expect((await call('/requests', base, 'outsider')).status === 403, 'membership gate');
    expect((await call('/requests', base, 'expired')).status === 401, 'expired write token');
    expect((await call('/requests', null, 'member')).status === 400, 'null input');
    for (const bad of [
      { title: [] }, { title: ' ' }, { os: 'linux' }, { category: 'invalid' }, { ae_versions: [] },
      { ae_versions: ['2023'] }, { ae_versions: ['any', '2024'] },
      { reference: 'javascript:alert(1)' }, { reference: 'https://user:pass@example.com' }
    ]) expect((await call('/requests', { ...base, ...bad }, 'member')).status === 400, 'input boundary ' + JSON.stringify(bad));
    out = await call('/requests', base, 'member');
    expect(out.status === 201 && out.data.notification === 'sent', 'create and notify');
    const row = out.data.requests.find(r => r.id === out.data.id);
    expect(row.os === 'macos' && row.ae_versions.join(',') === '2024,2026' && row.reference === base.reference && row.votes === 1 && row.you_voted, 'new fields and author vote');
    expect(!('by' in row) && !('voters' in row), 'private voter IDs');
    expect(deliveries.length === 1 && deliveries[0].allowed_mentions.parse.length === 0 && deliveries[0].embeds[0].color === 0x08090d, 'dark embed with mentions disabled');
    expect(deliveries[0].embeds[0].fields.find(f => f.name === 'Requested by').value === 'member-editor', 'Discord username');
    expect((await call('/requests', { ...base, title: ' MOTION   EASING helper!!!' }, 'member')).status === 409 && deliveries.length === 1, 'normalized duplicate prevention');
    expect((await call('/requests/vote', { id: 'missing' }, 'member')).status === 404, 'missing vote target');
    expect((await call('/requests/status', { id: row.id, status: 'planned' }, 'member')).status === 403, 'admin-only status');
    expect((await call('/requests/status', { id: row.id, status: 'invented' }, 'admin')).status === 400, 'status validation');
    for (const status of ['planned', 'in_progress', 'shipped', 'open']) {
      const statusOut = await call('/requests/status', { id: row.id, status }, 'admin');
      expect(statusOut.status === 200 && statusOut.data.is_admin && statusOut.data.requests.find(r => r.id === row.id).status === status, 'admin status ' + status);
    }
    const votes = await Promise.all(Array.from({ length: 20 }, (_, i) => call('/requests/vote', { id: 'starter-bounce' }, 'voter' + i)));
    expect(votes.every(v => v.status === 200), 'concurrent vote success');
    out = await call('/requests');
    expect(out.data.requests.find(r => r.id === 'starter-bounce').votes === 20, 'no lost concurrent votes');
    await Promise.all(Array.from({ length: 10 }, () => call('/requests/vote', { id: 'starter-glow' }, 'same-member')));
    expect((await call('/requests')).data.requests.find(r => r.id === 'starter-glow').votes === 0, 'same voter atomic toggles');
    const simultaneous = await Promise.all(Array.from({ length: 8 }, (_, i) => call('/requests', { ...base, title: 'Concurrent duplicate' }, 'duplicate' + i)));
    expect(simultaneous.filter(r => r.status === 201).length === 1 && simultaneous.filter(r => r.status === 409).length === 7, 'atomic duplicate insertion');
    webhookFailure = true;
    out = await call('/requests', { ...base, title: 'Saved despite webhook failure' }, 'member');
    expect(out.status === 201 && out.data.notification === 'failed' && out.data.requests.some(r => r.title === 'Saved despite webhook failure'), 'notification failure does not lose request');
    expect((await call('/requests', undefined, 'expired')).status === 200, 'public board survives expired token');
    const callback = await mf.dispatchFetch('http://localhost/callback?code=test&state=state-test', { redirect: 'manual' });
    expect(callback.status === 302 && callback.headers.get('location').includes('in_server=true'), 'OAuth unchanged');
    expect((await call('/downloads')).status === 200, 'download counts unchanged');
    expect((await call('/verify', { token: 'owner' })).data.is_owner === true, 'Discord owner detected');
    expect((await call('/verify', { token: 'member', is_owner: true })).data.is_owner === false, 'client owner flag ignored');
    expect((await call('/verify', { token: 'foreign-owner' })).data.is_owner === false, 'other guild ownership ignored');
    expect((await call('/verify', { token: 'admin' })).data.is_owner === false, 'administrator permission is not ownership');
    out = await call('/requests', undefined, 'owner');
    expect(out.data.is_owner && out.data.is_admin, 'owner board capabilities');
    expect((await call('/requests')).data.is_owner === false, 'anonymous has no owner capability');
    out = await call('/requests', { ...base, title: 'Owner test request' }, 'owner');
    const ownerRow = out.data.requests.find(r => r.id === out.data.id);
    expect(ownerRow.author_name === 'owner-editor' && ownerRow.author_role === 'owner', 'owner author metadata server-derived');
    out = await call('/requests', { ...base, title: 'Forged owner request', author_name: 'owner-editor', author_role: 'owner', is_owner: true }, 'member');
    expect(out.data.requests.find(r => r.id === out.data.id).author_role === 'member', 'author role spoof rejected');
    expect((await call('/requests')).data.requests.find(r => r.id === ownerRow.id).author_role === 'owner', 'owner submission badge public');
    expect((await call('/requests/status', { id: ownerRow.id, status: 'planned' }, 'owner')).status === 200, 'owner may update status');
    expect((await call('/requests/delete', { id: ownerRow.id })).status === 401, 'anonymous deletion denied');
    expect((await call('/requests/delete', { id: ownerRow.id }, 'expired')).status === 401, 'expired deletion denied');
    expect((await call('/requests/delete', { id: ownerRow.id }, 'outsider')).status === 403, 'nonmember deletion denied');
    for (const token of ['member', 'admin', 'foreign-owner']) {
      expect((await call('/requests/delete', { id: ownerRow.id, is_owner: true, user: 'owner' }, token)).status === 403, 'nonowner deletion denied ' + token);
    }
    expect((await call('/requests/delete', {}, 'owner')).status === 400, 'missing deletion ID');
    expect((await call('/requests/delete', null, 'owner')).status === 400, 'invalid deletion body');
    expect((await call('/requests/delete', { id: 'unknown' }, 'owner')).status === 404, 'unknown deletion target');
    expect((await call('/requests/delete', undefined, 'owner')).status === 405, 'GET cannot delete');
    const beforeDelete = (await call('/requests')).data.requests;
    const deliveryCount = deliveries.length;
    out = await call('/requests/delete', { id: ownerRow.id }, 'owner');
    expect(out.status === 200 && out.data.is_owner && !out.data.requests.some(r => r.id === ownerRow.id), 'owner deletes request');
    expect(out.data.requests.length === beforeDelete.length - 1 && deliveries.length === deliveryCount, 'delete preserves unrelated requests and sends no webhook');
    expect((await call('/requests/delete', { id: ownerRow.id }, 'owner')).status === 404, 'duplicate deletion does not recreate request');
    await Promise.all([
      call('/requests/vote', { id: 'starter-bounce' }, 'member'),
      call('/requests/delete', { id: 'starter-bounce' }, 'owner')
    ]);
    expect(!(await call('/requests')).data.requests.some(r => r.id === 'starter-bounce'), 'vote-delete race does not resurrect request');
    ownerUser = 'successor';
    expect((await call('/requests/delete', { id: 'starter-glow' }, 'owner')).status === 403, 'previous owner revoked after transfer');
    expect((await call('/requests/delete', { id: 'starter-glow' }, 'successor')).status === 200, 'new owner recognized automatically');
    ownerUser = 'owner';
    console.log(JSON.stringify({ checks, concurrentVotes: 20, duplicateRace: '1 created / 7 rejected', webhooks: 'mocked only', runtime: 'SQLite Durable Object', result: 'passed' }));
  } finally { await mf.dispose(); }
  const legacy = make(false, '');
  try {
    const kv = await legacy.getKVNamespace('KYRO_DATA');
    await kv.put('kyro.requests.v1', JSON.stringify([
      { id: 'old-1', title: 'Existing request', category: 'script', ae: '2025', status: 'under_review', created: '2026-11-01', by: 'original', voters: ['original', 'other'] },
      { id: 'old-2', title: 'Existing shipped request', category: 'preset', ae: '', status: 'added_to_vault', created: '2026-11-02', voters: ['original'] }
    ]));
    let res = await legacy.dispatchFetch('http://localhost/requests');
    let data = await res.json();
    assert.equal(data.requests.length, 2);
    assert.equal(data.requests.find(r => r.id === 'old-1').votes, 2);
    assert.equal(data.requests.find(r => r.id === 'old-1').status, 'open');
    assert.deepEqual(data.requests.find(r => r.id === 'old-1').ae_versions, ['2025']);
    assert.equal(data.requests.find(r => r.id === 'old-2').status, 'shipped');
    assert.equal((await kv.get('kyro.requests.v1', { type: 'json' }))[0].status, 'under_review');
    res = await legacy.dispatchFetch('http://localhost/requests', {
      method: 'POST', headers: { authorization: 'Bearer member' },
      body: JSON.stringify({ ...base, title: 'No webhook configured' })
    });
    data = await res.json();
    assert.equal(res.status, 201);
    assert.equal(data.notification, 'not_configured');
    res = await legacy.dispatchFetch('http://localhost/requests/status', {
      method: 'POST', headers: { authorization: 'Bearer owner' }, body: JSON.stringify({ id: 'old-1', status: 'planned' })
    });
    assert.equal(res.status, 200);
    res = await legacy.dispatchFetch('http://localhost/requests/delete', {
      method: 'POST', headers: { authorization: 'Bearer owner' }, body: JSON.stringify({ id: 'old-1' })
    });
    assert.equal(res.status, 200);
    assert.equal((await kv.get('kyro.requests.v1', { type: 'json' })).length, 2);
    console.log(JSON.stringify({ legacyRequests: 2, votesPreserved: true, legacyKVUntouched: true, statusMigration: 'passed', missingWebhook: 'request still saved' }));
  } finally { await legacy.dispose(); }
}
main().catch(err => { console.error(err); process.exitCode = 1; });
