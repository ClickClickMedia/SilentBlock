// Popup and tab-under blocking. DNR cannot block a popup, so this watches the tabs a page
// opens and closes any that land on a URL matched by a `$popup` filter, following the new
// tab through its first few hops (ad popups usually start at about:blank and redirect).
//
// Tab-under: the page opens itself in a new tab and sends *your* tab to the ad. If a tab
// that just opened a popup is navigated to an ad, it is sent back and the copy is closed.
import { hostnameAndParents } from '../shared/hostnames.js';
import { loadJSON, getMeta } from './data.js';
import { activeCategories } from './apply.js';
import { isPaused } from './state.js';
import { record } from './status.js';

const WATCH_MS = 8000;     // how long a new tab is followed
const MAX_HOPS = 8;        // navigations followed per new tab
const TAB_UNDER_MS = 3000; // how long after opening a popup the opener is guarded

const watched = new Map(); // popup tabId -> { openerTabId, openerHost, until, hops }
const openers = new Map(); // opener tabId -> { url, host, popupTabId, until }

// Registrable-domain approximation for first/third-party checks (no PSL in the worker).
const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'id', 'asn']);
export function siteOf(host) {
  const parts = host.split('.');
  if (parts.length > 2 && parts[parts.length - 1].length === 2 && SECOND_LEVEL.has(parts[parts.length - 2])) {
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}

let compiled = null;
let compiledKey = '';
async function filtersFor(state) {
  const meta = await getMeta();
  const cats = activeCategories(state, meta).filter((c) => meta.popups?.[c]);
  const key = cats.join(',');
  if (compiled && compiledKey === key) return compiled;
  const c = { hosts: new Set(), hosts3p: new Set(), rules: [], allow: [] };
  const toRule = ([re, inc, exc, party]) => ({ re: new RegExp(re, 'i'), inc, exc, party });
  for (const cat of cats) {
    const data = await loadJSON(`popups/${cat}.json`);
    data.hosts.forEach((h) => c.hosts.add(h));
    data.hosts3p.forEach((h) => c.hosts3p.add(h));
    c.rules.push(...data.rules.map(toRule));
    c.allow.push(...data.allow.map(toRule));
  }
  compiled = c;
  compiledKey = key;
  return c;
}

function ruleMatches(r, url, host, openerHost) {
  if (!r.re.test(url)) return false;
  const openerChain = hostnameAndParents(openerHost);
  if (r.inc.length && !openerChain.some((h) => r.inc.includes(h))) return false;
  if (r.exc.length && openerChain.some((h) => r.exc.includes(h))) return false;
  if (r.party === 3 && siteOf(host) === siteOf(openerHost)) return false;
  if (r.party === 1 && siteOf(host) !== siteOf(openerHost)) return false;
  return true;
}

export async function isAdPopup(url, openerHost, state) {
  if (!/^https?:/i.test(url)) return false;
  const c = await filtersFor(state);
  const host = new URL(url).hostname;
  if (c.allow.some((r) => ruleMatches(r, url, host, openerHost))) return false;
  const chain = hostnameAndParents(host);
  if (chain.some((h) => c.hosts.has(h))) return true;
  if (siteOf(host) !== siteOf(openerHost) && chain.some((h) => c.hosts3p.has(h))) return true;
  return c.rules.some((r) => ruleMatches(r, url, host, openerHost));
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

async function topUrl(tabId) {
  try { return (await chrome.webNavigation.getFrame({ tabId, frameId: 0 })).url; } catch { return ''; }
}

// Last committed http(s) URL per tab. Kept synchronously from onCommitted so a popup's
// opener can be registered before any await: a tab-under sends the opener to the ad
// immediately after window.open, and an async lookup here would lose that race.
const lastCommitted = new Map();
export function noteCommitted(tabId, url) { lastCommitted.set(tabId, url); }
export function lastUrlOf(tabId) { return lastCommitted.get(tabId) || ''; }

function register(d, openerUrl) {
  const now = Date.now();
  const openerHost = hostOf(openerUrl);
  watched.set(d.tabId, { openerTabId: d.sourceTabId, openerHost, until: now + WATCH_MS, hops: 0 });
  openers.set(d.sourceTabId, { url: openerUrl, host: openerHost, popupTabId: d.tabId, until: now + TAB_UNDER_MS });
}

export async function onCreatedNavigationTarget(d, statePromise) {
  let openerUrl = lastCommitted.get(d.sourceTabId) || '';
  if (/^https?:/i.test(openerUrl)) register(d, openerUrl); // synchronous, before any await
  const state = await statePromise;
  if (!openerUrl) {
    openerUrl = await topUrl(d.sourceTabId); // worker was asleep: ask the browser
    if (/^https?:/i.test(openerUrl)) register(d, openerUrl);
  }
  const openerHost = hostOf(openerUrl);
  if (!state.enabled || !/^https?:/i.test(openerUrl) || !openerHost || isPaused(openerHost, state)) {
    watched.delete(d.tabId);
    openers.delete(d.sourceTabId);
    return;
  }
  await onTopNavigation(d.tabId, d.url, state);
}

// Called for every top-level navigation (before it starts, and when it commits, which also
// catches server-side redirects).
export async function onTopNavigation(tabId, url, state) {
  const w = watched.get(tabId);
  if (w) {
    if (Date.now() > w.until || ++w.hops > MAX_HOPS) {
      watched.delete(tabId);
    } else if (await isAdPopup(url, w.openerHost, state)) {
      watched.delete(tabId);
      await chrome.tabs.remove(tabId).catch(() => {});
      await record(w.openerTabId, 'popup', null, state);
      return;
    }
  }

  const o = openers.get(tabId);
  if (!o) return;
  if (Date.now() > o.until) { openers.delete(tabId); return; }
  if (url === o.url || !(await isAdPopup(url, o.host, state))) return;
  openers.delete(tabId);
  await chrome.tabs.update(tabId, { url: o.url }).catch(() => {});
  setTimeout(() => { record(tabId, 'popup', null, state); }, 1500); // after the restored page resets its status
  // The popup is usually the page itself, opened so it survives the redirect. Close it.
  const popup = await chrome.tabs.get(o.popupTabId).catch(() => null);
  if (popup && hostOf(popup.pendingUrl || popup.url) === o.host) await chrome.tabs.remove(popup.id).catch(() => {});
}

// A watched popup whose navigation DNR blocked outright is just an error page: close it.
export async function onNavigationError(d, state) {
  if (d.frameId !== 0 || !watched.has(d.tabId) || !/BLOCKED_BY_CLIENT/.test(d.error || '')) return;
  const w = watched.get(d.tabId);
  watched.delete(d.tabId);
  await chrome.tabs.remove(d.tabId).catch(() => {});
  if (state) await record(w.openerTabId, 'popup', null, state);
}

export function forgetPopupTab(tabId) {
  watched.delete(tabId);
  openers.delete(tabId);
  lastCommitted.delete(tabId);
}
