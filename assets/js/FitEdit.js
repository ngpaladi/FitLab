'use strict';

/**
 * FitEdit.js — the operations: merge, crop, cut, pause, splice, shift,
 * strip, clean, sport; and the summary recomputation every one of them ends in.
 *
 * Every operation takes a decoded file (FitFile's shape) and returns a new
 * one. Nothing is mutated: a message that changes is cloned first, so undo is
 * just keeping the old file object.
 *
 * Messages fall into three kinds, and each operation treats them by kind:
 *
 *   KEEP     definitions and identity (file_id, device_info, developer
 *            fields, sport, zones, user profile). Never cut.
 *   SUMMARY  lap, session, activity. Never edited directly: rebuilt from the
 *            records they cover by `finalize`, so the totals can never
 *            disagree with the samples.
 *   timed    everything else: records, events, hrv, Garmin-private stream
 *            messages. Kept, moved or dropped by the time they belong to.
 *
 * Laps and sessions are tied to their records by identity, not by time:
 * `prepare` gives each lap and session an id and stamps every record with
 * the ids it falls in. After a cut or a splice the lap is whatever records
 * still carry its id, so laps survive any retiming.
 *
 * Timestamps everywhere are raw FIT seconds (since 1989-12-31 UTC).
 */
const FitEdit = (() => {
  const F = FitFile;
  const T = F.T;

  const REC = 20, LAP = 19, SES = 18, ACT = 34, EVT = 21, DEVID = 207, FDESC = 206, TIZ = 216;
  const SUMMARY = new Set([SES, LAP, ACT]);
  const KEEP = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 23, 26, 27, 49, 206, 207]);
  const TIMER = 0, START = 0, STOP_ALL = 4;
  const STOPS = new Set([1, 4, 8, 9]);

  let uidN = 0;
  const uid = p => p + (++uidN);

  /** Clone a message, carrying FitLab's own tags along. */
  function cl(m) {
    const c = F.clone(m);
    if (m.lap) c.lap = m.lap;
    if (m.ses) c.ses = m.ses;
    if (m.id) c.id = m.id;
    return c;
  }
  const ts = m => F.get(m, 253);
  const isRec = m => m.g === REC && ts(m) !== null;
  function records(file) { return file.messages.filter(isRec); }

  // ── Channels ──────────────────────────────────────────────────────────────

  /**
   * What can be carried from one file to another. `alias` groups are the same
   * quantity in two fields (altitude / enhanced altitude share a scale), so
   * the donor's value is written into whichever of them the base file uses.
   */
  const CHANNELS = [
    { key: 'power', label: 'Power', nums: [7] },
    { key: 'hr', label: 'Heart rate', nums: [3] },
    { key: 'cad', label: 'Cadence', nums: [4, 53] },
    { key: 'speed', label: 'Speed', nums: [73, 6], alias: true },
    { key: 'alt', label: 'Altitude', nums: [78, 2], alias: true },
    { key: 'pos', label: 'GPS position', nums: [0, 1] },
    { key: 'dist', label: 'Distance', nums: [5] },
    { key: 'temp', label: 'Temperature', nums: [13] },
    { key: 'balance', label: 'Left/right balance', nums: [30] },
    { key: 'pedal', label: 'Pedalling dynamics', nums: [43, 44, 45, 46, 47, 67, 68, 69, 70, 71, 72] },
    { key: 'resp', label: 'Respiration rate', nums: [108, 99], alias: false },
    { key: 'core', label: 'Core temperature', nums: [139] },
  ];
  // Accumulators and compressed forms: meaningless once copied into another
  // file's timeline, and readers prefer them over the plain fields.
  const NEVER_COPY = new Set([8, 18, 19, 28, 29, 48, 62, 253]);
  const DEFAULT_TYPE = { 0: T.sint32, 1: T.sint32, 2: T.uint16, 3: T.uint8, 4: T.uint8, 5: T.uint32, 6: T.uint16, 7: T.uint16, 13: T.sint8, 73: T.uint32, 78: T.uint32 };

  /** Developer field names, by "idx:num". */
  function devNames(file) {
    const out = {};
    for (const m of file.messages) if (m.g === FDESC) {
      const i = F.get(m, 0), n = F.get(m, 1);
      if (i === null || n === null) continue;
      const name = m.f[3] && typeof m.f[3].v === 'string' ? m.f[3].v : '';
      const units = m.f[8] && typeof m.f[8].v === 'string' ? m.f[8].v : '';
      out[i + ':' + n] = { name: name || 'Developer field ' + n, units };
    }
    return out;
  }

  /** Channels present in a file's records, with how many records carry each. */
  function channels(file) {
    const counts = {}, devCounts = {};
    for (const m of file.messages) {
      if (!isRec(m)) continue;
      for (const k in m.f) if (!F.isInvalid(m.f[k])) counts[k] = (counts[k] || 0) + 1;
      if (m.d) for (const k in m.d) if (!F.isInvalid(m.d[k])) devCounts[k] = (devCounts[k] || 0) + 1;
    }
    const out = [], used = new Set(NEVER_COPY);
    for (const c of CHANNELS) {
      for (const n of c.nums) used.add(n);
      const count = Math.max(...c.nums.map(n => counts[n] || 0));
      if (count) out.push({ key: c.key, label: c.label, nums: c.nums, alias: !!c.alias, count });
    }
    for (const k of Object.keys(counts).map(Number).sort((a, b) => a - b)) {
      if (used.has(k)) continue;
      out.push({ key: 'f' + k, label: F.recordFieldName(k), nums: [k], count: counts[k] });
    }
    const names = devNames(file);
    for (const k of Object.keys(devCounts)) {
      const nm = names[k];
      out.push({ key: 'dev:' + k, label: (nm ? nm.name : 'Developer field ' + k) + (nm && nm.units ? ' (' + nm.units + ')' : ''), dev: k, count: devCounts[k] });
    }
    return out;
  }

  // ── Series, for drawing and statistics ────────────────────────────────────

  /** Plain arrays in physical units, NaN where a record has no value. */
  function series(file) {
    const rs = records(file);
    const n = rs.length;
    const mk = () => new Float64Array(n).fill(NaN);
    const s = { n, t: new Float64Array(n), power: mk(), hr: mk(), cad: mk(), speed: mk(), alt: mk(), dist: mk(), lat: mk(), lon: mk(), temp: mk() };
    for (let i = 0; i < n; i++) {
      const m = rs[i];
      s.t[i] = ts(m);
      const v = k => F.get(m, k);
      let x;
      if ((x = v(7)) !== null) s.power[i] = x;
      if ((x = v(3)) !== null) s.hr[i] = x;
      if ((x = v(4)) !== null) s.cad[i] = x;
      if ((x = v(73)) !== null || (x = v(6)) !== null) s.speed[i] = x / 1000;
      if ((x = v(78)) !== null || (x = v(2)) !== null) s.alt[i] = x / 5 - 500;
      if ((x = v(5)) !== null) s.dist[i] = x / 100;
      if ((x = v(13)) !== null) s.temp[i] = x;
      const la = v(0), lo = v(1);
      if (la !== null && lo !== null && (la !== 0 || lo !== 0)) { s.lat[i] = la * F.SEMI; s.lon[i] = lo * F.SEMI; }
    }
    return s;
  }

  /** Timer pauses as [[stopTs, startTs]], from the timer events. */
  function pauses(file) {
    const ev = file.messages.filter(m => m.g === EVT && F.get(m, 0) === TIMER && ts(m) !== null)
      .map(m => ({ t: ts(m), type: F.get(m, 1) })).sort((a, b) => a.t - b.t);
    const out = [];
    let stoppedAt = null;
    for (const e of ev) {
      if (STOPS.has(e.type)) { if (stoppedAt === null) stoppedAt = e.t; }
      else if (e.type === START && stoppedAt !== null) { if (e.t > stoppedAt) out.push([stoppedAt, e.t]); stoppedAt = null; }
    }
    return out;
  }

  function pausedWithin(ps, a, b) {
    let s = 0;
    for (const [p, q] of ps) s += Math.max(0, Math.min(b, q) - Math.max(a, p));
    return s;
  }

  // ── Preparation ───────────────────────────────────────────────────────────

  function summaryMsg(g, t0, t1) {
    const m = { g, f: {}, d: null, at: t1 };
    F.put(m, 253, t1, T.uint32);
    if (g === ACT) {
      F.put(m, 0, (t1 - t0) * 1000, T.uint32);
      F.put(m, 1, 1, T.uint16);
      F.put(m, 2, 0, T.enum);
      F.put(m, 3, 26, T.enum);
      F.put(m, 4, 1, T.enum);
      return m;
    }
    F.put(m, 0, g === SES ? 8 : 9, T.enum);
    F.put(m, 1, 1, T.enum);
    F.put(m, 2, t0, T.uint32);
    F.put(m, 7, 0, T.uint32);
    F.put(m, 8, 0, T.uint32);
    if (g === SES) { F.put(m, 5, 2, T.enum); F.put(m, 6, 0, T.enum); }
    return m;
  }

  /**
   * Tag laps, sessions and records so they stay attached through any edit,
   * and add a lap, session and activity if the file has none (some exports
   * omit them, and Garmin Connect refuses a file without a session).
   */
  function prepare(file) {
    let msgs = file.messages.map(m => (SUMMARY.has(m.g) || m.g === REC ? cl(m) : m));
    const recs = msgs.filter(isRec);
    if (!recs.length) throw new Error('This FIT file has no samples (no record messages with a time).');
    const t0 = ts(recs[0]), t1 = ts(recs[recs.length - 1]);

    let made = false;
    for (const g of [LAP, SES, ACT]) if (!msgs.some(m => m.g === g)) { msgs.push(summaryMsg(g, t0, t1)); made = true; }

    for (const g of [LAP, SES]) {
      const list = msgs.filter(m => m.g === g);
      const spans = list.map((m, k) => {
        m.id = uid(g === LAP ? 'L' : 'S');
        const end = ts(m) !== null ? ts(m) : t1;
        const st = F.get(m, 2);
        return { id: m.id, start: st !== null ? st : (k ? null : t0), end };
      });
      for (let k = 0; k < spans.length; k++) if (spans[k].start === null) spans[k].start = spans[k - 1].end;
      const order = spans.slice().sort((a, b) => a.start - b.start);
      for (const r of recs) {
        const t = ts(r);
        let pick = order[0];
        for (const s of order) if (s.start <= t) pick = s;
        r[g === LAP ? 'lap' : 'ses'] = pick.id;
      }
    }
    // An untouched file goes out exactly as it came in; only a file that was
    // missing its summaries needs them computed now.
    return made ? finalize({ ...file, messages: msgs }, { dirty: false }) : { ...file, messages: msgs };
  }

  // ── Retiming ──────────────────────────────────────────────────────────────

  /**
   * Move or drop every timed message. `map(t)` returns the new time or null
   * to drop; `dist(t, raw)` optionally rewrites a record's raw distance.
   */
  function retime(file, map, dist) {
    const out = [];
    for (const m of file.messages) {
      if (SUMMARY.has(m.g)) { out.push(m); continue; }
      if (m.at === null || m.at === undefined) { out.push(m); continue; }
      const nt = map(m.at);
      if (KEEP.has(m.g)) {
        if (nt !== null && nt !== m.at && ts(m) !== null) { const c = cl(m); F.put(c, 253, nt); c.at = nt; out.push(c); }
        else out.push(m);
        continue;
      }
      if (nt === null) continue;
      const d = dist && m.g === REC ? F.get(m, 5) : null;
      if (nt === m.at && d === null) { out.push(m); continue; }
      const c = cl(m);
      c.at = nt;
      if (ts(m) !== null) F.put(c, 253, nt);
      if (d !== null) F.put(c, 5, dist(m.at, d));
      out.push(c);
    }
    return { ...file, messages: out };
  }

  /** Raw distance at (or just before) time t, from the records. */
  function rawDistAt(file, t) {
    let best = null;
    for (const m of file.messages) {
      if (!isRec(m)) continue;
      if (ts(m) > t) break;
      const d = F.get(m, 5);
      if (d !== null) best = d;
    }
    return best;
  }

  function timerEvent(template, t, type) {
    const m = template ? cl(template) : { g: EVT, f: {}, d: null, at: t };
    if (!template) { F.put(m, 0, TIMER, T.enum); F.put(m, 4, 0, T.uint8); }
    F.put(m, 253, t, T.uint32);
    F.put(m, 1, type, T.enum);
    m.at = t;
    return m;
  }

  /**
   * Make the timer events consistent with the records: a start at the first
   * sample, a stop at the last, alternating in between. Extra pauses can be
   * passed in as [a, b] to stop at a and start again at b.
   */
  function fixTimer(file, extraPauses = []) {
    const recs = records(file);
    const t0 = ts(recs[0]), t1 = ts(recs[recs.length - 1]);
    const isTimer = m => m.g === EVT && F.get(m, 0) === TIMER && ts(m) !== null;
    const template = file.messages.find(isTimer) || null;

    const want = [];
    for (const m of file.messages) if (isTimer(m)) want.push({ t: ts(m), start: F.get(m, 1) === START, m });
    for (const [a, b] of extraPauses) {
      if (b <= t0 || a >= t1) continue;
      want.push({ t: Math.max(a, t0), start: false });
      want.push({ t: Math.min(b, t1), start: true });
    }
    // At equal times a stop sorts before a start, so a pause at the very
    // start of an inserted pause is not swallowed.
    want.sort((x, y) => x.t - y.t || (x.start === y.start ? 0 : x.start ? 1 : -1));

    const ev = [{ t: t0, start: true }];
    let running = true;
    for (const e of want) {
      if (e.t <= t0 && e.start) continue;
      if (e.t < t0 || e.t > t1) continue;
      if (e.start === running) continue;
      // A stop at t0 or a start at t1 would make a zero-length ride.
      if (!e.start && e.t === t0) continue;
      if (e.start && e.t === t1) continue;
      ev.push(e); running = e.start;
    }
    if (running) ev.push({ t: t1, start: false });
    // Collapse zero-length pauses.
    const clean = [];
    for (const e of ev) {
      const last = clean[clean.length - 1];
      if (last && e.start && !last.start && last.t === e.t && clean.length > 1) { clean.pop(); continue; }
      clean.push(e);
    }

    const msgs = clean.map(e => (e.m && e.m.at === e.t && (F.get(e.m, 1) === START) === e.start
      ? e.m : timerEvent(template, e.t, e.start ? START : STOP_ALL)));

    // Re-thread them into the stream: before the first timed message that is
    // later (or, for a start, at the same second); stops after same-second records.
    const out = [];
    let k = 0;
    for (const m of file.messages) {
      if (isTimer(m)) continue;
      if (m.at !== null && m.at !== undefined && !KEEP.has(m.g)) {
        const summary = SUMMARY.has(m.g);
        while (k < msgs.length) {
          const e = msgs[k], et = e.at, isStart = F.get(e, 1) === START;
          if (et < m.at || (et === m.at && (isStart || summary))) { out.push(e); k++; } else break;
        }
      }
      out.push(m);
    }
    while (k < msgs.length) out.push(msgs[k++]);
    return { ...file, messages: out };
  }

  // ── Statistics and summaries ──────────────────────────────────────────────

  function stats(recs, start, end, rawD0, ps, wantAscent) {
    const s = { start, end, elapsed: end - start };
    s.timer = Math.max(0, s.elapsed - pausedWithin(ps, start, end));
    const n = recs.length;
    let dLast = null, la0 = null, lo0 = null, la1 = null, lo1 = null;
    let nec = [-Infinity, -Infinity], swc = [Infinity, Infinity];
    let hrS = 0, hrN = 0, hrMax = -1, hrMin = Infinity, cadS = 0, cadN = 0, cadMax = -1;
    let pS = 0, pN = 0, pMax = -1, vMax = -1, vS = 0, vN = 0, work = 0;
    const p1 = [];
    let asc = 0, desc = 0, ref = null, anyAlt = false;

    for (let i = 0; i < n; i++) {
      const m = recs[i];
      const t = ts(m);
      const dt = i + 1 < n ? Math.min(5, Math.max(0, ts(recs[i + 1]) - t)) : 1;
      let x;
      if ((x = F.get(m, 5)) !== null) dLast = x;
      const la = F.get(m, 0), lo = F.get(m, 1);
      if (la !== null && lo !== null && (la !== 0 || lo !== 0)) {
        if (la0 === null) { la0 = la; lo0 = lo; }
        la1 = la; lo1 = lo;
        nec = [Math.max(nec[0], la), Math.max(nec[1], lo)];
        swc = [Math.min(swc[0], la), Math.min(swc[1], lo)];
      }
      if ((x = F.get(m, 3)) !== null) { hrS += x; hrN++; if (x > hrMax) hrMax = x; if (x < hrMin) hrMin = x; }
      if ((x = F.get(m, 4)) !== null) { if (x > 0) { cadS += x; cadN++; } if (x > cadMax) cadMax = x; }
      if ((x = F.get(m, 7)) !== null) {
        pS += x; pN++; if (x > pMax) pMax = x; work += x * dt;
        for (let k = 0; k < Math.max(1, Math.round(dt)); k++) p1.push(x);
      }
      if ((x = F.get(m, 73)) !== null || (x = F.get(m, 6)) !== null) { vS += x; vN++; if (x > vMax) vMax = x; }
      if ((x = F.get(m, 78)) !== null || (x = F.get(m, 2)) !== null) {
        anyAlt = true;
        const a = x / 5 - 500;
        if (ref === null) ref = a;
        else if (a - ref >= 2) { asc += a - ref; ref = a; }
        else if (ref - a >= 2) { desc += ref - a; ref = a; }
      }
    }

    s.rawDist = dLast !== null && rawD0 !== null ? Math.max(0, dLast - rawD0) : null;
    s.rawDistEnd = dLast;
    s.startPos = la0 !== null ? [la0, lo0] : null;
    s.endPos = la1 !== null ? [la1, lo1] : null;
    s.box = la0 !== null ? { nec, swc } : null;
    s.hr = hrN ? { avg: Math.round(hrS / hrN), max: hrMax, min: hrMin } : null;
    s.cad = cadMax >= 0 ? { avg: cadN ? Math.round(cadS / cadN) : 0, max: cadMax } : null;
    if (pN) {
      s.power = { avg: Math.round(pS / pN), max: pMax, work: Math.round(work) };
      if (p1.length >= 30) {
        let roll = 0, acc = 0, k = 0;
        for (let i = 0; i < p1.length; i++) {
          roll += p1[i]; if (i >= 30) roll -= p1[i - 30];
          if (i >= 29) { acc += Math.pow(roll / 30, 4); k++; }
        }
        s.power.np = Math.round(Math.pow(acc / k, 0.25));
      }
    } else s.power = null;
    // Average speed the way head units define it: distance over moving time.
    if (s.rawDist !== null && s.timer > 0) s.avgSpeed = (s.rawDist / 100) / s.timer * 1000;
    else s.avgSpeed = vN ? vS / vN : null;
    s.maxSpeed = vMax >= 0 ? vMax : null;
    s.ascent = wantAscent && anyAlt ? { up: Math.round(asc), down: Math.round(desc) } : null;
    return s;
  }

  // Field numbers in lap (19) and session (18).
  const SF = {
    19: { start: 2, sLat: 3, sLon: 4, eLat: 5, eLon: 6, elapsed: 7, timer: 8, dist: 9, avgV: 13, maxV: 14, avgHr: 15, maxHr: 16, avgCad: 17, maxCad: 18, avgP: 19, maxP: 20, up: 21, down: 22, np: 33, work: 41, minHr: 63, eAvgV: 110, eMaxV: 111, necLat: 27, necLon: 28, swcLat: 29, swcLon: 30 },
    18: { start: 2, sLat: 3, sLon: 4, eLat: 38, eLon: 39, elapsed: 7, timer: 8, dist: 9, avgV: 14, maxV: 15, avgHr: 16, maxHr: 17, avgCad: 18, maxCad: 19, avgP: 20, maxP: 21, up: 22, down: 23, np: 34, work: 48, minHr: 64, eAvgV: 124, eMaxV: 125, necLat: 29, necLon: 30, swcLat: 31, swcLon: 32 },
  };
  /** Derived figures FitLab can't recompute; wrong once the samples change. */
  const STALE = { 19: [52, 57, 58, 59, 60], 18: [24, 35, 36, 59, 65, 66, 67, 68, 137] };

  function apply(m, s, opts) {
    const k = SF[m.g];
    const set = (name, v, b) => F.put(m, k[name], v, b);
    const opt = (name, v, b) => {
      if (v !== null && v !== undefined) set(name, v, b);
      else if (m.f[k[name]]) set(name, null);
    };
    set('start', s.start, T.uint32);
    F.put(m, 253, s.end, T.uint32); m.at = s.end;
    set('elapsed', s.elapsed * 1000, T.uint32);
    set('timer', s.timer * 1000, T.uint32);
    if (s.rawDist !== null) set('dist', s.rawDist, T.uint32);
    if (s.startPos) { set('sLat', s.startPos[0], T.sint32); set('sLon', s.startPos[1], T.sint32); }
    else { if (m.f[k.sLat]) set('sLat', null); if (m.f[k.sLon]) set('sLon', null); }
    if (s.endPos && (m.g === LAP || m.f[k.eLat])) { set('eLat', s.endPos[0], T.sint32); set('eLon', s.endPos[1], T.sint32); }
    else if (!s.endPos) { if (m.f[k.eLat]) set('eLat', null); if (m.f[k.eLon]) set('eLon', null); }
    if (m.f[k.necLat]) {
      for (const [nm, v] of [['necLat', s.box && s.box.nec[0]], ['necLon', s.box && s.box.nec[1]], ['swcLat', s.box && s.box.swc[0]], ['swcLon', s.box && s.box.swc[1]]]) set(nm, s.box ? v : null);
    }
    opt('avgHr', s.hr && s.hr.avg, T.uint8); opt('maxHr', s.hr && s.hr.max, T.uint8);
    if (m.f[k.minHr]) set('minHr', s.hr ? s.hr.min : null);
    opt('avgCad', s.cad && s.cad.avg, T.uint8); opt('maxCad', s.cad && s.cad.max, T.uint8);
    opt('avgP', s.power && s.power.avg, T.uint16); opt('maxP', s.power && s.power.max, T.uint16);
    opt('np', s.power && s.power.np, T.uint16); opt('work', s.power && s.power.work, T.uint32);
    opt('avgV', s.avgSpeed, T.uint16); opt('maxV', s.maxSpeed, T.uint16);
    if (m.f[k.eAvgV] || m.f[k.avgV]) opt('eAvgV', s.avgSpeed, T.uint32);
    if (m.f[k.eMaxV] || m.f[k.maxV]) opt('eMaxV', s.maxSpeed, T.uint32);
    if (s.ascent) { set('up', s.ascent.up, T.uint16); set('down', s.ascent.down, T.uint16); }
    if (opts.dirty) for (const n of STALE[m.g]) delete m.f[n];
  }

  /**
   * Rebuild laps, sessions and the activity from the records, and make the
   * timer events consistent. Every edit ends here.
   *   opts.dirty   samples were added, removed or changed: recompute ascent
   *                and drop the totals FitLab can't recompute (TSS, zones…)
   *   opts.pauses  extra [a, b] pauses to write as timer stop/start
   */
  function finalize(file, opts = {}) {
    const dirty = !!opts.dirty;
    const wantAscent = opts.ascent !== undefined ? !!opts.ascent : dirty;
    let f = fixTimer(file, opts.pauses || []);
    const recs = records(f);
    if (!recs.length) throw new Error('That would leave no samples at all.');
    const ps = pauses(f);
    const t0 = ts(recs[0]), t1 = ts(recs[recs.length - 1]);

    const byId = {};
    for (const r of recs) {
      for (const tag of ['lap', 'ses']) {
        const key = tag + ':' + r[tag];
        (byId[key] = byId[key] || []).push(r);
      }
    }

    // Laps, in the order their samples run.
    const laps = f.messages.filter(m => m.g === LAP);
    let live = laps.filter(m => byId['lap:' + m.id]);
    // Records whose lap was lost (shouldn't happen) join the lap before them.
    const orphan = recs.filter(r => !laps.some(l => l.id === r.lap));
    if (orphan.length && live.length) {
      for (const r of orphan) {
        let pick = live[0];
        for (const l of live) if (ts(byId['lap:' + l.id][0]) <= ts(r)) pick = l;
        byId['lap:' + pick.id].push(r);
      }
      for (const l of live) byId['lap:' + l.id].sort((a, b) => ts(a) - ts(b));
    }
    live.sort((a, b) => ts(byId['lap:' + a.id][0]) - ts(byId['lap:' + b.id][0]));

    const newLap = new Map();
    let prevEnd = t0, prevD = null;
    for (const r of recs) { const d = F.get(r, 5); if (d !== null) { prevD = d; break; } }
    const lapSession = new Map();
    live.forEach((l, i) => {
      const lr = byId['lap:' + l.id];
      const end = ts(lr[lr.length - 1]);
      const start = i === 0 ? t0 : Math.min(prevEnd, ts(lr[0]));
      const s = stats(lr, start, end, prevD, ps, wantAscent || !l.f[SF[LAP].up]);
      const c = cl(l);
      apply(c, s, opts);
      if (c.f[254]) F.put(c, 254, i);
      newLap.set(l, c);
      lapSession.set(l.id, lr[0].ses);
      prevEnd = end;
      if (s.rawDistEnd !== null) prevD = s.rawDistEnd;
    });

    // Sessions.
    const sessions = f.messages.filter(m => m.g === SES && byId['ses:' + m.id]);
    const newSes = new Map();
    let firstD = null;
    for (const r of recs) { const d = F.get(r, 5); if (d !== null) { firstD = d; break; } }
    let timerTotal = 0;
    sessions.sort((a, b) => ts(byId['ses:' + a.id][0]) - ts(byId['ses:' + b.id][0]));
    let sesEnd = t0, sesD = firstD;
    sessions.forEach((m, i) => {
      const sr = byId['ses:' + m.id];
      const end = ts(sr[sr.length - 1]);
      const start = i === 0 ? t0 : Math.min(sesEnd, ts(sr[0]));
      const s = stats(sr, start, end, sesD, ps, wantAscent || !m.f[SF[SES].up]);
      const c = cl(m);
      apply(c, s, opts);
      const mine = live.map((l, k) => [l, k]).filter(([l]) => lapSession.get(l.id) === m.id);
      if (mine.length) { F.put(c, 25, mine[0][1], T.uint16); F.put(c, 26, mine.length, T.uint16); }
      if (c.f[254]) F.put(c, 254, i);
      timerTotal += s.timer;
      newSes.set(m, c);
      sesEnd = end;
      if (s.rawDistEnd !== null) sesD = s.rawDistEnd;
    });

    const out = [];
    for (const m of f.messages) {
      if (m.g === LAP) { if (newLap.has(m)) out.push(newLap.get(m)); continue; }
      if (m.g === SES) { if (newSes.has(m)) out.push(newSes.get(m)); continue; }
      if (m.g === ACT) {
        const c = cl(m);
        const old = ts(m);
        F.put(c, 253, t1, T.uint32); c.at = t1;
        F.put(c, 0, timerTotal * 1000, T.uint32);
        F.put(c, 1, sessions.length, T.uint16);
        const lt = F.get(c, 5);
        if (lt !== null && old !== null) F.put(c, 5, lt + (t1 - old));
        out.push(c);
        continue;
      }
      if (m.g === TIZ && dirty) continue;
      out.push(m);
    }
    return { ...f, messages: out };
  }

  // ── Operations ────────────────────────────────────────────────────────────

  function range(file) {
    const r = records(file);
    return { t0: ts(r[0]), t1: ts(r[r.length - 1]) };
  }

  /** Keep only [a, b]. Distance starts again from zero at a. */
  function crop(file, a, b) {
    if (!(b > a)) throw new Error('Select a stretch of the ride first.');
    let d0 = null;
    for (const m of file.messages) {
      if (!isRec(m) || ts(m) < a) continue;
      d0 = F.get(m, 5);
      if (d0 !== null) break;
    }
    const out = retime(file, t => (t >= a && t <= b ? t : null), d0 ? (t, d) => Math.max(0, d - d0) : null);
    return finalize(out, { dirty: true });
  }

  /**
   * Remove [a, b) and close the gap: everything after moves earlier by
   * b − a. With `dropDistance`, the distance covered in the gap is taken out
   * too, so the distance trace stays continuous (a car ride, a train).
   */
  function cut(file, a, b, { dropDistance = true } = {}) {
    if (!(b > a)) throw new Error('Select a stretch of the ride first.');
    const { t0, t1 } = range(file);
    if (a <= t0 && b > t1) throw new Error('That would remove the whole ride.');
    const dGap = dropDistance ? (rawDistAt(file, b) || 0) - (rawDistAt(file, a) || 0) : 0;
    const out = retime(file,
      t => (t < a ? t : t < b ? null : t - (b - a)),
      dGap > 0 ? (t, d) => (t >= b ? Math.max(0, d - dGap) : d) : null);
    return finalize(out, { dirty: true });
  }

  /**
   * Turn [a, b] into a timer pause, the way auto-pause would have: the
   * samples inside are dropped, clock times are unchanged, and the timer
   * stops at a and starts at b, so moving time leaves it out.
   */
  function pause(file, a, b, { dropDistance = false } = {}) {
    if (!(b > a)) throw new Error('Select a stretch of the ride first.');
    const dGap = dropDistance ? (rawDistAt(file, b) || 0) - (rawDistAt(file, a) || 0) : 0;
    const out = retime(file,
      t => (t > a && t < b ? null : t),
      dGap > 0 ? (t, d) => (t >= b ? Math.max(0, d - dGap) : d) : null);
    return finalize(out, { dirty: true, pauses: [[a, b]] });
  }

  /** Move every timestamp by `sec` seconds (a head unit with the wrong clock). */
  function shift(file, sec) {
    sec = Math.round(sec);
    if (!sec) return file;
    const out = retime(file, t => t + sec);
    // Laps and sessions are rebuilt from records; the file's creation time moves too.
    out.messages = out.messages.map(m => {
      if (m.g === 0 && F.get(m, 4) !== null) { const c = cl(m); F.put(c, 4, F.get(m, 4) + sec); return c; }
      return m;
    });
    return finalize(out, { dirty: false });
  }

  /** Remove the samples in [a, b] without pausing or closing the gap. */
  function erase(file, a, b) {
    const out = retime(file, t => (t >= a && t <= b ? null : t));
    return finalize(out, { dirty: true });
  }

  // ── Developer fields across files ─────────────────────────────────────────

  function appKey(m) {
    const f = m.f[1];
    if (!f || F.isInvalid(f)) return null;
    return JSON.stringify(Array.isArray(f.v) ? f.v.map(Number) : [Number(f.v)]);
  }

  /**
   * Bring the definitions of the donor's developer fields `keys` ("idx:num")
   * into `msgs`. A developer app already present (same application id) keeps
   * its index; otherwise it gets the next free one. New definition messages
   * go just before the first record, which is before any use of them.
   * Returns { messages, map: { "donorIdx:num": "newIdx:num" } }.
   */
  function importDev(msgs, donor, keys) {
    const baseIds = msgs.filter(m => m.g === DEVID);
    const baseDescs = new Set(msgs.filter(m => m.g === FDESC).map(m => F.get(m, 0) + ':' + F.get(m, 1)));
    const used = new Set(baseIds.map(m => F.get(m, 3)).filter(x => x !== null));
    const idxMap = {};
    const add = [];
    const donorIds = donor.messages.filter(m => m.g === DEVID);
    const wantIdx = new Set(keys.map(k => Number(k.split(':')[0])));

    for (const m of donorIds) {
      const di = F.get(m, 3);
      if (di === null || !wantIdx.has(di) || di in idxMap) continue;
      const ak = appKey(m);
      const same = ak && baseIds.find(b => appKey(b) === ak);
      if (same) { idxMap[di] = F.get(same, 3); continue; }
      let ni = 0; while (used.has(ni)) ni++;
      used.add(ni); idxMap[di] = ni;
      const c = cl(m); F.put(c, 3, ni); c.at = null;
      add.push(c);
    }
    for (const i of wantIdx) if (!(i in idxMap)) {
      // A field with no developer_data_id: give it its own index anyway.
      let ni = 0; while (used.has(ni)) ni++;
      used.add(ni); idxMap[i] = ni;
      const m = { g: DEVID, f: {}, d: null, at: null };
      F.put(m, 3, ni, T.uint8);
      add.push(m);
    }
    for (const m of donor.messages) {
      if (m.g !== FDESC) continue;
      const di = F.get(m, 0), fn = F.get(m, 1);
      if (!keys.includes(di + ':' + fn)) continue;
      if (baseDescs.has(idxMap[di] + ':' + fn)) continue;
      const c = cl(m); F.put(c, 0, idxMap[di]); c.at = null;
      add.push(c);
      baseDescs.add(idxMap[di] + ':' + fn);
    }
    const map = {};
    for (const k of keys) { const [i, n] = k.split(':'); map[k] = idxMap[i] + ':' + n; }
    if (!add.length) return { messages: msgs, map };
    let at = msgs.findIndex(isRec);
    if (at < 0) at = msgs.length;
    return { messages: msgs.slice(0, at).concat(add, msgs.slice(at)), map };
  }

  // ── Merge ─────────────────────────────────────────────────────────────────

  function bsearch(arr, t) {           // last index with arr[i] <= t, or -1
    let lo = 0, hi = arr.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans;
  }

  /**
   * Bring channels from `donor` into `base`, matching samples by time.
   *   offset    seconds added to the donor's clock to line it up with the base
   *   channels  { key: 'fill' | 'replace' } — fill only where the base has
   *             nothing; replace wherever the donor has a value
   *   tol       a donor sample within this many seconds counts as "at" a base sample
   *   bridge    across donor gaps up to this long, interpolate linearly (for
   *             smart-recording files that log every few seconds); longer
   *             gaps are left empty, never filled with a held value
   */
  function merge(base, donor, { offset = 0, channels: want = {}, tol = 1, bridge = 5 } = {}) {
    const keys = Object.keys(want).filter(k => want[k] === 'fill' || want[k] === 'replace');
    if (!keys.length) throw new Error('Choose at least one channel to bring in.');
    const avail = channels(donor);
    const chans = keys.map(k => avail.find(c => c.key === k)).filter(Boolean);
    if (!chans.length) throw new Error('The second file has none of those channels.');

    const devKeys = chans.filter(c => c.dev).map(c => c.dev);
    let msgs = base.messages;
    let devMap = {};
    if (devKeys.length) ({ messages: msgs, map: devMap } = importDev(msgs, donor, devKeys));

    const drecs = records(donor);
    const baseRecs = msgs.filter(isRec);
    const basePresent = {};
    for (const m of baseRecs) for (const k in m.f) if (!F.isInvalid(m.f[k])) basePresent[k] = true;

    // Per channel: the donor samples that carry it, on the base's clock.
    const plan = chans.map(c => {
      const t = [], vals = [], types = {};
      for (const m of drecs) {
        if (c.dev) {
          const fd = m.d && m.d[c.dev];
          if (!fd || F.isInvalid(fd)) continue;
          t.push(ts(m) + offset); vals.push([fd]);
          continue;
        }
        let ok;
        if (c.alias) ok = c.nums.find(n => !F.isInvalid(m.f[n]));
        else ok = !F.isInvalid(m.f[c.nums[0]]) ? c.nums[0] : undefined;
        if (ok === undefined) continue;
        for (const n of c.nums) if (m.f[n] && !types[n]) types[n] = m.f[n];
        t.push(ts(m) + offset);
        vals.push(c.alias ? [m.f[ok]] : c.nums.map(n => m.f[n] || null));
      }
      // Where the donor's value lands in the base record.
      let targets;
      if (c.dev) targets = [devMap[c.dev]];
      else if (c.alias) {
        targets = c.nums.filter(n => basePresent[n]);
        if (!targets.length) targets = c.nums.filter(n => types[n]);
      } else targets = c.nums;
      return { c, t, vals, types, targets, mode: want[c.key] };
    });

    // A donor sample at the same second wins; between two donor samples no
    // more than `bridge` apart, interpolate; otherwise the nearest within
    // `tol`; otherwise nothing.
    function lookup(p, t) {
      const j = bsearch(p.t, t);
      if (j >= 0 && Math.abs(t - p.t[j]) < 0.5) return p.vals[j];
      if (j + 1 < p.t.length && Math.abs(p.t[j + 1] - t) < 0.5) return p.vals[j + 1];
      if (j >= 0 && j + 1 < p.t.length && p.t[j + 1] - p.t[j] <= bridge) {
        const w = (t - p.t[j]) / (p.t[j + 1] - p.t[j]);
        return p.vals[j].map((fa, k) => {
          const fb = p.vals[j + 1][k];
          if (!fa || !fb || F.isInvalid(fa) || F.isInvalid(fb) || typeof fa.v !== 'number' || typeof fb.v !== 'number') return w < 0.5 ? fa : fb;
          return { b: fa.b, s: fa.s, v: F.fit(fa.b, fa.v + (fb.v - fa.v) * w) };
        });
      }
      const cand = [];
      if (j >= 0 && t - p.t[j] <= tol) cand.push([t - p.t[j], j]);
      if (j + 1 < p.t.length && p.t[j + 1] - t <= tol) cand.push([p.t[j + 1] - t, j + 1]);
      if (cand.length) { cand.sort((a, b) => a[0] - b[0]); return p.vals[cand[0][1]]; }
      return null;
    }

    let filled = 0;
    const stat = {};
    const out = msgs.map(m => {
      if (!isRec(m)) return m;
      const t = ts(m);
      let c = null;
      for (const p of plan) {
        const v = lookup(p, t);
        const has = p.c.dev
          ? !!(m.d && m.d[p.targets[0]] && !F.isInvalid(m.d[p.targets[0]]))
          : (p.c.alias ? p.targets.concat(p.c.nums) : [p.c.nums[0]]).some(n => !F.isInvalid(m.f[n]));
        const write = v && (p.mode === 'replace' || !has);
        if (!c) c = cl(m);
        if (p.c.dev) {
          const key = p.targets[0], [ni, nn] = key.split(':').map(Number);
          if (write) { c.d = c.d || {}; c.d[key] = { i: ni, n: nn, b: v[0].b, s: v[0].s, v: v[0].v }; }
          else if (!(c.d && c.d[key]) && p.vals.length) { c.d = c.d || {}; const inv = F.invalidLike(p.vals[0][0]); c.d[key] = { i: ni, n: nn, ...inv }; }
        } else if (p.c.alias) {
          for (const n of p.targets) {
            const b = (m.f[n] && m.f[n].b) || (p.types[n] && p.types[n].b) || DEFAULT_TYPE[n];
            if (write) { F.put(c, n, Number(v[0].v), b); }
            else if (!c.f[n]) F.put(c, n, null, b);
          }
        } else {
          p.c.nums.forEach((n, k) => {
            const src = v && v[k];
            const proto = m.f[n] || (p.types[n]) || null;
            if (!proto) return;
            if (write) c.f[n] = src ? { b: src.b, s: src.s, v: src.v } : F.invalidLike(proto);
            else if (!c.f[n]) c.f[n] = F.invalidLike(proto);
          });
        }
        if (write) { stat[p.c.key] = (stat[p.c.key] || 0) + 1; filled++; }
      }
      return c || m;
    });

    const touchedAlt = plan.some(p => p.c.key === 'alt');
    const res = finalize({ ...base, messages: out }, { dirty: true, ascent: touchedAlt });
    res.mergeStats = { perChannel: stat, records: baseRecs.length, writes: filled };
    return res;
  }

  /**
   * Estimate the donor clock offset by cross-correlating a channel both files
   * share (power, then cadence, speed, heart rate) on a 1 Hz grid.
   * Returns { offset, channel, score } or null.
   */
  function estimateOffset(base, donor, { maxLag = 900 } = {}) {
    const A = series(base), B = series(donor);
    // Shared channels first; then, for files with nothing in common (GPS and
    // heart rate in one, power and cadence in the other), whether the rider
    // was moving — stops and starts are in both.
    const order = ['power', 'cad', 'speed', 'hr', 'moving'];
    for (const ch of order) {
      const a = ch === 'moving' ? movingGrid(A) : grid(A, ch), b = ch === 'moving' ? movingGrid(B) : grid(B, ch);
      if (!a || !b) continue;
      // lag L: donor time + L = base time.  base index i ↔ donor index i + (a.t0 - b.t0) - L
      const base0 = a.t0 - b.t0;
      let best = null;
      const tryLag = L => {
        const sh = base0 - L;
        let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
        const lo = Math.max(0, -sh), hi = Math.min(a.v.length, b.v.length - sh);
        for (let i = lo; i < hi; i++) {
          const x = a.v[i], y = b.v[i + sh];
          if (x !== x || y !== y) continue;
          n++; sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y;
        }
        if (n < 120) return;
        const cov = sab - sa * sb / n, va = saa - sa * sa / n, vb = sbb - sb * sb / n;
        if (va <= 0 || vb <= 0) return;
        const r = cov / Math.sqrt(va * vb);
        if (!best || r > best.score) best = { offset: L, channel: ch, score: r, overlap: n };
      };
      // Every second: second-to-second power is noisy, so the true peak is
      // one lag wide and a coarse search steps straight over it.
      for (let L = -maxLag; L <= maxLag; L++) tryLag(L);
      if (best && best.score > 0.3) return best;
    }
    return null;
  }

  /** 1 while moving, 0 while stopped: from speed if the file has it, else cadence or power. */
  function movingGrid(S) {
    const has = k => { for (let i = 0; i < S.n; i++) if (S[k][i] === S[k][i]) return true; return false; };
    const useSpeed = has('speed'), useCad = has('cad'), usePow = has('power');
    if (!useSpeed && !useCad && !usePow) return null;
    const m = { n: S.n, t: S.t, moving: new Float64Array(S.n).fill(NaN) };
    for (let i = 0; i < S.n; i++) {
      if (useSpeed) { const v = S.speed[i]; if (v === v) m.moving[i] = v > 1 ? 1 : 0; continue; }
      const c = useCad ? S.cad[i] : NaN, p = usePow ? S.power[i] : NaN;
      if (c === c || p === p) m.moving[i] = (c > 0 || p > 0) ? 1 : 0;
    }
    const g = grid(m, 'moving');
    // A ride with no stops has nothing to line up on.
    if (!g) return null;
    let stops = 0;
    for (let i = 0; i < g.v.length; i++) if (g.v[i] === 0) stops++;
    return stops >= 20 ? g : null;
  }

  function grid(S, ch) {
    if (!S.n) return null;
    const t0 = Math.round(S.t[0]), len = Math.round(S.t[S.n - 1]) - t0 + 1;
    if (len < 60 || len > 200000) return null;
    const v = new Float64Array(len).fill(NaN);
    let any = 0;
    for (let i = 0; i < S.n; i++) {
      const x = S[ch][i];
      if (x === x) { v[Math.round(S.t[i]) - t0] = x; any++; }
    }
    return any >= 120 ? { t0, v } : null;
  }

  // ── Splice ────────────────────────────────────────────────────────────────

  /**
   * Append `b` after `a` as one activity: one session, both files' laps.
   *   gap: null → keep b's real clock times (the gap becomes a pause)
   *   gap: n    → move b to start n seconds after a ends
   * b's distance continues from a's.
   */
  function splice(a, b, { gap = null } = {}) {
    const ra = range(a), rb = range(b);
    const delta = gap === null ? 0 : ra.t1 + Math.max(1, Math.round(gap)) - rb.t0;
    if (rb.t0 + delta <= ra.t1) {
      throw new Error('The second file starts before the first one ends (they overlap by ' +
        (ra.t1 - rb.t0 - delta + 1) + ' s). Use Merge to combine overlapping recordings, or splice with a set gap to move it after.');
    }
    const aRecs = records(a);
    let aEndD = null;
    for (let i = aRecs.length - 1; i >= 0; i--) { const d = F.get(aRecs[i], 5); if (d !== null) { aEndD = d; break; } }
    const aSes = a.messages.filter(m => m.g === SES);
    const lastSes = aSes[aSes.length - 1].id;

    const devKeys = new Set();
    for (const m of b.messages) if (m.d) for (const k in m.d) devKeys.add(k);
    let head = a.messages.filter(m => m.g !== SES && m.g !== ACT);
    let devMap = {};
    if (devKeys.size) ({ messages: head, map: devMap } = importDev(head, b, [...devKeys]));

    const moved = retime({ ...b, messages: b.messages.filter(m => !KEEP.has(m.g) && m.g !== SES && m.g !== ACT) },
      t => t + delta, aEndD !== null ? (t, d) => d + aEndD : null);
    // Fresh lap ids, so splicing a file onto a copy of itself can't confuse them.
    const lapIds = {};
    const relap = id => (lapIds[id] = lapIds[id] || uid('L'));
    const tail = moved.messages.map(m => {
      if (!isRec(m) && !m.d && m.g !== LAP) return m;
      const c = cl(m);
      if (m.g === LAP) c.id = relap(m.id);
      if (isRec(m)) { c.ses = lastSes; c.lap = relap(m.lap); }
      if (m.d) {
        c.d = {};
        for (const k in m.d) { const nk = devMap[k] || k; const [i, n] = nk.split(':').map(Number); c.d[nk] = { ...m.d[k], i, n }; }
      }
      return c;
    });
    // b's laps are retimed by finalize (they're rebuilt from their records).
    const msgs = head.concat(tail, aSes, a.messages.filter(m => m.g === ACT));
    return finalize({ ...a, messages: msgs }, { dirty: true });
  }

  // ── Small tools ───────────────────────────────────────────────────────────

  /** Remove channels entirely (e.g. GPS, for privacy). */
  function strip(file, keys) {
    const defs = channels(file).filter(c => keys.includes(c.key));
    const nums = new Set(), devs = new Set();
    for (const c of defs) { if (c.dev) devs.add(c.dev); else for (const n of c.nums) nums.add(n); }
    const pos = keys.includes('pos');
    const POS_SUM = { 19: [3, 4, 5, 6, 27, 28, 29, 30], 18: [3, 4, 29, 30, 31, 32, 38, 39] };
    const out = file.messages.map(m => {
      if (isRec(m)) {
        if (![...nums].some(n => m.f[n]) && !(m.d && [...devs].some(k => m.d[k]))) return m;
        const c = cl(m);
        for (const n of nums) delete c.f[n];
        if (c.d) { for (const k of devs) delete c.d[k]; if (!Object.keys(c.d).length) c.d = null; }
        return c;
      }
      if (pos && POS_SUM[m.g]) { const c = cl(m); for (const n of POS_SUM[m.g]) delete c.f[n]; return c; }
      return m;
    });
    return finalize({ ...file, messages: out }, { dirty: true });
  }

  /**
   * Blank out impossible values: power above `maxPower` W, heart rate above
   * `maxHr` bpm (optionally only inside [a, b]). Blank, not zero: zero watts
   * is a real reading and would drag the averages down.
   */
  function clean(file, { maxPower = null, maxHr = null, a = -Infinity, b = Infinity } = {}) {
    let n = 0;
    const out = file.messages.map(m => {
      if (!isRec(m)) return m;
      const t = ts(m);
      if (t < a || t > b) return m;
      const p = F.get(m, 7), h = F.get(m, 3);
      const badP = maxPower !== null && p !== null && p > maxPower;
      const badH = maxHr !== null && h !== null && h > maxHr;
      if (!badP && !badH) return m;
      const c = cl(m);
      if (badP) { F.put(c, 7, null); n++; }
      if (badH) { F.put(c, 3, null); n++; }
      return c;
    });
    const res = finalize({ ...file, messages: out }, { dirty: true });
    res.cleaned = n;
    return res;
  }

  const SPORTS = {
    'cycling': [2, 0], 'cycling/road': [2, 7], 'cycling/gravel': [2, 46], 'cycling/mountain': [2, 8],
    'cycling/cyclocross': [2, 11], 'cycling/indoor': [2, 6], 'cycling/virtual': [2, 58], 'cycling/track': [2, 13],
    'running': [1, 0], 'running/trail': [1, 3], 'running/treadmill': [1, 1], 'walking': [11, 0], 'hiking': [17, 0],
    'e_biking': [21, 0], 'rowing': [15, 0], 'swimming/open_water': [5, 18], 'generic': [0, 0],
  };

  /** Set the sport and sub-sport on the sport message, sessions and laps. */
  function setSport(file, key) {
    const sp = SPORTS[key];
    if (!sp) throw new Error('Unknown sport ' + key);
    const [s, sub] = sp;
    const out = file.messages.map(m => {
      if (m.g === 12) { const c = cl(m); F.put(c, 0, s, T.enum); F.put(c, 1, sub, T.enum); return c; }
      if (m.g === SES) { const c = cl(m); F.put(c, 5, s, T.enum); F.put(c, 6, sub, T.enum); return c; }
      if (m.g === LAP) { const c = cl(m); F.put(c, 25, s, T.enum); F.put(c, 39, sub, T.enum); return c; }
      return m;
    });
    return { ...file, messages: out };
  }

  function sportOf(file) {
    const ses = file.messages.find(m => m.g === SES);
    const sm = file.messages.find(m => m.g === 12);
    const s = (ses && F.get(ses, 5)) ?? (sm && F.get(sm, 0));
    const sub = (ses && F.get(ses, 6)) ?? (sm && F.get(sm, 1)) ?? 0;
    for (const [k, v] of Object.entries(SPORTS)) if (v[0] === s && v[1] === sub) return k;
    for (const [k, v] of Object.entries(SPORTS)) if (v[0] === s && v[1] === 0) return k;
    return null;
  }

  // ── Description ───────────────────────────────────────────────────────────

  const MAKERS = { 1: 'Garmin', 6: 'SRM', 9: 'Saris', 23: 'Suunto', 32: 'Wahoo', 41: 'Shimano', 51: '4iiii', 69: 'Stages', 73: 'Wattbike',
    86: 'Elite', 89: 'Tacx', 107: 'Magene', 112: 'Bryton', 115: 'iGPSPORT', 123: 'Polar', 144: 'Zwift', 255: 'Development', 258: 'Lezyne',
    260: 'Zwift', 263: 'Favero', 265: 'Strava', 267: 'Bryton', 268: 'SRAM', 281: 'TrainerRoad', 289: 'Hammerhead', 294: 'COROS', 340: 'Peloton' };

  /** A small description of a file for the UI. */
  function describe(file) {
    const recs = records(file);
    const fid = file.messages.find(m => m.g === 0);
    const ses = file.messages.filter(m => m.g === SES);
    const s0 = ses[0];
    const sum = (n, sc) => ses.reduce((acc, m) => { const v = F.get(m, n); return v === null ? acc : (acc || 0) + v / sc; }, null);
    const maker = fid ? F.get(fid, 1) : null;
    const prodName = fid && fid.f[8] && typeof fid.f[8].v === 'string' ? fid.f[8].v : '';
    const dev = file.messages.find(m => m.g === 23 && F.get(m, 0) === 0 && m.f[27] && typeof m.f[27].v === 'string');
    const counts = {};
    for (const m of file.messages) counts[m.g] = (counts[m.g] || 0) + 1;
    return {
      t0: recs.length ? ts(recs[0]) : null,
      t1: recs.length ? ts(recs[recs.length - 1]) : null,
      start: recs.length ? new Date((ts(recs[0]) + F.FIT_EPOCH) * 1000) : null,
      records: recs.length,
      elapsed: sum(7, 1000),
      timer: sum(8, 1000),
      distance: sum(9, 100),
      avgPower: s0 ? F.get(s0, 20) : null,
      np: s0 ? F.get(s0, 34) : null,
      avgHr: s0 ? F.get(s0, 16) : null,
      ascent: sum(22, 1),
      laps: counts[LAP] || 0,
      sessions: ses.length,
      device: [MAKERS[maker] || (maker !== null ? 'Manufacturer ' + maker : ''), prodName || (dev ? dev.f[27].v : '')].filter(Boolean).join(' '),
      sport: sportOf(file),
      channels: channels(file),
      messages: file.messages.length,
      counts,
      pauses: pauses(file),
    };
  }

  /** Problems a reader might choke on. */
  function check(file) {
    const issues = [];
    const recs = records(file);
    let back = 0, dBack = 0, lastD = null;
    for (let i = 1; i < recs.length; i++) if (ts(recs[i]) < ts(recs[i - 1])) back++;
    for (const r of recs) { const d = F.get(r, 5); if (d !== null) { if (lastD !== null && d < lastD) dBack++; lastD = d; } }
    if (back) issues.push(back + ' sample' + (back > 1 ? 's go' : ' goes') + ' backwards in time.');
    if (dBack) issues.push('The distance goes backwards at ' + dBack + ' sample' + (dBack > 1 ? 's' : '') + '.');
    return issues;
  }

  return {
    CHANNELS, SPORTS, KEEP, SUMMARY,
    prepare, finalize, records, series, channels, pauses, describe, check, range,
    crop, cut, pause, erase, shift, merge, splice, strip, clean, setSport, sportOf,
    estimateOffset, importDev, devNames,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FitEdit;
