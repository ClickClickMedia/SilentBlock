// Popup. Talks only to the service worker; holds no state of its own.
const $ = (id) => document.getElementById(id);
const root = $('popup');

// ?tabId= lets the e2e tests open the popup as a normal page against a chosen tab.
const params = new URLSearchParams(location.search);

async function send(message) {
  const res = await chrome.runtime.sendMessage(message);
  if (res && res.error) throw new Error(res.error);
  return res;
}

async function currentTabId() {
  if (params.has('tabId')) return Number(params.get('tabId'));
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ? tab.id : null;
}

let tabId = null;
let info = null;

function render() {
  root.dataset.state = 'ready';
  root.dataset.enabled = String(info.enabled);
  root.dataset.supported = String(Boolean(info.supported));
  root.dataset.paused = String(Boolean(info.pausedBy));
  $('version').textContent = `v${info.version}`;

  $('enabled').checked = info.enabled;
  $('protectionHint').textContent = info.enabled ? 'On everywhere' : 'Off everywhere';

  if (!info.supported) {
    $('hostname').textContent = "SilentBlock doesn't run on this page.";
    return;
  }
  $('hostname').textContent = info.hostname;
  $('siteOn').checked = !info.pausedBy;
  $('siteOn').disabled = !info.enabled;
  let hint = 'Ads and trackers are blocked here';
  if (!info.enabled) hint = 'Protection is off';
  else if (info.pausedBy && info.pausedBy !== info.hostname) hint = `Paused for all of ${info.pausedBy}`;
  else if (info.pausedBy) hint = 'Paused on this site';
  $('siteHint').textContent = hint;

  $('blocked').textContent = info.blocked === null || info.blocked === undefined ? '-' : String(info.blocked);
  $('unwallAlways').checked = Boolean(info.unwall);
}

async function refresh() {
  info = await send({ type: 'popup:get', tabId });
  render();
}

function needsReload() {
  $('reload').hidden = false;
}

$('enabled').addEventListener('change', async (e) => {
  await send({ type: 'setEnabled', enabled: e.target.checked });
  await refresh();
  if (info.supported) needsReload();
});

$('siteOn').addEventListener('change', async (e) => {
  await send({ type: 'setSitePaused', hostname: info.hostname, paused: !e.target.checked });
  await refresh();
  needsReload();
});

$('reload').addEventListener('click', async () => {
  await chrome.tabs.reload(tabId);
  window.close();
});

$('unwall').addEventListener('click', async () => {
  const btn = $('unwall');
  btn.disabled = true;
  try {
    await send({ type: 'unwallNow', tabId });
    btn.textContent = 'Done';
  } catch {
    btn.textContent = "Couldn't run here";
  }
  setTimeout(() => { btn.textContent = 'Kill nag wall'; btn.disabled = false; }, 1500);
});

$('unwallAlways').addEventListener('change', async (e) => {
  await send({ type: 'setUnwallSite', hostname: info.hostname, on: e.target.checked });
  if (e.target.checked) await send({ type: 'unwallNow', tabId });
});

$('settings').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
  window.close();
});

tabId = await currentTabId();
await refresh();
requestAnimationFrame(() => requestAnimationFrame(() => document.documentElement.classList.add('animate')));
