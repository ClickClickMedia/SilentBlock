// Lazy, memoised access to the build output (meta, registration, cosmetic data).
// The service worker can be torn down at any time, so nothing here is assumed warm.
const cache = new Map();

export function loadJSON(path) {
  let p = cache.get(path);
  if (!p) {
    p = fetch(chrome.runtime.getURL(path)).then((r) => {
      if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
      return r.json();
    });
    p.catch(() => cache.delete(path));
    cache.set(path, p);
  }
  return p;
}

export const getMeta = () => loadJSON('meta.json');
export const getRegistration = () => loadJSON('registration.json');
