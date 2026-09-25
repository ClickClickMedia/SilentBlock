// Stand-in for Google Publisher Tag (gpt.js) when blocked. Implements the googletag API
// as no-ops and drains `googletag.cmd`, so pages that queue ad code keep running.
(function () {
  'use strict';
  const noop = function () {};
  const self = function () { return this; };
  const nul = function () { return null; };
  const arr = function () { return []; };
  const str = function () { return ''; };

  const Slot = function (path, size, divId) {
    this._path = path || '';
    this._divId = divId || '';
  };
  Object.assign(Slot.prototype, {
    addService: self, clearCategoryExclusions: self, clearTargeting: self, defineSizeMapping: self,
    get: nul, getAdUnitPath() { return this._path; }, getAttributeKeys: arr, getCategoryExclusions: arr,
    getDomId() { return this._divId; }, getResponseInformation: nul, getSlotElementId() { return this._divId; },
    getSlotId: self, getTargeting: arr, getTargetingKeys: arr, set: self, setCategoryExclusion: self,
    setClickUrl: self, setCollapseEmptyDiv: self, setConfig: self, setForceSafeFrame: self,
    setSafeFrameConfig: self, setTargeting: self, updateTargetingFromMap: self,
  });
  const Passback = function () {};
  Object.assign(Passback.prototype, {
    display: noop, get: nul, set: self, setClickUrl: self, setTagForChildDirectedTreatment: self,
    setTargeting: self, updateTargetingFromMap: self,
  });
  const SizeMapping = function () {};
  SizeMapping.prototype.addSize = self;
  SizeMapping.prototype.build = nul;

  const pubads = {
    addEventListener: self, clear: noop, clearCategoryExclusions: self, clearTagForChildDirectedTreatment: self,
    clearTargeting: self, collapseEmptyDivs: noop, defineOutOfPagePassback() { return new Passback(); },
    definePassback() { return new Passback(); }, disableInitialLoad: noop, display: noop,
    enableAsyncRendering: noop, enableLazyLoad: noop, enableSingleRequest: noop, enableSyncRendering: noop,
    enableVideoAds: noop, get: nul, getAttributeKeys: arr, getSlots: arr, getTargeting: arr,
    getTargetingKeys: arr, isInitialLoadDisabled() { return false; }, refresh: noop, removeEventListener: noop,
    set: self, setCategoryExclusion: self, setCentering: noop, setCookieOptions: self, setForceSafeFrame: self,
    setLocation: self, setPrivacySettings: self, setPublisherProvidedId: self, setRequestNonPersonalizedAds: self,
    setSafeFrameConfig: self, setTagForChildDirectedTreatment: self, setTargeting: self, setVideoContent: self,
    updateCorrelator: noop,
  };

  const w = window;
  const gt = w.googletag || {};
  const cmd = Array.isArray(gt.cmd) ? gt.cmd : [];
  const run = function (fn) { if (typeof fn === 'function') { try { fn.call(w); } catch (e) { /* page code */ } } };
  Object.assign(gt, {
    apiReady: true,
    pubadsReady: true,
    companionAds() { return { addEventListener: self, enableSyncLoading: noop, setRefreshUnfilledSlots: noop }; },
    content() { return { addEventListener: self, setContent: noop }; },
    defineOutOfPageSlot(path, divId) { return new Slot(path, null, divId); },
    defineSlot(path, size, divId) { return new Slot(path, size, divId); },
    destroySlots: noop, disablePublisherConsole: noop, display: noop, enableServices: noop,
    getVersion: str, pubads() { return pubads; }, setAdIframeTitle: noop, setConfig: noop,
    sizeMapping() { return new SizeMapping(); },
  });
  gt.cmd = [];
  gt.cmd.push = function () { for (const fn of arguments) run(fn); return 1; };
  w.googletag = gt;
  for (const fn of cmd) run(fn);
})();
