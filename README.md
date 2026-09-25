# SilentBlock

Free, silent ad blocker for Chrome (Manifest V3). No ads, no nags, no subscriptions.

SilentBlock 2.0 compiles EasyList, EasyPrivacy, the uBlock Origin filter lists and the
EasyList Cookie List into Chrome's native blocking engine at build time. It ships them with
the extension and never downloads rules at runtime.

## What it does

| Layer | How |
|---|---|
| **Network blocking** | ~20,700 `declarativeNetRequest` rules (from ~120,000 filters; the ~100,000 plain `\|\|domain^` filters fold into a few dozen rules). Chrome enforces them itself, so no page script runs until it has been checked. |
| **Stand-ins** | Blocked Google Analytics, Tag Manager, gtag, GPT and AdSense scripts are swapped for local stubs, so "track the click, then navigate" links and anti-flicker snippets still work. |
| **Generic hiding** | The page reports its class and id names, and the service worker injects CSS for the ~27,500 generic ad and cookie-banner selectors that match. Nothing is parsed per frame for the rest. |
| **Site-specific hiding** | ~28,000 hostnames with their own hide and restyle rules, injected per frame as it loads. |
| **Anti-adblock** | ~8,200 site-specific scriptlets (uBO semantics: `set-constant`, `abort-on-property-read`, `prevent-setTimeout`, `json-prune` and 30 others), run in the page before its own scripts, only on the sites listed. |
| **Nag walls** | "Kill nag wall" in the popup removes an anti-adblock overlay on demand, or on every visit with "Always on this site". |

Every piece of CSS is injected as a *user* stylesheet: pages cannot see it, override it or
block it with CSP. On ordinary sites SilentBlock patches no page APIs at all.

## Using it

- **Protection** turns everything on or off.
- **Block on this site** pauses SilentBlock on the current site and its subdomains. This is
  also the fix when a site breaks: paused sites get no rules, no CSS and no scripts.
- **Settings** has the filter categories (ads, trackers, cookie banners), the paused and
  nag-wall site lists, the blocked-count badge, and settings export/import.

Pausing a site also covers tag debugging: pause the client site to let GTM preview and Tag
Assistant load there. The Google Ads, GA4, GTM, Meta, LinkedIn and Microsoft consoles, and
vendor dashboards such as Hotjar and Sentry, are excepted in `filters/silentblock-core.txt`
so they work out of the box.

## Install

1. Download `SilentBlock-<version>-chrome.zip` from the latest
   [release](https://github.com/ClickClickMedia/SilentBlock/releases) and unzip it somewhere
   permanent, or build it yourself (below) and use `dist/chrome`.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick
   the folder.
3. If you had SilentBlock 1.x loaded from another folder, remove it. Chrome gives each
   unpacked folder its own extension id, so the two would both run. Settings do not carry
   across folders, so re-add any paused sites.

Chrome 120 or later. A Firefox build (`dist/firefox`) is produced and passes `web-ext lint`,
but only the Chrome build is tested.

## Development

Requires Node 22.2+. The checkout must live on a local disk, not Google Drive (npm writes
zero-byte files there).

```sh
npm install
npx playwright install chromium   # used by the build to validate selectors and regexes
npm run build                     # -> dist/chrome, dist/firefox, dist/build-report.json
npm test                          # unit tests (compiler, settings)
npm run test:e2e                  # Playwright: the real build in headless Chromium
node scripts/verify-load.mjs      # load dist/chrome over CDP and report Chrome's own error
npm run check                     # all of the above
npm run package                   # -> release/SilentBlock-<version>-{chrome,firefox}.zip
```

`npm run build:fast` skips the browser validation. Only use it while iterating: Chrome
refuses to load the whole extension if a single regex rule is one it rejects, and the full
build is what catches those.

### Layout

```
filters/
  lists.json               list registry: id, category, file, upstream URL, licence
  upstream/*.txt           committed snapshots of the upstream lists (npm run lists:update)
  silentblock-*.txt        SilentBlock's own filters (core exceptions, extras, self-test)
scripts/
  build.mjs                lists -> DNR rulesets, cosmetic data, scriptlet buckets, manifests
  lib/                     parser, network/cosmetic/scriptlet compilers, validation
src/
  manifest.json            base manifest (version and rulesets are filled in by the build)
  background/              service worker: state, apply (reconcile), cosmetic injection
  content/                 token reporter, Facebook sponsored posts, nag-wall remover
  scriptlets/library.js    MAIN-world scriptlets, embedded into each bucket by the build
  resources/               redirect stubs (GPT, gtag/GTM, analytics.js, noop files)
  popup/, options/, shared/
test/unit, test/e2e, test/fixtures
```

### How settings apply

`src/background/apply.js` reconciles the browser with the saved settings: which rulesets are
enabled, one dynamic `allowAllRequests` rule for paused sites, and every registered content
script, each with `excludeMatches` built from the paused list. It runs on install, update,
browser start and after each settings change. Settings are never reset on update, and 1.x
settings are migrated.

### Updating the filter lists

```sh
npm run lists:update   # refresh filters/upstream/*.txt (keeps the old snapshot if a download looks wrong)
npm run check
```

Review the build report's rule counts before committing. The build fails if the total goes
past the 30,000 static rules Chrome guarantees every extension.

### Adding SilentBlock's own filters

Use ABP/uBO syntax in `filters/silentblock-*.txt`. Network rules should be `$third-party`
unless there's a reason not to be. `filters/silentblock-selftest.txt` only targets the
reserved `.test` TLD and drives the end-to-end tests. Leave it in.

## Releasing

```sh
npm run bump -- minor        # or patch / major / x.y.z; updates package.json + CHANGELOG
npm run check && npm run package
git add package.json package-lock.json CHANGELOG.md
git commit -m "Release vX.Y.Z" && git tag vX.Y.Z && git push --follow-tags
```

Pushing the tag runs `.github/workflows/release.yml`, which builds, tests and attaches both
zips to a GitHub release.

## Filter lists and licences

| List | Licence |
|---|---|
| EasyList, EasyPrivacy, EasyList Cookie List | GPL-3.0 or CC BY-SA 3.0 |
| uBlock filters (main, quick fixes, unbreak, privacy, cookie notices) | GPL-3.0 |

The lists are bundled as data in their original terms. Publishing SilentBlock outside CCM
(for example on the public Chrome Web Store) means distributing GPL-3.0 material, so check
the licence position first.
