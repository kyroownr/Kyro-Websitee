/* Assemble the deployable website in docs/.

   This repository used to publish its whole root: /worker.js, /package.json,
   /wrangler.jsonc and the bot/dashboard servers were all downloadable from
   kyro.new.tg. This build copies an explicit allow-list of public files into
   docs/ and refuses anything that belongs to the backend, so the deployed site
   can never carry source code again.

   Usage:  node tools/build-site.cjs
   Output: docs/  (committed — GitHub Pages serves "main /docs")

   Run this and commit docs/ whenever a page, script, style or asset changes on
   the site. The repository root keeps the working copies the dev server and
   tests use; docs/ is only the published mirror.

   Switching to Cloudflare Pages later needs no change here:
     npx wrangler pages deploy docs --project-name kyro
*/
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'docs');

/* Everything a browser legitimately needs. dashboard.html is the staff bot UI
   served by bot_dashboard.js on localhost — it has no business on the public
   site, where its API calls could only 404. */
const PUBLIC_FILES = [
  'index.html',
  '404.html',
  'CNAME',
  'robots.txt'
];
const PUBLIC_DIRS = [
  'about',
  'apply',
  'guide',
  'incoming',
  'macos',
  'windows',
  'css',
  'js',
  'assets'
];

/* Backend and tooling names, blocked even if they appear inside a public dir. */
const BLOCKED = [
  /^worker\.js$/i,
  /^applications-worker\.js$/i,
  /^bot_dashboard\.js$/i,
  /^worker-configuration\.d\.ts$/i,
  /^wrangler\./i,
  /^package(-lock)?\.json$/i,
  /^dashboard_data\.json$/i,
  /^start-dashboard\.cmd$/i,
  /^_headers$/i,
  /\.(cjs|mjs|ts|map|log|md)$/i,
  /^\./ // dotfiles and dot-directories
];

function refused(name) {
  return BLOCKED.some((rule) => rule.test(name));
}

/* A path is publishable only when it is inside an allowed directory and no
   segment of it is a backend file. Returns false for ../ escapes too. */
function shouldPublish(relative) {
  const clean = String(relative).replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean || clean.split('/').some((part) => part === '..')) return false;
  const parts = clean.split('/');
  if (parts.some(refused)) return false;
  if (parts.length === 1) return PUBLIC_FILES.includes(parts[0]);
  return PUBLIC_DIRS.includes(parts[0]);
}

function copyFile(relative) {
  const from = path.join(root, relative);
  const to = path.join(out, relative);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  return fs.statSync(to).size;
}

function walk(relative, files) {
  const absolute = path.join(root, relative);
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    const child = relative + '/' + entry.name;
    if (entry.isDirectory()) {
      if (shouldPublish(child)) walk(child, files);
    } else if (entry.isFile() && shouldPublish(child)) {
      files.push(child);
    }
  }
}

function build() {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  const files = [];
  for (const file of PUBLIC_FILES) {
    if (fs.existsSync(path.join(root, file)) && shouldPublish(file)) files.push(file);
  }
  for (const dir of PUBLIC_DIRS) {
    if (fs.existsSync(path.join(root, dir)) && shouldPublish(dir + '/index.html')) walk(dir, files);
  }

  let bytes = 0;
  for (const file of files) bytes += copyFile(file);

  // Belt and braces: nothing that reached the output may be backend source.
  const leaked = files.filter((file) => !shouldPublish(file));
  if (leaked.length) throw new Error('Refusing to publish backend files: ' + leaked.join(', '));

  return { files, bytes, out };
}

module.exports = { build, shouldPublish, PUBLIC_FILES, PUBLIC_DIRS, BLOCKED, outDir: out };

if (require.main === module) {
  const result = build();
  console.log(`Built ${result.files.length} public files into docs/ (${(result.bytes / 1024).toFixed(0)} KB)`);
  console.log('Backend files (worker.js, applications-worker.js, tools/, package.json, wrangler config) are not published.');
}
