// Warning page for known malware, phishing and scam sites. The blocked URL arrives in the
// query string; the service worker re-validates it before allowing anything.
const params = new URLSearchParams(location.search);
const target = params.get('u') || '';
const listedHost = params.get('h') || '';
const back = params.get('b') || '';

let host = listedHost;
try { host = new URL(target).hostname; } catch { /* keep the listed host */ }
document.getElementById('host').textContent = host || 'Unknown site';
document.getElementById('url').textContent = target;
document.title = `Blocked: ${host}`;

const valid = /^https?:\/\//i.test(target);
if (!valid) {
  document.getElementById('proceed').hidden = true;
  document.getElementById('fine').hidden = true;
}

document.getElementById('back').addEventListener('click', async () => {
  // Straight to the page you were on. history.back() would land on the blocked
  // navigation's error entry instead.
  if (/^https?:\/\//i.test(back)) { location.replace(back); return; }
  const tab = await chrome.tabs.getCurrent();
  if (tab) chrome.tabs.update(tab.id, { url: 'chrome://newtab/' });
});

document.getElementById('proceed').addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'security:bypass', url: target });
  if (res && !res.error) location.replace(target);
});
