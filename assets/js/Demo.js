'use strict';

/**
 * Demo.js — two sample recordings of the same ride, written as real FIT
 * bytes so they go through exactly the path a dropped file does.
 *
 *   base:   a head unit — GPS, heart rate, altitude, speed, distance, two
 *           laps — with auto-pause off, so the café stop from 25:00 to
 *           31:00 is six minutes of standing still.
 *   second: a phone app logging the power meter — power and cadence only,
 *           its clock 4 s behind, started 20 s late, stopped a minute
 *           early, and with a 40 s Bluetooth dropout at 10:00.
 *
 * Lining up, merging, and pausing the café stop are the three things to try.
 */
const Demo = (() => {
  const F = FitFile, T = F.T;
  const T0 = 1161360000;          // 2026-10-19 08:00:00 UTC, in FIT seconds
  const N = 3000, CAFE = [1500, 1860], LAG = 4;
  const SEMI = 2147483648 / 180;

  function M(g, fields) {
    const m = { g, f: {}, d: null, at: null };
    for (const n in fields) {
      const [b, v] = fields[n];
      m.f[n] = { b, s: typeof v === 'string' ? v.length + 1 : F.base(b).size, v };
    }
    return m;
  }

  // Deterministic noise, so the sample is the same every time.
  function rng(seed) { let s = seed >>> 0; return () => ((s = Math.imul(s ^ (s >>> 15), 0x2C1B3C6D) + 0x9E3779B9 >>> 0) / 4294967296); }

  function ride() {
    const r = rng(7);
    const pts = [];
    let d = 0, ang = 0;
    for (let i = 0; i < N; i++) {
      const stopped = i >= CAFE[0] && i < CAFE[1];
      const grade = 0.04 * Math.sin(i / 260) + 0.015 * Math.sin(i / 71);
      const watts = stopped ? 0 : Math.max(0, Math.round(195 + 260 * grade * 10 + 35 * (r() - 0.5) + (i % 420 < 40 ? 180 : 0)));
      const v = stopped ? 0 : Math.max(2.5, 8.6 - grade * 70 + 0.4 * (r() - 0.5));
      d += v;
      ang += v / 3300;
      const lat = 42.37 + 0.026 * Math.sin(ang) + 0.002 * Math.sin(ang * 7);
      const lon = -71.15 + 0.036 * Math.cos(ang) + 0.002 * Math.cos(ang * 5);
      pts.push({
        t: T0 + i, lat, lon, v, d, watts, stopped,
        alt: 40 + 180 * (0.5 + 0.5 * Math.sin(i / 600)) + 30 * Math.sin(i / 130),
        hr: Math.round(stopped ? 95 + 30 * Math.exp(-(i - CAFE[0]) / 60) : 128 + watts / 9 + 4 * (r() - 0.5)),
        cad: stopped ? 0 : Math.round(84 + 10 * (r() - 0.5) - grade * 120),
      });
    }
    return pts;
  }

  function timer(t, type) { return M(21, { 253: [T.uint32, t], 0: [T.enum, 0], 1: [T.enum, type], 4: [T.uint8, 0] }); }

  function base() {
    const pts = ride();
    const msgs = [
      M(0, { 0: [T.enum, 4], 1: [T.uint16, 1], 2: [T.uint16, 3843], 3: [T.uint32z, 3900123456], 4: [T.uint32, T0] }),
      M(23, { 253: [T.uint32, T0], 0: [T.uint8, 0], 2: [T.uint16, 1], 4: [T.uint16, 3843], 5: [T.uint16, 2119], 27: [T.string, 'Edge 840'] }),
      M(12, { 0: [T.enum, 2], 1: [T.enum, 7], 3: [T.string, 'Road'] }),
      timer(T0, 0),
    ];
    const lapAt = 1500;
    for (const p of pts) {
      msgs.push(M(20, {
        253: [T.uint32, p.t], 0: [T.sint32, Math.round(p.lat * SEMI)], 1: [T.sint32, Math.round(p.lon * SEMI)],
        5: [T.uint32, Math.round(p.d * 100)], 73: [T.uint32, Math.round(p.v * 1000)], 78: [T.uint32, Math.round((p.alt + 500) * 5)],
        3: [T.uint8, p.hr], 13: [T.sint8, 14],
      }));
      if (p.t === T0 + lapAt) msgs.push(M(19, { 253: [T.uint32, p.t], 2: [T.uint32, T0], 0: [T.enum, 9], 1: [T.enum, 1], 7: [T.uint32, lapAt * 1000], 8: [T.uint32, lapAt * 1000], 254: [T.uint16, 0] }));
    }
    const end = T0 + N - 1;
    msgs.push(timer(end, 4));
    msgs.push(M(19, { 253: [T.uint32, end], 2: [T.uint32, T0 + lapAt], 0: [T.enum, 9], 1: [T.enum, 1], 7: [T.uint32, 0], 8: [T.uint32, 0], 254: [T.uint16, 1] }));
    msgs.push(M(18, { 253: [T.uint32, end], 2: [T.uint32, T0], 0: [T.enum, 8], 1: [T.enum, 1], 5: [T.enum, 2], 6: [T.enum, 7], 7: [T.uint32, 0], 8: [T.uint32, 0], 254: [T.uint16, 0] }));
    msgs.push(M(34, { 253: [T.uint32, end], 0: [T.uint32, 0], 1: [T.uint16, 1], 2: [T.enum, 0], 3: [T.enum, 26], 4: [T.enum, 1], 5: [T.uint32, end - 4 * 3600] }));
    // Run it through finalize so the summaries are real numbers, as a head unit's would be.
    const file = FitEdit.finalize(FitEdit.prepare({ protocol: 0x20, profile: 2132, messages: msgs }), { dirty: true });
    return F.encode(file);
  }

  function second() {
    const pts = ride();
    const msgs = [
      M(0, { 0: [T.enum, 4], 1: [T.uint16, 255], 2: [T.uint16, 1], 4: [T.uint32, T0 + 20 - LAG], 8: [T.string, 'Phone app'] }),
    ];
    const first = 20, last = N - 61;
    msgs.push(timer(T0 + first - LAG, 0));
    for (const p of pts) {
      const i = p.t - T0;
      if (i < first || i > last) continue;
      if (i >= 600 && i < 640) continue;         // Bluetooth dropout
      msgs.push(M(20, { 253: [T.uint32, p.t - LAG], 7: [T.uint16, p.watts], 4: [T.uint8, p.cad] }));
    }
    msgs.push(timer(T0 + last - LAG, 4));
    const file = FitEdit.finalize(FitEdit.prepare({ protocol: 0x10, profile: 2132, messages: msgs }), { dirty: true });
    return F.encode(file);
  }

  return { base, second, T0, CAFE, LAG };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Demo;
