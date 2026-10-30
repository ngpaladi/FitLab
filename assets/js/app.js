'use strict';

/**
 * app.js — FitLab's UI. Holds the two file slots and the history of the
 * working file, and turns clicks into FitEdit operations.
 *
 * The working file is always history[at].file. Every operation produces a
 * new file object (FitEdit never mutates), so undo, redo and jumping back in
 * the history list are just moving `at`.
 */
const FitLabApp = (() => {
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const FIT_EPOCH = FitFile.FIT_EPOCH;

  const state = {
    base: null,          // { name, file, info, source, note }
    second: null,
    history: [],         // [{ label, file }]
    at: -1,
    sel: null,           // { a, b } FIT seconds
    offset: 0,
    modes: {},           // merge channel key → 'skip' | 'fill' | 'replace'
    tab: 'merge',
    icu: { oldest: null, list: [] },
  };
  const work = () => (state.at >= 0 ? state.history[state.at].file : null);

  // ── Formatting ───────────────────────────────────────────────────────────

  const units = () => Settings.get('flUnits') === 'mi' ? 'mi' : 'km';
  function fmtDist(m) {
    if (m === null || m === undefined || !isFinite(m)) return '–';
    return units() === 'mi' ? (m / 1609.344).toFixed(m < 16093 ? 2 : 1) : (m / 1000).toFixed(m < 10000 ? 2 : 1);
  }
  const hms = (s, h) => Timeline.hms(s, h);
  function fmtDur(s) { return s === null || s === undefined || !isFinite(s) ? '–' : hms(s, s >= 3600); }
  function fmtDate(d) {
    if (!d) return '';
    return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) + ' ' +
      d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  const clockOf = t => new Date((t + FIT_EPOCH) * 1000);

  /** "1:02:03", "62:03", "3723", "-30", "+1:00:00" → seconds (signed), or null. */
  function parseDur(str) {
    const s = String(str || '').trim().replace(/−/g, '-');
    if (!s) return null;
    const m = /^([+-]?)(\d+(?:\.\d+)?)(?::(\d{1,2}))?(?::(\d{1,2}))?$/.exec(s);
    if (!m) return null;
    const parts = [m[2], m[3], m[4]].filter(x => x !== undefined).map(Number);
    let sec = 0;
    for (const p of parts) sec = sec * 60 + p;
    return m[1] === '-' ? -sec : sec;
  }

  function say(id, kind, msg) {
    const el = $(id);
    if (!el) return;
    el.innerHTML = msg ? '<div class="status status-' + kind + '">' + msg + '</div>' : '';
  }

  function busy(msg, sub) {
    $('busy').hidden = !msg;
    if (msg) { $('busy-msg').textContent = msg; $('busy-sub').textContent = sub || ''; }
  }
  // Let the overlay paint before a long synchronous operation.
  const yieldFrame = () => new Promise(r => setTimeout(r, 0));

  async function run(label, statusId, fn) {
    busy(label);
    await yieldFrame();
    try { return await fn(); }
    catch (err) { say(statusId, 'err', esc(err.message || err)); console.error(err); return null; }
    finally { busy(null); }
  }

  // ── Loading ──────────────────────────────────────────────────────────────

  function loadBuffer(slot, buffer, name, source = {}) {
    const dec = FitFile.decode(buffer);
    const file = FitEdit.prepare(dec);
    const info = FitEdit.describe(file);
    const warn = [];
    if (dec.truncated) warn.push('The file ends early (truncated); everything up to the damage was read.');
    if (!dec.crcOk) warn.push('The checksum doesn\'t match; the file may be damaged.');
    if (source.note) warn.push(source.note);
    const entry = { name: String(name || 'activity').replace(/\.fit$/i, ''), file, info, source, warn };

    if (slot === 'base') {
      state.base = entry;
      state.history = [{ label: 'Opened ' + entry.name, file }];
      state.at = 0;
      state.sel = null;
      timeline.setSelection(null);
      $('out-name').value = entry.name + '-fitlab';
      if (state.second) alignAuto(true);
    } else {
      state.second = entry;
      state.modes = {};
      state.offset = 0;
      if (work()) alignAuto(true);
    }
    render();
    return entry;
  }

  async function loadFile(slot, f) {
    say('file-status', '', '');
    await run('Reading ' + f.name + '…', 'file-status', async () => {
      const buf = await f.arrayBuffer();
      loadBuffer(slot, buf, f.name, { kind: 'file' });
    });
  }

  function nextSlot() { return state.base ? 'second' : 'base'; }

  async function loadDemo() {
    await run('Writing the sample files…', 'file-status', async () => {
      loadBuffer('base', Demo.base(), 'Sample head unit', { kind: 'demo' });
      loadBuffer('second', Demo.second(), 'Sample power meter', { kind: 'demo' });
      setTab('merge');
      say('file-status', 'info', 'Two recordings of one ride: a head unit with GPS and heart rate, and a power meter on a phone app whose clock is a few seconds off. Merge brings the power across; the six-minute café stop at 25:00 is there to pause.');
    });
  }

  function swap() {
    if (!state.base || !state.second) return;
    const b = state.base, s = state.second;
    state.second = null;
    loadEntry('base', s);
    state.second = b; state.modes = {};
    alignAuto(true);
    render();
  }
  function loadEntry(slot, e) {
    if (slot === 'base') {
      state.base = e;
      state.history = [{ label: 'Opened ' + e.name, file: e.file }];
      state.at = 0; state.sel = null; timeline.setSelection(null);
      $('out-name').value = e.name + '-fitlab';
    }
  }

  function clearSlot(slot) {
    if (slot === 'base') { state.base = null; state.history = []; state.at = -1; state.sel = null; timeline.setSelection(null); }
    else { state.second = null; state.offset = 0; state.modes = {}; }
    render();
  }

  // ── History ──────────────────────────────────────────────────────────────

  function commit(label, file) {
    state.history = state.history.slice(0, state.at + 1).concat({ label, file });
    state.at = state.history.length - 1;
    // A selection that no longer fits the file is dropped.
    if (state.sel) {
      const r = FitEdit.range(file);
      if (state.sel.b < r.t0 || state.sel.a > r.t1) { state.sel = null; timeline.setSelection(null); }
    }
    render();
  }
  function jump(i) {
    if (i < 0 || i >= state.history.length) return;
    state.at = i;
    render();
  }

  // ── Rendering ────────────────────────────────────────────────────────────

  function chips(info) {
    return '<div class="slot-chans">' + info.channels.slice(0, 12).map(c => '<span class="chan-chip">' + esc(c.label) + '</span>').join('') + '</div>';
  }

  function renderSlot(slot) {
    const e = state[slot];
    const body = $('slot-' + slot + '-body');
    const box = $('slot-' + slot);
    box.querySelector('[data-clear]').hidden = !e;
    const sw = box.querySelector('[data-swap]');
    if (sw) sw.hidden = !(e && state.base);
    if (!e) {
      body.innerHTML = slot === 'base'
        ? '<p class="hint">The reference: its clock, laps and session are the workout\'s.</p>'
        : '<p class="hint">Optional. Channels to bring in by timestamp, or a ride to append.</p>';
      return;
    }
    const i = e.info;
    body.innerHTML =
      '<div class="slot-name" title="' + esc(e.name) + '">' + esc(e.name) + '</div>' +
      '<div class="slot-meta">' + esc(fmtDate(i.start)) + '<br>' + fmtDur(i.t1 - i.t0) +
      (i.distance ? ' · ' + fmtDist(i.distance) + ' ' + units() : '') + (i.device ? ' · ' + esc(i.device) : '') +
      (e.source.icuId ? ' · <a href="https://intervals.icu/activities/' + esc(e.source.icuId) + '" target="_blank" rel="noopener">intervals.icu ↗</a>' : '') + '</div>' +
      chips(i) + e.warn.map(w => '<div class="slot-warn">' + esc(w) + '</div>').join('');
  }

  function stat(label, val, unit, delta) {
    return '<div class="wstat"><div class="wstat-val">' + val + (unit ? '<span class="unit">' + unit + '</span>' : '') + '</div>' +
      '<div class="wstat-label">' + label + '</div>' + (delta ? '<div class="wstat-delta">' + delta + '</div>' : '') + '</div>';
  }

  function renderStats() {
    const f = work();
    if (!f) { $('work-stats').innerHTML = '<span class="hint">Open a .fit file to begin.</span>'; return; }
    const d = FitEdit.describe(f), o = state.history[0] && FitEdit.describe(state.history[0].file);
    const changed = state.at > 0;
    const dd = (a, b, fmt) => (changed && a !== null && b !== null && Math.round(a) !== Math.round(b) ? 'was ' + fmt(b) : '');
    $('work-stats').innerHTML =
      stat('Start', esc(d.start ? d.start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '–'), '') +
      stat('Elapsed', fmtDur(d.elapsed), '', dd(d.elapsed, o.elapsed, fmtDur)) +
      stat('Moving', fmtDur(d.timer), '', dd(d.timer, o.timer, fmtDur)) +
      stat('Distance', fmtDist(d.distance), units(), dd(d.distance, o.distance, x => fmtDist(x) + ' ' + units())) +
      (d.avgPower !== null ? stat('Avg power', d.avgPower, 'W') : '') +
      (d.np !== null ? stat('NP', d.np, 'W') : '') +
      (d.avgHr !== null ? stat('Avg HR', d.avgHr, 'bpm') : '') +
      (d.ascent !== null ? stat('Climbing', Math.round(units() === 'mi' ? d.ascent * 3.28084 : d.ascent), units() === 'mi' ? 'ft' : 'm') : '') +
      stat('Laps', d.laps, '');
  }

  let workSeries = null, secondSeries = null;
  function renderCharts() {
    const f = work();
    $('empty-state').hidden = !!f;
    if (!f) { timeline.setData(null); trackmap.setData(null); $('map-wrap').hidden = true; return; }
    workSeries = FitEdit.series(f);
    secondSeries = state.second ? FitEdit.series(state.second.file) : null;
    const laps = f.messages.filter(m => m.g === 19).map(m => FitFile.get(m, 2)).filter(x => x !== null);
    timeline.setData({ work: workSeries, second: secondSeries, offset: state.offset, pauses: FitEdit.pauses(f), laps });
    trackmap.setData({ work: workSeries, second: secondSeries });
    const show = trackmap.hasTrack();
    const was = $('map-wrap').hidden;
    $('map-wrap').hidden = !show;
    if (show && was) trackmap.resize();
    timeline.resize();
    $('map-legend').innerHTML = show ? '<span style="color:var(--st-good)">●</span> start &nbsp; <span style="color:var(--st-critical)">●</span> finish' +
      (trackmap.secondHasTrack() ? ' &nbsp; <span style="color:var(--second)">┅</span> second file' : '') : '';
  }

  function renderSelection() {
    const f = work(), sel = state.sel;
    const t0 = f ? FitEdit.range(f).t0 : 0;
    const active = document.activeElement;
    if (active !== $('sel-from')) $('sel-from').value = sel ? hms(sel.a - t0, true) : '';
    if (active !== $('sel-to')) $('sel-to').value = sel ? hms(sel.b - t0, true) : '';
    $('sel-clear').hidden = !sel;
    $('zoom-sel').hidden = !sel;
    if (sel && workSeries) {
      const S = workSeries;
      const idx = t => { let lo = 0, hi = S.n - 1, a = 0; while (lo <= hi) { const m = (lo + hi) >> 1; if (S.t[m] <= t) { a = m; lo = m + 1; } else hi = m - 1; } return a; };
      const ia = idx(sel.a), ib = idx(sel.b);
      const d = S.dist[ib] - S.dist[ia];
      let p = 0, n = 0;
      for (let i = ia; i <= ib; i++) if (S.power[i] === S.power[i]) { p += S.power[i]; n++; }
      $('sel-info').textContent = fmtDur(sel.b - sel.a) + (d === d ? ' · ' + fmtDist(d) + ' ' + units() : '') + (n ? ' · ' + Math.round(p / n) + ' W' : '') +
        ' · ' + clockOf(sel.a).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + '–' +
        clockOf(sel.b).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } else $('sel-info').textContent = f ? 'Drag across the chart to select' : '';
    document.querySelectorAll('[data-needs-sel]').forEach(b => { b.disabled = !sel || !f; });
    trackmap.setSelection(sel);
  }

  const MODE_LABEL = { skip: 'Skip', fill: 'Fill gaps', replace: 'Replace' };
  function renderMerge() {
    const ok = !!(work() && state.second);
    $('merge-need').hidden = ok;
    $('merge-need').textContent = !work() ? 'Open a base file first.' : 'Open a second file to merge from.';
    $('merge-body').hidden = !ok;
    if (!ok) return;
    if (document.activeElement !== $('offset')) $('offset').value = state.offset;
    const o = state.offset;
    $('offset-note').textContent = o === 0 ? 'Both clocks taken as right.'
      : 'The second file\'s clock is taken to be ' + Math.abs(o) + ' s ' + (o > 0 ? 'behind' : 'ahead of') + ' the base.';
    const baseCh = FitEdit.channels(work()), n = FitEdit.records(work()).length, n2 = state.second.info.records;
    const rows = FitEdit.channels(state.second.file).map(c => {
      const b = baseCh.find(x => x.key === c.key);
      if (!(c.key in state.modes)) state.modes[c.key] = b ? 'skip' : 'fill';
      const pct = (x, of) => (x ? Math.round(100 * x / of) + '%' : '–');
      return '<tr class="' + (b ? 'chan-same' : 'chan-new') + '"><td>' + esc(c.label) + '</td><td class="dim">' + pct(b && b.count, n) + '</td><td>' + pct(c.count, n2) + '</td>' +
        '<td><select data-chan="' + esc(c.key) + '" aria-label="' + esc(c.label) + '">' +
        Object.keys(MODE_LABEL).map(k => '<option value="' + k + '"' + (state.modes[c.key] === k ? ' selected' : '') + '>' + MODE_LABEL[k] + '</option>').join('') +
        '</select></td></tr>';
    });
    $('chan-rows').innerHTML = rows.join('') || '<tr><td colspan="4" class="table-empty">The second file has no channels to bring in</td></tr>';
    $('merge-btn').disabled = !Object.values(state.modes).some(m => m !== 'skip');
  }

  function renderSplice() {
    const ok = !!(work() && state.second);
    $('splice-need').hidden = ok;
    $('splice-need').textContent = !work() ? 'Open a base file first.' : 'Open a second file to append.';
    $('splice-body').hidden = !ok;
    if (!ok) return;
    const a = FitEdit.range(work()), b = FitEdit.range(state.second.file);
    const gap = b.t0 - a.t1;
    $('splice-note').textContent = gap > 0
      ? 'The second file starts ' + fmtDur(gap) + ' after the base ends.'
      : 'The two overlap by ' + fmtDur(-gap) + ', so keeping real times won\'t work: use Merge for two recordings of the same ride, or move the second file to follow on.';
  }

  const SPORT_LABEL = {
    'cycling': 'Cycling', 'cycling/road': 'Road cycling', 'cycling/gravel': 'Gravel', 'cycling/mountain': 'Mountain biking',
    'cycling/cyclocross': 'Cyclocross', 'cycling/indoor': 'Indoor cycling', 'cycling/virtual': 'Virtual ride', 'cycling/track': 'Track cycling',
    'running': 'Running', 'running/trail': 'Trail running', 'running/treadmill': 'Treadmill', 'walking': 'Walking', 'hiking': 'Hiking',
    'e_biking': 'E-bike', 'rowing': 'Rowing', 'swimming/open_water': 'Open-water swim', 'generic': 'Generic',
  };

  function renderMore() {
    const f = work();
    $('strip-btn').disabled = $('clean-btn').disabled = $('sport-btn').disabled = !f;
    if (!f) { $('strip-list').innerHTML = '<span class="hint">No file open.</span>'; $('file-info').innerHTML = ''; return; }
    $('strip-list').innerHTML = FitEdit.channels(f).map(c =>
      '<label class="check"><input type="checkbox" data-strip="' + esc(c.key) + '"><span>' + esc(c.label) + '</span></label>').join('');
    const cur = FitEdit.sportOf(f);
    $('sport-sel').innerHTML = Object.keys(FitEdit.SPORTS).map(k => '<option value="' + k + '"' + (k === cur ? ' selected' : '') + '>' + SPORT_LABEL[k] + '</option>').join('');
    const d = FitEdit.describe(f);
    const names = FitFile.MESG;
    const counts = Object.entries(d.counts).sort((a, b) => b[1] - a[1])
      .map(([g, n]) => '<tr><td>' + esc(names[g] || 'message ' + g) + '</td><td>' + n + '</td></tr>').join('');
    const devs = Object.values(FitEdit.devNames(f)).map(x => esc(x.name + (x.units ? ' (' + x.units + ')' : '')));
    const issues = FitEdit.check(f);
    $('file-info').innerHTML =
      (d.device ? 'Recorded by <b>' + esc(d.device) + '</b>. ' : '') + d.records + ' samples, ' + d.laps + ' lap' + (d.laps === 1 ? '' : 's') +
      ', ' + d.pauses.length + ' pause' + (d.pauses.length === 1 ? '' : 's') + '.' +
      (devs.length ? '<br>Developer fields: ' + devs.join(', ') + '.' : '') +
      (issues.length ? '<div class="status status-warn">' + issues.map(esc).join('<br>') + '</div>' : '') +
      '<table class="data file-info-table"><tbody>' + counts + '</tbody></table>';
  }

  function renderHistory() {
    const h = state.history;
    $('history-list').innerHTML = h.length
      ? h.map((x, i) => '<li data-hist="' + i + '" class="' + (i === state.at ? 'current' : i > state.at ? 'future' : '') + '"><span class="hn">' + (i + 1) + '</span><span>' + esc(x.label) + '</span></li>').join('')
      : '<li class="hint">Nothing yet</li>';
    $('undo-btn').disabled = state.at <= 0;
    $('redo-btn').disabled = state.at >= h.length - 1;
    $('revert-btn').disabled = state.at <= 0;
  }

  function renderExport() {
    const f = work(), on = !!Settings.getIcuKey();
    $('download-btn').disabled = !f;
    $('upload-btn').hidden = !on;
    $('upload-btn').disabled = !f;
  }

  function renderIcu() {
    const on = !!Settings.getIcuKey();
    $('icu-connect').style.display = on ? 'none' : '';
    $('icu-panel').style.display = on ? '' : 'none';
    const name = Settings.get('icuAthleteName');
    $('icu-who').textContent = on ? 'Connected' + (name ? ' as ' + name : '') + '. Pick an activity as the base or the second file.' : '';
  }

  function render() {
    renderSlot('base'); renderSlot('second');
    renderStats(); renderCharts(); renderSelection();
    renderMerge(); renderSplice(); renderMore(); renderHistory(); renderExport();
  }

  // ── Selection ────────────────────────────────────────────────────────────

  function setSel(sel, fromChart) {
    state.sel = sel && sel.b > sel.a ? { a: Math.round(sel.a), b: Math.round(sel.b) } : null;
    if (!fromChart) timeline.setSelection(state.sel);
    renderSelection();
  }

  function selFromInputs() {
    const f = work();
    if (!f) return;
    const t0 = FitEdit.range(f).t0;
    const a = parseDur($('sel-from').value), b = parseDur($('sel-to').value);
    if (a === null || b === null) return;
    setSel({ a: t0 + Math.min(a, b), b: t0 + Math.max(a, b) });
  }

  // ── Tools ────────────────────────────────────────────────────────────────

  function setTab(tab) {
    state.tab = tab;
    document.querySelectorAll('#tool-tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.tool-panel').forEach(p => { p.hidden = p.dataset.panel !== tab; });
  }

  function alignAuto(quiet) {
    if (!work() || !state.second) return;
    const est = FitEdit.estimateOffset(work(), state.second.file);
    const what = { power: 'power', cad: 'cadence', speed: 'speed', hr: 'heart rate', moving: 'when you stopped and started' };
    if (est) {
      state.offset = est.offset;
      say('merge-status', 'ok', 'Lined up on ' + what[est.channel] + ': ' + (est.offset === 0 ? 'the clocks agree.' :
        'the second file\'s clock is ' + Math.abs(est.offset) + ' s ' + (est.offset > 0 ? 'behind' : 'ahead') + '.') +
        (est.score < 0.6 ? ' The match is weak; check the traces agree and nudge if not.' : ''));
    } else if (!quiet) {
      say('merge-status', 'warn', 'Couldn\'t find anything the two files share to line them up on. Set the offset by eye: nudge until the traces agree.');
    } else say('merge-status', '', '');
    renderMerge();
    renderCharts();
  }

  function setOffset(v) {
    state.offset = Math.max(-86400, Math.min(86400, Math.round(v) || 0));
    renderMerge();
    if (workSeries) timeline.setData({ work: workSeries, second: secondSeries, offset: state.offset, pauses: FitEdit.pauses(work()), laps: work().messages.filter(m => m.g === 19).map(m => FitFile.get(m, 2)) });
  }

  async function doMerge() {
    const chans = {};
    for (const [k, m] of Object.entries(state.modes)) if (m !== 'skip') chans[k] = m;
    const labels = FitEdit.channels(state.second.file).filter(c => chans[c.key]).map(c => c.label.toLowerCase());
    await run('Merging…', 'merge-status', () => {
      const out = FitEdit.merge(work(), state.second.file, {
        offset: state.offset, channels: chans, tol: Settings.get('flTol'), bridge: Settings.get('flBridge'),
      });
      const n = FitEdit.records(out).length;
      const per = Object.entries(out.mergeStats.perChannel).map(([k, c]) => {
        const lab = (FitEdit.channels(state.second.file).find(x => x.key === k) || { label: k }).label;
        return esc(lab) + ' on ' + Math.round(100 * c / n) + '% of samples';
      });
      commit('Merged ' + labels.join(', ') + ' from ' + state.second.name, out);
      for (const k of Object.keys(chans)) state.modes[k] = 'skip';
      renderMerge();
      say('merge-status', per.length ? 'ok' : 'warn', per.length ? 'Brought in ' + per.join('; ') + '.' : 'Nothing was brought in: the files don\'t overlap at this offset.');
    });
  }

  function needSel(statusId) {
    if (!state.sel) { say(statusId, 'warn', 'Select a stretch on the chart first.'); return false; }
    return true;
  }
  const span = () => fmtDur(state.sel.b - state.sel.a);

  async function doEdit(kind) {
    if (!needSel('edit-status')) return;
    const { a, b } = state.sel;
    const f = work(), t0 = FitEdit.range(f).t0;
    const where = hms(a - t0, true) + '–' + hms(b - t0, true);
    await run('Working…', 'edit-status', () => {
      let out, label;
      if (kind === 'crop') { out = FitEdit.crop(f, a, b); label = 'Cropped to ' + where; }
      else if (kind === 'pause') { out = FitEdit.pause(f, a, b, { dropDistance: $('pause-dist').checked }); label = 'Paused ' + where; }
      else if (kind === 'cut') { out = FitEdit.cut(f, a, b, { dropDistance: $('cut-dist').checked }); label = 'Cut ' + where; }
      else { out = FitEdit.erase(f, a, b); label = 'Deleted samples ' + where; }
      const len = span();
      commit(label, out);
      setSel(null);
      timeline.resetView();
      say('edit-status', 'ok', { crop: 'Cropped to ' + len + '.', pause: len + ' paused; moving time leaves it out.', cut: len + ' cut out and the gap closed.', erase: 'Samples deleted.' }[kind]);
    });
  }

  async function doShift() {
    const s = parseDur($('shift-by').value);
    if (s === null || !s) { say('edit-status', 'warn', 'Type a shift like +1:00:00, -30 or 3600.'); return; }
    await run('Shifting…', 'edit-status', () => {
      commit('Shifted the clock ' + (s > 0 ? '+' : '−') + fmtDur(Math.abs(s)), FitEdit.shift(work(), s));
      // The second file was lined up with the old clock; keep it lined up.
      if (state.second) state.offset += s;
      say('edit-status', 'ok', 'Every timestamp moved ' + (s > 0 ? 'later' : 'earlier') + ' by ' + fmtDur(Math.abs(s)) + '.');
    });
  }

  async function doSplice() {
    const close = document.querySelector('input[name="splice-gap"]:checked').value === 'close';
    const gap = close ? Math.max(1, parseInt($('splice-secs').value, 10) || 1) : null;
    await run('Splicing…', 'splice-status', () => {
      const out = FitEdit.splice(work(), state.second.file, { gap });
      commit('Appended ' + state.second.name, out);
      timeline.resetView();
      say('splice-status', 'ok', 'Appended. One session now covers both, with ' + FitEdit.describe(out).laps + ' laps.');
    });
  }

  async function doStrip() {
    const keys = [...document.querySelectorAll('[data-strip]:checked')].map(x => x.dataset.strip);
    if (!keys.length) { say('more-status', 'warn', 'Tick the channels to remove.'); return; }
    const labels = FitEdit.channels(work()).filter(c => keys.includes(c.key)).map(c => c.label.toLowerCase());
    await run('Removing…', 'more-status', () => {
      commit('Removed ' + labels.join(', '), FitEdit.strip(work(), keys));
      say('more-status', 'ok', 'Removed ' + esc(labels.join(', ')) + '.');
    });
  }

  async function doClean() {
    const p = parseFloat($('clean-power').value), h = parseFloat($('clean-hr').value);
    if (!isFinite(p) && !isFinite(h)) { say('more-status', 'warn', 'Set a power or heart-rate limit.'); return; }
    const opts = { maxPower: isFinite(p) ? p : null, maxHr: isFinite(h) ? h : null };
    if ($('clean-sel').checked) { if (!needSel('more-status')) return; opts.a = state.sel.a; opts.b = state.sel.b; }
    await run('Clearing…', 'more-status', () => {
      const out = FitEdit.clean(work(), opts);
      if (!out.cleaned) { say('more-status', 'info', 'Nothing was over the limit.'); return; }
      commit('Cleared ' + out.cleaned + ' spike' + (out.cleaned === 1 ? '' : 's'), out);
      say('more-status', 'ok', out.cleaned + ' value' + (out.cleaned === 1 ? '' : 's') + ' blanked.');
    });
  }

  function doSport() {
    const k = $('sport-sel').value;
    commit('Sport set to ' + SPORT_LABEL[k], FitEdit.setSport(work(), k));
    say('more-status', 'ok', 'Sport set to ' + esc(SPORT_LABEL[k]) + '.');
  }

  // ── Export ───────────────────────────────────────────────────────────────

  function outName() {
    const n = ($('out-name').value || (state.base ? state.base.name + '-fitlab' : 'activity')).trim().replace(/[\\/:*?"<>|]+/g, '-');
    return /\.fit$/i.test(n) ? n : n + '.fit';
  }

  function bytes() {
    const f = work();
    const issues = FitEdit.check(f);
    return { buf: FitFile.encode(f), issues };
  }

  function download() {
    if (!work()) return;
    const { buf, issues } = bytes();
    const blob = new Blob([buf], { type: 'application/vnd.ant.fit' });
    const name = outName();
    if (typeof URL !== 'undefined' && URL.createObjectURL) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    }
    state.lastExport = { name, size: buf.byteLength };
    say('export-status', issues.length ? 'warn' : 'ok', 'Saved ' + esc(name) + ' (' + Math.round(buf.byteLength / 1024) + ' KB).' + (issues.length ? ' ' + issues.map(esc).join(' ') : ''));
  }

  async function upload() {
    if (!work()) return;
    if (!confirm('Upload this as a new activity on intervals.icu?\n\nIf the original recordings are already there, intervals.icu may treat this as a duplicate of them. To end up with just the combined ride, delete the originals there first.')) return;
    const { buf } = bytes();
    await run('Uploading to intervals.icu…', 'export-status', async () => {
      const name = outName().replace(/\.fit$/i, '');
      const r = await Intervals.uploadFit({ key: Settings.getIcuKey(), athleteId: Settings.get('icuAthlete') || '0', bytes: buf, filename: outName(), name });
      const id = r && (r.id || (Array.isArray(r.activities) && r.activities[0] && r.activities[0].id));
      say('export-status', 'ok', 'Uploaded.' + (id ? ' <a href="https://intervals.icu/activities/' + esc(id) + '" target="_blank" rel="noopener">Open it on intervals.icu ↗</a>' : ''));
    });
  }

  // ── intervals.icu ────────────────────────────────────────────────────────

  const ymd = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

  async function icuFetch(more) {
    const key = Settings.getIcuKey();
    if (!key) return;
    const days = Settings.get('flIcuDays') || 14;
    const newest = more && state.icu.oldest ? new Date(state.icu.oldest.getTime() - 86400000) : new Date(Date.now() + 86400000);
    const oldest = new Date(newest.getTime() - days * 86400000);
    say('icu-status', 'info', '<span class="status-loading"></span>Fetching activities…');
    try {
      const list = await Intervals.listActivities({ key, athleteId: Settings.get('icuAthlete') || '0', oldest: ymd(oldest), newest: ymd(newest) });
      state.icu.list = more ? state.icu.list.concat(list) : list;
      state.icu.oldest = oldest;
      say('icu-status', '', '');
      renderIcuList();
    } catch (err) {
      say('icu-status', 'err', esc(err.message || err));
    }
  }

  function renderIcuList() {
    const list = state.icu.list;
    const rows = list.map(a => {
      const when = a.start ? new Date(a.start.replace(/Z?$/, '')) : null;
      const meta = [when ? when.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ' + when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '',
        a.elapsedTime ? fmtDur(a.elapsedTime) : '', a.distance ? fmtDist(a.distance) + ' ' + units() : '', a.device || ''].filter(Boolean).join(' · ');
      const dis = a.apiBlocked ? ' disabled title="Strava-sourced: intervals.icu can\'t serve it through the API"' : '';
      return '<div class="ride-item' + (a.apiBlocked ? ' blocked' : '') + '"><div class="ride-swatch"></div><div class="ride-body">' +
        '<div class="ride-name">' + esc(a.name) + '</div><div class="ride-meta">' + esc(meta) + (a.apiBlocked ? ' · Strava' : '') + '</div></div>' +
        '<div class="icu-row-actions"><button class="btn btn-sm" data-icu="' + esc(a.id) + '" data-slot="base"' + dis + '>Base</button>' +
        '<button class="btn btn-sm" data-icu="' + esc(a.id) + '" data-slot="second"' + dis + '>2nd</button></div></div>';
    });
    $('icu-list').innerHTML = (rows.join('') || '<div class="list-empty">No activities in this window</div>') +
      '<button class="btn btn-sm icu-more" id="icu-more">Older…</button>';
  }

  async function icuLoad(id, slot) {
    const key = Settings.getIcuKey();
    const meta = state.icu.list.find(a => String(a.id) === String(id));
    say('icu-status', '', '');
    await run('Downloading from intervals.icu…', 'icu-status', async () => {
      const got = await Intervals.downloadFit(id, key);
      const note = got.from === 'generated'
        ? 'intervals.icu didn\'t have the original as a FIT (it was a GPX or TCX), so this is its own FIT version: device details and developer fields may be missing.'
        : null;
      loadBuffer(slot, got.buffer, meta ? meta.name : String(id), { kind: 'icu', icuId: id, note });
      if (slot === 'second') setTab('merge');
    });
  }

  // ── Getting started ──────────────────────────────────────────────────────

  const TOUR = [
    { el: '#files-section', title: 'Two files', body: '<p>The <b>base file</b> is the reference: the workout keeps its clock, laps and session. The <b>second file</b> is where extra channels come from, or a ride to append.</p><p>Drop .fit files here, or open them from intervals.icu below.</p>' },
    { el: '#icu-section', title: 'From intervals.icu', body: '<p>With your key connected (shared with CritLab, CrossLab and RouteLab), pick any recent activity as either file. The original upload is used when it\'s a FIT.</p>' },
    { el: '#timeline-wrap', title: 'The ride', body: '<p>Every channel on one time axis. The second file is drawn over the base in orange, shifted by the clock offset, so you can see when they line up.</p><p><b>Drag</b> to select a stretch, <b>wheel</b> to zoom, <b>double-click</b> for the whole ride.</p>' },
    { el: '#sel-bar', title: 'Selection', body: '<p>Or type the times. Crop, pause and cut all work on the selection.</p>' },
    { el: '#tools-section', title: 'Tools', body: '<p><b>Merge</b> brings channels across by timestamp. <b>Crop &amp; cut</b> trims, pauses a forgotten stop, or cuts out a lift. <b>Splice</b> joins two halves of a ride. <b>More</b>: remove GPS, clear spikes, change the sport.</p>' },
    { el: '#history-section', title: 'Nothing is final', body: '<p>Every step is in the history: undo, redo, or click any step to go back to it.</p>' },
    { el: '#export-section', title: 'Save', body: '<p>Download the .fit, or upload it to intervals.icu as a new activity. Laps and the session are recalculated from the samples, so the totals always match.</p>' },
  ];

  function tour() {
    Tour.start(TOUR, { onEnd: () => Settings.set({ flTourDone: true }) });
  }

  function welcome() {
    const params = new URLSearchParams(location.search);
    if (params.get('tour') === '1') { history.replaceState(null, '', location.pathname); tour(); return; }
    const s = Settings.all();
    if (!s.flWelcomeSeen) {
      Settings.set({ flWelcomeSeen: true });
      Tour.dialog({
        title: 'Welcome to FitLab',
        body: '<p>FitLab edits FIT activity files in your browser: combine two recordings of one ride into one workout, crop, pause a forgotten stop, cut out a lift, or join a ride split in two.</p>' +
          '<p>Nothing is uploaded unless you ask: files stay in this tab.' + (Settings.getIcuKey() ? ' Your intervals.icu key from the other tools is already here.' : '') + '</p>',
        actions: [
          { label: 'Try the sample files', primary: true, onClick: async () => { await loadDemo(); if (!Settings.get('flTourDone')) tour(); } },
          ...(Settings.getIcuKey() ? [] : [{ label: 'Connect intervals.icu', href: $('icu-connect-cta').getAttribute('href') }]),
          { label: 'Not now', onClick: () => {} },
        ],
      });
    }
  }

  // ── Wiring ───────────────────────────────────────────────────────────────

  let timeline, trackmap;
  let pickSlot = 'base';

  function init() {
    timeline = Timeline.create($('timeline'), {
      onSelect: sel => setSel(sel, true),
      onHover: t => trackmap.setCursor(t),
    });
    trackmap = TrackMap.create($('trackmap'));

    // Files
    document.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', () => { pickSlot = b.dataset.pick; $('file-input').click(); }));
    document.querySelectorAll('[data-clear]').forEach(b => b.addEventListener('click', () => clearSlot(b.dataset.clear)));
    document.querySelector('[data-swap]').addEventListener('click', swap);
    $('file-input').addEventListener('change', e => { const f = e.target.files[0]; if (f) loadFile(pickSlot, f); e.target.value = ''; });
    $('dropzone').addEventListener('click', () => { pickSlot = nextSlot(); $('file-input').click(); });
    $('demo-btn').addEventListener('click', loadDemo);

    const dropTargets = [['dropzone', null], ['slot-base', 'base'], ['slot-second', 'second']];
    for (const [id, slot] of dropTargets) {
      const el = $(id);
      el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('is-over'); });
      el.addEventListener('dragleave', () => el.classList.remove('is-over'));
      el.addEventListener('drop', async e => {
        e.preventDefault(); e.stopPropagation(); el.classList.remove('is-over');
        const files = [...(e.dataTransfer && e.dataTransfer.files || [])].filter(f => /\.fit$/i.test(f.name));
        if (!files.length) { say('file-status', 'warn', 'Only .fit files can be opened here.'); return; }
        if (slot) { await loadFile(slot, files[0]); return; }
        for (const f of files.slice(0, 2)) await loadFile(nextSlot(), f);
      });
    }
    // A file dropped anywhere else shouldn't navigate away from the page.
    window.addEventListener('dragover', e => e.preventDefault());
    window.addEventListener('drop', e => e.preventDefault());

    // intervals.icu
    $('icu-fetch').addEventListener('click', () => icuFetch(false));
    $('icu-list').addEventListener('click', e => {
      const b = e.target.closest('[data-icu]');
      if (b) { icuLoad(b.dataset.icu, b.dataset.slot); return; }
      if (e.target.id === 'icu-more') icuFetch(true);
    });
    const byId = slot => { const id = $('icu-id').value.trim(); if (id) icuLoad(id, slot); };
    $('icu-id-base').addEventListener('click', () => byId('base'));
    $('icu-id-second').addEventListener('click', () => byId('second'));

    // History
    $('undo-btn').addEventListener('click', () => jump(state.at - 1));
    $('redo-btn').addEventListener('click', () => jump(state.at + 1));
    $('revert-btn').addEventListener('click', () => jump(0));
    $('history-list').addEventListener('click', e => { const li = e.target.closest('[data-hist]'); if (li) jump(+li.dataset.hist); });

    // Selection
    for (const id of ['sel-from', 'sel-to']) {
      $(id).addEventListener('change', selFromInputs);
      $(id).addEventListener('keydown', e => { if (e.key === 'Enter') selFromInputs(); });
    }
    $('sel-clear').addEventListener('click', () => setSel(null));
    $('zoom-sel').addEventListener('click', () => { if (state.sel) { const pad = (state.sel.b - state.sel.a) * 0.1 + 5; timeline.setView(state.sel.a - pad, state.sel.b + pad); } });
    $('zoom-reset').addEventListener('click', () => timeline.resetView());

    // Tools
    document.querySelectorAll('#tool-tabs button').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
    $('offset').addEventListener('change', e => setOffset(parseFloat(e.target.value)));
    document.querySelectorAll('[data-nudge]').forEach(b => b.addEventListener('click', () => setOffset(state.offset + Number(b.dataset.nudge))));
    $('offset-auto').addEventListener('click', () => alignAuto(false));
    $('chan-rows').addEventListener('change', e => {
      const s = e.target.closest('[data-chan]');
      if (s) { state.modes[s.dataset.chan] = s.value; $('merge-btn').disabled = !Object.values(state.modes).some(m => m !== 'skip'); }
    });
    $('merge-btn').addEventListener('click', doMerge);
    $('crop-btn').addEventListener('click', () => doEdit('crop'));
    $('pause-btn').addEventListener('click', () => doEdit('pause'));
    $('cut-btn').addEventListener('click', () => doEdit('cut'));
    $('erase-btn').addEventListener('click', () => doEdit('erase'));
    $('shift-btn').addEventListener('click', doShift);
    $('splice-btn').addEventListener('click', doSplice);
    $('strip-btn').addEventListener('click', doStrip);
    $('clean-btn').addEventListener('click', doClean);
    $('sport-btn').addEventListener('click', doSport);

    // Export
    $('download-btn').addEventListener('click', download);
    $('upload-btn').addEventListener('click', upload);

    // Keyboard
    document.addEventListener('keydown', e => {
      const typing = /^(INPUT|SELECT|TEXTAREA)$/.test((e.target && e.target.tagName) || '');
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); jump(state.at + (e.shiftKey ? 1 : -1)); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y' && !typing) { e.preventDefault(); jump(state.at + 1); }
      else if (e.key === 'Escape' && !typing && state.sel && !(typeof Tour !== 'undefined' && Tour.isOpen())) setSel(null);
    });

    // Mobile panels
    document.querySelectorAll('.mobile-tab').forEach(b => b.addEventListener('click', () => {
      document.querySelectorAll('.mobile-tab').forEach(x => x.classList.toggle('active', x === b));
      $('app-wrap').dataset.panel = b.dataset.mpanel;
      if (b.dataset.mpanel === 'timeline') setTimeout(() => { timeline.resize(); trackmap.resize(); }, 0);
    }));

    window.addEventListener('resize', () => { timeline.resize(); trackmap.resize(); });
    window.addEventListener('fitlab:settings', e => {
      const d = e.detail || {};
      if (d.icu) { renderIcu(); renderExport(); }
      render();
    });

    renderIcu();
    render();
    welcome();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  return { state, loadBuffer, loadDemo, setSel, setOffset, setTab, work, parseDur, commit, jump, icuFetch, icuLoad, download, doMerge };
})();

window.FitLabApp = FitLabApp;
