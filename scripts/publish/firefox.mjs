// addons.mozilla.org: upload the Firefox build as a new listed version of silentblock@local,
// with the source archive attached (the build generates the rule and scriptlet files, so AMO
// reviewers need the source and build steps).
//   AMO_JWT_ISSUER=... AMO_JWT_SECRET=... node scripts/publish/firefox.mjs
// Credentials: https://addons.mozilla.org/developers/addon/api/key/
import { createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { call, need, releaseNotes, root, sleep, version, zipFor } from './common.mjs';

need(['AMO_JWT_ISSUER', 'AMO_JWT_SECRET'], 'firefox');
const API = 'https://addons.mozilla.org/api/v5';
const GUID = 'silentblock@local';

// AMO wants a fresh short-lived HS256 JWT on every request.
function jwt() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ iss: process.env.AMO_JWT_ISSUER, jti: randomUUID(), iat: now, exp: now + 60 });
  const sig = createHmac('sha256', process.env.AMO_JWT_SECRET).update(`${head}.${body}`).digest('base64url');
  return `JWT ${head}.${body}.${sig}`;
}

const v = await version();
const { body: addon } = await call(`${API}/addons/addon/${encodeURIComponent(GUID)}/`, { headers: { authorization: jwt() } }, 'addon');
if (addon.current_version?.version === v) { console.log(`firefox: v${v} is already live, nothing to do`); process.exit(0); }
console.log(`firefox: live v${addon.current_version?.version}, uploading v${v}`);

const form = new FormData();
form.set('upload', new Blob([await readFile(await zipFor('firefox'))]), `SilentBlock-${v}-firefox.zip`);
form.set('channel', 'listed');
let { body: up } = await call(`${API}/addons/upload/`, { method: 'POST', headers: { authorization: jwt() }, body: form }, 'upload');
for (let i = 0; !up.processed; i++) {
  if (i > 90) throw new Error('firefox: upload still validating after three minutes');
  await sleep(2000);
  ({ body: up } = await call(`${API}/addons/upload/${up.uuid}/`, { headers: { authorization: jwt() } }, 'upload status'));
}
if (!up.valid) throw new Error(`firefox: AMO rejected the package: ${JSON.stringify(up.validation?.messages?.filter((m) => m.type === 'error') || up.validation).slice(0, 1500)}`);

// Translated fields only work as JSON; the source archive only works as multipart. So:
// create the version as JSON, then attach the source to it.
const { body: created } = await call(`${API}/addons/addon/${encodeURIComponent(GUID)}/versions/`, {
  method: 'POST', headers: { authorization: jwt(), 'content-type': 'application/json' },
  body: JSON.stringify({ upload: up.uuid, release_notes: { 'en-US': (await releaseNotes(v)).slice(0, 3000) } }),
}, 'create version');
const src = new FormData();
src.set('source', new Blob([await readFile(path.join(root, 'release', `SilentBlock-${v}-source.zip`))]), `SilentBlock-${v}-source.zip`);
await call(`${API}/addons/addon/${encodeURIComponent(GUID)}/versions/${created.id}/`, {
  method: 'PATCH', headers: { authorization: jwt() }, body: src,
}, 'attach source');
console.log(`firefox: submitted v${created.version} (review: ${created.file?.status || 'pending'})`);

// Keep the AMO listing text in step with docs/store-listing.md (the one store with an API for it).
const listing = await readFile(path.join(root, 'docs/store-listing.md'), 'utf8');
const summary = /<!-- summary[^>]*-->\r?\n(.+)\r?\n/.exec(listing)?.[1]?.trim();
const description = /<!-- description -->\r?\n([\s\S]*?)\r?\n<!-- \/description -->/.exec(listing)?.[1]?.replace(/\r\n/g, '\n').trim();
if (summary && description) {
  await call(`${API}/addons/addon/${encodeURIComponent(GUID)}/`, {
    method: 'PATCH', headers: { authorization: jwt(), 'content-type': 'application/json' },
    body: JSON.stringify({ summary: { 'en-US': summary }, description: { 'en-US': description } }),
  }, 'update listing');
  console.log('firefox: listing text updated from docs/store-listing.md');
}
