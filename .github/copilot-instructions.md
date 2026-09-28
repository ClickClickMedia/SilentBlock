# SilentBlock: notes for AI coding assistants

SilentBlock is a Chrome MV3 ad blocker. Filter lists are compiled at build time into
declarativeNetRequest rulesets, cosmetic data files and MAIN-world scriptlet buckets.
Read README.md first; this file is the short list of things that bite.

## Rules
- Never fetch filters or code at runtime. Lists are committed snapshots in `filters/upstream/`.
- No telemetry, analytics or remote calls of any kind. Keep it free, with no nags or upsells.
- On ordinary sites SilentBlock must not patch page APIs. Anything that runs in the page's
  MAIN world goes through a scriptlet that a filter targets at specific hosts.
- Hide, never remove, page elements in anything heuristic (`src/shared/unwall-core.js`).
- Use `chrome.*` promise APIs (Firefox supports them too). No `browser` alias, no callbacks.
- Build output lives in `dist/`. Never edit it by hand, and never commit it.

## Traps
- A single `regexFilter` Chrome rejects stops the ENTIRE extension loading, and
  `--load-extension` fails silently. Run the full build (it validates regexes with
  `declarativeNetRequest.isRegexSupported`) and `node scripts/verify-load.mjs`, which
  prints Chrome's real error.
- One invalid selector voids a whole grouped CSS rule; the build validates selectors in Chromium.
- `||host^` means "host and subdomains" (becomes `requestDomains`); `||host` without `^`
  does not, and must stay a `urlFilter`.
- Entity domains (`example.*`) cannot be expressed; filters using only entities are
  dropped, never widened to generic.
- Priorities: block 10, redirect 11, list exception 20, `$important` 30, user pause 1000,
  security block 2000 (beats a pause), security "continue anyway" session rule 3000.
- The service worker can die at any time. State lives in `chrome.storage`; `apply.js`
  must stay idempotent. All listeners are registered synchronously at top level.
- Settings changes must come from extension pages (`sender.url` is ours). Content scripts
  may only send `tokens`.
- Chrome writes `_metadata/` into a loaded unpacked folder; `package.mjs` skips `_` paths.
- Anything that must happen before a tab-under's redirect (popup opener registration, the
  last committed URL) is done synchronously at the top of the listener, before any await.
- Security page URLs (~36k) live in `security/urls.json` and are checked by the worker;
  as DNR rules they would blow the 30k guarantee.
- Icons are generated: edit `scripts/icons.mjs` and run it, never hand-edit the PNGs.

## Tests
- `npm test` for the compiler and settings; `npm run test:e2e` for the real build in Chromium.
- `filters/silentblock-selftest.txt` targets reserved `.test` hosts and drives the e2e tests.
- Headless Chromium maps every host to the local fixture server
  (`--host-resolver-rules`). Use `.test` hosts in fixtures; real Google hosts are
  HSTS-preloaded and will not load over http.
