// SilentBlock scriptlet library.
//
// NOT a module: the build embeds this file verbatim into each MAIN-world scriptlet bucket
// (dist/.../scriptlets/<category>-<n>.js). It evaluates to `SCRIPTLETS`, an object of
// name -> function(...args). Argument semantics follow uBlock Origin's scriptlets of the
// same name so its filter lists work unchanged. Only the untrusted scriptlets are
// implemented; `trusted-*` ones are skipped at build time.
//
// Everything page-visible is wrapped in a Proxy so `fn.toString()` still reports
// native code, and natives are captured before any page script runs.

const SCRIPTLETS = (() => {
  const W = window;
  const safe = {
    Object: W.Object,
    defineProperty: W.Object.defineProperty.bind(W.Object),
    getOwnPropertyDescriptor: W.Object.getOwnPropertyDescriptor.bind(W.Object),
    RegExp: W.RegExp,
    JSON_parse: W.JSON.parse.bind(W.JSON),
    JSON_stringify: W.JSON.stringify.bind(W.JSON),
    Reflect_apply: W.Reflect.apply,
    Proxy: W.Proxy,
    Error: W.Error,
    Response: W.Response,
    Promise: W.Promise,
    MutationObserver: W.MutationObserver,
    setTimeout: W.setTimeout.bind(W),
    fnToString: W.Function.prototype.toString,
    addEventListener: W.EventTarget.prototype.addEventListener,
  };

  const noop = function () {};

  // ---- patterns -------------------------------------------------------------

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // "" matches everything, "/re/flags" is a regex, anything else is a literal substring.
  function patternToRegex(pattern, flags) {
    if (pattern === undefined || pattern === '') return /^/;
    const m = /^\/(.+)\/([gimsu]*)$/.exec(pattern);
    if (m) {
      try { return new safe.RegExp(m[1], m[2] || flags || ''); } catch { return /(?!)/; }
    }
    return new safe.RegExp(escapeRegex(pattern), flags || '');
  }

  // Supports a leading "!" to invert the match, as uBO does.
  function matcher(pattern) {
    let not = false;
    if (typeof pattern === 'string' && pattern.startsWith('!')) { not = true; pattern = pattern.slice(1); }
    const re = patternToRegex(pattern);
    return { empty: !pattern, test: (s) => re.test(s) !== not };
  }

  function fnText(fn) {
    if (typeof fn === 'function') {
      try { return safe.Reflect_apply(safe.fnToString, fn, []); } catch { return ''; }
    }
    return String(fn);
  }

  // Extra scriptlet args come as key/value pairs: (set, a.b, 1, as, function).
  function pairs(args) {
    const out = {};
    for (let i = 0; i + 1 < args.length; i += 2) out[args[i]] = args[i + 1];
    return out;
  }

  // A thrown ReferenceError that is swallowed by our own error handler, so aborting a
  // page script does not spam the console or trip "uncaught error" detectors.
  let exceptionToken;
  function getExceptionToken() {
    if (exceptionToken) return exceptionToken;
    exceptionToken = String.fromCharCode(Date.now() % 26 + 97) + Math.floor(Math.random() * 982451653 + 982451653).toString(36);
    const oe = W.onerror;
    W.onerror = function (msg, ...rest) {
      if (typeof msg === 'string' && msg.includes(exceptionToken)) return true;
      if (oe instanceof Function) return oe.call(this, msg, ...rest);
    };
    return exceptionToken;
  }

  function onReady(fn, when = 'interactive') {
    const states = ['loading', 'interactive', 'complete'];
    if (states.indexOf(document.readyState) >= states.indexOf(when)) { fn(); return; }
    const ev = when === 'complete' ? 'load' : 'DOMContentLoaded';
    safe.Reflect_apply(safe.addEventListener, when === 'complete' ? W : document, [ev, fn, { once: true, capture: true }]);
  }

  // ---- constants -------------------------------------------------------------

  const SKIP = Symbol('skip');
  function constantValue(raw) {
    switch (raw) {
      case 'undefined': return undefined;
      case 'false': return false;
      case 'true': return true;
      case 'null': return null;
      case "''": case '""': case 'emptyStr': case '': return '';
      case '[]': case 'emptyArr': return [];
      case '{}': case 'emptyObj': return {};
      case 'noopFunc': return function () {};
      case 'trueFunc': return function () { return true; };
      case 'falseFunc': return function () { return false; };
      case 'throwFunc': return function () { throw new safe.Error(); };
      case 'noopCallbackFunc': return function () { return function () {}; };
      case 'yes': case 'no': case 'on': case 'off': return raw;
      case 'NaN': return NaN;
      case 'Infinity': return Infinity;
      case '-Infinity': return -Infinity;
    }
    if (/^-?\d+$/.test(raw)) {
      const n = parseInt(raw, 10);
      if (Math.abs(n) <= 0x7fff) return n;
    }
    return SKIP;
  }

  // ---- property-chain traps --------------------------------------------------

  // Walks "a.b.c" from `root`, waiting for missing intermediates to be assigned, and
  // calls onFinal(owner, prop) once the last owner exists.
  function trapChain(root, chain, onFinal) {
    const pos = chain.indexOf('.');
    if (pos === -1) { onFinal(root, chain); return; }
    const prop = chain.slice(0, pos);
    const rest = chain.slice(pos + 1);
    const v = root[prop];
    if (v instanceof safe.Object || (typeof v === 'object' && v !== null)) { trapChain(v, rest, onFinal); return; }
    if (v !== undefined) return;
    const desc = safe.getOwnPropertyDescriptor(root, prop);
    if (desc && desc.configurable === false) return;
    let value = v;
    try {
      safe.defineProperty(root, prop, {
        configurable: true,
        enumerable: true,
        get() { return value; },
        set(a) {
          value = a;
          if (a instanceof safe.Object) trapChain(a, rest, onFinal);
        },
      });
    } catch { /* non-extensible */ }
  }

  function normaliseChain(chain) {
    return chain.startsWith('window.') ? chain.slice(7) : chain;
  }

  // ---- scriptlets --------------------------------------------------------------

  const S = {};

  // set-constant: pin a property to a harmless value before the page reads it.
  S['set-constant'] = function (chain = '', rawValue = '', ...extra) {
    if (!chain) return;
    let cValue = constantValue(rawValue);
    if (cValue === SKIP) return;
    const opts = pairs(extra);
    if (opts.as === 'function') { const v = cValue; cValue = function () { return v; }; }
    else if (opts.as === 'callback') { const v = cValue; cValue = function () { return function () { return v; }; }; }
    else if (opts.as === 'resolved') cValue = safe.Promise.resolve(cValue);
    else if (opts.as === 'rejected') cValue = safe.Promise.reject(cValue);

    let aborted = false;
    const mustAbort = (v) => {
      if (aborted) return true;
      aborted = v !== undefined && v !== null && cValue !== undefined && cValue !== null && typeof v !== typeof cValue;
      return aborted;
    };
    trapChain(W, normaliseChain(chain), (owner, prop) => {
      let desc;
      try { desc = safe.getOwnPropertyDescriptor(owner, prop); } catch { return; }
      if (desc && desc.configurable === false) return;
      const current = desc && 'value' in desc ? desc.value : undefined;
      if (mustAbort(current)) return;
      const prevGet = desc && desc.get;
      const prevSet = desc && desc.set;
      try {
        safe.defineProperty(owner, prop, {
          configurable: false,
          enumerable: desc ? desc.enumerable : true,
          get() {
            if (prevGet) { try { prevGet.call(owner); } catch { /* keep constant */ } }
            return cValue;
          },
          set(a) {
            if (prevSet) { try { prevSet.call(owner, a); } catch { /* ignore */ } }
            // A page assigning a different type is not what the filter expected: let it win.
            if (mustAbort(a)) cValue = a;
          },
        });
      } catch { /* ignore */ }
    });
  };

  // abort-on-property-read: throw when the page reads the property.
  S['abort-on-property-read'] = function (chain = '') {
    if (!chain) return;
    const token = getExceptionToken();
    trapChain(W, normaliseChain(chain), (owner, prop) => {
      const desc = safe.getOwnPropertyDescriptor(owner, prop);
      if (desc && desc.configurable === false) return;
      try {
        safe.defineProperty(owner, prop, {
          configurable: false,
          get() { throw new ReferenceError(token); },
          set() {},
        });
      } catch { /* ignore */ }
    });
  };

  // abort-on-property-write: throw when the page assigns the property.
  S['abort-on-property-write'] = function (prop = '') {
    prop = normaliseChain(prop);
    if (!prop || prop.includes('.')) return;
    const token = getExceptionToken();
    try {
      delete W[prop];
      safe.defineProperty(W, prop, { configurable: false, set() { throw new ReferenceError(token); } });
    } catch { /* ignore */ }
  };

  // abort-current-script: throw when the property is touched by an inline script whose
  // text matches `needle`.
  S['abort-current-script'] = function (target = '', needle = '', context = '') {
    if (!target) return;
    const reNeedle = patternToRegex(needle);
    const reContext = patternToRegex(context);
    const thisScript = document.currentScript;
    let chain = normaliseChain(target);
    let owner = W;
    for (;;) {
      const pos = chain.indexOf('.');
      if (pos === -1) break;
      const v = owner[chain.slice(0, pos)];
      chain = chain.slice(pos + 1);
      if (!(v instanceof safe.Object) && (typeof v !== 'object' || v === null)) return;
      owner = v;
    }
    const prop = chain;
    let value;
    let desc = safe.getOwnPropertyDescriptor(owner, prop);
    if (!(desc instanceof safe.Object) || !(desc.get instanceof Function)) { value = owner[prop]; desc = undefined; }
    const token = getExceptionToken();
    const scriptTexts = new WeakMap();
    const getScriptText = (el) => {
      const text = el.textContent;
      if (text.trim() !== '') return text;
      if (scriptTexts.has(el)) return scriptTexts.get(el);
      const [, mime = '', content = ''] = /^data:([^,]*),(.+)$/.exec(el.src.trim()) || [];
      let out = '';
      try { out = mime.endsWith(';base64') ? atob(content) : decodeURIComponent(content); } catch { /* ignore */ }
      scriptTexts.set(el, out);
      return out;
    };
    const validate = () => {
      const e = document.currentScript;
      if (!(e instanceof HTMLScriptElement) || e === thisScript) return;
      if (context !== '' && !reContext.test(e.src)) return;
      // Without a context we only judge inline (or data:) scripts, whose text we can read.
      if (context === '' && e.src && !e.src.startsWith('data:')) return;
      if (!reNeedle.test(getScriptText(e))) return;
      throw new ReferenceError(token);
    };
    try {
      safe.defineProperty(owner, prop, {
        get() { validate(); return desc ? desc.get.call(owner) : value; },
        set(a) { validate(); if (desc && desc.set) desc.set.call(owner, a); else value = a; },
      });
    } catch { /* ignore */ }
  };

  // abort-on-stack-trace: throw when the property is touched from a matching call stack.
  // Stack lines from the document itself read as "inlineScript", eval'd code as
  // "injectedScript", matching uBO's needles.
  S['abort-on-stack-trace'] = function (chain = '', needle = '') {
    if (!chain) return;
    const re = patternToRegex(needle);
    const token = getExceptionToken();
    const docURL = location.href.split('#')[0];
    const matchesStack = () => {
      const lines = [];
      for (const line of String(new safe.Error().stack).split(/[\n\r]+/)) {
        if (line.includes('-extension://')) continue;
        const m = /(\S+?)(?::\d+:\d+)?\)?$/.exec(line.trim());
        if (!m) continue;
        let url = m[1].replace(/^\(/, '');
        if (url === docURL || url.split('#')[0] === docURL) url = 'inlineScript';
        else if (url.startsWith('<anonymous>') || url === 'eval') url = 'injectedScript';
        lines.push(url);
      }
      return re.test(lines.join('\t'));
    };
    trapChain(W, normaliseChain(chain), (owner, prop) => {
      let value = owner[prop];
      const desc = safe.getOwnPropertyDescriptor(owner, prop);
      if (desc && desc.configurable === false) return;
      try {
        safe.defineProperty(owner, prop, {
          configurable: true,
          get() { if (matchesStack()) throw new ReferenceError(token); return value; },
          set(a) { if (matchesStack()) throw new ReferenceError(token); value = a; },
        });
      } catch { /* ignore */ }
    });
  };

  // prevent-window-open: swallow popups whose URL matches. Returns a fake window so
  // popunder scripts believe they succeeded and stop retrying.
  S['prevent-window-open'] = function (pattern = '') {
    const m = matcher(pattern);
    const fakeWindow = (url) => {
      const doc = { write: noop, writeln: noop, open: noop, close: noop, body: null };
      const fake = {
        closed: false, opener: W, document: doc, location: { href: String(url) },
        close() { fake.closed = true; }, focus: noop, blur: noop, postMessage: noop,
        moveTo: noop, resizeTo: noop, addEventListener: noop, removeEventListener: noop,
      };
      return fake;
    };
    W.open = new safe.Proxy(W.open, {
      apply(target, thisArg, args) {
        const url = args.length ? String(args[0]) : '';
        if (!m.test(url)) return safe.Reflect_apply(target, thisArg, args);
        return fakeWindow(url);
      },
    });
  };

  function timerDefuser(name) {
    return function (needle = '', delay = '') {
      const n = matcher(needle);
      let delayNot = false;
      if (delay.startsWith('!')) { delayNot = true; delay = delay.slice(1); }
      const d = delay === '' ? undefined : parseInt(delay, 10);
      W[name] = new safe.Proxy(W[name], {
        apply(target, thisArg, args) {
          const [cb, ms] = args;
          let defuse = n.empty ? true : n.test(fnText(cb));
          if (defuse && d !== undefined) defuse = ((ms | 0) === d) !== delayNot;
          if (defuse) args[0] = noop;
          return safe.Reflect_apply(target, thisArg, args);
        },
      });
    };
  }
  S['prevent-setTimeout'] = timerDefuser('setTimeout');
  S['prevent-setInterval'] = timerDefuser('setInterval');

  function timerBooster(name, defaultDelay) {
    return function (needle = '', delay = String(defaultDelay), boost = '0.05') {
      const n = matcher(needle === '' ? '' : needle);
      const anyDelay = delay === '*';
      const d = anyDelay ? 0 : (parseInt(delay, 10) || defaultDelay);
      let b = parseFloat(boost);
      if (!Number.isFinite(b)) b = 0.05;
      b = Math.min(Math.max(b, 0.001), 50);
      W[name] = new safe.Proxy(W[name], {
        apply(target, thisArg, args) {
          const [cb, ms] = args;
          if ((anyDelay || (ms | 0) === d) && n.test(fnText(cb))) args[1] = (ms | 0) * b;
          return safe.Reflect_apply(target, thisArg, args);
        },
      });
    };
  }
  S['adjust-setTimeout'] = timerBooster('setTimeout', 1000);
  S['adjust-setInterval'] = timerBooster('setInterval', 1000);

  // prevent-addEventListener: drop listeners whose type and handler text match.
  S['prevent-addEventListener'] = function (type = '', pattern = '') {
    const t = matcher(type);
    const p = matcher(pattern);
    const proto = W.EventTarget.prototype;
    proto.addEventListener = new safe.Proxy(proto.addEventListener, {
      apply(target, thisArg, args) {
        const [evType, handler] = args;
        let text = '';
        if (typeof handler === 'function') text = fnText(handler);
        else if (handler && typeof handler.handleEvent === 'function') text = fnText(handler.handleEvent);
        else text = String(handler);
        if (t.test(String(evType)) && p.test(text)) return undefined;
        return safe.Reflect_apply(target, thisArg, args);
      },
    });
  };

  // remove-node-text: blank out matching text/script nodes as they are parsed. The parser
  // runs a microtask checkpoint before executing an inline script, so this lands in time.
  S['remove-node-text'] = function (nodeName = '', pattern = '') {
    if (!nodeName) return;
    const nameRe = /^\/.+\/$/.test(nodeName) ? patternToRegex(nodeName) : new safe.RegExp(`^${escapeRegex(nodeName.toLowerCase())}$`);
    const re = patternToRegex(pattern);
    const handle = (node) => {
      if (!nameRe.test(node.nodeName.toLowerCase())) return;
      const text = node.textContent;
      if (!text || !re.test(text)) return;
      node.textContent = '';
    };
    const walk = (root) => {
      if (!root) return;
      handle(root);
      const tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      let n;
      while ((n = tw.nextNode())) handle(n);
    };
    const observer = new safe.MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) handle(n);
    });
    observer.observe(document, { childList: true, subtree: true });
    if (document.documentElement) walk(document.documentElement);
    onReady(() => observer.disconnect(), 'complete');
  };

  // ---- request details for fetch/xhr matching ------------------------------------

  // propsToMatch: "url:/ads/ method:POST" or a bare pattern meaning url.
  function parseProps(propsToMatch) {
    const out = [];
    for (const part of propsToMatch.split(/\s+/).filter(Boolean)) {
      const i = part.indexOf(':');
      const hasKey = i > 0 && /^[a-z]+$/i.test(part.slice(0, i)) && !/^https?$/i.test(part.slice(0, i));
      out.push(hasKey ? [part.slice(0, i), patternToRegex(part.slice(i + 1))] : ['url', patternToRegex(part)]);
    }
    return out;
  }
  function propsMatch(props, details) {
    for (const [k, re] of props) {
      const v = details[k];
      if (v === undefined || !re.test(String(v))) return false;
    }
    return true;
  }
  function responseBodyFor(directive) {
    switch (directive) {
      case 'emptyObj': case '{}': return '{}';
      case 'emptyArr': case '[]': return '[]';
      case 'true': return Math.random().toString(36).slice(2).repeat(10);
      default: return '';
    }
  }

  S['prevent-fetch'] = function (propsToMatch = '', responseBody = '', responseType = '') {
    if (!propsToMatch) return;
    const props = parseProps(propsToMatch);
    W.fetch = new safe.Proxy(W.fetch, {
      apply(target, thisArg, args) {
        const [input, init] = args;
        const details = {};
        try {
          if (input instanceof W.Request) {
            details.url = input.url; details.method = input.method; details.mode = input.mode; details.credentials = input.credentials;
          } else {
            details.url = String(input);
          }
          if (init && typeof init === 'object') {
            for (const k of ['method', 'mode', 'credentials', 'cache', 'referrer', 'referrerPolicy', 'integrity', 'redirect']) {
              if (init[k] !== undefined) details[k] = init[k];
            }
            if (typeof init.body === 'string') details.body = init.body;
          }
          details.method = details.method || 'GET';
        } catch { return safe.Reflect_apply(target, thisArg, args); }
        if (!propsMatch(props, details)) return safe.Reflect_apply(target, thisArg, args);
        const body = responseBodyFor(responseBody);
        const response = new safe.Response(body, { status: 200, statusText: 'OK', headers: { 'Content-Length': String(body.length) } });
        try {
          safe.defineProperty(response, 'url', { value: details.url });
          safe.defineProperty(response, 'type', { value: responseType || 'basic' });
        } catch { /* ignore */ }
        return safe.Promise.resolve(response);
      },
    });
  };

  // A subclass that can fake a response for chosen requests and pass everything else
  // through untouched. Shared by prevent-xhr and json-prune-xhr-response.
  function patchXhr({ onOpen, onResponse }) {
    const details = new WeakMap();
    const Native = W.XMLHttpRequest;
    W.XMLHttpRequest = class XMLHttpRequest extends Native {
      open(method, url, ...rest) {
        const d = { method: String(method).toUpperCase(), url: String(url) };
        const fake = onOpen ? onOpen(d) : null;
        if (fake !== null && fake !== undefined) details.set(this, { ...d, fake });
        else details.set(this, d);
        return super.open(method, url, ...rest);
      }
      send(body) {
        const d = details.get(this);
        if (!d || d.fake === undefined) return super.send(body);
        d.readyState = 1;
        safe.setTimeout(() => {
          d.readyState = 4;
          let response = d.fake;
          if (this.responseType === 'json') { try { response = safe.JSON_parse(d.fake); } catch { response = null; } }
          d.response = response;
          this.dispatchEvent(new Event('readystatechange'));
          this.dispatchEvent(new ProgressEvent('load'));
          this.dispatchEvent(new ProgressEvent('loadend'));
        }, 1);
      }
      get readyState() { const d = details.get(this); return d && d.readyState !== undefined ? d.readyState : super.readyState; }
      get status() { const d = details.get(this); return d && d.fake !== undefined ? 200 : super.status; }
      get statusText() { const d = details.get(this); return d && d.fake !== undefined ? 'OK' : super.statusText; }
      get responseURL() { const d = details.get(this); return d && d.fake !== undefined ? d.url : super.responseURL; }
      get responseXML() { const d = details.get(this); return d && d.fake !== undefined ? null : super.responseXML; }
      get response() {
        const d = details.get(this);
        if (d && d.fake !== undefined) return d.response;
        const r = super.response;
        return onResponse && d ? onResponse(d, r, this) : r;
      }
      get responseText() {
        const d = details.get(this);
        if (d && d.fake !== undefined) return typeof d.fake === 'string' ? d.fake : '';
        const r = super.responseText;
        return onResponse && d ? onResponse(d, r, this, true) : r;
      }
      getResponseHeader(name) { const d = details.get(this); return d && d.fake !== undefined ? null : super.getResponseHeader(name); }
      getAllResponseHeaders() { const d = details.get(this); return d && d.fake !== undefined ? '' : super.getAllResponseHeaders(); }
    };
  }

  S['prevent-xhr'] = function (propsToMatch = '', directive = '') {
    if (!propsToMatch) return;
    const props = parseProps(propsToMatch);
    patchXhr({ onOpen: (d) => (propsMatch(props, d) ? responseBodyFor(directive) : null) });
  };

  // ---- json-prune family -----------------------------------------------------------

  // Paths: "a.b.c", "a.[].b" (every array element / object value), "a.*.b" (any key).
  function walkPath(obj, parts, i, onLeaf) {
    if (obj === null || typeof obj !== 'object') return;
    const key = parts[i];
    const last = i === parts.length - 1;
    const keys = key === '[]' || key === '*' ? Object.keys(obj) : [key];
    for (const k of keys) {
      if (!(k in obj)) continue;
      if (last) onLeaf(obj, k);
      else walkPath(obj[k], parts, i + 1, onLeaf);
    }
  }
  function makePruner(rawPrunePaths, rawNeedlePaths) {
    const prunePaths = rawPrunePaths.split(/ +/).filter(Boolean).map((p) => p.split('.'));
    const needlePaths = rawNeedlePaths.split(/ +/).filter(Boolean).map((p) => p.split('.'));
    if (!prunePaths.length) return null;
    return (obj) => {
      if (obj === null || typeof obj !== 'object') return obj;
      for (const np of needlePaths) {
        let found = false;
        walkPath(obj, np, 0, () => { found = true; });
        if (!found) return obj;
      }
      for (const pp of prunePaths) walkPath(obj, pp, 0, (owner, k) => { delete owner[k]; });
      return obj;
    };
  }

  S['json-prune'] = function (rawPrunePaths = '', rawNeedlePaths = '') {
    const prune = makePruner(rawPrunePaths, rawNeedlePaths);
    if (!prune) return;
    W.JSON.parse = new safe.Proxy(W.JSON.parse, {
      apply(target, thisArg, args) { return prune(safe.Reflect_apply(target, thisArg, args)); },
    });
    const proto = W.Response.prototype;
    proto.json = new safe.Proxy(proto.json, {
      apply(target, thisArg, args) { return safe.Reflect_apply(target, thisArg, args).then(prune); },
    });
  };

  S['json-prune-fetch-response'] = function (rawPrunePaths = '', rawNeedlePaths = '', ...extra) {
    const prune = makePruner(rawPrunePaths, rawNeedlePaths);
    if (!prune) return;
    const opts = pairs(extra);
    const props = opts.propsToMatch ? parseProps(opts.propsToMatch) : [];
    W.fetch = new safe.Proxy(W.fetch, {
      apply(target, thisArg, args) {
        const p = safe.Reflect_apply(target, thisArg, args);
        if (props.length) {
          const [input, init] = args;
          const details = { url: input instanceof W.Request ? input.url : String(input), method: (init && init.method) || (input instanceof W.Request ? input.method : 'GET') };
          if (!propsMatch(props, details)) return p;
        }
        return p.then((response) => response.clone().text().then((text) => {
          let obj;
          try { obj = safe.JSON_parse(text); } catch { return response; }
          const pruned = new safe.Response(safe.JSON_stringify(prune(obj)), {
            status: response.status, statusText: response.statusText, headers: response.headers,
          });
          try {
            safe.defineProperty(pruned, 'url', { value: response.url });
            safe.defineProperty(pruned, 'type', { value: response.type });
            safe.defineProperty(pruned, 'redirected', { value: response.redirected });
          } catch { /* ignore */ }
          return pruned;
        }).catch(() => response));
      },
    });
  };

  S['json-prune-xhr-response'] = function (rawPrunePaths = '', rawNeedlePaths = '', ...extra) {
    const prune = makePruner(rawPrunePaths, rawNeedlePaths);
    if (!prune) return;
    const opts = pairs(extra);
    const props = opts.propsToMatch ? parseProps(opts.propsToMatch) : [];
    const cache = new WeakMap();
    patchXhr({
      onOpen: () => null,
      onResponse: (d, r, xhr, asText) => {
        if (xhr.readyState !== 4 || (props.length && !propsMatch(props, d))) return r;
        if (cache.has(xhr)) { const c = cache.get(xhr); return asText ? c.text : c.value; }
        let value = r;
        let text = typeof r === 'string' ? r : '';
        try {
          const obj = typeof r === 'string' ? safe.JSON_parse(r) : r;
          if (obj && typeof obj === 'object') { const pruned = prune(obj); text = safe.JSON_stringify(pruned); value = typeof r === 'string' ? text : pruned; }
        } catch { /* not JSON */ }
        cache.set(xhr, { value, text });
        return asText ? text : value;
      },
    });
  };

  // ---- eval ----------------------------------------------------------------------------

  S['noeval-if'] = function (needle = '') {
    const m = matcher(needle);
    W.eval = new safe.Proxy(W.eval, {
      apply(target, thisArg, args) {
        if (m.test(String(args[0]))) return undefined;
        return safe.Reflect_apply(target, thisArg, args);
      },
    });
  };
  S['noeval'] = function () {
    W.eval = new safe.Proxy(W.eval, { apply() { return undefined; } });
  };

  // ---- DOM attribute/class removal ------------------------------------------------------

  function domFixer(apply, selector, behavior) {
    let timer = 0;
    const run = () => { timer = 0; try { document.querySelectorAll(selector).forEach(apply); } catch { /* bad selector */ } };
    const schedule = () => { if (!timer) timer = safe.setTimeout(run, 0); };
    const start = () => {
      run();
      if (!/stay/.test(behavior)) return;
      new safe.MutationObserver(schedule).observe(document, { childList: true, subtree: true, attributes: true });
    };
    if (/complete/.test(behavior)) onReady(start, 'complete');
    else if (document.readyState === 'loading') {
      // Keep fixing while the document loads, then settle.
      const mo = new safe.MutationObserver(schedule);
      mo.observe(document, { childList: true, subtree: true });
      onReady(() => { if (!/stay/.test(behavior)) mo.disconnect(); start(); });
    } else start();
  }

  S['remove-attr'] = function (rawToken = '', rawSelector = '', behavior = '') {
    const attrs = rawToken.split(/\s*\|\s*/).filter(Boolean);
    if (!attrs.length) return;
    const selector = rawSelector || attrs.map((a) => `[${CSS.escape(a)}]`).join(',');
    domFixer((el) => attrs.forEach((a) => el.removeAttribute(a)), selector, behavior);
  };

  S['remove-class'] = function (rawToken = '', rawSelector = '', behavior = '') {
    const classes = rawToken.split(/\s*\|\s*/).filter(Boolean);
    if (!classes.length) return;
    const selector = rawSelector || classes.map((c) => `.${CSS.escape(c)}`).join(',');
    domFixer((el) => el.classList.remove(...classes), selector, behavior);
  };

  S['set-attr'] = function (selector = '', attr = '', value = '') {
    if (!selector || !attr || /^on/i.test(attr) || /^(src|href|style|srcdoc|action|formaction|data)$/i.test(attr)) return;
    // Untrusted values only: empty, booleans, small integers, or a copy of another attribute.
    let getValue;
    if (value === '' || value === 'true' || value === 'false' || (/^-?\d+$/.test(value) && Math.abs(parseInt(value, 10)) <= 0x7fff)) getValue = () => value;
    else if (/^\[[\w-]+\]$/.test(value)) { const src = value.slice(1, -1); getValue = (el) => el.getAttribute(src); }
    else return;
    domFixer((el) => { const v = getValue(el); if (v !== null && el.getAttribute(attr) !== v) el.setAttribute(attr, v); }, selector, 'stay');
  };

  // ---- storage / cookies -----------------------------------------------------------------

  const SAFE_COOKIE_VALUES = new Set([
    '', 'accept', 'accepted', 'agree', 'all', 'allow', 'allowed', 'approved', 'checked', 'closed', 'decline',
    'declined', 'deny', 'denied', 'disable', 'disabled', 'disagree', 'dismiss', 'dismissed', 'done', 'enable',
    'enabled', 'essential', 'f', 'false', 'functional', 'granted', 'hidden', 'hide', 'mandatory', 'n',
    'necessary', 'next', 'no', 'nonessential', 'none', 'off', 'ok', 'on', 'reject', 'rejected', 'required',
    't', 'true', 'unchecked', 'y', 'yes',
  ]);

  S['set-cookie'] = function (name = '', value = '', path = '') {
    if (!name) return;
    const lower = value.toLowerCase();
    if (!SAFE_COOKIE_VALUES.has(lower) && !(/^\d+$/.test(value) && parseInt(value, 10) <= 0x7fff)) return;
    const encName = encodeURIComponent(name);
    const already = document.cookie.split(/;\s*/).some((c) => c === `${encName}=${encodeURIComponent(value)}`);
    if (already) return;
    let cookie = `${encName}=${encodeURIComponent(value)}; SameSite=Lax`;
    if (path === '' || path === '/') cookie += '; path=/';
    else if (path !== 'none') return;
    cookie += `; max-age=${60 * 60 * 24 * 365}`;
    try { document.cookie = cookie; } catch { /* sandboxed */ }
  };

  S['remove-cookie'] = function (needle = '') {
    const re = patternToRegex(needle);
    const remove = () => {
      for (const c of document.cookie.split(';')) {
        const name = c.split('=')[0].trim();
        if (!name || !re.test(name)) continue;
        const expire = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
        document.cookie = `${expire}; path=/`;
        document.cookie = expire;
        let host = location.hostname;
        while (host.includes('.')) {
          document.cookie = `${expire}; path=/; domain=.${host}`;
          host = host.slice(host.indexOf('.') + 1);
        }
      }
    };
    remove();
    safe.Reflect_apply(safe.addEventListener, W, ['beforeunload', remove]);
    safe.Reflect_apply(safe.addEventListener, document, ['visibilitychange', () => { if (document.visibilityState === 'hidden') remove(); }]);
  };

  function storageSetter(storageName) {
    return function (key = '', value = '') {
      if (!key) return;
      let storage;
      try { storage = W[storageName]; } catch { return; }
      if (!storage) return;
      if (value === '$remove$' || value === 'undefined') { try { storage.removeItem(key); } catch { /* ignore */ } return; }
      let v;
      const lower = value.toLowerCase();
      if (['', 'false', 'true', 'null', 'yes', 'no', 'on', 'off', 'accept', 'accepted', 'reject', 'rejected', 'allowed', 'denied', 'ok', 'y', 'n'].includes(lower)) v = value;
      else if (value === 'emptyObj' || value === '{}') v = '{}';
      else if (value === 'emptyArr' || value === '[]') v = '[]';
      else if (/^\d+$/.test(value) && parseInt(value, 10) <= 0x7fff) v = value;
      else if (value === '$now$') v = String(Date.now());
      else if (value === '$currentDate$') v = String(new Date());
      else if (value === '$currentISODate$') v = new Date().toISOString();
      else return;
      try { if (storage.getItem(key) !== v) storage.setItem(key, v); } catch { /* quota / disabled */ }
    };
  }
  S['set-local-storage-item'] = storageSetter('localStorage');
  S['set-session-storage-item'] = storageSetter('sessionStorage');

  // ---- anti-adblock library fakes ----------------------------------------------------------

  // BlockAdBlock / FuckAdBlock / SniffAdBlock: report "not detected" and run the page's
  // not-detected callbacks.
  function fakeDetector() {
    const Fake = function () {};
    const self = function () { return this; };
    Fake.prototype.on = function (detected, fn) { if (!detected && typeof fn === 'function') safe.setTimeout(fn, 1); return this; };
    Fake.prototype.onDetected = self;
    Fake.prototype.onNotDetected = function (fn) { if (typeof fn === 'function') safe.setTimeout(fn, 1); return this; };
    Fake.prototype.setOption = self;
    Fake.prototype.check = function () { return false; };
    Fake.prototype.emitEvent = self;
    Fake.prototype.clearEvent = self;
    Fake.prototype.options = { set: self, get: self };
    return Fake;
  }
  S['nobab'] = function () {
    const Fake = fakeDetector();
    const inst = new Fake();
    for (const [k, v] of [['BlockAdBlock', Fake], ['blockAdBlock', inst], ['SniffAdBlock', Fake], ['sniffAdBlock', inst]]) {
      try { safe.defineProperty(W, k, { value: v, writable: false, configurable: false }); } catch { /* ignore */ }
    }
    // The obfuscated "bab" loader evals a blob with recognisable tokens.
    const sig = ['getElementById', 'String.fromCharCode', 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', 'charAt', 'DOMContentLoaded', 'AdBlock', 'addEventListener', 'doScroll', 'fromCharCode', '<<2|r>>4', 'sessionStorage', 'clientWidth', 'localStorage', 'Math', 'random'];
    W.eval = new safe.Proxy(W.eval, {
      apply(target, thisArg, args) {
        const a = args[0];
        // Case-sensitive, like uBO: the obfuscated loader uses these exact lowercase tokens.
        if (typeof a === 'string' && (a.includes('blockadblock') || a.includes('babasbm') || /getItem\('babn'\)/.test(a) || sig.every((s) => a.includes(s)))) {
          if (document.body) document.body.style.removeProperty('visibility');
          return undefined;
        }
        return safe.Reflect_apply(target, thisArg, args);
      },
    });
  };
  S['nofab'] = function () {
    const Fake = fakeDetector();
    const inst = new Fake();
    for (const [k, v] of [['FuckAdBlock', Fake], ['fuckAdBlock', inst], ['fAB', inst]]) {
      try { safe.defineProperty(W, k, { value: v, writable: false, configurable: false }); } catch { /* ignore */ }
    }
  };

  S['nowebrtc'] = function () {
    const name = W.RTCPeerConnection ? 'RTCPeerConnection' : W.webkitRTCPeerConnection ? 'webkitRTCPeerConnection' : '';
    if (!name) return;
    const Native = W[name];
    const Fake = function () {};
    Fake.prototype = {
      close: noop, createDataChannel: () => ({ close: noop, send: noop }), createOffer: () => safe.Promise.resolve({}),
      setRemoteDescription: () => safe.Promise.resolve(), setLocalDescription: () => safe.Promise.resolve(),
      addIceCandidate: () => safe.Promise.resolve(), addEventListener: noop, removeEventListener: noop,
      toString() { return '[object RTCPeerConnection]'; },
    };
    W[name] = new safe.Proxy(Native, { construct() { return new Fake(); } });
  };

  S['refresh-defuser'] = function (arg = '') {
    onReady(() => {
      const meta = document.querySelector('meta[http-equiv="refresh" i][content]');
      if (!meta) return;
      const s = arg === '' ? meta.getAttribute('content') : arg;
      const ms = Math.max(parseFloat(s) || 0, 0) * 1000;
      safe.setTimeout(() => W.stop(), ms);
    });
  };

  S['popads-dummy'] = function () {
    delete W.PopAds;
    delete W.popns;
    try {
      safe.defineProperty(W, 'PopAds', { value: {} });
      safe.defineProperty(W, 'popns', { value: {} });
    } catch { /* ignore */ }
  };

  // SilentBlock's own: dismiss anti-adblock walls on sites listed in our filters.
  S['sb-unwall'] = function () {
    /*@UNWALL_CORE@*/
    unwallWatch(20000);
  };

  return S;
})();
