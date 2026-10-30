'use strict';

/**
 * Timeline.js — the ride as stacked channel lanes on one time axis.
 *
 * The working file is drawn in each channel's colour; the second file, when
 * there is one, is drawn over it in the second file's colour, shifted by the
 * clock offset, so lining the two up is a matter of watching the traces
 * agree. Drag to select a stretch (the edges can be dragged afterwards);
 * wheel to zoom, shift+wheel to pan, double-click for the whole ride.
 *
 *   const tl = Timeline.create(canvas, { onSelect(sel), onHover(t) })
 *   tl.setData({ work, second, offset, pauses, laps, units })
 *   tl.setSelection({ a, b } | null)
 */
const Timeline = (() => {

  const LANES = [
    { key: 'power', label: 'Power', unit: 'W', color: '--series-2', fmt: v => Math.round(v) },
    { key: 'hr', label: 'Heart rate', unit: 'bpm', color: '--series-5', fmt: v => Math.round(v) },
    { key: 'cad', label: 'Cadence', unit: 'rpm', color: '--series-3', fmt: v => Math.round(v) },
    { key: 'speed', label: 'Speed', unit: 'km/h', color: '--series-4', k: 3.6, fmt: v => v.toFixed(1) },
    { key: 'alt', label: 'Altitude', unit: 'm', color: '--text-muted', fmt: v => Math.round(v) },
  ];
  const GUTTER = 64, AXIS = 20, TOP = 30, GAP_BREAK = 10;

  function css(name, fallback) {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    } catch (_) { return fallback; }
  }

  function hms(sec, withHours) {
    const s = Math.round(Math.abs(sec)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    const mm = String(m).padStart(h || withHours ? 2 : 1, '0'), ss = String(x).padStart(2, '0');
    return (sec < 0 ? '−' : '') + (h || withHours ? h + ':' + mm : mm) + ':' + ss;
  }

  function bsearch(t, x) {
    let lo = 0, hi = t.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (t[mid] <= x) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans;
  }

  /** Robust range: ignores the top and bottom 0.2% so one spike doesn't flatten the trace. */
  function extent(arrs, key) {
    const vals = [];
    for (const a of arrs) if (a) for (let i = 0; i < a.length; i += Math.max(1, Math.floor(a.length / 4000))) if (a[i] === a[i]) vals.push(a[i]);
    if (!vals.length) return null;
    vals.sort((x, y) => x - y);
    let lo = vals[Math.floor(vals.length * 0.002)], hi = vals[Math.ceil(vals.length * 0.998) - 1];
    if (key === 'power' || key === 'speed' || key === 'cad') lo = 0;
    if (hi - lo < 1e-6) hi = lo + 1;
    const pad = (hi - lo) * 0.08;
    return [key === 'alt' || key === 'hr' ? lo - pad : lo, hi + pad];
  }

  function create(canvas, { onSelect = () => {}, onHover = () => {} } = {}) {
    const ctx = canvas.getContext('2d');
    let data = null, lanes = [], view = null, full = null;
    let sel = null, hoverX = null, drag = null;
    let W = 0, H = 0, dpr = 1;

    function size() {
      const r = canvas.getBoundingClientRect();
      dpr = window.devicePixelRatio || 1;
      W = Math.max(1, Math.round(r.width)); H = Math.max(1, Math.round(r.height));
      canvas.width = W * dpr; canvas.height = H * dpr;
    }

    const gx = () => GUTTER, gw = () => Math.max(1, W - GUTTER - 10);
    const xOf = t => gx() + (t - view[0]) / (view[1] - view[0]) * gw();
    const tOf = x => view[0] + (x - gx()) / gw() * (view[1] - view[0]);

    function setData(d) {
      const keepView = data && view && full && d && d.work && data.work && d.work.t[0] === data.work.t[0];
      data = d;
      if (!d || !d.work || !d.work.n) { lanes = []; view = full = null; draw(); return; }
      const S = d.second;
      lanes = LANES.filter(L => d.work[L.key].some(v => v === v) || (S && S[L.key].some(v => v === v)))
        .map(L => ({ ...L, range: extent([d.work[L.key], S && S[L.key]], L.key) }));
      const w = d.work;
      let a = w.t[0], b = w.t[w.n - 1];
      if (S && S.n) { a = Math.min(a, S.t[0] + d.offset); b = Math.max(b, S.t[S.n - 1] + d.offset); }
      full = [a, Math.max(b, a + 10)];
      if (!keepView) view = full.slice();
      else view = [Math.max(full[0], view[0]), Math.min(full[1], view[1])];
      if (view[1] - view[0] < 10) view = full.slice();
      draw();
    }

    function laneBox(k) {
      const h = (H - TOP - AXIS) / Math.max(1, lanes.length);
      return { y: TOP + k * h, h };
    }

    function trace(S, key, shift, lane, box, color, width, alpha) {
      const arr = S[key], t = S.t;
      const [lo, hi] = lane.range;
      const yOf = v => box.y + box.h - 3 - ((v - lo) / (hi - lo)) * (box.h - 6);
      const from = Math.max(0, bsearch(t, view[0] - shift) - 1), to = Math.min(S.n - 1, bsearch(t, view[1] - shift) + 1);
      ctx.save();
      ctx.beginPath();
      ctx.rect(gx(), box.y, gw(), box.h);
      ctx.clip();
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.globalAlpha = alpha;
      ctx.beginPath();
      let px = null, mn = 0, mx = 0, lastT = null, open = false;
      const flush = () => {
        if (px === null) return;
        if (!open) { ctx.moveTo(px, yOf(mx)); open = true; } else ctx.lineTo(px, yOf(mx));
        if (mn !== mx) ctx.lineTo(px, yOf(mn));
      };
      for (let i = from; i <= to; i++) {
        const v = arr[i];
        if (v !== v) continue;
        const tt = t[i] + shift;
        if (lastT !== null && tt - lastT > GAP_BREAK) { flush(); px = null; open = false; }
        lastT = tt;
        const x = Math.round(xOf(tt));
        if (x === px) { if (v < mn) mn = v; if (v > mx) mx = v; continue; }
        flush();
        px = x; mn = mx = v;
      }
      flush();
      ctx.stroke();
      ctx.restore();
    }

    function niceStep(span) {
      const steps = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400];
      for (const s of steps) if (span / s <= 9) return s;
      return 28800;
    }

    function draw() {
      if (!W || !H) size();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      if (!data || !data.work || !view) return;
      const grid = css('--grid', '#2c313a'), muted = css('--text-muted', '#8b949e'), text = css('--text', '#e6edf3');
      const accent = css('--accent', '#58a6ff'), secondC = css('--second', '#a371f7');
      const t0 = data.work.t[0];
      ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      ctx.textBaseline = 'middle';

      // Pauses: shaded right through every lane.
      ctx.fillStyle = 'rgba(139,148,158,0.13)';
      for (const [a, b] of data.pauses || []) {
        const xa = Math.max(gx(), xOf(a)), xb = Math.min(gx() + gw(), xOf(b));
        if (xb > xa) ctx.fillRect(xa, TOP, xb - xa, H - TOP - AXIS);
      }

      // Time grid and axis, in elapsed time from the start of the working file.
      const step = niceStep(view[1] - view[0]);
      ctx.strokeStyle = grid; ctx.lineWidth = 1; ctx.fillStyle = muted; ctx.textAlign = 'center';
      const firstTick = Math.ceil((view[0] - t0) / step) * step;
      for (let e = firstTick; t0 + e <= view[1]; e += step) {
        const x = Math.round(xOf(t0 + e)) + 0.5;
        ctx.beginPath(); ctx.moveTo(x, TOP); ctx.lineTo(x, H - AXIS); ctx.stroke();
        ctx.fillText(hms(e), x, H - AXIS / 2);
      }

      // Lanes.
      lanes.forEach((L, k) => {
        const box = laneBox(k);
        ctx.strokeStyle = grid;
        ctx.beginPath(); ctx.moveTo(gx(), Math.round(box.y + box.h) + 0.5); ctx.lineTo(gx() + gw(), Math.round(box.y + box.h) + 0.5); ctx.stroke();
        const col = css(L.color, '#888');
        const lane = { range: L.range };
        if (data.second) trace(data.second, L.key, data.offset, lane, box, secondC, 1.2, 0.75);
        trace(data.work, L.key, 0, lane, box, col, 1.3, 1);
        ctx.textAlign = 'left'; ctx.fillStyle = col;
        ctx.fillText(L.label, 6, box.y + 10);
        ctx.fillStyle = muted;
        const k2 = L.k || 1;
        ctx.fillText(L.fmt(L.range[1] * k2) + ' ' + L.unit, 6, box.y + 24);
      });

      // Laps.
      ctx.setLineDash([3, 3]); ctx.strokeStyle = muted; ctx.fillStyle = muted; ctx.textAlign = 'left';
      (data.laps || []).forEach((t, i) => {
        if (i === 0 || t < view[0] || t > view[1]) return;
        const x = Math.round(xOf(t)) + 0.5;
        ctx.beginPath(); ctx.moveTo(x, TOP - 4); ctx.lineTo(x, H - AXIS); ctx.stroke();
        ctx.fillText('Lap ' + (i + 1), x + 3, TOP - 7);
      });
      ctx.setLineDash([]);

      // Selection.
      if (sel) {
        const xa = Math.max(gx(), xOf(sel.a)), xb = Math.min(gx() + gw(), xOf(sel.b));
        if (xb >= xa) {
          ctx.fillStyle = 'rgba(88,166,255,0.15)';
          ctx.fillRect(xa, TOP, xb - xa, H - TOP - AXIS);
          ctx.strokeStyle = accent; ctx.lineWidth = 1.5;
          for (const x of [xOf(sel.a), xOf(sel.b)]) {
            if (x < gx() - 1 || x > gx() + gw() + 1) continue;
            ctx.beginPath(); ctx.moveTo(x, TOP); ctx.lineTo(x, H - AXIS); ctx.stroke();
            ctx.fillStyle = accent; ctx.fillRect(x - 3, TOP, 6, 12);
          }
        }
      }

      // Legend.
      ctx.textAlign = 'right'; ctx.fillStyle = muted;
      let lx = W - 10;
      if (data.second) {
        const label = 'Second file' + (data.offset ? ' (' + (data.offset > 0 ? '+' : '−') + Math.abs(data.offset) + ' s)' : '');
        ctx.fillText(label, lx, 9); lx -= ctx.measureText(label).width + 6;
        ctx.fillStyle = secondC; ctx.fillRect(lx - 12, 8, 12, 2); lx -= 22;
        ctx.fillStyle = muted; ctx.fillText('Working file', lx, 9); lx -= ctx.measureText('Working file').width + 6;
        ctx.fillStyle = text; ctx.fillRect(lx - 12, 8, 12, 2);
      }

      // Hover readout.
      if (hoverX !== null && hoverX >= gx() && hoverX <= gx() + gw()) {
        const t = tOf(hoverX);
        ctx.strokeStyle = 'rgba(230,237,243,0.5)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(Math.round(hoverX) + 0.5, TOP); ctx.lineTo(Math.round(hoverX) + 0.5, H - AXIS); ctx.stroke();
        const rows = [hms(t - t0, true) + '  ·  ' + clock(t)];
        for (const L of lanes) {
          const v = at(data.work, L.key, t, 0), w = data.second ? at(data.second, L.key, t, data.offset) : NaN;
          if (v !== v && w !== w) continue;
          const k2 = L.k || 1;
          rows.push(L.label + '  ' + (v === v ? L.fmt(v * k2) : '–') + (data.second ? ' / ' + (w === w ? L.fmt(w * k2) : '–') : '') + ' ' + L.unit);
        }
        ctx.font = '11.5px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        const bw = Math.max(...rows.map(r => ctx.measureText(r).width)) + 16, bh = rows.length * 16 + 8;
        let bx = hoverX + 12; if (bx + bw > W - 4) bx = hoverX - 12 - bw;
        ctx.fillStyle = 'rgba(22,27,34,0.94)'; ctx.strokeStyle = css('--border', '#30363d');
        ctx.fillRect(bx, TOP + 4, bw, bh); ctx.strokeRect(bx + 0.5, TOP + 4.5, bw - 1, bh - 1);
        ctx.textAlign = 'left';
        rows.forEach((r, i) => { ctx.fillStyle = i ? text : muted; ctx.fillText(r, bx + 8, TOP + 16 + i * 16); });
      }
    }

    function clock(t) {
      const d = new Date((t + 631065600) * 1000);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    function at(S, key, t, shift) {
      const i = bsearch(S.t, t - shift);
      let best = NaN, bd = 3;
      for (const j of [i, i + 1]) {
        if (j < 0 || j >= S.n) continue;
        const d = Math.abs(S.t[j] + shift - t);
        if (d <= bd && S[key][j] === S[key][j]) { best = S[key][j]; bd = d; }
      }
      return best;
    }

    // ── Interaction ────────────────────────────────────────────────────────

    const snap = t => Math.round(Math.max(full[0], Math.min(full[1], t)));
    function emit() { onSelect(sel ? { a: sel.a, b: sel.b } : null); }

    function localX(e) { const r = canvas.getBoundingClientRect(); return e.clientX - r.left; }

    canvas.addEventListener('pointerdown', e => {
      if (!view) return;
      const x = localX(e);
      if (x < gx() - 4) return;
      if (canvas.setPointerCapture && e.pointerId !== undefined) { try { canvas.setPointerCapture(e.pointerId); } catch (_) {} }
      if (sel && Math.abs(x - xOf(sel.a)) <= 6) drag = { kind: 'edge', which: 'a', x0: x };
      else if (sel && Math.abs(x - xOf(sel.b)) <= 6) drag = { kind: 'edge', which: 'b', x0: x };
      else drag = { kind: 'new', anchor: snap(tOf(x)), x0: x, moved: false };
      e.preventDefault();
    });

    canvas.addEventListener('pointermove', e => {
      if (!view) return;
      const x = localX(e);
      hoverX = x;
      if (drag) {
        const t = snap(tOf(x));
        if (drag.kind === 'new') {
          if (Math.abs(x - drag.x0) > 3) drag.moved = true;
          if (drag.moved) sel = { a: Math.min(drag.anchor, t), b: Math.max(drag.anchor, t) };
        } else {
          const other = drag.which === 'a' ? sel.b : sel.a;
          sel = { a: Math.min(other, t), b: Math.max(other, t) };
          drag.which = t <= other ? 'a' : 'b';
        }
        if (sel) emit();
      } else {
        canvas.style.cursor = sel && (Math.abs(x - xOf(sel.a)) <= 6 || Math.abs(x - xOf(sel.b)) <= 6) ? 'ew-resize' : 'crosshair';
      }
      onHover(x >= gx() ? tOf(x) : null);
      draw();
    });

    function end() {
      if (drag && drag.kind === 'new' && !drag.moved) { sel = null; emit(); }
      if (sel && sel.b - sel.a < 1) { sel = null; emit(); }
      drag = null;
      draw();
    }
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('pointerleave', () => { if (!drag) { hoverX = null; onHover(null); draw(); } });

    canvas.addEventListener('wheel', e => {
      if (!view) return;
      e.preventDefault();
      const span = view[1] - view[0];
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const d = (e.shiftKey ? e.deltaY : e.deltaX) / gw() * span;
        setView(view[0] + d, view[1] + d);
        return;
      }
      const t = tOf(localX(e));
      const f = e.deltaY > 0 ? 1.25 : 0.8;
      setView(t - (t - view[0]) * f, t + (view[1] - t) * f);
    }, { passive: false });

    canvas.addEventListener('dblclick', () => resetView());

    function setView(a, b) {
      if (!full) return;
      const span = Math.max(30, Math.min(full[1] - full[0], b - a));
      if (a < full[0]) a = full[0];
      if (a + span > full[1]) a = full[1] - span;
      view = [a, a + span];
      draw();
    }
    function resetView() { if (full) { view = full.slice(); draw(); } }

    return {
      setData, draw, resetView, setView,
      resize() { size(); draw(); },
      setSelection(s) { sel = s ? { a: s.a, b: s.b } : null; draw(); },
      selection() { return sel ? { a: sel.a, b: sel.b } : null; },
      view() { return view ? view.slice() : null; },
      lanes() { return lanes.map(l => l.key); },
    };
  }

  return { create, hms, LANES };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Timeline;
