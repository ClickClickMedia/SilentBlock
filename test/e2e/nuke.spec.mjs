// "Nuke this": the picker, what it remembers (site and vendor), undo, and who may save.
import { test, expect, openPopup, tabIdFor, display } from './fixtures.mjs';

const EMPTY = { sites: {}, services: {} };
const nukedState = (sw) => sw.evaluate(async () => (await chrome.storage.local.get('nuked')).nuked);
const vendorLoaded = (page) => expect.poll(() => page.evaluate(() => (window.__real || []).includes('/script/paywall.js'))).toBe(true);
const overflowY = (page) => page.evaluate(() => getComputedStyle(document.body).overflowY);
const watchSelect = (page) => page.evaluate(() => {
  window.__selected = false;
  document.getElementById('select').addEventListener('click', () => { window.__selected = true; });
});

// Sends what the picker's isolated world would send, from the tab's top frame.
const fromPicker = (sw, tabId, message) => sw.evaluate(async ([id, msg]) => {
  const [r] = await chrome.scripting.executeScript({ target: { tabId: id }, func: (m) => chrome.runtime.sendMessage(m), args: [msg] });
  return r.result;
}, [tabId, message]);

async function pressNuke(context, extensionId, tabId) {
  const popup = await openPopup(context, extensionId, tabId);
  await popup.locator('#nuke').click();
  await expect(popup.locator('#nuke')).toHaveText('Click it on the page');
  await popup.close();
}

async function openAndArm({ context, sw, extensionId, url }, host) {
  const page = await context.newPage();
  await page.goto(url(host, 'nuke.html'));
  await vendorLoaded(page);
  const tabId = await tabIdFor(sw, `*://${host}/*`);
  await pressNuke(context, extensionId, tabId);
  await expect(page.locator('silentblock-nuke')).toHaveCount(1);
  return { page, tabId };
}

async function clickModal(page) {
  const box = await page.locator('.paywallco-modal').boundingBox();
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.click(box.x + 20, box.y + 20);
}

test('one click takes out the whole overlay, unlocks the page, and is remembered for the site and the vendor', async ({ context, sw, extensionId, url }) => {
  const fx = { context, sw, extensionId, url };
  const { page } = await openAndArm(fx, 'site.test');
  await watchSelect(page);

  // Click inside the dialog box: the pick grows to the full-screen overlay holding it.
  await clickModal(page);
  await expect.poll(() => display(page, '.paywallco-overlay')).toBe('none');
  expect(await page.evaluate(() => window.__selected)).toBe(false); // the page never got the click
  expect(await overflowY(page)).toBe('auto');
  expect(await page.$eval('#story', (el) => getComputedStyle(el).filter)).toBe('none');
  expect(await display(page, '#promo')).toBe('block');

  await expect.poll(() => nukedState(sw)).toMatchObject({
    sites: { 'site.test': ['div.paywallco-overlay'] },
    services: { 'paywallco.test': { name: 'Paywallco', tokens: ['.paywallco-overlay'], from: 'site.test' } },
  });

  // Reload: gone with no clicking. User-origin CSS beats the page's own inline !important.
  await page.reload();
  await vendorLoaded(page);
  await expect.poll(() => display(page, '.paywallco-overlay')).toBe('none');
  expect(await overflowY(page)).toBe('auto');
  expect(await page.$eval('#story', (el) => getComputedStyle(el).filter)).toBe('none');
  expect(await page.locator('silentblock-nuke').count()).toBe(0);

  // Another site on the same vendor: nuked by the learned service, nothing else touched.
  const other = await context.newPage();
  await other.goto(url('other.test', 'nuke.html'));
  await expect.poll(() => display(other, '.paywallco-overlay')).toBe('none');
  expect(await overflowY(other)).toBe('auto');
  expect(await display(other, '#promo')).toBe('block');
  const popup = await openPopup(context, extensionId, await tabIdFor(sw, '*://other.test/*'));
  await expect(popup.locator('#nukedText')).toHaveText('Paywallco walls nuked');
  await expect(popup.locator('#nukedUndo')).toBeHidden();
});

test('Esc cancels the picker and the page gets its clicks back', async ({ context, sw, extensionId, url }) => {
  const fx = { context, sw, extensionId, url };
  const { page } = await openAndArm(fx, 'site.test');
  await page.keyboard.press('Escape');
  await expect(page.locator('silentblock-nuke')).toHaveCount(0);
  await watchSelect(page);
  await page.click('#select');
  expect(await page.evaluate(() => window.__selected)).toBe(true);
  expect(await nukedState(fx.sw)).toEqual(EMPTY);
});

test('undo right after a nuke forgets the site rule and the service it taught', async ({ context, sw, extensionId, url }) => {
  const fx = { context, sw, extensionId, url };
  const { page, tabId } = await openAndArm(fx, 'site.test');
  await clickModal(page);
  await expect.poll(() => nukedState(sw)).toMatchObject({ sites: { 'site.test': ['div.paywallco-overlay'] } });
  // The toast (and its Undo) only appears once the save has answered; wait for that point.
  await expect.poll(() => sw.evaluate(async (id) => Boolean((await chrome.storage.session.get(`nukeLast:${id}`))[`nukeLast:${id}`]), tabId)).toBe(true);

  // The toast lives in a closed shadow root; send what its Undo button sends.
  expect(await fromPicker(sw, tabId, { type: 'nuke:undo', selector: 'div.paywallco-overlay' })).toEqual({ ok: true });
  expect(await nukedState(sw)).toEqual(EMPTY);
  await page.reload();
  await vendorLoaded(page);
  await page.waitForTimeout(800);
  expect(await display(page, '.paywallco-overlay')).toBe('flex');
  // Undo is one-shot.
  expect((await fromPicker(sw, tabId, { type: 'nuke:undo', selector: 'div.paywallco-overlay' })).error).toBe('Nothing to undo');
});

test('a page cannot save a nuke unless the popup armed its tab, and one arm is one save', async ({ context, sw, extensionId, url }) => {
  const page = await context.newPage();
  await page.goto(url('site.test', 'nuke.html'));
  const tabId = await tabIdFor(sw, '*://site.test/*');
  const save = { type: 'nuke:save', selector: 'div.paywallco-overlay', tokens: ['.paywallco-overlay'], hosts: ['paywallco.test'] };
  expect((await fromPicker(sw, tabId, save)).error).toBe('Not armed');
  expect(await nukedState(sw)).toEqual(EMPTY);

  await pressNuke(context, extensionId, tabId);
  expect((await fromPicker(sw, tabId, { ...save, selector: 'div}body{display:none' })).error).toBe('Bad selector');
  expect((await fromPicker(sw, tabId, save)).ok).toBe(true);
  expect((await fromPicker(sw, tabId, { ...save, selector: '#promo' })).error).toBe('Not armed');
  expect((await nukedState(sw)).sites).toEqual({ 'site.test': ['div.paywallco-overlay'] });
});

test('popup shows what is nuked here and Undo clears the site', async ({ context, sw, extensionId, url }) => {
  await sw.evaluate(() => chrome.storage.local.set({ nuked: { sites: { 'site.test': ['#promo', 'div.paywallco-overlay'] }, services: {} } }));
  const page = await context.newPage();
  await page.goto(url('site.test', 'nuke.html'));
  await expect.poll(() => display(page, '#promo')).toBe('none');
  const popup = await openPopup(context, extensionId, await tabIdFor(sw, '*://site.test/*'));
  await expect(popup.locator('#nukedText')).toHaveText('2 things nuked here');
  await popup.locator('#nukedUndo').click();
  await expect(popup.locator('#reload')).toBeVisible();
  await expect(popup.locator('#nukedRow')).toBeHidden();
  expect(await nukedState(sw)).toEqual(EMPTY);
});

test('settings list nuked sites and services and remove them', async ({ context, sw, extensionId }) => {
  await sw.evaluate(() => chrome.storage.local.set({ nuked: {
    sites: { 'site.test': ['#promo'] },
    services: { 'paywallco.test': { name: 'Paywallco', tokens: ['.paywallco-overlay'], from: 'site.test', at: '2026-11-16T00:00:00.000Z' } },
  } }));
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options/options.html`);
  await expect(options.locator('#nukedSites li')).toHaveText(/site\.test \(1 thing\)/);
  await expect(options.locator('#nukedServices li')).toHaveText(/Paywallco \(paywallco\.test\), learned on site\.test/);
  await options.getByRole('button', { name: 'Remove paywallco.test' }).click();
  await expect(options.locator('#nukedServices li')).toHaveCount(0);
  const after = await nukedState(sw);
  expect(after.services).toEqual({});
  expect(after.sites).toEqual({ 'site.test': ['#promo'] });
});
