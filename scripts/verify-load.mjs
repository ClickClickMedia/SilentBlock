// Loads dist/<target> into headless Chromium through CDP, which reports the exact error
// Chrome would show on chrome://extensions. `--load-extension` just fails silently.
import { chromium } from '@playwright/test';
import path from 'node:path';

const dir = path.resolve(import.meta.dirname, '..', 'dist', process.argv[2] || 'chrome');
const ctx = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true, args: ['--enable-unsafe-extension-debugging'] });
try {
  const cdp = await ctx.browser().newBrowserCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: dir });
  console.log(`OK: loaded ${dir} as ${id}`);
} catch (err) {
  console.error(`FAILED to load ${dir}:\n  ${err.message.split('\n')[0]}`);
  process.exitCode = 1;
} finally {
  await ctx.close();
}
