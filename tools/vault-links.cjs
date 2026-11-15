/* Move vault download links out of the public website.

   js/data.js is served to every visitor, so any `url` or archive `pass` in it
   is public — the membership gate in the UI meant nothing. This tool extracts
   those secrets into vault-links.json (gitignored), strips them from the
   catalogue, and can upload the map to the worker's KV where /vault/link
   releases a file only to verified members.

   Usage:
     node tools/vault-links.cjs            extract + strip
     node tools/vault-links.cjs --upload   also push the map to KYRO_DATA
*/
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const dataFile = path.join(root, 'js', 'data.js');
const outFile = path.join(root, 'vault-links.json');
const wranglerFile = path.join(root, 'wrangler.jsonc');
const KEY = 'kyro.vault_links.v1';

function readSeed() {
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(dataFile, 'utf8'), sandbox, { filename: 'js/data.js' });
  return sandbox.window.KYRO_SEED || [];
}

function extract(seed) {
  const items = {};
  for (const item of seed) {
    const files = {};
    for (const file of item.files || []) {
      if (!file.url) continue;
      files[file.name || file.ext || 'file'] = { url: file.url, ...(file.pass ? { pass: file.pass } : {}) };
    }
    if (Object.keys(files).length) items[item.id] = { files };
  }
  return { items };
}

/* Every gated file entry loses its url (replaced by `gated: true`) and its
   archive password. The catalogue keeps its title, description, screenshots,
   checksum and feature list — only the secrets move server-side. */
function strip(source) {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const kept = [];
  let urls = 0;
  let passes = 0;
  for (const line of source.split(/\r?\n/)) {
    if (/^\s*url:\s*'[^']*',?\s*$/.test(line)) {
      kept.push(line.replace(/^(\s*)url:\s*'[^']*'(,?)\s*$/, (_, indent, comma) => indent + 'gated: true' + comma));
      urls++;
      continue;
    }
    if (/^\s*pass:\s*'[^']*',?\s*$/.test(line)) { passes++; continue; }
    kept.push(line);
  }
  return { source: kept.join(eol), urls, passes };
}

function namespaceId() {
  const config = fs.readFileSync(wranglerFile, 'utf8');
  const match = config.match(/"kv_namespaces"\s*:\s*\[[\s\S]*?"id"\s*:\s*"([^"]+)"/);
  if (!match) throw new Error('No KV namespace id found in wrangler.jsonc');
  return match[1];
}

function existingLinks() {
  try {
    const current = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    return current && current.items ? current : { items: {} };
  } catch { return { items: {} }; }
}

function main() {
  const seed = readSeed();
  const fresh = extract(seed);
  let links = fresh;
  const freshFiles = Object.values(fresh.items).reduce((n, item) => n + Object.keys(item.files).length, 0);
  const saved = existingLinks();
  const savedFiles = Object.values(saved.items).reduce((n, item) => n + Object.keys(item.files).length, 0);

  /* The catalogue is already stripped on a second run, so extraction finds
     nothing. Never let that empty result overwrite (or upload over) the links
     that were captured the first time. */
  if (!freshFiles && savedFiles) {
    links = saved;
    console.log(`Catalogue already stripped — keeping the ${savedFiles} links in vault-links.json`);
  } else {
    fs.writeFileSync(outFile, JSON.stringify(links, null, 2) + '\n');
  }

  const itemCount = Object.keys(links.items).length;
  const fileCount = Object.values(links.items).reduce((n, item) => n + Object.keys(item.files).length, 0);

  const original = fs.readFileSync(dataFile, 'utf8');
  const stripped = strip(original);
  if (stripped.source !== original) fs.writeFileSync(dataFile, stripped.source);

  console.log(`vault-links.json holds ${fileCount} gated links across ${itemCount} resources`);
  console.log(stripped.urls ? `Stripped ${stripped.urls} urls and ${stripped.passes} passwords from js/data.js` : 'js/data.js already stripped');

  if (process.argv.includes('--upload')) {
    execSync(`npx wrangler kv key put --namespace-id=${namespaceId()} ${KEY} --path="${outFile}" --remote`, { stdio: 'inherit' });
    console.log('Uploaded to KYRO_DATA as ' + KEY);
  } else {
    console.log('Upload with: node tools/vault-links.cjs --upload');
  }
}

module.exports = { readSeed, extract, strip, KEY };

if (require.main === module) main();
