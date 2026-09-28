// Path matching for the security page-URL list, with ABP separator semantics.
// Shared by the service worker and the unit tests.
//
// An entry is a path prefix, optionally ending in "^". Without "^" it is a plain prefix
// (`/spt/` matches `/spt/anything`). With "^" the path must end there or continue with a
// separator, so `/6Y3zq^` matches `/6Y3zq` and `/6Y3zq?x` but NOT `/6Y3zqABC`, which on a
// link shortener is someone else's link.

// ABP: a separator is anything but a letter, digit, or one of _ - . %
const WORD = /[A-Za-z0-9_\-.%]/;

export function pathMatches(path, entry) {
  if (!entry.endsWith('^')) return path.startsWith(entry);
  const base = entry.slice(0, -1);
  if (!path.startsWith(base)) return false;
  const next = path.charAt(base.length);
  return next === '' || !WORD.test(next);
}
