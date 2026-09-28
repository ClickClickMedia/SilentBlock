// Makes the browser match the saved state: enabled rulesets, the allowlist rule, the
// registered content scripts, the toolbar icon. Idempotent, so it is safe to call on
// install, update, startup and after every settings change.
//
// Everything a paused site must not get (scriptlets, generic CSS, the token reporter) is
// registered with `excludeMatches` built from the allowlist. That is the whole off switch:
// v1 used a DOM event any page could fire to switch SilentBlock off.
import { hostnameToMatchPatterns } from '../shared/hostnames.js';
import { getMeta, getRegistration } from './data.js';
import { iconPaths, repaintAll } from './status.js';

export const ALLOWLIST_RULE_ID = 1;
export const ALLOWLIST_PRIORITY = 1000;
const HTTP = ['http://*/*', 'https://*/*'];


export function activeCategories(state, meta) {
  if (!state.enabled) return [];
  return Object.keys(meta.categories).filter((c) => meta.categories[c].alwaysOn || state.categories[c]);
}

async function applyRulesets(state, meta) {
  const all = Object.keys(meta.categories);
  const on = activeCategories(state, meta);
  const current = new Set(await chrome.declarativeNetRequest.getEnabledRulesets());
  const enableRulesetIds = on.filter((c) => !current.has(c));
  const disableRulesetIds = all.filter((c) => !on.includes(c) && current.has(c));
  if (enableRulesetIds.length || disableRulesetIds.length) {
    await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds, disableRulesetIds });
  }
}

async function applyDynamicRules(state) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const addRules = [];
  if (state.enabled && state.allowlist.length) {
    // allowAllRequests on the top-level document covers every request in its frame tree.
    addRules.push({
      id: ALLOWLIST_RULE_ID,
      priority: ALLOWLIST_PRIORITY,
      action: { type: 'allowAllRequests' },
      condition: { requestDomains: state.allowlist, resourceTypes: ['main_frame'] },
    });
  }
  // Removing every existing id also clears v1's per-site hashed rules on upgrade.
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: existing.map((r) => r.id), addRules });
}

export async function desiredContentScripts(state) {
  if (!state.enabled) return [];
  const [meta, reg] = await Promise.all([getMeta(), getRegistration()]);
  const cats = activeCategories(state, meta);
  const paused = state.allowlist.flatMap(hostnameToMatchPatterns);
  const scripts = [];

  const complexExclude = [...paused, ...reg.complexCssExcludeHosts.flatMap(hostnameToMatchPatterns)];
  for (const cat of cats) {
    if (!meta.cosmetic[cat]?.complex) continue;
    scripts.push({
      id: `sb-generic-${cat}`,
      css: [`cosmetic/generic-${cat}.css`],
      matches: HTTP,
      excludeMatches: complexExclude,
      allFrames: true,
      matchOriginAsFallback: true,
      runAt: 'document_start',
    });
  }

  if (cats.some((c) => meta.cosmetic[c]?.tokens)) {
    scripts.push({
      id: 'sb-tokens',
      js: ['content/generic.js'],
      matches: HTTP,
      excludeMatches: [...paused, ...reg.tokenExcludeHosts.flatMap(hostnameToMatchPatterns)],
      allFrames: true,
      matchOriginAsFallback: true,
      runAt: 'document_start',
    });
  }

  for (const cat of cats) {
    (reg.scriptlets[cat] || []).forEach((bucket, i) => {
      scripts.push({
        id: `sb-sl-${cat}-${i}`,
        js: [bucket.file],
        matches: bucket.matches,
        excludeMatches: paused,
        allFrames: true,
        runAt: 'document_start',
        world: 'MAIN',
      });
    });
  }

  if (cats.includes('ads')) {
    scripts.push({
      id: 'sb-facebook',
      js: ['content/facebook.js'],
      matches: ['*://*.facebook.com/*'],
      excludeMatches: paused,
      runAt: 'document_idle',
    });
  }

  if (state.unwallSites.length) {
    scripts.push({
      id: 'sb-unwall',
      js: ['content/unwall.js'],
      matches: state.unwallSites.flatMap(hostnameToMatchPatterns),
      excludeMatches: paused,
      runAt: 'document_start',
    });
  }
  return scripts;
}

async function registerBatch(scripts) {
  try {
    await chrome.scripting.registerContentScripts(scripts);
  } catch (err) {
    // Firefox (and older Chromium) reject matchOriginAsFallback; retry without it.
    if (!/matchOriginAsFallback/i.test(String(err))) throw err;
    await chrome.scripting.registerContentScripts(scripts.map(({ matchOriginAsFallback, ...s }) => s));
  }
}

// The batch call is all-or-nothing. If it fails, register one by one so a single bad
// script (say, a pattern some browser rejects) cannot switch off every other layer.
async function register(scripts) {
  try {
    await registerBatch(scripts);
  } catch (err) {
    console.warn('SilentBlock: batch registration failed, registering individually:', err);
    await chrome.scripting.unregisterContentScripts().catch(() => {});
    for (const s of scripts) {
      try { await registerBatch([s]); } catch (e) { console.error(`SilentBlock: could not register ${s.id}:`, e); }
    }
  }
}

async function applyContentScripts(state) {
  const scripts = await desiredContentScripts(state);
  await chrome.scripting.unregisterContentScripts();
  if (scripts.length) await register(scripts);
}

export async function applyAction(state) {
  // Global default (new tabs, pages we cannot touch); each tab is then painted by status.js.
  await chrome.action.setIcon({ path: iconPaths(state.enabled ? 'idle' : 'paused') });
  await chrome.action.setTitle({ title: state.enabled ? 'SilentBlock' : 'SilentBlock (off)' });
  await repaintAll(state).catch(() => {});
  try {
    await chrome.declarativeNetRequest.setExtensionActionOptions({ displayActionCountAsBadgeText: state.enabled && state.badge });
  } catch { /* not supported everywhere */ }
}

// Serialise applies: two quick toggles must not interleave unregister/register calls.
let chain = Promise.resolve();
export function applyAll(state, parts = { rulesets: true, dynamic: true, scripts: true, action: true }) {
  const run = async () => {
    const meta = await getMeta();
    if (parts.rulesets) await applyRulesets(state, meta);
    if (parts.dynamic) await applyDynamicRules(state);
    if (parts.scripts) await applyContentScripts(state);
    if (parts.action) await applyAction(state);
  };
  chain = chain.then(run, run);
  return chain;
}
