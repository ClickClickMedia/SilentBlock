// Scriptlet library tests. No extension here: the library is injected before page
// scripts (as the MAIN-world buckets do) and each scriptlet is checked against the uBO
// argument semantics the filter lists rely on.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const unwall = readFileSync(path.join(root, 'src/shared/unwall-core.js'), 'utf8');
const LIBRARY = readFileSync(path.join(root, 'src/scriptlets/library.js'), 'utf8').replace('/*@UNWALL_CORE@*/', unwall);

async function run(page, calls, html, routes = {}) {
  const invocations = calls.map(([name, ...args]) => `SCRIPTLETS[${JSON.stringify(name)}](...${JSON.stringify(args)});`).join('\n');
  await page.addInitScript({ content: `${LIBRARY}\n${invocations}` });
  await page.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (routes[u.pathname]) return route.fulfill(routes[u.pathname]);
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body>${html}</body></html>` });
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://scriptlets.test/');
  return errors;
}

test('set-constant pins nested chains that the page assigns later', async ({ page }) => {
  await run(page, [['set-constant', 'ads.config.enabled', 'false'], ['set-constant', 'adCheck', 'noopFunc']], `<script>
    window.ads = { config: { enabled: true, other: 1 } };
    window.result = { enabled: ads.config.enabled, other: ads.config.other, check: typeof adCheck };
    window.adCheck = function () { throw new Error('ran'); };
    window.result.after = adCheck();
  </script>`);
  expect(await page.evaluate(() => window.result)).toEqual({ enabled: false, other: 1, check: 'function', after: undefined });
});

test('set-constant lets the page win when it assigns a different type', async ({ page }) => {
  await run(page, [['set-constant', 'flag', 'true']], '<script>window.flag = "a string"; window.result = window.flag;</script>');
  expect(await page.evaluate(() => window.result)).toBe('a string');
});

test('set-constant rejects values outside the untrusted set', async ({ page }) => {
  await run(page, [['set-constant', 'x', 'alert(1)']], '<script>window.x = 5; window.result = window.x;</script>');
  expect(await page.evaluate(() => window.result)).toBe(5);
});

test('abort-on-property-read throws inside the page and stays quiet', async ({ page }) => {
  const errors = await run(page, [['abort-on-property-read', 'detector.run']], `<script>
    window.detector = { run() { return 'detected'; } };
  </script><script>window.first = detector.run();</script><script>window.second = 'still running';</script>`);
  expect(await page.evaluate(() => [window.first, window.second])).toEqual([undefined, 'still running']);
  expect(errors).toEqual([]);
});

test('abort-current-script only kills inline scripts containing the needle', async ({ page }) => {
  await run(page, [['abort-current-script', 'document.createElement', 'adblockCheck']], `<script>
    window.a = 'untouched'; try { document.createElement('div'); window.a = 'ok'; } catch (e) { window.a = 'aborted'; }
  </script><script>
    window.b = 'untouched'; /* adblockCheck */ try { document.createElement('div'); window.b = 'ok'; } catch (e) { window.b = 'aborted'; }
  </script>`);
  expect(await page.evaluate(() => [window.a, window.b])).toEqual(['ok', 'aborted']);
});

test('prevent-setTimeout defuses matching callbacks only, and stays native-looking', async ({ page }) => {
  await run(page, [['prevent-setTimeout', 'showNag']], `<script>
    window.r = [];
    setTimeout(function showNag() { r.push('nag'); }, 1);
    setTimeout(function other() { r.push('other'); }, 1);
    window.native = Function.prototype.toString.call(setTimeout);
  </script>`);
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.r)).toEqual(['other']);
  expect(await page.evaluate(() => window.native)).toContain('[native code]');
});

test('prevent-setTimeout honours the delay argument and "!" negation', async ({ page }) => {
  await run(page, [['prevent-setTimeout', '', '!50']], `<script>
    window.r = [];
    setTimeout(function a() { r.push('a50'); }, 50);
    setTimeout(function b() { r.push('b10'); }, 10);
  </script>`);
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.r)).toEqual(['a50']);
});

test('adjust-setTimeout speeds up countdowns', async ({ page }) => {
  await run(page, [['adjust-setTimeout', 'countdown', '5000', '0.001']], `<script>
    window.done = false;
    setTimeout(function countdown() { window.done = true; }, 5000);
  </script>`);
  await expect.poll(() => page.evaluate(() => window.done), { timeout: 2000 }).toBe(true);
});

test('prevent-addEventListener drops matching handlers', async ({ page }) => {
  await run(page, [['prevent-addEventListener', 'click', 'detectAdblock']], `<button id="b">x</button><script>
    window.r = [];
    const b = document.getElementById('b');
    b.addEventListener('click', function () { detectAdblock(); r.push('bad'); });
    b.addEventListener('click', function () { r.push('good'); });
    function detectAdblock() {}
  </script>`);
  await page.click('#b');
  expect(await page.evaluate(() => window.r)).toEqual(['good']);
});

test('remove-node-text blanks an inline script before it runs', async ({ page }) => {
  await run(page, [['remove-node-text', 'script', 'adblockWall']], `<script>window.before = 1;</script>
    <script>/* adblockWall */ window.wall = true;</script>
    <script>window.after = 1;</script>`);
  expect(await page.evaluate(() => [window.before, window.wall, window.after])).toEqual([1, undefined, 1]);
});

test('prevent-fetch fakes matching requests and passes the rest through', async ({ page }) => {
  await run(page, [['prevent-fetch', 'ads.example']], `<script>
    window.r = Promise.all([
      fetch('http://ads.example/track').then((res) => res.status + ':' + res.url),
      fetch('/real').then((res) => res.text()),
    ]);
  </script>`, { '/real': { body: 'real body' } });
  expect(await page.evaluate(() => window.r)).toEqual(['200:http://ads.example/track', 'real body']);
});

test('prevent-xhr fakes a completed request', async ({ page }) => {
  await run(page, [['prevent-xhr', 'method:POST url:/beacon']], `<script>
    window.r = new Promise((resolve) => {
      const x = new XMLHttpRequest();
      x.open('POST', '/beacon');
      x.onload = () => resolve([x.readyState, x.status, x.responseText]);
      x.send('data');
    });
    window.real = new Promise((resolve) => {
      const x = new XMLHttpRequest();
      x.open('GET', '/real');
      x.onload = () => resolve(x.responseText);
      x.send();
    });
  </script>`, { '/real': { body: 'real body' } });
  expect(await page.evaluate(() => window.r)).toEqual([4, 200, '']);
  expect(await page.evaluate(() => window.real)).toBe('real body');
});

test('json-prune strips ad payloads from JSON.parse and Response.json', async ({ page }) => {
  await run(page, [['json-prune', 'adPlacements playerAds', 'streamingData']], `<script>
    window.a = JSON.parse('{"streamingData":1,"adPlacements":[1],"playerAds":[2],"keep":3}');
    window.b = JSON.parse('{"adPlacements":[1]}');
  </script>`);
  expect(await page.evaluate(() => [window.a, window.b])).toEqual([{ streamingData: 1, keep: 3 }, { adPlacements: [1] }]);
});

test('json-prune-fetch-response prunes fetched JSON', async ({ page }) => {
  await run(page, [['json-prune-fetch-response', 'ads.[].url']], `<script>
    window.r = fetch('/api').then((res) => res.json());
  </script>`, { '/api': { contentType: 'application/json', body: '{"ads":[{"url":"x","id":1},{"url":"y","id":2}]}' } });
  expect(await page.evaluate(() => window.r)).toEqual({ ads: [{ id: 1 }, { id: 2 }] });
});

test('remove-attr and remove-class clean elements as they appear', async ({ page }) => {
  await run(page, [['remove-attr', 'onclick', 'a.ad', 'stay'], ['remove-class', 'blurred', 'body']], `<a class="ad" onclick="alert(1)">x</a><script>
    document.body.classList.add('blurred');
    setTimeout(() => { const a = document.createElement('a'); a.className = 'ad'; a.setAttribute('onclick', 'x()'); document.body.append(a); }, 20);
  </script>`);
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => [document.querySelectorAll('a[onclick]').length, document.body.classList.contains('blurred')])).toEqual([0, false]);
});

test('set-cookie and set-local-storage-item accept only safe values', async ({ page }) => {
  await run(page, [
    ['set-cookie', 'consent', 'accept'], ['set-cookie', 'evil', '<script>'],
    ['set-local-storage-item', 'cmp', 'true'], ['set-local-storage-item', 'bad', 'javascript:x'],
  ], '<p>x</p>');
  expect(await page.evaluate(() => ({ c: document.cookie, ls: localStorage.getItem('cmp'), bad: localStorage.getItem('bad') })))
    .toEqual({ c: 'consent=accept', ls: 'true', bad: null });
});

test('nobab makes BlockAdBlock report "not detected"', async ({ page }) => {
  await run(page, [['nobab']], `<script>
    window.r = [];
    blockAdBlock.onDetected(() => r.push('detected'));
    blockAdBlock.onNotDetected(() => r.push('clean'));
    window.BlockAdBlock = function () {}; // the real library cannot replace the fake
  </script>`);
  await page.waitForTimeout(50);
  expect(await page.evaluate(() => [window.r, typeof BlockAdBlock.prototype.onNotDetected])).toEqual([['clean'], 'function']);
});

test('prevent-window-open returns a fake window for matching URLs', async ({ page }) => {
  await run(page, [['prevent-window-open', 'popads']], `<script>
    const w = window.open('http://popads.test/x');
    window.r = [w === null, w && w.closed, typeof (w && w.close)];
  </script>`);
  expect(await page.evaluate(() => window.r)).toEqual([false, false, 'function']);
});

test('noeval-if blocks matching eval only', async ({ page }) => {
  await run(page, [['noeval-if', 'adblock']], `<script>
    window.a = eval('"adblock"; 1 + 1');
    window.b = eval('2 + 2');
  </script>`);
  expect(await page.evaluate(() => [window.a, window.b])).toEqual([undefined, 4]);
});

test('sb-unwall removes an anti-adblock wall and nothing else', async ({ page }) => {
  await run(page, [['sb-unwall']], `
    <style>body{overflow:hidden} #wall{position:fixed;inset:10%;z-index:9999;background:#fff}
    #menu{position:absolute;z-index:500;width:300px;height:300px}</style>
    <div id="menu">IP whitelist settings</div>
    <div id="wall">We've detected an ad blocker. Please whitelist this site.</div>`);
  await expect.poll(() => page.$eval('#wall', (el) => getComputedStyle(el).display)).toBe('none');
  expect(await page.$eval('#menu', (el) => getComputedStyle(el).display)).toBe('block');
  expect(await page.evaluate(() => getComputedStyle(document.body).overflowY)).toBe('auto');
});
