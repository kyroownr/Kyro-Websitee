/* /vault/upload-image hardening.

   The endpoint posts whatever it is given into the owner's private media
   channel, so it must only ever accept a genuine, small raster image. */
'use strict';
const assert = require('node:assert/strict');
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const source = require('esbuild').buildSync({ entryPoints: ['worker.js'], bundle: true, write: false, format: 'esm', platform: 'browser' }).outputFiles[0].text;

const OWNER = '200000000000000001';
const uploads = [];
// The media channel can lose the bot's access (category overwrite, deleted
// channel). When that happens the image must still be stored and served.
let discordDown = false;

const mf = new Miniflare(convertV4MiniflareOptions({
  modules: true,
  script: source,
  compatibilityDate: '2025-09-01',
  kvNamespaces: ['KYRO_DATA'],
  durableObjects: { KYRO_REQUESTS: { className: 'KyroRequests', useSQLite: true } },
  bindings: {
    KYRO_GUILD_ID: 'guild',
    DISCORD_CLIENT_ID: 'test-client',
    DISCORD_CLIENT_SECRET: 'test-secret',
    DISCORD_BOT_TOKEN: 'test-bot'
  },
  outboundService: async request => {
    const url = new URL(request.url);
    if (url.hostname !== 'discord.com') throw new Error('Unexpected outbound host: ' + url.hostname);
    if (url.pathname === '/api/users/@me') return Response.json({ id: OWNER, username: 'owner', avatar: null });
    if (url.pathname === '/api/users/@me/guilds') return Response.json([{ id: 'guild', owner: true, permissions: '8' }]);
    const media = url.pathname.match(/^\/api\/v10\/channels\/(\d+)\/messages$/);
    if (media && request.method === 'POST') {
      if (discordDown) return Response.json({ message: 'Missing Access' }, { status: 403 });
      uploads.push({ channel: media[1], type: request.headers.get('content-type') || '' });
      return Response.json({ attachments: [{ url: 'https://cdn.discordapp.com/attachments/1/2/image.png' }] });
    }
    if (url.pathname === '/api/v10/guilds/guild/channels') {
      if (request.method === 'GET') return Response.json([]);
      return Response.json({ message: 'Missing Access' }, { status: 403 });
    }
    throw new Error('Unexpected Discord endpoint: ' + request.method + ' ' + url.pathname);
  }
}));

const upload = (image) => mf.dispatchFetch('http://localhost/vault/upload-image', {
  method: 'POST',
  headers: { origin: 'http://localhost:4173', authorization: 'Bearer ' + OWNER, 'content-type': 'application/json' },
  body: JSON.stringify({ image })
});
const dataUri = (type, bytes) => 'data:' + type + ';base64,' + Buffer.from(bytes).toString('base64');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const GIF = Buffer.from('R0lGODlhAQABAAAAACw=', 'base64');

async function main() {
  let checks = 0;
  const expect = (value, label) => { assert.ok(value, label); checks++; };
  try {
    const svg = await upload(dataUri('image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'));
    expect(svg.status === 415, 'svg is refused even when the type says image/svg+xml');

    const html = await upload(dataUri('image/png', '<html><script>alert(1)</script></html>'));
    expect(html.status === 415, 'a file claiming image/png but holding html is refused');

    const stub = await upload(dataUri('image/gif', 'GIF89'));
    expect(stub.status === 415, 'a stub too short to sniff is refused');

    const badData = await upload('data:image/png;base64,!!!not-base64!!!');
    expect(badData.status === 400, 'malformed base64 is refused');

    const png = await upload(dataUri('image/png', PNG));
    const pngBody = await png.json();
    expect(png.status === 200 && /cdn\.discordapp\.com/.test(pngBody.url), 'a genuine png is stored');
    expect(uploads.length === 1 && uploads[0].channel === '1571185513401159720', 'only the validated image reaches Discord');
    expect(/multipart\/form-data/.test(uploads[0].type), 'the file is forwarded as form data, not raw bytes');

    const gif = await upload(dataUri('image/gif', GIF));
    expect(gif.status === 200, 'a genuine gif is stored');

    // 8 MiB cap: a ~8.4 MB image is rejected before any Discord call.
    const big = Buffer.concat([PNG, Buffer.alloc(8 * 1024 * 1024)]);
    const oversize = await upload(dataUri('image/png', big));
    expect(oversize.status === 413, 'images over 8 MB are refused');
    expect(uploads.length === 2, 'a refused image never reaches Discord');

    // Discord refuses the media channel: the picture still has to survive, or
    // the card silently falls back to the Kyro banner.
    discordDown = true;
    const fallback = await upload(dataUri('image/png', PNG));
    const fallbackBody = await fallback.json();
    expect(fallback.status === 200 && /\/vault\/image\/[a-f0-9-]{36}$/.test(fallbackBody.url || ''), 'a refused Discord upload still stores the image');
    const served = await mf.dispatchFetch(fallbackBody.url);
    const servedBytes = Buffer.from(await served.arrayBuffer());
    expect(served.status === 200 && served.headers.get('content-type') === 'image/png' && servedBytes.equals(PNG), 'the stored image is served back byte-for-byte');
    expect(served.headers.get('cache-control').includes('immutable') && served.headers.get('x-content-type-options') === 'nosniff', 'stored images are cached and never sniffed as another type');
    expect((await mf.dispatchFetch('http://localhost/vault/image/not-a-uuid')).status === 404, 'unknown image ids are not served');
    discordDown = false;

    // Deployment without a bot token: the endpoint must still store the picture
    // instead of refusing the upload and leaving the card on the Kyro banner.
    const mfNoBot = new Miniflare(convertV4MiniflareOptions({
      modules: true, script: source, compatibilityDate: '2025-09-01', kvNamespaces: ['KYRO_DATA'],
      durableObjects: { KYRO_REQUESTS: { className: 'KyroRequests', useSQLite: true } },
      bindings: { KYRO_GUILD_ID: 'guild', DISCORD_CLIENT_ID: 'test-client', DISCORD_CLIENT_SECRET: 'test-secret' },
      outboundService: async request => {
        const url = new URL(request.url);
        if (url.pathname === '/api/users/@me') return Response.json({ id: OWNER, username: 'owner', avatar: null });
        if (url.pathname === '/api/users/@me/guilds') return Response.json([{ id: 'guild', owner: true, permissions: '8' }]);
        throw new Error('Unexpected outbound call without a bot token: ' + url.pathname);
      }
    }));
    try {
      const res = await mfNoBot.dispatchFetch('http://localhost/vault/upload-image', {
        method: 'POST',
        headers: { origin: 'http://localhost:4173', authorization: 'Bearer ' + OWNER, 'content-type': 'application/json' },
        body: JSON.stringify({ image: dataUri('image/png', PNG) })
      });
      const noBot = await res.json();
      expect(res.status === 200 && /\/vault\/image\/[a-f0-9-]{36}$/.test(noBot.url || ''), 'an image is stored even when no bot token is configured');
      const noBotServed = await mfNoBot.dispatchFetch(noBot.url);
      expect(noBotServed.status === 200 && Buffer.from(await noBotServed.arrayBuffer()).equals(PNG), 'that image is served back unchanged');
    } finally { await mfNoBot.dispose(); }

    console.log(JSON.stringify({ checks, maxBytes: '8 MiB', types: 'png, jpeg, gif, webp', fallback: 'KV-backed with no usable Discord channel', result: 'passed' }));
  } finally { await mf.dispose(); }
}

main().catch(err => { console.error(err); process.exit(1); });
