# Chrome Web Store listing — EasyKyro

## Name
EasyKyro

## Summary (132 characters max)
Request After Effects assets from any website. Type a title, AI writes the rest, and it posts to the Kyro requests board.

## Detailed description
EasyKyro turns "I wish the vault had this" into a filed request in seconds.

Open the popup on any website and type a title. EasyKyro reads the page you are
on and uses your own free Google AI key to write a short description and infer
the category, OS and After Effects versions. Prefer a different take? Press
Generate again. Submit and the request goes through the exact same Kyro pipeline
as the website: it appears on the requests board and in the Kyro Discord
requests channel.

WHY EASYKYRO
• Works on any website — product pages, store listings, tutorials, videos.
• AI fill with your own free Gemini key from aistudio.google.com/api-keys —
  checked the moment you paste it, no model to pick.
• Discord sign-in reuses the Kyro website session. No second account.
• Same dark theme as kyro.new.tg.
• Right-click any page, link or selected text to start the request, or press
  Alt+Shift+K.
• Priority submissions: requests filed from EasyKyro are flagged PRIORITY on the
  board and in the Discord requests card, so they are never manual entries.
• The same five fields the website asks for (category, OS, AE versions,
  reference, description) stay editable under "Fine-tune details".
• Duplicate check: if you already requested the same thing, it offers an upvote.
• Nothing to configure on the server: it uses the existing Kyro requests API.

HOW IT WORKS
1. Connect Discord (the Kyro website opens once; the extension picks up the
   session you already created).
2. Paste your free Google AI key in Settings — it verifies itself and saves.
3. Type a title. The request details are written from the page; review, submit.
4. The request is stored on the Kyro requests board and announced in Discord.

PRIVACY
Your Discord token and Gemini key stay in this browser. The key is sent only to
Google's Gemini API. The extension has no analytics and no remote code. Full
policy: see PRIVACY.md.

Requests require membership of the Kyro Discord server.

## Category
Productivity

## Language
English (United States)

## Screenshots
Upload at least one 1280×800 or 640×400 image showing the popup over a product
page, with the AI-filled description visible.

## Single purpose
File feature requests for the Kyro community from any website.

## Permission justifications
- storage: Keep the Discord token, Gemini API key and draft locally.
- storage (site tab read): the extension reads the session the Kyro website
  stored, only on kyro.new.tg.
- activeTab: Read the current page only after the user clicks the extension icon.
- scripting: Extract the title, meta description, heading and selection from the active tab.
- contextMenus: Add the right-click entries (page, link, selection) that open the
  popup with that context.
- https://kyro-auth.kyro-ownr.workers.dev/*: Verify the Discord session and submit requests to the Kyro API.
- https://kyro.new.tg/*: Read the Discord session the website stored so the extension can reuse the website login.
- https://generativelanguage.googleapis.com/*: Call the Gemini API with the user's own API key.

## Remote code
No. All JavaScript ships inside the extension package. The extension calls
Google's Gemini REST API and the Kyro requests API, but it does not load or
execute remote code.

## Data usage disclosures
- Authentication information: yes (Discord access token).
- Personal communications: no.
- Website content: yes (page title/meta/excerpt, only when the popup is used).
- User activity: no.
- Location: no.
- Financial info: no.
- Health info: no.
- Sold to third parties: no.
- Used for purposes unrelated to the single purpose: no.
- Used to determine creditworthiness: no.

## Support / homepage
https://kyro.new.tg
