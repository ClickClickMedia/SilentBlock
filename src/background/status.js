// Per-tab page status. It drives the toolbar icon colour and the popup's status line.
//
//   idle       nothing on this page needed blocking (slate blue, also the brand colour)
//   protected  ads or trackers blocked (jade)
//   caution    a pushy site: pop-under, tab-under or nag wall dealt with (amber)
//   danger     a known malware, phishing or scam host (garnet)
//   paused     site paused or protection off (grey)
//
// Counts come from watching requests fail with ERR_BLOCKED_BY_CLIENT (webRequest, read-only)
// and from redirects to our stubs, so they are live and need no activeTab grant. They are
// kept in memory and mirrored to storage.session, because the worker can stop mid-page.
import { isPaused } from './state.js';

const RANK = { idle: 0, protected: 1, caution: 2, danger: 3 };
const tabs = new Map();      // tabId -> status
const painted = new Map();   // tabId -> icon state last set
const flushTimers = new Map();

function blank(host = '') {
  return { host, blocked: 0, popups: 0, walls: 0, danger: 0, dangerHosts: [] };
}

export function levelOf(s) {
  if (s.danger) return 'danger';
  if (s.popups || s.walls) return 'caution';
  if (s.blocked) return 'protected';
  return 'idle';
}

export function iconPaths(state) {
  return Object.fromEntries([16, 32, 48, 128].map((n) => [n, `/icons/${state}-${n}.png`]));
}

// What the icon shows for a tab, given settings. Paused and off always win; with the status
// colours switched off the icon stays slate blue.
export function iconStateFor(status, settings) {
  if (!settings.enabled || (status.host && isPaused(status.host, settings))) return 'paused';
  if (!settings.statusIcon) return 'idle';
  return levelOf(status);
}

async function load(tabId) {
  if (tabs.has(tabId)) return tabs.get(tabId);
  const key = `st:${tabId}`;
  const saved = (await chrome.storage.session.get(key))[key];
  const s = saved || blank();
  tabs.set(tabId, s);
  return s;
}

function persist(tabId) {
  if (flushTimers.has(tabId)) return;
  flushTimers.set(tabId, setTimeout(() => {
    flushTimers.delete(tabId);
    const s = tabs.get(tabId);
    if (s) chrome.storage.session.set({ [`st:${tabId}`]: s }).catch(() => {});
  }, 300));
}

export async function paint(tabId, settings) {
  const s = await load(tabId);
  const state = iconStateFor(s, settings);
  if (painted.get(tabId) === state) return;
  painted.set(tabId, state);
  const title = { idle: 'SilentBlock', protected: 'SilentBlock: protected', caution: 'SilentBlock: pushy site handled', danger: 'SilentBlock: dangerous content blocked', paused: 'SilentBlock: paused' }[state];
  await chrome.action.setIcon({ tabId, path: iconPaths(state) }).catch(() => {});
  await chrome.action.setTitle({ tabId, title }).catch(() => {});
}

// A new top-level document: counts start again.
export async function resetTab(tabId, host, settings) {
  tabs.set(tabId, blank(host));
  painted.delete(tabId);
  persist(tabId);
  await paint(tabId, settings);
}

export async function record(tabId, kind, detail, settings) {
  if (tabId < 0) return;
  const s = await load(tabId);
  if (kind === 'blocked') s.blocked++;
  else if (kind === 'popup') s.popups++;
  else if (kind === 'wall') s.walls++;
  else if (kind === 'danger') {
    s.danger++;
    if (detail && !s.dangerHosts.includes(detail) && s.dangerHosts.length < 10) s.dangerHosts.push(detail);
  }
  persist(tabId);
  if (RANK[levelOf(s)] >= RANK.protected) await paint(tabId, settings);
}

export async function getStatus(tabId) {
  return { ...(await load(tabId)) };
}

export function forgetStatus(tabId) {
  tabs.delete(tabId);
  painted.delete(tabId);
  chrome.storage.session.remove(`st:${tabId}`).catch(() => {});
}

// Settings changed (pause, off, status colours): repaint what is on screen.
export async function repaintAll(settings) {
  painted.clear();
  const open = await chrome.tabs.query({});
  await Promise.all(open.map((t) => paint(t.id, settings)));
}
