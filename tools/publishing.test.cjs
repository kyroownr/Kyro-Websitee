/* Server-owned Discord publishing, mention safety, retries and the optional
   VirusTotal flow. Nothing here talks to the real Discord or VirusTotal APIs:
   every request is answered by the local mock below. */
'use strict';
const assert = require('node:assert/strict');
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const source = require('esbuild').buildSync({ entryPoints: ['worker.js'], bundle: true, write: false, format: 'esm', platform: 'browser' }).outputFiles[0].text;

const OWNER = '200000000000000001';
const MEMBER = '300000000000000001';
const OWNER_TOKEN = 'owner-token';
const MEMBER_TOKEN = 'member-token';
const PROOF = '900000000000000001';
const BOT_SECRET = 'test-bot-secret';
const ANNOUNCE = '1539961971422658571';
const DOWNLOADS = '1539961998601756722';
const SHOWCASE = '1541775088901292042';

const posts = [];      // { channel, body }
const patches = [];    // { channel, id, body }
const vtSubmissions = [];
let vtAnalysisStatus = 'queued';
let vtStats = { malicious: 0, suspicious: 0, harmless: 70, undetected: 5, timeout: 0 };
let failPosts = 0;
let messageSeq = 0;
let vtSubmits = 0;

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
    DISCORD_BOT_TOKEN: 'test-bot-token',
    VIRUSTOTAL_API_KEY: 'test-vt-key',
    BOT_PUBLISH_SECRET: BOT_SECRET,
    DISCORD_PROOF_CHANNEL_ID: PROOF
  },
  outboundService: async request => {
    const url = new URL(request.url);
    const auth = request.headers.get('authorization') || '';

    if (url.hostname === 'discord.com') {
      if (url.pathname === '/api/users/@me') {
        return Response.json({ id: auth.includes(OWNER_TOKEN) ? OWNER : MEMBER, username: auth.includes(OWNER_TOKEN) ? 'owner' : 'member', avatar: null });
      }
      if (url.pathname === '/api/users/@me/guilds') {
        return Response.json([{ id: 'guild', owner: auth.includes(OWNER_TOKEN), permissions: auth.includes(OWNER_TOKEN) ? '8' : '0' }]);
      }
      if (url.pathname === '/api/v10/guilds/guild/roles') return Response.json([]);
      if (url.pathname === '/api/v10/guilds/guild/channels') return Response.json([]);
      const channelGet = url.pathname.match(/^\/api\/v10\/channels\/(\d+)$/);
      if (channelGet && request.method === 'GET') {
        if (channelGet[1] === '910000000000000099') return Response.json({ message: 'Unknown Channel' }, { status: 404 });
        return Response.json({ id: channelGet[1], type: 0, guild_id: 'guild' });
      }

      const messagePost = url.pathname.match(/^\/api\/v10\/channels\/(\d+)\/messages$/);
      if (messagePost && request.method === 'POST') {
        if (failPosts > 0) { failPosts--; return Response.json({ message: 'Internal Server Error' }, { status: 500 }); }
        const body = await request.json();
        posts.push({ channel: messagePost[1], body });
        return Response.json({ id: 'msg-' + (++messageSeq) });
      }
      const messagePatch = url.pathname.match(/^\/api\/v10\/channels\/(\d+)\/messages\/(\d+|msg-\d+)$/);
      if (messagePatch && request.method === 'PATCH') {
        const body = await request.json();
        patches.push({ channel: messagePatch[1], id: messagePatch[2], body });
        return Response.json({ id: messagePatch[2] });
      }
      if (url.pathname === `/api/v10/channels/${SHOWCASE}/threads` && request.method === 'POST') {
        return Response.json({ id: 'thread-' + (++messageSeq) });
      }
      throw new Error('Unexpected Discord request: ' + request.method + ' ' + url.pathname);
    }

    if (url.hostname === 'www.virustotal.com') {
      if (url.pathname === '/api/v3/urls' && request.method === 'POST') {
        vtSubmissions.push(await request.text());
        vtSubmits++;
        return Response.json({ data: { id: 'analysis-' + vtSubmits, type: 'analysis' } });
      }
      if (url.pathname.startsWith('/api/v3/analyses/')) {
        return Response.json({ data: { attributes: { status: vtAnalysisStatus, stats: vtStats } } });
      }
      throw new Error('Unexpected VirusTotal request: ' + url.pathname);
    }
    throw new Error('Unexpected outbound host: ' + url.hostname);
  }
}));

const call = (path, token, body, method = 'POST') => mf.dispatchFetch('http://localhost' + path, {
  method,
  headers: { origin: 'http://localhost:4173', authorization: 'Bearer ' + token, 'content-type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined
});
const announce = () => posts.filter(post => post.channel === ANNOUNCE);
const proofPosts = () => posts.filter(post => post.channel === PROOF);

async function publishTool(slug, extra = {}) {
  return call('/vault/submissions', OWNER_TOKEN, {
    title: '@everyone Free Tool <@&123456789012345678>',
    slug,
    kind: 'tool',
    os: 'windows',
    category: 'Plugins',
    details: 'A very long description '.repeat(30) + '@here <@123456789012345678>',
    download_url: 'https://example.com/file.zip',
    ...extra
  });
}

async function main() {
  let checks = 0;
  const expect = (value, label) => { assert.ok(value, label); checks++; };

  // 1. A tool publishes with escaped mentions and no false "Verified" claim.
  const tool = await publishTool('mention-tool');
  expect(tool.status === 201, 'tool submission accepted');
  const first = announce()[0];
  expect(Boolean(first), 'tool announcement posted');
  expect(first.body.embeds[0].title.length <= 110, 'embed title length limited');
  expect(first.body.embeds[0].description.length <= 340, 'embed description length limited');
  expect(!first.body.embeds[0].description.includes('@everyone'), 'everyone mention neutralised');
  expect(!first.body.embeds[0].description.includes('@here'), 'here mention neutralised');
  expect(!JSON.stringify(first.body.embeds[0]).includes('<@123456789012345678>'), 'user mention neutralised');
  expect(!JSON.stringify(first.body.embeds[0]).includes('@&123456789012345678'), 'role mention neutralised');
  expect(!/Verified/.test(JSON.stringify(first.body.embeds[0])), 'no unearned Verified label');
  expect(first.body.embeds[0].fields.some(field => field.name === 'Platform'), 'tool shows platform');
  expect(posts.some(post => post.channel === DOWNLOADS), 'downloads announcement posted');

  // 2. Status is reported, and retrying an unchanged post is a no-op.
  const status = await call('/vault/discord/publish', OWNER_TOKEN, null, 'GET');
  const statusBody = await status.json();
  expect(statusBody.publish['mention-tool'].status === 'posted', 'publish status reported');
  const countBefore = announce().length;
  const retry = await call('/vault/discord/publish', OWNER_TOKEN, { slug: 'mention-tool', action: 'retry' });
  expect(retry.status === 200, 'owner can retry');
  expect(announce().length === countBefore, 'retry of unchanged resource does not duplicate');

  // 3. Course announcements use Open course and instructor/source, not size.
  const course = await call('/vault/submissions', OWNER_TOKEN, {
    title: 'Colour Grading Course',
    slug: 'colour-course',
    kind: 'course',
    category: 'Course',
    creator: 'Studio Source',
    source_url: 'https://courses.example.com/grading',
    download_url: 'https://courses.example.com/grading',
    rights_confirmed: true,
    details: 'A course about grading.'
  });
  expect(course.status === 201, 'course submission accepted');
  const coursePost = announce().find(post => JSON.stringify(post.body).includes('Colour Grading Course'));
  expect(Boolean(coursePost), 'course announcement posted');
  const courseEmbed = coursePost.body.embeds[0];
  expect(coursePost.body.components[0].components[0].label === 'Open course ↗', 'course action says Open course');
  expect(courseEmbed.fields.some(field => field.name === 'Instructor / source'), 'course shows instructor/source');
  expect(!courseEmbed.fields.some(field => field.name === 'Platform'), 'course omits platform field');
  expect(courseEmbed.url.includes('/courses#colour-course'), 'course links to the courses page');

  // 4. Removal replaces the live announcement with a removal notice.
  const remove = await call('/vault/submissions/manage', OWNER_TOKEN, { id: 'colour-course' }, 'DELETE');
  expect(remove.status === 200, 'owner can remove a resource');
  expect(patches.some(patch => JSON.stringify(patch.body).includes('REMOVED')), 'removal notice patched into Discord');
  const afterRemove = await (await call('/vault/discord/publish', OWNER_TOKEN, null, 'GET')).json();
  expect(afterRemove.publish['colour-course'].status === 'removed', 'removal recorded in status');

  // 5. A Discord failure is recorded, publication still succeeds, retry posts it.
  failPosts = 12;
  const failing = await publishTool('failed-tool');
  expect(failing.status === 201, 'resource is still accepted when Discord fails');
  const failedStatus = await (await call('/vault/discord/publish', OWNER_TOKEN, null, 'GET')).json();
  expect(failedStatus.publish['failed-tool'].status === 'failed', 'failure recorded as failed');
  expect(!JSON.stringify(failedStatus).includes('test-bot-token'), 'token never appears in status');
  failPosts = 0;
  const beforeRetry = announce().length;
  const retryOk = await call('/vault/discord/publish', OWNER_TOKEN, { slug: 'failed-tool', action: 'retry' });
  expect(retryOk.status === 200, 'failed post can be retried');
  expect(announce().length === beforeRetry + 1, 'retry posts exactly one announcement');

  // 6. Opt-in scan: URL submitted, proof posted, pending then results updated.
  const beforeVt = vtSubmits;
  const scanned = await publishTool('scanned-tool', { scan_requested: true });
  expect(scanned.status === 201, 'opt-in submission accepted');
  expect(vtSubmits === beforeVt + 1, 'URL submitted to VirusTotal only after opt-in');
  const dbgStatus = await (await call('/vault/virustotal', OWNER_TOKEN, null, 'GET')).json();
  const proofPending = proofPosts().find(post => JSON.stringify(post.body).includes('scanned-tool') || JSON.stringify(post.body).includes('@everyone'));
  expect(Boolean(proofPending), 'pending proof message posted');
  expect(!JSON.stringify(proofPending.body).includes('test-vt-key'), 'API key not exposed');

  vtAnalysisStatus = 'completed';
  vtStats = { malicious: 1, suspicious: 0, harmless: 70, undetected: 5, timeout: 0 };
  const refreshed = await call('/vault/virustotal', OWNER_TOKEN, { slug: 'scanned-tool', action: 'refresh' });
  expect(refreshed.status === 200, 'owner can refresh a pending scan');
  expect(patches.some(patch => patch.channel === PROOF && JSON.stringify(patch.body).includes('Detections reported: 1 of 76')), 'proof updated with detection counts');
  const scanStatus = await (await call('/vault/virustotal', OWNER_TOKEN, null, 'GET')).json();
  expect(scanStatus.scans['scanned-tool'].status === 'completed', 'scan completion stored');
  expect(scanStatus.scans['scanned-tool'].flagged === true, 'detections flagged for moderator review');

  // 6b. Detections hold the listing until a moderator releases it.
  const publicHeld = await (await call('/vault/public', OWNER_TOKEN, null, 'GET')).json();
  expect(!(publicHeld.items || []).some(item => item.slug === 'scanned-tool'), 'flagged resource held out of the catalogue');
  const released = await call('/vault/virustotal', OWNER_TOKEN, { slug: 'scanned-tool', action: 'release' });
  expect(released.status === 200, 'moderator can release a held resource');
  const publicReleased = await (await call('/vault/public', OWNER_TOKEN, null, 'GET')).json();
  expect((publicReleased.items || []).some(item => item.slug === 'scanned-tool'), 'released resource is public again');

  // 7. Opt-out: no scan record and no VirusTotal request.
  const beforeOptOut = vtSubmits;
  await publishTool('no-scan-tool');
  expect(vtSubmits === beforeOptOut, 'no scan request without consent');

  // 8. Unauthorized retry and scan status are refused.
  const denied = await call('/vault/discord/publish', MEMBER_TOKEN, { slug: 'mention-tool', action: 'retry' });
  expect(denied.status === 403, 'ordinary member cannot retry');
  const deniedScan = await call('/vault/virustotal', MEMBER_TOKEN, null, 'GET');
  expect(deniedScan.status === 403, 'ordinary member cannot read scan records');

  // 9. Proof channel setup: verified with a test post, clear errors otherwise.
  const saved = await call('/dashboard/publishing', OWNER_TOKEN, { channel_id: '910000000000000002' });
  expect(saved.status === 200, 'admin can save a proof channel');
  const savedBody = await saved.json();
  expect(savedBody.channel_id === '910000000000000002', 'proof channel id persisted');
  expect(Boolean(savedBody.test_message_id), 'test post confirmed by Discord');
  const proofGet = await call('/dashboard/publishing', OWNER_TOKEN, null, 'GET');
  const proofGetBody = await proofGet.json();
  expect(proofGetBody.proof_channel_id === '910000000000000002' && proofGetBody.reachable === true, 'saved channel is reachable');
  const missing = await call('/dashboard/publishing', OWNER_TOKEN, { channel_id: '910000000000000099' });
  const missingBody = await missing.json();
  expect(missing.status === 404 && missingBody.code === 'channel_missing', 'missing channel returns a clear setup error');
  const deniedProof = await call('/dashboard/publishing', MEMBER_TOKEN, { channel_id: '910000000000000002' });
  expect(deniedProof.status === 403, 'ordinary member cannot configure the proof channel');
  const tested = await call('/dashboard/publishing', OWNER_TOKEN, { action: 'test' });
  expect(tested.status === 200, 'saved channel can be re-tested');

  // 10. Every product post carries an owner-only update button; pressing it
  //     with a new version edits the post and says it just got updated.
  const updatePost = posts.find(post => post.channel === ANNOUNCE &&
    (post.body.components || []).some(row => (row.components || []).some(c => c.custom_id === 'kyro-upd:mention-tool')));
  expect(Boolean(updatePost), 'product post carries the update button');
  const updateButton = updatePost.body.components[0].components.find(c => c.custom_id === 'kyro-upd:mention-tool');
  expect(updateButton.style === 3 && updateButton.label.length <= 80, 'update button is a real button with a short label');

  const forged = await mf.dispatchFetch('http://localhost/vault/discord/update', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug: 'mention-tool', version: 'v1.1' })
  });
  expect(forged.status === 403, 'update route refuses requests without the bot secret');

  const memberDenied = await mf.dispatchFetch('http://localhost/vault/discord/update', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + MEMBER_TOKEN },
    body: JSON.stringify({ slug: 'mention-tool', version: 'v1.0.9' })
  });
  expect(memberDenied.status === 403, 'ordinary member cannot post an update from the website');

  const beforeOwnerUpdate = announce().length;
  const ownerUpdated = await mf.dispatchFetch('http://localhost/vault/discord/update', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + OWNER_TOKEN },
    body: JSON.stringify({ slug: 'mention-tool', version: 'v1.0.5', note: 'Posted from the website' })
  });
  const ownerUpdatedBody = await ownerUpdated.json();
  expect(ownerUpdated.status === 200 && ownerUpdatedBody.ok, 'owner token can post an update from the website');
  expect(announce().length === beforeOwnerUpdate + 1, 'owner update posts exactly one announcement');
  expect(/just got updated/.test(announce().at(-1).body.content), 'owner update announcement says it just got updated');

  const beforeUpdate = announce().length;
  const updated = await mf.dispatchFetch('http://localhost/vault/discord/update', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-kyro-bot': BOT_SECRET },
    body: JSON.stringify({ slug: 'mention-tool', version: 'v1.1', note: 'Fixed the installer', by: OWNER })
  });
  const updatedBody = await updated.json();
  expect(updated.status === 200 && updatedBody.version === 'v1.1', 'update route applies the new version');
  const updateNotice = announce().at(-1);
  expect(announce().length === beforeUpdate + 1, 'exactly one update announcement posted');
  expect(/just got updated/.test(updateNotice.body.content), 'announcement says the product just got updated');
  expect(!/https:\/\//.test(updateNotice.body.content), 'no bare page link for Discord to unfurl');
  const updateCard = (updateNotice.body.embeds || [])[0] || {};
  expect(updateCard.author && updateCard.author.name.includes('Updated'), 'update card is labelled as an update');
  expect(updateCard.url && updateCard.url.includes('/windows#mention-tool'), 'update card links to the product page');
  expect((updateCard.fields || []).some(field => field.name === 'New version' && field.value.includes('v1.1')), 'update card shows the new version');
  expect(String(updateCard.description || '').includes('Fixed the installer'), 'update card carries the change note');
  const pageButton = (updateNotice.body.components || []).flatMap(row => row.components || []).find(c => c.label === 'Open product page ↗');
  expect(pageButton && pageButton.url.includes('/windows#mention-tool'), 'update card has a button to the product page');
  expect(patches.some(patch => JSON.stringify(patch.body).includes('UPDATED')), 'the existing post was edited in place');
  const afterUpdate = await (await call('/vault/public', OWNER_TOKEN, null, 'GET')).json();
  const versioned = (afterUpdate.items || []).find(item => item.slug === 'mention-tool');
  expect(versioned && versioned.version === 'v1.1', 'new version stored on the resource');

  const backfill = await mf.dispatchFetch('http://localhost/vault/discord/publish', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-kyro-bot': BOT_SECRET },
    body: JSON.stringify({ action: 'backfill' })
  });
  const backfillBody = await backfill.json();
  expect(backfill.status === 200 && backfillBody.backfill.patched >= 2, 'backfill adds the button to existing posts');

  // 11. Alternative download links: labels are public, URLs stay gated.
  const mirrored = await call('/vault/submissions', OWNER_TOKEN, {
    title: 'Mirror Test Tool',
    slug: 'mirror-test',
    kind: 'tool',
    os: 'windows',
    category: 'Plugins',
    download_url: 'https://example.com/main.zip',
    links: [
      { label: 'Google Drive', url: 'https://drive.example.com/mirror.zip' },
      { label: 'Broken mirror', url: 'not-a-url' }
    ]
  });
  expect(mirrored.status === 201, 'upload with alternative links accepted');
  const mirrorPublic = await (await call('/vault/public', OWNER_TOKEN, null, 'GET')).json();
  const mirrorEntry = (mirrorPublic.items || []).find(item => item.slug === 'mirror-test');
  expect(Boolean(mirrorEntry), 'mirrored resource is in the catalogue');
  expect(!mirrorEntry.links && !mirrorEntry.download_url, 'mirror and main URLs stay out of the public catalogue');
  expect(mirrorEntry.link_labels.length === 1 && mirrorEntry.link_labels[0] === 'Google Drive', 'mirror labels are public, the broken one dropped');
  const altLink = await call('/vault/link', OWNER_TOKEN, { id: mirrorEntry.id, name: 'alt:0' });
  const altLinkBody = await altLink.json();
  expect(altLink.status === 200 && altLinkBody.url === 'https://drive.example.com/mirror.zip', 'verified member gets the alternative link');
  const altMissing = await call('/vault/link', OWNER_TOKEN, { id: mirrorEntry.id, name: 'alt:4' });
  expect(altMissing.status === 404, 'a mirror that does not exist is refused');

  const editedMirrors = await call('/vault/submissions/manage', OWNER_TOKEN, {
    id: mirrorEntry.id,
    links: [{ label: 'MEGA', url: 'https://mega.example.com/build.zip' }]
  }, 'PUT');
  expect(editedMirrors.status === 200, 'owner can replace mirrors from the edit form');
  const editedPublic = await (await call('/vault/public', OWNER_TOKEN, null, 'GET')).json();
  const editedEntry = (editedPublic.items || []).find(item => item.slug === 'mirror-test');
  expect(editedEntry.link_labels.length === 1 && editedEntry.link_labels[0] === 'MEGA', 'edited mirrors show on the listing');
  const editedAlt = await call('/vault/link', OWNER_TOKEN, { id: editedEntry.id, name: 'alt:0' });
  const editedAltBody = await editedAlt.json();
  expect(editedAlt.status === 200 && editedAltBody.url === 'https://mega.example.com/build.zip', 'edited mirror is released to members');

  console.log(`publishing: ${checks} checks passed`);
  await mf.dispose();
}

main().catch(async error => {
  console.error(error);
  try { await mf.dispose(); } catch {}
  process.exit(1);
});
