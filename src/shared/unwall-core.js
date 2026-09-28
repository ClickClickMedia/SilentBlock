// Anti-adblock wall remover. Self-contained on purpose: the build pastes this source into
// content/unwall.js (isolated world, run from the popup) and into the `sb-unwall`
// scriptlet (MAIN world, run on sites our filters list). No imports, no exports.
//
// It only runs where someone asked for it (popup button, per-site setting, or a filter),
// and even then it hides rather than removes, and only touches scroll/blur after it has
// actually found a wall. v1 ran a looser version of this on every site and broke admin
// panels that mention "whitelist".

/* eslint-disable no-unused-vars */
const UNWALL_TEXT_RE = /\bad[\s-]?block(?:er|ing)?s?\b|\bcontent[\s-]?blockers?\b|\bads? (?:are|is) (?:being )?blocked\b|\b(?:disable|turn off|pause|deactivate) (?:your |the )?(?:ad|content)[\s-]?block|\b(?:whitelist|allowlist|white-list) (?:us|this site|our (?:site|website|domain))\b|\bads aren'?t (?:being )?displayed\b/i;

const unwallHidden = new WeakSet();

function unwallHide(el) {
  el.style.setProperty('display', 'none', 'important');
  unwallHidden.add(el);
}

function unwallArea(el) {
  const r = el.getBoundingClientRect();
  return (r.width * r.height) / Math.max(1, innerWidth * innerHeight);
}

function unwallText(el) {
  const t = el.innerText || '';
  return t.length > 6000 ? '' : t;
}

// Walls sit near the top of the tree; a bounded walk keeps the sweep cheap on big pages.
function unwallCandidates(root, maxDepth) {
  const out = [];
  const walk = (el, depth) => {
    for (let c = el.firstElementChild; c; c = c.nextElementSibling) {
      out.push(c);
      if (depth < maxDepth) walk(c, depth + 1);
    }
  };
  walk(root, 1);
  return out;
}

function unwallSweep() {
  const body = document.body;
  if (!body) return false;
  let hit = false;

  for (const d of document.querySelectorAll('dialog[open]')) {
    if (unwallHidden.has(d) || !UNWALL_TEXT_RE.test(unwallText(d))) continue;
    try { d.close(); } catch { /* not closable */ }
    unwallHide(d);
    hit = true;
  }

  const overlays = [];
  for (const el of unwallCandidates(body, 6)) {
    if (unwallHidden.has(el)) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none') continue;
    const z = parseInt(cs.zIndex, 10) || 0;
    const positioned = cs.position === 'fixed' || cs.position === 'sticky' || (cs.position === 'absolute' && z >= 100);
    if (!positioned) continue;
    overlays.push([el, cs]);
    if (unwallArea(el) < 0.08) continue; // a small badge is not a wall
    if (UNWALL_TEXT_RE.test(unwallText(el))) { unwallHide(el); hit = true; }
  }

  if (!hit) return false;

  // Full-screen dimmers left behind once the message box is gone.
  for (const [el, cs] of overlays) {
    if (unwallHidden.has(el) || cs.position !== 'fixed' || unwallArea(el) < 0.85) continue;
    const text = (el.innerText || '').trim();
    const dim = /rgba\(.+,\s*0?\.\d+\)|rgba\(.+,\s*1\)|rgb\(/.test(cs.backgroundColor) || cs.backdropFilter !== 'none' || parseFloat(cs.opacity) < 1;
    if (text.length < 40 && dim) unwallHide(el);
  }

  for (const el of [document.documentElement, body]) {
    const cs = getComputedStyle(el);
    if (cs.overflow === 'hidden' || cs.overflowY === 'hidden') {
      el.style.setProperty('overflow', 'auto', 'important');
      el.style.setProperty('overflow-y', 'auto', 'important');
    }
    if (el === body && cs.position === 'fixed') el.style.setProperty('position', 'static', 'important');
    if (cs.pointerEvents === 'none') el.style.setProperty('pointer-events', 'auto', 'important');
  }
  const blurred = [document.documentElement, body, ...document.querySelectorAll('body > *, main, article, [role="main"]')];
  for (const el of blurred) {
    const cs = getComputedStyle(el);
    if (cs.filter.includes('blur')) el.style.setProperty('filter', 'none', 'important');
    if (cs.backdropFilter && cs.backdropFilter.includes('blur')) el.style.setProperty('backdrop-filter', 'none', 'important');
  }
  return true;
}

// Sweep now, then keep sweeping (throttled) while the page settles, for `ms` milliseconds.
// `onHit` runs once, the first time a wall is actually removed.
function unwallWatch(ms, onHit) {
  let pending = 0;
  let reported = false;
  const sweep = () => {
    pending = 0;
    let hit = false;
    try { hit = unwallSweep(); } catch { /* page in flux */ }
    if (hit && !reported && onHit) { reported = true; try { onHit(); } catch { /* ignore */ } }
  };
  const schedule = () => { if (!pending) pending = setTimeout(sweep, 400); };
  const start = () => {
    sweep();
    const mo = new MutationObserver(schedule);
    mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'open'] });
    setTimeout(() => mo.disconnect(), ms);
    addEventListener('load', schedule, { once: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}
