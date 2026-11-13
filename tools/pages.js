/* Generates the clean-path category pages (windows/index.html, macos/index.html)
   from index.html so the overlays, palette and scripts can never drift.
   Run: node tools/pages.js                                     */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

const src = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const cut = src.indexOf('  <!-- ============ Command palette');
if (cut === -1) throw new Error('overlay block not found in index.html');
const overlays = src.slice(cut);

const PAGES = [
  {
    id: 'windows',
    title: 'Windows',
    desc: 'Software, tools, and plugins for Windows editors.',
    meta: 'Free After Effects software, tools and plugins for Windows editors — verified through the Kyro Discord.'
  },
  {
    id: 'macos',
    title: 'MacOS',
    desc: 'Software, tools, and plugins for Mac editors.',
    meta: 'Free After Effects software, tools and plugins for Mac editors — verified through the Kyro Discord.'
  }
];

const head = (p) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${p.title} — Kyro</title>
  <meta name="description" content="${p.meta}" />
  <meta name="theme-color" content="#08090d" />

  <!-- Absolute og:url / og:image: link crawlers resolve them outside the page. -->
  <link rel="canonical" href="https://kyro.new.tg/${p.id}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Kyro" />
  <meta property="og:url" content="https://kyro.new.tg/${p.id}" />
  <meta property="og:title" content="${p.title} — Kyro" />
  <meta property="og:description" content="${p.meta}" />
  <meta property="og:image" content="https://kyro.new.tg/assets/kyro-banner.png" />
  <meta property="og:image:width" content="512" />
  <meta property="og:image:height" content="512" />
  <meta property="og:image:alt" content="KYRO — est. Nov 2026" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${p.title} — Kyro" />
  <meta name="twitter:description" content="${p.meta}" />
  <meta name="twitter:image" content="https://kyro.new.tg/assets/kyro-banner.png" />

  <link rel="icon" type="image/png" href="/assets/kyro-icon.png" />

  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet" />

  <link rel="stylesheet" href="/css/styles.css" />
</head>
<body data-page="category" data-category="${p.id}">

  <header class="site-nav">
    <div class="nav-inner">
      <a class="nav-logo" href="/" aria-label="Kyro — home">
        <img class="nav-logo-mark" src="/assets/kyro-icon.png" alt="" width="26" height="26" />
        <span class="nav-logo-text">Kyro</span>
      </a>

      <nav class="nav-right" aria-label="Site">
        <button type="button" class="nav-link" id="paletteOpen">Search</button>
        <a class="nav-link" href="/guide">Guide</a>
        <a class="nav-link" href="/about">About</a>
        <a class="nav-link" href="#discordCard">Community</a>
        <button type="button" class="nav-link" id="requestsOpen">Requests</button>

        <button type="button" class="nav-icon-btn" id="savedBtn" aria-label="Open saved vault" title="Saved Vault">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M18 21 12 16.5 6 21V4.8A1.8 1.8 0 0 1 7.8 3h8.4A1.8 1.8 0 0 1 18 4.8z"/></svg>
          <span class="count-badge mono" id="savedCount" hidden>0</span>
        </button>

        <!-- Rendered by app.js: Login button when logged out, profile pill when logged in -->
        <div class="nav-auth" id="authSlot"></div>
      </nav>
    </div>
  </header>

  <main class="shell">
    <!-- ============ Category head (filled by app.js) ============ -->
    <header class="page-head">
      <p class="section-label">Browse</p>
      <h1 class="page-title" id="catTitle">${p.title}</h1>
      <p class="page-lede" id="catDesc">${p.desc}</p>
      <p class="page-meta" id="catCount"></p>
      <nav class="cat-nav" id="catNav" aria-label="Categories"></nav>
    </header>

    <!-- ============ Access status strip (rendered by app.js) ============ -->
    <section class="access-strip" id="accessStrip" aria-live="polite"></section>

    <section class="section">
      <div class="grid" id="softwareGrid"></div>
      <div class="empty" id="emptyState" hidden>
        <p>Nothing in this category yet.</p>
        <a class="btn btn-ghost" href="/">Show everything</a>
      </div>
    </section>

    <!-- ============ Split community banner (rendered by app.js) ============ -->
    <section class="banner" id="discordCard" aria-label="Kyro Discord"></section>
  </main>

  <footer class="site-footer">
    <div class="shell">
      <div class="footer-main">
        <div class="footer-left">
          <span class="brand-word mono">KYRO <span class="brand-heart" aria-hidden="true">&lt;3</span></span>
          <span class="stamp-badge mono" id="siteUpdated">—</span>
        </div>
        <div class="footer-links">
          <a href="/">Vault</a>
          <a href="/about">About</a>
          <a href="https://discord.gg/5ch7XeNg98" target="_blank" rel="noopener noreferrer" id="footerInvite">Invite ↗</a>
        </div>
      </div>
      <div class="footer-meta mono">
        <p>© 2026, Est. Nov 2026 · Kyro</p>
        <p><span id="footerDomain">kyro.new.tg</span></p>
      </div>
    </div>
  </footer>

`;

PAGES.forEach((p) => {
  const dir = path.join(root, p.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), head(p) + overlays, 'utf8');
  console.log(p.id + '/index.html written');
});
