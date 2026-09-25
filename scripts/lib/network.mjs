// Converts parsed network filters into declarativeNetRequest rules.
//
// Priority ladder (higher wins; at equal priority DNR prefers allow > block > redirect):
//   10  block
//   11  redirect         beats a plain block of the same URL, loses to an exception
//   20  allow / allowAllRequests from list exceptions (@@)
//   30  $important block beats list exceptions, like uBO
//   31  $important redirect
//   1000 user allowlist (dynamic rule, see src/background/apply.js)
import { isValidHostname } from '../../src/shared/hostnames.js';
import { parseDomainList } from './parse.mjs';

export const PRIORITY = { block: 10, redirect: 11, allow: 20, important: 30, importantRedirect: 31 };

// Rule ids at or above this are allow rules. The popup counter uses it to count only blocks.
export const ALLOW_ID_BASE = 1_000_000;

const TYPE_MAP = {
  script: ['script'],
  image: ['image'],
  stylesheet: ['stylesheet'],
  css: ['stylesheet'],
  object: ['object'],
  'object-subrequest': ['object'],
  xmlhttprequest: ['xmlhttprequest'],
  xhr: ['xmlhttprequest'],
  subdocument: ['sub_frame'],
  frame: ['sub_frame'],
  ping: ['ping'],
  beacon: ['ping'],
  websocket: ['websocket'],
  font: ['font'],
  media: ['media'],
  other: ['other'],
  document: ['main_frame'],
  doc: ['main_frame'],
};
const ALL_TYPES = ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'media', 'websocket', 'other'];

const COSMETIC_FLAG_OPTIONS = {
  generichide: 'ghide', ghide: 'ghide',
  elemhide: 'ehide', ehide: 'ehide',
  specifichide: 'shide', shide: 'shide',
};

// Options that change nothing we can express and can be ignored safely.
const IGNORED_OPTIONS = new Set(['collapse', 'reason', 'empty', 'mp4']);

// Options whose semantics DNR cannot express. A filter using them is dropped rather than
// approximated, because an approximation blocks things the list author never meant to.
const UNSUPPORTED_OPTIONS = new Set([
  'csp', 'permissions', 'removeparam', 'replace', 'urlskip', 'uritransform', 'urltransform',
  'header', 'ipaddress', 'cname', 'rewrite', 'inline-script', 'inline-font', 'sitekey', 'webrtc',
  'genericblock', 'redirect-rule', 'popup', 'popunder',
]);

export const METHODS = new Set(['connect', 'delete', 'get', 'head', 'options', 'patch', 'post', 'put']);

// `||host^` is exactly "this host and its subdomains", which is what requestDomains means.
// `||host` without `^` also matches `hostile.com`, so it must stay a urlFilter. The loose
// form is only used to find the page host of cosmetic exceptions (`@@||site$ghide`).
function hostFromPattern(pattern, loose = false) {
  const m = (loose ? /^\|\|([a-z0-9._-]+)\^?\|?$/i : /^\|\|([a-z0-9._-]+)\^\|?$/i).exec(pattern);
  return m && isValidHostname(m[1].toLowerCase()) ? m[1].toLowerCase() : null;
}

// A regex that is really a literal ("/banner/ads/" or "/\/ads\//") becomes a cheap urlFilter.
function literalFromRegex(body) {
  if (!/^(?:[\w\-=&%]|\\[\/.?\-])+$/.test(body)) return null;
  return body.replace(/\\(.)/g, '$1');
}

// RE2 (used by DNR) has no lookaround or backreferences.
function isRe2Compatible(body) {
  if (body.length > 400) return false;
  if (/\(\?[=!<]/.test(body)) return false;
  if (/\\[1-9]/.test(body)) return false;
  try { new RegExp(body); } catch { return false; }
  return true;
}

/**
 * @returns {{ rule?: object, flags?: object, skip?: string }}
 *   rule  - DNR rule without id
 *   flags - cosmetic exception flags ({ hosts: [...], ghide, ehide, shide })
 *   skip  - reason the filter was dropped
 */
export function networkToRule(net, resources) {
  const condition = {};
  let types = null;       // positive resource types
  const negTypes = [];    // excluded resource types
  let important = false;
  let redirect = null;
  let allowDocument = false;
  const cosmeticFlags = {};

  for (const opt of net.options) {
    const { name, value, negated } = opt;
    if (TYPE_MAP[name]) {
      if (name === 'document' || name === 'doc') {
        if (net.allow && !negated) { allowDocument = true; continue; }
      }
      if (negated) negTypes.push(...TYPE_MAP[name]);
      else (types ||= []).push(...TYPE_MAP[name]);
      continue;
    }
    if (COSMETIC_FLAG_OPTIONS[name]) {
      if (!net.allow) return { skip: 'cosmetic-flag-on-block' };
      cosmeticFlags[COSMETIC_FLAG_OPTIONS[name]] = true;
      continue;
    }
    switch (name) {
      case 'all':
        (types ||= []).push(...ALL_TYPES);
        continue;
      case 'third-party': case '3p': case 'strict3p':
        condition.domainType = negated ? 'firstParty' : 'thirdParty';
        continue;
      case 'first-party': case '1p': case 'strict1p':
        condition.domainType = negated ? 'thirdParty' : 'firstParty';
        continue;
      case 'domain': case 'from': {
        const d = parseDomainList(value || '', '|');
        if (d.hadInclude && d.include.length === 0) return { skip: 'domain-entity-only' };
        if (d.include.length) condition.initiatorDomains = d.include;
        if (d.exclude.length) condition.excludedInitiatorDomains = d.exclude;
        continue;
      }
      case 'to': {
        const d = parseDomainList(value || '', '|');
        if (d.hadInclude && d.include.length === 0) return { skip: 'to-entity-only' };
        if (d.include.length) condition.requestDomains = d.include;
        if (d.exclude.length) condition.excludedRequestDomains = d.exclude;
        continue;
      }
      case 'denyallow': {
        const d = parseDomainList(value || '', '|');
        if (d.include.length) condition.excludedRequestDomains = [...(condition.excludedRequestDomains || []), ...d.include];
        continue;
      }
      case 'method': {
        const inc = []; const exc = [];
        for (let m of (value || '').toLowerCase().split('|')) {
          const n = m.startsWith('~');
          if (n) m = m.slice(1);
          if (!METHODS.has(m)) return { skip: 'method-unknown' };
          (n ? exc : inc).push(m);
        }
        if (inc.length) condition.requestMethods = inc;
        if (exc.length) condition.excludedRequestMethods = exc;
        continue;
      }
      case 'match-case':
        condition.isUrlFilterCaseSensitive = true;
        continue;
      case 'important':
        if (!net.allow) important = true;
        continue;
      case 'redirect': {
        const resName = (value || '').split(':')[0];
        redirect = resources[resName] || null; // unknown resource: uBO blocks, so do we
        if (!redirect && !resName) return { skip: 'redirect-empty' };
        continue;
      }
      case 'badfilter':
        return { skip: 'badfilter' };
      default:
        if (IGNORED_OPTIONS.has(name)) continue;
        if (UNSUPPORTED_OPTIONS.has(name)) return { skip: `option-${name}` };
        return { skip: 'option-unknown' };
    }
  }

  // A `$document` exception switches off element hiding too (ABP semantics).
  if (allowDocument) cosmeticFlags.ehide = true;
  let flags = null;
  if (Object.keys(cosmeticFlags).length) {
    const hosts = [];
    const h = hostFromPattern(net.pattern, true);
    if (h) hosts.push(h);
    if (condition.initiatorDomains) hosts.push(...condition.initiatorDomains);
    if (hosts.length) flags = { hosts, ...cosmeticFlags };
    // Pure cosmetic exception (@@||site^$ghide): not a network rule at all.
    if (!allowDocument && !types) return flags ? { flags } : { skip: 'cosmetic-flag-no-host' };
  }

  // URL pattern
  let pattern = net.pattern;
  if (net.isRegex) {
    const body = pattern.slice(1, -1);
    const lit = literalFromRegex(body);
    if (lit !== null) condition.urlFilter = lit;
    else if (isRe2Compatible(body)) condition.regexFilter = body;
    else return { skip: 'regex-unsupported' };
  } else {
    if (!/^[\x20-\x7e]*$/.test(pattern)) return { skip: 'non-ascii-pattern' };
    if (pattern.startsWith('||*')) pattern = pattern.slice(2);
    if (pattern.length > 1) pattern = pattern.replace(/^\*+/, '').replace(/\*+$/, '');
    if (pattern === '*') pattern = '';
    const host = hostFromPattern(pattern);
    if (host && !condition.requestDomains) {
      condition.requestDomains = [host];
    } else if (pattern) {
      condition.urlFilter = pattern;
    }
  }

  const hasTarget = condition.urlFilter || condition.regexFilter || condition.requestDomains;
  if (!hasTarget && !condition.initiatorDomains) return { skip: 'match-everything' };

  // Resource types
  if (types) {
    let t = [...new Set(types)].filter((x) => !negTypes.includes(x));
    if (!t.length) return { skip: 'no-resource-types' };
    condition.resourceTypes = t.sort();
  } else if (negTypes.length) {
    condition.excludedResourceTypes = [...new Set(negTypes)].sort();
  }

  let action;
  let priority;
  if (net.allow) {
    if (allowDocument) {
      action = { type: 'allowAllRequests' };
      condition.resourceTypes = ['main_frame', 'sub_frame'];
      delete condition.excludedResourceTypes;
    } else {
      action = { type: 'allow' };
    }
    priority = PRIORITY.allow;
  } else if (redirect) {
    action = { type: 'redirect', redirect: { extensionPath: `/resources/${redirect}` } };
    priority = important ? PRIORITY.importantRedirect : PRIORITY.redirect;
    // A redirect with no type would swap images and frames for a script stub.
    if (!condition.resourceTypes) return { skip: 'redirect-without-type' };
  } else {
    action = { type: 'block' };
    priority = important ? PRIORITY.important : PRIORITY.block;
  }

  return flags ? { rule: { priority, action, condition }, flags } : { rule: { priority, action, condition } };
}

function sortedKey(obj) {
  return JSON.stringify(obj, Object.keys(obj).sort());
}

// Folds rules that differ only in `requestDomains` into one rule with a combined list.
// EasyList + EasyPrivacy are ~99k `||host^` filters that collapse to a few dozen rules.
export function mergeRules(rules) {
  const merged = new Map();
  const out = [];
  for (const r of rules) {
    const c = r.condition;
    const mergeable = c.requestDomains && !c.urlFilter && !c.regexFilter && !c.excludedRequestDomains;
    if (!mergeable) { out.push(r); continue; }
    const { requestDomains, ...rest } = c;
    const key = sortedKey({ p: r.priority, a: sortedKey(r.action), c: sortedKey(rest) });
    let m = merged.get(key);
    if (!m) {
      m = { priority: r.priority, action: r.action, condition: { ...rest, requestDomains: new Set() } };
      merged.set(key, m);
      out.push(m);
    }
    for (const d of requestDomains) m.condition.requestDomains.add(d);
  }
  for (const m of merged.values()) {
    // Drop domains already covered by a parent in the same rule (ads.x.com under x.com).
    const set = m.condition.requestDomains;
    const kept = [...set].filter((d) => {
      let i = d.indexOf('.');
      while (i !== -1) {
        if (set.has(d.slice(i + 1))) return false;
        i = d.indexOf('.', i + 1);
      }
      return true;
    });
    m.condition.requestDomains = kept.sort();
  }
  // Exact duplicates (the same filter in two lists) collapse too.
  const seen = new Set();
  return out.filter((r) => {
    const k = sortedKey({ p: r.priority, a: sortedKey(r.action), c: sortedKey(r.condition) });
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Assigns ids: blocks/redirects from 1, allow rules from ALLOW_ID_BASE.
export function assignIds(rules) {
  let blockId = 1;
  let allowId = ALLOW_ID_BASE;
  return rules.map((r) => {
    const isAllow = r.action.type === 'allow' || r.action.type === 'allowAllRequests';
    return { id: isAllow ? allowId++ : blockId++, ...r };
  });
}
