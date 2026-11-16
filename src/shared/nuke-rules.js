// "Nuke this": rules the user made by clicking things away. Shared by the service worker
// and the unit tests. Dependency-free, like hostnames.js.
//
// Two kinds of rule:
//   sites     hostname -> CSS selectors picked on that site (applied to its top frame)
//   services  vendor domain -> class/id tokens of that vendor's overlay. Learned when the
//             nuked element is named after a third-party script on the page (.pelcro-*
//             while js.pelcro.com is loaded), then hidden on any page that shows the token.
//
// Selectors and tokens come from the page, so they are validated here, in the worker,
// before they go anywhere near CSS. The picker is just a messenger.
import { normaliseHostname } from './hostnames.js';

export const LIMITS = { selectorsPerSite: 50, sites: 2000, services: 100, tokensPerService: 6, selectorLength: 300 };

// Only the grammar the picker writes: identifiers (CSS.escape'd), # . > spaces, :nth-of-type(n).
// No quotes, brackets, braces or semicolons, so a selector can never close its rule or
// open a new one.
const ESCAPE_RE = /\\(?:[0-9a-fA-F]{1,6} ?|[^\n\r\f0-9a-fA-F])/g;
const NTH_RE = /:nth-of-type\(\d{1,3}\)/g;
const SAFE_RE = /^[A-Za-z0-9_\-#.>  -￿]+$/;

export function cleanSelector(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim().replace(/\s+/g, ' ');
  if (!s || s.length > LIMITS.selectorLength) return null;
  const bare = s.replace(ESCAPE_RE, 'x').replace(NTH_RE, '');
  if (!SAFE_RE.test(bare)) return null;
  if (/^[>]|[>]$|>\s*>/.test(bare.trim())) return null;
  // Nuking the whole page is never what someone meant.
  if (/^(?:html|body|:root)$/i.test(s)) return null;
  return s;
}

// Tokens are reported raw by content/generic.js ("#id", ".class"). Service tokens are used as
// selectors as-is, so only plain identifiers qualify (no escaping available in the worker).
const TOKEN_RE = /^[.#][A-Za-z_][A-Za-z0-9_-]{1,80}$/;
export function cleanToken(t) {
  return typeof t === 'string' && TOKEN_RE.test(t) ? t : null;
}

// Second-level labels under a two-letter country code that people register beneath:
// pelcro.com.au -> registrable "pelcro.com.au", brand "pelcro".
const SLD = new Set(['com', 'net', 'org', 'co', 'gov', 'edu', 'ac', 'asn', 'id', 'or', 'ne', 'go']);

export function registrableDomain(hostname) {
  const parts = String(hostname || '').toLowerCase().split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const tld = parts[parts.length - 1];
  const sld = parts[parts.length - 2];
  const n = tld.length === 2 && SLD.has(sld) ? 3 : 2;
  return parts.slice(-n).join('.');
}

export function brandOf(hostname) {
  return registrableDomain(hostname).split('.')[0] || '';
}

// Hosts that serve half the web. A class named after one of these says nothing about who
// drew the wall, so they are never learned as a service.
export const NEVER_A_SERVICE = new Set([
  'google', 'googleapis', 'gstatic', 'googletagmanager', 'googlesyndication', 'googleadservices', 'doubleclick',
  'youtube', 'ytimg', 'facebook', 'fbcdn', 'instagram', 'twitter', 'twimg', 'linkedin', 'tiktok', 'pinterest',
  'cloudflare', 'cloudflareinsights', 'cloudfront', 'amazonaws', 'amazon', 'akamai', 'akamaihd', 'akamaized',
  'fastly', 'jsdelivr', 'unpkg', 'cdnjs', 'jquery', 'bootstrapcdn', 'fontawesome', 'typekit', 'fonts',
  'wordpress', 'wpcom', 'jetpack', 'gravatar', 'wix', 'wixstatic', 'squarespace', 'shopify', 'shopifycdn',
  'microsoft', 'msecnd', 'azureedge', 'apple', 'polyfill', 'recaptcha', 'hcaptcha', 'vimeo', 'github', 'githubusercontent',
  'cdn', 'static', 'assets', 'media', 'images', 'img', 'api', 'www', 'app', 'apps', 'web', 'site', 'page', 'modal', 'popup',
]);

function tokenMentions(token, brand) {
  const words = token.slice(1).toLowerCase().split(/[-_]+/);
  return words.includes(brand) || words[0].startsWith(brand);
}

// Pick the vendor behind a nuked element. `tokens` are the element's own tokens first, then
// same-size wrappers, then children; `hosts` are third-party script/frame hosts on the page.
export function pickService(pageHost, hosts, tokens) {
  const own = registrableDomain(pageHost);
  const brands = new Map(); // brand -> registrable domain
  for (const h of Array.isArray(hosts) ? hosts.slice(0, 200) : []) {
    const host = normaliseHostname(h);
    if (!host) continue;
    const domain = registrableDomain(host);
    const brand = brandOf(host);
    if (domain === own || brand.length < 4 || NEVER_A_SERVICE.has(brand)) continue;
    if (!brands.has(brand)) brands.set(brand, domain);
  }
  if (!brands.size) return null;
  for (const raw of Array.isArray(tokens) ? tokens.slice(0, 60) : []) {
    const token = cleanToken(raw);
    if (!token) continue;
    for (const [brand, domain] of brands) {
      if (tokenMentions(token, brand)) return { domain, name: brand.charAt(0).toUpperCase() + brand.slice(1), token };
    }
  }
  return null;
}

function hideRule(selectors) {
  return selectors.length ? `${selectors.join(',\n')}\n{display:none!important}\n` : '';
}

// Walls lock scrolling and blur the article; once something is nuked, undo both. User-origin
// !important beats the page's own !important, inline styles included.
export const UNLOCK_CSS = 'html,body{overflow:auto!important;overflow-y:auto!important}\n'
  + '[style*="blur("]{filter:none!important;-webkit-filter:none!important;pointer-events:auto!important;user-select:auto!important}\n';

// One rule per selector: a selector one browser rejects then voids only itself.
export function nukeCss(selectors) {
  const clean = selectors.map(cleanSelector).filter(Boolean);
  if (!clean.length) return '';
  return clean.map((s) => hideRule([s])).join('') + UNLOCK_CSS;
}

export function emptyNuked() {
  return { sites: {}, services: {} };
}

export function normaliseNuked(raw) {
  const out = emptyNuked();
  const r = raw && typeof raw === 'object' ? raw : {};
  const sites = r.sites && typeof r.sites === 'object' ? r.sites : {};
  for (const [h, list] of Object.entries(sites).slice(0, LIMITS.sites)) {
    const host = normaliseHostname(h);
    if (!host || !Array.isArray(list)) continue;
    const sel = [...new Set([...(out.sites[host] || []), ...list.map(cleanSelector).filter(Boolean)])].slice(0, LIMITS.selectorsPerSite);
    if (sel.length) out.sites[host] = sel;
  }
  const services = r.services && typeof r.services === 'object' ? r.services : {};
  for (const [d, svc] of Object.entries(services).slice(0, LIMITS.services)) {
    const domain = normaliseHostname(d);
    if (!domain || !svc || typeof svc !== 'object' || !Array.isArray(svc.tokens)) continue;
    const brand = brandOf(domain);
    if (brand.length < 4 || NEVER_A_SERVICE.has(brand) || registrableDomain(domain) !== domain) continue;
    const tokens = [...new Set(svc.tokens.map(cleanToken).filter(Boolean))].slice(0, LIMITS.tokensPerService);
    if (!tokens.length) continue;
    out.services[domain] = {
      name: typeof svc.name === 'string' && /^[\w .-]{1,40}$/.test(svc.name) ? svc.name : brand,
      tokens,
      from: normaliseHostname(svc.from) || '',
      at: typeof svc.at === 'string' && !Number.isNaN(Date.parse(svc.at)) ? svc.at : '',
    };
  }
  // Stable order so saved state compares cleanly.
  out.sites = Object.fromEntries(Object.entries(out.sites).sort(([a], [b]) => a.localeCompare(b)));
  out.services = Object.fromEntries(Object.entries(out.services).sort(([a], [b]) => a.localeCompare(b)));
  return out;
}

// Selectors that apply to `hostname` (its own rules and its parents').
export function siteSelectors(nuked, hostnames) {
  const out = [];
  for (const h of hostnames) for (const s of nuked.sites[h] || []) out.push(s);
  return [...new Set(out)];
}

// token -> [domain] for every learned service.
export function serviceTokenIndex(nuked) {
  const idx = new Map();
  for (const [domain, svc] of Object.entries(nuked.services)) {
    for (const t of svc.tokens) {
      if (!idx.has(t)) idx.set(t, []);
      idx.get(t).push(domain);
    }
  }
  return idx;
}
