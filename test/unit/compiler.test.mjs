// Unit tests for the filter-list compiler (scripts/lib) and shared helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, preprocess } from '../../scripts/lib/preprocess.mjs';
import { parseLine, parseDomainList, splitScriptletArgs, badfilterKey } from '../../scripts/lib/parse.mjs';
import { networkToRule, mergeRules, assignIds, PRIORITY, ALLOW_ID_BASE } from '../../scripts/lib/network.mjs';
import { processSelector, CosmeticCompiler, TOKEN_RE, cssHide } from '../../scripts/lib/cosmetic.mjs';
import { ScriptletCompiler, CANONICAL } from '../../scripts/lib/scriptlets.mjs';
import { RESOURCES } from '../../scripts/lib/resources.mjs';
import { hostnameAndParents, normaliseHostname, hostnameToMatchPatterns, isValidHostname } from '../../src/shared/hostnames.js';

const rule = (line) => networkToRule(parseLine(line), RESOURCES);

// ---- preprocess ----------------------------------------------------------------

test('preprocessor evaluates uBO environment expressions', () => {
  assert.equal(evaluate('env_chromium'), true);
  assert.equal(evaluate('env_firefox'), false);
  assert.equal(evaluate('!cap_html_filtering && (env_mv3 || false)'), true);
  assert.equal(evaluate('unknown_token'), false);
});

test('preprocessor keeps the right branch of nested !#if/!#else', () => {
  const { lines } = preprocess([
    'a', '!#if env_firefox', 'ff', '!#if env_mv3', 'ff-mv3', '!#endif', '!#else', 'not-ff', '!#endif', '!#include x.txt', 'z',
  ].join('\n'));
  assert.deepEqual(lines, ['a', 'not-ff', 'z']);
});

// ---- parse ---------------------------------------------------------------------------

test('parser classifies network, cosmetic, scriptlet, comments and skips', () => {
  assert.equal(parseLine('! comment'), null);
  assert.equal(parseLine('[Adblock Plus 2.0]'), null);
  assert.equal(parseLine('||ads.com^$third-party').type, 'network');
  assert.equal(parseLine('||site.com/#!/ads$script').type, 'network');
  assert.equal(parseLine('##.ad').type, 'cosmetic');
  assert.equal(parseLine('example.com##+js(set, a, 1)').type, 'scriptlet');
  assert.equal(parseLine('example.com##^script:has-text(x)').reason, 'html-filter');
  assert.equal(parseLine('example.com#$#abort-on-property-read x').reason, 'abp-snippet');
});

test('entity-only cosmetic domains are dropped, never widened to generic', () => {
  assert.equal(parseLine('example.*##.ad').type, 'skip');
  const f = parseLine('example.*,real.com##.ad');
  assert.deepEqual(f.include, ['real.com']);
});

test('domain lists handle negation, case and IDN', () => {
  const d = parseDomainList('A.com|~b.a.com|bücher.de|x.*', '|');
  assert.deepEqual(d.include, ['a.com', 'xn--bcher-kva.de']);
  assert.deepEqual(d.exclude, ['b.a.com']);
  assert.equal(d.dropped, 1);
});

test('scriptlet args split on unescaped commas and unquote', () => {
  assert.deepEqual(splitScriptletArgs('set, a.b, "x, y", c\\,d'), ['set', 'a.b', 'x, y', 'c,d']);
});

test('badfilter key ignores option order', () => {
  assert.equal(badfilterKey(parseLine('||a.com^$script,3p,badfilter')), badfilterKey(parseLine('||a.com^$3p,script')));
});

// ---- network -----------------------------------------------------------------------

test('||host^ becomes requestDomains; ||host without ^ stays a urlFilter', () => {
  assert.deepEqual(rule('||ads.com^').rule.condition, { requestDomains: ['ads.com'] });
  assert.deepEqual(rule('||ads.com').rule.condition, { urlFilter: '||ads.com' });
});

test('party, types, domains and methods map to DNR conditions', () => {
  const r = rule('||t.com/px$image,ping,third-party,domain=a.com|~b.a.com,method=post').rule;
  assert.deepEqual(r.condition, {
    urlFilter: '||t.com/px', resourceTypes: ['image', 'ping'], domainType: 'thirdParty',
    initiatorDomains: ['a.com'], excludedInitiatorDomains: ['b.a.com'], requestMethods: ['post'],
  });
  assert.equal(r.priority, PRIORITY.block);
  assert.deepEqual(rule('||x.com^$~script').rule.condition.excludedResourceTypes, ['script']);
  assert.equal(rule('||x.com^$1p').rule.condition.domainType, 'firstParty');
});

test('priority ladder: block < redirect < allow < important', () => {
  assert.equal(rule('||a.com^').rule.priority, 10);
  const redir = rule('||a.com/gpt.js$script,redirect=googletagservices_gpt.js').rule;
  assert.equal(redir.priority, 11);
  assert.deepEqual(redir.action, { type: 'redirect', redirect: { extensionPath: '/resources/googletagservices_gpt.js' } });
  assert.equal(rule('@@||a.com^').rule.priority, 20);
  assert.equal(rule('||a.com^$important').rule.priority, 30);
  assert.ok(PRIORITY.important < 1000, 'user allowlist (1000) must beat everything');
});

test('unknown redirect resource falls back to a block; redirect needs a type', () => {
  assert.equal(rule('||a.com/x.js$script,redirect=not-a-resource').rule.action.type, 'block');
  assert.equal(rule('||a.com/x.js$redirect=noop.js').skip, 'redirect-without-type');
});

test('unsupported options drop the filter instead of approximating it', () => {
  for (const opt of ['csp=script-src none', 'removeparam=utm', 'popup', 'redirect-rule=noop.js', 'header=x:y', 'frobnicate']) {
    assert.ok(rule(`||a.com^$${opt}`).skip, opt);
  }
  assert.equal(rule('$script').skip, 'match-everything');
});

test('$document exceptions allow the frame tree and disable cosmetics', () => {
  const r = rule('@@||site.com^$document');
  assert.equal(r.rule.action.type, 'allowAllRequests');
  assert.deepEqual(r.rule.condition.resourceTypes, ['main_frame', 'sub_frame']);
  assert.deepEqual(r.flags, { hosts: ['site.com'], ehide: true });
});

test('$ghide is a cosmetic flag, not a network rule', () => {
  const r = rule('@@||site.com^$ghide');
  assert.equal(r.rule, undefined);
  assert.deepEqual(r.flags, { hosts: ['site.com'], ghide: true });
  assert.equal(rule('||site.com^$ghide').skip, 'cosmetic-flag-on-block');
});

test('regex filters: literals become urlFilter, lookarounds are refused', () => {
  assert.deepEqual(rule('/\\/banner\\/ads\\//').rule.condition, { urlFilter: '/banner/ads/' });
  assert.equal(rule('/^https?:\\/\\/[a-z]{8}\\.xyz\\//$script').rule.condition.regexFilter, '^https?:\\/\\/[a-z]{8}\\.xyz\\/');
  assert.equal(rule('/ads(?=\\.js)/').skip, 'regex-unsupported');
});

test('mergeRules folds requestDomains, drops covered subdomains and duplicates', () => {
  const merged = mergeRules(['||a.com^', '||x.a.com^', '||b.com^', '||c.com^$3p', '||a.com^', '||d.com/path'].map((l) => rule(l).rule));
  assert.equal(merged.length, 3);
  assert.deepEqual(merged.find((r) => !r.condition.domainType && r.condition.requestDomains).condition.requestDomains, ['a.com', 'b.com']);
});

test('assignIds puts allow rules above ALLOW_ID_BASE', () => {
  const ids = assignIds([rule('||a.com^').rule, rule('@@||b.com^').rule, rule('||c.com/x').rule]).map((r) => r.id);
  assert.deepEqual(ids, [1, ALLOW_ID_BASE, 2]);
});

// ---- cosmetic ------------------------------------------------------------------------

test('selectors: :style is sanitised, procedural and unsafe ones are skipped', () => {
  assert.deepEqual(processSelector('body:style(overflow: auto)'), { kind: 'style', selector: 'body', decl: 'overflow: auto !important' });
  assert.equal(processSelector('div:style(background: url(http://x))').skip, 'style-unsafe');
  assert.equal(processSelector('div:has-text(Sponsored)').skip, 'procedural');
  assert.equal(processSelector('a{} body{display:none}').skip, 'selector-unsafe');
  assert.equal(processSelector('div /* comment').skip, 'selector-unsafe');
  assert.deepEqual(processSelector('div:-abp-has(> .ad)'), { kind: 'hide', selector: 'div:has(> .ad)' });
  assert.deepEqual(processSelector('.x:remove()'), { kind: 'hide', selector: '.x' });
});

test('token selectors are only plain classes and ids', () => {
  assert.ok(TOKEN_RE.test('.ad-banner') && TOKEN_RE.test('#ad_top'));
  assert.ok(!TOKEN_RE.test('div.ad') && !TOKEN_RE.test('.a .b') && !TOKEN_RE.test('[class^="ad"]'));
});

test('cosmetic compiler routes generic, specific and exceptions', () => {
  const c = new CosmeticCompiler(['ads']);
  for (const l of ['##.ad', '##div[id^="ad-"]', 'a.com##.site-ad', 'a.com#@#.ad', '~b.com##.gone', '#@#.gone', 'c.com##.x:style(color: red)']) {
    c.add('ads', parseLine(l));
  }
  const { files } = c.emit();
  assert.deepEqual(files['cosmetic/tokens-ads.json'], ['.ad']);
  assert.deepEqual(files['cosmetic/complex-ads.json'], ['div[id^="ad-"]']);
  assert.deepEqual(files['cosmetic/exceptions.json'], { 'a.com': ['.ad'], 'b.com': ['.gone'] });
  const shards = Object.entries(files).filter(([k]) => k.startsWith('cosmetic/specific-ads-')).map(([, v]) => v);
  const merged = Object.assign({}, ...shards);
  assert.deepEqual(merged, { 'a.com': { h: ['.site-ad'] }, 'c.com': { s: [['.x', 'color: red !important']] } });
});

test('cssHide groups selectors into rules', () => {
  assert.equal(cssHide(['.a', '.b', '.c'], 2), '.a,\n.b\n{display:none!important}\n.c\n{display:none!important}');
});

// ---- scriptlets ------------------------------------------------------------------------

test('scriptlet aliases resolve to canonical names', () => {
  assert.equal(CANONICAL.get('aopr'), 'abort-on-property-read');
  assert.equal(CANONICAL.get('nostif'), 'prevent-setTimeout');
  assert.equal(CANONICAL.get('trusted-set'), undefined);
});

test('scriptlet compiler: generic skipped, exceptions honoured, buckets registered per host', () => {
  const c = new ScriptletCompiler(['ads']);
  for (const l of [
    'a.com,b.com##+js(set, x, true)', '##+js(set, y, true)', 'b.com#@#+js(set, x, true)',
    'c.com##+js(trusted-set, z, 1)', 'd.com##+js(aopr, ad)', 'd.com#@#+js()',
  ]) c.add('ads', parseLine(l));
  assert.equal(c.stats['generic-skipped'], 1);
  assert.equal(c.stats['trusted-skipped'], 1);
  const { files, registrations } = c.emit('const SCRIPTLETS = {};');
  const src = Object.values(files).join('\n');
  assert.match(src, /"a\.com":\[\["set-constant","x","true"\]\]/);
  assert.match(src, /"d\.com":\["\*"\]/);
  const matches = registrations.ads.flatMap((b) => b.matches);
  assert.ok(matches.includes('*://a.com/*') && matches.includes('*://*.a.com/*'));
});

// ---- hostnames -----------------------------------------------------------------------------

test('hostname helpers', () => {
  assert.deepEqual(hostnameAndParents('a.b.c'), ['a.b.c', 'b.c', 'c']);
  assert.equal(normaliseHostname(' https://WWW.Example.com/path?q '), 'www.example.com');
  assert.equal(normaliseHostname('*.example.com.'), 'example.com');
  assert.equal(normaliseHostname('not a host'), null);
  assert.equal(normaliseHostname('example.com:8080'), null);
  assert.deepEqual(hostnameToMatchPatterns('x.com'), ['*://x.com/*', '*://*.x.com/*']);
  assert.ok(!isValidHostname('-bad.com') && isValidHostname('ok-1.co.uk'));
});

// ---- popups ----------------------------------------------------------------------------

import { PopupCompiler, patternToRegexSource, isPopupFilter, withoutPopup } from '../../scripts/lib/popups.mjs';

test('popup patterns compile to URL regexes with ABP anchors', () => {
  const re = new RegExp(patternToRegexSource('||ads.com^'), 'i');
  assert.ok(re.test('https://ads.com/x') && re.test('https://sub.ads.com/') && !re.test('https://notads.com/'));
  const path = new RegExp(patternToRegexSource('/popunder/*.php'), 'i');
  assert.ok(path.test('https://x.com/popunder/a.php') && !path.test('https://x.com/other.php'));
});

test('popup compiler splits hosts, third-party hosts, rules and exceptions', () => {
  const c = new PopupCompiler();
  for (const l of ['||pop.com^$popup', '||pop3.com^$popup,third-party', '||x.com/go$popup,domain=site.com', '@@*$popup,domain=mail.google.com', '||e.*^$popup,domain=e.*']) {
    c.add(parseLine(l));
  }
  const out = c.emit();
  assert.deepEqual(out.hosts, ['pop.com']);
  assert.deepEqual(out.hosts3p, ['pop3.com']);
  assert.equal(out.rules.length, 1);
  assert.deepEqual(out.rules[0].slice(1), [['site.com'], [], 0]);
  assert.deepEqual(out.allow[0].slice(1), [['mail.google.com'], [], 0]);
});

test('$script,popup filters keep their network half', () => {
  const f = parseLine('||ads.com^$script,popup');
  assert.ok(isPopupFilter(f));
  const rest = withoutPopup(f);
  assert.deepEqual(rest.options.map((o) => o.name), ['script']);
  assert.equal(withoutPopup(parseLine('||ads.com^$popup')), null);
});

// ---- security page-URL matching ------------------------------------------------------------

import { pathMatches } from '../../src/shared/url-match.js';

test('page-URL entries use ABP separator semantics', () => {
  // A shortener code must not swallow a longer, different code.
  assert.equal(pathMatches('/6Y3zq', '/6Y3zq^'), true);
  assert.equal(pathMatches('/6Y3zq?utm=x', '/6Y3zq^'), true);
  assert.equal(pathMatches('/6Y3zq/', '/6Y3zq^'), true);
  assert.equal(pathMatches('/6Y3zqABC', '/6Y3zq^'), false);
  assert.equal(pathMatches('/6Y3zq-x', '/6Y3zq^'), false);
  // Without ^ it is a plain prefix.
  assert.equal(pathMatches('/spt/login.php', '/spt/'), true);
  assert.equal(pathMatches('/sp', '/spt/'), false);
});
