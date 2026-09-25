// Stand-in for scorecardresearch.com/beacon.js (comScore) when blocked.
(function () {
  'use strict';
  window.COMSCORE = { purge: function () { window._comscore = []; }, beacon: function () {} };
})();
