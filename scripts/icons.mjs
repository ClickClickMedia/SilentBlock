// Renders the toolbar icons: one shield, five states, two hands.
//   node scripts/icons.mjs
// Writes assets/icons/<state>.svg + src/icons/<state>-<size>.png (Chrome and Firefox), and
// assets/icons/edge/<state>.svg + src/icons-edge/<state>-<size>.png (Edge).
//
// The shield is "Tidewater": faceted, with the hand cut clean through so the toolbar itself
// makes the gesture. That only reads if the shield colour is mid-tone (a white finger on a
// light toolbar, a dark one on a dark toolbar), so keep new colours in that band.
//
// Edge Add-ons rejected the middle finger (policy 2.10, store logo, 2026-10-01), so the Edge
// build gets the "polite" hand: every finger up except that one.
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

// Hands in local coordinates, middle finger centred on x=32.
export const HANDS = {
  // The thumb grows out of the palm's lower-left along the index finger so it reads as one
  // fist at 16px.
  classic: [
    '<rect x="23" y="0" width="18" height="54" rx="9"/>',
    '<rect x="7" y="29" width="16.5" height="30" rx="8.25"/>',
    '<rect x="40.5" y="31" width="15" height="28" rx="7.5"/>',
    '<rect x="55" y="37" width="11.5" height="22" rx="5.75"/>',
    '<path d="M7 46 H66.5 V60 C66.5 70 60 77 50 77 H23 C13 77 7 70 7 60 Z"/>',
    '<rect x="3" y="40" width="14.5" height="38" rx="7.25" transform="rotate(-20 10.25 59)"/>',
    '<path d="M5 56 C4 68 9 77 20 77 L20 52 Z"/>',
  ].join(''),
  // The classic fist with the fingers swapped: index, ring and pinky up, middle folded down.
  // Same finger columns, palm and thumb as classic so the two read as one family.
  polite: [
    '<rect x="7" y="6" width="16.5" height="53" rx="8.25"/>',
    '<rect x="23" y="31" width="18" height="28" rx="9"/>',
    '<rect x="40.5" y="4" width="15" height="55" rx="7.5"/>',
    '<rect x="55" y="16" width="11.5" height="43" rx="5.75"/>',
    '<path d="M7 46 H66.5 V60 C66.5 70 60 77 50 77 H23 C13 77 7 70 7 60 Z"/>',
    '<rect x="3" y="40" width="14.5" height="38" rx="7.25" transform="rotate(-20 10.25 59)"/>',
    '<path d="M5 56 C4 68 9 77 20 77 L20 52 Z"/>',
  ].join(''),
};
// Which hand each icon set uses, and where it goes.
const SETS = [
  { hand: 'classic', svgDir: 'assets/icons', pngDir: 'src/icons' },
  { hand: 'polite', svgDir: 'assets/icons/edge', pngDir: 'src/icons-edge' },
];
const SHIELD = 'M64 10 L110 22 L104 80 L64 118 L24 80 L18 22 Z';

export function shieldSvg({ body, facet }, title, hand = 'classic') {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128"><title>${title}</title>` +
    `<defs><mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="128" height="128">` +
    `<rect width="128" height="128" fill="#000"/>` +
    `<path d="${SHIELD}" fill="#fff" stroke="#fff" stroke-width="10" stroke-linejoin="round"/>` +
    `<g fill="#000" transform="translate(64 26) scale(0.8) translate(-32 0)">${HANDS[hand]}</g></mask></defs>` +
    `<g mask="url(#m)"><rect width="128" height="128" fill="${body}"/>` +
    `<path d="M64 4 L116 18 L110 84 L64 126 Z" fill="${facet}"/></g></svg>\n`;
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}` || process.argv[1].endsWith('icons.mjs')) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  for (const { hand, svgDir, pngDir } of SETS) {
    await mkdir(path.join(root, svgDir), { recursive: true });
    await mkdir(path.join(root, pngDir), { recursive: true });
    for (const [state, colours] of Object.entries(STATES)) {
      const svg = shieldSvg(colours, `SilentBlock: ${colours.meaning}`, hand);
      await writeFile(path.join(root, svgDir, `${state}.svg`), svg);
      for (const size of SIZES) {
        await page.setViewportSize({ width: size, height: size });
        await page.setContent(`<html><body style="margin:0;background:transparent"><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="${size}" height="${size}" style="display:block"></body></html>`);
        await page.locator('img').screenshot({ path: path.join(root, pngDir, `${state}-${size}.png`), omitBackground: true });
      }
      console.log(`${hand.padEnd(8)} ${state.padEnd(10)} ${colours.body}  ${colours.meaning}`);
    }
  }
  await browser.close();
}
