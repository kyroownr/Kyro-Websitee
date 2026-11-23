# EasyKyro privacy policy

_Last updated: 21 November 2026_

EasyKyro is a Chrome extension that files feature requests for the Kyro
community from any website.

## What EasyKyro stores

Stored locally in your browser (`chrome.storage.local`), never on a Kyro
server unless you submit a request:

- **Discord session token** — the access token the Kyro website already issued
  when you signed in with Discord. It is used to authenticate your request and
  to check that you are a member of the Kyro Discord server.
- **Google AI (Gemini) API key** — the key you create yourself at
  <https://aistudio.google.com/api-keys>. It is used only to generate request
  text.
- **Draft request fields** — title, category, OS, After Effects versions,
  reference link and description, so the form survives closing the popup.
- **Your Discord profile** — username, user id, avatar and membership flag, as
  returned by the Kyro auth worker.

## What EasyKyro reads

When you open the popup, it reads the active tab **only after you click the
extension icon**: the page URL, title, meta description, first heading, any text
you have selected, and a short excerpt of the page text. This context is used to
fill the request. It is sent to Google's Gemini API only when you press
**Generate with AI** (or leave auto-generate enabled).

The content script runs only on `https://kyro.new.tg/*` and only reads the
`kyro.auth.v1` entry the website itself stored, so the extension can reuse the
website login. It does not read cookies.

## What EasyKyro sends, and to whom

- **Google Gemini API** (`generativelanguage.googleapis.com`) — the page
  context described above, plus your Gemini API key, to generate the request
  text.
- **Kyro auth worker** (`kyro-auth.kyro-ownr.workers.dev`) — your Discord token
  and the request fields you submit, exactly like a request submitted on
  `kyro.new.tg`.
- **Kyro Discord** — the request itself is posted to the Kyro requests channel
  through the same webhook the website uses. It includes your Discord username,
  the request title, category, OS, After Effects versions, reference link and
  description.

No analytics, advertising, tracking pixels or third-party telemetry. No data is
sold.

## Retention and deletion

- Local data stays until you remove it. **Disconnect** in the popup deletes the
  stored Discord session. Clearing the extension's storage or uninstalling
  EasyKyro removes everything else.
- Submitted requests live on the Kyro requests board and in the Kyro Discord,
  the same as website submissions. Ask in the Kyro Discord to have one removed.

## Permissions

- `storage` — save the token, key and draft locally.
- `activeTab` — read the current tab only when you click the icon.
- `scripting` — extract the page context from that tab.
- `contextMenus` — add the right-click entries that open the popup for the
  current page, a link or a selection. The same page context rules apply.
- Host permissions for the Kyro worker, `kyro.new.tg` and Google's Gemini API —
  the three services described above.

## Contact

Questions or removal requests: open a ticket in the Kyro Discord
(<https://discord.gg/5ch7XeNg98>) or contact the owner through
<https://kyro.new.tg>.
