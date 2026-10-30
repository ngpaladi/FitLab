'use strict';

/**
 * TrackMap.js — the GPS track, drawn plain on a canvas.
 *
 * No basemap: FitLab is about what's in the file, and a track on its own is
 * enough to see where a selection is, where a GPS glitch jumped, or that two
 * files covered the same road. The selection is highlighted, the hover point
 * from the timeline is marked, and the second file's track is drawn under
 * the working one.
 */
const TrackMap = (() => {

  function css(name, fallback) {
    try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback; } catch (_) { return fallback; }
  }

  function create(canvas) {
    const ctx = canvas.getContext('2d');
    let data = null, sel = null, cursor = null, W = 0, H = 0, dpr = 1;

    function size() {
      const r = canvas.getBoundingClientRect();
      dpr = window.devicePixelRatio || 1;
      W = Math.max(1, Math.round(r.width)); H = Math.max(1, Math.round(r.height));
      canvas.width = W * dpr; canvas.height = H * dpr;
    }

    function hasGps(S) { if (!S) return false; for (let i = 0; i < S.n; i++) if (S.lat[i] === S.lat[i]) return true; return false; }

    function projector() {
      let la0 = Infinity, la1 = -Infinity, lo0 = Infinity, lo1 = -Infinity;
      for (const S of [data.work, data.second]) {
        if (!S) continue;
        for (let i = 0; i < S.n; i++) {
          const a = S.lat[i], o = S.lon[i];
          if (a !== a) continue;
          if (a < la0) la0 = a; if (a > la1) la1 = a; if (o < lo0) lo0 = o; if (o > lo1) lo1 = o;
        }
      }
      const k = Math.cos((la0 + la1) / 2 * Math.PI / 180);
      const w = Math.max(1e-6, (lo1 - lo0) * k), h = Math.max(1e-6, la1 - la0);
      const pad = 16, s = Math.min((W - 2 * pad) / w, (H - 2 * pad) / h);
      const ox = (W - w * s) / 2, oy = (H - h * s) / 2;
      return (a, o) => [ox + (o - lo0) * k * s, H - oy - (a - la0) * s];
    }

    function line(S, P, from, to, color, width, dash) {
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash || []);
      ctx.beginPath();
      let open = false, lastT = null;
      for (let i = from; i <= to; i++) {
        if (S.lat[i] !== S.lat[i]) { open = false; continue; }
        if (lastT !== null && S.t[i] - lastT > 30) open = false;
        lastT = S.t[i];
        const [x, y] = P(S.lat[i], S.lon[i]);
        if (!open) { ctx.moveTo(x, y); open = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    function idx(S, t) {
      let lo = 0, hi = S.n - 1, ans = 0;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (S.t[m] <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
      return ans;
    }

    function draw() {
      if (!W) size();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      if (!data || !(hasGps(data.work) || hasGps(data.second))) return;
      const P = projector();
      const S = data.work;
      if (data.second && hasGps(data.second)) line(data.second, P, 0, data.second.n - 1, css('--second', '#a371f7'), 3, [4, 4]);
      if (hasGps(S)) {
        line(S, P, 0, S.n - 1, css('--base', '#3987e5'), 2);
        if (sel) line(S, P, idx(S, sel.a), idx(S, sel.b), css('--accent', '#58a6ff'), 4.5);
        const dot = (i, c) => {
          for (let k = i; k >= 0 && k < S.n; k += i === 0 ? 1 : -1) {
            if (S.lat[k] === S.lat[k]) { const [x, y] = P(S.lat[k], S.lon[k]); ctx.fillStyle = c; ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill(); return; }
          }
        };
        dot(0, css('--st-good', '#0ca30c'));
        dot(S.n - 1, css('--st-critical', '#d03b3b'));
        if (cursor !== null) {
          const i = idx(S, cursor);
          if (S.lat[i] === S.lat[i] && Math.abs(S.t[i] - cursor) < 30) {
            const [x, y] = P(S.lat[i], S.lon[i]);
            ctx.strokeStyle = css('--text', '#e6edf3'); ctx.lineWidth = 2;
            ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.stroke();
          }
        }
      }
    }

    return {
      setData(d) { data = d; draw(); },
      setSelection(s) { sel = s; draw(); },
      setCursor(t) { cursor = t; draw(); },
      resize() { size(); draw(); },
      hasTrack() { return !!data && (hasGps(data.work) || hasGps(data.second)); },
      secondHasTrack() { return !!data && hasGps(data.second); },
    };
  }

  return { create };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TrackMap;
