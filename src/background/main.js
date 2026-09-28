// SilentBlock service worker.
//
// All listeners are registered synchronously at top level so Chrome can wake the worker
// for them. State lives in chrome.storage; nothing here relies on the worker staying alive.
import { loadState, saveState, migrate, allowlistEntryFor, isPaused, normalise } from './state.js';
import { applyAll, applyAction, iconPaths, desiredContentScripts } from './apply.js';
import { onCommitted, onTokens, rememberTop, forgetTab } from './cosmetic.js';
import { onCreatedNavigationTarget, onTopNavigation, onNavigationError, forgetPopupTab } from './popups.js';
import { getMeta } from './data.js';
import { hostnameAndParents, normaliseHostname } from '../shared/hostnames.js';

const EXTENSION_ORIGIN = chrome.runtime.getURL('');

// ---- lifecycle ----------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  await migrate();
  // Extension updates reset the enabled static rulesets to the manifest defaults, and
  // registered scripts must be rebuilt for the new build's files, so always re-apply.
  await applyAll(await loadState());
});

chrome.runtime.onStartup.addListener(async () => {
  const state = await loadState();
  // Toolbar icons are not persisted across browser restarts.
  await applyAction(state);
  // Registered scripts and dynamic rules persist, but self-heal if something was lost.
  const registered = await chrome.scripting.getRegisteredContentScripts();
  if (registered.length !== (await desiredContentScripts(state)).length) await applyAll(state);
});

// ---- navigation ---------------------------------------------------------------------

chrome.webNavigation.onCreatedNavigationTarget.addListener(async (details) => {
  await onCreatedNavigationTarget(details, await loadState());
});

chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId === 0) await onTopNavigation(details.tabId, details.url, await loadState());
});

chrome.webNavigation.onErrorOccurred.addListener((details) => { onNavigationError(details); });

chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (!/^https?:/.test(details.url)) return;
  const state = await loadState();
  if (details.frameId === 0) {
    await onTopNavigation(details.tabId, details.url, state);
    const hostname = new URL(details.url).hostname;
    rememberTop(details.tabId, hostname);
    chrome.storage.session.set({ [`nav:${details.tabId}`]: details.timeStamp }).catch(() => {});
    // Per-tab icon: grey on paused sites so it is obvious why ads are showing.
    const on = state.enabled && !isPaused(hostname, state);
    chrome.action.setIcon({ tabId: details.tabId, path: iconPaths(on) }).catch(() => {});
  }
  await onCommitted(details, state);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  forgetTab(tabId);
  forgetPopupTab(tabId);
  chrome.storage.session.remove(`nav:${tabId}`).catch(() => {});
});

// ---- messages -----------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string' || sender.id !== chrome.runtime.id) return false;
  const fromExtensionPage = typeof sender.url === 'string' && sender.url.startsWith(EXTENSION_ORIGIN);

  // The only thing a content script may say: "these classes/ids are on my page".
  if (message.type === 'tokens') {
    if (!fromExtensionPage && sender.tab) loadState().then((s) => onTokens(message, sender, s)).catch(() => {});
    return false;
  }

  // Everything else changes settings, so it must come from our own popup or options page.
  if (!fromExtensionPage) return false;
  handle(message).then(sendResponse, (err) => sendResponse({ error: String(err?.message || err) }));
  return true;
});

async function blockedCount(tabId) {
  const [meta, session] = await Promise.all([getMeta(), chrome.storage.session.get(`nav:${tabId}`)]);
  const minTimeStamp = session[`nav:${tabId}`] || 0;
  try {
    const { rulesMatchedInfo } = await chrome.declarativeNetRequest.getMatchedRules({ tabId, minTimeStamp });
    return rulesMatchedInfo.filter((m) => m.rule.rulesetId !== '_dynamic' && m.rule.ruleId < meta.allowIdBase).length;
  } catch {
    return null; // no activeTab grant for this tab
  }
}

async function tabInfo(tabId) {
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { return { supported: false }; }
  let url;
  try { url = new URL(tab.url || ''); } catch { return { supported: false }; }
  if (!/^https?:$/.test(url.protocol)) return { supported: false };
  return { supported: true, hostname: url.hostname };
}

async function handle(msg) {
  switch (msg.type) {
    case 'popup:get': {
      const [state, meta, info] = await Promise.all([loadState(), getMeta(), tabInfo(msg.tabId)]);
      const out = { enabled: state.enabled, version: meta.version, ...info };
      if (info.supported) {
        out.pausedBy = allowlistEntryFor(info.hostname, state);
        out.unwall = hostnameAndParents(info.hostname).some((h) => state.unwallSites.includes(h));
        out.blocked = await blockedCount(msg.tabId);
      }
      return out;
    }

    case 'setEnabled': {
      const state = await saveState({ enabled: Boolean(msg.enabled) });
      await applyAll(state);
      return { ok: true };
    }

    case 'setSitePaused': {
      const hostname = normaliseHostname(msg.hostname);
      if (!hostname) throw new Error('Not a valid hostname');
      const cur = await loadState();
      // Resuming removes every entry that covers the site, so the toggle always does
      // what it says even if a parent domain was paused.
      const covering = new Set(hostnameAndParents(hostname));
      const allowlist = msg.paused
        ? [...cur.allowlist, hostname]
        : cur.allowlist.filter((h) => !covering.has(h));
      const state = await saveState({ allowlist });
      await applyAll(state, { dynamic: true, scripts: true });
      return { ok: true, pausedBy: allowlistEntryFor(hostname, state) };
    }

    case 'unwallNow': {
      await chrome.scripting.executeScript({ target: { tabId: msg.tabId }, files: ['content/unwall.js'] });
      return { ok: true };
    }

    case 'setUnwallSite': {
      const hostname = normaliseHostname(msg.hostname);
      if (!hostname) throw new Error('Not a valid hostname');
      const cur = await loadState();
      const covering = new Set(hostnameAndParents(hostname));
      const unwallSites = msg.on ? [...cur.unwallSites, hostname] : cur.unwallSites.filter((h) => !covering.has(h));
      const state = await saveState({ unwallSites });
      await applyAll(state, { scripts: true });
      return { ok: true };
    }

    case 'settings:get': {
      const [state, meta] = await Promise.all([loadState(), getMeta()]);
      return { state, meta };
    }

    case 'settings:set': {
      const before = await loadState();
      const state = await saveState(msg.patch || {});
      const rulesetsChanged = before.enabled !== state.enabled || JSON.stringify(before.categories) !== JSON.stringify(state.categories);
      await applyAll(state, { rulesets: rulesetsChanged, dynamic: true, scripts: true, action: true });
      return { state };
    }

    case 'settings:import': {
      const incoming = normalise(msg.data);
      await chrome.storage.local.set(incoming);
      await applyAll(incoming);
      return { state: incoming };
    }

    default:
      throw new Error(`Unknown message ${msg.type}`);
  }
}
