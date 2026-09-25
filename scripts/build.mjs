// Builds dist/chrome and dist/firefox from src/ and the filter lists.
//
//   node scripts/build.mjs               full build, selectors validated in headless Chromium
//   node scripts/build.mjs --no-validate skip browser validation (faster, CI without a browser)
import { readFile, writeFile, mkdir, rm, cp } from 'node:fs/promises';
import path from 'node:path';
import { preprocess } from './lib/preprocess.mjs';
import { parseLine, badfilterKey } from './lib/parse.mjs';
import { networkToRule, mergeRules, assignIds, ALLOW_ID_BASE } from './lib/network.mjs';
import { CosmeticCompiler, FLAG } from './lib/cosmetic.mjs';
import { ScriptletCompiler } from './lib/scriptlets.mjs';
import { RESOURCES } from './lib/resources.mjs';
import { validateSelectors, validateRegexes } from './lib/validate-selectors.mjs';

const root = path.resolve(import.meta.dirname, '..');
const args = new Set(process.argv.slice(2));
const VALIDATE = !args.has('--no-validate');

// DNR allows 1000 regex rules across all enabled rulesets; keep headroom.
const REGEX_CAP = { core: 50, ads: 600, privacy: 250, annoyances: 50 };

const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const config = JSON.parse(await readFile(path.join(root, 'filters/lists.json'), 'utf8'));
let upstreamMeta = {};
try { upstreamMeta = JSON.parse(await readFile(path.join(root, 'filters/upstream/meta.json'), 'utf8')); } catch { /* none yet */ }
const categories = Object.keys(config.categories);
const t0 = Date.now();

// ---- 1. read + preprocess + parse ------------------------------------------------
const parsed = [];
const listStats = {};
for (const list of config.lists) {
  const text = await readFile(path.join(root, list.file), 'utf8');
  const { lines, includes } = preprocess(text);
  let n = 0;
  for (const line of lines) {
    const p = parseLine(line);
    if (!p) continue;
    parsed.push({ list, p });
    n++;
  }
  listStats[list.id] = { filters: n, includesSkipped: includes };
}

// ---- 2. $badfilter cancels matching filters in every list -------------------------
const badfilters = new Set();
for (const { p } of parsed) {
  if (p.type === 'network' && p.options.some((o) => o.name === 'badfilter')) badfilters.add(badfilterKey(p));
}

// ---- 3. route filters ----------------------------------------------------------------
const rulesByCat = Object.fromEntries(categories.map((c) => [c, []]));
const cosmetic = new CosmeticCompiler(categories);
const scriptlets = new ScriptletCompiler(categories);
const netStats = {};
const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };

for (const { list, p } of parsed) {
  const cat = list.category;
  if (p.type === 'skip') { bump(netStats, `skip:${p.reason}`); continue; }
  if (p.type === 'cosmetic') { cosmetic.add(cat, p); continue; }
  if (p.type === 'scriptlet') { scriptlets.add(cat, p); continue; }
  if (badfilters.has(badfilterKey(p))) { bump(netStats, 'badfiltered'); continue; }
  const r = networkToRule(p, RESOURCES);
  if (r.skip) { bump(netStats, `skip:${r.skip}`); continue; }
  if (r.flags) {
    for (const h of r.flags.hosts) {
      if (r.flags.ghide) cosmetic.addFlag(h, FLAG.ghide);
      if (r.flags.ehide) cosmetic.addFlag(h, FLAG.ehide);
      if (r.flags.shide) cosmetic.addFlag(h, FLAG.shide);
    }
  }
  if (r.rule) { rulesByCat[cat].push(r.rule); bump(netStats, 'rule'); }
}

// ---- 4. network rulesets ----------------------------------------------------------------
// One regex Chromium rejects fails the whole extension at load, so every regexFilter is
// checked with declarativeNetRequest.isRegexSupported. Without a browser, fall back to a
// conservative heuristic: no counted repetition above 100.
const regexKey = (r) => `${r.condition.regexFilter}${Boolean(r.condition.isUrlFilterCaseSensitive)}`;
let badRegex;
if (VALIDATE) {
  const items = new Map();
  for (const cat of categories) for (const r of rulesByCat[cat]) {
    if (r.condition.regexFilter) items.set(regexKey(r), { regex: r.condition.regexFilter, isCaseSensitive: Boolean(r.condition.isUrlFilterCaseSensitive) });
  }
  badRegex = await validateRegexes([...items.values()]);
} else {
  badRegex = new Set();
  for (const cat of categories) for (const r of rulesByCat[cat]) {
    const re = r.condition.regexFilter;
    if (re && /\{\d*,?(\d{3,}|[2-9]\d{2})\}|\{\d{3,}/.test(re)) badRegex.add(regexKey(r));
  }
}
netStats['regex-rejected'] = 0;
for (const cat of categories) {
  rulesByCat[cat] = rulesByCat[cat].filter((r) => {
    if (!r.condition.regexFilter || !badRegex.has(regexKey(r))) return true;
    netStats['regex-rejected']++;
    return false;
  });
}

const out = {}; // relative path -> string | object
const rulesetSummary = {};
for (const cat of categories) {
  let rules = mergeRules(rulesByCat[cat]);
  const regex = rules.filter((r) => r.condition.regexFilter);
  if (regex.length > REGEX_CAP[cat]) {
    const drop = new Set(regex.slice(REGEX_CAP[cat]));
    rules = rules.filter((r) => !drop.has(r));
    netStats[`regex-capped:${cat}`] = drop.size;
  }
  rules = assignIds(rules);
  out[`rules/${cat}.json`] = rules;
  rulesetSummary[cat] = {
    rules: rules.length,
    block: rules.filter((r) => r.id < ALLOW_ID_BASE).length,
    allow: rules.filter((r) => r.id >= ALLOW_ID_BASE).length,
    regex: rules.filter((r) => r.condition.regexFilter).length,
    domains: rules.reduce((n, r) => n + (r.condition.requestDomains?.length || 0), 0),
  };
}

// ---- 5. selector validation ----------------------------------------------------------------
if (VALIDATE) {
  const all = [...cosmetic.allSelectors()];
  const invalid = await validateSelectors(all);
  cosmetic.applyValidation((s) => !invalid.has(s));
} else {
  cosmetic.stats['invalid-selector'] = 'not validated';
}

// ---- 6. cosmetic + scriptlet outputs ----------------------------------------------------------
const cos = cosmetic.emit();
Object.assign(out, cos.files);

const unwallCore = await readFile(path.join(root, 'src/shared/unwall-core.js'), 'utf8');
const library = (await readFile(path.join(root, 'src/scriptlets/library.js'), 'utf8'))
  .replace('/*@UNWALL_CORE@*/', unwallCore.replace(/^\/\* eslint.*$/m, ''));
const sl = scriptlets.emit(library);
Object.assign(out, sl.files);

const hostflags = cos.files['cosmetic/hostflags.json'];
const hostsWith = (mask) => Object.entries(hostflags).filter(([, f]) => f & mask).map(([h]) => h).sort();
out['registration.json'] = {
  // Static complex stylesheet: not on sites with a generic exception we cannot subtract.
  complexCssExcludeHosts: hostsWith(FLAG.ghide | FLAG.ehide | FLAG.complexException),
  // Token reporter: not on sites that turn generic (or all) cosmetics off.
  tokenExcludeHosts: hostsWith(FLAG.ghide | FLAG.ehide),
  scriptlets: sl.registrations,
};

out['content/unwall.js'] = `// Built from src/shared/unwall-core.js. Injected on demand by the popup and on
// per-site "always kill nag walls" hosts. Wrapped so a second injection is harmless.
(() => {
${unwallCore}
unwallWatch(15000);
})();
`;

// ---- 7. meta --------------------------------------------------------------------------------
const meta = {
  version: pkg.version,
  builtAt: new Date().toISOString(),
  categories: config.categories,
  lists: config.lists.map((l) => ({
    id: l.id, title: l.title, category: l.category, url: l.url || null, license: l.license || null,
    snapshot: upstreamMeta[l.id]?.fetchedAt || null, version: upstreamMeta[l.id]?.version || null,
    filters: listStats[l.id].filters,
  })),
  rulesets: rulesetSummary,
  cosmetic: cos.summary,
  scriptlets: sl.summary,
  allowIdBase: ALLOW_ID_BASE,
};
out['meta.json'] = meta;

// ---- 8. write dist/<target> -------------------------------------------------------------------
const manifestBase = JSON.parse(await readFile(path.join(root, 'src/manifest.json'), 'utf8'));

function manifestFor(target) {
  const m = structuredClone(manifestBase);
  m.version = pkg.version;
  m.declarative_net_request = {
    rule_resources: categories.map((cat) => ({
      id: cat,
      enabled: config.categories[cat].alwaysOn || config.categories[cat].default === true,
      path: `rules/${cat}.json`,
    })),
  };
  if (target === 'firefox') {
    m.background = { scripts: ['background/main.js'], type: 'module' };
    m.browser_specific_settings = { gecko: { id: 'silentblock@clickclickmedia.com.au', strict_min_version: '128.0' } };
    delete m.minimum_chrome_version;
  }
  return m;
}

const report = [];
for (const target of ['chrome', 'firefox']) {
  const dist = path.join(root, 'dist', target);
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });
  for (const dir of ['background', 'popup', 'options', 'content', 'shared', 'icons', 'resources']) {
    await cp(path.join(root, 'src', dir), path.join(dist, dir), { recursive: true });
  }
  await rm(path.join(dist, 'shared/unwall-core.js'), { force: true });
  for (const [rel, data] of Object.entries(out)) {
    const file = path.join(dist, rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof data === 'string' ? data : JSON.stringify(data));
  }
  await writeFile(path.join(dist, 'manifest.json'), JSON.stringify(manifestFor(target), null, 2));
  report.push(target);
}

// ---- 9. report ------------------------------------------------------------------------------------
const totalRules = Object.values(rulesetSummary).reduce((n, s) => n + s.rules, 0);
console.log(`SilentBlock ${pkg.version} built for ${report.join(' + ')} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.table(rulesetSummary);
console.log(`Static rules: ${totalRules} (Chrome guarantees 30000 per extension)`);
console.table(cos.summary);
console.table(sl.summary);
const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k}=${v}`).join('  ');
console.log(`network: ${top(netStats)}`);
console.log(`cosmetic: ${top(cosmetic.stats)}`);
console.log(`scriptlets: ${top(scriptlets.stats)}`);
await writeFile(path.join(root, 'dist/build-report.json'), JSON.stringify({ meta, netStats, cosmeticStats: cosmetic.stats, scriptletStats: scriptlets.stats }, null, 2));
if (totalRules > 30000) {
  console.error(`\nERROR: ${totalRules} static rules exceeds the 30000 guaranteed minimum.`);
  process.exitCode = 1;
}
