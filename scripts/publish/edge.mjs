// Microsoft Edge Add-ons: upload the Edge zip (the Chrome build with the polite icons) to the draft
// submission, then publish it for certification.
//   EDGE_PRODUCT_ID=... EDGE_CLIENT_ID=... EDGE_API_KEY=... node scripts/publish/edge.mjs
// Credentials: Partner Center > Microsoft Edge > Publish API. The product ID is the Partner
// Center GUID of the SilentBlock product, not the store's hhdolnhpfeeipbomjfkalbhegkakbkmo.
import { readFile } from 'node:fs/promises';
import { call, need, releaseNotes, sleep, version, zipFor } from './common.mjs';

need(['EDGE_PRODUCT_ID', 'EDGE_CLIENT_ID', 'EDGE_API_KEY'], 'edge');
const API = `https://api.addons.microsoftedge.microsoft.com/v1/products/${process.env.EDGE_PRODUCT_ID}/submissions`;
const auth = { authorization: `ApiKey ${process.env.EDGE_API_KEY}`, 'x-clientid': process.env.EDGE_CLIENT_ID };

// Uploads and publishes are asynchronous: the POST returns an operation id in Location.
async function waitFor(url, what) {
  for (let i = 0; i < 90; i++) {
    await sleep(3000);
    const { body } = await call(url, { headers: auth }, `${what} status`);
    if (body.status === 'Succeeded') return body;
    if (body.status === 'Failed') throw new Error(`edge: ${what} failed: ${JSON.stringify(body).slice(0, 1500)}`);
  }
  throw new Error(`edge: ${what} still running after four minutes`);
}

const v = await version();
console.log(`edge: uploading v${v}`);
const { res: upRes } = await call(`${API}/draft/package`, {
  method: 'POST', headers: { ...auth, 'content-type': 'application/zip' }, body: await readFile(await zipFor('edge')),
}, 'upload');
await waitFor(`${API}/draft/package/operations/${upRes.headers.get('location')}`, 'upload');

const { res: pubRes } = await call(API, {
  method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
  body: JSON.stringify({ notes: (await releaseNotes(v)).slice(0, 1500) }),
}, 'publish');
try {
  await waitFor(`${API}/operations/${pubRes.headers.get('location')}`, 'publish');
} catch (err) {
  // Edge takes one submission at a time. While the previous version is still being
  // certified, the new package sits in the draft; submit it once certification finishes.
  if (/InProgressSubmission/.test(err.message)) {
    console.log(`edge: v${v} is uploaded to the draft, but the previous version is still in certification.`);
    console.log(`edge: once it clears, run: gh workflow run publish.yml -f tag=v${v} -f stores=edge`);
    process.exit(0);
  }
  throw err;
}
console.log(`edge: submitted v${v} for certification`);
