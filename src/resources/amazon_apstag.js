// Stand-in for Amazon's apstag.js when blocked: bids come back empty, callbacks still run.
(function () {
  'use strict';
  const w = window;
  const noop = function () {};
  const q = (w.apstag && Array.isArray(w.apstag._Q)) ? w.apstag._Q : [];
  const apstag = {
    _Q: [],
    fetchBids: function (config, cb) { if (typeof cb === 'function') { try { cb([]); } catch (e) { /* page code */ } } },
    init: noop, setDisplayBids: noop, targetingKeys: function () { return []; },
  };
  apstag._Q.push = function (prefix, args) { if (prefix === 'f') apstag.fetchBids.apply(apstag, args || []); return 0; };
  w.apstag = apstag;
  for (const entry of q) { if (Array.isArray(entry)) apstag._Q.push(entry[0], entry[1]); }
})();
