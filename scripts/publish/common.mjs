// Shared bits for the store publishers.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export const root = path.resolve(import.meta.dirname, '..', '..');

export async function version() {
  return JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
}

export async function zipFor(target) {
  const v = await version();
  const file = path.join(root, 'release', `SilentBlock-${v}-${target}.zip`);
  try { await stat(file); } catch { throw new Error(`${path.relative(root, file)} is missing: run npm run package first`); }
  return file;
}

// The CHANGELOG section for a version, as plain text for store "what's new" fields.
export async function releaseNotes(v) {
  const cl = await readFile(path.join(root, 'CHANGELOG.md'), 'utf8');
  const start = cl.indexOf(`## [${v}]`);
  if (start === -1) return `SilentBlock ${v}`;
  const next = cl.indexOf('\n## [', start + 1);
  return cl.slice(cl.indexOf('\n', start) + 1, next === -1 ? undefined : next).trim();
}

export async function call(url, init, what) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`${what}: HTTP ${res.status} ${JSON.stringify(body).slice(0, 800)}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return { body, res };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Store scripts exit 0 with a notice when their credentials are absent, so one release
// workflow can publish to whichever stores are configured.
export function need(names, store) {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) {
    console.log(`${store}: skipped, missing ${missing.join(', ')}`);
    process.exit(0);
  }
}
