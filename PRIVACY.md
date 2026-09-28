# SilentBlock privacy policy

Last updated: 28 September 2026

**SilentBlock collects nothing.** It has no accounts, no analytics, no telemetry and no
servers. Nothing you browse, block or configure ever leaves your browser.

## What SilentBlock does on your device

- **Blocks requests** using filter lists that ship inside the extension. Lists are updated by
  releasing a new version of the extension, never downloaded while you browse.
- **Checks pages against malware, phishing and scam lists** stored inside the extension. The
  check happens on your device. SilentBlock does not send the addresses you visit to anyone,
  including Google Safe Browsing or any other lookup service.
- **Reads the pages you visit** in order to hide ads, remove anti-adblock walls and colour
  its toolbar icon. What it reads stays in the browser and is not stored.
- **Stores your settings** (paused sites, categories, display options) with your browser's
  extension storage. They stay in that browser. Export them from Settings if you want a copy.
- **Keeps per-tab counts** (how many requests were blocked) in memory for the popup. They are
  cleared when you close the tab or the browser.

## Why it asks for its permissions

| Permission | Used for |
|---|---|
| Access to all sites | Blocking and hiding ads on every site you visit, and redirecting blocked scripts to harmless local stand-ins |
| declarativeNetRequest | The browser's built-in blocking engine, which applies the filter lists |
| scripting | Injecting the hiding rules and the anti-adblock fixes into pages |
| webNavigation | Knowing when a page loads, to apply site-specific rules, follow pop-ups and show the malware warning |
| webRequest (read-only) | Counting blocked requests for the toolbar icon and popup. It cannot change or read request contents |
| storage | Saving your settings |

## Third parties

None. SilentBlock has no third-party code, SDKs, trackers or advertising, and does not share,
sell or transfer data, because it has none.

## Contact

Click Click Media, [clickclickmedia.com.au](https://clickclickmedia.com.au). Source code and
issues: [github.com/ClickClickMedia/SilentBlock](https://github.com/ClickClickMedia/SilentBlock).
