// "Nuke this" picker. Injected into the top frame by the popup (via the service worker).
// Hover highlights, click nukes, Esc cancels. Clicking inside a full-screen overlay nukes the
// whole overlay, so one click takes the dimmer with the box.
//
// The page never sees this UI (closed shadow root) and never gets the click. What gets
// remembered is decided by the worker: this script only reports a selector, the class/id
// tokens around the element, and the third-party script hosts on the page.
(() => {
  'use strict';
  const G = globalThis;
  if (G.__silentblockNuke) { G.__silentblockNuke.start(); return; }

  const html = document.documentElement;
  const area = (el) => {
    const r = el.getBoundingClientRect();
    return (r.width * r.height) / Math.max(1, innerWidth * innerHeight);
  };

  // ---- UI -------------------------------------------------------------------------------
  let ui = null;
  function mount() {
    if (ui) return ui;
    const host = document.createElement('silentblock-nuke');
    host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;display:block!important';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>
      :host { all: initial; }
      * { box-sizing: border-box; font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
      .bar { position: fixed; top: 0; left: 0; right: 0; padding: 9px 14px; background: #1d2433; color: #fff; text-align: center; font-weight: 600; box-shadow: 0 2px 12px rgba(0,0,0,.35); }
      .box { position: fixed; display: none; border: 2px solid #e5484d; background: rgba(229,72,77,.18); border-radius: 3px; }
      .toast { position: fixed; right: 16px; bottom: 16px; max-width: 340px; display: none; align-items: flex-start; gap: 12px; padding: 12px 14px; background: #1d2433; color: #fff; border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.4); pointer-events: auto; }
      .toast p { margin: 0; }
      .toast button { flex: none; margin-left: auto; padding: 4px 10px; border: 1px solid rgba(255,255,255,.4); border-radius: 6px; background: transparent; color: #fff; font-weight: 600; cursor: pointer; }
      .toast button:hover { background: rgba(255,255,255,.12); }
      .toast button[hidden] { display: none; }
    </style>
    <div class="bar" part="bar">\u{1F4A5} Click what you want gone. Esc cancels.</div>
    <div class="box"></div>
    <div class="toast" role="status"><p></p><button type="button">Undo</button></div>`;
    html.appendChild(host);
    ui = { host, bar: root.querySelector('.bar'), box: root.querySelector('.box'), toast: root.querySelector('.toast') };
    return ui;
  }

  function unmount() {
    ui?.host.remove();
    ui = null;
  }

  // ---- picking --------------------------------------------------------------------------
  let picking = false;
  let current = null;

  function targetAt(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el || el === html || el === document.body || el.localName === 'silentblock-nuke') return null;
    // Outermost fixed/sticky ancestor that covers half the screen: that's the overlay.
    let best = el;
    for (let a = el; a && a !== document.body && a !== html; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if ((cs.position === 'fixed' || cs.position === 'sticky') && area(a) >= 0.5) best = a;
    }
    return best;
  }

  function highlight(el) {
    current = el;
    const { box } = mount();
    if (!el) { box.style.display = 'none'; return; }
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  }

  const swallow = (e) => {
    if (!picking || !e.isTrusted) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const onMove = (e) => { if (picking) highlight(targetAt(e.clientX, e.clientY)); };
  const onScroll = () => { if (picking && current) highlight(current); };
  const onClick = (e) => {
    if (!picking || !e.isTrusted) return;
    swallow(e);
    if (e.button !== 0) return;
    const t = targetAt(e.clientX, e.clientY) || current;
    if (t) nuke(t);
  };
  const onKey = (e) => {
    if (!picking || e.key !== 'Escape') return;
    swallow(e);
    stop();
    unmount();
  };

  const BLOCKED = ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'auxclick', 'dblclick', 'contextmenu'];
  function listen(on) {
    const f = (on ? addEventListener : removeEventListener).bind(G);
    f('mousemove', onMove, true);
    f('click', onClick, true);
    f('keydown', onKey, true);
    f('scroll', onScroll, true);
    for (const t of BLOCKED) f(t, swallow, true);
  }

  function start() {
    if (picking) return;
    picking = true;
    const u = mount();
    u.bar.style.display = '';
    u.toast.style.display = 'none';
    listen(true);
  }

  function stop() {
    picking = false;
    listen(false);
    if (ui) { ui.bar.style.display = 'none'; ui.box.style.display = 'none'; }
  }

  // ---- what to remember -----------------------------------------------------------------
  // Generated class names (css-1x2y3z, sc-AbC12) change every deploy, so skip them.
  function stable(name) {
    if (!name || name.length < 2 || name.length > 40) return false;
    if (/\d{3,}/.test(name) || /^(?:css|sc|jsx|emotion|styled|svelte|astro)[-_]/i.test(name)) return false;
    return ((name.match(/[a-z][0-9]|[0-9][a-z]/gi) || []).length) < 3;
  }

  function part(el) {
    const tag = CSS.escape(el.localName);
    if (el.id && stable(el.id)) return `#${CSS.escape(el.id)}`;
    const cls = [...el.classList].filter(stable).slice(0, 3);
    return cls.length ? `${tag}.${cls.map((c) => CSS.escape(c)).join('.')}` : tag;
  }

  function unique(sel, el) {
    try {
      const m = document.querySelectorAll(sel);
      return m.length === 1 && m[0] === el;
    } catch { return false; }
  }

  function selectorFor(t) {
    let chain = part(t);
    if (unique(chain, t)) return chain;
    let cur = t;
    for (let i = 0; i < 5; i++) {
      const p = cur.parentElement;
      if (!p || p === html) break;
      chain = `${p === document.body ? 'body' : part(p)} > ${chain}`;
      if (unique(chain, t)) return chain;
      if (p === document.body) break;
      cur = p;
    }
    // Last resort: a positional path from <body>.
    const steps = [];
    for (let e = t; e && e !== document.body && e !== html; e = e.parentElement) {
      let n = 1;
      for (let s = e.previousElementSibling; s; s = s.previousElementSibling) if (s.localName === e.localName) n++;
      steps.unshift(`${CSS.escape(e.localName)}:nth-of-type(${n})`);
    }
    const path = `body > ${steps.join(' > ')}`;
    return steps.length && unique(path, t) ? path : null;
  }

  // The element's own class/id tokens first, then wrappers no bigger than it, then children.
  function tokensFor(t) {
    const out = [];
    const add = (e) => {
      if (e.id) out.push(`#${e.id}`);
      for (const c of e.classList) out.push(`.${c}`);
    };
    add(t);
    const a0 = area(t);
    let depth = 0;
    for (let a = t.parentElement; a && a !== document.body && a !== html && depth < 6; a = a.parentElement, depth++) {
      if (area(a) <= a0 * 1.2 + 0.001) add(a);
    }
    for (const c of t.children) {
      add(c);
      for (const g of c.children) add(g);
    }
    return [...new Set(out)].slice(0, 60);
  }

  function thirdPartyHosts() {
    const hosts = new Set();
    const addUrl = (u) => {
      try {
        const url = new URL(u, location.href);
        if (/^https?:$/.test(url.protocol) && url.hostname !== location.hostname) hosts.add(url.hostname);
      } catch { /* not a URL */ }
    };
    for (const s of document.scripts) if (s.src) addUrl(s.src);
    for (const f of document.querySelectorAll('iframe[src]')) addUrl(f.src);
    try {
      for (const r of performance.getEntriesByType('resource')) {
        if (r.initiatorType === 'script' || r.initiatorType === 'iframe') addUrl(r.name);
      }
    } catch { /* no timing API */ }
    return [...hosts].slice(0, 200);
  }

  // ---- nuking ---------------------------------------------------------------------------
  function unlock() {
    for (const el of [html, document.body]) {
      if (!el) continue;
      const cs = getComputedStyle(el);
      if (cs.overflow === 'hidden' || cs.overflowY === 'hidden') {
        el.style.setProperty('overflow', 'auto', 'important');
        el.style.setProperty('overflow-y', 'auto', 'important');
      }
      if (cs.pointerEvents === 'none') el.style.setProperty('pointer-events', 'auto', 'important');
    }
    for (const el of document.querySelectorAll('body > *, main, article, [role="main"], [style*="blur("]')) {
      const cs = getComputedStyle(el);
      if (cs.filter.includes('blur')) el.style.setProperty('filter', 'none', 'important');
      if (cs.backdropFilter && cs.backdropFilter.includes('blur')) el.style.setProperty('backdrop-filter', 'none', 'important');
      if (cs.filter.includes('blur') && cs.pointerEvents === 'none') el.style.setProperty('pointer-events', 'auto', 'important');
    }
  }

  let toastTimer = 0;
  function toast(text, undo) {
    const { toast: box } = mount();
    const btn = box.querySelector('button');
    box.querySelector('p').textContent = text;
    btn.hidden = !undo;
    btn.onclick = undo ? () => { btn.hidden = true; undo(); } : null;
    box.style.display = 'flex';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(unmount, 8000);
  }

  async function nuke(t) {
    stop();
    const selector = selectorFor(t);
    const tokens = tokensFor(t);
    const hosts = thirdPartyHosts();
    const prev = t.style.getPropertyValue('display');
    const prevPriority = t.style.getPropertyPriority('display');
    t.style.setProperty('display', 'none', 'important');
    unlock();
    if (!selector) { toast('Nuked for now. Couldn’t pin it down well enough to remember it.'); return; }

    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: 'nuke:save', selector, tokens, hosts });
    } catch { res = null; }
    if (!res || res.error) { toast('Nuked for now, but SilentBlock couldn’t remember it.'); return; }

    const where = res.service ? `, and on other ${res.service.name} sites` : '';
    toast(`Nuked. Gone on this site from now on${where}.`, async () => {
      try {
        const r = await chrome.runtime.sendMessage({ type: 'nuke:undo', selector });
        if (r && r.error) throw new Error(r.error);
        if (prev) t.style.setProperty('display', prev, prevPriority); else t.style.removeProperty('display');
        toast('Un-nuked. It’s back.');
      } catch {
        toast('Too late to undo here. Remove it in SilentBlock settings.');
      }
    });
  }

  G.__silentblockNuke = { start };
  start();
})();
