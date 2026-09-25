// Stand-in for googletagmanager.com/gtm.js and /gtag/js when they are blocked.
// Pages often wait on a tag's callback before navigating ("track the click, then go"), or
// hide themselves until GTM loads (the anti-flicker snippet). Without this stub those
// pages hang. We fire the callbacks and lift the hide, and send nothing anywhere.
(function () {
  'use strict';
  const w = window;
  w.ga = w.ga || function () {};
  const dl = w.dataLayer;
  if (!(dl instanceof Object)) return;
  if (dl.hide instanceof Object && typeof dl.hide.end === 'function') {
    dl.hide.end();
    dl.hide.end = function () {};
  }
  if (typeof dl.push !== 'function') return;
  const fire = function (fn) { if (typeof fn === 'function') setTimeout(fn, 1); };
  const doCallback = function (item) {
    if (!(item instanceof Object)) return;
    // GTM style: dataLayer.push({ event, eventCallback })
    if (typeof item.eventCallback === 'function') {
      fire(item.eventCallback);
      item.eventCallback = function () {};
    }
    // gtag style: gtag('event', name, { event_callback }) pushes the arguments object
    const params = item[2];
    if (item[0] === 'event' && params instanceof Object && typeof params.event_callback === 'function') {
      fire(params.event_callback);
      params.event_callback = function () {};
    }
  };
  dl.push = new Proxy(dl.push, {
    apply(target, thisArg, args) {
      doCallback(args[0]);
      return Reflect.apply(target, thisArg, args);
    },
  });
  if (Array.isArray(dl)) for (const item of dl.slice()) doCallback(item);
})();
