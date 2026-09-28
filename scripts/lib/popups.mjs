// Compiles `$popup` filters. DNR cannot block a popup, so the service worker watches new
// tabs a page opens and closes any that land on a matching URL (src/background/popups.js).
//
// Output (popups.json):
//   hosts      "||host^$popup"              any opener
//   hosts3p    "||host^$popup,third-party"  only when the opener is another site
//   rules      everything else: [regexSource, openerInclude[], openerExclude[], party]
//   allow      exceptions, same shape as rules
import { parseDomainList } from './parse.mjs';
import { isValidHostname } from '../../src/shared/hostnames.js';

const POPUP_OPTIONS = new Set(['popup']);
const PARTY = { 'third-party': 3, '3p': 3, 'first-party': 1, '1p': 1 };
// Options that don't change which popups match and can be ignored for the popup half.
const IGNORABLE = new Set(['important', 'match-case', 'reason', 'badfilter']);

// ABP pattern -> JS regex source. Same semantics as DNR urlFilter.
export function patternToRegexSource(pattern) {
  let p = pattern;
  let prefix = '';
  let suffix = '';
  if (p.startsWith('||')) { prefix = '^[a-z][a-z0-9+.-]*:\\/\\/(?:[^/?#]*\\.)?'; p = p.slice(2); }
  else if (p.startsWith('|')) { prefix = '^'; p = p.slice(1); }
  if (p.endsWith('|')) { suffix = '$'; p = p.slice(0, -1); }
  const body = p
    .replace(/[.+?${}()[\]\\/]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\^/g, '(?:[^\\w.%-]|$)');
  return prefix + body + suffix;
}

/** True if the filter carries `$popup`. */
export function isPopupFilter(net) {
  return net.options.some((o) => POPUP_OPTIONS.has(o.name) && !o.negated);
}

// The network filter left after removing `popup`, if it still names resource types
// (`$script,popup` is both a popup filter and a script filter). Null when nothing is left.
export function withoutPopup(net) {
  const rest = net.options.filter((o) => !POPUP_OPTIONS.has(o.name));
  const TYPES = new Set(['script', 'image', 'stylesheet', 'css', 'object', 'xmlhttprequest', 'xhr', 'subdocument', 'frame', 'ping', 'websocket', 'font', 'media', 'other', 'document', 'doc', 'all']);
  if (!rest.some((o) => TYPES.has(o.name) && !o.negated)) return null;
  return { ...net, options: rest, optionsText: rest.map((o) => `${o.negated ? '~' : ''}${o.name}${o.value !== null ? '=' + o.value : ''}`).join(',') };
}

export class PopupCompiler {
  constructor() {
    this.hosts = new Set();
    this.hosts3p = new Set();
    this.rules = [];
    this.allow = [];
    this.stats = {};
  }

  count(k) { this.stats[k] = (this.stats[k] || 0) + 1; }

  add(net) {
    let include = [];
    let exclude = [];
    let party = 0;
    for (const o of net.options) {
      if (POPUP_OPTIONS.has(o.name) || IGNORABLE.has(o.name)) continue;
      if (PARTY[o.name]) { party = o.negated ? (PARTY[o.name] === 3 ? 1 : 3) : PARTY[o.name]; continue; }
      if (o.name === 'domain' || o.name === 'from') {
        const d = parseDomainList(o.value || '', '|');
        if (d.hadInclude && !d.include.length) return this.count('entity-only');
        include = d.include;
        exclude = d.exclude;
        continue;
      }
      // Resource types belong to the network half; anything else we don't model here.
      if (/^(script|image|stylesheet|css|object|xmlhttprequest|xhr|subdocument|frame|ping|websocket|font|media|other|document|doc|all)$/.test(o.name)) continue;
      return this.count(`unsupported-${o.name}`);
    }
    if (net.isRegex) return this.count('regex-skipped');
    let pattern = net.pattern;
    if (!/^[\x20-\x7e]*$/.test(pattern)) return this.count('non-ascii');
    if (pattern === '' || pattern === '*') {
      if (!include.length) return this.count('match-everything');
      pattern = '*';
    }

    const host = /^\|\|([a-z0-9._-]+)\^$/.exec(pattern)?.[1];
    const simple = host && isValidHostname(host) && !include.length && !exclude.length;
    if (net.allow) {
      this.allow.push([patternToRegexSource(pattern), include, exclude, party]);
      return this.count('allow');
    }
    if (simple && party === 0) { this.hosts.add(host); return this.count('host'); }
    if (simple && party === 3) { this.hosts3p.add(host); return this.count('host-3p'); }
    this.rules.push([patternToRegexSource(pattern), include, exclude, party]);
    this.count('rule');
  }

  emit() {
    return {
      hosts: [...this.hosts].sort(),
      hosts3p: [...this.hosts3p].sort(),
      rules: this.rules,
      allow: this.allow,
    };
  }
}
