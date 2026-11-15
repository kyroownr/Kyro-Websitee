/* Hardened build: produces minified, mangled copies for deployment.

   Usage: node tools/build-hardened.cjs

   Output (gitignored):
     dist/worker.js        bundled Worker — minified, identifiers mangled,
                           comments and source maps stripped. Deploy with
                           `npx wrangler deploy dist/worker.js` or use the
                           `npm run deploy` script (wrangler --minify).
     dist/site/<name>.js   minified copies of the public js/ assets, for when
                           you want the browser bundle to be harder to read.

   What this does and does not do:
   - Minification/mangling raises the effort for casual reading and shortens
     the download, but it is NOT a security boundary. LLMs, formatters and
     de-minifiers recover readable code quickly. Never put secrets or
     authorisation decisions in client code or rely on this to protect them.
   - The Worker runs on Cloudflare and its source is not served to browsers;
     what clients can inspect is the API. Real protection is server-side
     validation and authorisation (see handleIncomingVote), not scrambling.
   - Aggressive transforms (string-array obfuscation, control-flow
     flattening) slow execution measurably; this build only does esbuild's
     minify pass, which is typically as fast or faster than the original.
*/
'use strict';
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'dist');
const siteOut = path.join(outDir, 'site');

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return Buffer.byteLength(contents);
}

function main() {
  const started = Date.now();
  fs.rmSync(outDir, { recursive: true, force: true });

  const workerSource = fs.readFileSync(path.join(root, 'worker.js'), 'utf8');
  const worker = esbuild.buildSync({
    entryPoints: [path.join(root, 'worker.js')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    legalComments: 'none',
    sourcemap: false
  }).outputFiles[0].text;
  const workerBytes = write(path.join(outDir, 'worker.js'), worker);

  const siteFiles = fs.readdirSync(path.join(root, 'js'))
    .filter((name) => name.endsWith('.js') && !name.endsWith('.min.js'));
  const site = siteFiles.map((name) => {
    const source = fs.readFileSync(path.join(root, 'js', name), 'utf8');
    const minified = esbuild.transformSync(source, {
      loader: 'js',
      minify: true,
      target: 'es2020',
      legalComments: 'none'
    }).code;
    const bytes = write(path.join(siteOut, name), minified);
    return { file: 'js/' + name, originalBytes: Buffer.byteLength(source), minifiedBytes: bytes };
  });

  const report = {
    builtAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    worker: { file: 'dist/worker.js', originalBytes: Buffer.byteLength(workerSource), minifiedBytes: workerBytes },
    site
  };
  write(path.join(outDir, 'hardened-report.json'), JSON.stringify(report, null, 2));

  const pct = (a, b) => (100 - Math.round((a / b) * 100)) + '% smaller';
  console.log('Hardened build written to dist/');
  console.log(`  worker.js  ${report.worker.originalBytes} → ${workerBytes} bytes (${pct(workerBytes, report.worker.originalBytes)})`);
  for (const item of site) {
    console.log(`  ${item.file.padEnd(16)} ${item.originalBytes} → ${item.minifiedBytes} bytes (${pct(item.minifiedBytes, item.originalBytes)})`);
  }
  console.log('Reminder: this is hardening, not security. Auth and validation stay server-side.');
}

main();
