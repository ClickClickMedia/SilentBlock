// Compiles `site##+js(name, args...)` filters into MAIN-world bucket scripts.
//
// Each bucket is one self-contained file: the scriptlet library + a host table. It is
// registered with `matches` for exactly its hosts, so a site with no scriptlets never
// parses any of this. Hosts are spread over buckets by hash to keep each file small.
import { fnv1a, hostnameToMatchPatterns } from '../../src/shared/hostnames.js';

const ALIASES = {
  'set-constant': ['set'],
  'abort-on-property-read': ['aopr'],
  'abort-on-property-write': ['aopw'],
  'abort-current-script': ['acs', 'abort-current-inline-script', 'acis'],
  'abort-on-stack-trace': ['aost'],
  'prevent-window-open': ['nowoif', 'no-window-open-if', 'window.open-defuser'],
  'prevent-setTimeout': ['nostif', 'no-setTimeout-if', 'setTimeout-defuser'],
  'prevent-setInterval': ['nosiif', 'no-setInterval-if', 'setInterval-defuser'],
  'adjust-setTimeout': ['nano-stb', 'nano-setTimeout-booster'],
  'adjust-setInterval': ['nano-sib', 'nano-setInterval-booster'],
  'prevent-addEventListener': ['aeld', 'addEventListener-defuser'],
  'remove-node-text': ['rmnt'],
  'prevent-fetch': ['no-fetch-if'],
  'prevent-xhr': ['no-xhr-if'],
  'json-prune': [],
  'json-prune-fetch-response': [],
  'json-prune-xhr-response': [],
  'noeval-if': ['prevent-eval-if'],
  'noeval': ['silent-noeval'],
  'remove-attr': ['ra'],
  'remove-class': ['rc'],
  'set-attr': [],
  'set-cookie': [],
  'remove-cookie': ['cookie-remover'],
  'set-local-storage-item': [],
  'set-session-storage-item': [],
  'nobab': ['nobab2', 'bab-defuser'],
  'nofab': ['fuckadblock.js-3.2.0'],
  'nowebrtc': [],
  'refresh-defuser': [],
  'popads-dummy': [],
  'sb-unwall': [],
};

export const CANONICAL = new Map();
for (const [name, aliases] of Object.entries(ALIASES)) {
  CANONICAL.set(name, name);
  for (const a of aliases) CANONICAL.set(a, name);
}

const HOSTS_PER_BUCKET = 400;

export class ScriptletCompiler {
  constructor(categories) {
    this.categories = categories;
    this.table = Object.fromEntries(categories.map((c) => [c, new Map()])); // host -> Map(key -> [name,...args])
    this.exclusions = new Map(); // host -> Set(key | '*')
    this.globalExclusions = new Set();
    this.stats = {};
  }

  count(reason) { this.stats[reason] = (this.stats[reason] || 0) + 1; }

  static key(name, args) { return [name, ...args].join('\u0001'); }

  addExclusion(host, key) {
    let s = this.exclusions.get(host);
    if (!s) this.exclusions.set(host, (s = new Set()));
    s.add(key);
  }

  add(cat, f) {
    // `site#@#+js()` disables every scriptlet on the site.
    if (f.exception && f.name === '') {
      for (const h of f.include) this.addExclusion(h, '*');
      return this.count('exception-all');
    }
    const name = CANONICAL.get(f.name);
    if (!name) return this.count(f.name.startsWith('trusted-') ? 'trusted-skipped' : 'unsupported');
    const key = ScriptletCompiler.key(name, f.args);
    if (f.exception) {
      if (!f.include.length) this.globalExclusions.add(key);
      for (const h of f.include) this.addExclusion(h, key);
      return this.count('exception');
    }
    if (!f.include.length) return this.count('generic-skipped'); // never run a scriptlet on every site
    for (const h of f.exclude) this.addExclusion(h, key);
    const map = this.table[cat];
    for (const h of f.include) {
      let e = map.get(h);
      if (!e) map.set(h, (e = new Map()));
      e.set(key, [name, ...f.args]);
    }
    this.count('ok');
  }

  /**
   * @param {string} librarySource  contents of src/scriptlets/library.js (with unwall core inlined)
   * @returns {{ files: object, registrations: object, summary: object }}
   */
  emit(librarySource) {
    const files = {};
    const registrations = {};
    const summary = {};
    const exclusions = {};
    for (const [h, set] of this.exclusions) exclusions[h] = [...set].sort();

    for (const cat of this.categories) {
      const hosts = [...this.table[cat].keys()].filter((h) => {
        const entries = [...this.table[cat].get(h).entries()].filter(([k]) => !this.globalExclusions.has(k));
        this.table[cat].set(h, new Map(entries));
        return entries.length > 0;
      }).sort();
      const nBuckets = Math.max(1, Math.ceil(hosts.length / HOSTS_PER_BUCKET));
      const buckets = Array.from({ length: nBuckets }, () => []);
      for (const h of hosts) buckets[fnv1a(h) % nBuckets].push(h);

      registrations[cat] = [];
      buckets.forEach((bucketHosts, i) => {
        if (!bucketHosts.length) return;
        const table = {};
        for (const h of bucketHosts) table[h] = [...this.table[cat].get(h).values()];
        const file = `scriptlets/${cat}-${String(i).padStart(2, '0')}.js`;
        files[file] = bucketSource(librarySource, table, exclusions);
        registrations[cat].push({ file, matches: bucketHosts.flatMap(hostnameToMatchPatterns) });
      });
      summary[cat] = { hosts: hosts.length, buckets: registrations[cat].length };
    }
    return { files, registrations, summary };
  }
}

function bucketSource(librarySource, table, exclusions) {
  // The host lookup runs first so a frame that matched only by parent domain exits
  // before the library is even evaluated.
  return `(function () {
'use strict';
const TABLE = ${JSON.stringify(table)};
const EXCLUSIONS = ${JSON.stringify(exclusions)};
const hostname = location.hostname;
if (!hostname) return;
const parents = [];
for (let h = hostname; ; ) { parents.push(h); const i = h.indexOf('.'); if (i === -1) break; h = h.slice(i + 1); }
const excluded = new Set();
for (const h of parents) { const e = EXCLUSIONS[h]; if (e) for (const k of e) excluded.add(k); }
if (excluded.has('*')) return;
const todo = [];
const seen = new Set();
for (const h of parents) {
  const list = TABLE[h];
  if (!list) continue;
  for (const entry of list) {
    const key = entry.join('\\u0001');
    if (seen.has(key) || excluded.has(key)) continue;
    seen.add(key);
    todo.push(entry);
  }
}
if (!todo.length) return;
${librarySource}
for (const [name, ...args] of todo) {
  try { SCRIPTLETS[name](...args); } catch (e) { /* one broken scriptlet must not stop the rest */ }
}
})();
`;
}
