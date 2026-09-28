// Malware, phishing and scam protection.
//
// Hosts on the security lists are blocked by DNR at priority 2000, above list exceptions
// and above a user's pause (1000): pausing a site is about ads, not safety. The ~35k
// individual page URLs from the phishing and URLhaus lists are too many for DNR, so top-level
// navigations are checked against them here. Either way the tab is sent to a warning page,
// where the user can go back or continue for the rest of the browser session.
import { hostnameAndParents } from '../shared/hostnames.js';
import { pathMatches } from '../shared/url-match.js';
import { loadJSON } from './data.js';

const BYPASS_KEY = 'secBypass';
const BYPASS_RULE_BASE = 900000;

let hostSet = null;
async function hosts() {
  if (!hostSet) hostSet = loadJSON('security/hosts.json').then((list) => new Set(list));
  return hostSet;
}

export function securityOn(settings) {
  return settings.enabled && settings.categories.security !== false;
}

// The listed host covering `hostname`, or null.
export async function dangerHost(hostname) {
  const set = await hosts();
  // Never match on a bare TLD, whatever the data says: that would flag every site in it.
  for (const h of hostnameAndParents(hostname)) if (h.includes('.') && set.has(h)) return h;
  return null;
}

async function dangerPage(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const host = await dangerHost(u.hostname);
  if (host) return host;
  const urls = await loadJSON('security/urls.json');
  const path = u.pathname + u.search;
  for (const h of hostnameAndParents(u.hostname)) {
    const prefixes = urls[h];
    if (prefixes && prefixes.some((p) => pathMatches(path, p))) return u.hostname;
  }
  return null;
}

async function bypassed(hostname) {
  const list = (await chrome.storage.session.get(BYPASS_KEY))[BYPASS_KEY] || [];
  return hostnameAndParents(hostname).some((h) => list.includes(h));
}

export function warningUrl(url, host, back = '') {
  const b = /^https?:/i.test(back) ? `&b=${encodeURIComponent(back)}` : '';
  return chrome.runtime.getURL(`warning/warning.html?u=${encodeURIComponent(url)}&h=${encodeURIComponent(host)}${b}`);
}

const recentlyWarned = new Map(); // tabId -> url, so the DNR backstop doesn't warn twice

// Called for top-level navigations before they start. Returns the listed host if the tab
// was sent to the warning page.
// `back` is the page the tab was on, for the warning page's "Back to safety".
export async function checkNavigation(tabId, url, settings, back = '') {
  if (!securityOn(settings) || !/^https?:/i.test(url)) return null;
  const host = await dangerPage(url);
  if (!host || await bypassed(new URL(url).hostname)) return null;
  if (recentlyWarned.get(tabId) === url) return host;
  recentlyWarned.set(tabId, url);
  setTimeout(() => { if (recentlyWarned.get(tabId) === url) recentlyWarned.delete(tabId); }, 5000);
  await chrome.tabs.update(tabId, { url: warningUrl(url, host, back) }).catch(() => {});
  return host;
}

// "Continue anyway": allow the host (and its subdomains) until the browser closes.
export async function bypass(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error('Not a valid URL'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Not a web page');
  const host = u.hostname;
  const list = (await chrome.storage.session.get(BYPASS_KEY))[BYPASS_KEY] || [];
  if (!list.includes(host)) list.push(host);
  await chrome.storage.session.set({ [BYPASS_KEY]: list });
  const existing = await chrome.declarativeNetRequest.getSessionRules();
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: existing.map((r) => r.id),
    addRules: [{
      id: BYPASS_RULE_BASE,
      priority: 3000,
      action: { type: 'allowAllRequests' },
      condition: { requestDomains: list, resourceTypes: ['main_frame', 'sub_frame'] },
    }],
  });
  return url;
}
