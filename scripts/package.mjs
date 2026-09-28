// Zips dist/chrome and dist/firefox into release/. manifest.json sits at the zip root,
// which is what the Chrome Web Store and addons.mozilla.org expect.
//   node scripts/package.mjs
import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

async function walk(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    // Chrome writes _metadata/ into an unpacked folder it has loaded; stores reject "_" paths.
    if (entry.name.startsWith('_')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full, base));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

// Minimal zip writer (deflate + CRC32 from node:zlib). Timestamps are fixed so the same
// build produces the same bytes.
function zip(files) {
  const local = [];
  const central = [];
  let offset = 0;
  const DOS_TIME = 0;
  const DOS_DATE = (1 << 5) | 1; // 1980-01-01
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const crc = zlib.crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6); // UTF-8 names
    header.writeUInt16LE(useDeflate ? 8 : 0, 8);
    header.writeUInt16LE(DOS_TIME, 10);
    header.writeUInt16LE(DOS_DATE, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);
    local.push(header, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(useDeflate ? 8 : 0, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += header.length + nameBuf.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cdBuf, end]);
}

const outDir = path.join(root, 'release');
await mkdir(outDir, { recursive: true });
for (const target of ['chrome', 'firefox']) {
  const dir = path.join(root, 'dist', target);
  try { await stat(path.join(dir, 'manifest.json')); } catch { throw new Error(`dist/${target} missing: run npm run build first`); }
  const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
  if (manifest.version !== pkg.version) throw new Error(`dist/${target} is ${manifest.version}, package.json is ${pkg.version}: rebuild`);
  const names = await walk(dir);
  const files = await Promise.all(names.map(async (name) => ({ name, data: await readFile(path.join(dir, name)) })));
  const file = path.join(outDir, `SilentBlock-${pkg.version}-${target}.zip`);
  await writeFile(file, zip(files));
  const size = (await stat(file)).size;
  console.log(`${path.relative(root, file)}  ${names.length} files, ${(size / 1024 / 1024).toFixed(1)} MB`);
}

// Source archive of the tagged tree, for store reviewers (AMO requires it for generated code).
const source = path.join(outDir, `SilentBlock-${pkg.version}-source.zip`);
execFileSync('git', ['archive', '--format=zip', `--output=${source}`, 'HEAD'], { cwd: root });
console.log(`${path.relative(root, source)}  source (git archive HEAD), ${((await stat(source)).size / 1024 / 1024).toFixed(1)} MB`);

