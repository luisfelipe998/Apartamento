import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createStaticServer } from '../scripts/serve.mjs';
import { encryptAccess } from '../public/access-crypto.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = join(root, 'test-results');
const chromeBinary = process.env.CHROME_BIN || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome');
const fixture = await mkdtemp(join(tmpdir(), 'apartamento-browser-'));
const remoteImageOrigin = 'https://images.example.test';
const interceptPatterns = [{ urlPattern: '*://api.github.com/*' }, { urlPattern: remoteImageOrigin + '/*' }];
let server;
let chrome;
let socket;
let diagnostics;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(80);
  }
  throw new Error('Timed out: ' + message);
}

try {
  await cp(join(root, 'public'), join(fixture, 'public'), {
    recursive: true,
    // Never copy the real encrypted token. GitHub requests are fulfilled by
    // Chrome's request interceptor using fake credentials and an in-memory log.
    filter: (source) => source !== join(root, 'public', 'access.json'),
  });
  const envelope = await encryptAccess({ mode: 'github', token: 'browser-test-token', owner: 'luisfelipe998',
    repo: 'Apartamento', author: 'luisfelipe998', issueNumber: 1 }, 'password');
  await writeFile(join(fixture, 'public', 'access.json'), JSON.stringify(envelope));
  const catalogFile = join(fixture, 'public', 'data', 'items.json');
  const catalog = JSON.parse(await readFile(catalogFile, 'utf8'));
  catalog.items.find((item) => item.id === 'cafeteira').images = [
    './assets/espresso-machine.svg',
    { url: remoteImageOrigin + '/espresso-detail.svg', alt: 'Imagem externa da cafeteira' },
  ];
  catalog.items.find((item) => item.id === 'toalhas-banho').images = [remoteImageOrigin + '/towels.svg'];
  catalog.items.find((item) => item.id === 'jogo-cama').images = [
    { src: remoteImageOrigin + '/bedding.svg', alt: 'Imagem externa do jogo de cama' },
  ];
  await writeFile(catalogFile, JSON.stringify(catalog));
  const remoteImageBodies = new Map(await Promise.all(['espresso-detail.svg', 'towels.svg', 'bedding.svg']
    .map(async (name) => ['/' + name, (await readFile(join(fixture, 'public', 'assets', name))).toString('base64')])));
  await mkdir(artifacts, { recursive: true });
  server = createStaticServer(join(fixture, 'public'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = 'http://127.0.0.1:' + server.address().port;
  assert.equal((await fetch(address + '/.env')).status, 404, 'static server must not serve .env');

  const profile = join(fixture, 'chrome');
  chrome = spawn(chromeBinary, ['--headless=new', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--disable-gpu', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'],
  { stdio: ['ignore', 'ignore', 'pipe'] });
  let chromeError = '';
  chrome.on('error', (error) => { chromeError = error.message; });
  chrome.stderr.on('data', (chunk) => { chromeError = String(chunk).slice(-1500); });
  const devtools = await waitFor(async () => {
    if (chrome.exitCode !== null) throw new Error('Chrome exited: ' + chromeError);
    try { return await readFile(join(profile, 'DevToolsActivePort'), 'utf8'); } catch { return null; }
  }, 'Chrome remote debugging port');
  const [debugPort, debugPath] = devtools.trim().split('\n');
  socket = new WebSocket('ws://127.0.0.1:' + debugPort + debugPath);
  await once(socket, 'open');
  let nextId = 0;
  const pending = new Map();
  const exceptions = [];
  const networkErrors = [];
  const githubRequests = [];
  const interceptedComments = [];
  const remoteImageRequests = [];
  const commentEvent = (comment) => JSON.parse(comment.body.match(/<!-- apartamento-gift:v1 (.+) -->/)[1]);
  let rejectedRequests = 0;
  let liveReadOnly = false;
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const callback = pending.get(message.id);
      if (!callback) return;
      clearTimeout(callback.timer);
      pending.delete(message.id);
      if (message.error) callback.reject(new Error(message.error.message));
      else callback.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') {
      exceptions.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    } else if (message.method === 'Network.loadingFailed' && !message.params.canceled) {
      networkErrors.push(message.params.errorText);
    } else if (message.method === 'Network.requestWillBeSent'
      && message.params.request.url.startsWith('https://api.github.com')) {
      githubRequests.push(message.params.request.url);
    } else if (message.method === 'Fetch.requestPaused') {
      // Exercise the browser's actual window.fetch, including CORS/preflight,
      // without sending credentials or mutations to the real GitHub service.
      const { requestId, request } = message.params;
      const requestUrl = new URL(request.url);
      if (requestUrl.origin === remoteImageOrigin && request.method === 'GET' && remoteImageBodies.has(requestUrl.pathname)) {
        remoteImageRequests.push(request.url);
        send('Fetch.fulfillRequest', { requestId, responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'image/svg+xml' }, { name: 'Cache-Control', value: 'no-store' }],
          body: remoteImageBodies.get(requestUrl.pathname),
        }, message.sessionId).catch(() => {});
        return;
      }
      if (requestUrl.origin !== 'https://api.github.com'
        || requestUrl.pathname !== '/repos/luisfelipe998/Apartamento/issues/1/comments'
        || !['GET', 'POST', 'OPTIONS'].includes(request.method)) {
        rejectedRequests += 1;
        send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, message.sessionId).catch(() => {});
        return;
      }
      if (liveReadOnly) {
        if (request.method === 'GET' || request.method === 'OPTIONS') {
          send('Fetch.continueRequest', { requestId }, message.sessionId).catch(() => {});
        } else {
          rejectedRequests += 1;
          send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, message.sessionId).catch(() => {});
        }
        return;
      }
      let body = [];
      let responseCode = 200;
      if (request.method === 'POST') {
        const postedBody = JSON.parse(request.postData).body;
        const comment = { id: interceptedComments.length + 1, body: postedBody,
          user: { login: 'luisfelipe998' }, created_at: new Date().toISOString() };
        interceptedComments.push(comment);
        body = comment;
        responseCode = 201;
      } else if (request.method === 'GET') {
        const page = Number(requestUrl.searchParams.get('page') || '1');
        body = interceptedComments.slice((page - 1) * 100, page * 100);
      } else responseCode = 204;
      send('Fetch.fulfillRequest', { requestId, responseCode,
        responseHeaders: [
          { name: 'Content-Type', value: 'application/json' },
          { name: 'Access-Control-Allow-Origin', value: address },
          { name: 'Access-Control-Allow-Headers', value: 'accept,authorization,content-type,x-github-api-version' },
          { name: 'Access-Control-Allow-Methods', value: 'GET,POST,OPTIONS' },
        ], body: responseCode === 204 ? '' : Buffer.from(JSON.stringify(body)).toString('base64'),
      }, message.sessionId).catch(() => {});
    }
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const command = (method, params) => send(method, params, sessionId);
  await Promise.all([command('Runtime.enable'), command('Page.enable'), command('Network.enable'),
    command('Fetch.enable', { patterns: interceptPatterns })]);
  const evaluate = async (expression) => {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const visible = (selector) => evaluate('Boolean(document.querySelector(' + JSON.stringify(selector)
    + ')?.getClientRects().length)');
  const click = (selector) => evaluate('document.querySelector(' + JSON.stringify(selector) + ').click()');
  const closeDialog = () => evaluate('new Promise(resolve => { const dialog = document.querySelector("#gift-dialog");'
    + ' if (!dialog.open) return resolve(); dialog.addEventListener("close", resolve, { once: true });'
    + ' document.querySelector("#close-dialog").click(); })');
  diagnostics = () => evaluate('({ url: location.href, dialogOpen: document.querySelector("#gift-dialog")?.open,'
    + ' loginError: document.querySelector("#login-error")?.textContent,'
    + ' dialogError: document.querySelector("#dialog-error")?.textContent,'
    + ' listMessage: document.querySelector("#list-message")?.textContent,'
    + ' cardCount: document.querySelectorAll(".gift-card").length,'
    + ' mine: document.querySelector("#count-mine")?.textContent })');
  const pointerClick = async (selector, touch = false) => {
    const point = await evaluate('(() => { const target = document.querySelector(' + JSON.stringify(selector)
      + '); target.scrollIntoView({ block: "center", behavior: "instant" }); const box = target.getBoundingClientRect();'
      + ' const x = box.x + box.width / 2; const y = box.y + box.height / 2;'
      + ' return { x, y, unobstructed: Boolean(document.elementFromPoint(x, y)?.closest("#password-toggle")) }; })()');
    assert.equal(point.unobstructed, true, 'password toggle must receive pointer hits without an overlay');
    if (touch) {
      await command('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: point.x, y: point.y }] });
      await command('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
      await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    }
  };
  const assertPasswordState = async (showing, value) => {
    assert.deepEqual(await evaluate('({ type: document.querySelector("#password").type,'
      + ' value: document.querySelector("#password").value,'
      + ' pressed: document.querySelector("#password-toggle").getAttribute("aria-pressed"),'
      + ' label: document.querySelector("#password-toggle").getAttribute("aria-label"),'
      + ' title: document.querySelector("#password-toggle").title,'
      + ' slashVisible: getComputedStyle(document.querySelector("[data-password-slash]")).display !== "none" })'),
    { type: showing ? 'text' : 'password', value, pressed: String(showing),
      label: showing ? 'Ocultar senha' : 'Mostrar senha', title: showing ? 'Ocultar senha' : 'Mostrar senha', slashVisible: showing });
  };
  const fill = (selector, value) => evaluate('(() => { const input = document.querySelector('
    + JSON.stringify(selector) + '); input.value = ' + JSON.stringify(value)
    + '; input.dispatchEvent(new Event("input", { bubbles: true })); })()');
  const submit = (selector) => evaluate('document.querySelector(' + JSON.stringify(selector) + ').requestSubmit()');
  const waitEval = (expression, description) => waitFor(() => evaluate(expression), description);
  const touchSwipe = async (selector, direction) => {
    const box = await evaluate('(() => { const target = document.querySelector(' + JSON.stringify(selector)
      + '); target.scrollIntoView({ block: "center", behavior: "instant" }); const box = target.getBoundingClientRect();'
      + ' return { x: box.x, y: box.y, width: box.width, height: box.height }; })()');
    const startX = box.x + box.width * (direction === 'left' ? 0.75 : 0.25);
    const endX = box.x + box.width * (direction === 'left' ? 0.25 : 0.75);
    const y = box.y + box.height * 0.72;
    await command('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: startX, y }] });
    for (let step = 1; step <= 5; step += 1) {
      await command('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: startX + (endX - startX) * step / 5, y }] });
    }
    await command('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const pressEnter = async () => {
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  };
  const assertDialogSlide = async (index) => {
    assert.deepEqual(await evaluate('({ index: document.querySelector("#dialog-gallery").dataset.imageIndex,'
      + ' count: document.querySelector("#dialog-image-count").textContent,'
      + ' active: [...document.querySelectorAll("#dialog-thumbnails button")].findIndex(button => button.getAttribute("aria-pressed") === "true") })'),
    { index: String(index), count: (index + 1) + ' / 2', active: index });
  };
  const screenshot = async (name, fullPage = true) => {
    const { cssContentSize } = await command('Page.getLayoutMetrics');
    const clip = fullPage ? { x: 0, y: 0, width: cssContentSize.width, height: cssContentSize.height, scale: 1 } : undefined;
    const { data } = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage, ...(clip ? { clip } : {}) });
    await writeFile(join(artifacts, name), Buffer.from(data, 'base64'));
  };
  const login = async () => {
    await waitFor(() => visible('#login-form'), 'login form visible');
    await waitEval('document.readyState === "complete" && !document.querySelector("#login-button").disabled', 'login module ready');
    await fill('#password', 'password');
    await submit('#login-form');
    await waitEval('document.querySelectorAll(".gift-card").length === 8 && document.querySelector("#count-available").textContent !== "—"', 'eight gifts and reservation state');
  };
  const restoredList = async (description) => {
    await waitEval('document.readyState === "complete" && !document.querySelector("#list-view").classList.contains("hidden")'
      + ' && document.querySelectorAll(".gift-card").length === 8 && document.querySelector("#count-available").textContent !== "—"', description);
    assert.equal(await visible('#login-form'), false, 'saved access opens the list without asking for the password');
  };
  const checkNewPageRestoration = async () => {
    const { targetId: reopenedTarget } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId: reopenedSession } = await send('Target.attachToTarget', { targetId: reopenedTarget, flatten: true });
    const reopenedCommand = (method, params) => send(method, params, reopenedSession);
    try {
      await Promise.all([reopenedCommand('Runtime.enable'), reopenedCommand('Page.enable'), reopenedCommand('Network.enable'),
        reopenedCommand('Fetch.enable', { patterns: interceptPatterns })]);
      await reopenedCommand('Page.navigate', { url: address });
      const reopenedState = async () => {
        const result = await reopenedCommand('Runtime.evaluate', { expression: '({ ready: document.readyState === "complete",'
          + ' visible: Boolean(document.querySelector("#list-view")?.getClientRects().length),'
          + ' count: document.querySelectorAll(".gift-card").length, mine: document.querySelector("#count-mine")?.textContent,'
          + ' login: Boolean(document.querySelector("#login-form")?.getClientRects().length) })', returnByValue: true });
        return result.result.value;
      };
      const result = await waitFor(async () => {
        const state = await reopenedState();
        return state.ready && state.visible && state.count === 8 && state.mine === '1' ? state : false;
      }, 'a newly opened page restores login and reservation ownership');
      assert.equal(result.login, false, 'new page does not need the shared password again');
    } finally {
      await send('Target.closeTarget', { targetId: reopenedTarget });
    }
  };
  await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1050, deviceScaleFactor: 1, mobile: false });
  await command('Page.navigate', { url: address });
  await waitEval('document.querySelector("#login-button") && document.readyState === "complete"', 'welcome page');
  assert.match(await evaluate('document.title'), /Chá de casa nova.*Karol e Felipe/);
  assert.equal(await evaluate('document.documentElement.lang'), 'pt-BR');
  const nativeSnapshot = await evaluate('(async () => { const { GitHubStore } = await import("./github-store.js"); try { const state = await new GitHubStore({ token: "browser-test-token" }).snapshot(); return { ok: true, size: state.size }; } catch (error) { return { ok: false, message: error.message }; } })()');
  assert.deepEqual(nativeSnapshot, { ok: true, size: 0 }, 'the production GitHubStore must support native browser fetch');
  await screenshot('desktop-welcome.png');
  assert.equal(await evaluate('document.querySelector("#login-button").textContent.trim()'), 'Entrar na lista', 'login action has no decorative arrow');
  await fill('#password', 'senha-de-teste');
  await assertPasswordState(false, 'senha-de-teste');
  const closedEye = await evaluate('document.querySelector("#password-toggle").innerHTML');
  await click('#password-toggle');
  await assertPasswordState(true, 'senha-de-teste');
  const openEye = await evaluate('document.querySelector("#password-toggle").innerHTML');
  assert.notEqual(closedEye, openEye, 'eye icon must visibly change along with the input type');
  await pointerClick('#password-toggle svg');
  await assertPasswordState(false, 'senha-de-teste');
  await pointerClick('#password-toggle svg');
  await assertPasswordState(true, 'senha-de-teste');
  await evaluate('document.querySelector("#password-toggle").focus()');
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
  await assertPasswordState(false, 'senha-de-teste');
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await assertPasswordState(true, 'senha-de-teste');
  await click('#password-toggle');
  await assertPasswordState(false, 'senha-de-teste');
  await fill('#password', 'wrong-password');
  await submit('#login-form');
  await waitEval('document.querySelector("#login-error").textContent.length > 0 && !document.querySelector("#login-button").disabled', 'wrong password error');
  assert.equal(await visible('#list-view'), false, 'wrong password must not unlock list');
  await login();
  assert.equal(await visible('#demo-label'), false, 'browser fixture exercises native GitHub mode, not demo transport');
  await evaluate('document.querySelectorAll(".gift-card img").forEach(image => image.loading = "eager")');
  await waitEval('[...document.querySelectorAll(".gift-card img")].every(image => image.complete && image.naturalWidth > 0)', 'all gift illustrations');
  assert.equal(await evaluate('[...document.querySelectorAll(".gift-card img")].some(image => image.src.endsWith("fallback.svg"))'), false);
  assert.equal(await evaluate('document.querySelector("#giver-name")'), null, 'guests are not asked to enter a name');
  assert.equal(await evaluate('[...document.querySelectorAll(".card-details-button")].every(button => button.textContent.trim() === "Ver detalhes")'), true, 'details actions have no decorative arrows');
  assert.equal(await evaluate('document.querySelector("[data-item-id=cafeteira] .card-image-button img").src.startsWith(location.origin)'), true, 'local image string loads normally');
  assert.equal(await evaluate('document.querySelector("[data-item-id=toalhas-banho] .card-image-button img").src'), remoteImageOrigin + '/towels.svg', 'external image strings load normally');
  assert.equal(await evaluate('document.querySelector("[data-item-id=jogo-cama] .card-image-button img").src'), remoteImageOrigin + '/bedding.svg', 'external src objects load normally');
  assert.equal(await evaluate('document.querySelectorAll(".card-price, #dialog-price").length'), 0, 'prices are omitted from the guest interface');
  assert.equal(await evaluate('document.body.innerText.includes("R$")'), false, 'no estimated prices are shown');
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true, 'desktop list must not overflow horizontally');
  await screenshot('desktop-list.png');

  await fill('#search', 'cafe');
  await waitEval('document.querySelectorAll(".gift-card").length === 2', 'accent-insensitive search');
  await fill('#search', '');
  await waitEval('document.querySelectorAll(".gift-card").length === 8', 'reset search');
  await click('[data-item-id="cafeteira"] .carousel-next');
  assert.equal(await evaluate('document.querySelector("[data-item-id=cafeteira] .card-carousel").dataset.imageIndex'), '1');
  assert.equal(await evaluate('document.querySelector("[data-item-id=cafeteira] .carousel-count").textContent'), '2 / 2');
  assert.equal(await evaluate('document.querySelector("#gift-dialog").open'), false, 'card carousel arrows must not open details');
  await click('[data-item-id="cafeteira"] .carousel-next');
  assert.equal(await evaluate('document.querySelector("[data-item-id=cafeteira] .card-carousel").dataset.imageIndex'), '0', 'card next wraps to first image');
  await click('[data-item-id="cafeteira"] .carousel-previous');
  assert.equal(await evaluate('document.querySelector("[data-item-id=cafeteira] .card-carousel").dataset.imageIndex'), '1', 'card previous wraps to last image');
  assert.equal(await visible('[data-item-id="jogo-panelas"] .carousel-next'), false);
  assert.equal(await visible('[data-item-id="jogo-panelas"] .carousel-count'), false);
  await click('[data-item-id="cafeteira"] .card-title');
  assert.equal(await evaluate('document.querySelector("#gift-dialog").open'), true, 'card title opens details');
  await closeDialog();
  await click('[data-item-id="cafeteira"] .card-description');
  assert.equal(await evaluate('document.querySelector("#gift-dialog").open'), true, 'card description opens details');
  await closeDialog();
  assert.equal(await evaluate('document.querySelector("[data-item-id=cafeteira] .card-details-button").tabIndex'), 0);
  await evaluate('document.querySelector("[data-item-id=cafeteira] .card-details-button").focus()');
  await pressEnter();
  assert.equal(await evaluate('document.querySelector("#gift-dialog").open'), true, 'explicit details button is keyboard accessible');
  await closeDialog();
  await click('[data-item-id="cafeteira"] .card-button');
  await waitEval('document.querySelector("#count-mine").textContent === "1" && document.querySelector("[data-item-id=cafeteira]").classList.contains("is-mine")', 'card action directly reserves the gift');
  assert.equal(await evaluate('document.querySelector("#gift-dialog").open'), false, 'direct reservation does not open a modal');
  assert.equal(await evaluate('document.querySelector("[data-item-id=cafeteira] .card-badge").textContent'), 'Meu presente');
  assert.equal(interceptedComments.length, 1, 'one card action posts one reserve event');
  assert.equal(commentEvent(interceptedComments[0]).giverName, 'Convidado', 'direct reservations post only the generic compatibility name');
  await click('[data-item-id="cafeteira"] .card-button');
  await waitEval('document.querySelector("#gift-dialog").open && !document.querySelector("#release-button").disabled', 'owned card opens details for cancellation');
  await click('#release-button');
  await waitEval('document.querySelector("#count-mine").textContent === "0" && !document.querySelector("#reserve-button").disabled', 'release the direct card reservation');
  await closeDialog();
  await click('[data-item-id="jogo-panelas"] .card-title');
  assert.equal(await visible('#dialog-next'), false);
  assert.equal(await visible('#dialog-previous'), false);
  assert.equal(await visible('#dialog-image-count'), false);
  assert.equal(await visible('#dialog-thumbnails'), false, 'single-image gifts hide carousel controls');
  await closeDialog();
  await click('[data-item-id="cafeteira"] .card-image-button');
  await waitEval('document.querySelector("#gift-dialog").open', 'gift dialog');
  await assertDialogSlide(0);
  await click('#dialog-previous');
  await assertDialogSlide(1);
  await click('#dialog-next');
  await assertDialogSlide(0);
  await click('#dialog-next');
  await assertDialogSlide(1);
  await click('#dialog-next');
  await assertDialogSlide(0);
  await waitEval('[...document.querySelectorAll("#purchase-links img")].length === 3 && [...document.querySelectorAll("#purchase-links img")].every(image => image.complete && image.naturalWidth > 0)', 'three local store icons');
  const links = await evaluate('[...document.querySelectorAll("#purchase-links a")].map(a => { const icon = a.querySelector("img"); const box = icon.getBoundingClientRect(); return { href: a.href, target: a.target, rel: a.rel, icon: icon.src, width: box.width, height: box.height }; })');
  assert.equal(links.length, 3);
  assert(links.some((link) => new URL(link.href).hostname === 'www.amazon.com.br'));
  assert(links.some((link) => new URL(link.href).hostname === 'lista.mercadolivre.com.br'));
  assert(links.some((link) => new URL(link.href).hostname === 'shopee.com.br'));
  assert(links.every((link) => link.target === '_blank' && link.rel.includes('noopener')));
  assert(links.every((link) => new URL(link.icon).origin === address && link.width === 24 && link.height === 24), 'store icons are local and rendered at 24px');
  assert.equal(await evaluate('document.querySelectorAll("#dialog-thumbnails button").length'), 2);
  await click('#dialog-thumbnails button:nth-child(2)');
  await waitEval('document.querySelector("#dialog-image").src.endsWith("espresso-detail.svg") && document.querySelector("#dialog-image").complete', 'second gallery image');
  assert.equal(await evaluate('document.querySelector("#dialog-image").src'), remoteImageOrigin + '/espresso-detail.svg', 'external url objects work in the mixed gallery');
  assert.equal(await evaluate('document.querySelector("#dialog-image").alt'), 'Imagem externa da cafeteira');
  await assertDialogSlide(1);
  assert.equal(await evaluate('document.querySelectorAll("#reservation-form input").length'), 0, 'modal reservation is anonymous too');
  await submit('#reservation-form');
  await waitEval('document.querySelector("#count-mine").textContent === "1" && !document.querySelector("#release-button").disabled', 'reserve a gift');
  assert.equal(await visible('#release-section'), true);
  assert.equal(await visible('#reservation-form'), false);
  assert.equal(commentEvent(interceptedComments[2]).giverName, 'Convidado', 'modal reservations also post the generic compatibility name');
  // Simulate a legacy named event to keep privacy coverage meaningful after
  // the UI stops collecting names. This only changes the fake in-memory log.
  const legacyEvent = { ...commentEvent(interceptedComments[2]), giverName: 'Convidado de teste' };
  interceptedComments[2].body = 'Reserva legada de teste\n\n<!-- apartamento-gift:v1 ' + JSON.stringify(legacyEvent) + ' -->';
  await closeDialog();
  await click('[data-status="mine"]');
  await waitEval('document.querySelectorAll(".gift-card").length === 1', 'my gifts filter');

  const originalDevice = await evaluate('localStorage.getItem("casa-nova.device.v1")');
  await command('Page.reload', { ignoreCache: true });
  await restoredList('reload automatically restores the signed-in list');
  assert.equal(await evaluate('document.querySelector("#count-mine").textContent'), '1', 'automatic restoration retains reservation ownership');
  await checkNewPageRestoration();
  await evaluate('localStorage.setItem("casa-nova.device.v1", "b".repeat(43))');
  await command('Page.reload', { ignoreCache: true });
  await restoredList('saved access remains available for the second guest privacy check');
  assert.equal(await evaluate('document.querySelector("#count-mine").textContent'), '0');
  assert.equal(await evaluate('document.querySelector("#count-reserved").textContent'), '1');
  assert.equal(await evaluate('document.querySelector("#gift-grid").innerText.includes("Convidado de teste")'), false, 'cards never reveal another giver name');
  await click('[data-item-id="cafeteira"] .card-details-button');
  assert.equal(await evaluate('document.querySelector("#dialog-status").textContent'), 'Este presente já foi reservado.');
  assert.equal(await evaluate('document.querySelector("#gift-dialog").innerText.includes("Convidado de teste")'), false, 'details never reveal another giver name');
  await closeDialog();
  await evaluate('localStorage.setItem("casa-nova.device.v1", ' + JSON.stringify(originalDevice) + ')');

  await command('Page.reload', { ignoreCache: true });
  await restoredList('restored access for the original reservation owner');
  assert.equal(await evaluate('document.querySelector("#count-mine").textContent'), '1', 'same browser retains ownership');
  await click('[data-item-id="cafeteira"] .card-button');
  await waitEval('document.querySelector("#gift-dialog").open && !document.querySelector("#release-button").disabled', 'owned reservation after reload');
  await click('#release-button');
  await waitEval('document.querySelector("#count-mine").textContent === "0" && !document.querySelector("#reserve-button").disabled', 'release a gift');
  assert.equal(await evaluate('document.querySelector("#count-available").textContent'), '8');
  await closeDialog();

  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await evaluate('window.scrollTo(0, 0)');
  await delay(120);
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true, 'mobile list must not overflow horizontally');
  await screenshot('mobile-list.png');
  await touchSwipe('[data-item-id="cafeteira"] .card-carousel', 'left');
  await waitEval('document.querySelector("[data-item-id=cafeteira] .card-carousel").dataset.imageIndex === "1"', 'card touch swipe');
  assert.equal(await evaluate('document.querySelector("#gift-dialog").open'), false, 'swiping a card image must not open details');
  await touchSwipe('[data-item-id="cafeteira"] .card-carousel', 'right');
  await waitEval('document.querySelector("[data-item-id=cafeteira] .card-carousel").dataset.imageIndex === "0"', 'card reverse swipe');
  await click('[data-item-id="cafeteira"] .card-details-button');
  assert.equal(await evaluate('document.querySelector("#gift-dialog").getBoundingClientRect().width <= window.innerWidth'), true, 'mobile dialog fits viewport');
  await assertDialogSlide(0);
  await touchSwipe('#dialog-gallery', 'left');
  await waitEval('document.querySelector("#dialog-gallery").dataset.imageIndex === "1"', 'dialog touch swipe');
  await assertDialogSlide(1);
  await screenshot('mobile-dialog.png', false);
  await closeDialog();
  await click('#logout-button');
  await waitFor(() => visible('#welcome-view'), 'logout returns to welcome');
  await waitEval('!document.querySelector("#login-button").disabled', 'logout finished clearing saved access');
  assert.equal(await visible('#list-view'), false);
  await command('Page.reload', { ignoreCache: true });
  await waitEval('document.readyState === "complete" && !document.querySelector("#login-button").disabled', 'reload after explicit logout');
  assert.equal(await visible('#login-form'), true, 'logout persists across reloads');
  assert.equal(await visible('#list-view'), false, 'logged-out page does not restore saved access');
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true, 'mobile welcome must not overflow horizontally');
  await screenshot('mobile-welcome.png');
  await fill('#password', 'senha-no-celular');
  await pointerClick('#password-toggle svg', true);
  await waitEval('document.querySelector("#password").type === "text"', 'mobile password reveal');
  await assertPasswordState(true, 'senha-no-celular');
  await pointerClick('#password-toggle', true);
  await waitEval('document.querySelector("#password").type === "password"', 'mobile password masking');
  await assertPasswordState(false, 'senha-no-celular');
  assert.deepEqual(exceptions, [], 'no browser JavaScript errors');
  assert.deepEqual(networkErrors, [], 'no failed network requests');
  assert(githubRequests.length > 0, 'native browser fetch must reach the GitHub interceptor');
  assert.equal(rejectedRequests, 0, 'all expected GitHub requests were safely mocked');
  assert.equal(interceptedComments.length, 4, 'direct and modal reserve/release each append one issue comment');
  assert.deepEqual(interceptedComments.map((comment) => commentEvent(comment).action), ['reserve', 'release', 'reserve', 'release']);
  assert(remoteImageRequests.some((url) => url.endsWith('/espresso-detail.svg')) && remoteImageRequests.some((url) => url.endsWith('/towels.svg'))
    && remoteImageRequests.some((url) => url.endsWith('/bedding.svg')), 'all external image forms use intercepted offline responses');
  // Classic password controls must still work when a guest opens index.html
  // directly and Chrome blocks the reservation app's ES-module imports.
  await command('Page.navigate', { url: pathToFileURL(join(fixture, 'public', 'index.html')).href });
  await waitEval('document.readyState === "complete" && location.protocol === "file:"', 'direct-file welcome page');
  assert.equal(await evaluate('document.querySelector("#login-button").disabled'), true, 'file:// login explains that an HTTP preview is required');
  assert.match(await evaluate('document.querySelector("#login-error").textContent'), /localhost:3000/);
  await fill('#password', 'senha-no-arquivo-local');
  await assertPasswordState(false, 'senha-no-arquivo-local');
  await pointerClick('#password-toggle svg', true);
  await waitEval('document.querySelector("#password").type === "text"', 'file:// password reveal');
  await assertPasswordState(true, 'senha-no-arquivo-local');
  await pointerClick('#password-toggle', true);
  await waitEval('document.querySelector("#password").type === "password"', 'file:// password masking');
  await assertPasswordState(false, 'senha-no-arquivo-local');
  if (process.env.LIVE_PREVIEW_URL) {
    const preview = new URL(process.env.LIVE_PREVIEW_URL);
    assert(['localhost', '127.0.0.1'].includes(preview.hostname), 'live preview must be local');
    assert.equal(preview.protocol, 'http:');
    liveReadOnly = true;
    exceptions.length = 0;
    networkErrors.length = 0;
    await command('Page.navigate', { url: preview.href });
    await waitEval('document.querySelector("#login-button") && document.readyState === "complete"', 'live local preview');
    await fill('#password', 'password');
    await submit('#login-form');
    await waitEval('document.querySelectorAll(".gift-card").length > 0 && document.querySelector("#count-available").textContent !== "—"', 'read-only real GitHub reservation state');
    assert.deepEqual(exceptions, [], 'live preview must have no JavaScript errors');
    assert.deepEqual(networkErrors, [], 'live preview must load the real GitHub reservation state');
    assert.equal(rejectedRequests, 0, 'live validation must not attempt an issue mutation');
    await screenshot('live-readonly.png');
    console.log('Read-only live preview passed: ' + await evaluate('document.querySelector("#count-all").textContent') + ' gifts loaded; real GitHub comments read successfully; mutation requests blocked.');
  }
  console.log('Browser smoke passed: anonymous one-click and modal reservations, local/remote images, Amazon/Mercado Livre/Shopee icons, password controls, persistent login, restored ownership, legacy-name privacy, durable logout, carousels, and 390px mobile layout.');
  console.log('Direct file:// opening: password visibility toggles correctly even with the main module blocked.');
  console.log('Screenshots: test-results/{desktop-welcome,desktop-list,mobile-list,mobile-dialog,mobile-welcome}.png');
  await command('Page.close');
} catch (error) {
  if (diagnostics) {
    try { console.error('Browser state at failure:', await diagnostics()); } catch { /* Target may have closed. */ }
  }
  throw error;
} finally {
  socket?.close();
  if (chrome && chrome.exitCode === null) {
    const exited = once(chrome, 'exit');
    chrome.kill('SIGTERM');
    await Promise.race([exited, delay(2500)]);
    if (chrome.exitCode === null) chrome.kill('SIGKILL');
  }
  if (server?.listening) await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
  await rm(fixture, { recursive: true, force: true });
}
