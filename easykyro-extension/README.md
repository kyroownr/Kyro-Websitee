# EasyKyro

A Chrome extension that files Kyro requests from any website.

Type a title. EasyKyro reads the page you are on, uses your own free Google AI
key to write the description and infer the category, OS and After Effects
versions, then posts the request through the **same Kyro worker** the website
uses. The request lands on the requests board and in the Discord requests
channel exactly like a website submission, marked **priority** so it is never
mistaken for a manual entry.

---

## What it does

- **Works on any page** (`http` / `https`). It reads the title, meta
  description, first heading, your text selection and a short body excerpt.
- **AI fill with your own key.** Add a free key from
  <https://aistudio.google.com/api-keys>. It is verified the moment you paste
  it, saved automatically and the settings panel closes itself. There is no
  model picker: EasyKyro asks Google which models the key can use and picks the
  cheapest one (a `…-flash-lite` model, newest first). The key is stored only
  in this browser and is sent only to Google's Gemini API.
- **Discord login, same as the website.** No second Discord app: a content
  script on `kyro.new.tg` picks up the session the site already created.
- **Same request pipeline.** `POST https://kyro-auth.kyro-ownr.workers.dev/requests`
  with the same fields the website sends, so the Durable Object stores it and
  the `DISCORD_REQUESTS_WEBHOOK_URL` notification fires.
- **Priority, not a manual entry.** Every submission carries `source: 'easykyro'`.
  The worker stores it as `priority`, the board shows a `⚡ PRIORITY` chip and
  lists those requests first, and the Discord request card says
  `⚡ PRIORITY · sent with EasyKyro` under **Requested By**.
- **Fine-tune details.** The AI fills category, OS, AE versions, reference and
  description — the same five fields the website form asks for — and
  **Fine-tune details** opens them as editable chips and inputs. Anything you
  edit by hand is never overwritten by the next AI pass.
- **Duplicate check like the website.** While you type, EasyKyro compares your
  title with your requests on the board and offers **Upvote instead** when one
  already covers it, so fewer submissions hit the worker's 409.
- **Website theme, dark only.** Same obsidian background, frosted cards, blue
  accent and mono labels as `kyro.new.tg`. There is no light theme.
- **Right-click anywhere.** *Send this page to EasyKyro*, *Request this link
  in EasyKyro* and *Request "…" in EasyKyro* on a selection all open the popup
  with that page, link and selected text already loaded.
- **Keyboard shortcut.** `Alt+Shift+K` (`Ctrl+Shift+K` on macOS) opens the
  popup on the page you are on.
- **Drafts survive.** The title and the generated details are kept for the page
  you are on, so closing the popup does not lose the request. It tells you when
  you are offline instead of failing on submit.

## Install for development (load unpacked)

Requires Chrome 127 or newer (the right-click menu opens the popup
programmatically).

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked**.
4. Select this `easykyro-extension` folder.
5. Pin **EasyKyro** to the toolbar.

Reload the extension from `chrome://extensions` after changing any file.

## First run

1. Click the EasyKyro icon on any normal website. If you are already signed in
   on `kyro.new.tg`, the popup shows **Connected as @you** on its own.
2. Otherwise press **Connect Discord**. A Kyro tab opens — sign in with Discord
   there (the normal website login), then reopen EasyKyro. The extension reads
   the session the website stored, in any open Kyro tab.
3. Open the gear and paste your **Google AI key** from
   <https://aistudio.google.com/api-keys>. It is checked immediately; once it is
   verified the panel closes and the key is saved — there is no Save button and
   no model to choose.
4. Type a title. The **Request details** card fills itself with the category,
   OS, AE version and description written from the page. Press **Generate** to
   redo it, then **Submit Request**.

Requests require membership of the Kyro Discord server, because the worker
checks `requireMember()` before writing. If you are not in the server yet, the
extension shows **Join server** and a recheck button.

## How the request reaches Discord

```
EasyKyro popup
  └─ POST /requests { token, title, category, os, ae_versions, reference, desc,
                      source: 'easykyro' }
       └─ worker.js → KyroRequests Durable Object (SQLite)
            ├─ board row (visible on kyro.new.tg)
            └─ alarm → DISCORD_REQUESTS_WEBHOOK_URL → #requests channel
```

The path is the website's existing endpoint and webhook, and the extension
authenticates with the Discord access token the website already issued. The
`priority` flag is read from the request body, so `worker.js` must be deployed
(`npm run deploy`) for the chip, the ordering and the Discord line to appear;
until then the request is saved exactly as before.

## Publish to the Chrome Web Store

1. **Build the upload zip**

   ```powershell
   powershell -ExecutionPolicy Bypass -File tools/package-extension.ps1
   ```

   This writes `..\easykyro-extension.zip` containing only the shipped files
   (`manifest.json`, popup, background, content script, icons). The preview
   harness and build scripts are excluded.

2. **Developer account**

   - Go to <https://chrome.google.com/webstore/devconsole>.
   - Register as a Chrome Web Store developer (one-time US$5 fee).
   - Accept the developer agreement.

3. **Create the item**

   - **New item** → upload `easykyro-extension.zip`.
   - Fill the store listing (name, summary, description, category, language).
   - Upload at least one screenshot at **1280×800** or **640×400**. Take it by
     opening the popup and using the OS screenshot tool, or resize a capture.
   - Upload the 128×128 icon from `icons/icon128.png`.

4. **Privacy tab**

   - Single purpose: *file Kyro requests from any website*.
   - Justify each permission:
     - `storage` — keep the Discord token, AI key and draft locally.
     - `activeTab` — read the current page only after the user clicks the icon.
     - `scripting` — extract title/meta/selection from that tab.
     - `contextMenus` — add the right-click entries that open the popup for the
       current page, a link or a selection.
     - Host `kyro-auth.kyro-ownr.workers.dev` — submit requests and verify login.
     - Host `kyro.new.tg` — pick up the website's Discord session.
     - Host `generativelanguage.googleapis.com` — call Gemini with the user's key.
   - Data usage: the extension does not sell data, does not use analytics, and
     does not send the AI key anywhere except Google's API. Paste the same text
     as `PRIVACY.md`.
   - Remote code: **No** (all code ships in the package).

5. **Submit for review.** First reviews usually take a few days.

6. **After the store assigns your extension ID** (shown on the item page), if
   you ever see a CORS error in the popup console, add that origin to the
   worker and redeploy:

   ```text
   KYRO_ALLOWED_ORIGINS=https://kyro.new.tg,chrome-extension://<your-extension-id>
   npx wrangler deploy
   ```

   In practice this is not needed: the manifest's `host_permissions` let an
   extension page read cross-origin responses without CORS.

## Security notes

- The Discord token and Gemini key live in `chrome.storage.local`, not in
  `storage.sync`, so they never leave this browser profile.
- The content script only runs on `https://kyro.new.tg/*` and only forwards the
  token the site already stored. It never reads cookies.
- The extension sends no analytics and has no remote code.
- Requests are still validated by the worker (title length, category enum, OS
  enum, AE versions, HTTP(S)-only reference, 280-character description).

## Files

```
easykyro-extension/
├─ manifest.json          MV3 manifest
├─ background.js          Discord hand-off + token verification
├─ popup.html/css/js      the request form
├─ content/kyro-auth.js   reads the website session on kyro.new.tg
├─ icons/                 16/32/48/128 px
├─ popup.preview.html     local UI harness (dev only, not shipped)
├─ preview-mock.js        fake chrome.* + fetch for that harness (not shipped)
├─ tools/make-icons.ps1   regenerate the icons
├─ tools/package-extension.ps1
├─ PRIVACY.md
└─ store/listing.md       copy for the store listing
```

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "Connect Discord" does nothing | Allow pop-ups for `kyro.new.tg`; the login opens in a tab. |
| Connected but requests 403 `not_a_member` | Join the Kyro Discord, then press **Recheck**. |
| Signed in on the website but the extension says "Not connected" | Keep a `kyro.new.tg` tab open (even in the background) and reopen the popup. The extension can only read the session from an open site tab. |
| "That Google AI key was rejected" | Re-copy the key from AI Studio; keys start with `AIza`. |
| "quota is used up" | Free Gemini limits reset daily. Try later or use another key. |
| Page says "protected" | `chrome://`, the Web Store and PDF viewers cannot be scripted. Right-click a link on the page and choose **Request this link in EasyKyro**, or fill the form manually. |
| Right-click menu opens nothing | Chrome 126 and older cannot open a popup from a menu click. Open the toolbar icon — the page, link and selection you right-clicked are still loaded. |
| 409 duplicate | The worker rejects duplicate titles. EasyKyro offers **Upvote instead** above the form when it spots one of yours; otherwise upvote it on the board. |
| Requests do not appear in Discord | The worker's `DISCORD_REQUESTS_WEBHOOK_URL` secret is missing; the board still updates. |
