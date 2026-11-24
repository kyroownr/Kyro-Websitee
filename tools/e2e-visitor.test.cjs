/* One end-to-end pass as a new visitor: browse anonymously, sign in through the
   real /callback route (Discord is the only mocked piece), verify membership,
   and receive the download link and archive password. A non-member follows the
   same path and is refused at the last step. The aggregate signals those
   actions feed are checked from the owner side.

   Run: node tools/e2e-visitor.test.cjs                                     */
'use strict';
const assert = require('node:assert/strict');
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const source = require('esbuild').buildSync({ entryPoints: ['worker.js'], bundle: true, write: false, format: 'esm', platform: 'browser' }).outputFiles[0].text;

const USERS = {
  'visitor-token': { id: '300000000000000010', username: 'visitor-editor', guilds: [{ id: 'guild' }] },
  'outsider-token': { id: '300000000000000011', username: 'not-in-server', guilds: [] },
  'owner-token': { id: '300000000000000001', username: 'kyro-owner', guilds: [{ id: 'guild', owner: true }] }
};

const mf = new Miniflare(convertV4MiniflareOptions({
  modules: true,
  script: source,
  compatibilityDate: '2025-09-01',
  kvNamespaces: ['KYRO_DATA'],
  durableObjects: { KYRO_REQUESTS: { className: 'KyroRequests', useSQLite: true } },
  bindings: {
    KYRO_GUILD_ID: 'guild',
    KYRO_OWNER_ID: USERS['owner-token'].id,
    DISCORD_CLIENT_ID: 'client-id',
    DISCORD_CLIENT_SECRET: 'client-secret'
  },
  outboundService: async request => {
    const url = new URL(request.url);
    if (url.hostname !== 'discord.com') throw new Error('Unexpected outbound host: ' + url.hostname);
    if (url.pathname === '/api/oauth2/token') {
      const form = new URLSearchParams(await request.text());
      const user = USERS[form.get('code') + '-token'] || USERS['visitor-token'];
      return Response.json({ access_token: form.get('code') + '-token', token_type: 'Bearer' });
    }
    const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
    const user = USERS[token];
    if (!user) return new Response('unauthorized', { status: 401 });
    if (url.pathname === '/api/users/@me') return Response.json({ id: user.id, username: user.username, avatar: null });
    if (url.pathname === '/api/users/@me/guilds') return Response.json(user.guilds);
    throw new Error('Unexpected Discord endpoint ' + url.pathname);
  }
}));

async function main() {
  let checks = 0;
  const expect = (value, label) => { assert.ok(value, label); checks++; };
  const api = async (path, { method = 'GET', token, body } = {}) => {
    const headers = { origin: 'http://localhost:4173' };
    if (token) headers.authorization = 'Bearer ' + token;
    if (body) headers['content-type'] = 'application/json';
    const res = await mf.dispatchFetch('http://localhost' + path, {
      method, headers, body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    return { status: res.status, data, text, headers: res.headers };
  };

  try {
    const kv = await mf.getKVNamespace('KYRO_DATA');
    await kv.put('kyro.vault_approved_items.v1', JSON.stringify({ items: [{
      id: 'demo-1', slug: 'demo-tool', title: 'Demo Tool', kind: 'tool', os: 'windows',
      creator: 'Demo Studio', details: 'A demo listing used by the visitor test.',
      download_url: 'https://example.com/demo.zip', pass: 'unlock-me', created: new Date().toISOString()
    }] }));
    await kv.put('kyro.vault_links.v1', JSON.stringify({ items: {
      'demo-tool': { files: { 'Demo Tool': { url: 'https://example.com/demo.zip', pass: 'unlock-me' } } }
    } }));

    /* 1. Browse with no account at all. */
    const catalogue = await api('/vault/public');
    expect(catalogue.status === 200, 'anonymous visitor can read the catalogue');
    expect(catalogue.data.items.length === 1 && catalogue.data.items[0].title === 'Demo Tool', 'the resource is listed');
    expect(!('pass' in catalogue.data.items[0]), 'the archive password is not in the public catalogue');
    expect(!('download_url' in catalogue.data.items[0]), 'the download URL is not in the public catalogue');

    /* 2. The download gate refuses an anonymous click. */
    expect((await api('/vault/link', { method: 'POST', body: { id: 'demo-tool', name: 'Demo Tool' } })).status === 401,
      'anonymous download request is refused');

    /* 3. Sign in through the redirect the browser would follow. */
    const callback = await mf.dispatchFetch('http://localhost/callback?code=visitor&state=abc123', { redirect: 'manual' });
    expect(callback.status === 302, 'the Discord callback redirects back to the site');
    const location = new URL(callback.headers.get('location'));
    expect(location.searchParams.get('token') === 'visitor-token', 'the callback hands back a session token');
    const token = location.searchParams.get('token');

    /* 4. Verify membership with that token. */
    const verify = await api('/verify?token=' + token);
    expect(verify.status === 200 && verify.data.in_server === true, 'the sign-in is verified as a Kyro member');
    expect(verify.data.username === 'visitor-editor', 'the verified username comes back');

    /* 5. Member receives the link and the password. */
    const link = await api('/vault/link', { method: 'POST', token, body: { id: 'demo-tool', name: 'Demo Tool' } });
    expect(link.status === 200 && link.data.url === 'https://example.com/demo.zip', 'the member receives the download link');
    expect(link.data.pass === 'unlock-me', 'the member receives the archive password');

    /* 6. Signed in but not a member: stopped at the same step. */
    const outsiderCallback = await mf.dispatchFetch('http://localhost/callback?code=outsider&state=def456', { redirect: 'manual' });
    const outsiderToken = new URL(outsiderCallback.headers.get('location')).searchParams.get('token');
    const outsiderVerify = await api('/verify?token=' + outsiderToken);
    expect(outsiderVerify.data.in_server === false, 'a signed-in non-member is not treated as a member');
    expect((await api('/vault/link', { method: 'POST', token: outsiderToken, body: { id: 'demo-tool' } })).status === 403,
      'a non-member is refused the download link');

    /* 7. Anonymous signals the page sends. */
    expect((await api('/vault/view', { method: 'POST', body: { id: 'demo-tool' } })).status === 200, 'a view is accepted anonymously');
    expect((await api('/vault/link-report', { method: 'POST', body: { id: 'demo-tool', note: 'test report' } })).status === 200,
      'a broken-link report is accepted anonymously');

    /* 8. Owner reads the signals without any personal data. */
    const ownerCallback = await mf.dispatchFetch('http://localhost/callback?code=owner&state=ghi789', { redirect: 'manual' });
    const ownerToken = new URL(ownerCallback.headers.get('location')).searchParams.get('token');
    const signals = await api('/vault/signals', { token: ownerToken });
    expect(signals.status === 200, 'the owner can read the signals');
    expect(signals.data.totals.signins === 3, 'all three successful sign-ins were counted');
    expect(signals.data.totals.views === 1, 'the resource view was counted');
    expect(signals.data.totals.downloads === 1, 'the handed-out download link was counted');
    expect(signals.data.totals.broken === 1 && signals.data.reports[0].note === 'test report', 'the broken-link report was stored');
    expect((await api('/vault/signals', { token })).status === 403, 'a normal member cannot read the owner signals');

    /* 9. Approval stores exactly what the owner ticked and nothing more. */
    await kv.put('kyro.vault_submissions.v1', JSON.stringify({ submissions: [{
      id: 'sub-1', slug: 'review-demo', title: 'Review Demo', kind: 'tool', os: 'windows',
      download_url: 'https://example.com/review.zip', pass: 'review-pass',
      by: USERS['visitor-token'].id, by_username: 'visitor-editor',
      created: new Date().toISOString(), status: 'pending'
    }] }));
    const sha = 'b'.repeat(64);
    const approve = await api('/vault/submissions/review', {
      method: 'POST', token: ownerToken,
      body: { id: 'sub-1', decision: 'approve', checks: ['Download link opened'], sha256: sha }
    });
    expect(approve.status === 200, 'the owner approves a pending submission');
    expect(approve.data.submission.reviewed_by === 'kyro-owner', 'the approval stores the reviewer name');
    expect(Boolean(approve.data.submission.reviewed_at), 'the approval stores the review date');
    expect(JSON.stringify(approve.data.submission.checks) === JSON.stringify(['Download link opened']),
      'only the ticked check is recorded');
    expect(approve.data.submission.sha256 === sha, 'the recorded checksum is stored');

    const afterApproval = await api('/vault/public');
    const reviewed = (afterApproval.data.items || []).find(i => i.slug === 'review-demo');
    expect(reviewed && reviewed.reviewed_by === 'kyro-owner', 'the public listing names its reviewer');
    expect(reviewed && Array.isArray(reviewed.checks) && reviewed.checks.length === 1 && reviewed.checks[0] === 'Download link opened',
      'the public listing shows only the performed check');
    expect(reviewed && reviewed.sha256 === sha, 'the public listing carries the recorded checksum');
    expect(reviewed && !('download_url' in reviewed) && !('pass' in reviewed),
      'the approved listing still hides its URL and password');

    const approvedLink = await api('/vault/link', { method: 'POST', token, body: { id: 'review-demo' } });
    expect(approvedLink.status === 200 && approvedLink.data.pass === 'review-pass',
      'a member can still retrieve the approved link and password');

    console.log(JSON.stringify({
      checks,
      flow: 'browse anonymous -> 401 gate -> /callback sign-in -> /verify member -> link + password',
      outsider: 'signed in, not a member -> 403',
      signals: 'views, sign-ins, downloads, broken-link reports counted; owner-only',
      approval: 'reviewer, date, ticked checks and checksum recorded; listing shows exactly those',
      discord: 'mocked only; #help channel access needs a real Discord account',
      result: 'passed'
    }));
  } finally { await mf.dispose(); }
}

main().catch(err => { console.error(err); process.exit(1); });
