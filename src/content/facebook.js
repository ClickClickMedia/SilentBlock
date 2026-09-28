// Hides sponsored posts in the Facebook feed.
//
// Facebook scrambles the "Sponsored" label (split spans, invisible characters, CSS-hidden
// decoy letters), so this uses structural markers first and reads rendered text only for
// posts it has not judged yet. v1 re-scanned every span on the page, with a layout call
// each, on every mutation, every 2s and every scroll.
(() => {
  'use strict';
  if (globalThis.__silentblockFacebook) return;
  globalThis.__silentblockFacebook = true;

  const LABELS = new Set([
    'sponsored', 'gesponsert', 'sponsorisé', 'sponsorisée', 'patrocinado', 'patrocinada', 'sponsorizzato',
    'gesponsord', 'sponsrad', 'sponsoreret', 'sponset', 'sponsoroitu', 'sponsorowane', 'реклама', '広告',
    '赞助内容', '贊助', '광고', 'sponzorováno', 'hirdetés', 'χορηγούμενη', 'reklam', 'bersponsor',
  ]);
  const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠎​-‏‪-‮⁠-⁤⁪-⁯ㅤ﻿ﾠ\s]/g;
  const MARKERS = [
    'a[href*="/ads/about"]',
    'a[href*="/ad_center/"]',
    'a[attributionsrc*="privacy_sandbox"]',
    '[aria-label="Sponsored"]',
  ].join(',');
  const POST_SELECTOR = '[role="feed"] > div, div[data-pagelet^="FeedUnit"], [role="article"]';

  const hidden = new WeakSet();
  const lastChecked = new WeakMap();

  function postOf(el) {
    let node = el;
    for (let depth = 0; node && node !== document.body && depth < 40; depth++) {
      const parent = node.parentElement;
      if (parent && parent.getAttribute('role') === 'feed') return node;
      const pagelet = node.getAttribute && node.getAttribute('data-pagelet');
      if (pagelet && pagelet.startsWith('FeedUnit')) return node;
      node = parent;
    }
    return null; // no structural marker: never guess, or we might hide the whole feed
  }

  function isLabel(el) {
    const text = (el.innerText || '').replace(INVISIBLE, '').toLowerCase();
    return text.length > 0 && text.length < 24 && LABELS.has(text);
  }

  function judge(post) {
    if (hidden.has(post)) return;
    const now = Date.now();
    if (now - (lastChecked.get(post) || 0) < 800) return;
    lastChecked.set(post, now);
    let sponsored = post.querySelector(MARKERS) !== null;
    if (!sponsored) {
      // The label sits in the post header, among the first few links.
      const candidates = post.querySelectorAll('a[role="link"], span[dir="auto"] > span, a[href="#"]');
      for (let i = 0; i < candidates.length && i < 30 && !sponsored; i++) sponsored = isLabel(candidates[i]);
    }
    if (sponsored) {
      hidden.add(post);
      post.style.setProperty('display', 'none', 'important');
    }
  }

  const queue = new Set();
  let scheduled = false;
  const run = () => {
    scheduled = false;
    for (const post of queue) judge(post);
    queue.clear();
  };
  const enqueue = (node) => {
    if (node.nodeType !== 1) return;
    const own = postOf(node);
    if (own) queue.add(own);
    else for (const p of node.querySelectorAll(POST_SELECTOR)) { const post = postOf(p) || p; queue.add(post); }
    if (!scheduled && queue.size) {
      scheduled = true;
      (window.requestIdleCallback || setTimeout)(run, { timeout: 300 });
    }
  };

  new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) enqueue(n);
  }).observe(document.body || document.documentElement, { childList: true, subtree: true });
  enqueue(document.body || document.documentElement);
})();
