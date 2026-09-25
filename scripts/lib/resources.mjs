// Redirect resource names used by filter lists (`$redirect=<name>`) mapped to the stub
// files in src/resources/. A name not listed here falls back to a plain block.
export const RESOURCES = {};

const FILES = {
  'noop.js': ['noopjs', 'abp-resource:blank-js'],
  'noop.txt': ['nooptext', 'empty', 'abp-resource:blank-text'],
  'noop.css': ['noopcss', 'abp-resource:blank-css'],
  'noop.html': ['noopframe', 'abp-resource:blank-html'],
  '1x1.gif': ['1x1-transparent.gif', 'abp-resource:1x1-transparent-gif'],
  '2x2.png': ['2x2-transparent.png', 'abp-resource:2x2-transparent-png'],
  '3x2.png': ['3x2-transparent.png', 'abp-resource:3x2-transparent-png'],
  '32x32.png': ['32x32-transparent.png', 'abp-resource:32x32-transparent-png'],
  'noopvast-2.0.xml': ['noopvast-2.0'],
  'noopvast-3.0.xml': ['noopvast-3.0'],
  'noopvast-4.0.xml': ['noopvast-4.0'],
  'noopvmap-1.0.xml': ['noopvmap-1.0'],
  'googletagservices_gpt.js': ['googletagservices.com/gpt.js', 'googletagservices-gpt'],
  'googlesyndication_adsbygoogle.js': ['googlesyndication.com/adsbygoogle.js', 'googlesyndication-adsbygoogle'],
  'google-analytics_analytics.js': ['google-analytics.com/analytics.js', 'google-analytics-analytics'],
  'google-analytics_ga.js': ['google-analytics.com/ga.js', 'google-analytics-ga'],
  'googletagmanager_gtm.js': ['googletagmanager.com/gtm.js', 'googletagmanager-gtm', 'googletagmanager_gtag.js', 'googletagmanager.com/gtag.js'],
  'amazon_apstag.js': ['amazon-adsystem.com/aax2/apstag.js', 'amazon-apstag'],
  'scorecardresearch_beacon.js': ['scorecardresearch.com/beacon.js', 'scorecardresearch-beacon'],
  'doubleclick_instream_ad_status.js': ['doubleclick.net/instream/ad_status.js', 'doubleclick-instream-ad-status'],
  'prebid-ads.js': ['prebid-ads'],
};

for (const [file, aliases] of Object.entries(FILES)) {
  RESOURCES[file] = file;
  for (const a of aliases) RESOURCES[a] = file;
}
