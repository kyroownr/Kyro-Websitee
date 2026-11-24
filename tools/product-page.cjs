/* Generates product/index.html from windows/index.html.

   /product/?id=<listing> is one page per product: js/app.js renders the same
   body the popup uses into #productView, so a static host still gives every
   listing its own address. Building it from the Windows page keeps the nav,
   footer, palette, drawers and modal markup identical to the rest of the site.

   Run: node tools/product-page.cjs      (after tools/pages.js regenerates the
   Windows page, so the shell stays in sync)                                  */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

const src = fs.readFileSync(path.join(root, 'windows', 'index.html'), 'utf8');
const start = src.indexOf('  <main class="shell">');
const endTag = '  </main>';
const end = start === -1 ? -1 : src.indexOf(endTag, start);
if (start === -1 || end === -1) throw new Error('main block not found in windows/index.html');

const main = `  <main class="shell">
    <header class="page-head pp-head">
      <nav class="pp-crumbs" aria-label="Breadcrumb">
        <a href="/">Vault</a>
        <span aria-hidden="true">/</span>
        <a href="/windows">Browse</a>
        <span aria-hidden="true">/</span>
        <span id="ppCrumb">Listing</span>
      </nav>
      <h1 class="page-title" id="ppTitle">Loading listing…</h1>
      <p class="pp-meta" id="ppMeta"></p>
    </header>

    <!-- Filled by app.js from ?id= with the same body the popup shows. -->
    <div class="pp-card" id="productView" aria-live="polite">
      <div class="empty"><p>Loading the listing…</p></div>
    </div>

    <section class="pp-related" id="ppRelatedSection" hidden>
      <p class="section-label">More like this</p>
      <div class="grid" id="ppRelated"></div>
    </section>
  </main>`;

const head = src.slice(0, start)
  .replace(/<title>[^<]*<\/title>/, '<title>Product — Kyro</title>')
  .replace(/<meta name="description" content="[^"]*"/, '<meta name="description" content="A Kyro vault listing: screenshots, what is included, install steps and its download gate."')
  .replace(/<link rel="canonical" href="[^"]*"/, '<link rel="canonical" href="https://kyro.new.tg/product/"')
  .replace(/<meta property="og:url" content="[^"]*"/, '<meta property="og:url" content="https://kyro.new.tg/product/"')
  .replace(/<meta property="og:title" content="[^"]*"/, '<meta property="og:title" content="Product — Kyro"')
  .replace(/<meta name="twitter:title" content="[^"]*"/, '<meta name="twitter:title" content="Product — Kyro"')
  .replace(/data-page="[^"]*"[^>]*data-category="[^"]*"/, 'data-page="product"');

fs.mkdirSync(path.join(root, 'product'), { recursive: true });
fs.writeFileSync(path.join(root, 'product', 'index.html'), head + main + src.slice(end + endTag.length), 'utf8');
console.log('product/index.html written');
