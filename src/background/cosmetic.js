// Cosmetic filtering that needs the service worker:
//   - site-specific CSS, injected into each frame when its document commits
//   - generic token CSS, injected when the content script reports classes/ids it saw
// All CSS goes in with origin USER: the page cannot see it, restyle it, or block it with CSP.
import { hostnameAndParents, shardOf } from '../shared/hostnames.js';
import { loadJSON, getMeta } from './data.js';
import { activeCategories } from './apply.js';
import { isPaused } from './state.js';

const FLAG = { ghide: 1, ehide: 2, shide: 4, complexException: 8 };

const tokenSets = new Map();
async function tokens(cat) {
  let p = tokenSets.get(cat);
  if (!p) {
    p = loadJSON(`cosmetic/tokens-${cat}.json`).then((list) => new Set(list));
    tokenSets.set(cat, p);
  }
  return p;
}

async function hostFlags(hostname) {
  const flags = await loadJSON('cosmetic/hostflags.json');
  let f = 0;
  for (const h of hostnameAndParents(hostname)) f |= flags[h] || 0;
  return f;
}

async function exceptionsFor(hostname) {
  const all = await loadJSON('cosmetic/exceptions.json');
  const out = new Set();
  for (const h of hostnameAndParents(hostname)) for (const s of all[h] || []) out.add(s);
  return out;
}

async function specificEntries(cat, hostname) {
  const out = [];
  for (const h of hostnameAndParents(hostname)) {
    const shard = await loadJSON(`cosmetic/specific-${cat}-${String(shardOf(h)).padStart(2, '0')}.json`);
    if (shard[h]) out.push(shard[h]);
  }
  return out;
}

function hideRule(selectors) {
  return selectors.length ? `${selectors.join(',\n')}\n{display:none!important}\n` : '';
}

// One bad selector voids a whole selector list, so specific selectors (validated at build,
// but browsers differ) are grouped in small chunks.
function hideRules(selectors, chunk = 25) {
  let css = '';
  for (let i = 0; i < selectors.length; i += chunk) css += hideRule(selectors.slice(i, i + chunk));
  return css;
}

async function insert(tabId, frameId, documentId, css) {
  if (!css) return;
  const target = documentId ? { tabId, documentIds: [documentId] } : { tabId, frameIds: [frameId] };
  try {
    await chrome.scripting.insertCSS({ target, css, origin: 'USER' });
  } catch (err) {
    // The frame navigated away or the browser rejected documentIds (Firefox): one retry by frameId.
    if (documentId && !/No frame|No tab|removed/i.test(String(err))) {
      try { await chrome.scripting.insertCSS({ target: { tabId, frameIds: [frameId] }, css, origin: 'USER' }); } catch { /* gone */ }
    }
  }
}

// Top-level hostname per tab, so subframes of a paused site are left alone too.
const topHosts = new Map();

export function rememberTop(tabId, hostname) {
  topHosts.set(tabId, hostname);
}

export function forgetTab(tabId) {
  topHosts.delete(tabId);
}

async function topHostOf(tabId, fallbackUrl) {
  if (topHosts.has(tabId)) return topHosts.get(tabId);
  try {
    const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
    const h = new URL(frame.url).hostname;
    topHosts.set(tabId, h);
    return h;
  } catch {
    try { return new URL(fallbackUrl).hostname; } catch { return ''; }
  }
}

export async function onCommitted({ tabId, frameId, documentId, url }, state) {
  if (!state.enabled || !/^https?:/.test(url)) return;
  const hostname = new URL(url).hostname;
  const top = frameId === 0 ? hostname : await topHostOf(tabId, url);
  if (isPaused(top, state)) return;

  const flags = await hostFlags(hostname);
  if (flags & FLAG.ehide) return;
  const meta = await getMeta();
  const cats = activeCategories(state, meta);
  const exc = await exceptionsFor(hostname);

  const hide = new Set();
  let css = '';
  if (!(flags & FLAG.shide)) {
    for (const cat of cats) {
      if (!meta.cosmetic[cat]?.specificHosts) continue;
      for (const entry of await specificEntries(cat, hostname)) {
        for (const s of entry.h || []) if (!exc.has(s)) hide.add(s);
        for (const [s, decl] of entry.s || []) if (!exc.has(s)) css += `${s}{${decl}}\n`;
      }
    }
  }
  // Sites excluded from the shared complex stylesheet because of an exception get
  // "complex minus exceptions" here instead.
  if ((flags & FLAG.complexException) && !(flags & FLAG.ghide)) {
    for (const cat of cats) {
      if (!meta.cosmetic[cat]?.complex) continue;
      for (const s of await loadJSON(`cosmetic/complex-${cat}.json`)) if (!exc.has(s)) hide.add(s);
    }
  }
  css = hideRules([...hide]) + css;
  await insert(tabId, frameId, documentId, css);
}

export async function onTokens(message, sender, state) {
  if (!state.enabled || !sender.tab || !sender.url || !/^https?:/.test(sender.url)) return;
  if (!Array.isArray(message.tokens) || !message.tokens.length) return;
  const hostname = new URL(sender.url).hostname;
  const top = await topHostOf(sender.tab.id, sender.tab.url || sender.url);
  if (isPaused(top, state)) return;
  const flags = await hostFlags(hostname);
  if (flags & (FLAG.ghide | FLAG.ehide)) return;

  const meta = await getMeta();
  const sets = await Promise.all(activeCategories(state, meta).filter((c) => meta.cosmetic[c]?.tokens).map(tokens));
  const exc = await exceptionsFor(hostname);
  // Only strings that exist in our own lists ever reach the CSS: page-supplied class
  // names are used as lookup keys, never interpolated.
  const hits = [];
  for (const t of message.tokens.slice(0, 5000)) {
    if (typeof t !== 'string' || exc.has(t)) continue;
    if (sets.some((s) => s.has(t))) hits.push(t);
  }
  if (hits.length) await insert(sender.tab.id, sender.frameId, sender.documentId, hideRule(hits));
}
