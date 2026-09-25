// Refreshes the upstream filter list snapshots in filters/upstream/.
// The extension never fetches lists at runtime: snapshots are committed so builds are
// reproducible and every list change shows up as a reviewable diff.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const config = JSON.parse(await readFile(path.join(root, 'filters/lists.json'), 'utf8'));
const metaPath = path.join(root, 'filters/upstream/meta.json');
let meta = {};
try { meta = JSON.parse(await readFile(metaPath, 'utf8')); } catch { /* first run */ }

let failed = 0;
for (const list of config.lists.filter((l) => l.url)) {
  process.stdout.write(`${list.id.padEnd(18)} `);
  try {
    const res = await fetch(list.url, { headers: { 'user-agent': 'SilentBlock list updater' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const lines = text.split('\n').length;
    // A truncated or HTML error page must never replace a good snapshot.
    if (lines < 100 || /^\s*<(!doctype|html)/i.test(text)) throw new Error(`suspicious body (${lines} lines)`);
    await writeFile(path.join(root, list.file), text);
    meta[list.id] = {
      url: list.url,
      fetchedAt: new Date().toISOString(),
      lines,
      sha256: createHash('sha256').update(text).digest('hex'),
      version: (text.match(/^! (?:Version|Last modified):\s*(.+)$/m) || [])[1]?.trim() || null,
    };
    console.log(`ok  ${lines} lines`);
  } catch (err) {
    failed++;
    console.log(`FAILED  ${err.message} (kept previous snapshot)`);
  }
}

await writeFile(metaPath, JSON.stringify(meta, null, 2) + '\n');
if (failed) {
  console.error(`\n${failed} list(s) failed to update.`);
  process.exitCode = 1;
}
