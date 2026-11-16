// "Nuke this": the popup arms a tab, the picker (content/nuke.js) reports one click, and
// this file turns it into a saved rule.
//
// Content scripts normally cannot change settings. The picker is the one exception, and it
// is narrow: a save is accepted only from the top frame of a tab the popup armed in the last
// few minutes, and it uses the arm up. Undo is accepted only for the rule that save made,
// for a minute. Everything the picker sends is validated by nuke-rules.js.
import { loadState, saveState } from './state.js';
import { record } from './status.js';
import { hostnameAndParents, normaliseHostname } from '../shared/hostnames.js';
import { cleanSelector, pickService, nukeCss, siteSelectors } from '../shared/nuke-rules.js';

const ARM_MS = 10 * 60 * 1000;
const UNDO_MS = 60 * 1000;
const armKey = (tabId) => `nukeArm:${tabId}`;
const lastKey = (tabId) => `nukeLast:${tabId}`;

// storage.session survives the worker stopping between the click and the save.
async function take(key) {
  const got = (await chrome.storage.session.get(key))[key];
  await chrome.storage.session.remove(key);
  return got && got.until > Date.now() ? got : null;
}

export async function armNuke(tabId) {
  if (!Number.isInteger(tabId)) throw new Error('No tab');
  await chrome.storage.session.set({ [armKey(tabId)]: { until: Date.now() + ARM_MS } });
}

async function cssTarget(sender) {
  return sender.documentId ? { tabId: sender.tab.id, documentIds: [sender.documentId] } : { tabId: sender.tab.id, frameIds: [0] };
}

async function css(method, sender, text) {
  try {
    await chrome.scripting[method]({ target: await cssTarget(sender), css: text, origin: 'USER' });
  } catch {
    try { await chrome.scripting[method]({ target: { tabId: sender.tab.id, frameIds: [0] }, css: text, origin: 'USER' }); } catch { /* gone */ }
  }
}

function senderHost(sender) {
  if (sender.frameId !== 0 || !sender.url || !/^https?:/.test(sender.url)) return null;
  try { return normaliseHostname(new URL(sender.url).hostname); } catch { return null; }
}

export async function onNukeMessage(msg, sender) {
  const tabId = sender.tab.id;
  const host = senderHost(sender);
  if (!host) throw new Error('Not here');

  if (msg.type === 'nuke:save') {
    const selector = cleanSelector(msg.selector);
    if (!selector) throw new Error('Bad selector');
    if (!(await take(armKey(tabId)))) throw new Error('Not armed');
    const service = pickService(host, msg.hosts, msg.tokens);

    const cur = await loadState();
    const nuked = structuredClone(cur.nuked);
    nuked.sites[host] = [...new Set([...(nuked.sites[host] || []), selector])];
    let learned = false;
    if (service) {
      const prev = nuked.services[service.domain];
      learned = !prev || !prev.tokens.includes(service.token);
      nuked.services[service.domain] = {
        name: prev?.name || service.name,
        tokens: [...new Set([...(prev?.tokens || []), service.token])],
        from: prev?.from || host,
        at: prev?.at || new Date().toISOString(),
      };
    }
    const state = await saveState({ nuked });
    if (!state.nuked.sites[host]?.includes(selector)) throw new Error('Rule not saved');

    await chrome.storage.session.set({
      [lastKey(tabId)]: { until: Date.now() + UNDO_MS, host, selector, service: learned ? service : null },
    });
    await css('insertCSS', sender, nukeCss([selector]));
    await record(tabId, 'wall', null, state).catch(() => {});
    return { ok: true, host, service: service ? { domain: service.domain, name: service.name } : null };
  }

  if (msg.type === 'nuke:undo') {
    const last = await take(lastKey(tabId));
    if (!last || last.host !== host || last.selector !== msg.selector) throw new Error('Nothing to undo');
    const cur = await loadState();
    const nuked = structuredClone(cur.nuked);
    const left = (nuked.sites[host] || []).filter((s) => s !== last.selector);
    if (left.length) nuked.sites[host] = left; else delete nuked.sites[host];
    // Forget the service only if this nuke is what taught it that token.
    if (last.service && nuked.services[last.service.domain]) {
      const svc = nuked.services[last.service.domain];
      svc.tokens = svc.tokens.filter((t) => t !== last.service.token);
      if (!svc.tokens.length) delete nuked.services[last.service.domain];
    }
    await saveState({ nuked });
    await css('removeCSS', sender, nukeCss([last.selector]));
    return { ok: true };
  }

  throw new Error('Unknown nuke message');
}

export async function clearSiteNukes(hostname) {
  const cur = await loadState();
  const nuked = structuredClone(cur.nuked);
  for (const h of hostnameAndParents(hostname)) delete nuked.sites[h];
  await saveState({ nuked });
}

export function nukedCount(state, hostname) {
  return siteSelectors(state.nuked, hostnameAndParents(hostname)).length;
}
