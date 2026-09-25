// Settings normalisation and migration, against a fake chrome.storage.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let store = {};
globalThis.chrome = {
  storage: {
    local: {
      get: async () => structuredClone(store),
      set: async (o) => { Object.assign(store, structuredClone(o)); },
      clear: async () => { store = {}; },
    },
  },
};

const { normalise, migrate, defaults, allowlistEntryFor } = await import('../../src/background/state.js');

beforeEach(() => { store = {}; });

test('normalise fills defaults and rejects junk', () => {
  assert.deepEqual(normalise(undefined), defaults());
  const n = normalise({ enabled: 'yes', allowlist: ['B.com', 'b.com', 'bad host', 5, 'https://a.com/x'], categories: { ads: false, evil: true }, badge: 1 });
  assert.deepEqual(n, { ...defaults(), allowlist: ['a.com', 'b.com'], categories: { ads: false, privacy: true, annoyances: true } });
});

test('first install writes defaults', async () => {
  await migrate();
  assert.deepEqual(store, defaults());
});

test('an update never resets existing v2 settings', async () => {
  store = { ...defaults(), enabled: false, allowlist: ['keep.com'], categories: { ads: true, privacy: false, annoyances: true } };
  await migrate();
  assert.equal(store.enabled, false);
  assert.deepEqual(store.allowlist, ['keep.com']);
  assert.equal(store.categories.privacy, false);
});

test('v1 settings migrate and v1 leftovers are dropped', async () => {
  store = { enabled: false, disabledSites: ['Old.com', 'x.org'], updateAvailable: '1.6.1', updateUrl: 'https://github.com/...' };
  await migrate();
  assert.deepEqual(store, { ...defaults(), enabled: false, allowlist: ['old.com', 'x.org'] });
});

test('allowlist entries cover subdomains', () => {
  const s = { ...defaults(), allowlist: ['example.com'] };
  assert.equal(allowlistEntryFor('www.example.com', s), 'example.com');
  assert.equal(allowlistEntryFor('example.com', s), 'example.com');
  assert.equal(allowlistEntryFor('notexample.com', s), null);
});
