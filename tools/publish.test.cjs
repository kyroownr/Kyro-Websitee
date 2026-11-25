/* Locks down what the website publishes.

   The site is served by GitHub Pages, so anything committed to the published
   root is downloadable. This test fails if the allow-list starts letting
   backend source through. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { build, shouldPublish, outDir } = require('./build-site.cjs');

let checks = 0;
const expect = (value, label) => { assert.ok(value, label); checks++; };

const backend = [
  'worker.js',
  'applications-worker.js',
  'bot_dashboard.js',
  'package.json',
  'package-lock.json',
  'wrangler.jsonc',
  'worker-configuration.d.ts',
  'dashboard_data.json',
  '_headers',
  'tools/build-site.cjs',
  'docs/worker.js',
  'docs/tools/build-site.cjs',
  'js/app.js.map',
  '.env',
  '.git/config'
];
for (const file of backend) expect(!shouldPublish(file), 'backend path refused: ' + file);

const publicPaths = [
  'index.html',
  '404.html',
  'CNAME',
  'js/app.js',
  'css/style.css',
  'assets/kyro-icon.png',
  'about/index.html'
];
for (const file of publicPaths) expect(shouldPublish(file), 'public path allowed: ' + file);

expect(!shouldPublish('../secrets.txt'), 'parent-directory escape refused');

const result = build();
expect(outDir.endsWith('docs'), 'the published mirror lives in docs/');
expect(fs.existsSync(path.join(outDir, 'index.html')), 'index.html is published');
expect(result.files.includes('js/app.js'), 'js/app.js is published');
expect(!fs.existsSync(path.join(outDir, 'worker.js')), 'worker.js is not published');
expect(!fs.existsSync(path.join(outDir, 'bot_dashboard.js')), 'bot_dashboard.js is not published');
expect(!fs.existsSync(path.join(outDir, 'package.json')), 'package.json is not published');
expect(!fs.existsSync(path.join(outDir, 'tools')), 'tools/ is not published');
expect(!fs.existsSync(path.join(outDir, 'dashboard.html')), 'the staff dashboard is not published');
expect(!result.files.some((file) => /\.(cjs|ts|map|log)$/i.test(file)), 'no code or log artifacts in the output');

/* Every page that can open the product detail modal also carries the owner
   edit modal. The Post Update modal must travel with it: the button renders
   from the shared bundle, so a page that forgets the markup shows a button
   that silently does nothing. */
for (const page of result.files.filter((file) => file.endsWith('.html'))) {
  const text = fs.readFileSync(path.join(outDir, page), 'utf8');
  if (!text.includes('ownerEditModalOverlay')) continue;
  expect(text.includes('postUpdateModalOverlay'), 'post update modal present in ' + page);
  expect(text.includes('pumSubmit'), 'post update form present in ' + page);
  expect(text.includes('oemAddAltLink'), 'alternative link editor present in ' + page);
}

console.log(JSON.stringify({ checks, publishedFiles: result.files.length, backendBlocked: backend.length, result: 'passed' }));
