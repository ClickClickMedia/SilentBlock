// Stand-in for google-analytics.com/analytics.js (Universal Analytics) when blocked.
// Runs every hitCallback so "send the hit, then navigate" links still navigate.
(function () {
  'use strict';
  const noop = function () {};
  const Tracker = function () {};
  Tracker.prototype.get = noop;
  Tracker.prototype.set = noop;
  Tracker.prototype.send = noop;
  const w = window;
  const gaName = w.GoogleAnalyticsObject || 'ga';
  const queued = w[gaName];
  const ga = function () {
    const args = Array.from(arguments);
    if (!args.length) return;
    const last = args[args.length - 1];
    let fn;
    if (last instanceof Object && typeof last.hitCallback === 'function') fn = last.hitCallback;
    else if (typeof last === 'function') fn = function () { last(ga.create()); };
    else {
      const i = args.indexOf('hitCallback');
      if (i !== -1 && typeof args[i + 1] === 'function') fn = args[i + 1];
    }
    if (typeof fn === 'function') { try { fn(); } catch (e) { /* page callback */ } }
  };
  ga.create = function () { return new Tracker(); };
  ga.getByName = function () { return new Tracker(); };
  ga.getAll = function () { return [new Tracker()]; };
  ga.remove = noop;
  ga.loaded = true;
  w[gaName] = ga;

  const dl = w.dataLayer;
  if (dl instanceof Object && dl.hide instanceof Object && typeof dl.hide.end === 'function') {
    dl.hide.end();
    dl.hide.end = noop;
  }
  if (typeof queued === 'function' && Array.isArray(queued.q)) {
    const q = queued.q.slice();
    queued.q.length = 0;
    for (const entry of q) ga.apply(null, Array.from(entry));
  }
})();
