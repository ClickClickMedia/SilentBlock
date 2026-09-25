// Hostname helpers shared by the build scripts (Node) and the extension runtime.
// Keep this file dependency-free: it is imported by the service worker as-is.

// "a.b.example.com" -> ["a.b.example.com", "b.example.com", "example.com", "com"]
export function hostnameAndParents(hostname) {
  const out = [];
  let h = hostname;
  while (h) {
    out.push(h);
    const dot = h.indexOf('.');
    if (dot === -1) break;
    h = h.slice(dot + 1);
  }
  return out;
}

const HOST_RE = /^(?=.{1,253}$)[a-z0-9_](?:[a-z0-9_-]{0,62}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,62}[a-z0-9_])?)*$/;

export function isValidHostname(hostname) {
  return typeof hostname === 'string' && HOST_RE.test(hostname);
}

// Normalise user or list input ("https://WWW.Example.com/x", "example.com.") to a bare hostname,
// or return null if it is not one.
export function normaliseHostname(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim().toLowerCase();
  if (!s) return null;
  if (s.includes('://')) {
    try { s = new URL(s).hostname; } catch { return null; }
  }
  s = s.replace(/^\*\./, '').replace(/\.$/, '');
  if (s.includes('/') || s.includes(':')) return null;
  return isValidHostname(s) ? s : null;
}

// Match patterns that cover a hostname and all of its subdomains, over http and https.
export function hostnameToMatchPatterns(hostname) {
  return [`*://${hostname}/*`, `*://*.${hostname}/*`];
}

// True when `hostname` is `domain` or a subdomain of it.
export function hostnameIsWithin(hostname, domain) {
  return hostname === domain || hostname.endsWith('.' + domain);
}

// Stable 32-bit FNV-1a, used to shard per-host data files.
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export const SPECIFIC_SHARDS = 32;

export function shardOf(hostname) {
  return fnv1a(hostname) % SPECIFIC_SHARDS;
}
