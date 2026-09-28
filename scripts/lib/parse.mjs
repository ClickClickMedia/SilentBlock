// Parses individual filter lines (ABP / uBO syntax) into plain objects.
// Anything we cannot faithfully represent returns { type: 'skip', reason } so the build
// can report exactly what was dropped instead of silently guessing.
import { domainToASCII } from 'node:url';
import { isValidHostname } from '../../src/shared/hostnames.js';

const COSMETIC_SEP_RE = /#@?(?:\?|\$\??|%)?#/;

export function parseLine(line) {
  if (!line) return null;
  if (line.startsWith('!') || line.startsWith('[')) return null;
  if (line.startsWith('#') && !COSMETIC_SEP_RE.test(line.slice(0, 5))) return null; // hosts-file comment

  const m = COSMETIC_SEP_RE.exec(line);
  if (m) {
    const before = line.slice(0, m.index);
    // A `#` inside a URL pattern (`||a.com/#!/ads$script`) is not a cosmetic filter.
    if (!/[|^$=]/.test(before)) return parseCosmetic(before, m[0], line.slice(m.index + m[0].length));
  }
  return parseNetwork(line);
}

// ---------------------------------------------------------------------------
// Domains

// Parses a cosmetic domain list ("a.com,~b.a.com,c.*") or a network `domain=` value
// ("a.com|~b.a.com"). Entities (`c.*`) and regex domains cannot be expressed in DNR or
// match patterns, so they are dropped; `hadInclude` lets callers refuse to turn a
// site-specific filter into a global one when every include was dropped.
export function parseDomainList(value, sep) {
  const include = [];
  const exclude = [];
  let hadInclude = false;
  let dropped = 0;
  for (let part of value.split(sep)) {
    part = part.trim().toLowerCase();
    if (!part) continue;
    const negated = part.startsWith('~');
    if (negated) part = part.slice(1);
    if (!negated) hadInclude = true;
    if (part.startsWith('/') || part.endsWith('.*') || part.includes('*')) { dropped++; continue; }
    const ascii = /^[\x00-\x7f]*$/.test(part) ? part : domainToASCII(part);
    if (!ascii || !isValidHostname(ascii)) { dropped++; continue; }
    (negated ? exclude : include).push(ascii);
  }
  return { include, exclude, hadInclude, dropped };
}

// ---------------------------------------------------------------------------
// Cosmetic + scriptlets

function parseCosmetic(domainPart, sep, body) {
  const exception = sep.includes('@');
  const domains = parseDomainList(domainPart, ',');
  if (domains.hadInclude && domains.include.length === 0) {
    return { type: 'skip', reason: 'cosmetic-entity-or-regex-domain' };
  }
  const base = { exception, include: domains.include, exclude: domains.exclude };

  if (sep === '#$#' || sep === '#@$#' || sep === '#$?#' || sep === '#@$?#') return { type: 'skip', reason: 'abp-snippet' };
  if (sep === '#%#' || sep === '#@%#') return { type: 'skip', reason: 'adguard-scriptlet' };

  if (sep === '##' || sep === '#@#') {
    if (body.startsWith('+js(')) return parseScriptlet(base, body);
    if (body.startsWith('^')) return { type: 'skip', reason: 'html-filter' };
  }
  if (!body) return { type: 'skip', reason: 'empty-selector' };
  return { type: 'cosmetic', procedural: sep.includes('?'), ...base, selector: body };
}

function unquote(arg) {
  if (arg.length >= 2) {
    const q = arg[0];
    if ((q === '"' || q === "'" || q === '`') && arg[arg.length - 1] === q) return arg.slice(1, -1);
  }
  return arg;
}

// Splits scriptlet arguments on unescaped commas. `\,` is a literal comma, and an
// argument wrapped in quotes may contain commas: set, a, "x, y".
export function splitScriptletArgs(inner) {
  const args = [];
  let cur = '';
  let quote = '';
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (quote) {
      if (c === '\\' && inner[i + 1] === quote) { cur += quote; i++; continue; }
      cur += c;
      if (c === quote) quote = '';
      continue;
    }
    if ((c === '"' || c === "'" || c === '`') && cur.trim() === '') { cur = c; quote = c; continue; }
    if (c === '\\' && inner[i + 1] === ',') { cur += ','; i++; continue; }
    if (c === ',') { args.push(cur); cur = ''; continue; }
    cur += c;
  }
  args.push(cur);
  return args.map((a) => unquote(a.trim()));
}

function parseScriptlet(base, body) {
  if (!body.endsWith(')')) return { type: 'skip', reason: 'scriptlet-malformed' };
  const inner = body.slice(4, -1);
  if (inner.trim() === '') return { type: 'scriptlet', ...base, name: '', args: [] };
  const [rawName, ...args] = splitScriptletArgs(inner);
  const name = rawName.replace(/\.js$/, '');
  // Trim trailing empty args so "set, a, 1," and "set, a, 1" compare equal for exceptions.
  while (args.length && args[args.length - 1] === '') args.pop();
  return { type: 'scriptlet', ...base, name, args };
}

// ---------------------------------------------------------------------------
// Network

// Finds the `$` that starts the options. Regex filters (`/re$/$script`) and URLs with a
// literal `$` need care: options must look like `[~]name[=...]`.
function findOptionsStart(s) {
  let from = s.length;
  const minIdx = s.startsWith('/') ? s.lastIndexOf('/') : 0;
  while (true) {
    const i = s.lastIndexOf('$', from - 1);
    if (i < minIdx || i < 0) return -1;
    if (/^~?[a-z0-9_-]+(=|,|$)/i.test(s.slice(i + 1))) return i;
    from = i;
    if (from <= 0) return -1;
  }
}

function parseNetwork(line) {
  let s = line;
  const allow = s.startsWith('@@');
  if (allow) s = s.slice(2);
  let optionsText = '';
  const oi = findOptionsStart(s);
  if (oi !== -1) {
    optionsText = s.slice(oi + 1);
    s = s.slice(0, oi);
  }
  const options = optionsText
    ? optionsText.split(',').map((o) => {
      const negated = o.startsWith('~');
      const body = negated ? o.slice(1) : o;
      const eq = body.indexOf('=');
      return eq === -1
        ? { name: body.toLowerCase(), value: null, negated }
        : { name: body.slice(0, eq).toLowerCase(), value: body.slice(eq + 1), negated };
    })
    : [];
  const isRegex = s.length > 2 && s.startsWith('/') && s.endsWith('/');
  return { type: 'network', allow, pattern: s, isRegex, options, optionsText, raw: line };
}

// Canonical text used to match `$badfilter` against the filter it cancels.
export function badfilterKey(net) {
  const opts = net.optionsText
    .split(',')
    .filter((o) => o && o.toLowerCase() !== 'badfilter')
    .sort()
    .join(',');
  return `${net.allow ? '@@' : ''}${net.pattern}${opts ? '$' + opts : ''}`;
}
