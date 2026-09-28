// Bumps the version in package.json (the build writes it into the manifest) and turns the
// CHANGELOG "Unreleased" section into a dated release heading.
//   node scripts/bump.mjs patch | minor | major | 2.3.4
// Git is left to you: stage the files by name, never `git add -A`.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const arg = process.argv[2] || 'patch';
const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
const [maj, min, pat] = pkg.version.split('.').map(Number);

let next;
if (/^\d+\.\d+\.\d+$/.test(arg)) next = arg;
else if (arg === 'major') next = `${maj + 1}.0.0`;
else if (arg === 'minor') next = `${maj}.${min + 1}.0`;
else if (arg === 'patch') next = `${maj}.${min}.${pat + 1}`;
else throw new Error(`Usage: bump.mjs patch|minor|major|x.y.z (got "${arg}")`);

pkg.version = next;
await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

const lockPath = path.join(root, 'package-lock.json');
try {
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  lock.version = next;
  if (lock.packages?.['']) lock.packages[''].version = next;
  await writeFile(lockPath, JSON.stringify(lock, null, 2) + '\n');
} catch { /* no lockfile */ }

const clPath = path.join(root, 'CHANGELOG.md');
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date());
let cl = await readFile(clPath, 'utf8');
if (cl.includes(`## [${next}]`)) {
  console.log(`CHANGELOG.md already has a ${next} entry; left as is.`);
} else if (cl.includes('## [Unreleased]')) {
  cl = cl.replace('## [Unreleased]', `## [Unreleased]\n\n## [${next}] - ${today}`);
  await writeFile(clPath, cl);
} else {
  console.warn('CHANGELOG.md has no "## [Unreleased]" section; add the release notes by hand.');
}

console.log(`${pkg.name} ${[maj, min, pat].join('.')} -> ${next}`);
console.log('Next: npm run check && npm run package, then commit package.json package-lock.json CHANGELOG.md and tag v' + next);
