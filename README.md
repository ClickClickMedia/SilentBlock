# SilentBlock

Free, silent ad blocker for Chrome (Manifest V3). No ads, no nags, no subscriptions.

SilentBlock 2.0 compiles EasyList, EasyPrivacy, the uBlock Origin filter lists and the
EasyList Cookie List into Chrome's native blocking engine at build time. It ships them with
the extension and never downloads rules at runtime.

## What it does

| Layer | How |
|---|---|
| **Network blocking** | ~21,700 `declarativeNetRequest` rules (from ~120,000 filters; the ~100,000 plain `\|\|domain^` filters fold into a few dozen rules). Chrome enforces them itself, so no page script runs until it has been checked. |
| **Stand-ins** | Blocked Google Analytics, Tag Manager, gtag, GPT and AdSense scripts are swapped for local stubs, so "track the click, then navigate" links and anti-flicker snippets still work. |
| **Generic hiding** | The page reports its class and id names, and the service worker injects CSS for the ~27,500 generic ad and cookie-banner selectors that match. Nothing is parsed per frame for the rest. |
| **Site-specific hiding** | ~28,000 hostnames with their own hide and restyle rules, injected per frame as it loads. |
| **Anti-adblock** | ~8,200 site-specific scriptlets (uBO semantics: `set-constant`, `abort-on-property-read`, `prevent-setTimeout`, `json-prune` and 30 others), run in the page before its own scripts, only on the sites listed. |
| **Pop-ups and tab-unders** | New tabs a page opens are followed for their first few hops and closed if they land on one of ~3,000 `$popup` hosts. A tab sent to an ad right after the page reopened itself in a new tab is put back. |
| **Malware and scams** | uBO Badware, URLhaus, the Phishing URL Blocklist and DurableNapkin's scam list: ~46,000 hosts blocked outright, plus ~36,000 individual phishing and malware page URLs checked on every navigation. A listed page gets a warning with "Back to safety" and "Continue anyway". This layer stays on for paused sites. No API keys and no lookups: every check is local. |
| **Nag walls** | "Kill nag wall" in the popup removes an anti-adblock overlay on demand, or on every visit with "Always on this site". |

Every piece of CSS is injected as a *user* stylesheet: pages cannot see it, override it or
block it with CSP. On ordinary sites SilentBlock patches no page APIs at all.

## Using it

The toolbar icon's colour tells you what happened on the page in front of you:

| Colour | Meaning |
|---|---|
| Slate blue | Nothing on this page needed blocking (also the brand colour) |
| Green | Protected: ads and trackers blocked |
| Amber | Pushy site: a pop-up, tab-under or nag wall was dealt with |
| Red | A known malware, phishing or scam host was blocked |
| Grey | Paused on this site, or protection is off |

The popup explains the colour and shows a live count. Settings can keep the icon plain blue.

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
  icons/                   toolbar icons per state, rendered by scripts/icons.mjs from assets/icons/
  icons-edge/              the same for the Edge build, without the middle finger (Edge policy 2.10)
  popup/, options/, warning/, shared/
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

Pushing the tag runs `.github/workflows/release.yml`: build, full tests (Chrome and a Firefox
smoke test), a GitHub release with the Chrome, Firefox and source zips, then a submission to
each store it has credentials for. Every store reviews the upload before users get it.

| Store | Item | Credentials |
|---|---|---|
| Chrome Web Store | `accdpphckockpflaggbplikpmaknioao` | None stored: keyless login from GitHub Actions to the `cws-publisher` service account (Workload Identity Federation in `clicktrack-505800`, tags only) |
| Firefox (AMO) | `silentblock@local` | Repo secrets `AMO_JWT_ISSUER`, `AMO_JWT_SECRET` |
| Microsoft Edge | `hhdolnhpfeeipbomjfkalbhegkakbkmo` | Repo secrets `EDGE_PRODUCT_ID`, `EDGE_CLIENT_ID`, `EDGE_API_KEY` |

A store with no credentials is skipped. To retry a store, or publish an existing release after
adding credentials, run the Publish workflow by hand:
`gh workflow run publish.yml -f tag=v2.0.1 -f stores=firefox` (stores defaults to all three).
The same scripts run locally: `npm run package`, then
`npm run publish:chrome` (signs in through your gcloud login), `publish:firefox` or
`publish:edge` with the variables above. `npm run store:status` shows what Chrome has.
Listing text and images: `docs/store-listing.md` and `npm run store:art`.

Edge gets its own zip (`SilentBlock-<v>-edge.zip`, built from `dist/edge`) and its own images
(`release/store-art/edge/`). It is the Chrome build with a different hand on the icon: Edge
Add-ons rejected the middle finger under policy 2.10 on 2026-10-01. Edge also has no API for
listing images, and its publish API submits whatever listing is in the Partner Center draft,
so new Edge images go into the draft by hand BEFORE the tag is pushed.

## Filter lists and licences

| List | Licence |
|---|---|
| EasyList, EasyPrivacy, EasyList Cookie List | GPL-3.0 or CC BY-SA 3.0 |
| uBlock filters (main, quick fixes, unbreak, privacy, cookie notices, badware) | GPL-3.0 |
| Malicious URL Blocklist (URLhaus data) | CC0 / MIT |
| Phishing URL Blocklist | CC BY-SA 4.0 (sources: OpenPhish, PhishTank, IPThreat) |
| Scam Blocklist by DurableNapkin | MIT |

SilentBlock itself is licensed under the [GNU GPL v3.0 or later](LICENSE). The bundled
filter lists keep their own licences, listed above. Privacy policy: [PRIVACY.md](PRIVACY.md).
