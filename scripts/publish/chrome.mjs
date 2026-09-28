// Chrome Web Store: upload the Chrome zip and submit it for review.
//   node scripts/publish/chrome.mjs            upload + submit
//   node scripts/publish/chrome.mjs --status   show what the store has
//
// Auth is the CCM Web Store service account, never a key file:
//   - in GitHub Actions, CWS_ACCESS_TOKEN comes from Workload Identity Federation
//   - locally, gcloud impersonates the service account for whoever is signed in
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { call, sleep, version, zipFor } from './common.mjs';

const PUBLISHER = process.env.CWS_PUBLISHER_ID || 'b7b011da-ecfd-4ec1-8d99-c600f9c31543';
const ITEM = process.env.CWS_ITEM_ID || 'accdpphckockpflaggbplikpmaknioao';
const SERVICE_ACCOUNT = process.env.CWS_SERVICE_ACCOUNT || 'cws-publisher@clicktrack-505800.iam.gserviceaccount.com';
const API = `https://chromewebstore.googleapis.com/v2/publishers/${PUBLISHER}/items/${ITEM}`;
const UPLOAD = `https://chromewebstore.googleapis.com/upload/v2/publishers/${PUBLISHER}/items/${ITEM}:upload`;

function token() {
  if (process.env.CWS_ACCESS_TOKEN) return process.env.CWS_ACCESS_TOKEN;
  // gcloud is often not on PATH on Windows; the quotes survive the space in "Cloud SDK".
  const win = path.join(homedir(), 'AppData/Local/Google/Cloud SDK/google-cloud-sdk/bin/gcloud.cmd');
  const gcloud = process.platform === 'win32' && existsSync(win) ? `"${win}"` : 'gcloud';
  try {
    return execSync(`${gcloud} auth print-access-token --impersonate-service-account=${SERVICE_ACCOUNT} --scopes=https://www.googleapis.com/auth/chromewebstore`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    const err = String(e.stderr || e);
    if (/Reauthentication|auth login/.test(err)) throw new Error('gcloud needs signing in again: gcloud auth login');
    throw new Error(`Could not get a Web Store token: ${err.split('\n')[0]}`);
  }
}

const describe = (r) => {
  if (!r?.state) return 'none';
  const v = (r.distributionChannels || []).map((c) => c.crxVersion).filter(Boolean);
  return `${r.state}${v.length ? ` (v${v.join(', v')})` : ''}`;
};

const t = token();
const auth = { authorization: `Bearer ${t}` };
const status = async () => {
  const { body } = await call(`${API}:fetchStatus`, { headers: auth }, 'fetchStatus');
  console.log(`chrome: published ${describe(body.publishedItemRevisionStatus)}, submitted ${describe(body.submittedItemRevisionStatus)}`);
  if (body.takenDown || body.warned) console.log(`chrome: POLICY takenDown=${body.takenDown} warned=${body.warned}`);
  return body;
};

const before = await status();
if (process.argv.includes('--status')) process.exit(0);

const v = await version();
const published = (before.publishedItemRevisionStatus?.distributionChannels || []).map((c) => c.crxVersion);
if (published.includes(v)) { console.log(`chrome: v${v} is already published, nothing to do`); process.exit(0); }
if (before.submittedItemRevisionStatus?.state === 'PENDING_REVIEW') {
  console.error('chrome: a submission is already waiting for review; wait for it or cancel it in the dashboard');
  process.exit(1);
}

console.log(`chrome: uploading v${v}`);
let { body: up } = await call(UPLOAD, { method: 'POST', headers: { ...auth, 'content-type': 'application/zip' }, body: readFileSync(await zipFor('chrome')) }, 'upload');
for (let i = 0; up.uploadState === 'UPLOAD_IN_PROGRESS' || (!up.uploadState && i === 0); i++) {
  if (i > 60) throw new Error('chrome: upload still processing after two minutes; check the dashboard');
  await sleep(2000);
  const { body: s } = await call(`${API}:fetchStatus`, { headers: auth }, 'fetchStatus');
  up = { ...up, uploadState: s.lastAsyncUploadState };
}
if (up.uploadState !== 'SUCCEEDED') throw new Error(`chrome: upload did not succeed: ${JSON.stringify(up)}`);
if (up.crxVersion && up.crxVersion !== v) throw new Error(`chrome: store read v${up.crxVersion} from the zip, package.json says ${v}`);

const { body: pub } = await call(`${API}:publish`, {
  method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ publishType: 'DEFAULT_PUBLISH' }),
}, 'publish');
console.log(`chrome: submitted v${v} for review (${pub.state ?? 'ok'})`);
if (pub.warningInfo) console.log(`chrome: warnings ${JSON.stringify(pub.warningInfo)}`);
