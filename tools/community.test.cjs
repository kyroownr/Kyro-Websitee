const assert = require('node:assert/strict');
const path = require('node:path');
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const source = require('esbuild').buildSync({ entryPoints: [path.join(__dirname, '..', 'worker.js')], bundle: true, write: false, format: 'esm', platform: 'browser' }).outputFiles[0].text;

// Numeric Discord ids so the early-access grant validator (17-20 digits) accepts them.
const IDS = {
  owner: '200000000000000001',
  admin: '200000000000000002',
  memberA: '200000000000000003',
  memberB: '200000000000000004',
  outsider: '200000000000000005'
};

const mf = new Miniflare(convertV4MiniflareOptions({
  modules: true,
  script: source,
  compatibilityDate: '2025-09-01',
  kvNamespaces: ['KYRO_DATA'],
  durableObjects: { KYRO_REQUESTS: { className: 'KyroRequests', useSQLite: true } },
  bindings: {
    KYRO_GUILD_ID: 'guild', KYRO_ADMIN_IDS: IDS.admin,
    DISCORD_CLIENT_ID: 'test-client', DISCORD_CLIENT_SECRET: 'test-secret'
    // No DISCORD_BOT_TOKEN: incoming/audit Discord posts are skipped, KV only.
  },
  outboundService: async request => {
    const url = new URL(request.url);
    if (url.hostname !== 'discord.com') throw new Error('Unexpected outbound host ' + url.hostname);
    if (url.pathname === '/api/oauth2/token') return Response.json({ access_token: 'x' });
    const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
    const id = IDS[token] || token;
    if (url.pathname === '/api/users/@me') return Response.json({ id, username: token + '-editor', avatar: null });
    if (url.pathname === '/api/users/@me/guilds') return Response.json(token === 'outsider' ? [] : [
      { id: 'guild', owner: token === 'owner', permissions: token === 'admin' ? '8' : '0' }
    ]);
    throw new Error('Unexpected Discord endpoint ' + url.pathname);
  }
}));

async function main() {
  let checks = 0;
  const expect = (value, label) => { assert.ok(value, label); checks++; };
  const call = async (route, body, token, method) => {
    const headers = { origin: 'http://localhost:4173' };
    if (token) headers.authorization = 'Bearer ' + token;
    const m = method || (body === undefined ? 'GET' : 'POST');
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await mf.dispatchFetch('http://localhost' + route, {
      method: m, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: res.status, data: await res.json() };
  };

  try {
    /* ---------------- per-user requests board ---------------- */
    const base = { category: 'script', os: 'both', ae_versions: ['any'], desc: 'mine' };
    const a = await call('/requests', { ...base, title: 'Alpha request' }, 'memberA');
    expect(a.status === 201, 'A creates a request');
    expect(a.data.requests.length === 1 && a.data.requests[0].title === 'Alpha request', 'A create response is scoped to A');
    const b = await call('/requests', { ...base, title: 'Beta request' }, 'memberB');
    expect(b.status === 201 && b.data.requests.length === 1 && b.data.requests[0].title === 'Beta request', 'B create response is scoped to B');

    const ga = await call('/requests', undefined, 'memberA');
    expect(ga.data.requests.length === 1 && ga.data.requests[0].title === 'Alpha request' && ga.data.is_admin === false, 'A sees only their own request');
    const gb = await call('/requests', undefined, 'memberB');
    expect(gb.data.requests.length === 1 && gb.data.requests[0].title === 'Beta request', 'B sees only their own request');
    const gan = await call('/requests');
    expect(gan.data.requests.length === 6, 'signed-out visitors still see the public board (4 starters + 2)');
    const gad = await call('/requests', undefined, 'admin');
    expect(gad.data.requests.length === 6 && gad.data.is_admin === true, 'admin sees the whole board');
    const go = await call('/requests', undefined, 'owner');
    expect(go.data.requests.length === 6 && go.data.is_owner === true, 'owner sees the whole board');

    /* ---------------- per-user feedback ---------------- */
    const fa = await call('/feedback', { rating: 5, feedback: 'Great vault A', improvements: '' }, 'memberA');
    expect(fa.status === 201 && fa.data.feedback.length === 1 && fa.data.feedback[0].feedback === 'Great vault A', 'A feedback response scoped to A');
    const fb = await call('/feedback', { rating: 4, feedback: 'Nice tools B', anonymous: true }, 'memberB');
    expect(fb.status === 201 && fb.data.feedback.length === 1 && fb.data.feedback[0].anonymous === true, 'B sees their own anonymous feedback');
    const gfa = await call('/feedback', undefined, 'memberA');
    expect(gfa.data.feedback.length === 1 && gfa.data.feedback[0].feedback === 'Great vault A', 'A GET returns only their own feedback');
    const gfb = await call('/feedback', undefined, 'memberB');
    expect(gfb.data.feedback.length === 1 && gfb.data.feedback[0].author_name === 'Anonymous Editor', 'B GET returns their own anonymous entry');
    const gfad = await call('/feedback', undefined, 'admin');
    expect(gfad.data.feedback.length === 2 && gfad.data.is_admin === true, 'admin sees all feedback');
    expect((await call('/feedback')).status === 401, 'feedback requires a token');
    expect((await call('/feedback', undefined, 'outsider')).status === 403, 'feedback requires membership');

    /* ---------------- early access pass ---------------- */
    const kv = await mf.getKVNamespace('KYRO_DATA');
    await kv.put('kyro.incoming_releases.v1', JSON.stringify({ items: [{
      id: 'rel-1', title: 'Released Build', slug: 'released-build', kind: 'tool', os: 'both',
      download_url: 'https://example.com/released.zip', pass: 'relpass', votes: 5, vote_limit: 5,
      released: true, voters: {}, by: IDS.owner, by_username: 'owner-editor', created: new Date().toISOString()
    }] }));
    const inc = await call('/vault/incoming', { title: 'Pending Build', download_url: 'https://example.com/pending.zip', password: 'pendpass', vote_limit: 5 }, 'owner');
    expect(inc.status === 201, 'owner creates an incoming release');
    const pendingId = inc.data.item.id;

    /* ---------------- vote integrity: only +1 / -1 ---------------- */
    // A total poisoned by the old unvalidated handler (votes: 999999).
    const seeded = JSON.parse(await kv.get('kyro.incoming_releases.v1'));
    seeded.items.unshift({
      id: 'poison-1', title: 'Spoofed Votes', slug: 'spoofed-votes', kind: 'tool', os: 'both',
      download_url: 'https://example.com/spoofed.zip', votes: 999999, vote_limit: 7,
      released: false, voters: { [IDS.memberA]: 1 }, created: new Date().toISOString()
    });
    await kv.put('kyro.incoming_releases.v1', JSON.stringify(seeded));

    for (const delta of [999999, -999, 0, 2, 1.5, '1e9', null, undefined]) {
      const bad = await call('/vault/incoming/vote', { id: pendingId, delta }, 'memberB');
      expect(bad.status === 400 && /delta must be 1 or -1/.test(bad.data.error), 'vote delta ' + String(delta) + ' rejected');
    }
    const afterBads = await call('/vault/incoming', undefined, 'owner');
    expect(afterBads.data.incoming.find(i => i.id === pendingId).votes === 0, 'rejected votes never change the total');

    const selfVote = await call('/vault/incoming/vote', { id: pendingId, delta: 1 }, 'owner');
    expect(selfVote.status === 403 && /own incoming/.test(selfVote.data.error), 'the creator cannot vote their own release live');

    const up = await call('/vault/incoming/vote', { id: pendingId, delta: 1 }, 'memberB');
    expect(up.status === 200 && up.data.votes === 1 && up.data.userVote === 1, 'one +1 vote counts exactly once');
    const upAgain = await call('/vault/incoming/vote', { id: pendingId, delta: 1 }, 'memberB');
    expect(upAgain.data.votes === 0 && upAgain.data.userVote === 0, 'clicking +1 again removes the vote');
    const down = await call('/vault/incoming/vote', { id: pendingId, delta: -1 }, 'memberB');
    expect(down.status === 200 && down.data.votes === 0 && down.data.userVote === -1, 'a -1 vote cannot take the total below zero');
    const downOff = await call('/vault/incoming/vote', { id: pendingId, delta: -1 }, 'memberB');
    expect(downOff.data.votes === 0 && downOff.data.userVote === 0, 'clicking -1 again removes the downvote');
    const upA = await call('/vault/incoming/vote', { id: pendingId, delta: 1 }, 'memberA');
    expect(upA.data.votes === 1 && upA.data.userVote === 1, 'another member adds exactly one vote');
    const seenByA = await call('/vault/incoming', undefined, 'memberA');
    const seenByB = await call('/vault/incoming', undefined, 'memberB');
    expect(seenByA.data.incoming.find(i => i.id === pendingId).userVote === 1, 'A sees their own vote state');
    expect(seenByB.data.incoming.find(i => i.id === pendingId).userVote === 0, 'B does not inherit A\u2019s vote state');

    const healed = await call('/vault/incoming/vote', { id: 'poison-1', delta: 1 }, 'memberB');
    expect(healed.status === 200 && healed.data.votes === 2, 'a poisoned total heals to the real member votes');
    expect(healed.data.released === false, 'healed total does not fake a release');

    const imB = await call('/vault/incoming', undefined, 'memberB');
    expect(imB.data.earlyAccess === false, 'B has no early access');
    const pendB = imB.data.incoming.find(i => i.id === pendingId);
    const relB = imB.data.incoming.find(i => i.id === 'rel-1');
    expect(pendB && pendB.download_url === undefined && pendB.pass === undefined && pendB.early_access === false, 'unreleased link hidden from a regular member');
    expect(relB && relB.download_url === 'https://example.com/released.zip', 'released link is public');
    const ia = await call('/vault/incoming');
    expect(ia.data.incoming.find(i => i.id === pendingId).download_url === undefined, 'unreleased link hidden from anonymous');

    expect((await call('/early-access', { id: IDS.memberA }, 'memberB')).status === 403, 'member cannot grant early access');
    expect((await call('/early-access', { id: IDS.memberA }, 'admin')).status === 403, 'admin cannot grant early access (owner only)');
    expect((await call('/early-access', { id: 'abc' }, 'owner')).status === 400, 'invalid Discord id rejected');
    const grant = await call('/early-access', { id: IDS.memberA, username: 'memberA-editor' }, 'owner');
    expect(grant.status === 200 && grant.data.ok === true, 'owner grants early access to A');

    const eaA = await call('/early-access', undefined, 'memberA');
    expect(eaA.data.earlyAccess === true && eaA.data.is_owner === false && eaA.data.users === undefined, 'A has the pass but cannot list users');
    const imA = await call('/vault/incoming', undefined, 'memberA');
    const pendA = imA.data.incoming.find(i => i.id === pendingId);
    expect(imA.data.earlyAccess === true && pendA.download_url === 'https://example.com/pending.zip' && pendA.pass === 'pendpass' && pendA.early_access === true, 'A skips the waitlist and gets the direct link');
    const imB2 = await call('/vault/incoming', undefined, 'memberB');
    expect(imB2.data.incoming.find(i => i.id === pendingId).download_url === undefined, 'B is still gated after A is granted');

    const eaO = await call('/early-access', undefined, 'owner');
    expect(eaO.data.is_owner === true && Array.isArray(eaO.data.users) && eaO.data.users.some(u => u.id === IDS.memberA), 'owner lists granted users');
    const imO = await call('/vault/incoming', undefined, 'owner');
    expect(imO.data.incoming.find(i => i.id === pendingId).download_url === 'https://example.com/pending.zip', 'owner always bypasses the waitlist');

    const rev = await call('/early-access', { id: IDS.memberA }, 'owner', 'DELETE');
    expect(rev.status === 200 && rev.data.removed === true, 'owner revokes early access from A');
    const imA2 = await call('/vault/incoming', undefined, 'memberA');
    expect(imA2.data.earlyAccess === false && imA2.data.incoming.find(i => i.id === pendingId).download_url === undefined, 'A is gated again after revoke');

    /* ---------------- owner vote editing + release ---------------- */
    const edit = await call('/vault/incoming', { id: pendingId, votes: 100, vote_limit: 150 }, 'owner', 'PATCH');
    expect(edit.status === 200 && edit.data.item.votes === 100 && edit.data.item.vote_limit === 150, 'owner can set the displayed vote count');
    const memberEdit = await call('/vault/incoming', { id: pendingId, votes: 999 }, 'memberA', 'PATCH');
    expect(memberEdit.status === 403, 'members cannot edit incoming votes');
    const imEdited = await call('/vault/incoming', undefined, 'owner');
    expect(imEdited.data.incoming.find(i => i.id === pendingId).votes === 100, 'edited vote count is persisted');
    const released = await call('/vault/incoming', { id: pendingId, votes: 150 }, 'owner', 'PATCH');
    expect(released.status === 200 && released.data.item.released === true, 'owner edit can push an item live');
    const publicAfterRelease = await call('/vault/public');
    const releasedCard = publicAfterRelease.data.items.find(i => i.slug === 'pending-build');
    expect(Boolean(releasedCard), 'released incoming item reaches the public vault');
    expect(releasedCard.voters === undefined && releasedCard.by === undefined, 'public card does not expose who voted or who uploaded');


    /* ---------------- deletion really deletes + catalog tombstones ---------------- */
    const del = await call('/vault/submissions/manage', { id: pendingId, title: 'Pending Build' }, 'owner', 'DELETE');
    expect(del.status === 200 && del.data.deleted === true, 'owner deletes a published resource');
    const publicAfterDelete = await call('/vault/public');
    expect(!publicAfterDelete.data.items.some(i => i.slug === 'pending-build'), 'deleted resource is gone from the public vault');
    const memberDelete = await call('/vault/submissions/manage', { id: pendingId }, 'memberA', 'DELETE');
    expect(memberDelete.status === 403, 'members cannot delete vault resources');
    const catalogDelete = await call('/vault/submissions/manage', { id: 'catalog-test', title: 'Catalog Test', catalogue: true }, 'owner', 'DELETE');
    expect(catalogDelete.status === 200 && catalogDelete.data.catalogue === true, 'deleting a built-in catalogue entry records a tombstone');
    const missDelete = await call('/vault/submissions/manage', { id: 'not-a-real-card', title: 'Ghost' }, 'owner', 'DELETE');
    expect(missDelete.status === 200 && missDelete.data.deleted === false, 'deleting an unknown id does not fake a deletion');
    const publicAfterCatalog = await call('/vault/public');
    expect(publicAfterCatalog.data.hidden.includes('catalog-test'), 'tombstone is returned so the seed card stays hidden');

    /* ---------------- write flood is throttled ---------------- */
    let throttled = 0;
    let lastStatus = 0;
    for (let i = 0; i < 32; i++) {
      const res = await call('/feedback', { rating: 5, feedback: 'flood test ' + i }, 'memberB');
      if (res.status === 429) { throttled++; lastStatus = 429; }
      else lastStatus = res.status;
    }
    expect(throttled >= 1 && lastStatus === 429, 'a write flood from one member is throttled');

    console.log(JSON.stringify({ checks, perUserRequests: 'member scoped, admin/owner full, public showcase intact', perUserFeedback: 'author scoped, admin full', earlyAccess: 'owner grant/revoke, waitlist bypass, link gating', result: 'passed' }));
  } finally { await mf.dispose(); }
}
main().catch(err => { console.error(err); process.exitCode = 1; });