# Store listing

One source for all three stores. The Firefox listing text is updated automatically on
release (`scripts/publish/firefox.mjs`). Chrome and Edge have no API for listing text, so
paste these in by hand when they change. Store images: `npm run store:art` renders them into
`release/store-art/` (Chrome and Firefox) and `release/store-art/edge/` (Edge, polite icon:
never upload the middle-finger set to Edge, it fails certification under policy 2.10).

Store items:
- Chrome Web Store: `accdpphckockpflaggbplikpmaknioao` (publisher b7b011da-ecfd-4ec1-8d99-c600f9c31543)
- Firefox: `silentblock@local`, https://addons.mozilla.org/firefox/addon/silentblock/
- Edge: `hhdolnhpfeeipbomjfkalbhegkakbkmo`

## Name

SilentBlock

## Summary

<!-- summary: Chrome max 132 characters, Firefox max 250 -->
Blocks ads, trackers, pop-ups, cookie banners and malware sites, silently. No nags, no accounts, no data collection. Free forever.

## Description

<!-- description -->
SilentBlock is a free ad blocker that stays out of your way. No upsells, no nags, no account, and nothing you do ever leaves your browser.

WHAT IT BLOCKS
• Ads and ad networks, using EasyList and the uBlock Origin filter lists
• Trackers and analytics, using EasyPrivacy
• Pop-ups, pop-unders and tab-unders
• Cookie consent banners, without breaking the page underneath
• Malware, phishing and scam sites, using URLhaus, the Phishing URL Blocklist, uBlock Origin's Badware list and a scam blocklist
• "Turn off your ad blocker" walls, with one click, or automatically on sites you choose

THE ICON TELLS YOU WHAT HAPPENED
• Blue: nothing on this page needed blocking
• Green: ads and trackers blocked
• Amber: a pushy site, with pop-ups or a nag wall dealt with
• Red: a dangerous site or host was blocked
• Grey: paused

WHY IT'S FAST
SilentBlock compiles more than 120,000 filters into the browser's own blocking engine, so pages are checked before anything loads. Hiding rules are applied as invisible user styles, and only the ones a page actually needs. On ordinary sites SilentBlock doesn't patch anything in the page at all.

YOUR PRIVACY
The filter lists ship inside the extension and are never downloaded while you browse. Malware checks happen on your device: SilentBlock never sends the addresses you visit to anyone. No analytics, no telemetry, no servers.

SITE BROKEN?
Click the icon and switch off "Block on this site". Paused sites get no blocking at all, except the malware protection, which always stays on.

Open source (GPL-3.0): https://github.com/ClickClickMedia/SilentBlock
<!-- /description -->

## Category

Leave each store's category as the existing listing has it (Firefox: Privacy & Security).

## Chrome Web Store privacy tab

**Single purpose:** Blocks ads, trackers, pop-ups and known malicious sites while you browse.

**Permission justifications:**
- `declarativeNetRequest`: applies the bundled filter lists with the browser's built-in request blocker.
- `scripting`: injects the bundled hiding rules and anti-adblock fixes into pages, and removes anti-adblock walls when the user asks.
- `storage`: saves the user's settings (paused sites, categories, display options).
- `webNavigation`: knows when a page loads, to apply site-specific rules, follow new tabs opened by pages (pop-up blocking), and show the malware warning page.
- `webRequest`: read-only, counts blocked requests per tab for the toolbar icon colour and the popup count.
- Host permission `<all_urls>`: ads, trackers and malicious content can appear on any site; blocking and hiding must work on every site the user visits.
- Remote code: **No**. All code and filter lists are bundled.

**Data usage:** collects no user data. Tick nothing. Certify that data is not sold, not used for unrelated purposes, and not used for creditworthiness.

**Privacy policy URL:** https://github.com/ClickClickMedia/SilentBlock/blob/main/PRIVACY.md
