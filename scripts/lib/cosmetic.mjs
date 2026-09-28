// Turns parsed cosmetic filters into the data files the runtime injects.
//
// Generic filters split two ways:
//   token   `.cls` / `#id`   27k+ of these. Never shipped as a stylesheet: the content script
//                            reports the class/id tokens it sees and the service worker injects
//                            only the matching ones (this is what keeps memory flat per frame).
//   complex everything else  ~1k selectors, shipped as a small static stylesheet.
// Specific filters (`site##sel`) are sharded by hostname and injected per frame on commit.

import { shardOf } from '../../src/shared/hostnames.js';

// uBO/ABP procedural operators that need a JS engine to evaluate. Filters using them are
// skipped. `:-abp-has()` is rewritten to native `:has()` before this check.
const PROCEDURAL_RE = /:(?:has-text|upward|xpath|matches-css(?:-before|-after)?|min-text-length|watch-attr|matches-path|matches-attr|matches-prop|matches-media|others|remove-attr|remove-class|-abp-contains|-abp-properties|contains|if|if-not|nth-ancestor|properties|shadow|style|remove)\(/;

export const TOKEN_RE = /^[#.][A-Za-z_][\w-]*$/;

export const FLAG = { ghide: 1, ehide: 2, shide: 4, complexException: 8 };

function isSafeSelector(sel) {
  if (sel.length > 1000) return false;
  // Anything that could escape the rule we wrap it in.
  if (/[{}]|\/\*|\*\/|\\$|[\x00-\x1f]/.test(sel)) return false;
  return true;
}

// Only plain declarations; nothing that loads a resource or escapes the block.
function sanitiseDeclarations(decl) {
  if (/[{}\\]|\/\*|url\(|image-set\(|expression\(|@import|javascript:/i.test(decl)) return null;
  const parts = decl.split(';').map((d) => d.trim()).filter(Boolean);
  if (!parts.length) return null;
  const out = [];
  for (const p of parts) {
    if (!/^-?[a-z-]+\s*:\s*[^:]+$/i.test(p) && !/^-?[a-z-]+\s*:\s*.+$/i.test(p)) return null;
    out.push(/!important\s*$/i.test(p) ? p : `${p} !important`);
  }
  return out.join('; ');
}

/**
 * @returns {{ kind: 'hide'|'style', selector: string, decl?: string } | { skip: string }}
 */
export function processSelector(raw, procedural) {
  let sel = raw.trim();
  let kind = 'hide';
  let decl;
  if (sel.endsWith(':remove()')) {
    sel = sel.slice(0, -':remove()'.length);
  } else {
    const m = /:style\((.*)\)$/.exec(sel);
    if (m) {
      decl = sanitiseDeclarations(m[1]);
      if (!decl) return { skip: 'style-unsafe' };
      sel = sel.slice(0, m.index);
      kind = 'style';
    }
  }
  sel = sel.replace(/:-abp-has\(/g, ':has(');
  if (PROCEDURAL_RE.test(sel)) return { skip: 'procedural' };
  if (procedural && /:-abp-/.test(sel)) return { skip: 'procedural' };
  if (!sel || !isSafeSelector(sel)) return { skip: 'selector-unsafe' };
  return kind === 'style' ? { kind, selector: sel, decl } : { kind, selector: sel };
}

export class CosmeticCompiler {
  constructor(categories) {
    this.categories = categories;
    this.generic = Object.fromEntries(categories.map((c) => [c, new Set()]));
    // specific[cat]: Map(host -> { h: Set, s: Map(sel -> decl) })
    this.specific = Object.fromEntries(categories.map((c) => [c, new Map()]));
    this.exceptions = new Map();      // host -> Set(selector)  (site#@#sel, ~site##sel)
    this.globalExceptions = new Set(); // #@#sel
    this.hostFlags = new Map();       // host -> bitmask
    this.stats = {};
  }

  count(reason) { this.stats[reason] = (this.stats[reason] || 0) + 1; }

  addFlag(host, bit) { this.hostFlags.set(host, (this.hostFlags.get(host) || 0) | bit); }

  addException(host, sel) {
    let s = this.exceptions.get(host);
    if (!s) this.exceptions.set(host, (s = new Set()));
    s.add(sel);
  }

  add(cat, f) {
    const p = processSelector(f.selector, f.procedural);
    if (p.skip) return this.count(p.skip);

    if (f.exception) {
      if (!f.include.length) this.globalExceptions.add(p.selector);
      for (const h of f.include) this.addException(h, p.selector);
      return this.count('exception');
    }

    // `~a.com##.ad`: generic everywhere except a.com.
    for (const h of f.exclude) this.addException(h, p.selector);

    if (!f.include.length) {
      if (p.kind === 'style') return this.count('generic-style-skipped');
      this.generic[cat].add(p.selector);
      return this.count('generic');
    }
    const map = this.specific[cat];
    for (const h of f.include) {
      let e = map.get(h);
      if (!e) map.set(h, (e = { h: new Set(), s: new Map() }));
      if (p.kind === 'style') e.s.set(p.selector, p.decl);
      else e.h.add(p.selector);
    }
    this.count('specific');
  }

  // Validation drops selectors Chromium rejects. It runs after all lists are added.
  applyValidation(isValid) {
    let dropped = 0;
    for (const cat of this.categories) {
      for (const sel of this.generic[cat]) if (!isValid(sel)) { this.generic[cat].delete(sel); dropped++; }
      for (const e of this.specific[cat].values()) {
        for (const sel of e.h) if (!isValid(sel)) { e.h.delete(sel); dropped++; }
        for (const sel of e.s.keys()) if (!isValid(sel)) { e.s.delete(sel); dropped++; }
      }
    }
    this.stats['invalid-selector'] = dropped;
  }

  allSelectors() {
    const all = new Set();
    for (const cat of this.categories) {
      for (const s of this.generic[cat]) all.add(s);
      for (const e of this.specific[cat].values()) {
        for (const s of e.h) all.add(s);
        for (const s of e.s.keys()) all.add(s);
      }
    }
    return all;
  }

  /** Returns a map of output file path -> contents (string or JSON-able). */
  emit() {
    const files = {};
    const complexAll = new Set();
    const summary = {};

    for (const cat of this.categories) {
      const tokens = [];
      const complex = [];
      for (const sel of this.generic[cat]) {
        if (this.globalExceptions.has(sel)) continue;
        (TOKEN_RE.test(sel) ? tokens : complex).push(sel);
      }
      tokens.sort();
      complex.sort();
      complex.forEach((s) => complexAll.add(s));
      files[`cosmetic/tokens-${cat}.json`] = tokens;
      files[`cosmetic/complex-${cat}.json`] = complex;
      files[`cosmetic/generic-${cat}.css`] = cssHide(complex);

      const shards = Array.from({ length: 32 }, () => ({}));
      let hosts = 0;
      for (const [host, e] of this.specific[cat]) {
        const h = [...e.h].filter((s) => !this.globalExceptions.has(s)).sort();
        const s = [...e.s].filter(([sel]) => !this.globalExceptions.has(sel)).sort();
        if (!h.length && !s.length) continue;
        const entry = {};
        if (h.length) entry.h = h;
        if (s.length) entry.s = s;
        shards[shardOf(host)][host] = entry;
        hosts++;
      }
      shards.forEach((data, i) => { files[`cosmetic/specific-${cat}-${String(i).padStart(2, '0')}.json`] = data; });
      summary[cat] = { tokens: tokens.length, complex: complex.length, specificHosts: hosts };
    }

    // Hosts with an exception for a complex generic selector cannot take the shared static
    // stylesheet; the service worker injects "complex minus exceptions" for them instead.
    const exceptions = {};
    for (const [host, sels] of this.exceptions) {
      exceptions[host] = [...sels].sort();
      if ([...sels].some((s) => complexAll.has(s))) this.addFlag(host, FLAG.complexException);
    }
    files['cosmetic/exceptions.json'] = exceptions;
    files['cosmetic/hostflags.json'] = Object.fromEntries([...this.hostFlags].sort(([a], [b]) => (a < b ? -1 : 1)));
    return { files, summary };
  }
}

export function cssHide(selectors, chunk = 50) {
  const out = [];
  for (let i = 0; i < selectors.length; i += chunk) {
    out.push(`${selectors.slice(i, i + chunk).join(',\n')}\n{display:none!important}`);
  }
  return out.join('\n');
}
