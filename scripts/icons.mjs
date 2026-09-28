// Renders the toolbar icons: one shield, five states.
//   node scripts/icons.mjs
// Writes assets/icons/<state>.svg (sources) and src/icons/<state>-<size>.png (shipped).
//
// The shield is "Tidewater": faceted, with the hand cut clean through so the toolbar itself
// makes the gesture. That only reads if the shield colour is mid-tone (a white finger on a
// light toolbar, a dark one on a dark toolbar), so keep new colours in that band.
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');

export const STATES = {
  idle:      { body: '#4A6FA5', facet: '#3A5886', meaning: 'Idle, or nothing on this page needed blocking (slate blue)' },
  protected: { body: '#15986A', facet: '#107A55', meaning: 'Ads or trackers blocked (jade)' },
  caution:   { body: '#E39B1F', facet: '#BF7F14', meaning: 'Pushy site: pop-under, tab-under or nag wall dealt with (amber)' },
  danger:    { body: '#A4243B', facet: '#831C2F', meaning: 'Known malware, phishing or scam host (garnet)' },
  paused:    { body: '#8A919A', facet: '#727982', meaning: 'Paused on this site, or protection off (grey)' },
};
const SIZES = [16, 32, 48, 64, 128];

// Hand in local coordinates, middle finger centred on x=32. The thumb grows out of the
// palm's lower-left along the index finger so it reads as one fist at 16px.
const HAND = [
  '<rect x="23" y="0" width="18" height="54" rx="9"/>',
  '<rect x="7" y="29" width="16.5" height="30" rx="8.25"/>',
  '<rect x="40.5" y="31" width="15" height="28" rx="7.5"/>',
  '<rect x="55" y="37" width="11.5" height="22" rx="5.75"/>',
  '<path d="M7 46 H66.5 V60 C66.5 70 60 77 50 77 H23 C13 77 7 70 7 60 Z"/>',
  '<rect x="3" y="40" width="14.5" height="38" rx="7.25" transform="rotate(-20 10.25 59)"/>',
  '<path d="M5 56 C4 68 9 77 20 77 L20 52 Z"/>',
].join('');
const SHIELD = 'M64 10 L110 22 L104 80 L64 118 L24 80 L18 22 Z';

export function shieldSvg({ body, facet }, title) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128"><title>${title}</title>` +
    `<defs><mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="128" height="128">` +
    `<rect width="128" height="128" fill="#000"/>` +
    `<path d="${SHIELD}" fill="#fff" stroke="#fff" stroke-width="10" stroke-linejoin="round"/>` +
    `<g fill="#000" transform="translate(64 26) scale(0.8) translate(-32 0)">${HAND}</g></mask></defs>` +
    `<g mask="url(#m)"><rect width="128" height="128" fill="${body}"/>` +
    `<path d="M64 4 L116 18 L110 84 L64 126 Z" fill="${facet}"/></g></svg>\n`;
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}` || process.argv[1].endsWith('icons.mjs')) {
  await mkdir(path.join(root, 'assets/icons'), { recursive: true });
  await mkdir(path.join(root, 'src/icons'), { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage();
  for (const [state, colours] of Object.entries(STATES)) {
    const svg = shieldSvg(colours, `SilentBlock: ${colours.meaning}`);
    await writeFile(path.join(root, `assets/icons/${state}.svg`), svg);
    for (const size of SIZES) {
      await page.setViewportSize({ width: size, height: size });
      await page.setContent(`<html><body style="margin:0;background:transparent"><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="${size}" height="${size}" style="display:block"></body></html>`);
      await page.locator('img').screenshot({ path: path.join(root, `src/icons/${state}-${size}.png`), omitBackground: true });
    }
    console.log(`${state.padEnd(10)} ${colours.body}  ${colours.meaning}`);
  }
  await browser.close();
}
