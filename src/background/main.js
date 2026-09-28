// SilentBlock service worker.
//
// All listeners are registered synchronously at top level so Chrome can wake the worker
// for them. State lives in chrome.storage; nothing here relies on the worker staying alive.
import { loadState, saveState, migrate, allowlistEntryFor, normalise } from './state.js';
import { applyAll, applyAction, desiredContentScripts } from './apply.js';
import { onCommitted, onTokens, rememberTop, forgetTab } from './cosmetic.js';
import { onCreatedNavigationTarget, onTopNavigation, onNavigationError, forgetPopupTab, noteCommitted, lastUrlOf } from './popups.js';
import { resetTab, record, getStatus, levelOf, iconStateFor, forgetStatus } from './status.js';
import { checkNavigation, dangerHost, securityOn, bypass } from './security.js';
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

chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
  // Pass the promise, not the state: registration must happen before any await.
  onCreatedNavigationTarget(details, loadState());
});

chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const back = lastUrlOf(details.tabId);
  const state = await loadState();
  const host = await checkNavigation(details.tabId, details.url, state, back);
  if (host) { await record(details.tabId, 'danger', host, state); return; }
  await onTopNavigation(details.tabId, details.url, state);
});

chrome.webNavigation.onErrorOccurred.addListener(async (details) => {
  const state = await loadState();
  onNavigationError(details, state);
  // Backstop: DNR blocked a listed page before the navigation check could redirect it.
  if (details.frameId === 0 && /BLOCKED_BY_CLIENT/.test(details.error || '')) {
    const host = await checkNavigation(details.tabId, details.url, state, lastUrlOf(details.tabId));
    if (host) await record(details.tabId, 'danger', host, state);
  }
});

chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (!/^https?:/.test(details.url)) return;
  if (details.frameId === 0) noteCommitted(details.tabId, details.url); // before any await
  const state = await loadState();
  if (details.frameId === 0) {
    await onTopNavigation(details.tabId, details.url, state);
    const hostname = new URL(details.url).hostname;
    rememberTop(details.tabId, hostname);
    await resetTab(details.tabId, hostname, state);
  }
  await onCommitted(details, state);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  forgetTab(tabId);
  forgetPopupTab(tabId);
  forgetStatus(tabId);
});

// ---- live request watching (read-only) -----------------------------------------------

// Every request SilentBlock (or anything else) blocked shows up here as ERR_BLOCKED_BY_CLIENT.
chrome.webRequest.onErrorOccurred.addListener(async (d) => {
  if (d.tabId < 0 || d.type === 'main_frame' || !/BLOCKED_BY_CLIENT/.test(d.error)) return;
  const state = await loadState();
  let host = '';
  try { host = new URL(d.url).hostname; } catch { return; }
  const listed = securityOn(state) ? await dangerHost(host) : null;
  await record(d.tabId, listed ? 'danger' : 'blocked', listed, state);
}, { urls: ['<all_urls>'] });

// Requests swapped for a local stub (GPT, gtag, analytics.js, ...) were blocked too.
chrome.webRequest.onBeforeRedirect.addListener(async (d) => {
  if (d.tabId < 0 || !/^(chrome|moz)-extension:\/\/[^/]+\/resources\//.test(d.redirectUrl)) return;
  await record(d.tabId, 'blocked', null, await loadState());
}, { urls: ['<all_urls>'] });

// ---- messages -----------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string' || sender.id !== chrome.runtime.id) return false;
  const fromExtensionPage = typeof sender.url === 'string' && sender.url.startsWith(EXTENSION_ORIGIN);

  // Content scripts may say two things: "these classes/ids are on my page", and
  // "I removed a nag wall". Neither changes settings.
  if (!fromExtensionPage && sender.tab) {
    if (message.type === 'tokens') loadState().then((s) => onTokens(message, sender, s)).catch(() => {});
    if (message.type === 'wall') loadState().then((s) => record(sender.tab.id, 'wall', null, s)).catch(() => {});
    return false;
  }

  // Everything else must come from our own popup, options or warning page.
  if (!fromExtensionPage) return false;
  handle(message).then(sendResponse, (err) => sendResponse({ error: String(err?.message || err) }));
  return true;
});

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
        const status = await getStatus(msg.tabId);
        out.pausedBy = allowlistEntryFor(info.hostname, state);
        out.unwall = hostnameAndParents(info.hostname).some((h) => state.unwallSites.includes(h));
        out.status = { ...status, level: levelOf(status), icon: iconStateFor({ ...status, host: info.hostname }, state) };
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
      await applyAll(state, { dynamic: true, scripts: true, action: true });
      return { ok: true, pausedBy: allowlistEntryFor(hostname, state) };
    }

    case 'unwallNow': {
      // Every frame: walls also turn up inside embedded players and sandboxed page frames.
      await chrome.scripting.executeScript({ target: { tabId: msg.tabId, allFrames: true }, files: ['content/unwall.js'] });
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

    case 'security:bypass':
      return { url: await bypass(msg.url) };

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
