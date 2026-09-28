// Options page. Every change goes through the service worker, which validates it.
import { normaliseHostname } from '../shared/hostnames.js';

const $ = (id) => document.getElementById(id);

async function send(message) {
  const res = await chrome.runtime.sendMessage(message);
  if (res && res.error) throw new Error(res.error);
  return res;
}

let state;
let meta;

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const c of children) node.append(c);
  return node;
}

function fmtDate(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function renderCategories() {
  const box = $('categories');
  box.replaceChildren();
  for (const [id, cat] of Object.entries(meta.categories)) {
    if (cat.alwaysOn) continue;
    const input = el('input', { type: 'checkbox', checked: state.categories[id], disabled: !state.enabled });
    input.setAttribute('aria-label', cat.title);
    input.addEventListener('change', () => save({ categories: { ...state.categories, [id]: input.checked } }));
    const rules = meta.rulesets[id];
    const cos = meta.cosmetic[id];
    const detail = `${rules.rules.toLocaleString()} network rules, ${(rules.domains).toLocaleString()} domains, ${(cos.tokens + cos.complex).toLocaleString()} generic and ${cos.specificHosts.toLocaleString()} site-specific hiding rules`;
    box.append(el('div', { className: 'cat' },
      el('div', {}, el('div', { className: 'label', textContent: cat.title }), el('div', { className: 'hint', textContent: cat.description }), el('div', { className: 'meta', textContent: detail })),
      el('label', { className: 'switch' }, input, el('span')),
    ));
  }
}

function renderList(listId, hosts, onRemove) {
  const ul = $(listId);
  ul.replaceChildren();
  for (const h of hosts) {
    const btn = el('button', { type: 'button', textContent: 'Remove' });
    btn.setAttribute('aria-label', `Remove ${h}`);
    btn.addEventListener('click', () => onRemove(h));
    ul.append(el('li', {}, el('span', { textContent: h }), btn));
  }
}

function render() {
  $('subtitle').textContent = `Version ${meta.version}, lists built ${fmtDate(meta.builtAt)}`;
  $('enabled').checked = state.enabled;
  $('badge').checked = state.badge;
  $('statusIcon').checked = state.statusIcon;
  renderCategories();
  renderList('pausedList', state.allowlist, (h) => save({ allowlist: state.allowlist.filter((x) => x !== h) }));
  renderList('unwallList', state.unwallSites, (h) => save({ unwallSites: state.unwallSites.filter((x) => x !== h) }));

  const rows = $('listRows');
  rows.replaceChildren();
  for (const l of meta.lists) {
    const name = l.url ? el('a', { href: l.url, textContent: l.title, target: '_blank', rel: 'noreferrer' }) : l.title;
    rows.append(el('tr', {},
      el('td', {}, name),
      el('td', { textContent: meta.categories[l.category].title }),
      el('td', { textContent: l.snapshot ? fmtDate(l.snapshot) : (l.url ? '-' : 'built in') }),
      el('td', { textContent: l.license || '-' }),
    ));
  }
  const total = Object.values(meta.rulesets).reduce((n, r) => n + r.rules, 0);
  $('ruleSummary').textContent = `${total.toLocaleString()} network rules across ${Object.keys(meta.rulesets).length} rulesets.`;
}

async function save(patch) {
  ({ state } = await send({ type: 'settings:set', patch }));
  render();
}

$('enabled').addEventListener('change', (e) => save({ enabled: e.target.checked }));
$('badge').addEventListener('change', (e) => save({ badge: e.target.checked }));
$('statusIcon').addEventListener('change', (e) => save({ statusIcon: e.target.checked }));

$('addPaused').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('pausedInput');
  const host = normaliseHostname(input.value);
  const err = $('pausedError');
  if (!host) {
    err.textContent = 'Enter a site like example.com';
    err.hidden = false;
    return;
  }
  err.hidden = true;
  input.value = '';
  await save({ allowlist: [...state.allowlist, host] });
});

$('export').addEventListener('click', () => {
  const data = { silentblock: meta.version, exportedAt: new Date().toISOString(), ...state };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `silentblock-settings-${new Date().toISOString().slice(0, 10)}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  $('backupStatus').textContent = 'Exported.';
});

$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || typeof data !== 'object' || !('allowlist' in data || 'enabled' in data)) throw new Error('not a SilentBlock settings file');
    ({ state } = await send({ type: 'settings:import', data }));
    render();
    $('backupStatus').textContent = `Imported ${state.allowlist.length} paused site(s).`;
  } catch (err) {
    $('backupStatus').textContent = `Import failed: ${err.message}`;
  }
});

({ state, meta } = await send({ type: 'settings:get' }));
render();
requestAnimationFrame(() => requestAnimationFrame(() => document.documentElement.classList.add('animate')));
