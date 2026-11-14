/**
 * Kyro Staff Bot — Localhost Command Center & Auto-Publisher
 * Exclusively for Server Owner: sxii123 (1052909930073567232)
 *
 * Runs locally on http://localhost:4000
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 4000;
// Bot token loaded from environment or local .env
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || (function() {
  try {
    const fs = require('fs');
    if (fs.existsSync('.env')) {
      const match = fs.readFileSync('.env', 'utf8').match(/DISCORD_BOT_TOKEN=([^\r\n]+)/);
      if (match) return match[1].trim();
    }
  } catch(e) {}
  return '';
})();
const GUILD_ID = process.env.DISCORD_GUILD_ID || '1539961184323772498';
const OWNER_ID = process.env.DISCORD_OWNER_ID || '1052909930073567232';
const KYRO_ICON = 'https://raw.githubusercontent.com/kyroownr/Kyro-Websitee/main/assets/kyro-icon.png';

// Server Channels
const CHANNELS = {
  announcements: '1539961971422658571',
  downloads_links: '1539961998601756722',
  showcase_forum: '1541775088901292042'
};

// Forum tag for software/tools
const SHOWCASE_TAG_SOFTWARE = '1541775995395379310';

// Upload history database to detect new uploads vs updates
const DB_FILE = path.join(__dirname, 'published_uploads.json');
function loadPublished() {
  try {
    if (fs.existsSync(DB_FILE)) {
      return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    }
  } catch (e) {}
  return {};
}

function savePublished(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save publish history:', e);
  }
}

async function discordFetch(endpoint, options = {}) {
  const res = await fetch(`https://discord.com/api/v10${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bot ${BOT_TOKEN}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || `Discord HTTP ${res.status}`);
  }
  return data;
}

/**
 * Builds a Kyro-branded card embed with buttons
 */
function buildKyroCard(item, isUpdate, pageUrl) {
  const os = (item.os || 'windows').toLowerCase();
  const osLabel = os === 'both' ? 'Windows & macOS' : os === 'macos' ? 'macOS' : 'Windows';
  const category = item.category || 'Adobe After Effects';
  const creator = item.creator || 'Kyro Vault';
  const size = item.size || 'Vault Build';
  const resourceId = item.id_code || ('#' + Math.floor(100000 + Math.random() * 900000));
  const tier = item.tier || 'Free';

  const embed = {
    author: {
      name: item.author_tag || 'Kyro Vault',
      icon_url: item.author_icon || KYRO_ICON
    },
    title: (isUpdate ? '🔄 UPDATE: ' : '') + item.name.toUpperCase(),
    url: pageUrl,
    description: (item.details || `${item.name} is now available in the Kyro Vault. Free resources, plugins and presets for verified editors.`) +
      `\n\n**Website Link:** ${pageUrl}`,
    color: 0x1f232b,
    fields: [
      {
        name: 'Information',
        value: `• **Creator:** \`${creator}\`\n• **ID:** \`${resourceId}\`\n• **Size:** \`${size}\`\n• **Category:** \`${category}\`\n• **Platform:** \`${osLabel}\``,
        inline: true
      },
      {
        name: 'Membership',
        value: `• **Tier:** \`${tier}\`\n• **Status:** \`${isUpdate ? 'Updated' : 'Verified'}\``,
        inline: true
      }
    ],
    footer: {
      text: 'Kyro™ Website | Resource Monitor',
      icon_url: KYRO_ICON
    },
    timestamp: new Date().toISOString()
  };

  if (item.image_url && /^https?:\/\//.test(item.image_url)) {
    embed.image = { url: item.image_url };
  }

  const components = [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 5,
          label: 'View Resource ↗',
          url: pageUrl
        },
        {
          type: 2,
          style: 5,
          label: 'Browse Vault ↗',
          url: 'https://kyro.new.tg'
        }
      ]
    }
  ];

  return { embed, components };
}

/**
 * Publishes an upload across announcements, download links, and showcase forum
 */
async function publishUpload(item) {
  const published = loadPublished();
  const slug = item.slug.toLowerCase().trim().replace(/^\/+|\/+$/g, '');
  const os = (item.os || 'windows').toLowerCase();
  const isUpdate = Boolean(published[slug]);
  const pageUrl = `https://kyro.new.tg/${os}/${slug}/`;

  console.log(`[Auto-Publisher] Kyro format dispatch: ${item.name} (${isUpdate ? 'UPDATE' : 'NEW'}) -> ${pageUrl}`);

  const results = {
    announcements: false,
    downloads_links: false,
    showcase: false,
    isUpdate,
    pageUrl
  };

  const { embed, components } = buildKyroCard(item, isUpdate, pageUrl);

  // 1. Post to #announcements
  try {
    await discordFetch(`/channels/${CHANNELS.announcements}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        content: isUpdate ? `📢 **Vault Update Alert** — <@&1542127783440818226>` : `🚀 **New Vault Resource Released** — <@&1542127783440818226>`,
        embeds: [embed],
        components
      })
    });
    results.announcements = true;
  } catch (err) {
    console.error('Failed to post announcement:', err.message);
  }

  // 2. Post to #downloads-links
  try {
    await discordFetch(`/channels/${CHANNELS.downloads_links}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        embeds: [embed],
        components
      })
    });
    results.downloads_links = true;
  } catch (err) {
    console.error('Failed to post download link:', err.message);
  }

  // 3. Showcase Forum Post
  if (isUpdate && published[slug]?.thread_id) {
    try {
      await discordFetch(`/channels/${published[slug].thread_id}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          content: `🔄 **New Update Released** for **${item.name}**!`,
          embeds: [embed],
          components
        })
      });
      results.showcase = true;
    } catch (thErr) {
      console.warn('Existing thread reply failed, creating new forum post:', thErr.message);
      results.showcase = false;
    }
  }

  if (!results.showcase) {
    try {
      const threadRes = await discordFetch(`/channels/${CHANNELS.showcase_forum}/threads`, {
        method: 'POST',
        body: JSON.stringify({
          name: (isUpdate ? '[UPDATE] ' : '') + item.name,
          applied_tags: [SHOWCASE_TAG_SOFTWARE],
          message: {
            embeds: [embed],
            components
          }
        })
      });
      if (threadRes && threadRes.id) {
        published[slug] = {
          name: item.name,
          slug,
          os,
          thread_id: threadRes.id,
          last_updated: new Date().toISOString(),
          version: item.version || '1.0'
        };
        savePublished(published);
        results.showcase = true;
      }
    } catch (fErr) {
      console.error('Failed to create showcase forum thread:', fErr.message);
    }
  } else if (isUpdate) {
    published[slug].last_updated = new Date().toISOString();
    published[slug].version = item.version || published[slug].version;
    savePublished(published);
  }

  return results;
}

// Function to open browser on localhost
function openLocalDashboard() {
  const url = `http://localhost:${PORT}`;
  const startCmd = process.platform === 'win32' ? `start ${url}` : process.platform === 'darwin' ? `open ${url}` : `xdg-open ${url}`;
  exec(startCmd, (err) => {
    if (err) console.error('Failed to auto-open browser:', err);
    else console.log(`[Dashboard] Opened browser to ${url}`);
  });
}

// Dashboard HTML interface
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Kyro Staff Bot — Owner Command Center</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap">
  <style>
    :root {
      --bg: #0b0d13;
      --card: rgba(255,255,255,0.035);
      --border: rgba(255,255,255,0.08);
      --accent: #5865f2;
      --text: #f8fafc;
      --dim: #94a3b8;
      --green: #10b981;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: 'Plus Jakarta Sans', -apple-system, sans-serif;
      padding: 40px 20px;
      display: flex;
      justify-content: center;
    }
    .container {
      width: 100%;
      max-width: 860px;
      display: flex;
      flex-direction: column;
      gap: 24px;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--border);
    }
    .title { font-size: 1.5rem; font-weight: 700; letter-spacing: -0.02em; }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: rgba(16,185,129,0.12);
      border: 1px solid rgba(16,185,129,0.3);
      color: var(--green);
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 0.75rem;
      font-weight: 600;
      font-family: 'JetBrains Mono', monospace;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 24px;
      backdrop-filter: blur(20px);
    }
    .card-title {
      font-size: 1.15rem;
      font-weight: 600;
      margin-bottom: 6px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .card-desc {
      font-size: 0.88rem;
      color: var(--dim);
      margin-bottom: 20px;
      line-height: 1.5;
    }
    .form-group {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-bottom: 16px;
    }
    label { font-size: 0.85rem; font-weight: 600; color: #cbd5e1; }
    input, textarea, select {
      background: rgba(255,255,255,0.05);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 10px 14px;
      color: #fff;
      font-family: inherit;
      font-size: 0.9rem;
      outline: none;
      transition: border 0.15s;
    }
    input:focus, textarea:focus, select:focus {
      border-color: var(--accent);
    }
    .btn {
      background: var(--accent);
      color: #fff;
      border: none;
      padding: 12px 20px;
      border-radius: 10px;
      font-weight: 600;
      font-size: 0.92rem;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
    }
    .btn:hover { opacity: 0.92; }
    .grid-2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
    }
    .grid-3 {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 16px;
    }
    .status-msg {
      padding: 12px 16px;
      border-radius: 10px;
      font-size: 0.88rem;
      display: none;
      margin-top: 14px;
    }
    .status-msg.success {
      background: rgba(16,185,129,0.12);
      border: 1px solid rgba(16,185,129,0.3);
      color: #34d399;
    }
    .status-msg.error {
      background: rgba(239,68,68,0.12);
      border: 1px solid rgba(239,68,68,0.3);
      color: #f87171;
    }
    /* Kyro preview card */
    .preview-box {
      background: #1f232b;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 12px;
      padding: 18px;
      margin-top: 20px;
      color: #fff;
    }
    .preview-author { display: flex; align-items: center; gap: 8px; font-size: 0.82rem; color: #cbd5e1; margin-bottom: 8px; }
    .preview-title { font-size: 1.1rem; font-weight: 700; color: #38bdf8; margin-bottom: 8px; }
    .preview-desc { font-size: 0.85rem; color: #cbd5e1; line-height: 1.5; margin-bottom: 12px; }
    .preview-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; background: rgba(0,0,0,0.25); padding: 12px; border-radius: 8px; font-size: 0.8rem; margin-bottom: 14px; }
    .preview-buttons { display: flex; gap: 10px; }
    .preview-btn {
      background: #2b313e;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 6px;
      padding: 8px 16px;
      font-size: 0.82rem;
      font-weight: 600;
      color: #fff;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div>
        <h1 class="title">Kyro Staff Bot · Resource Publisher &amp; Bot Controls</h1>
        <p style="color:var(--dim);font-size:0.85rem;margin-top:4px;">Localhost Interface (Triggered by <code>/start-kyro</code>)</p>
      </div>
      <span class="badge">● LOCALHOST ONLINE</span>
    </div>

    <div class="card">
      <div class="card-title">✨ Publish Kyro Vault Announcement</div>
      <p class="card-desc">Publishes rich resource cards across <b>#announcements</b>, <b>#downloads-links</b>, and <b>#showcase</b> forum. Automatically detects if the resource is an <b>UPDATE</b> and routes downloads to the website page (<code>https://kyro.new.tg/windows/slug/</code>).</p>
      
      <form id="uploadForm">
        <div class="grid-2">
          <div class="form-group">
            <label>Resource Title</label>
            <input type="text" id="name" placeholder="e.g. Qwix Plugin or 2000SLEGEND EDIT PACK" required>
          </div>
          <div class="form-group">
            <label>Website Slug</label>
            <input type="text" id="slug" placeholder="e.g. qwix-plugin" required>
          </div>
        </div>

        <div class="grid-3">
          <div class="form-group">
            <label>Platform / OS</label>
            <select id="os">
              <option value="windows">Windows</option>
              <option value="macos">macOS</option>
              <option value="both">Windows & macOS</option>
            </select>
          </div>
          <div class="form-group">
            <label>Creator / Author</label>
            <input type="text" id="creator" placeholder="e.g. packsffx">
          </div>
          <div class="form-group">
            <label>Size</label>
            <input type="text" id="size" placeholder="e.g. 1.49 MB">
          </div>
        </div>

        <div class="grid-2">
          <div class="form-group">
            <label>Category</label>
            <input type="text" id="category" placeholder="e.g. Adobe After Effects">
          </div>
          <div class="form-group">
            <label>Membership Tier</label>
            <input type="text" id="tier" value="Free">
          </div>
        </div>

        <div class="form-group">
          <label>Poster / Banner Image URL</label>
          <input type="url" id="image_url" placeholder="https://... (screenshot / artwork)">
        </div>

        <div class="form-group">
          <label>Description / Effects Included</label>
          <textarea id="details" rows="3" placeholder="Features, effects, changelog or presets included..."></textarea>
        </div>

        <button type="submit" class="btn" id="btnPublish">🚀 Publish Kyro Announcement &amp; Forum Post</button>
        <div id="publishStatus" class="status-msg"></div>
      </form>
    </div>

    <!-- Live Preview Card -->
    <div class="card">
      <div class="card-title">👁️ Kyro Live Preview</div>
      <div class="preview-box">
        <div class="preview-author"><img src="${KYRO_ICON}" width="16" height="16" style="border-radius:50%;"> Anonymous / Kyro Vault</div>
        <div class="preview-title" id="prevTitle">QWIX PLUGIN</div>
        <div class="preview-desc" id="prevDesc">Effects, transitions, presets and overlays included for editors...</div>
        <div class="preview-fields">
          <div>
            <strong>Information</strong><br>
            • Creator: <span id="prevCreator">packsffx</span><br>
            • ID: <span id="prevId">#198099</span><br>
            • Size: <span id="prevSize">1.49 MB</span><br>
            • Category: <span id="prevCat">Adobe After Effects</span>
          </div>
          <div>
            <strong>Membership</strong><br>
            • Tier: <span id="prevTier">Free</span><br>
            • Access: <span id="prevAccess">Kyro Vault</span>
          </div>
        </div>
        <div class="preview-buttons">
          <div class="preview-btn">View Resource ↗</div>
          <div class="preview-btn">Find Resources ↗</div>
        </div>
      </div>
    </div>
  </div>

  <script>
    const form = document.getElementById('uploadForm');
    const statusMsg = document.getElementById('publishStatus');
    const btnPublish = document.getElementById('btnPublish');

    // Update live preview
    const updatePreview = () => {
      document.getElementById('prevTitle').textContent = (document.getElementById('name').value.trim() || 'QWIX PLUGIN').toUpperCase();
      document.getElementById('prevDesc').textContent = document.getElementById('details').value.trim() || 'Effects, transitions, presets and overlays included for editors...';
      document.getElementById('prevCreator').textContent = document.getElementById('creator').value.trim() || 'packsffx';
      document.getElementById('prevSize').textContent = document.getElementById('size').value.trim() || '1.49 MB';
      document.getElementById('prevCat').textContent = document.getElementById('category').value.trim() || 'Adobe After Effects';
      document.getElementById('prevTier').textContent = document.getElementById('tier').value.trim() || 'Free';
    };

    ['name', 'details', 'creator', 'size', 'category', 'tier'].forEach(id => {
      document.getElementById(id).addEventListener('input', updatePreview);
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      btnPublish.disabled = true;
      btnPublish.textContent = 'Publishing…';
      statusMsg.style.display = 'none';

      const payload = {
        name: document.getElementById('name').value.trim(),
        slug: document.getElementById('slug').value.trim(),
        os: document.getElementById('os').value,
        creator: document.getElementById('creator').value.trim(),
        size: document.getElementById('size').value.trim(),
        category: document.getElementById('category').value.trim(),
        tier: document.getElementById('tier').value.trim(),
        image_url: document.getElementById('image_url').value.trim(),
        details: document.getElementById('details').value.trim()
      };

      try {
        const res = await fetch('/api/publish', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (res.ok) {
          statusMsg.className = 'status-msg success';
          statusMsg.textContent = '✅ ' + (data.isUpdate ? 'Update' : 'New upload') + ' successfully published with Kyro branding to #announcements, #downloads-links, and #showcase forum! Website link: ' + data.pageUrl;
          statusMsg.style.display = 'block';
        } else {
          statusMsg.className = 'status-msg error';
          statusMsg.textContent = '❌ Failed: ' + (data.error || 'Server error');
          statusMsg.style.display = 'block';
        }
      } catch (err) {
        statusMsg.className = 'status-msg error';
        statusMsg.textContent = '❌ Error: ' + err.message;
        statusMsg.style.display = 'block';
      } finally {
        btnPublish.disabled = false;
        btnPublish.textContent = '🚀 Publish Kyro Announcement & Forum Post';
      }
    });
  </script>
</body>
</html>
`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(DASHBOARD_HTML);
    return;
  }

  // Triggered by /start-kyro in Discord
  if (req.method === 'POST' && url.pathname === '/api/launch') {
    openLocalDashboard();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/publish') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const item = JSON.parse(body);
        if (!item.name || !item.slug) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Name and slug are required.' }));
          return;
        }
        const outcome = await publishUpload(item);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(outcome));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`=======================================================`);
  console.log(`🚀 Kyro Staff Bot Local Dashboard running on:`);
  console.log(`👉 http://localhost:${PORT}`);
  console.log(`Command /start-kyro in Discord will trigger auto-open!`);
  console.log(`=======================================================`);
});
