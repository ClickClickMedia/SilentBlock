// Playwright fixtures: a Chromium with the built extension loaded, the fixture server,
// and helpers to talk to the service worker.
import { test as base, expect, chromium } from '@playwright/test';
import path from 'node:path';
import { startServer } from './server.mjs';

const EXT = path.resolve(import.meta.dirname, '..', '..', 'dist', 'chrome');

export async function waitForWorker(context, previous) {
  const current = context.serviceWorkers().find((w) => w !== previous);
  return current || context.waitForEvent('serviceworker', { predicate: (w) => w !== previous });
}

export async function waitForApplied(sw) {
  await expect.poll(
    () => sw.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).length).catch(() => 0),
    { timeout: 20_000 },
  ).toBeGreaterThan(0);
}

export const test = base.extend({
  server: [async ({}, use) => {
    const s = await startServer();
    await use(s);
    await s.close();
  }, { scope: 'worker' }],

  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: process.env.SB_CHANNEL || 'chromium', // SB_CHANNEL=msedge runs the suite in Edge
      headless: true,
      args: [
        '--enable-unsafe-extension-debugging', // lets tests re-install the build over CDP
        `--disable-extensions-except=${EXT}`,
        `--load-extension=${EXT}`,
        '--host-resolver-rules=MAP * 127.0.0.1, EXCLUDE localhost',
      ],
    });
    await use(context);
    await context.close();
  },

  sw: async ({ context }, use) => {
    const sw = await waitForWorker(context);
    await waitForApplied(sw);
    await use(sw);
  },

  extensionId: async ({ sw }, use) => {
    await use(new URL(sw.url()).host);
  },

  url: async ({ server }, use) => {
    await use((host, file) => `http://${host}:${server.port}/page/${file}`);
  },
});

export { expect };

// Opens the popup as a normal tab pointed at `tabId` (tests cannot open a real popup).
export async function openPopup(context, extensionId, tabId) {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html?tabId=${tabId}`);
  await popup.locator('#popup[data-state="ready"]').waitFor();
  return popup;
}

export async function tabIdFor(sw, urlPattern) {
  return sw.evaluate(async (pattern) => (await chrome.tabs.query({ url: pattern }))[0]?.id, urlPattern);
}

// Re-installs the unpacked build over CDP: Chrome treats it as an update of the same
// extension id, which is exactly the path that wiped settings in v1.
export async function reinstallExtension(context) {
  const page = await context.newPage();
  const cdp = await context.browser().newBrowserCDPSession(); // the Extensions domain is browser-level
  await cdp.send('Extensions.loadUnpacked', { path: EXT });
  return page;
}

export const display = (page, sel) => page.$eval(sel, (el) => getComputedStyle(el).display);
