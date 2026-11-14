const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.join(__dirname, '..');
const artifacts = path.join(root, '.wrangler', 'ui-check');
fs.mkdirSync(artifacts, { recursive: true });

async function main() {
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
    ws.addEventListener('message', event => {
      const message = JSON.parse(event.data);
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
    console.log(JSON.stringify({ realChrome: 'passed', ownerControls: 'role refresh, public owner submission badge, status, confirm/cancel deletion, member/admin gates, spoofed storage, desktop/mobile', mobileWidth: 390, softwareAccordion: 'mouse, Enter, Space, both OS pages, empty state', toolsAccordion: 'mouse, Enter, Space, both OS pages, desktop/mobile, independent shelves, empty state', toolDownloads: 'AutoCaption modal, Kyro copy, install guide', toonboom: 'download URL, Kyro password, install note, auth gates', boardFirst: true, composer: true, publicChecksumCopy: true, malformedAndMissingHashes: 'hidden', guide: '6 sections', authGates: 'passed', searchAndCatalog: 'passed', artifacts }));
  } finally {
    if (ws && ws.readyState === WebSocket.OPEN) ws.close();
    chrome.kill();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
