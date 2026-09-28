// Stand-in for the legacy google-analytics.com/ga.js (_gaq) when blocked.
(function () {
  'use strict';
  const noop = function () {};
  const tracker = new Proxy({}, { get: function () { return noop; } });
  const w = window;
  const queued = Array.isArray(w._gaq) ? w._gaq : [];
  const run = function (item) { if (typeof item === 'function') { try { item(); } catch (e) { /* page code */ } } };
  w._gaq = { push: function () { for (const item of arguments) run(item); return 0; } };
  w._gat = { _createTracker: function () { return tracker; }, _getTracker: function () { return tracker; }, _getTrackerByName: function () { return tracker; }, _anonymizeIp: noop };
  for (const item of queued) run(item);
})();
