# Changelog

## [Unreleased]

## [2.0.0] - 2026-09-25

A rebuild. The 1.x engine (a hand-written list of ~226 domains plus global page patches)
is replaced by the real filter lists compiled into Chrome's native blocker.

### Added
- EasyList, EasyPrivacy, uBlock filters (main, quick fixes, unbreak, privacy, cookie
  notices) and EasyList Cookie List, compiled at build time to ~20,700 DNR rules. Nothing
  is fetched at runtime.
- Generic cosmetic filtering that injects only the selectors matching the page's own class
  and id names, plus site-specific hiding and `:style()` rules for ~28,000 hostnames. All as
  user-origin CSS that pages cannot see or override.
- 33 uBO-compatible scriptlets running site-specific anti-adblock fixes in the page before
  its scripts (~8,200 filters).
- Redirect stubs for GPT, AdSense, analytics.js, ga.js, gtag/GTM, apstag, comScore and
  noop files, so pages that wait on ad or analytics callbacks keep working.
- Popup and tab-under blocking from the lists' 3,000 `$popup` filters, which DNR cannot
  express: new tabs a page opens are followed for their first hops and closed if they land
  on an ad host; a tab sent to an ad right after opening itself in a new tab is sent back
  and the copy closed. Tabs opened from webmail and ad consoles are never closed.
- Malware and scam protection (new "Malware & scams" category): uBO Badware, URLhaus,
  the Phishing URL Blocklist and DurableNapkin's scam list. ~46,000 hosts are blocked by
  DNR above list exceptions and above a paused site; ~36,000 page URLs (too many for DNR)
  are checked on each navigation. Listed pages show a warning page with "Back to safety"
  and "Continue anyway" (allowed until the browser closes). No API keys, no lookups.
- Toolbar icon shows the page's status: slate blue (nothing to block), green (ads and
  trackers blocked), amber (pop-up, tab-under or nag wall dealt with), red (malware or
  scam host blocked), grey (paused or off). Counts are live, from read-only request
  watching. Can be turned off in settings.
- New icon: the Tidewater shield, with the finger cut through so the toolbar shows through it.
- Popup: per-page blocked-request count, "Kill nag wall", "Always on this site", reload
  prompt, clear paused state (including when a parent domain is paused).
- Options page: filter categories, paused and nag-wall site lists, badge count, settings
  export and import, list provenance and licences.
- Exceptions so Google Ads, GA4, GTM and Tag Assistant, Meta, LinkedIn and Microsoft
  consoles, and tracker vendors' own dashboards work.
- Build validates every selector and regex in real Chromium (one rejected regex stops
  Chrome loading the extension at all), and fails past 30,000 static rules.
- Unit tests, and Playwright end-to-end tests against the real build.
- Firefox build (`dist/firefox`), lint-clean but untested.

### Fixed
- Settings were wiped on every extension update and every Chrome update. Paused sites now
  persist, and 1.x settings (`disabledSites`) are migrated.
- Any page could switch SilentBlock off by dispatching the `__sb_disable` event. Paused
  sites are now excluded when scripts are registered, so there is no switch to find.
- Per-site pause left the cosmetic CSS running. Pausing now removes every layer.
- The update check never ran (its alarm was recreated, and so reset, on every worker wake).
  The checker is gone: the repo is private and updates come through releases.
- The anti-adblock bait was hidden by SilentBlock's own CSS, which advertised the blocker.
  Generic bait is gone; detection is handled by site-specific scriptlets.
- Ad counter was overwritten by whichever iframe reported last and counted its own bait.
  It now counts network blocks for the current page.
- Facebook sponsored-post hiding re-scanned every span with a layout read on every
  mutation, every 2 seconds and every scroll. It now judges each new post once.

### Changed
- Network rules only apply to third parties unless the list says otherwise, so vendors'
  own sites keep working.
- No page API is patched on ordinary sites: `fetch`, XHR, `sendBeacon`, `Image`,
  `window.open`, `classList.add` and `style.filter` stay native. 1.x blocked all blur,
  forced `overflow:auto` on every page and deleted any overlay mentioning "whitelist".
- Dropped rules that broke real functionality: Chargebee (checkout), Piano, TinyPass,
  Pelcro and Poool (subscriber logins), AMP, the IMA SDK, Branch deep links, consent
  platforms, and error monitoring.
- Permissions: removed `tabs`, `notifications`, `alarms`, `activeTab` and
  `declarativeNetRequestFeedback`; added `scripting`, `webNavigation` and `webRequest`
  (read-only, for live counts).
- Repository moved to `ClickClickMedia/SilentBlock`.

## [1.6.0] - 2026-03-30
Last release of the 1.x line. See the git history for earlier versions.
