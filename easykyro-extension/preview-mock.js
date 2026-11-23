/* Local preview harness only — never shipped to the Chrome Web Store.
 * Loads popup.html with a fake chrome.* API, a fake page, and fake fetch
 * responses so the UI can be checked without loading the extension.
 */
(() => {
  const info = {
    url: 'https://motionbae.com/products/ae-plugin-pack',
    title: 'MotionBae AE Plugin Pack — 12 transitions',
    host: 'motionbae.com',
    description: 'A pack of 12 GPU-accelerated transitions for After Effects 2025.',
    ogTitle: '',
    h1: 'AE Plugin Pack',
    selection: '',
    body: 'Twelve drag-and-drop transitions for After Effects 2025 and 2024. Windows and macOS. Works in the Essential Graphics panel.',
    favicon: '',
    lang: 'en'
  };

  const auth = { token: 'mock-token', user: { id: '1', username: 'quiff', inServer: true, role: 'Owner' } };

  const store = {
    settings: { geminiKey: '', model: '' }
  };

  window.chrome = {
    storage: {
      local: {
        get: async (keys) => {
          const out = {};
          (Array.isArray(keys) ? keys : [keys]).forEach((key) => { if (key in store) out[key] = store[key]; });
          return out;
        },
        set: async (obj) => { Object.assign(store, obj); },
        remove: async (key) => { delete store[key]; }
      }
    },
    tabs: {
      query: async () => [{ id: 1, url: info.url, title: info.title }],
      create: async () => ({ id: 2 })
    },
    scripting: { executeScript: async () => [{ result: info }] },
    runtime: {
      sendMessage: async (message) => {
        if (message && message.type === 'EASYKYRO_SYNC') return { ok: true, auth };
        return { ok: true };
      },
      onMessage: { addListener: () => {} }
    }
  };

  const ai = {
    title: 'MotionBae AE Plugin Pack',
    category: 'extension',
    os: 'both',
    ae_versions: ['2024', '2025'],
    reference: info.url,
    description: 'Add the MotionBae transitions pack to the vault. It has 12 GPU-accelerated drag-and-drop transitions for AE 2024 and 2025 that would speed up quick cuts and title work.'
  };

  /* A member's own request, so the similar-request card has something to match. */
  const board = {
    requests: [{
      id: 'mock-existing', title: 'MotionBae AE Plugin Pack', category: 'extension', os: 'both',
      ae_versions: ['2025'], reference: info.url, desc: 'Already on the board.',
      status: 'open', created: '2026-11-01T00:00:00.000Z', votes: 4, you_voted: false, priority: false
    }]
  };

  const models = {
    models: [
      { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-2.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-2.0-flash-lite', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] }
    ]
  };

  window.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.includes('generativelanguage.googleapis.com')) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      if (target.includes('/models?')) {
        return new Response(JSON.stringify(models), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify(ai) }] } }]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (target.endsWith('/verify')) {
      return new Response(JSON.stringify({
        in_server: true, is_owner: true, username: 'quiff', id: '1', avatar: '', role: 'Owner'
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (target.endsWith('/requests/vote')) {
      board.requests[0].votes = 5;
      board.requests[0].you_voted = true;
      return new Response(JSON.stringify({ requests: board.requests }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    }
    if (target.endsWith('/requests')) {
      if ((options.method || 'GET').toUpperCase() === 'GET') {
        return new Response(JSON.stringify({ requests: board.requests }), {
          status: 200, headers: { 'content-type': 'application/json' }
        });
      }
      return new Response(JSON.stringify({
        id: 'mock-request', notification: 'queued',
        requests: board.requests.concat([{
          id: 'mock-request', title: ai.title, priority: true, votes: 1, you_voted: true
        }])
      }), { status: 201, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 404 });
  };
})();
