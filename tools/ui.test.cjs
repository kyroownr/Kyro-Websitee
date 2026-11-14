const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const root = path.join(__dirname, '..');
const artifacts = path.join(root, '.wrangler', 'ui-check');
fs.mkdirSync(artifacts, { recursive: true });

async function main() {
  const { applicationConfiguration } = await import(pathToFileURL(path.join(root, 'applications-worker.js')));
  const applicationConfig = applicationConfiguration({ KYRO_GUILD_ID: '1539961184323772498', DISCORD_BOT_TOKEN: 'dummy', DISCORD_APPLICATIONS_CATEGORY_ID: '1539961184323772499', DISCORD_MOD_ROLE_ID: '1539961184323772500', DISCORD_PUBLIC_KEY: '0'.repeat(64), KYRO_APPLICATIONS: {} });
  const chrome = spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless=new', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=' + path.join(artifacts, 'chrome-' + process.pid), 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let ws;
  try {
    const address = await new Promise((resolve, reject) => {
      let stderr = '';
      const timeout = setTimeout(() => reject(new Error('Chrome startup timed out')), 15000);
      chrome.on('error', reject);
      chrome.stderr.on('data', chunk => {
        stderr += chunk;
        const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
        if (match) { clearTimeout(timeout); resolve(match[1]); }
      });
    });
    ws = new WebSocket(address);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
    let id = 0;
    let sessionId;
    const pending = new Map();
    const events = new Map();
    const browserErrors = [];
    ws.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.exceptionThrown') browserErrors.push(message.params.exceptionDetails);
      if (message.id) {
        const waiter = pending.get(message.id);
        if (waiter) { pending.delete(message.id); message.error ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve(message.result); }
      } else if (events.has(message.method)) {
        const resolve = events.get(message.method);
        events.delete(message.method);
        resolve(message.params);
      }
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const requestId = ++id;
      pending.set(requestId, { resolve, reject });
      ws.send(JSON.stringify({ id: requestId, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    const target = await send('Target.createTarget', { url: 'about:blank' });
    sessionId = (await send('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
    await send('Page.enable');
    await send('Runtime.enable');
    const evaluate = async expression => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `
      const parameters = new URLSearchParams(location.search);
      const role = parameters.get('uiAuth') || 'member';
      if (role === 'out') localStorage.removeItem('kyro.auth.v1');
      else localStorage.setItem('kyro.auth.v1', JSON.stringify({state:role === 'logged' ? 'logged' : 'verified',user:{id:role === 'logged' ? 'outsider' : role,username:role + '-editor',initials:'E'},token:role === 'logged' || role === 'departed' ? 'outsider' : role,is_owner:role === 'forged',role:role === 'forged' ? 'owner' : 'member'}));
      const nativeFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const raw = typeof input === 'string' ? input : input.url;
        if (raw.startsWith('https://kyro-auth.kyro-ownr.workers.dev')) {
          const url = new URL(raw);
          if (url.pathname.startsWith('/applications')) {
            const config = ${JSON.stringify(applicationConfig)};
            const fixtureCase = parameters.get('applicationCase');
            const records = JSON.parse(sessionStorage.getItem('ui.applications') || '[]');
            if (url.pathname === '/applications/config') return Promise.resolve(Response.json({ ...config, open: fixtureCase !== 'closed' }));
            if (role === 'logged') return Promise.resolve(Response.json({ error: 'Join the server.' }, { status: 403 }));
            if (fixtureCase === 'expired') return Promise.resolve(Response.json({ error: 'Session expired.' }, { status: 401 }));
            if (url.pathname === '/applications/status') return Promise.resolve(Response.json({ application: records.find(row => row.id === url.searchParams.get('id')) }));
            if (init?.method === 'POST') {
              window.__applicationPosts = (window.__applicationPosts || 0) + 1;
              const payload = JSON.parse(init.body);
              window.__applicationPayload = payload;
              if (fixtureCase === 'failed') return Promise.resolve(Response.json({ error: 'Please retry.' }, { status: 503 }));
              const application = { id: crypto.randomUUID(), role: payload.role, status: 'pending', created: new Date().toISOString() };
              records.push(application); sessionStorage.setItem('ui.applications', JSON.stringify(records));
              return new Promise(resolve => setTimeout(() => resolve(Response.json({ application }, { status: 201 })), 100));
            }
            const result = Response.json({ profile: { id: '1142933516332437504', username: 'verified-editor', tag: 'verified-editor', account_created: fixtureCase === 'new' ? new Date().toISOString() : '2023-08-21T00:00:00.000Z' }, applications: records });
            if (fixtureCase === 'slow') return new Promise(resolve => { window.__releaseApplication = () => resolve(result); });
            return Promise.resolve(result);
          }
          return nativeFetch('http://127.0.0.1:8787' + url.pathname + url.search, init);
        }
        if (raw.startsWith('https://discord.com/api/v9/invites/')) return Promise.resolve(Response.json({}));
        return nativeFetch(input, init);
      };
      Object.defineProperty(navigator, 'clipboard', {configurable:true,value:{writeText:async value=>{window.__copied=value;}}});
      if (parameters.has('checksumFixture') || parameters.has('emptySoftwareFixture') || parameters.has('emptyToolsFixture')) {
        let seed;
        Object.defineProperty(window, 'KYRO_SEED', {configurable:true,get:()=>seed,set:value=>{
          if (parameters.has('checksumFixture')) value.find(row=>row.id === 'after-effects-windows-v27').sha256 = parameters.get('checksumFixture') === 'valid' ? 'A'.repeat(64) : '<invalid>';
          seed = value.filter(row => !(parameters.has('emptySoftwareFixture') && row.kind === 'software') && !(parameters.has('emptyToolsFixture') && row.kind === 'tool'));
        }});
      }
    ` });
    const navigate = async route => {
      const loaded = new Promise(resolve => events.set('Page.loadEventFired', resolve));
      await send('Page.navigate', { url: 'http://localhost:4173' + route });
      await loaded;
    };
    const screenshot = async filename => {
      await evaluate("Promise.all(document.getAnimations().filter(animation=>animation.playState === 'running' && animation.effect.target.checkVisibility() && animation.effect.getComputedTiming().iterations !== Infinity).map(animation=>animation.finished.catch(()=>{})))");
      const capture = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(path.join(artifacts, filename), Buffer.from(capture.data, 'base64'));
    };
    const waitExpression = `async predicate => { const deadline=Date.now()+8000; while(!predicate()){ if(Date.now()>deadline)throw new Error('UI timeout'); await new Promise(resolve=>setTimeout(resolve,25)); } }`;
    const toggleSoftware = async () => {
      const point = await evaluate("(()=>{const header=document.querySelector('.software-toggle');header.scrollIntoView({block:'center',behavior:'instant'});const rect=header.getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};})()");
      await send('Input.dispatchMouseEvent', {type:'mousePressed',button:'left',clickCount:1,...point});
      await send('Input.dispatchMouseEvent', {type:'mouseReleased',button:'left',clickCount:1,...point});
    };
    const expandSoftware = async () => {
      if (!await evaluate("document.querySelector('#softwareSection').open")) await toggleSoftware();
      assert.equal(await evaluate("document.querySelector('#softwareSection').open && document.querySelector('#softwareGrid').checkVisibility()"), true);
    };
    const toggleTools = async () => {
      const point = await evaluate("(()=>{const header=document.querySelector('.tools-toggle');header.scrollIntoView({block:'center',behavior:'instant'});const rect=header.getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};})()");
      await send('Input.dispatchMouseEvent', {type:'mousePressed',button:'left',clickCount:1,...point});
      await send('Input.dispatchMouseEvent', {type:'mouseReleased',button:'left',clickCount:1,...point});
    };
    const openBoard = async () => evaluate(`(async()=>{ document.querySelector('#requestsOpen').click(); await (${waitExpression})(()=>document.querySelectorAll('.req-item').length>0); return document.querySelectorAll('.req-item').length; })()`);
    const applyErrors = browserErrors.length;
    const waitApply = async predicate => {
      try { await evaluate(`(${waitExpression})(()=>${predicate})`); }
      catch (error) { console.error(JSON.stringify({ predicate, state: await evaluate("({location:location.href,view:document.querySelector('#applyView')?.textContent,posts:window.__applicationPosts,valid:document.querySelector('#applicationForm')?.checkValidity()})"), browserErrors })); throw error; }
    };
    const fillApplication = async () => evaluate(`(()=>{const form=document.querySelector('#applicationForm');for(const input of form.elements){if(input.type==='checkbox')input.checked=true;else if(input.name==='age')input.value='20';else if(input.tagName==='TEXTAREA')input.value='I support editors calmly, verify original resources, and contribute consistently.';else if(input.name==='portfolio')input.value='https://example.com/portfolio';}return form.checkValidity()})()`);
    for (const width of [1366, 390, 320]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: width < 400 ? 844 : 900, deviceScaleFactor: 1, mobile: width < 400 });
      await navigate('/?uiAuth=out');
      await evaluate("document.querySelector('#applyOpen').scrollIntoView({block:'center',behavior:'instant'});document.querySelector('#applyOpen').click()");
      await waitApply("document.querySelector('#applicationsStatusText').textContent.startsWith('Applications are open!')");
      assert.equal(await evaluate("document.querySelector('#applicationsStatus').open && getComputedStyle(document.querySelector('#applicationsStatus')).backgroundColor === 'rgb(8, 9, 13)' && document.querySelector('#applicationsStatus').scrollWidth <= document.querySelector('#applicationsStatus').clientWidth"), true);
      assert.equal(await evaluate("document.querySelector('#applicationsStatus a').getAttribute('href')"), '/apply');
      await screenshot('applications-modal-' + width + '.png');
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      assert.equal(await evaluate("document.querySelector('#applicationsStatus').open"), false);
      await navigate('/apply?uiAuth=out');
      await waitApply("document.querySelectorAll('#applyRoles button').length === 3");
      assert.equal(await evaluate("document.querySelector('h1').textContent === 'Apply' && document.documentElement.scrollWidth <= innerWidth"), true);
      await screenshot('applications-requirements-' + width + '.png');
      await evaluate("document.querySelector('[data-role=moderator]').click()");
      assert.equal(await evaluate("document.querySelector('#applicationRoleTitle').textContent === 'Moderator' && document.querySelector('[data-role=moderator]').getAttribute('aria-pressed') === 'true'"), true);
      await evaluate("document.querySelector('[data-role=support]').click();document.querySelector('#applyNow').click()");
      assert.equal(await evaluate("document.querySelector('#applicationLogin') !== null && document.querySelector('#applicationForm') === null"), true);
      for (const role of ['support', 'moderator', 'contributor']) {
        await evaluate("sessionStorage.removeItem('ui.applications')");
        await navigate('/apply?uiAuth=member&role=' + role + '&form=1');
        await waitApply("document.querySelector('#applicationForm') !== null");
        assert.equal(await evaluate("document.querySelector('.application-identity').textContent.includes('verified-editor') && document.querySelector('#application-handle').value === 'verified-editor' && document.documentElement.scrollWidth <= innerWidth"), true);
        await evaluate("document.querySelector('#application-age').value='15'");
        assert.equal(await evaluate("document.querySelector('#applicationForm').checkValidity()"), false);
        assert.equal(await fillApplication(), true);
        await screenshot('application-form-' + role + '-' + width + '.png');
        await evaluate("document.querySelector('#application-experience').scrollIntoView({block:'center',behavior:'instant'})");
        await screenshot('application-fields-' + role + '-' + width + '.png');
        await evaluate("document.querySelector('#applicationSubmit').click();document.querySelector('#applicationSubmit').click()");
        await waitApply("document.querySelector('.application-receipt') !== null");
        assert.equal(await evaluate("window.__applicationPosts === 1 && Object.keys(window.__applicationPayload).join(',') === 'role,answers' && document.querySelector('.application-receipt').textContent.includes('Application submitted') && document.documentElement.scrollWidth <= innerWidth"), true);
        assert.equal(await evaluate("Object.keys(localStorage).some(key=>localStorage.getItem(key).includes('I support editors calmly'))"), false);
        await screenshot('application-receipt-' + role + '-' + width + '.png');
        await navigate('/apply?uiAuth=member&role=' + role + '&form=1');
        await waitApply("document.querySelector('.application-receipt') !== null");
        assert.equal(await evaluate("document.querySelector('#applicationForm') === null"), true);
      }
    }
    await evaluate("sessionStorage.removeItem('ui.applications')");
    for (const [fixtureCase, text] of [['new', 'Your Discord account is too new'], ['expired', 'Your Discord session expired'], ['closed', 'Applications are currently closed']]) {
      await navigate('/apply?uiAuth=member&form=1&applicationCase=' + fixtureCase);
      await waitApply("document.querySelector('#applyView').textContent.includes(" + JSON.stringify(text) + ")");
      assert.equal(await evaluate("document.querySelector('#applicationForm') === null"), true);
    }
    await navigate('/apply?uiAuth=logged&form=1');
    await waitApply("document.querySelector('#applicationRefresh') !== null");
    await navigate('/apply?uiAuth=member&form=1&applicationCase=failed');
    await waitApply("document.querySelector('#applicationForm') !== null");
    await fillApplication();
    await evaluate("document.querySelector('#applicationSubmit').click()");
    await waitApply("!document.querySelector('#applicationError').hidden");
    assert.equal(await evaluate("!document.querySelector('#applicationSubmit').disabled && document.querySelector('#application-scenario').value.includes('I support editors calmly')"), true);
    await navigate('/apply?uiAuth=member&form=1&applicationCase=slow');
    await waitApply("typeof window.__releaseApplication === 'function'");
    await evaluate("document.querySelector('#profileBtn').click();document.querySelector('[data-logout]').click();window.__releaseApplication()");
    await waitApply("document.querySelector('#applicationLogin') !== null");
    assert.equal(await evaluate("document.querySelector('#applicationForm') === null && document.querySelector('.application-identity') === null"), true);
    await evaluate("sessionStorage.removeItem('kyro.oauth.state.v1');sessionStorage.removeItem('kyro.oauth.return.v1')");
    await navigate('/?uiAuth=out&token=synthetic-token&username=forged&id=1142933516332437504&state=unrequested&in_server=true');
    assert.equal(await evaluate("window.KyroAuth.profile() === null && !location.search.includes('token')"), true);
    await evaluate("sessionStorage.setItem('kyro.oauth.state.v1','expected');sessionStorage.setItem('kyro.oauth.return.v1','/apply?role=contributor&form=1')");
    await navigate('/?uiAuth=out&token=synthetic-token&username=verified-editor&id=1142933516332437504&state=expected&in_server=true');
    await waitApply("location.pathname === '/apply' && document.querySelector('#applicationForm') !== null");
    assert.equal(await evaluate("new URLSearchParams(location.search).get('role') === 'contributor' && !sessionStorage.getItem('kyro.oauth.return.v1')"), true);
    assert.deepEqual(browserErrors.slice(applyErrors), []);

    for (const width of [1366, 390, 320]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: width < 400 ? 844 : 900, deviceScaleFactor: 1, mobile: width < 400 });
      await navigate('/?uiAuth=out');
      assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false);
      await screenshot('launch-home-' + width + '.png');
      await evaluate("document.querySelector('#heroSearch').click()");
      assert.equal(await evaluate("!document.querySelector('#paletteOverlay').hidden && document.querySelector('.palette').getBoundingClientRect().right <= innerWidth && document.querySelector('.palette').getBoundingClientRect().left >= 0"), true);
      await evaluate("document.querySelector('#paletteInput').value='Cosmic'; document.querySelector('#paletteInput').dispatchEvent(new Event('input',{bubbles:true}))");
      assert.equal(await evaluate("document.querySelector('#paletteResults').textContent.includes('Cosmic')"), true);
      await screenshot('launch-search-' + width + '.png');
      await evaluate("document.querySelector('.palette-row').click()");
      assert.equal(await evaluate("!document.querySelector('#modalOverlay').hidden && document.querySelector('#modalBox').getBoundingClientRect().right <= innerWidth && document.querySelector('#modalBox').getBoundingClientRect().left >= 0 && document.querySelector('#modalBox').scrollWidth <= document.querySelector('#modalBox').clientWidth"), true);
      await screenshot('launch-inspect-' + width + '.png');
      await evaluate("document.querySelector('.modal-close').click(); document.querySelector('#heroSearch').click()");
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 2 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 2 });
      assert.equal(await evaluate("document.querySelector('#paletteOverlay').hidden"), false);
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await openBoard();
      assert.equal(await evaluate("document.querySelector('#requestsDrawer').scrollWidth <= document.querySelector('#requestsDrawer').clientWidth && document.documentElement.scrollWidth <= innerWidth"), true);
      await evaluate("document.querySelector('#requestsClose').click()");
      await navigate('/missing/old-link');
      assert.equal(await evaluate("document.title === 'Page Not Found — Kyro' && document.querySelector('h1').textContent === '404' && getComputedStyle(document.body).backgroundColor === 'rgb(8, 9, 13)'"), true);
      assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth && document.querySelector('.btn-primary').getAttribute('href') === '/' && document.querySelector('.btn-primary').textContent === 'Back to the Vault'"), true);
      assert.equal(await evaluate("document.querySelector('meta[name=robots]').content"), 'noindex, follow');
      assert.equal(await evaluate("(async()=>{const response=await fetch(location.href);return response.status})()"), 404);
      await screenshot('launch-404-' + width + '.png');
      const returned = new Promise(resolve => events.set('Page.loadEventFired', resolve));
      await evaluate("document.querySelector('.btn-primary').click()");
      await returned;
      assert.equal(await evaluate('location.pathname'), '/');
    }
    for (const route of ['/', '/windows', '/macos', '/guide', '/about']) {
      await navigate(route + '?uiAuth=out');
      const metadata = await evaluate(`(()=>{const get=key=>document.querySelector('meta[property="'+key+'"]')?.content;return {title:get('og:title'),description:get('og:description'),image:get('og:image'),width:get('og:image:width'),height:get('og:image:height'),type:get('og:image:type'),url:get('og:url'),canonical:document.querySelector('link[rel=canonical]').href,unique:document.querySelectorAll('meta[property="og:image"]').length,twitter:document.querySelector('meta[name="twitter:image"]').content}})()`);
      assert.ok(metadata.title && metadata.description);
      assert.equal(metadata.image, 'https://kyro.new.tg/assets/kyro-preview.png');
      assert.equal(metadata.width, '1200');
      assert.equal(metadata.height, '630');
      assert.equal(metadata.type, 'image/png');
      assert.equal(metadata.canonical, metadata.url);
      assert.equal(metadata.unique, 1);
      assert.equal(metadata.twitter, metadata.image);
    }
    assert.deepEqual(await evaluate("(async()=>{const image=new Image();image.src='/assets/kyro-preview.png';await image.decode();return [image.naturalWidth,image.naturalHeight]})()"), [1200, 630]);
    await send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
    await navigate('/windows');
    assert.equal(await evaluate("document.querySelector('#softwareSection').open"), false);
    assert.equal(await evaluate("document.querySelector('#softwareGrid').checkVisibility()"), false);
    assert.equal(await evaluate("document.querySelector('#toolsSection').open"), false);
    assert.equal(await evaluate("document.querySelector('#toolsGrid').checkVisibility()"), false);
    assert.equal(await evaluate("document.querySelector('#toolsNote').textContent"), '· 4 items');
    assert.equal(await evaluate("document.querySelector('#softwareNote').textContent"), '· 4 items');
    await evaluate("document.querySelector('.software-toggle').scrollIntoView({block:'center',behavior:'instant'})");
    await screenshot('software-collapsed-desktop.png');
    await expandSoftware();
    assert.equal(await evaluate("document.querySelectorAll('#softwareGrid .software-card').length"), 4);
    await screenshot('software-expanded-desktop.png');
    await toggleSoftware();
    assert.equal(await evaluate("document.querySelector('#softwareSection').open"), false);
    await evaluate("document.querySelector('.software-toggle').focus()");
    await send('Input.dispatchKeyEvent', {type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r',unmodifiedText:'\r'});
    await send('Input.dispatchKeyEvent', {type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
    assert.equal(await evaluate("document.querySelector('#softwareSection').open"), true);
    await send('Input.dispatchKeyEvent', {type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32});
    await send('Input.dispatchKeyEvent', {type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32});
    assert.equal(await evaluate("document.querySelector('#softwareSection').open"), false);
    for (const width of [1366, 390]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: width === 390 ? 844 : 900, deviceScaleFactor: 1, mobile: width === 390 });
      for (const os of ['windows', 'macos']) {
        await navigate('/' + os);
        assert.equal(await evaluate("document.querySelector('#toolsSection').open"), false);
        assert.equal(await evaluate("document.querySelector('#toolsGrid').checkVisibility()"), false);
        assert.equal(await evaluate("document.querySelector('#toolsNote').textContent"), '· 4 items');
        await evaluate("document.querySelector('.tools-toggle').scrollIntoView({block:'center',behavior:'instant'})");
        await screenshot('tools-collapsed-' + os + '-' + width + '.png');
        await toggleTools();
        assert.equal(await evaluate("document.querySelector('#toolsSection').open && document.querySelector('#toolsGrid').checkVisibility() && !document.querySelector('#softwareSection').open"), true);
        assert.equal(await evaluate("document.querySelectorAll('#toolsGrid .software-card').length"), 4);
        await expandSoftware();
        assert.equal(await evaluate("document.querySelector('#toolsSection').open"), true);
        await toggleSoftware();
        assert.equal(await evaluate("document.querySelector('#toolsGrid').checkVisibility()"), true);
        assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false);
        await evaluate("document.querySelector('.tools-toggle').scrollIntoView({block:'center',behavior:'instant'})");
        await screenshot('tools-expanded-' + os + '-' + width + '.png');
        await evaluate("document.querySelector('[data-id=autocaption] [data-inspect]').click()");
        assert.equal(await evaluate("document.querySelector('.file-name').textContent"), 'Aescripts AutoCaption v4.6.1.zip');
        await evaluate("document.querySelector('[data-pass-copy]').click()");
        assert.equal(await evaluate('window.__copied'), 'Kyro');
        await evaluate("document.querySelector('[data-tab=install]').click()");
        assert.equal(await evaluate("document.querySelector('[data-panel=install]').textContent.includes('AutoCaption')"), true);
        await evaluate("document.querySelector('.modal-close').click()");
        await toggleTools();
        assert.equal(await evaluate("document.querySelector('#toolsSection').open"), false);
        await evaluate("document.querySelector('.tools-toggle').focus()");
        await send('Input.dispatchKeyEvent', {type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r',unmodifiedText:'\r'});
        await send('Input.dispatchKeyEvent', {type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
        assert.equal(await evaluate("document.querySelector('#toolsSection').open"), true);
        await send('Input.dispatchKeyEvent', {type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32});
        await send('Input.dispatchKeyEvent', {type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32});
        assert.equal(await evaluate("document.querySelector('#toolsSection').open"), false);
        await navigate('/' + os);
        assert.equal(await evaluate("document.querySelector('#toolsSection').open"), false);
      }
    }
    await send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
    await navigate('/windows');
    assert.equal(await evaluate("document.querySelector('#softwareSection').open"), false);
    assert.ok(await openBoard());
    assert.equal(await evaluate("document.querySelector('#reqCompose').getBoundingClientRect().height"), 0);
    assert.equal(await evaluate("document.querySelector('#reqNewRequest').getBoundingClientRect().right <= document.querySelector('#requestsClose').getBoundingClientRect().left"), true);
    assert.equal(await evaluate("getComputedStyle(document.querySelector('#requestsClose')).position"), 'relative');
    await screenshot('requests-desktop.png');
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await navigate('/windows');
    assert.equal(await evaluate("document.querySelector('#softwareSection').open"), false);
    await evaluate("document.querySelector('.software-toggle').scrollIntoView({block:'center',behavior:'instant'})");
    await screenshot('software-collapsed-mobile.png');
    await expandSoftware();
    assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false);
    await screenshot('software-expanded-mobile.png');
    await evaluate("document.querySelector('[data-id=toonboom] [data-inspect]').click()");
    assert.equal(await evaluate("document.querySelector('[data-ext-link]').getAttribute('href')"), 'https://1024terabox.com/s/1exMINTeowOqb6mzXgZ_TIQ');
    assert.equal(await evaluate("document.querySelector('.pass-value').textContent"), 'Kyro');
    assert.equal(await evaluate("document.querySelector('.file-name').textContent"), 'Toon Boom Harmony Premium');
    assert.equal(await evaluate("document.querySelector('.file-ico') === null && !document.querySelector('.spec-row').textContent.includes('File Format')"), true);
    await evaluate("document.querySelector('.pass-row').scrollIntoView({block:'center',behavior:'instant'})");
    await screenshot('toonboom-download-mobile.png');
    await evaluate("document.querySelector('[data-pass-copy]').click()");
    assert.equal(await evaluate('window.__copied'), 'Kyro');
    await evaluate("document.querySelector('[data-tab=install]').click()");
    assert.equal(await evaluate("document.querySelector('[data-panel=install]').textContent.includes('Follow it from the Read me in The folder')"), true);
    await evaluate("document.querySelector('.modal-close').click()");
    await toggleSoftware();
    assert.equal(await evaluate("document.querySelector('#softwareSection').open"), false);
    await openBoard();
    assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false);
    assert.notEqual(await evaluate("getComputedStyle(document.querySelector('#requestsOpen')).display"), 'none');
    await screenshot('requests-mobile.png');
    await evaluate("document.querySelector('#reqNewRequest').click()");
    await evaluate(`(${waitExpression})(()=>document.querySelector('#reqCompose').getBoundingClientRect().height>=document.querySelector('.req-fields').getBoundingClientRect().height-1)`);
    assert.equal(await evaluate("document.querySelector('#reqCompose').inert"), false);
    await screenshot('request-form-mobile.png');
    await navigate('/guide?os=macos');
    assert.equal(await evaluate("document.querySelector('#guideMac').hidden"), false);
    assert.equal(await evaluate("document.querySelectorAll('#guideMac .prose-section').length"), 6);
    assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false);
    await screenshot('macbook-guide-mobile.png');
    await navigate('/windows?uiAuth=out&checksumFixture=valid');
    await expandSoftware();
    await evaluate("document.querySelector('[data-id=\"after-effects-windows-v27\"] [data-inspect]').click()");
    assert.equal(await evaluate("document.querySelector('.checksum-value').textContent"), 'a'.repeat(64));
    await evaluate("document.querySelector('[data-checksum-copy]').click()");
    assert.equal(await evaluate('window.__copied'), 'a'.repeat(64));
    assert.equal(await evaluate("document.querySelector('.checksum-help').textContent.includes('certutil -hashfile <file> SHA256') && document.querySelector('.checksum-help').textContent.includes('shasum -a 256 <file>')"), true);
    assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false);
    await evaluate("document.querySelector('.checksum-box').scrollIntoView({block:'center'})");
    await screenshot('checksum-mobile.png');
    await navigate('/windows?checksumFixture=invalid');
    await expandSoftware();
    await evaluate("document.querySelector('[data-id=\"after-effects-windows-v27\"] [data-inspect]').click()");
    assert.equal(await evaluate("document.querySelector('.checksum-box') === null"), true);
    await navigate('/windows');
    await expandSoftware();
    await evaluate("document.querySelector('[data-id=\"after-effects-windows-v27\"] [data-inspect]').click()");
    assert.equal(await evaluate("document.querySelector('.checksum-box') === null"), true);
    await evaluate("document.querySelector('[data-tab=install]').click()");
    assert.equal(await evaluate("document.querySelector('[data-panel=install]').classList.contains('is-active')"), true);
    await evaluate("document.querySelector('.modal-close').click(); document.querySelector('#paletteOpen').click(); document.querySelector('#paletteInput').value='Cosmic'; document.querySelector('#paletteInput').dispatchEvent(new Event('input',{bubbles:true}));");
    assert.equal(await evaluate("document.querySelector('#paletteResults').textContent.includes('Cosmic')"), true);
    await navigate('/windows?uiAuth=out');
    await openBoard();
    await evaluate("document.querySelector('#reqNewRequest').click()");
    assert.equal(await evaluate("!document.querySelector('#reqGate').hidden && document.querySelector('#reqGate').textContent.includes('Login with Discord') && document.querySelector('#reqCompose').inert"), true);
    await navigate('/windows?uiAuth=logged');
    await openBoard();
    await evaluate("document.querySelector('#reqNewRequest').click()");
    assert.equal(await evaluate("document.querySelector('#reqGate').textContent.includes('Join Server') && document.querySelector('#reqCompose').inert"), true);
    await navigate('/macos');
    assert.equal(await evaluate("document.querySelector('#softwareSection').open"), false);
    assert.equal(await evaluate("document.querySelector('#softwareNote').textContent"), '· 4 items');
    await expandSoftware();
    assert.equal(await evaluate("document.querySelectorAll('#softwareGrid .software-card').length"), 4);
    await evaluate("document.querySelector('[data-id=\"after-effects-macos-arm\"] [data-inspect]').click(); document.querySelector('[data-pass-copy]').click()");
    assert.equal(await evaluate('window.__copied'), 'flame');
    await evaluate("document.querySelector('.modal-close').click(); document.querySelector('[data-id=\"after-effects-macos-arm\"] [data-save]').click(); document.querySelector('#savedBtn').click()");
    assert.equal(await evaluate("document.querySelector('#vaultDrawer').classList.contains('is-open') && document.querySelector('#vaultList').textContent.includes('After Effects ARM')"), true);
    await send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/142.0 Safari/537.36', platform: 'MacIntel' });
    await navigate('/macos');
    await openBoard();
    await evaluate("document.querySelector('#reqNewRequest').click()");
    assert.equal(await evaluate("document.querySelector('[data-req-os=macos]').getAttribute('aria-pressed')"), 'true');
    await navigate('/guide');
    assert.equal(await evaluate("document.querySelector('#guideMac').hidden"), false);
    await navigate('/windows?uiAuth=out');
    await expandSoftware();
    await evaluate("document.querySelector('[data-id=toonboom] [data-inspect]').click()");
    assert.equal(await evaluate("document.querySelector('[data-ext-link]') === null && document.querySelector('[data-pass-copy]') === null"), true);
    await navigate('/windows?uiAuth=logged');
    await expandSoftware();
    await evaluate("document.querySelector('[data-id=toonboom] [data-inspect]').click()");
    assert.equal(await evaluate("document.querySelector('[data-ext-link]') === null && document.querySelector('[data-pass-copy]') === null"), true);
    await navigate('/windows?emptySoftwareFixture');
    await toggleSoftware();
    assert.equal(await evaluate("document.querySelector('#softwareSection').open && !document.querySelector('#softwareEmpty').hidden && document.querySelector('#softwareNote').textContent === '· coming soon'"), true);
    await toggleSoftware();
    assert.equal(await evaluate("document.querySelector('#softwareSection').open"), false);
    await navigate('/windows?emptyToolsFixture');
    assert.equal(await evaluate("document.querySelector('#toolsSection').open"), false);
    await toggleTools();
    assert.equal(await evaluate("document.querySelector('#toolsSection').open && !document.querySelector('#toolsEmpty').hidden && document.querySelector('#toolsNote').textContent === '· coming soon'"), true);
    await toggleTools();
    assert.equal(await evaluate("document.querySelector('#toolsSection').open"), false);
    for (const width of [1366, 390]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: width === 390 ? 844 : 900, deviceScaleFactor: 1, mobile: width === 390 });
      await navigate('/windows?uiAuth=owner');
      await evaluate(`(${waitExpression})(()=>document.querySelector('.profile-role')?.textContent === 'OWNER')`);
      await evaluate("document.querySelector('#profileBtn').click()");
      assert.equal(await evaluate("document.querySelector('.pm-role').textContent.includes('OWNER')"), true);
      await screenshot('owner-profile-' + width + '.png');
      await evaluate("document.querySelector('#profileBtn').click()");
      await openBoard();
      assert.ok(await evaluate("document.querySelectorAll('[data-req-delete]').length"));
      await evaluate("document.querySelector('#reqNewRequest').click(); document.querySelector('#reqTitle').value='Owner UI request " + width + "'; document.querySelector('#reqTitle').dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('#reqSubmit').click()");
      await evaluate(`(${waitExpression})(()=>Array.from(document.querySelectorAll('.req-title')).some(e=>e.textContent === 'Owner UI request ${width}'))`);
      await evaluate(`(${waitExpression})(()=>document.querySelector('#toasts').textContent.includes('Saved to the board. Discord notification queued.'))`);
      const requestId = await evaluate("Array.from(document.querySelectorAll('.req-item')).find(e=>e.querySelector('.req-title').textContent==='Owner UI request " + width + "').dataset.requestId");
      await navigate('/windows?uiAuth=out');
      await openBoard();
      assert.equal(await evaluate("document.querySelector('[data-request-id=\"" + requestId + "\"]').textContent.includes('OWNER')"), true);
      assert.equal(await evaluate("document.querySelector('[data-req-delete]') === null"), true);
      await navigate('/windows?uiAuth=owner');
      await openBoard();
      await evaluate("document.querySelector('[data-req-status=\"" + requestId + "\"]').value='planned'; document.querySelector('[data-req-status=\"" + requestId + "\"]').dispatchEvent(new Event('change',{bubbles:true}))");
      await evaluate(`(${waitExpression})(()=>document.querySelector('[data-request-id="${requestId}"] .req-meta').textContent.includes('PLANNED'))`);
      await evaluate("document.querySelector('[data-req-delete=\"" + requestId + "\"]').click()");
      assert.equal(await evaluate("document.querySelector('[data-req-delete=\"" + requestId + "\"]').textContent"), 'Confirm Delete');
      await evaluate("document.querySelector('[data-req-delete-cancel]').click()");
      assert.equal(await evaluate("document.querySelector('[data-req-delete=\"" + requestId + "\"]').textContent"), 'Delete Request');
      await evaluate("document.querySelector('[data-req-delete=\"" + requestId + "\"]').click()");
      await screenshot('owner-delete-' + width + '.png');
      assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false);
      await evaluate("document.querySelector('[data-req-delete=\"" + requestId + "\"]').click()");
      await evaluate(`(${waitExpression})(()=>!document.querySelector('[data-request-id="${requestId}"]'))`);
      await navigate('/windows?uiAuth=member');
      await openBoard();
      assert.equal(await evaluate("document.querySelector('[data-request-id=\"" + requestId + "\"]') === null && document.querySelector('[data-req-delete]') === null"), true);
      await evaluate("document.querySelector('#requestsClose').click(); document.querySelector('#profileBtn').click()");
      assert.equal(await evaluate("document.querySelector('.pm-role').textContent.includes('MEMBER')"), true);
      await navigate('/windows?uiAuth=forged');
      await openBoard();
      assert.equal(await evaluate("document.querySelector('.profile-role') === null && document.querySelector('[data-req-delete]') === null"), true);
      await navigate('/windows?uiAuth=admin');
      await openBoard();
      assert.ok(await evaluate("document.querySelectorAll('[data-req-status]').length"));
      assert.equal(await evaluate("document.querySelector('[data-req-delete]') === null"), true);
      await navigate('/windows?uiAuth=departed');
      await evaluate(`(${waitExpression})(()=>document.querySelector('#stripRecheck'))`);
      assert.equal(await evaluate("document.querySelector('.status-dot.is-verified') === null && document.querySelector('.profile-role') === null"), true);
      await evaluate("document.querySelector('#profileBtn').click()");
      assert.equal(await evaluate("document.querySelector('.pm-state').textContent.includes('Not in the Kyro server') && document.querySelector('.pm-role') === null"), true);
    }
    console.log(JSON.stringify({ realChrome: 'passed', applications: 'CTA/dialog, three roles, verified forms, single submit, private receipts, duplicates, validation, retry, membership/age/closed gates, logout race, OAuth state and return path at 1366/390/320px', launchPolish: '1200x630 preview, unique Open Graph on five pages, custom 404 status and return button, search/Ctrl+K/drawers at 1366/390/320px', ownerControls: 'role refresh, public owner submission badge, status, confirm/cancel deletion, member/admin gates, spoofed storage, desktop/mobile', mobileWidth: 390, softwareAccordion: 'mouse, Enter, Space, both OS pages, empty state', toolsAccordion: 'mouse, Enter, Space, both OS pages, desktop/mobile, independent shelves, empty state', toolDownloads: 'AutoCaption modal, Kyro copy, install guide', toonboom: 'download URL, Kyro password, install note, auth gates', boardFirst: true, composer: true, publicChecksumCopy: true, malformedAndMissingHashes: 'hidden', guide: '6 sections', authGates: 'passed', searchAndCatalog: 'passed', artifacts }));
  } finally {
    if (ws && ws.readyState === WebSocket.OPEN) ws.close();
    chrome.kill();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
