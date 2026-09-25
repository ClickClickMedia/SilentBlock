// Persistent settings. One normalised shape, validated on every read and write.
//
// v1 wiped settings on every extension AND browser update (onInstalled reset them
// unconditionally). Here install writes defaults only when nothing is stored, and update
// migrates in place.
import { normaliseHostname } from '../shared/hostnames.js';

export const SCHEMA = 2;

export const TOGGLEABLE = ['ads', 'privacy', 'annoyances'];

export function defaults() {
  return {
    schema: SCHEMA,
    enabled: true,
    allowlist: [],
    categories: { ads: true, privacy: true, annoyances: true },
    unwallSites: [],
    badge: false,
  };
}

function hostList(value) {
  if (!Array.isArray(value)) return [];
  const out = new Set();
  for (const v of value) {
    const h = normaliseHostname(v);
    if (h) out.add(h);
  }
  return [...out].sort();
}

export function normalise(raw) {
  const d = defaults();
  const r = raw && typeof raw === 'object' ? raw : {};
  const categories = { ...d.categories };
  if (r.categories && typeof r.categories === 'object') {
    for (const c of TOGGLEABLE) if (typeof r.categories[c] === 'boolean') categories[c] = r.categories[c];
  }
  return {
    schema: SCHEMA,
    enabled: typeof r.enabled === 'boolean' ? r.enabled : d.enabled,
    allowlist: hostList(r.allowlist),
    categories,
    unwallSites: hostList(r.unwallSites),
    badge: typeof r.badge === 'boolean' ? r.badge : d.badge,
  };
}

export async function loadState() {
  return normalise(await chrome.storage.local.get(null));
}

export async function saveState(patch) {
  const next = normalise({ ...(await loadState()), ...patch });
  await chrome.storage.local.set(next);
  return next;
}

// Called from runtime.onInstalled for every reason (install, update, browser update).
export async function migrate() {
  const raw = await chrome.storage.local.get(null);
  if (raw.schema === SCHEMA) {
    // Still normalise, in case an older build of this schema wrote something odd.
    await chrome.storage.local.set(normalise(raw));
    return;
  }
  // v1.x stored { enabled, disabledSites, updateAvailable, updateUrl }.
  const next = normalise({
    enabled: raw.enabled,
    allowlist: raw.allowlist || raw.disabledSites,
    categories: raw.categories,
    unwallSites: raw.unwallSites,
    badge: raw.badge,
  });
  await chrome.storage.local.clear();
  await chrome.storage.local.set(next);
}

// Allowlisting a hostname covers its subdomains, matching DNR `requestDomains` and the
// `*://*.host/*` match patterns used for content scripts.
export function allowlistEntryFor(hostname, state) {
  if (!hostname) return null;
  let h = hostname;
  for (;;) {
    if (state.allowlist.includes(h)) return h;
    const i = h.indexOf('.');
    if (i === -1) return null;
    h = h.slice(i + 1);
  }
}

export function isPaused(hostname, state) {
  return allowlistEntryFor(hostname, state) !== null;
}
