'use strict';

/**
 * Settings — small persistent preference bag in localStorage.
 * Loaded on every page, because the settings drawer lives in the layout.
 *
 * STORAGE IS SHARED WITH CRITLAB, CROSSLAB AND ROUTELAB. All four tools are
 * served from the same origin (www.noahpaladino.com/CritLab, /CrossLab,
 * /RouteLab, /FitLab), so localStorage is one bag. The blob key, the API-key
 * slot and every key the others define keep their names and meanings here:
 * paste the intervals.icu key once and every tool sees it.
 *
 * Rules that keep that true:
 *   · only ADD keys to DEFAULTS, never change what an existing one means
 *   · FitLab-only keys are prefixed `fl` so they are recognisable in a dump
 *   · `reset()` removes FitLab's own keys only; it never touches the
 *     intervals.icu settings, the rider numbers or the other tools' keys
 *   · unknown keys in the stored blob survive a round trip (all() merges the
 *     stored object over DEFAULTS, set() merges on top of that)
 *
 * This is RouteLab's Settings with FitLab's DEFAULTS; port fixes both ways.
 */
const Settings = (() => {
  const KEY = 'cl-settings';

  // The intervals.icu key is deliberately NOT part of the settings blob: it
  // gets its own lifetime (session or persistent), can be purged on its own,
  // and never rides along in a dump of `cl-settings`. Same slot as CritLab.
  const ICU_KEY_STORE = 'cl-icu-key';

  const DEFAULTS = {
    // ── Shared with CritLab, CrossLab and RouteLab: identical names and meanings ──
    icuAthlete: '', icuAthleteName: '',
    icuKeyPersist: 'local',        // 'local' = remembered · 'session' = until the tab closes
    mass: 78,                      // rider + bike, kg
    crr: 0.004, cda: 0.32,
    ftp: 250, ftpUserSet: false,

    // ── FitLab only ───────────────────────────────────────────────────────
    flUnits: 'km',                 // 'km' | 'mi'
    flTol: 1,                      // merge: a donor sample within this many s counts as "at" a base sample
    flBridge: 5,                   // merge: interpolate across donor gaps up to this many s
    flIcuDays: 14,                 // how far back the intervals.icu list looks
    flWelcomeSeen: false, flTourDone: false,
  };

  const RESETTABLE = ['flUnits', 'flTol', 'flBridge', 'flIcuDays'];

  let cache = null;
  let memKey = '';

  function store(kind) {
    try {
      const s = kind === 'session' ? sessionStorage : localStorage;
      if (!s) return null;
      const probe = '__cl_probe__';
      s.setItem(probe, '1');
      s.removeItem(probe);
      return s;
    } catch (_) { return null; }
  }

  /** Read the key from wherever it was put. Session wins — it is the fresher one. */
  function getIcuKey() {
    try {
      const s = store('session'), l = store('local');
      const found = (s && s.getItem(ICU_KEY_STORE)) || (l && l.getItem(ICU_KEY_STORE)) || '';
      return found || memKey;
    } catch (_) { return memKey; }
  }

  function setIcuKey(key, persist) {
    const how = persist || get('icuKeyPersist') || 'local';
    memKey = key || '';
    try { const l = store('local'); if (l) l.removeItem(ICU_KEY_STORE); } catch (_) {}
    try { const s = store('session'); if (s) s.removeItem(ICU_KEY_STORE); } catch (_) {}
    if (!key) return;
    try {
      const target = store(how === 'session' ? 'session' : 'local');
      if (target) target.setItem(ICU_KEY_STORE, key);
    } catch (_) {}
  }

  function forgetIcuKey() { setIcuKey(''); }

  function all() {
    if (cache) return cache;
    let stored = {};
    try { stored = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (_) {}
    // Earlier CritLab builds kept the key inside the blob. Move it out.
    if (stored.icuKey) {
      const legacy = stored.icuKey;
      delete stored.icuKey;
      cache = { ...DEFAULTS, ...stored };
      try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch (_) {}
      setIcuKey(legacy, cache.icuKeyPersist);
    } else {
      delete stored.icuKey;
      cache = { ...DEFAULTS, ...stored };
    }
    return cache;
  }

  function get(k) {
    const s = all();
    return k === 'icuKey' ? getIcuKey() : s[k];
  }

  function set(patch) {
    const next = { ...patch };
    if ('icuKey' in next) {
      setIcuKey(next.icuKey, next.icuKeyPersist || get('icuKeyPersist'));
      delete next.icuKey;
    }
    cache = { ...all(), ...next };
    delete cache.icuKey;
    try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch (_) {}
    if (next.icuKeyPersist) {
      const existing = getIcuKey();
      if (existing) setIcuKey(existing, next.icuKeyPersist);
    }
    return cache;
  }

  function reset() {
    const keep = { ...all() };
    for (const k of RESETTABLE) delete keep[k];
    cache = null;
    try { localStorage.setItem(KEY, JSON.stringify(keep)); } catch (_) {}
    return all();
  }

  return { all, get, set, reset, DEFAULTS, RESETTABLE, getIcuKey, setIcuKey, forgetIcuKey, ICU_KEY_STORE, KEY };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { Settings };
