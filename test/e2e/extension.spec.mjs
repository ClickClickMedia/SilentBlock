// End-to-end tests against the real built extension (dist/chrome). Each one pins a
// behaviour the 1.x review found broken, or a promise 2.0 makes.
import { test, expect, openPopup, tabIdFor, display, reinstallExtension } from './fixtures.mjs';

test.describe('install', () => {
  test('enables every ruleset and registers content scripts', async ({ sw }) => {
    const r = await sw.evaluate(async () => ({
      rulesets: (await chrome.declarativeNetRequest.getEnabledRulesets()).sort(),
      scripts: (await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id),
      state: await chrome.storage.local.get(null),
    }));
    expect(r.rulesets).toEqual(['ads', 'annoyances', 'core', 'privacy']);
    expect(r.scripts).toContain('sb-tokens');
    expect(r.scripts).toContain('sb-generic-ads');
    expect(r.scripts.some((id) => id.startsWith('sb-sl-core-'))).toBe(true);
    expect(r.state).toMatchObject({ schema: 2, enabled: true, allowlist: [] });
  });
});

test.describe('network', () => {
  test('blocks third-party ad hosts and lets other hosts load', async ({ context, sw, url }) => {
    const page = await context.newPage();
    await page.goto(url('site.test', 'basic.html'));
    await expect.poll(() => page.evaluate(() => window.__net)).toEqual({ ad: 'error', ok: 'load' });
  });

  test('third-party rules leave the vendor\'s own site alone', async ({ context, sw, url }) => {
    const page = await context.newPage();
    await page.goto(url('sb-ads.test', 'basic.html'));
    await expect.poll(() => page.evaluate(() => window.__net.ad)).toBe('load');
  });

  test('first-party Google tag is swapped for a stub that still fires callbacks', async ({ context, sw, url, server }) => {
    const page = await context.newPage();
    await page.goto(url('site.test', 'gtag.html'));
    await expect.poll(() => page.evaluate(() => window.__callback)).toBe(true);
    expect(await page.evaluate(() => window.__ended)).toBe(true);
    expect(await page.evaluate(() => window.__real || [])).not.toContain('G-TEST');
    expect(server.hits.some((h) => h.includes('/gtag/js'))).toBe(false);
  });
});

test.describe('cosmetic', () => {
  test('hides generic token, generic complex and site-specific targets, applies :style()', async ({ context, sw, url }) => {
    const page = await context.newPage();
    await page.goto(url('sb-selftest.test', 'basic.html'));
    await expect.poll(() => display(page, '#tokenProbe')).toBe('none');
    await expect.poll(() => display(page, '#complexProbe')).toBe('none');
    await expect.poll(() => display(page, '#specificProbe')).toBe('none');
    await expect.poll(() => page.$eval('#styleProbe', (el) => getComputedStyle(el).color)).toBe('rgb(1, 2, 3)');
  });

  test('hiding CSS is invisible to the page (user origin, no <style> nodes)', async ({ context, sw, url }) => {
    const page = await context.newPage();
    await page.goto(url('sb-selftest.test', 'basic.html'));
    await expect.poll(() => display(page, '#tokenProbe')).toBe('none');
    const leaks = await page.evaluate(() => ({
      styles: [...document.querySelectorAll('style')].filter((s) => /sb-generic-probe|sb-selftest/.test(s.textContent)).length,
      // v1 stamped these on every element it touched
      attrs: document.querySelectorAll('[data-sb-hidden], [data-sb-neutralized], [data-sb-fb-hidden], [data-sb-checked]').length,
    }));
    expect(leaks).toEqual({ styles: 0, attrs: 0 });
  });

  test('site exceptions subtract generic selectors (token and complex paths)', async ({ context, sw, url }) => {
    const page = await context.newPage();
    await page.goto(url('sb-exception.test', 'basic.html'));
    await page.waitForTimeout(1200);
    expect(await display(page, '#tokenProbe')).toBe('block');
    expect(await display(page, '#complexProbe')).toBe('block');
  });

  test('$ghide turns generic hiding off for a site', async ({ context, sw, url }) => {
    const page = await context.newPage();
    await page.goto(url('sb-ghide.test', 'basic.html'));
    await page.waitForTimeout(1200);
    expect(await display(page, '#tokenProbe')).toBe('block');
    expect(await display(page, '#complexProbe')).toBe('block');
  });
});

test.describe('scriptlets', () => {
  test('run before page scripts, only on their listed hosts', async ({ context, sw, url }) => {
    const listed = await context.newPage();
    await listed.goto(url('sb-selftest.test', 'basic.html'));
    await listed.waitForTimeout(300);
    expect(await listed.evaluate(() => ({ flag: window.__flag, timer: window.__timerRan, other: window.__otherTimerRan })))
      .toEqual({ flag: true, timer: false, other: true });

    const other = await context.newPage();
    await other.goto(url('site.test', 'basic.html'));
    await other.waitForTimeout(300);
    expect(await other.evaluate(() => ({ flag: window.__flag, timer: window.__timerRan }))).toEqual({ flag: false, timer: true });
  });
});

test.describe('no global side effects', () => {
  test('leaves page APIs native and legitimate UI intact on ordinary sites', async ({ context, sw, url }) => {
    const page = await context.newPage();
    await page.goto(url('site.test', 'hygiene.html'));
    await page.waitForTimeout(1500);
    const natives = await page.evaluate(() => window.__natives);
    for (const [name, src] of Object.entries(natives)) expect(src, name).toContain('[native code]');
    expect(await page.evaluate(() => window.__globals)).toEqual([]);
    // v1 blocked these outright
    expect(await page.$eval('#glass', (el) => [...el.classList])).toEqual(['backdrop-blur-md', 'blur-sm']);
    expect(await page.$eval('#lqip', (el) => el.style.filter)).toBe('blur(8px)');
    // v1 forced overflow:auto and deleted anything "whitelist"-y with a z-index
    expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).toBe('hidden');
    expect(await display(page, '#menu')).toBe('block');
  });
});

test.describe('pause on site', () => {
  test('pausing from the popup turns off every layer for that site only', async ({ context, sw, extensionId, url }) => {
    const page = await context.newPage();
    await page.goto(url('sb-selftest.test', 'basic.html'));
    await expect.poll(() => display(page, '#tokenProbe')).toBe('none');

    const tabId = await tabIdFor(sw, '*://sb-selftest.test/*');
    const popup = await openPopup(context, extensionId, tabId);
    await expect(popup.locator('#hostname')).toHaveText('sb-selftest.test');
    await expect(popup.locator('#siteOn')).toBeChecked();
    await popup.locator('#siteOn').click({ force: true });
    await expect(popup.locator('#siteHint')).toHaveText('Paused on this site');
    await expect(popup.locator('#reload')).toBeVisible();

    await page.reload();
    await page.waitForTimeout(1200);
    expect(await page.evaluate(() => window.__net)).toEqual({ ad: 'load', ok: 'load' });
    expect(await page.evaluate(() => ({ flag: window.__flag, timer: window.__timerRan }))).toEqual({ flag: false, timer: true });
    for (const probe of ['#tokenProbe', '#complexProbe', '#specificProbe']) expect(await display(page, probe), probe).toBe('block');

    // Another site is still protected
    const other = await context.newPage();
    await other.goto(url('site.test', 'basic.html'));
    await expect.poll(() => other.evaluate(() => window.__net.ad)).toBe('error');

    // Resume
    await popup.reload();
    await popup.locator('#popup[data-state="ready"]').waitFor();
    await popup.locator('#siteOn').click({ force: true });
    await expect(popup.locator('#siteHint')).toHaveText('Ads and trackers are blocked here');
    await page.reload();
    await expect.poll(() => page.evaluate(() => window.__net.ad)).toBe('error');
  });

  test('a page cannot switch SilentBlock off by dispatching the old v1 event', async ({ context, sw, url }) => {
    const page = await context.newPage();
    await page.goto(url('sb-selftest.test', 'basic.html'));
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('__sb_disable')));
    await page.evaluate(() => { window.sbSelfTest = { flag: false }; });
    expect(await page.evaluate(() => window.sbSelfTest.flag)).toBe(true);
  });
});

test.describe('settings survive updates', () => {
  // State is read through an extension page (same chrome.* APIs): Playwright does not
  // hand back the service worker of a re-installed extension.
  async function reloadExtension(context, sw, extensionId) {
    const page = await reinstallExtension(context);
    await expect.poll(async () => {
      try {
        await page.goto(`chrome-extension://${extensionId}/options/options.html`);
        return await page.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).length);
      } catch { return 0; }
    }, { timeout: 30_000 }).toBeGreaterThan(0);
    return page;
  }
  const snapshot = (page) => page.evaluate(async () => ({
    state: await chrome.storage.local.get(null),
    dynamic: await chrome.declarativeNetRequest.getDynamicRules(),
  }));

  test('extension reload keeps the allowlist and re-applies it', async ({ context, sw, extensionId }) => {
    await sw.evaluate(() => chrome.storage.local.set({ allowlist: ['keep.test'], unwallSites: ['wall.test'] }));
    const page = await reloadExtension(context, sw, extensionId);
    const r = await snapshot(page);
    expect(r.state.allowlist).toEqual(['keep.test']);
    expect(r.state.unwallSites).toEqual(['wall.test']);
    expect(r.dynamic).toHaveLength(1);
    expect(r.dynamic[0].condition.requestDomains).toEqual(['keep.test']);
  });

  test('migrates v1 settings (disabledSites) and clears v1 hashed rules', async ({ context, sw, extensionId }) => {
    await sw.evaluate(async () => {
      await chrome.storage.local.clear();
      await chrome.storage.local.set({ enabled: true, disabledSites: ['old.test', 'www.Example.com'], updateAvailable: '1.6.1' });
      await chrome.declarativeNetRequest.updateDynamicRules({
        addRules: [{ id: 482913, priority: 2, action: { type: 'allowAllRequests' }, condition: { requestDomains: ['old.test'], resourceTypes: ['main_frame', 'sub_frame'] } }],
      });
    });
    const page = await reloadExtension(context, sw, extensionId);
    const r = await snapshot(page);
    expect(r.state).toEqual({
      schema: 2, enabled: true, allowlist: ['old.test', 'www.example.com'],
      categories: { ads: true, privacy: true, annoyances: true }, unwallSites: [], badge: false,
    });
    expect(r.dynamic.map((d) => d.id)).toEqual([1]);
  });
});

test.describe('nag walls', () => {
  test('"Kill nag wall" hides the wall and restores scrolling', async ({ context, sw, extensionId, url }) => {
    const page = await context.newPage();
    await page.goto(url('site.test', 'wall.html'));
    const tabId = await tabIdFor(sw, '*://site.test/*wall*');
    const popup = await openPopup(context, extensionId, tabId);
    await popup.locator('#unwall').click();
    await expect(popup.locator('#unwall')).toHaveText('Done');
    await expect.poll(() => display(page, '#wall')).toBe('none');
    await expect.poll(() => display(page, '#backdrop')).toBe('none');
    expect(await page.evaluate(() => getComputedStyle(document.body).overflowY)).toBe('auto');
    expect(await page.$eval('#content', (el) => getComputedStyle(el).filter)).toBe('none');
  });
});

test.describe('popups', () => {
  const openTabs = (context) => context.pages().map((p) => p.url()).filter((u) => /landing|popup/.test(u));

  test('closes a popup that lands on a $popup host', async ({ context, sw, url }) => {
    const page = await context.newPage();
    await page.goto(url('site.test', 'popup.html'));
    await page.click('#openAd');
    await page.waitForTimeout(1500);
    expect(openTabs(context).filter((u) => u.includes('sb-popads.test'))).toEqual([]);
  });

  test('follows about:blank popups through their redirect', async ({ context, sw, url }) => {
    const page = await context.newPage();
    await page.goto(url('site.test', 'popup.html'));
    await page.click('#blankThenAd');
    await page.waitForTimeout(2000);
    expect(openTabs(context).filter((u) => u.includes('sb-popads.test'))).toEqual([]);
  });

  test('leaves ordinary popups alone', async ({ context, sw, url }) => {
    const page = await context.newPage();
    await page.goto(url('site.test', 'popup.html'));
    const popup = context.waitForEvent('page');
    await page.click('#openOk');
    const p = await popup;
    await p.waitForLoadState();
    await page.waitForTimeout(1000);
    expect(p.isClosed()).toBe(false);
    expect(p.url()).toContain('cdn-ok.test');
  });

  test('undoes a tab-under: the tab comes back, the copy closes', async ({ context, sw, url }) => {
    const page = await context.newPage();
    const start = url('site.test', 'popup.html');
    await page.goto(start);
    await page.click('#tabUnder');
    await expect.poll(() => page.url(), { timeout: 5000 }).toBe(start);
    await page.waitForTimeout(1000);
    expect(openTabs(context).filter((u) => u.includes('sb-popads.test'))).toEqual([]);
    expect(context.pages().filter((p) => p.url() === start)).toHaveLength(1);
  });

  test('a paused site keeps its popups', async ({ context, sw, url }) => {
    await sw.evaluate(async () => {
      await chrome.storage.local.set({ allowlist: ['site.test'] });
    });
    const page = await context.newPage();
    await page.goto(url('site.test', 'popup.html'));
    const popup = context.waitForEvent('page');
    await page.click('#openAd');
    const p = await popup;
    await p.waitForLoadState();
    await page.waitForTimeout(1000);
    expect(p.isClosed()).toBe(false);
  });
});

test.describe('global switch and categories', () => {
  test('protection off disables rulesets and unregisters every script', async ({ context, sw, extensionId, url }) => {
    const page = await context.newPage();
    await page.goto(url('site.test', 'basic.html'));
    const tabId = await tabIdFor(sw, '*://site.test/*');
    const popup = await openPopup(context, extensionId, tabId);
    await popup.locator('#enabled').click({ force: true });
    await expect(popup.locator('#protectionHint')).toHaveText('Off everywhere');
    const r = await sw.evaluate(async () => ({
      rulesets: await chrome.declarativeNetRequest.getEnabledRulesets(),
      scripts: (await chrome.scripting.getRegisteredContentScripts()).length,
    }));
    expect(r).toEqual({ rulesets: [], scripts: 0 });
    await page.reload();
    await expect.poll(() => page.evaluate(() => window.__net.ad)).toBe('load');
  });

  test('options page toggles a category', async ({ context, sw, extensionId }) => {
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options/options.html`);
    await expect(options.locator('.cat')).toHaveCount(3);
    await expect(options.locator('#listRows tr')).not.toHaveCount(0);
    await options.getByLabel('Ads & anti-adblock').click({ force: true });
    await expect.poll(() => sw.evaluate(() => chrome.declarativeNetRequest.getEnabledRulesets())).not.toContain('ads');
    await options.getByLabel('Ads & anti-adblock').click({ force: true });
    await expect.poll(() => sw.evaluate(() => chrome.declarativeNetRequest.getEnabledRulesets())).toContain('ads');
  });

  test('options page adds and removes a paused site', async ({ context, sw, extensionId }) => {
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options/options.html`);
    await options.fill('#pausedInput', 'https://WWW.Paused.test/some/path');
    await options.click('#addPaused button');
    await expect(options.locator('#pausedList li')).toHaveText(/www\.paused\.test/);
    expect((await sw.evaluate(() => chrome.declarativeNetRequest.getDynamicRules()))[0].condition.requestDomains).toEqual(['www.paused.test']);
    await options.getByRole('button', { name: 'Remove www.paused.test' }).click();
    await expect(options.locator('#pausedList li')).toHaveCount(0);
    expect(await sw.evaluate(() => chrome.declarativeNetRequest.getDynamicRules())).toEqual([]);
  });
});

test.describe('message trust', () => {
  test('content scripts cannot change settings', async ({ context, sw, url }) => {
    // Simulate a compromised content script by messaging from a page's isolated world.
    const page = await context.newPage();
    await page.goto(url('site.test', 'basic.html'));
    const tabId = await tabIdFor(sw, '*://site.test/*');
    await sw.evaluate(async (id) => {
      await chrome.scripting.executeScript({
        target: { tabId: id },
        func: () => chrome.runtime.sendMessage({ type: 'setEnabled', enabled: false }),
      });
    }, tabId);
    await page.waitForTimeout(500);
    expect((await sw.evaluate(() => chrome.storage.local.get('enabled'))).enabled).toBe(true);
  });
});
