/* /vault/link — the only way a download URL leaves the server.

   The catalogue used to ship every archive URL and password to the browser, so
   "members only" was decorative. These checks keep the link behind a verified
   member and keep staged releases sealed until they are actually released. */
'use strict';
const assert = require('node:assert/strict');
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const source = require('esbuild').buildSync({ entryPoints: ['worker.js'], bundle: true, write: false, format: 'esm', platform: 'browser' }).outputFiles[0].text;

const IDS = {
  owner: '200000000000000001',
  admin: '200000000000000002',
  member: '200000000000000003',
  outsider: '200000000000000005'
};

const mf = new Miniflare(convertV4MiniflareOptions({
  modules: true,
  script: source,
  compatibilityDate: '2025-09-01',
  kvNamespaces: ['KYRO_DATA'],
  durableObjects: { KYRO_REQUESTS: { className: 'KyroRequests', useSQLite: true } },
  bindings: { KYRO_GUILD_ID: 'guild', KYRO_ADMIN_IDS: IDS.admin, DISCORD_CLIENT_ID: 'c', DISCORD_CLIENT_SECRET: 's' },
  outboundService: async request => {
    const url = new URL(request.url);
    if (url.hostname !== 'discord.com') throw new Error('Unexpected outbound host: ' + url.hostname);
    const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
    const id = IDS[token] || token;
    if (url.pathname === '/api/users/@me') return Response.json({ id, username: token + '-editor', avatar: null });
    if (url.pathname === '/api/users/@me/guilds') return Response.json(token === 'outsider' ? [] : [{ id: 'guild', owner: token === 'owner', permissions: '0' }]);
    throw new Error('Unexpected Discord endpoint ' + url.pathname);
  }
}));

async function main() {
  let checks = 0;
  const expect = (value, label) => { assert.ok(value, label); checks++; };
  const call = async (body, token) => {
    const headers = { origin: 'http://localhost:4173' };
    if (token) headers.authorization = 'Bearer ' + token;
    const res = await mf.dispatchFetch('http://localhost/vault/link', { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  };
  try {
    const kv = await mf.getKVNamespace('KYRO_DATA');
    await kv.put('kyro.vault_links.v1', JSON.stringify({
      items: {
        released: { files: { 'released.zip': { url: 'https://example.com/released.zip', pass: 'open' } } },
        applefx: { files: { 'AppleFX-1.2.5.zxp': { url: 'https://1024terabox.com/s/1sxC_pFYaOWc7dpeTkzRUsw', pass: 'Kyro' } } },
        external: { files: { 'other.zip': { url: 'https://example.com/other.zip' } } }
      }
    }));
    await kv.put('kyro.incoming_releases.v1', JSON.stringify({ items: [{
      id: 'inc-applefx', slug: 'applefx', title: 'AppleFX', votes: 0, vote_limit: 5,
      released: false, voters: {}, by: 'someone', created: new Date().toISOString()
    }] }));

    expect((await call({ id: 'released' })).status === 401, 'anonymous request is refused');

    const outsider = await call({ id: 'released' }, 'outsider');
    expect(outsider.status === 403, 'a signed-in non-member is refused');

    expect((await call({ id: 'released', name: 'released.zip' }, 'member')).status === 200, 'member gets a released archive');

    const unreleased = await call({ id: 'applefx', name: 'AppleFX-1.2.5.zxp' }, 'member');
    expect(unreleased.status === 403 && unreleased.data.url === undefined, 'a staged release is sealed before it is live');
    expect(/gathering/.test(unreleased.data.error || ''), 'the refusal explains why');

    expect((await call({ id: 'applefx', name: 'AppleFX-1.2.5.zxp' }, 'admin')).status === 200, 'staff bypass the staged release');

    const grantRes = await mf.dispatchFetch('http://localhost/early-access', {
      method: 'POST',
      headers: { origin: 'http://localhost:4173', authorization: 'Bearer owner', 'content-type': 'application/json' },
      body: JSON.stringify({ id: IDS.member })
    });
    expect(grantRes.status === 200, 'owner grants early access');

    const early = await call({ id: 'applefx', name: 'AppleFX-1.2.5.zxp' }, 'member');
    expect(early.status === 200 && early.data.url === 'https://1024terabox.com/s/1sxC_pFYaOWc7dpeTkzRUsw' && early.data.pass === 'Kyro', 'early access unlocks the staged link and password');

    const wrongName = await call({ id: 'released', name: 'not-a-file.zip' }, 'member');
    expect(wrongName.status === 404, 'a file name that has no stored link is refused');

    expect((await call({ id: 'unknown-resource' }, 'member')).status === 404, 'unknown resource has no link');
    expect((await call({}, 'member')).status === 400, 'missing resource id is rejected');

    // The public catalogue itself must never carry the secrets.
    const fs = require('node:fs');
    const catalogue = fs.readFileSync('js/data.js', 'utf8');
    expect(!/url:\s*'https?:/.test(catalogue), 'js/data.js ships no download urls');
    expect(!/^\s*pass:\s*'/m.test(catalogue), 'js/data.js ships no archive passwords');

    console.log(JSON.stringify({ checks, gate: 'member + released/early-access only', catalogue: 'no urls or passwords', result: 'passed' }));
  } finally { await mf.dispose(); }
}

main().catch(err => { console.error(err); process.exit(1); });
