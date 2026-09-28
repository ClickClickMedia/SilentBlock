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
  if (!info.supported || !info.enabled) $('stateIcon').src = `../icons/${info.enabled ? 'idle' : 'paused'}-32.png`;
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

  $('unwallAlways').checked = Boolean(info.unwall);
  renderStatus(info.status);
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function renderStatus(st) {
  if (!st) return;
  root.dataset.level = st.level;
  $('stateIcon').src = `../icons/${st.icon}-32.png`;
  $('blocked').textContent = String(st.level === 'danger' ? st.danger : st.blocked);
  $('cap').textContent = st.level === 'danger' ? 'dangerous requests blocked' : 'ads and trackers blocked';
  let text;
  if (st.level === 'danger') {
    text = `Known malware or scam hosts here: ${st.dangerHosts.join(', ')}`;
    if (st.blocked) text += `. Also blocked ${plural(st.blocked, 'ad or tracker', 'ads and trackers')}.`;
  } else if (st.level === 'caution') {
    const bits = [];
    if (st.popups) bits.push(`stopped ${plural(st.popups, 'pop-up', 'pop-ups')}`);
    if (st.walls) bits.push('removed a nag wall');
    text = `Pushy site: ${bits.join(' and ')}.`;
  } else if (st.level === 'protected') {
    text = 'Protected: ads and trackers stopped before they loaded.';
  } else {
    text = 'Nothing to block on this page.';
  }
  if (st.icon === 'paused') text = info.enabled ? 'Paused here. Malware protection is still on.' : text;
  $('statusText').textContent = text;
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
// Counts climb while the page loads; keep the popup current while it is open.
setInterval(() => { refresh().catch(() => {}); }, 1000);
requestAnimationFrame(() => requestAnimationFrame(() => document.documentElement.classList.add('animate')));
