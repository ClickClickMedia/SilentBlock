// Reports the class and id tokens present in this frame to the service worker, which
// answers by injecting CSS for the ones our generic filters target.
//
// This replaces shipping ~28k generic selectors as a stylesheet into every frame. The
// only work here is collecting new tokens; matching and CSS happen in the worker.
(() => {
  'use strict';
  if (globalThis.__silentblockTokens) return;
  globalThis.__silentblockTokens = true;

  const seen = new Set();
  let pending = [];
  let timer = 0;
  let dead = false;
  let observer;

  const push = (t) => {
    if (seen.has(t)) return;
    seen.add(t);
    pending.push(t);
  };

  const collect = (el) => {
    const id = el.id;
    if (id && typeof id === 'string') push('#' + id);
    const cl = el.classList;
    if (cl) for (let i = 0; i < cl.length; i++) push('.' + cl[i]);
  };

  const scan = (root) => {
    if (root.nodeType !== 1) return;
    collect(root);
    const els = root.querySelectorAll('[id],[class]');
    for (let i = 0; i < els.length; i++) collect(els[i]);
  };

  const flush = () => {
    timer = 0;
    if (!pending.length || dead) return;
    const tokens = pending;
    pending = [];
    try {
      chrome.runtime.sendMessage({ type: 'tokens', tokens }).catch(() => {});
    } catch {
      // Extension reloaded or removed: this copy is orphaned, stop working.
      dead = true;
      observer?.disconnect();
    }
  };

  // First batch goes quickly so ads are hidden near first paint; later ones are batched.
  const schedule = () => {
    if (!timer) timer = setTimeout(flush, seen.size < 3000 ? 40 : 250);
  };

  observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'attributes') collect(r.target);
      else for (const n of r.addedNodes) if (n.nodeType === 1) scan(n);
    }
    if (pending.length) schedule();
  });
  observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'id'] });

  if (document.documentElement) scan(document.documentElement);
  if (pending.length) schedule();
})();
