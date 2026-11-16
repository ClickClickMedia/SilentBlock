// "Nuke this" rules: selector safety, service learning, normalisation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanSelector, cleanToken, registrableDomain, brandOf, pickService, nukeCss, normaliseNuked, siteSelectors, serviceTokenIndex,
} from '../../src/shared/nuke-rules.js';

test('selectors the picker writes are accepted', () => {
  for (const s of [
    'div.pelcro-modal-overlay',
    '#paywall',
    'body > div.wrap > section.modal',
    'body > div:nth-of-type(3) > aside:nth-of-type(1)',
    '#\\31 23abc',             // CSS.escape of an id starting with a digit
    'div.md\\:flex',           // escaped colon
    'div.\\{weird\\}',         // escaped braces are just characters
  ]) assert.equal(cleanSelector(s), s, s);
});

test('selectors that could escape their rule are rejected', () => {
  for (const s of [
    'div{}', 'div}body{display:none', 'a;b', 'div[style]', 'a:has(b)', 'div::before', '@import url(x)',
    'a "b"', "a 'b'", 'a,b', 'html', 'body', ':root', '> div', 'div >', 'div > > p', '', ' ', 'x'.repeat(301),
    'a:nth-of-type(n+1)', 'a/*x*/', 'a\\', null, 42, {},
  ]) assert.equal(cleanSelector(s), null, String(s));
  // Line breaks collapse to a plain descendant combinator rather than surviving into the CSS.
  assert.equal(cleanSelector('div\n  p.x'), 'div p.x');
});

test('service tokens must be plain identifiers', () => {
  assert.equal(cleanToken('.pelcro-root'), '.pelcro-root');
  assert.equal(cleanToken('#tp-modal'), '#tp-modal');
  for (const t of ['pelcro', '.1abc', '.a', '.a{b}', '.a b', '#a,b', '.' + 'a'.repeat(90), 5]) assert.equal(cleanToken(t), null, String(t));
});

test('registrable domains and brands', () => {
  assert.equal(registrableDomain('js.pelcro.com'), 'pelcro.com');
  assert.equal(registrableDomain('cdn.thing.com.au'), 'thing.com.au');
  assert.equal(registrableDomain('a.b.c.co.uk'), 'c.co.uk');
  assert.equal(registrableDomain('thing.io'), 'thing.io');
  assert.equal(brandOf('experience.tinypass.com'), 'tinypass');
});

test('a Pelcro overlay is learned as the Pelcro service', () => {
  const s = pickService('thestraight.com.au', ['js.pelcro.com', 'www.googletagmanager.com', 'servedby.indiegraf.com'],
    ['.pelcro-modal-overlay', '#pelcro-app', '.pelcro-root']);
  assert.deepEqual(s, { domain: 'pelcro.com', name: 'Pelcro', token: '.pelcro-modal-overlay' });
});

test('services are never learned from the site itself, big platforms or generic names', () => {
  // The site's own CDN is not a service.
  assert.equal(pickService('news.example.com', ['cdn.example.com'], ['.example-modal']), null);
  // A Google script plus a google-ish class says nothing about the wall.
  assert.equal(pickService('site.com', ['www.googletagmanager.com', 'fonts.googleapis.com'], ['.google-wall']), null);
  // Short brands match too much.
  assert.equal(pickService('site.com', ['x.ab.io'], ['.ab-modal']), null);
  // No token mentions the vendor.
  assert.equal(pickService('site.com', ['js.pelcro.com'], ['.modal', '#overlay']), null);
  // Brand must be a whole word or prefix, not buried inside another word.
  assert.equal(pickService('site.com', ['cdn.lay.io', 'x.overlay.net'], ['.my-overlays']), null);
});

test('nukeCss writes one rule per selector plus the unlock, and drops bad selectors', () => {
  const css = nukeCss(['div.a', 'div{}', '#b']);
  assert.match(css, /^div\.a\n\{display:none!important\}\n#b\n\{display:none!important\}\n/);
  assert.match(css, /html,body\{overflow:auto!important/);
  assert.doesNotMatch(css, /div\{\}/);
  assert.equal(nukeCss(['div{}']), '');
});

test('normaliseNuked validates everything and keeps a stable order', () => {
  const n = normaliseNuked({
    sites: {
      'Z.com': ['div.a', 'div.a', 'evil{', '#b'],
      'a.com': ['div.x'],
      'bad host': ['div.y'],
      'empty.com': ['}{'],
    },
    services: {
      'pelcro.com': { name: 'Pelcro', tokens: ['.pelcro-root', 'bad token', '.pelcro-root'], from: 'thestraight.com.au', at: '2026-11-16T00:00:00.000Z' },
      'js.pelcro.com': { name: 'x', tokens: ['.a-b'] },        // not a registrable domain
      'google.com': { name: 'Google', tokens: ['.google-x'] }, // never a service
      'nothing.com': { tokens: [] },
      'oddity.com': { name: '<script>', tokens: ['.oddity-x'], at: 'yesterday' },
    },
  });
  assert.deepEqual(n, {
    sites: { 'a.com': ['div.x'], 'z.com': ['div.a', '#b'] },
    services: {
      'oddity.com': { name: 'oddity', tokens: ['.oddity-x'], from: '', at: '' },
      'pelcro.com': { name: 'Pelcro', tokens: ['.pelcro-root'], from: 'thestraight.com.au', at: '2026-11-16T00:00:00.000Z' },
    },
  });
  assert.deepEqual(normaliseNuked('junk'), { sites: {}, services: {} });
});

test('lookups cover parent domains and index service tokens', () => {
  const n = normaliseNuked({ sites: { 'example.com': ['#a'], 'www.example.com': ['#b', '#a'] }, services: { 'pelcro.com': { tokens: ['.pelcro-root'] } } });
  assert.deepEqual(siteSelectors(n, ['www.example.com', 'example.com', 'com']), ['#b', '#a']);
  assert.deepEqual([...serviceTokenIndex(n)], [['.pelcro-root', ['pelcro.com']]]);
});
