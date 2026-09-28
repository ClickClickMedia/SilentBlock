// Firefox smoke test: the real dist/firefox build in real Firefox (Selenium + geckodriver,
// installed as a temporary add-on). Checks the layers most likely to differ from Chrome.
//   npm run test:firefox
import { Builder, until } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import path from 'node:path';
import { startServer } from '../e2e/server.mjs';

const EXT = path.resolve(import.meta.dirname, '..', '..', 'dist', 'firefox');
const HOSTS = ['site.test', 'sb-ads.test', 'cdn-ok.test', 'sb-selftest.test', 'sb-malware.test', 'sb-phish.test'];

const server = await startServer();
// Pin the installed binary and stop a running Firefox from absorbing the test instance.
process.env.MOZ_NO_REMOTE = '1';
const opts = new firefox.Options()
  .setBinary(process.env.FIREFOX_BIN || (process.platform === 'win32' ? 'C:/Program Files/Mozilla Firefox/firefox.exe' : 'firefox'))
  .addArguments('-headless', '-no-remote')
  .setPreference('network.dns.localDomains', HOSTS.join(','))
  .setPreference('dom.security.https_only_mode', false)
  .setPreference('extensions.webextensions.restrictedDomains', '');
const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(opts).build();

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(['ok', name]);
  } catch (err) {
    results.push(['FAIL', name, String(err.message || err).split('\n')[0]]);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const url = (host, file) => `http://${host}:${server.port}/page/${file}`;
async function poll(fn, expected, ms = 8000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (JSON.stringify(last) === JSON.stringify(expected)) return;
    await sleep(250);
  }
  throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(last)}`);
}

try {
  await driver.installAddon(EXT, true);
  await sleep(4000); // install: rulesets enable, content scripts register

  await check('network: third-party ad blocked, other host loads', async () => {
    await driver.get(url('site.test', 'basic.html'));
    await poll(() => driver.executeScript('return window.__net'), { ad: 'error', ok: 'load' });
  });

  await check('cosmetic: generic token, generic complex and site-specific hiding', async () => {
    await driver.get(url('sb-selftest.test', 'basic.html'));
    for (const id of ['tokenProbe', 'complexProbe', 'specificProbe']) {
      await poll(() => driver.executeScript(`return getComputedStyle(document.getElementById('${id}')).display`), 'none');
    }
  });

  await check('scriptlets: set-constant and prevent-setTimeout run before page scripts', async () => {
    await driver.get(url('sb-selftest.test', 'basic.html'));
    await sleep(400);
    await poll(() => driver.executeScript('return [window.__flag, window.__timerRan, window.__otherTimerRan]'), [true, false, true]);
  });

  await check('stubs: first-party gtag swapped for a stub that fires callbacks', async () => {
    await driver.get(url('site.test', 'gtag.html'));
    await poll(() => driver.executeScript('return [window.__callback, window.__ended]'), [true, true]);
  });

  await check('security: listed host gets the warning page', async () => {
    await driver.get(url('sb-malware.test', 'landing.html')).catch(() => {});
    await driver.wait(until.urlContains('/warning/warning.html'), 8000);
  });

  await check('hygiene: page APIs stay native on ordinary sites', async () => {
    await driver.get(url('site.test', 'hygiene.html'));
    await sleep(800);
    const natives = await driver.executeScript('return window.__natives');
    const bad = Object.entries(natives).filter(([, src]) => !src.includes('[native code]')).map(([k]) => k);
    if (bad.length) throw new Error(`patched: ${bad.join(', ')}`);
  });
} finally {
  await driver.quit();
  await server.close();
}

for (const r of results) console.log(r.join('  '));
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} Firefox checks passed`);
process.exitCode = failed ? 1 : 0;
