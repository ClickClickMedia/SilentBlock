// Build-time validation in real Chromium, because Chromium is the only authority on what
// it accepts:
//   - CSS selectors: one invalid selector voids a whole grouped rule.
//   - DNR regexFilter: a single regex RE2 rejects (e.g. `{200,1300}` blows the 2KB
//     compiled-size limit) makes Chrome refuse to load the ENTIRE extension.
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function playwright() {
  try {
    return (await import('@playwright/test')).chromium;
  } catch {
    throw new Error('Validation needs @playwright/test (npm install), or build with --no-validate.');
  }
}

export async function validateSelectors(selectors) {
  const chromium = await playwright();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><html><body></body></html>');
    const invalid = new Set();
    const CHUNK = 5000;
    for (let i = 0; i < selectors.length; i += CHUNK) {
      const bad = await page.evaluate((chunk) => {
        const frag = document.createDocumentFragment();
        return chunk.filter((s) => {
          try { frag.querySelector(s); return false; } catch { return true; }
        });
      }, selectors.slice(i, i + CHUNK));
      bad.forEach((s) => invalid.add(s));
    }
    return invalid;
  } finally {
    await browser.close();
  }
}

// items: [{ regex, isCaseSensitive }]. Returns a Set of "regex\u0001caseSensitive" keys
// that Chromium's declarativeNetRequest rejects.
export async function validateRegexes(items) {
  if (!items.length) return new Set();
  const chromium = await playwright();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sb-regex-'));
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: 'regex-validator', version: '1',
    permissions: ['declarativeNetRequest'], background: { service_worker: 'sw.js' },
  }));
  await writeFile(path.join(dir, 'sw.js'), '');
  const ctx = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`],
  });
  try {
    const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 20000 });
    const bad = await sw.evaluate(async (list) => {
      const out = [];
      for (const { regex, isCaseSensitive } of list) {
        const r = await chrome.declarativeNetRequest.isRegexSupported({ regex, isCaseSensitive });
        if (!r.isSupported) out.push(`${regex}\u0001${isCaseSensitive}`);
      }
      return out;
    }, items);
    return new Set(bad);
  } finally {
    await ctx.close();
    await rm(dir, { recursive: true, force: true });
  }
}
