'use strict';

/**
 * FitFile.js — a lossless FIT reader and writer.
 *
 * CritLab's Fit.js decodes into the handful of channels an analyser needs and
 * throws the rest away. An editor cannot do that: a file that comes back out
 * without its device_info, HRV, developer fields (Stryd, CORE, Moxy…) or the
 * Garmin-private messages is a worse file than the one that went in. So this
 * keeps every message and every field, as raw (unscaled) values with their
 * base type and size, and writes them back the same way.
 *
 *   FitFile.decode(arrayBuffer)  → { protocol, profile, messages: [msg] }
 *   FitFile.encode(file)         → ArrayBuffer (14-byte header, CRCs)
 *
 * A message is { g, f, d, at }:
 *   g   global message number (20 = record, 19 = lap, …)
 *   f   { fieldNum: { b: baseTypeByte, s: sizeBytes, v: raw } }
 *   d   developer fields or null: { "devIdx:fieldNum": { i, n, b, s, v } }
 *   at  FIT timestamp the message belongs to — its own field 253, or for
 *       messages without one (hrv), the last timestamp before it in the file.
 *
 * Raw values: a number (or BigInt for 64-bit types) for a single value, an
 * array for array fields, a JS string for strings. Invalid sentinels are kept
 * as they are, so a field that was "invalid" in the input is invalid in the
 * output; use `get()` to read a value with the sentinel turned into null.
 *
 * Compressed-timestamp headers are expanded to an explicit field 253 and
 * big-endian definitions are rewritten little-endian; neither changes what a
 * reader sees. Everything else round-trips byte for byte in meaning.
 */
const FitFile = (() => {

  /** Seconds between the Unix epoch and the FIT epoch (1989-12-31T00:00:00Z). */
  const FIT_EPOCH = 631065600;
  /** Degrees per semicircle. */
  const SEMI = 180 / 2147483648;

  // ── Base types, indexed by (byte & 0x1F) ──────────────────────────────────
  const BASE = [
    { name: 'enum',    byte: 0x00, size: 1, inv: 0xFF },
    { name: 'sint8',   byte: 0x01, size: 1, inv: 0x7F,       min: -128, max: 127 },
    { name: 'uint8',   byte: 0x02, size: 1, inv: 0xFF,       min: 0, max: 0xFE },
    { name: 'sint16',  byte: 0x83, size: 2, inv: 0x7FFF,     min: -32768, max: 32766 },
    { name: 'uint16',  byte: 0x84, size: 2, inv: 0xFFFF,     min: 0, max: 0xFFFE },
    { name: 'sint32',  byte: 0x85, size: 4, inv: 0x7FFFFFFF, min: -2147483648, max: 2147483646 },
    { name: 'uint32',  byte: 0x86, size: 4, inv: 0xFFFFFFFF, min: 0, max: 0xFFFFFFFE },
    { name: 'string',  byte: 0x07, size: 1, inv: 0x00 },
    { name: 'float32', byte: 0x88, size: 4, inv: NaN },
    { name: 'float64', byte: 0x89, size: 8, inv: NaN },
    { name: 'uint8z',  byte: 0x0A, size: 1, inv: 0,          min: 1, max: 0xFF },
    { name: 'uint16z', byte: 0x8B, size: 2, inv: 0,          min: 1, max: 0xFFFF },
    { name: 'uint32z', byte: 0x8C, size: 4, inv: 0,          min: 1, max: 0xFFFFFFFF },
    { name: 'byte',    byte: 0x0D, size: 1, inv: 0xFF },
    { name: 'sint64',  byte: 0x8E, size: 8, inv: 0x7FFFFFFFFFFFFFFFn },
    { name: 'uint64',  byte: 0x8F, size: 8, inv: 0xFFFFFFFFFFFFFFFFn },
    { name: 'uint64z', byte: 0x90, size: 8, inv: 0n },
  ];
  const T = {};
  for (const b of BASE) T[b.name] = b.byte;
  function base(b) { return BASE[b & 0x1F] || BASE[13]; }

  // ── Names, for people (the codec itself never needs them) ─────────────────
  const MESG = {
    0: 'file_id', 2: 'device_settings', 3: 'user_profile', 7: 'zones_target', 12: 'sport',
    18: 'session', 19: 'lap', 20: 'record', 21: 'event', 23: 'device_info', 34: 'activity',
    49: 'file_creator', 78: 'hrv', 101: 'length', 104: 'device_aux_battery_info',
    160: 'gps_metadata', 206: 'field_description', 207: 'developer_data_id',
    216: 'time_in_zone', 285: 'jump', 290: 'beat_intervals', 297: 'respiration_rate',
  };

  /** Record fields: name, unit, scale, offset (value = raw / scale - offset). */
  const RECORD = {
    0:   { n: 'Latitude', u: '°', s: 1 / SEMI },
    1:   { n: 'Longitude', u: '°', s: 1 / SEMI },
    2:   { n: 'Altitude', u: 'm', s: 5, o: 500 },
    3:   { n: 'Heart rate', u: 'bpm' },
    4:   { n: 'Cadence', u: 'rpm' },
    5:   { n: 'Distance', u: 'm', s: 100 },
    6:   { n: 'Speed', u: 'm/s', s: 1000 },
    7:   { n: 'Power', u: 'W' },
    9:   { n: 'Grade', u: '%', s: 100 },
    10:  { n: 'Resistance' },
    13:  { n: 'Temperature', u: '°C' },
    18:  { n: 'Cycles' },
    19:  { n: 'Total cycles' },
    28:  { n: 'Compressed accumulated power' },
    29:  { n: 'Accumulated power', u: 'J' },
    30:  { n: 'Left/right balance' },
    31:  { n: 'GPS accuracy', u: 'm' },
    32:  { n: 'Vertical speed', u: 'm/s', s: 1000 },
    33:  { n: 'Calories', u: 'kcal' },
    39:  { n: 'Vertical oscillation', u: 'mm', s: 10 },
    40:  { n: 'Stance time %', s: 100 },
    41:  { n: 'Stance time', u: 'ms', s: 10 },
    42:  { n: 'Activity type' },
    43:  { n: 'Left torque effectiveness', s: 2 },
    44:  { n: 'Right torque effectiveness', s: 2 },
    45:  { n: 'Left pedal smoothness', s: 2 },
    46:  { n: 'Right pedal smoothness', s: 2 },
    47:  { n: 'Combined pedal smoothness', s: 2 },
    53:  { n: 'Fractional cadence', s: 128 },
    54:  { n: 'Total haemoglobin', s: 100 },
    57:  { n: 'Saturated haemoglobin %', s: 10 },
    62:  { n: 'Device index' },
    67:  { n: 'Left platform centre offset', u: 'mm' },
    68:  { n: 'Right platform centre offset', u: 'mm' },
    69:  { n: 'Left power phase' },
    70:  { n: 'Left power phase peak' },
    71:  { n: 'Right power phase' },
    72:  { n: 'Right power phase peak' },
    73:  { n: 'Speed (enhanced)', u: 'm/s', s: 1000 },
    78:  { n: 'Altitude (enhanced)', u: 'm', s: 5, o: 500 },
    81:  { n: 'Battery', u: '%', s: 2 },
    82:  { n: 'Motor power', u: 'W' },
    83:  { n: 'Vertical ratio', s: 100 },
    84:  { n: 'Stance time balance', s: 100 },
    85:  { n: 'Step length', u: 'mm', s: 10 },
    87:  { n: 'Cycle length', u: 'm', s: 100 },
    90:  { n: 'Performance condition' },
    91:  { n: 'Absolute pressure', u: 'Pa' },
    99:  { n: 'Respiration rate', u: 'br/min' },
    108: { n: 'Respiration rate (enhanced)', u: 'br/min', s: 100 },
    114: { n: 'Grit' },
    115: { n: 'Flow' },
    116: { n: 'Stress', s: 100 },
    117: { n: 'E-bike range', u: 'km' },
    118: { n: 'E-bike battery', u: '%' },
    119: { n: 'E-bike assist mode' },
    120: { n: 'E-bike assist level', u: '%' },
    127: { n: 'Ascent rate', u: 'm/s', s: 1000 },
    139: { n: 'Core temperature', u: '°C', s: 100 },
    253: { n: 'Timestamp' },
  };

  // ── CRC (FIT spec, nibble-wise) ───────────────────────────────────────────
  const CRC_TABLE = [
    0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401,
    0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400,
  ];
  function crc16(bytes, from, to, crc = 0) {
    for (let i = from; i < to; i++) {
      const b = bytes[i];
      let tmp = CRC_TABLE[crc & 0xF];
      crc = (crc >> 4) & 0x0FFF;
      crc = crc ^ tmp ^ CRC_TABLE[b & 0xF];
      tmp = CRC_TABLE[crc & 0xF];
      crc = (crc >> 4) & 0x0FFF;
      crc = crc ^ tmp ^ CRC_TABLE[(b >> 4) & 0xF];
    }
    return crc;
  }

  // ── Decoding ──────────────────────────────────────────────────────────────

  const utf8 = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8', { fatal: false }) : null;

  function readOne(dv, p, bt, le) {
    switch (bt.name) {
      case 'sint8': return dv.getInt8(p);
      case 'sint16': return dv.getInt16(p, le);
      case 'uint16': case 'uint16z': return dv.getUint16(p, le);
      case 'sint32': return dv.getInt32(p, le);
      case 'uint32': case 'uint32z': return dv.getUint32(p, le);
      case 'float32': return dv.getFloat32(p, le);
      case 'float64': return dv.getFloat64(p, le);
      case 'sint64': return dv.getBigInt64(p, le);
      case 'uint64': case 'uint64z': return dv.getBigUint64(p, le);
      default: return dv.getUint8(p);
    }
  }

  function readValue(dv, pos, size, b, le) {
    const bt = base(b);
    if (bt.name === 'string') {
      const bytes = new Uint8Array(dv.buffer, dv.byteOffset + pos, size);
      let end = bytes.indexOf(0);
      if (end < 0) end = size;
      return utf8 ? utf8.decode(bytes.subarray(0, end)) : String.fromCharCode.apply(null, bytes.subarray(0, end));
    }
    // A size that isn't a multiple of the type width is malformed; read it as bytes.
    if (size % bt.size !== 0) {
      const out = [];
      for (let k = 0; k < size; k++) out.push(dv.getUint8(pos + k));
      return out;
    }
    const count = size / bt.size;
    if (count === 1) return readOne(dv, pos, bt, le);
    const out = new Array(count);
    for (let k = 0; k < count; k++) out[k] = readOne(dv, pos + k * bt.size, bt, le);
    return out;
  }

  function readHeader(dv, at) {
    if (at + 12 > dv.byteLength) return null;
    const size = dv.getUint8(at);
    if (size < 12) return null;
    if (String.fromCharCode(dv.getUint8(at + 8), dv.getUint8(at + 9), dv.getUint8(at + 10), dv.getUint8(at + 11)) !== '.FIT') return null;
    return { size, protocol: dv.getUint8(at + 1), profile: dv.getUint16(at + 2, true), dataSize: dv.getUint32(at + 4, true) };
  }

  /** True when the bytes start with a FIT header. */
  function isFit(buffer) {
    try { return !!readHeader(new DataView(buffer), 0); } catch (_) { return false; }
  }

  /**
   * Decode every message in a FIT file. Chained files (several FIT segments
   * back to back) come out as one message list.
   */
  function decode(buffer) {
    const dv = new DataView(buffer);
    if (dv.byteLength < 12) throw new Error('This file is too small to be a FIT file.');
    const first = readHeader(dv, 0);
    if (!first) throw new Error('This is not a FIT file (there is no .FIT signature).');

    const out = { protocol: first.protocol, profile: first.profile, messages: [], truncated: false, crcOk: true };
    const bytes = new Uint8Array(buffer);
    let seg = 0;

    while (seg + 12 <= dv.byteLength) {
      const hdr = readHeader(dv, seg);
      if (!hdr) break;
      const start = seg + hdr.size;
      const end = Math.min(start + hdr.dataSize, dv.byteLength);
      if (start + hdr.dataSize > dv.byteLength) out.truncated = true;
      else if (start + hdr.dataSize + 2 <= dv.byteLength) {
        const want = dv.getUint16(start + hdr.dataSize, true);
        if (want !== 0 && crc16(bytes, seg, start + hdr.dataSize) !== want) out.crcOk = false;
      }

      const defs = {};
      const devDefs = {};     // "idx:num" → base type byte, from field_description
      let lastTs = null;
      let pos = start;

      try {
        while (pos < end) {
          const h = dv.getUint8(pos++);
          let local, compressedTs = null;

          if (h & 0x80) {
            local = (h >> 5) & 0x03;
            const off = h & 0x1F;
            if (lastTs !== null) {
              compressedTs = (lastTs & ~0x1F) + off;
              if (off < (lastTs & 0x1F)) compressedTs += 0x20;
            }
          } else if (h & 0x40) {
            local = h & 0x0F;
            pos++;                                        // reserved
            const le = dv.getUint8(pos++) === 0;
            const g = dv.getUint16(pos, le); pos += 2;
            const nf = dv.getUint8(pos++);
            const fields = [];
            for (let k = 0; k < nf; k++, pos += 3) fields.push({ n: dv.getUint8(pos), s: dv.getUint8(pos + 1), b: dv.getUint8(pos + 2) });
            const dev = [];
            if (h & 0x20) {
              const nd = dv.getUint8(pos++);
              for (let k = 0; k < nd; k++, pos += 3) dev.push({ n: dv.getUint8(pos), s: dv.getUint8(pos + 1), i: dv.getUint8(pos + 2) });
            }
            defs[local] = { g, le, fields, dev };
            continue;
          } else {
            local = h & 0x0F;
          }

          const def = defs[local];
          if (!def) break;                                // lost sync; keep what we have
          const msg = { g: def.g, f: {}, d: null, at: null };
          for (const fd of def.fields) {
            if (pos + fd.s > end) { pos = end; break; }
            msg.f[fd.n] = { b: fd.b, s: fd.s, v: readValue(dv, pos, fd.s, fd.b, def.le) };
            pos += fd.s;
          }
          for (const fd of def.dev) {
            if (pos + fd.s > end) { pos = end; break; }
            const key = fd.i + ':' + fd.n;
            const b = devDefs[key] != null ? devDefs[key] : T.byte;
            msg.d = msg.d || {};
            msg.d[key] = { i: fd.i, n: fd.n, b, s: fd.s, v: readValue(dv, pos, fd.s, b, def.le) };
            pos += fd.s;
          }

          if (compressedTs !== null && !msg.f[253]) msg.f[253] = { b: T.uint32, s: 4, v: compressedTs };
          const ts = msg.f[253] && typeof msg.f[253].v === 'number' && msg.f[253].v !== 0xFFFFFFFF ? msg.f[253].v : null;
          if (ts !== null) lastTs = ts;
          msg.at = ts !== null ? ts : lastTs;

          if (msg.g === 206) {
            const idx = get(msg, 0), num = get(msg, 1), bt = get(msg, 2);
            if (idx !== null && num !== null && bt !== null) devDefs[idx + ':' + num] = bt;
          }
          out.messages.push(msg);
        }
      } catch (err) {
        out.truncated = true;                           // ran off the end of a damaged file
      }

      seg = start + hdr.dataSize + 2;
      if (out.messages.length && hdr.dataSize === 0) break;
    }

    if (!out.messages.length) throw new Error('This FIT file has no messages in it.');
    return out;
  }

  // ── Encoding ──────────────────────────────────────────────────────────────

  const utf8e = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

  function strBytes(s) {
    if (utf8e) return utf8e.encode(String(s));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xFF;
    return out;
  }

  function writeOne(dv, p, bt, v) {
    switch (bt.name) {
      case 'sint8': dv.setInt8(p, v); break;
      case 'sint16': dv.setInt16(p, v, true); break;
      case 'uint16': case 'uint16z': dv.setUint16(p, v, true); break;
      case 'sint32': dv.setInt32(p, v, true); break;
      case 'uint32': case 'uint32z': dv.setUint32(p, v, true); break;
      case 'float32':
        if (Number.isNaN(v)) dv.setUint32(p, 0xFFFFFFFF, true); else dv.setFloat32(p, v, true);
        break;
      case 'float64':
        if (Number.isNaN(v)) { dv.setUint32(p, 0xFFFFFFFF, true); dv.setUint32(p + 4, 0xFFFFFFFF, true); }
        else dv.setFloat64(p, v, true);
        break;
      case 'sint64': dv.setBigInt64(p, BigInt(v), true); break;
      case 'uint64': case 'uint64z': dv.setBigUint64(p, BigInt(v), true); break;
      default: dv.setUint8(p, v & 0xFF);
    }
  }

  /** Size a field will need: strings grow to fit (FIT caps a field at 255 bytes). */
  function fieldSize(fd) {
    const bt = base(fd.b);
    if (bt.name === 'string') return Math.min(255, Math.max(fd.s || 1, strBytes(fd.v == null ? '' : fd.v).length + 1));
    if (Array.isArray(fd.v)) return fd.v.length * (fd.s % bt.size === 0 ? bt.size : 1);
    return fd.s % bt.size === 0 ? bt.size : fd.s;
  }

  function writeValue(dv, p, fd, size) {
    const bt = base(fd.b);
    if (bt.name === 'string') {
      const b = strBytes(fd.v == null ? '' : fd.v);
      for (let k = 0; k < size; k++) dv.setUint8(p + k, k < b.length && k < size - 1 ? b[k] : 0);
      return;
    }
    if (Array.isArray(fd.v)) {
      const w = size / fd.v.length;
      const one = w === bt.size ? bt : BASE[13];
      for (let k = 0; k < fd.v.length; k++) writeOne(dv, p + k * w, one, fd.v[k]);
      return;
    }
    writeOne(dv, p, size === bt.size ? bt : BASE[13], fd.v);
  }

  class Out {
    constructor() { this.buf = new Uint8Array(1 << 16); this.dv = new DataView(this.buf.buffer); this.n = 0; }
    need(k) {
      if (this.n + k <= this.buf.length) return;
      let cap = this.buf.length * 2;
      while (cap < this.n + k) cap *= 2;
      const nb = new Uint8Array(cap); nb.set(this.buf.subarray(0, this.n));
      this.buf = nb; this.dv = new DataView(nb.buffer);
    }
    u8(v) { this.need(1); this.buf[this.n++] = v; }
  }

  /**
   * Write a file. Messages are written in the order given; a definition is
   * emitted whenever a message's layout differs from what its local slot last
   * defined. Slots are reused least-recently-used, so a stream that alternates
   * record / hrv / record does not redefine on every message.
   */
  function encode(file) {
    const o = new Out();
    o.need(14);
    o.n = 14;
    const slots = [];               // [{ key, used }] per local type 0..15
    let tick = 0;
    let anyDev = false;

    for (const m of file.messages) {
      const fnums = Object.keys(m.f).map(Number).sort((a, b) => (a === 253 ? -1 : b === 253 ? 1 : a - b));
      const fs = fnums.map(n => ({ n, fd: m.f[n], size: fieldSize(m.f[n]) }));
      const ds = m.d ? Object.keys(m.d).map(k => ({ fd: m.d[k], size: fieldSize(m.d[k]) })) : [];
      if (ds.length) anyDev = true;
      const key = m.g + '|' + fs.map(x => x.n + ':' + x.size + ':' + x.fd.b).join(',') + '|' + ds.map(x => x.fd.i + ':' + x.fd.n + ':' + x.size).join(',');

      let local = slots.findIndex(s => s && s.key === key);
      if (local < 0) {
        if (slots.length < 16) local = slots.length;
        else { local = 0; for (let k = 1; k < 16; k++) if (slots[k].used < slots[local].used) local = k; }
        slots[local] = { key, used: 0 };
        o.need(6 + fs.length * 3 + 1 + ds.length * 3);
        o.u8(0x40 | (ds.length ? 0x20 : 0) | local);
        o.u8(0); o.u8(0);                                  // reserved, little-endian
        o.dv.setUint16(o.n, m.g, true); o.n += 2;
        o.u8(fs.length);
        for (const x of fs) { o.u8(x.n); o.u8(x.size); o.u8(x.fd.b); }
        if (ds.length) {
          o.u8(ds.length);
          for (const x of ds) { o.u8(x.fd.n); o.u8(x.size); o.u8(x.fd.i); }
        }
      }
      slots[local].used = ++tick;

      let len = 1;
      for (const x of fs) len += x.size;
      for (const x of ds) len += x.size;
      o.need(len);
      o.u8(local);
      for (const x of fs) { writeValue(o.dv, o.n, x.fd, x.size); o.n += x.size; }
      for (const x of ds) { writeValue(o.dv, o.n, x.fd, x.size); o.n += x.size; }
    }

    const dataSize = o.n - 14;
    const dv = o.dv, bytes = o.buf;
    dv.setUint8(0, 14);
    // Protocol 2.0 is needed for developer fields; 1.0 readers reject the bit.
    dv.setUint8(1, anyDev ? 0x20 : Math.max(0x10, file.protocol || 0x10));
    dv.setUint16(2, file.profile || 2132, true);
    dv.setUint32(4, dataSize, true);
    bytes[8] = 0x2E; bytes[9] = 0x46; bytes[10] = 0x49; bytes[11] = 0x54;   // ".FIT"
    dv.setUint16(12, crc16(bytes, 0, 12), true);
    o.need(2);
    dv.setUint16(o.n, crc16(o.buf, 0, o.n), true);
    o.n += 2;
    return o.buf.slice(0, o.n).buffer;
  }

  // ── Field access ──────────────────────────────────────────────────────────

  function isInvalid(fd) {
    if (!fd) return true;
    const bt = base(fd.b);
    const v = Array.isArray(fd.v) ? fd.v[0] : fd.v;
    if (v === null || v === undefined) return true;
    if (bt.name === 'string') return v === '';
    if (typeof v === 'number' && Number.isNaN(v)) return true;
    return v === bt.inv;
  }

  /** A field's raw value (first element of an array), or null when absent/invalid. */
  function get(m, n) {
    const fd = m.f[n];
    if (isInvalid(fd)) return null;
    const v = Array.isArray(fd.v) ? fd.v[0] : fd.v;
    return typeof v === 'bigint' ? Number(v) : v;
  }

  /** Copy of a message whose field maps can be changed without touching the original. */
  function clone(m) {
    const f = {};
    for (const k in m.f) f[k] = m.f[k];
    let d = null;
    if (m.d) { d = {}; for (const k in m.d) d[k] = m.d[k]; }
    return { g: m.g, f, d, at: m.at };
  }

  /** Clamp a raw number into the valid range of a base type. */
  function fit(b, v) {
    const bt = base(b);
    if (bt.min === undefined) return v;
    return Math.max(bt.min, Math.min(bt.max, Math.round(v)));
  }

  /** Set a scalar field on a (cloned) message, creating it with base type `b` if absent. */
  function put(m, n, raw, b) {
    const old = m.f[n];
    const bt = old ? old.b : b;
    if (bt === undefined) throw new Error('No type known for field ' + n);
    m.f[n] = { b: bt, s: base(bt).size, v: raw === null ? base(bt).inv : fit(bt, raw) };
  }

  /** The invalid value for a field of this type, sized like `fd`. */
  function invalidLike(fd) {
    const bt = base(fd.b);
    if (Array.isArray(fd.v)) return { b: fd.b, s: fd.s, v: fd.v.map(() => bt.inv) };
    return { b: fd.b, s: fd.s, v: bt.name === 'string' ? '' : bt.inv };
  }

  /** Field name for display. */
  function recordFieldName(n) { return RECORD[n] ? RECORD[n].n : 'Field ' + n; }

  /** Physical value of a record field (scale and offset applied), or null. */
  function recordValue(m, n) {
    const v = get(m, n);
    if (v === null) return null;
    const p = RECORD[n];
    if (!p) return v;
    return v / (p.s || 1) - (p.o || 0);
  }

  return {
    FIT_EPOCH, SEMI, BASE, T, MESG, RECORD,
    decode, encode, isFit, crc16,
    get, put, clone, fit, isInvalid, invalidLike, base,
    recordFieldName, recordValue,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FitFile;
