'use strict';

/**
 * DOM test. Builds the site with Jekyll, loads the generated index.html into
 * jsdom with a recording canvas stub and a fake intervals.icu, then drives
 * the UI the way a person would: the welcome dialog and walkthrough, the
 * sample files, lining up and merging, selecting on the chart and by typing,
 * pause / crop / cut, undo, splice, strip, the intervals.icu list, download
 * and upload. Every downloaded file is checked with Garmin's decoder.
 *
 *   node test/dom.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const SITE = fs.mkdtempSync(path.join(os.tmpdir(), 'fitlab-site-'));

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  \x1b[32mok\x1b[0m   ' + name + (detail ? '  \x1b[2m' + detail + '\x1b[0m' : '')); }
  else { failed++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  \x1b[31mFAIL\x1b[0m ' + name + (detail ? '  ' + detail : '')); }
}
function section(t) { console.log('\n\x1b[1m' + t + '\x1b[0m'); }

section('Jekyll build');
try {
  execFileSync('jekyll', ['build', '--destination', SITE], { cwd: ROOT, stdio: 'pipe' });
  check('site builds', fs.existsSync(path.join(SITE, 'index.html')));
  check('about and connect pages build', fs.existsSync(path.join(SITE, 'about.html')) && fs.existsSync(path.join(SITE, 'connect.html')));
  check('CLAUDE.md, README, tests and node_modules are not published', !fs.existsSync(path.join(SITE, 'CLAUDE.md')) && !fs.existsSync(path.join(SITE, 'README.md')) &&
    !fs.existsSync(path.join(SITE, 'test')) && !fs.existsSync(path.join(SITE, 'node_modules')));
} catch (err) {
  check('site builds', false, String(err.stderr || err.message).slice(0, 300));
  process.exit(1);
}

section('Shared files match the sibling tools');
for (const [file, sib] of [['assets/js/Tour.js', 'RouteLab'], ['assets/js/Tour.js', 'CrossLab']]) {
  const other = path.join(ROOT, '..', sib, file);
  if (fs.existsSync(other)) check(file + ' is byte-identical to ' + sib + '\'s', fs.readFileSync(other, 'utf8') === fs.readFileSync(path.join(ROOT, file), 'utf8'));
  else console.log('  \x1b[2m(skipped: ' + sib + ' not checked out beside FitLab)\x1b[0m');
}

function makeContext() {
  const calls = { stroke: 0, fillText: 0, lineTo: 0 };
  const noop = () => {};
  return {
    calls, canvas: null,
    setTransform: noop, save: noop, restore: noop, translate: noop, scale: noop, rotate: noop,
    clearRect: noop, beginPath: noop, closePath: noop, moveTo: noop, lineTo: () => calls.lineTo++, arc: noop,
    rect: noop, clip: noop, fill: noop, stroke: () => calls.stroke++, fillRect: noop, strokeRect: noop,
    fillText: () => calls.fillText++, setLineDash: noop, measureText: t => ({ width: String(t).length * 6 }),
  };
}

// ── Fake intervals.icu ─────────────────────────────────────────────────────
const net = { calls: [], uploads: [] };
let fitFor = {};             // activity id → FIT bytes
function resp(status, body, json) {
  return { ok: status >= 200 && status < 300, status, text: async () => String(body), json: async () => json,
    arrayBuffer: async () => { const b = Buffer.from(body); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } };
}
async function fakeFetch(url, opts = {}) {
  net.calls.push(url);
  const u = String(url);
  if (/\/athlete\/0\/activities\?oldest=/.test(u)) {
    return resp(200, '', [
      { id: 'i101', name: 'Morning ride (head unit)', type: 'Ride', start_date_local: '2026-10-19T08:00:00', elapsed_time: 3000, distance: 22000, device_name: 'Garmin Edge 840', stream_types: ['latlng', 'heartrate'] },
      { id: 'i102', name: 'Morning ride (power app)', type: 'Ride', start_date_local: '2026-10-19T08:00:16', elapsed_time: 2900, stream_types: ['watts'] },
      { id: 'i103', name: 'From Strava', type: 'Ride', source: 'STRAVA', start_date_local: '2026-10-18T08:00:00' },
    ]);
  }
  const m = /\/activity\/(i\d+)\/file$/.exec(u);
  if (m && fitFor[m[1]]) return resp(200, zlib.gzipSync(Buffer.from(fitFor[m[1]])));
  if (/\/athlete\/0\/activities/.test(u) && opts.method === 'POST') { net.uploads.push(opts.body); return resp(200, '', { id: 'i555' }); }
  return resp(404, 'not found');
}

section('Boot');
const errors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', e => errors.push(e.message + '\n' + (e.stack || '')));
virtualConsole.on('error', (...a) => errors.push(a.map(String).join(' ')));

const html = fs.readFileSync(path.join(SITE, 'index.html'), 'utf8').replace(/(src|href)="\/FitLab\//g, '$1="');
const downloads = [];
const dom = new JSDOM(html, {
  runScripts: 'dangerously', resources: 'usable', url: require('url').pathToFileURL(path.join(SITE, 'index.html')).href,
  pretendToBeVisual: true, virtualConsole,
  beforeParse(window) {
    window.HTMLCanvasElement.prototype.getContext = function () {
      if (!this._ctx) { this._ctx = makeContext(); this._ctx.canvas = this; }
      return this._ctx;
    };
    window.Element.prototype.getBoundingClientRect = function () {
      return { x: 0, y: 0, top: 0, left: 0, right: 900, bottom: 440, width: 900, height: 440 };
    };
    Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', { get: () => 160, configurable: true });
    Object.defineProperty(window.HTMLElement.prototype, 'offsetHeight', { get: () => 60, configurable: true });
    window.devicePixelRatio = 2;
    window.alert = msg => errors.push('alert(): ' + msg);
    window.confirm = () => true;
    window.fetch = fakeFetch;
    window.TextEncoder = TextEncoder; window.TextDecoder = TextDecoder;
    window.DecompressionStream = DecompressionStream; window.Response = Response;
    window.URL.createObjectURL = blob => { downloads.push(blob); return 'blob:x'; };
    window.URL.revokeObjectURL = () => {};
    window.HTMLAnchorElement.prototype.click = function () {};
    const read = (blob, how) => new Promise((res, rej) => {
      const r = new window.FileReader();
      r.onload = () => res(r.result); r.onerror = () => rej(r.error);
      r[how](blob);
    });
    if (!window.Blob.prototype.arrayBuffer) window.Blob.prototype.arrayBuffer = function () { return read(this, 'readAsArrayBuffer'); };
    // Real Blobs stream; the gzip path in Intervals.unpack needs it.
    window.Blob.prototype.stream = function () { const b = this; return new ReadableStream({ async start(c) { c.enqueue(new Uint8Array(await b.arrayBuffer())); c.close(); } }); };
  },
});

const { window } = dom;
const { document } = window;
const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const G = name => window.eval(name);
const App = () => window.FitLabApp;
const S = () => App().state;
function pointer(type, x, y) {
  const e = new window.MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0 });
  Object.defineProperty(e, 'pointerId', { value: 1 });
  return e;
}
function setValue(id, v) { const el = $(id); el.value = v; el.dispatchEvent(new window.Event('input', { bubbles: true })); el.dispatchEvent(new window.Event('change', { bubbles: true })); }
async function waitIdle() { for (let k = 0; k < 100; k++) { await sleep(20); if ($('busy').hidden) break; } await sleep(20); }
async function click(el) { el.click(); await waitIdle(); }
const statusText = id => ($(id).textContent || '').trim();

(async () => {
  const sdk = await import(path.join(ROOT, 'node_modules/@garmin/fitsdk/src/index.js'));
  async function garmin(blob) {
    const buf = await blob.arrayBuffer();
    const ok = new sdk.Decoder(sdk.Stream.fromArrayBuffer(buf)).checkIntegrity();
    const r = new sdk.Decoder(sdk.Stream.fromArrayBuffer(buf)).read({ convertDateTimesToDates: false });
    return { ok, errors: r.errors, m: r.messages };
  }

  await new Promise(resolve => document.readyState === 'complete' ? resolve() : window.addEventListener('load', resolve));
  await sleep(200);
  check('no errors on boot', errors.length === 0, errors.join(' | ').slice(0, 400));
  check('empty state shown, tools disabled', !$('empty-state').hidden && $('download-btn').disabled && !$('merge-need').hidden);

  section('Welcome and walkthrough');
  const dlg = document.querySelector('.tour-dialog');
  check('welcome dialog on first visit', !!dlg && /Welcome to FitLab/.test(dlg.textContent));
  check('offers to connect intervals.icu (not connected)', /Connect intervals\.icu/.test(dlg.textContent));
  const trySample = [...dlg.querySelectorAll('button, a')].find(b => /sample/.test(b.textContent));
  await click(trySample);
  await sleep(50);
  check('sample files load into both slots', S().base && S().second && /Sample head unit/.test($('slot-base-body').textContent) && /Sample power meter/.test($('slot-second-body').textContent));
  check('walkthrough starts after the sample', !!document.querySelector('.tour-pop'));
  const steps = [];
  for (let k = 0; k < 10 && document.querySelector('.tour-pop'); k++) { steps.push(document.querySelector('.tour-title').textContent); document.getElementById('tour-next').click(); }
  check('walkthrough runs to the end', !document.querySelector('.tour-pop') && steps.length >= 6, steps.join(' → '));
  check('…and is remembered', G('Settings').get('flTourDone') === true && G('Settings').get('flWelcomeSeen') === true);
  check('no errors so far', errors.length === 0, errors.join(' | ').slice(0, 400));

  section('Lining up and merging');
  check('offset found automatically from the stops', S().offset === G('Demo').LAG, String(S().offset));
  check('…and explained', /stopped and started/.test(statusText('merge-status')) && /4 s behind/.test(statusText('merge-status')), statusText('merge-status'));
  const rows = [...document.querySelectorAll('#chan-rows tr')];
  check('channel table lists power and cadence, defaulting to fill', rows.length === 2 && rows.every(r => r.querySelector('select').value === 'fill'), rows.map(r => r.textContent).join(' | '));
  check('timeline draws both files', $('timeline')._ctx.calls.lineTo > 1000 && G('Timeline') && true);
  document.querySelector('[data-nudge="1"]').click();
  check('nudge moves the offset', S().offset === G('Demo').LAG + 1);
  await click($('offset-auto'));
  check('line up again restores it', S().offset === G('Demo').LAG);
  await click($('merge-btn'));
  const w = App().work();
  const powered = G('FitEdit').records(w).filter(m => G('FitFile').get(m, 7) !== null).length;
  check('merge brings power in', powered > 2800, powered + ' samples with power');
  check('stats show average power', /Avg power/.test($('work-stats').textContent));
  check('history has the merge', S().history.length === 2 && /Merged power, cadence/.test($('history-list').textContent));
  check('merge status reports coverage', /Power on 9\d% of samples/.test(statusText('merge-status')), statusText('merge-status'));
  check('channels already merged switch to skip', [...document.querySelectorAll('#chan-rows select')].every(s => s.value === 'skip') && $('merge-btn').disabled);

  section('Selecting');
  const tl = $('timeline');
  // Gutter 64 px, plot 826 px wide for a 900 px canvas.
  tl.dispatchEvent(pointer('pointerdown', 64 + 826 * 0.2, 100));
  for (let k = 1; k <= 4; k++) tl.dispatchEvent(pointer('pointermove', 64 + 826 * (0.2 + 0.1 * k), 100));
  tl.dispatchEvent(pointer('pointerup', 64 + 826 * 0.6, 100));
  const sel = S().sel;
  check('dragging the chart selects', sel && sel.b - sel.a > 1000 && sel.b - sel.a < 1300, sel && (sel.b - sel.a) + ' s');
  check('selection shows in the inputs and the bar', /^0:\d\d:\d\d$/.test($('sel-from').value) && /km/.test($('sel-info').textContent));
  check('selection tools enabled', !$('crop-btn').disabled && !$('pause-btn').disabled);
  tl.dispatchEvent(pointer('pointerdown', 500, 100)); tl.dispatchEvent(pointer('pointerup', 500, 100));
  check('a click clears it', S().sel === null && $('crop-btn').disabled);

  section('Pause the café stop');
  setValue('sel-from', '25:00'); setValue('sel-to', '31:00');
  check('typed selection', S().sel && S().sel.b - S().sel.a === 360);
  const before = G('FitEdit').describe(App().work());
  App().setTab('edit');
  await click($('pause-btn'));
  const after = G('FitEdit').describe(App().work());
  check('moving time drops by six minutes, elapsed does not', after.timer === before.timer - 360 && after.elapsed === before.elapsed, before.timer + ' → ' + after.timer);
  check('stats say what it was', /was/.test($('work-stats').textContent));
  check('pause drawn on the chart', after.pauses.length === 1);

  section('Undo, redo, history');
  await click($('undo-btn'));
  check('undo', G('FitEdit').describe(App().work()).timer === before.timer && !$('redo-btn').disabled);
  await click($('redo-btn'));
  check('redo', G('FitEdit').describe(App().work()).timer === after.timer);
  document.querySelector('[data-hist="0"]').click();
  check('clicking a history step jumps to it', S().at === 0 && G('FitEdit').describe(App().work()).avgPower === null);
  document.querySelector('[data-hist="2"]').click();
  check('…and forward again', S().at === 2);

  section('Crop and cut');
  setValue('sel-from', '1:00'); setValue('sel-to', '45:00');
  await click($('crop-btn'));
  const cr = G('FitEdit').describe(App().work());
  check('crop', cr.t1 - cr.t0 === 44 * 60, String(cr.t1 - cr.t0));
  check('crop keeps the pause inside it', cr.pauses.length === 1);
  check('crop resets the selection', S().sel === null);
  setValue('sel-from', '10:00'); setValue('sel-to', '12:00');
  await click($('cut-btn'));
  const ct = G('FitEdit').describe(App().work());
  check('cut closes the gap', ct.t1 - ct.t0 === 42 * 60 && G('FitEdit').check(App().work()).length === 0);

  section('Download');
  await click($('download-btn'));
  check('download produced a file', downloads.length === 1 && /Saved .*\.fit/.test(statusText('export-status')), statusText('export-status'));
  const g1 = await garmin(downloads[0]);
  check('Garmin reads it: valid, power merged, one pause, laps', g1.ok && g1.errors.length === 0 && g1.m.recordMesgs.some(r => r.power > 0) &&
    g1.m.eventMesgs.filter(e => e.event === 'timer').length === 4 && g1.m.lapMesgs.length >= 1, g1.errors.join(';'));
  check('…and its session matches the stats', g1.m.sessionMesgs[0].totalElapsedTime === 42 * 60 && Math.abs(g1.m.sessionMesgs[0].totalTimerTime - (42 * 60 - 360)) < 1, g1.m.sessionMesgs[0].totalTimerTime);

  section('Splice');
  const later = G('FitFile').encode(G('FitEdit').shift(G('FitEdit').prepare(G('FitFile').decode(G('Demo').base())), 4 * 3600));
  App().loadBuffer('base', G('Demo').base(), 'Morning');
  App().loadBuffer('second', later, 'Afternoon');
  App().setTab('splice');
  check('splice note says how far apart', /starts .* after the base ends/.test($('splice-note').textContent), $('splice-note').textContent);
  await click($('splice-btn'));
  const sp = G('FitEdit').describe(App().work());
  check('splice: one session, four laps, the gap a pause', sp.sessions === 1 && sp.laps === 4 && sp.pauses.some(([a, b]) => b - a > 3 * 3600));
  document.querySelector('input[name="splice-gap"][value="close"]').click();
  setValue('splice-secs', '60');
  document.querySelector('[data-hist="0"]').click();
  await click($('splice-btn'));
  const sp2 = G('FitEdit').describe(App().work());
  check('…or moved to follow on a minute later', sp2.t1 - sp2.t0 === 2999 + 60 + 2999, String(sp2.t1 - sp2.t0));

  section('More: strip, clean, sport');
  App().setTab('more');
  document.querySelector('[data-strip="pos"]').click();
  await click($('strip-btn'));
  check('GPS removed from the working file', !G('FitEdit').channels(App().work()).some(c => c.key === 'pos') && G('FitEdit').records(App().work()).every(m => !m.f[0]));
  check('the map still shows the second file\'s track', !$('map-wrap').hidden);
  setValue('clean-hr', '150');
  await click($('clean-btn'));
  check('spikes cleared', /blanked/.test(statusText('more-status')), statusText('more-status'));
  setValue('sport-sel', 'cycling/gravel');
  await click($('sport-btn'));
  check('sport set', G('FitEdit').sportOf(App().work()) === 'cycling/gravel');
  check('file info lists the messages', /record/.test($('file-info').textContent));

  section('Shift the clock');
  App().setTab('edit');
  const t0 = G('FitEdit').range(App().work()).t0;
  setValue('shift-by', '+1:00:00');
  await click($('shift-btn'));
  check('every timestamp an hour later', G('FitEdit').range(App().work()).t0 === t0 + 3600);
  check('the second file stays lined up', S().offset === 3600);
  setValue('shift-by', 'nonsense');
  await click($('shift-btn'));
  check('a bad shift is explained, not applied', /Type a shift/.test(statusText('edit-status')));

  section('intervals.icu');
  check('connect call to action when not connected', $('icu-connect').style.display === '' && $('icu-panel').style.display === 'none');
  G('Settings').set({ icuKey: 'secret', icuAthleteName: 'Test Rider' });
  window.dispatchEvent(new window.CustomEvent('fitlab:settings', { detail: { icu: true } }));
  check('panel appears once connected', $('icu-panel').style.display === '' && /Test Rider/.test($('icu-who').textContent) && !$('upload-btn').hidden);
  fitFor = { i101: Buffer.from(G('Demo').base()), i102: Buffer.from(G('Demo').second()) };
  await click($('icu-fetch'));
  await sleep(50);
  const items = document.querySelectorAll('#icu-list .ride-item');
  check('recent activities listed', items.length === 3, String(items.length));
  check('Strava-sourced activity greyed out', items[2].classList.contains('blocked') && items[2].querySelector('button').disabled);
  await click(document.querySelector('[data-icu="i101"][data-slot="base"]'));
  await sleep(50);
  check('activity downloaded as the base', S().base && S().base.source.icuId === 'i101' && /Morning ride \(head unit\)/.test($('slot-base-body').textContent), statusText('icu-status'));
  await click(document.querySelector('[data-icu="i102"][data-slot="second"]'));
  await sleep(50);
  check('…and the second', S().second && S().second.source.icuId === 'i102' && S().offset === G('Demo').LAG);
  check('slot links back to intervals.icu', !!document.querySelector('#slot-base-body a[href="https://intervals.icu/activities/i101"]'));
  await click($('merge-btn'));
  await click($('upload-btn'));
  await sleep(50);
  check('upload posts the file', net.uploads.length === 1 && /Uploaded/.test(statusText('export-status')) && !!document.querySelector('#export-status a[href*="i555"]'), statusText('export-status'));
  check('key sent only to intervals.icu', net.calls.every(u => String(u).startsWith('https://intervals.icu/api/v1/')));

  section('Swap and clear');
  await click(document.querySelector('[data-swap]'));
  check('swap makes the second file the base', /Morning ride \(power app\)/.test($('slot-base-body').textContent) && /head unit/.test($('slot-second-body').textContent));
  await click(document.querySelector('[data-clear="second"]'));
  check('clearing the second file hides merge', !S().second && !$('merge-need').hidden);

  check('no errors through the whole run', errors.length === 0, errors.join(' | ').slice(0, 600));

  section('Other pages');
  for (const file of ['about.html', 'connect.html']) {
    const errs = [];
    const vc = new VirtualConsole();
    vc.on('jsdomError', e => errs.push(e.message));
    const src = fs.readFileSync(path.join(SITE, file), 'utf8').replace(/(src|href)="\/FitLab\//g, '$1="');
    const page = new JSDOM(src, { runScripts: 'dangerously', resources: 'usable', virtualConsole: vc, url: require('url').pathToFileURL(path.join(SITE, file)).href,
      beforeParse(w) { w.fetch = () => Promise.reject(new Error('network disabled')); } });
    await new Promise(r => page.window.document.readyState === 'complete' ? r() : page.window.addEventListener('load', r));
    await sleep(100);
    check(file + ' boots without errors', errs.length === 0, errs.join(' | '));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log(failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
  process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
