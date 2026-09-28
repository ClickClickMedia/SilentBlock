// Stand-in for pagead2.googlesyndication.com/pagead/js/adsbygoogle.js when blocked.
// Pages push slot configs into `adsbygoogle`; accept them so page code keeps running.
(function () {
  'use strict';
  const w = window;
  const queued = Array.isArray(w.adsbygoogle) ? w.adsbygoogle : [];
  const markDone = function () {
    for (const el of document.querySelectorAll('ins.adsbygoogle:not([data-adsbygoogle-status])')) {
      el.setAttribute('data-adsbygoogle-status', 'done');
    }
  };
  w.adsbygoogle = { loaded: true, push: function () { markDone(); } };
  if (queued.length) markDone();
})();
