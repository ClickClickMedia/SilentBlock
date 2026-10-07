// Renders the store images from the real extension pages.
//   npm run store:art      -> release/store-art/*.png       (Chrome Web Store, Firefox; from dist/chrome)
//                             release/store-art/edge/*.png  (Edge Add-ons; from dist/edge, polite icons)
//
// The popup and options pages run with a stubbed `chrome` API so each shot shows a chosen
// state. Hostnames use example.com and example.net (reserved for documentation) so no real
// site appears in a listing.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const ORIGIN = 'https://silentblock.art';
const SETS = [
  { dist: 'dist/chrome', icons: 'assets/icons', out: 'release/store-art' },
  { dist: 'dist/edge', icons: 'assets/icons/edge', out: 'release/store-art/edge' },
];
const browser = await chromium.launch();
for (const set of SETS) {
  console.log(`${set.out}/`);
  await render(path.join(root, set.dist), path.join(root, set.icons), path.join(root, set.out));
}
await browser.close();

async function render(dist, iconDir, out) {
  await mkdir(out, { recursive: true });

  const meta = JSON.parse(await readFile(path.join(dist, 'meta.json'), 'utf8'));
  const svg = async (state) => `data:image/svg+xml;base64,${(await readFile(path.join(iconDir, `${state}.svg`))).toString('base64')}`;
  const ICON = Object.fromEntries(await Promise.all(['idle', 'protected', 'caution', 'danger', 'paused'].map(async (s) => [s, await svg(s)])));

  function popupState(status, host) {
    return { enabled: true, version: meta.version, supported: true, hostname: host, pausedBy: null, unwall: false, status };
  }
  const STATES = {
    protected: popupState({ blocked: 47, popups: 0, walls: 0, danger: 0, dangerHosts: [], level: 'protected', icon: 'protected' }, 'news.example.com'),
    caution: popupState({ blocked: 31, popups: 2, walls: 1, danger: 0, dangerHosts: [], level: 'caution', icon: 'caution' }, 'streams.example.net'),
    danger: popupState({ blocked: 12, popups: 0, walls: 0, danger: 3, dangerHosts: ['cdn-payload.example.net'], level: 'danger', icon: 'danger' }, 'free-downloads.example.net'),
  };
  const stub = (popupData) => `
    window.chrome = {
      runtime: {
        sendMessage: async (m) => m.type === 'popup:get' ? ${JSON.stringify(popupData)}
          : m.type === 'settings:get' ? { state: { enabled: true, allowlist: ['intranet.example.com'], categories: { ads: true, privacy: true, annoyances: true, security: true }, unwallSites: ['recipes.example.com'], badge: false, statusIcon: true }, meta: ${JSON.stringify(meta)} }
          : {},
        openOptionsPage() {},
      },
      tabs: { query: async () => [{ id: 1 }], reload: async () => {}, getCurrent: async () => ({ id: 1 }) },
    };`;

  async function capture(pagePath, { width, height, data, scale = 2, colorScheme = 'light' }) {
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, colorScheme });
    await ctx.route(`${ORIGIN}/**`, async (route) => {
      const rel = new URL(route.request().url()).pathname.slice(1);
      const type = rel.endsWith('.html') ? 'text/html' : rel.endsWith('.css') ? 'text/css' : rel.endsWith('.js') ? 'text/javascript' : rel.endsWith('.png') ? 'image/png' : 'application/octet-stream';
      try { await route.fulfill({ body: await readFile(path.join(dist, rel)), contentType: type }); } catch { await route.fulfill({ status: 404 }); }
    });
    const page = await ctx.newPage();
    if (data !== undefined) await page.addInitScript(stub(data));
    await page.goto(`${ORIGIN}/${pagePath}`);
    await page.waitForTimeout(600);
    const png = await page.screenshot({ fullPage: false });
    await ctx.close();
    return `data:image/png;base64,${png.toString('base64')}`;
  }

  const shots = {
    protected: await capture('popup/popup.html?tabId=1', { width: 300, height: 330, data: STATES.protected }),
    caution: await capture('popup/popup.html?tabId=1', { width: 300, height: 330, data: STATES.caution }),
    danger: await capture('popup/popup.html?tabId=1', { width: 300, height: 330, data: STATES.danger }),
    options: await capture('options/options.html', { width: 760, height: 900, data: null, scale: 1.5 }),
    warning: await capture(`warning/warning.html?u=${encodeURIComponent('https://free-prize-claim.example.net/login')}&h=example.net`, { width: 900, height: 620, scale: 1.5 }),
  };

  const FONT = `"Segoe UI", system-ui, -apple-system, Roboto, sans-serif`;
  const frame = (w, h, inner) => `<!doctype html><html><head><style>
    * { box-sizing: border-box; margin: 0; }
    /* Light, toolbar-like ground: the icon's finger is cut out, so it needs a light background to read. */
    body { width: ${w}px; height: ${h}px; overflow: hidden; font-family: ${FONT}; color: #1b2536;
      background: radial-gradient(120% 90% at 85% 10%, #ffffff 0%, #eef2f8 48%, #dbe3ef 100%); }
    h1 em { font-style: normal; color: #4A6FA5; }
    .shadow { box-shadow: 0 30px 70px rgba(30, 50, 90, .22), 0 3px 10px rgba(30, 50, 90, .14); border-radius: 14px; }
    h1 { font-weight: 800; letter-spacing: -.02em; line-height: 1.05; }
    p { color: #4a5568; line-height: 1.45; }
  </style></head><body>${inner}</body></html>`;

  const pages = {
    'screenshot-1-blocks': frame(1280, 800, `
      <div style="display:flex;align-items:center;gap:80px;height:100%;padding:0 110px">
        <div style="flex:1">
          <img src="${ICON.protected}" width="96" height="96" alt="">
          <h1 style="font-size:64px;margin-top:26px">Ads gone.<br><em>Silently.</em></h1>
          <p style="font-size:24px;margin-top:22px;max-width:520px">Ads, trackers, pop-ups and cookie banners are blocked before they load. No nags, no account, nothing leaves your browser.</p>
        </div>
        <img class="shadow" src="${shots.protected}" width="330" alt="">
      </div>`),
    'screenshot-2-status': frame(1280, 800, `
      <div style="display:flex;flex-direction:column;justify-content:center;height:100%;padding:0 110px;gap:46px">
        <div><h1 style="font-size:54px">One look tells you what happened</h1>
        <p style="font-size:22px;margin-top:14px">The icon changes colour with every page.</p></div>
        <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:26px">
          ${[['idle', 'Nothing to block'], ['protected', 'Ads and trackers blocked'], ['caution', 'Pushy site handled'], ['danger', 'Dangerous site blocked'], ['paused', 'Paused']].map(([s, l]) => `
            <div style="background:#fff;border-radius:18px;padding:30px 16px;text-align:center;box-shadow:0 10px 30px rgba(30,50,90,.1)">
              <img src="${ICON[s]}" width="112" height="112" alt="">
              <p style="font-size:20px;font-weight:600;margin-top:18px;color:#1b2536">${l}</p></div>`).join('')}
        </div></div>`),
    'screenshot-3-malware': frame(1280, 800, `
      <div style="display:flex;align-items:center;gap:60px;height:100%;padding:0 80px">
        <div style="flex:0 0 420px">
          <h1 style="font-size:52px">Stops dangerous sites before they load</h1>
          <p style="font-size:22px;margin-top:20px">Known malware, phishing and scam sites are checked on your device. Your browsing is never sent anywhere to be checked.</p>
        </div>
        <img class="shadow" src="${shots.warning}" width="700" alt="">
      </div>`),
    'screenshot-4-pushy': frame(1280, 800, `
      <div style="display:flex;align-items:center;gap:80px;height:100%;padding:0 110px">
        <img class="shadow" src="${shots.caution}" width="330" alt="">
        <div style="flex:1">
          <h1 style="font-size:56px">Pop-ups and nag walls, handled</h1>
          <p style="font-size:24px;margin-top:22px;max-width:560px">Pop-unders get closed, tab-unders get undone, and "turn off your ad blocker" walls come down with one click, or on their own on sites you choose.</p>
        </div>
      </div>`),
    'screenshot-5-settings': frame(1280, 800, `
      <div style="display:flex;align-items:center;gap:60px;height:100%;padding:0 80px">
        <div style="flex:0 0 400px">
          <h1 style="font-size:52px">Free. Open source. No strings.</h1>
          <p style="font-size:22px;margin-top:20px">More than 120,000 filters from EasyList, EasyPrivacy and uBlock Origin, bundled with each release. Pause any site with one switch.</p>
        </div>
        <img class="shadow" src="${shots.options}" width="640" style="max-height:700px;object-fit:cover;object-position:top" alt="">
      </div>`),
    'promo-small-440x280': frame(440, 280, `
      <div style="display:flex;align-items:center;gap:22px;height:100%;padding:0 34px">
        <img src="${ICON.idle}" width="104" height="104" alt="" style="filter:drop-shadow(0 6px 14px rgba(30,50,90,.2))">
        <div><h1 style="font-size:38px">SilentBlock</h1><p style="font-size:17px;margin-top:8px">Ads gone. <b style="color:#4A6FA5">Silently.</b></p></div>
      </div>`),
    'promo-marquee-1400x560': frame(1400, 560, `
      <div style="display:flex;align-items:center;gap:70px;height:100%;padding:0 120px">
        <img src="${ICON.protected}" width="170" height="170" alt="" style="filter:drop-shadow(0 10px 24px rgba(30,50,90,.22))">
        <div style="flex:1"><h1 style="font-size:78px">SilentBlock</h1>
        <p style="font-size:28px;margin-top:14px">Ads, trackers, pop-ups and malware, blocked. Silently.</p></div>
        <img class="shadow" src="${shots.danger}" width="300" alt="">
      </div>`),
  };

  const sizes = { 'promo-small-440x280': [440, 280], 'promo-marquee-1400x560': [1400, 560] };
  for (const [name, html] of Object.entries(pages)) {
    const [w, h] = sizes[name] || [1280, 800];
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    await page.setContent(html);
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(out, `${name}.png`) });
    await page.close();
    console.log(`${name}.png  ${w}x${h}`);
  }
  // Store icons: Edge wants 300x300, Chrome's listing icon is 128x128, Firefox asks for 32 and 64.
  for (const [name, size] of [['logo-300', 300], ['icon-128', 128], ['icon-64', 64], ['icon-32', 32]]) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(`<body style="margin:0;background:transparent"><img src="${ICON.idle}" width="${size}" height="${size}" style="display:block"></body>`);
    await page.locator('img').screenshot({ path: path.join(out, `${name}.png`), omitBackground: true });
    await page.close();
    console.log(`${name}.png  ${size}x${size}`);
  }
}
