'use strict';

/**
 * Headless tests for the codec and the edit operations.
 *
 * Fixtures are written by Garmin's own FIT SDK (a devDependency, never
 * shipped), so the decoder is tested on bytes it did not produce; every file
 * FitLab writes is read back by Garmin's decoder, so "valid FIT" means valid
 * to the reference implementation and not just to ourselves.
 *
 *   node test/harness.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const JS = path.join(ROOT, 'assets', 'js');

function memStorage() {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k), key: i => Array.from(m.keys())[i], get length() { return m.size; },
  };
}

const sandbox = {
  console, localStorage: memStorage(), sessionStorage: memStorage(),
  fetch: () => Promise.reject(new Error('network disabled in tests')),
  btoa: s => Buffer.from(s, 'binary').toString('base64'),
  TextEncoder, TextDecoder, DecompressionStream, Response, Blob, FormData,
  Math, JSON, Date, Number, String, Array, Object, Boolean, Error, Map, Set, Promise, RegExp, BigInt,
  Float64Array, Int32Array, Uint8Array, ArrayBuffer, DataView, isFinite, isNaN, parseFloat, parseInt,
  URLSearchParams, encodeURIComponent, setTimeout, clearTimeout,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of ['Intervals.js', 'FitStore.js', 'FitFile.js', 'FitEdit.js']) {
  vm.runInContext(fs.readFileSync(path.join(JS, f), 'utf8'), sandbox, { filename: f });
}
const G = name => vm.runInContext(name, sandbox);
const FitFile = G('FitFile'), FitEdit = G('FitEdit'), Intervals = G('Intervals'), Settings = G('Settings');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  \x1b[32mok\x1b[0m   ' + name + (detail ? '  \x1b[2m' + detail + '\x1b[0m' : '')); }
  else { failed++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  \x1b[31mFAIL\x1b[0m ' + name + (detail ? '  ' + detail : '')); }
}
function section(t) { console.log('\n\x1b[1m' + t + '\x1b[0m'); }
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const ab = u8 => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

(async () => {
  const sdk = await import(path.join(ROOT, 'node_modules/@garmin/fitsdk/src/index.js'));
  const { Encoder, Decoder, Stream, Profile } = sdk;
  const MN = Profile.MesgNum;

  function garminRead(buf) {
    const d = new Decoder(Stream.fromArrayBuffer(buf));
    const ok = d.isFIT() && d.checkIntegrity();
    const r = new Decoder(Stream.fromArrayBuffer(buf)).read({ convertDateTimesToDates: false, mergeHeartRates: false });
    return { ok, errors: r.errors, m: r.messages };
  }

  const T0 = 1159790400;       // 2026-10-01 12:00:00 UTC in FIT seconds
  const SEMI = 2147483648 / 180;

  /**
   * "Head unit": 1200 s at 1 Hz with GPS, HR, altitude, speed, distance, a
   * CORE-style developer field, HRV, two laps and a timer start/stop.
   */
  function headUnit({ t0 = T0, n = 1200, lapAt = 600, startDist = 0 } = {}) {
    const dd = { developerDataIndex: 0, applicationId: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16] };
    const fd = { developerDataIndex: 0, fieldDefinitionNumber: 0, fitBaseTypeId: 0x84, fieldName: 'core_temperature', units: 'C', scale: 100 };
    const enc = new Encoder();
    enc.addDeveloperField(0, dd, fd);
    enc.onMesg(MN.FILE_ID, { type: 'activity', manufacturer: 'garmin', product: 3843, timeCreated: t0, serialNumber: 42 });
    enc.onMesg(MN.DEVICE_INFO, { timestamp: t0, deviceIndex: 0, manufacturer: 'garmin', product: 3843, softwareVersion: 21.19 });
    enc.onMesg(MN.DEVELOPER_DATA_ID, dd);
    enc.onMesg(MN.FIELD_DESCRIPTION, fd);
    enc.onMesg(MN.EVENT, { timestamp: t0, event: 'timer', eventType: 'start', eventGroup: 0 });
    for (let i = 0; i < n; i++) {
      const v = 8 + 2 * Math.sin(i / 60);
      enc.onMesg(MN.RECORD, {
        timestamp: t0 + i, positionLat: Math.round((42.35 + i * 0.00005) * SEMI), positionLong: Math.round(-71.1 * SEMI),
        heartRate: 130 + Math.round(10 * Math.sin(i / 30)), enhancedAltitude: 50 + 20 * Math.sin(i / 200),
        enhancedSpeed: v, distance: startDist + i * 8, developerFields: { 0: 3750 + i },
      });
      if (i % 2 === 0) enc.onMesg(MN.HRV, { time: [0.46, 0.47] });
      if (i === lapAt) enc.onMesg(MN.LAP, { timestamp: t0 + i, startTime: t0, totalElapsedTime: lapAt, totalTimerTime: lapAt, event: 'lap', eventType: 'stop', messageIndex: 0 });
    }
    enc.onMesg(MN.EVENT, { timestamp: t0 + n - 1, event: 'timer', eventType: 'stopAll', eventGroup: 0 });
    enc.onMesg(MN.LAP, { timestamp: t0 + n - 1, startTime: t0 + lapAt, totalElapsedTime: n - 1 - lapAt, totalTimerTime: n - 1 - lapAt, event: 'lap', eventType: 'stop', messageIndex: 1 });
    enc.onMesg(MN.SESSION, { timestamp: t0 + n - 1, startTime: t0, totalElapsedTime: n - 1, totalTimerTime: n - 1, sport: 'cycling', subSport: 'road', event: 'session', eventType: 'stop', avgPower: 999, trainingStressScore: 55, numLaps: 2, firstLapIndex: 0, messageIndex: 0 });
    enc.onMesg(MN.ACTIVITY, { timestamp: t0 + n - 1, numSessions: 1, totalTimerTime: n - 1, localTimestamp: t0 + n - 1 - 4 * 3600, type: 'manual', event: 'activity', eventType: 'stop' });
    return ab(enc.close());
  }

  /**
   * "Trainer": power and cadence, smart recording every 2 s, a clock 7 s
   * fast, starting 30 s earlier and ending 50 s earlier, with a pedal
   * smoothness developer field.
   */
  const CLOCK = 7;
  // Seeded noise on a slow wave: realistic enough that the correlation has one clear peak.
  const noise = i => { let x = Math.imul((i + 1000) ^ 0x9E3779B9, 0x85EBCA6B); x ^= x >>> 13; x = Math.imul(x, 0xC2B2AE35); x ^= x >>> 16; return (x >>> 0) / 4294967296; };
  const powerAt = i => 180 + Math.round(50 * Math.sin(i / 90) + 80 * noise(i));
  function trainer() {
    const dd = { developerDataIndex: 0, applicationId: [9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9] };
    const fd = { developerDataIndex: 0, fieldDefinitionNumber: 3, fitBaseTypeId: 0x02, fieldName: 'smoothness', units: '%' };
    const enc = new Encoder();
    enc.addDeveloperField(0, dd, fd);
    enc.onMesg(MN.FILE_ID, { type: 'activity', manufacturer: 'wahooFitness', product: 1, timeCreated: T0, serialNumber: 7 });
    enc.onMesg(MN.DEVELOPER_DATA_ID, dd);
    enc.onMesg(MN.FIELD_DESCRIPTION, fd);
    enc.onMesg(MN.EVENT, { timestamp: T0 - 30 + CLOCK, event: 'timer', eventType: 'start' });
    for (let i = -30; i < 1150; i += 2) {
      enc.onMesg(MN.RECORD, { timestamp: T0 + i + CLOCK, power: powerAt(i), cadence: 85 + (i % 7), heartRate: 100, developerFields: { 0: 20 + (i % 10) } });
    }
    enc.onMesg(MN.EVENT, { timestamp: T0 + 1148 + CLOCK, event: 'timer', eventType: 'stopAll' });
    enc.onMesg(MN.SESSION, { timestamp: T0 + 1148 + CLOCK, startTime: T0 - 30 + CLOCK, totalElapsedTime: 1178, totalTimerTime: 1178, sport: 'cycling' });
    return ab(enc.close());
  }

  const load = buf => FitEdit.prepare(FitFile.decode(buf));
  const recs = f => FitEdit.records(f);
  const ts = m => FitFile.get(m, 253);
  const ses = f => f.messages.find(m => m.g === 18);
  const laps = f => f.messages.filter(m => m.g === 19);
  const timerEvents = f => f.messages.filter(m => m.g === 21 && FitFile.get(m, 0) === 0).map(m => [ts(m), FitFile.get(m, 1)]);

  // ── Codec ────────────────────────────────────────────────────────────────

  section('Codec: decode Garmin-written bytes, write them back');
  const aBuf = headUnit();
  const aDec = FitFile.decode(aBuf);
  check('decodes, CRC verified', aDec.crcOk && !aDec.truncated);
  check('every record is there', aDec.messages.filter(m => m.g === 20).length === 1200);
  check('hrv messages kept, each tied to the record before it', aDec.messages.filter(m => m.g === 78).length === 600 && aDec.messages.filter(m => m.g === 78).every(m => m.at !== null));
  const r5 = aDec.messages.filter(m => m.g === 20)[5];
  check('developer field read with its declared type', r5.d && r5.d['0:0'] && r5.d['0:0'].b === 0x84 && r5.d['0:0'].v === 3755, JSON.stringify(r5.d));
  check('physical values', near(FitFile.recordValue(r5, 78), 50 + 20 * Math.sin(5 / 200), 0.2) && FitFile.recordValue(r5, 5) === 40);

  const aOut = FitFile.encode(aDec);
  const gA = garminRead(aOut);
  check('re-encoded file passes Garmin integrity check', gA.ok && gA.errors.length === 0, gA.errors.join(';'));
  check('Garmin reads the same records', gA.m.recordMesgs.length === 1200 && gA.m.recordMesgs[5].heartRate === 130 + Math.round(10 * Math.sin(5 / 30)));
  check('…with the developer field', gA.m.recordMesgs[5].developerFields && gA.m.recordMesgs[5].developerFields[0] === 3755, JSON.stringify(gA.m.recordMesgs[5].developerFields));
  check('…and the hrv, device_info, laps, session, activity', gA.m.hrvMesgs.length === 600 && gA.m.deviceInfoMesgs.length === 1 && gA.m.lapMesgs.length === 2 && gA.m.sessionMesgs.length === 1 && gA.m.activityMesgs.length === 1);
  const again = FitFile.decode(aOut);
  check('decode(encode(x)) has the same messages', again.messages.length === aDec.messages.length &&
    again.messages.every((m, i) => JSON.stringify(m.f, (k, v) => (typeof v === 'bigint' ? String(v) : v)) === JSON.stringify(aDec.messages[i].f, (k, v) => (typeof v === 'bigint' ? String(v) : v))));

  section('Codec: compressed timestamps and big-endian definitions');
  {
    // Hand-built: a big-endian definition for record (ts + hr), one normal
    // message, then two compressed-timestamp messages using a second definition.
    const b = [];
    const u16be = v => [v >> 8, v & 255], u32be = v => [v >>> 24, (v >> 16) & 255, (v >> 8) & 255, v & 255];
    b.push(0x40, 0, 1, ...u16be(20), 2, 253, 4, 0x86, 3, 1, 0x02);          // local 0, big-endian
    b.push(0x00, ...u32be(T0 + 30), 140);
    b.push(0x41, 0, 1, ...u16be(20), 1, 3, 1, 0x02);                        // local 1: hr only
    b.push(0x80 | (1 << 5) | ((T0 + 31) & 31), 141);
    b.push(0x80 | (1 << 5) | ((T0 + 33) & 31), 142);
    const body = Uint8Array.from(b);
    const hdr = new Uint8Array(14);
    const dv = new DataView(hdr.buffer);
    dv.setUint8(0, 14); dv.setUint8(1, 0x10); dv.setUint16(2, 2132, true); dv.setUint32(4, body.length, true);
    hdr.set([0x2E, 0x46, 0x49, 0x54], 8);
    dv.setUint16(12, FitFile.crc16(hdr, 0, 12), true);
    const all = new Uint8Array(14 + body.length + 2);
    all.set(hdr); all.set(body, 14);
    new DataView(all.buffer).setUint16(14 + body.length, FitFile.crc16(all, 0, 14 + body.length), true);
    const d = FitFile.decode(all.buffer);
    const rr = d.messages.filter(m => m.g === 20);
    check('big-endian fields read', ts(rr[0]) === T0 + 30 && FitFile.get(rr[0], 3) === 140);
    check('compressed timestamps expand', ts(rr[1]) === T0 + 31 && ts(rr[2]) === T0 + 33, rr.map(ts).join(','));
    const g = garminRead(FitFile.encode(d));
    check('…and come out as explicit timestamps Garmin reads', g.ok && g.m.recordMesgs.length === 3 && g.m.recordMesgs[2].timestamp === T0 + 33);
  }

  // ── Untouched ────────────────────────────────────────────────────────────

  section('An untouched file goes out unchanged');
  const A = load(aBuf);
  const sameOut = FitFile.decode(FitFile.encode(A));
  check('prepare does not rewrite summaries', FitFile.get(sameOut.messages.find(m => m.g === 18), 20) === 999 && FitFile.get(sameOut.messages.find(m => m.g === 18), 35) === 550);

  // ── Merge ────────────────────────────────────────────────────────────────

  section('Merge: power and cadence from a trainer file');
  const B = load(trainer());
  const est = FitEdit.estimateOffset(A, B);
  // The only channel both have is heart rate, and the trainer's is flat: no guess beats a wrong one.
  check('no offset guessed without a shared, varying channel', est === null, est ? est.channel + ' r=' + est.score.toFixed(2) : 'none');
  const chB = FitEdit.channels(B);
  check('donor channels listed, developer field by name', chB.some(c => c.key === 'power') && chB.some(c => c.key === 'cad') && chB.some(c => c.dev && /smoothness/.test(c.label)), chB.map(c => c.label).join(', '));

  const M = FitEdit.merge(A, B, { offset: -CLOCK, channels: { power: 'fill', cad: 'fill', 'dev:0:3': 'fill' }, tol: 1, bridge: 5 });
  const mr = recs(M);
  check('no records added or lost', mr.length === 1200);
  const at = i => mr.find(m => ts(m) === T0 + i);
  check('power lands on the right second', FitFile.get(at(100), 7) === powerAt(100) && FitFile.get(at(400), 7) === powerAt(400), FitFile.get(at(100), 7) + ' vs ' + powerAt(100));
  check('odd seconds are interpolated across the 2 s smart-recording gap', near(FitFile.get(at(101), 7), (powerAt(100) + powerAt(102)) / 2, 1));
  check('no power past the end of the trainer file (never held)', FitFile.get(at(1190), 7) === null);
  check('base heart rate untouched in fill mode', FitFile.get(at(100), 3) === 130 + Math.round(10 * Math.sin(100 / 30)));
  const sM = ses(M);
  const pw = mr.map(m => FitFile.get(m, 7)).filter(x => x !== null);
  check('session average power recomputed from the samples', FitFile.get(sM, 20) === Math.round(pw.reduce((a, b) => a + b, 0) / pw.length), String(FitFile.get(sM, 20)));
  check('stale totals dropped (TSS)', FitFile.get(sM, 35) === null);
  check('laps get power too', laps(M).every(l => FitFile.get(l, 19) > 100));
  check('merge reports what it wrote', M.mergeStats.perChannel.power > 1100, JSON.stringify(M.mergeStats.perChannel));

  const gM = garminRead(FitFile.encode(M));
  check('merged file is valid FIT to Garmin', gM.ok && gM.errors.length === 0, gM.errors.join(';'));
  check('Garmin reads power, cadence and both developer fields', gM.m.recordMesgs[100].power === powerAt(100) && gM.m.recordMesgs[100].cadence > 80 &&
    Object.keys(gM.m.recordMesgs[100].developerFields || {}).length === 2, JSON.stringify(gM.m.recordMesgs[100].developerFields));
  check('…with the donor developer field given a free index', gM.m.developerDataIdMesgs.length === 2 && gM.m.fieldDescriptionMesgs.some(f => f.fieldName === 'smoothness' && f.developerDataIndex === 1));

  const est2 = FitEdit.estimateOffset(M, B);
  check('offset estimate recovers the trainer clock error', est2 && est2.channel === 'power' && est2.offset === -CLOCK, est2 && (est2.offset + ' s via ' + est2.channel));

  section('Merge: replace mode');
  const MR = FitEdit.merge(A, B, { offset: -CLOCK, channels: { hr: 'replace' } });
  check('replace overwrites where the donor has data', FitFile.get(recs(MR).find(m => ts(m) === T0 + 100), 3) === 100);
  check('…and leaves the base alone where it has none', FitFile.get(recs(MR).find(m => ts(m) === T0 + 1190), 3) === 130 + Math.round(10 * Math.sin(1190 / 30)));
  check('merging nothing is an error', (() => { try { FitEdit.merge(A, B, { channels: {} }); return false; } catch (_) { return true; } })());

  // ── Crop / cut / pause ───────────────────────────────────────────────────

  section('Crop');
  const C = FitEdit.crop(A, T0 + 100, T0 + 899);
  const cr = recs(C);
  check('only the selection is left', ts(cr[0]) === T0 + 100 && ts(cr[cr.length - 1]) === T0 + 899 && cr.length === 800);
  check('hrv outside is gone too', C.messages.filter(m => m.g === 78).length === 400);
  check('timer starts at the first sample and stops at the last', JSON.stringify(timerEvents(C)) === JSON.stringify([[T0 + 100, 0], [T0 + 899, 4]]), JSON.stringify(timerEvents(C)));
  check('session spans the crop', FitFile.get(ses(C), 2) === T0 + 100 && FitFile.get(ses(C), 7) === 799000 && FitFile.get(ses(C), 9) === 799 * 800);
  check('both laps survive, clipped', laps(C).length === 2 && FitFile.get(laps(C)[0], 2) === T0 + 100 && FitFile.get(laps(C)[1], 253) === T0 + 899);
  check('distance starts again from zero', FitFile.get(cr[0], 5) === 0 && FitFile.get(cr[cr.length - 1], 5) === FitFile.get(ses(C), 9));
  check('lap distances sum to the session', laps(C).reduce((s, l) => s + FitFile.get(l, 9), 0) === FitFile.get(ses(C), 9));
  check('activity timer total matches', FitFile.get(C.messages.find(m => m.g === 34), 0) === 799000);
  check('local timestamp moves with the end', FitFile.get(C.messages.find(m => m.g === 34), 5) === T0 + 899 - 4 * 3600);
  const C1 = FitEdit.crop(A, T0 + 700, T0 + 900);
  check('cropping inside one lap leaves one lap', laps(C1).length === 1);
  check('crop file valid to Garmin', garminRead(FitFile.encode(C)).ok);

  section('Pause');
  const P = FitEdit.pause(A, T0 + 300, T0 + 420);
  const pr = recs(P);
  check('samples inside the pause are gone; the edges stay', pr.length === 1200 - 119 && pr.some(m => ts(m) === T0 + 300) && pr.some(m => ts(m) === T0 + 420));
  check('clock times unchanged', ts(pr[pr.length - 1]) === T0 + 1199);
  check('timer stop and start written', JSON.stringify(timerEvents(P)) === JSON.stringify([[T0, 0], [T0 + 300, 4], [T0 + 420, 0], [T0 + 1199, 4]]), JSON.stringify(timerEvents(P)));
  check('timer time excludes the pause, elapsed does not', FitFile.get(ses(P), 7) === 1199000 && FitFile.get(ses(P), 8) === 1079000);
  check('lap 1 carries the pause', FitFile.get(laps(P)[0], 8) === FitFile.get(laps(P)[0], 7) - 120000, String(FitFile.get(laps(P)[0], 8)));
  check('lap timer times sum to the session', laps(P).reduce((s, l) => s + FitFile.get(l, 8), 0) === FitFile.get(ses(P), 8));
  const gP = garminRead(FitFile.encode(P));
  check('Garmin sees the stop/start', gP.ok && gP.m.eventMesgs.filter(e => e.event === 'timer').map(e => e.eventType).join(',') === 'start,stopAll,start,stopAll');
  const P2 = FitEdit.pause(P, T0 + 350, T0 + 500);
  check('overlapping pauses merge into one', JSON.stringify(timerEvents(P2)) === JSON.stringify([[T0, 0], [T0 + 300, 4], [T0 + 500, 0], [T0 + 1199, 4]]), JSON.stringify(timerEvents(P2)));
  const P3 = FitEdit.pause(A, T0 + 300, T0 + 420, { dropDistance: true });
  check('pause can take the distance out', FitFile.get(ses(P3), 9) === 1199 * 800 - 120 * 800);

  section('Cut (close the gap)');
  const K = FitEdit.cut(A, T0 + 300, T0 + 420);
  const kr = recs(K);
  check('120 s removed and the clock closed up', kr.length === 1080 && ts(kr[kr.length - 1]) === T0 + 1079);
  check('timestamps strictly increase', kr.every((m, i) => i === 0 || ts(m) > ts(kr[i - 1])));
  check('distance continuous across the join', FitFile.get(kr[300], 5) - FitFile.get(kr[299], 5) === 800 && FitEdit.check(K).length === 0);
  check('session shorter by the cut', FitFile.get(ses(K), 7) === 1079000 && FitFile.get(ses(K), 9) === 1079 * 800);
  const K2 = FitEdit.cut(A, T0 + 300, T0 + 420, { dropDistance: false });
  check('…or keep the distance jump if asked', FitFile.get(ses(K2), 9) === 1199 * 800);
  check('cutting everything is refused', (() => { try { FitEdit.cut(A, T0 - 5, T0 + 5000); return false; } catch (_) { return true; } })());

  section('Splice');
  const later = load(headUnit({ t0: T0 + 1800, n: 600, lapAt: 300 }));
  const S = FitEdit.splice(A, later, { gap: null });
  const sr = recs(S);
  check('all samples of both', sr.length === 1800);
  check('one session, four laps', S.messages.filter(m => m.g === 18).length === 1 && laps(S).length === 4);
  check('the gap between files is a pause', FitFile.get(ses(S), 7) === (1800 + 599) * 1000 && FitFile.get(ses(S), 8) === (1199 + 599) * 1000, FitFile.get(ses(S), 8));
  check('distance carries on from the first file', FitEdit.check(S).length === 0 && FitFile.get(sr[sr.length - 1], 5) === 1199 * 800 + 599 * 800);
  check('developer app shared by both files keeps one index', S.messages.filter(m => m.g === 207).length === 1);
  const gS = garminRead(FitFile.encode(S));
  check('spliced file valid to Garmin', gS.ok && gS.errors.length === 0 && gS.m.lapMesgs.length === 4 && gS.m.sessionMesgs[0].numLaps === 4);
  const S2 = FitEdit.splice(A, later, { gap: 10 });
  check('…or moved to follow on after a set gap', ts(recs(S2)[1200]) === T0 + 1199 + 10);
  check('overlapping files are refused with a pointer to Merge', (() => { try { FitEdit.splice(A, B); return false; } catch (e) { return /Merge/.test(e.message); } })());
  const self = FitEdit.splice(A, A, { gap: 30 });
  check('a file spliced onto itself keeps distinct laps', laps(self).length === 4);

  section('Shift, strip, clean, sport');
  const H = FitEdit.shift(A, 3600);
  check('shift moves every sample and the summaries', ts(recs(H)[0]) === T0 + 3600 && FitFile.get(ses(H), 2) === T0 + 3600 && timerEvents(H)[0][0] === T0 + 3600);
  check('…and the file creation time', FitFile.get(H.messages[0], 4) === T0 + 3600);
  const X = FitEdit.strip(A, ['pos']);
  check('strip GPS: none left in records or summaries', recs(X).every(m => !m.f[0] && !m.f[1]) && !ses(X).f[3] && laps(X).every(l => !l.f[3] && !l.f[5]));
  check('stripped file valid', garminRead(FitFile.encode(X)).ok);
  const spiky = FitEdit.merge(A, B, { offset: -CLOCK, channels: { power: 'fill' } });
  const Q = FitEdit.clean(spiky, { maxPower: 200 });
  check('clean blanks values over the limit', recs(Q).every(m => FitFile.get(m, 7) === null || FitFile.get(m, 7) <= 200) && Q.cleaned > 100, String(Q.cleaned));
  const W = FitEdit.setSport(A, 'cycling/gravel');
  check('sport set on session and laps', FitFile.get(ses(W), 6) === 46 && laps(W).every(l => FitFile.get(l, 39) === 46) && FitEdit.sportOf(W) === 'cycling/gravel');

  section('A file with no laps or session gets them');
  {
    const enc = new Encoder();
    enc.onMesg(MN.FILE_ID, { type: 'activity', manufacturer: 'development', product: 1, timeCreated: T0 });
    for (let i = 0; i < 100; i++) enc.onMesg(MN.RECORD, { timestamp: T0 + i, power: 200, heartRate: 140 });
    const bare = load(ab(enc.close()));
    check('lap, session and activity created', laps(bare).length === 1 && !!ses(bare) && bare.messages.some(m => m.g === 34));
    check('…with the right totals', FitFile.get(ses(bare), 7) === 99000 && FitFile.get(ses(bare), 20) === 200);
    const g = garminRead(FitFile.encode(bare));
    check('…that Garmin reads', g.ok && g.m.sessionMesgs.length === 1 && g.m.sessionMesgs[0].avgPower === 200);
  }

  section('Describe');
  const dA = FitEdit.describe(A);
  check('device, sport, totals', /Garmin/.test(dA.device) && dA.sport === 'cycling/road' && dA.records === 1200 && dA.laps === 2, dA.device + ' / ' + dA.sport);

  // ── intervals.icu client ─────────────────────────────────────────────────

  section('intervals.icu file download');
  const fitBytes = new Uint8Array(aBuf);
  const gz = zlib.gzipSync(Buffer.from(fitBytes));
  check('gzip is recognised and inflated', FitFile.isFit(await Intervals.unpack(ab(gz))));
  check('plain FIT passes through', FitFile.isFit(await Intervals.unpack(aBuf)));

  const calls = [];
  sandbox.fetch = async (url, opts) => {
    calls.push(url);
    if (/\/activity\/i1\/file$/.test(url)) return new Response(Buffer.from('<?xml version="1.0"?><gpx/>'), { status: 200 });
    if (/\/activity\/i1\/fit-file$/.test(url)) return new Response(zlib.gzipSync(Buffer.from(fitBytes)), { status: 200 });
    if (/\/activity\/i2\/file$/.test(url)) return new Response(gz, { status: 200 });
    if (/\/activity\/i3\/file$/.test(url)) return new Response('Activity is from Strava', { status: 422 });
    if (/\/athlete\/0\/activities(\?|$)/.test(url) && opts.method === 'POST') return new Response(JSON.stringify({ id: 'i99', icu_athlete_id: 'x' }), { status: 201 });
    return new Response('nope', { status: 404 });
  };
  const got2 = await Intervals.downloadFit('i2', 'k');
  check('original upload used when it is a FIT', FitFile.isFit(got2.buffer) && got2.from === 'original');
  const got1 = await Intervals.downloadFit('i1', 'k');
  check('falls back to the generated FIT when the original is a GPX', FitFile.isFit(got1.buffer) && got1.from === 'generated', calls.slice(-2).join(' '));
  let strava = null;
  try { await Intervals.downloadFit('i3', 'k'); } catch (e) { strava = e.message; }
  check('Strava-sourced activity explained', strava && /Strava/.test(strava) && /FitLab/.test(strava), strava);
  const up = await Intervals.uploadFit({ key: 'k', bytes: aOut, filename: 'x.fit', name: 'Merged' });
  check('upload posts to the athlete activities', up && up.id === 'i99' && /athlete\/0\/activities/.test(calls[calls.length - 1]));

  section('Settings shared with the siblings');
  sandbox.localStorage.setItem('cl-settings', JSON.stringify({ ftp: 301, rlUnits: 'mi', icuAthleteName: 'Someone' }));
  sandbox.localStorage.setItem('cl-icu-key', 'abc');
  vm.runInContext('Settings.set({ flTol: 2 })', sandbox);
  const stored = JSON.parse(sandbox.localStorage.getItem('cl-settings'));
  check('other tools\' keys survive a FitLab write', stored.ftp === 301 && stored.rlUnits === 'mi' && stored.flTol === 2);
  check('the shared intervals.icu key is visible', Settings.getIcuKey() === 'abc');

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log(failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
})().catch(err => { console.error(err); process.exit(1); });
