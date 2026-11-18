/**
 * End-to-end checks (headless Chromium via Playwright).
 *
 *   npm test                      # starts tools/serve.mjs on :8099 and runs all checks
 *   BASE_URL=https://opinofaeroex.github.io/mf550-assembly/public npm test   # test the live site
 *
 * Natural voice (v1.4): the recorded MP3 narration really plays in headless Chromium
 * (autoplay allowed by a launch flag); an in-page spy on the audio element logs every
 * play / pause / ended with the recording key. Headless Chromium has no speech voices, so
 * the Web Speech API (fallback voice) is replaced by a deterministic in-page mock
 * (speechSynthesis + SpeechSynthesisUtterance) that logs every speak / start / end / cancel.
 * The app code under test is unchanged.
 *
 * [1] Viewer & data: loads without errors; GLB ↔ assembly.json; geometry of every part
 *     within tolerance of the OpenCascade B-rep boxes.
 * [2] Exploded view ×3: every displayed vector = 3 × the pipeline vector, same direction;
 *     components return to their exact CAD positions.
 * [3] Synchronisation for all steps: positions, highlight, BOM row, step card, spoken script
 *     (same operation, component, quantity, target and direction as the card).
 * [4] Manual navigation: NEXT/PREVIOUS buttons, boundaries, no automatic advance after the
 *     animation or the narration, navigation during animation, rapid clicks, late downloads.
 * [5] Natural voice: auto-start on step entry, previous narration stopped, pause / resume
 *     (same position) / replay / mute / speed / volume via the UI, next-step preload,
 *     blocked-until-gesture, browsers without Web Speech or without audio.
 * [5b] Browser-voice fallback: recordings unavailable → the Web Speech voice narrates with the
 *     v1.1–v1.3 behaviour (sentence pause/resume, best voice), one notice; missing file.
 * [6] WebXR AR flow under the Immersive Web Emulation Runtime (IWER + SEM), incl. NEXT in AR
 *     and the gesture camera being released during the AR session.
 * [7] New STEP integration: names from MF-550-210-B_MIST_FIT_550_FINAL_NAMED.STEP, structure
 *     map provenance, concise step instructions (card text == spoken text), step loop.
 * [8] Right-hand gestures: classifier on real MediaPipe landmarks (tests/fixtures), trigger
 *     state machine, and end-to-end with a fake camera + scripted tracker: thumbs up / down
 *     navigate exactly once, left hand ignored, boundaries, disable, permission denied.
 *     (The real MediaPipe model is checked on the live site, see README § Tests.)
 * [9] Automatic step camera. [10] AR capability detection. [11] Branding and BOM (v1.3)
 *     + AEROEX symbol, favicon and loading screen (v1.4).
 * [12] Natural-voice recordings: manifest covers every position with the exact spoken script,
 *     every MP3 decodes in the browser with the listed duration, consistent loudness metadata.
 */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8099;
let BASE = process.env.BASE_URL;
let server;
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? '  ✓' : '  ✗'} ${msg}`); if (!ok) failures++; };

/** In-page Web Speech API mock. opts.requireGesture: refuse ('not-allowed') until a pointerdown;
 *  opts.msPerChar: speaking time per character (default 10 ms). */
const speechMock = (opts = {}) => `(() => {
  const log = []; let queue = []; let cur = null; let speaking = false; let gesture = ${opts.requireGesture ? 'false' : 'true'};
  addEventListener('pointerdown', () => { gesture = true; }, true);
  const fire = (u, type, extra) => u.dispatchEvent(Object.assign(new Event(type), extra || {}));
  const pump = () => {
    if (cur || !queue.length) { speaking = !!cur; return; }
    cur = queue.shift(); speaking = true;
    const u = cur;
    setTimeout(() => { if (cur === u) { log.push({ t: 'start', text: u.text }); fire(u, 'start'); } }, 5);
    setTimeout(() => { if (cur !== u) return; cur = null; log.push({ t: 'end', text: u.text }); fire(u, 'end'); pump(); }, 30 + u.text.length * ${opts.msPerChar || 10});
  };
  class Utterance extends EventTarget {
    constructor(text) { super(); this.text = text; this.lang = ''; this.rate = 1; this.voice = null;
      for (const k of ['start', 'end', 'error']) this.addEventListener(k, (e) => this['on' + k] && this['on' + k](e)); }
  }
  const synth = {
    get speaking() { return speaking; }, get pending() { return queue.length > 0; }, paused: false,
    getVoices: () => [
      { name: 'Microsoft Jenny Online (Natural) - English (United States)', lang: 'en-US', voiceURI: 'jenny', localService: false, default: false },
      { name: 'Microsoft David - English (United States)', lang: 'en-US', voiceURI: 'david', localService: true, default: true },
      { name: 'Microsoft Sabina - Spanish (Mexico)', lang: 'es-MX', voiceURI: 'sabina', localService: true, default: false }],
    speak(u) {
      log.push({ t: 'speak', text: u.text });
      if (!gesture) { setTimeout(() => fire(u, 'error', { error: 'not-allowed' }), 5); return; }
      queue.push(u); pump();
    },
    cancel() {
      const c = cur, q = queue; cur = null; queue = []; speaking = false;
      if (c) { log.push({ t: 'cancel', text: c.text }); fire(c, 'error', { error: 'interrupted' }); }
      q.forEach((u) => fire(u, 'error', { error: 'canceled' }));
    },
    pause() {}, resume() {}, addEventListener() {}, removeEventListener() {},
  };
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
  window.SpeechSynthesisUtterance = Utterance;
  window.__speechLog = log;
  window.__speechActive = () => !!cur;
})();`;

/** Spy on the narration audio element (real playback): logs play / pause / ended with the
 *  recording key. opts.requireGesture: play() is refused (NotAllowedError) until a pointerdown. */
const audioSpy = (opts = {}) => `(() => {
  const log = []; let gesture = ${opts.requireGesture ? 'false' : 'true'};
  addEventListener('pointerdown', () => { gesture = true; }, true);
  const P = HTMLAudioElement.prototype;               // narration only: <video> elements are untouched
  const play = HTMLMediaElement.prototype.play, pause = HTMLMediaElement.prototype.pause;
  const keyOf = () => (window.app && app.narrator && app.narrator.recorded.current) || null;
  P.play = function () {
    if (!this.__spy) { this.__spy = true; this.addEventListener('ended', () => log.push({ t: 'ended', key: keyOf() })); }
    if (!gesture) { log.push({ t: 'blocked', key: keyOf() }); return Promise.reject(new DOMException('needs a gesture', 'NotAllowedError')); }
    log.push({ t: 'play', key: keyOf(), at: this.currentTime, seq: window.app ? app.seq.pos : null });
    return play.call(this);
  };
  P.pause = function () { if (!this.paused) log.push({ t: 'pause', key: keyOf(), at: this.currentTime }); return pause.call(this); };
  window.__audioLog = log;
  window.__audioActive = () => { const a = window.app && app.narrator.recorded.audio; return !!a && !a.paused && !a.ended; };
})();`;

const noSpeech = `(() => {
  Object.defineProperty(window, 'speechSynthesis', { value: undefined, configurable: true });
  window.SpeechSynthesisUtterance = undefined;
})();`;

async function startServer() {
  if (BASE) return;
  server = spawn(process.execPath, [path.join(ROOT, 'tools/serve.mjs'), '--port', String(PORT), '--host', '127.0.0.1'], { stdio: 'pipe' });
  BASE = `http://127.0.0.1:${PORT}`;
  await new Promise((r) => server.stdout.once('data', r));
}

async function launch() {
  return chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required'],   // real narration audio plays without a click
  });
}

/** v1.5: sections [1]–[12] test the full-detail behaviour; headless Chromium renders in software,
 *  which the app would otherwise detect as "Low performance". Section [13] tests the profiles. */
const pinProfile = (id) => `try { localStorage.setItem('mf550.perf.profile', '${id}'); } catch (e) {}`;

async function openApp(browser, init, viewport = { width: 1280, height: 800 }, { setup, audio, profile = 'high', query = '' } = {}) {
  const page = await browser.newPage({ viewport });
  if (profile) await page.addInitScript(pinProfile(profile));
  await page.addInitScript(audioSpy(audio));
  if (init) await page.addInitScript(init);
  if (setup) await setup(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${BASE}/${query}`);
  await page.waitForFunction(() => window.app && window.app.seq && window.app.narrator, null, { timeout: 120000 });
  return { page, errors };
}

/** Scripted stand-in for MediaPipe: returns whatever window.__fakeHands holds for each frame. */
const fakeTracker = `(() => {
  window.__fakeHands = [];
  window.__detectCalls = 0;
  window.__MF550_TEST_TRACKER__ = () => ({
    landmarker: null, delegate: null,
    async init() { await new Promise((r) => setTimeout(r, 50)); this.landmarker = {}; this.delegate = 'TEST'; },
    detect() { window.__detectCalls++; return { hands: window.__fakeHands }; },
    close() { this.landmarker = null; },
  });
})();`;

/** Real Hand Landmarker output (fixtures) + exact image transforms for the other cases. */
const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'hand-landmarks.json'), 'utf8')).hands;
function hand(name, { rot = 0, mirror = false } = {}) {
  const f = FIX.find((h) => h.img === name);
  const r = (rot * Math.PI) / 180, cs = Math.cos(r), sn = Math.sin(r);
  const lm = [], wl = [];
  for (let i = 0; i < 21; i++) {
    let x = f.lm[i * 3] / 1000, y = f.lm[i * 3 + 1] / 1000;
    let X = f.wl[i * 3] / 1000, Y = f.wl[i * 3 + 1] / 1000;
    if (mirror) { x = 1 - x; X = -X; }
    // rotate the picture about its centre (in pixels, so the aspect ratio is respected)
    const px = (x - 0.5) * f.w, py = (y - 0.5) * f.h;
    lm.push({ x: 0.5 + (px * cs - py * sn) / f.w, y: 0.5 + (px * sn + py * cs) / f.h, z: f.lm[i * 3 + 2] / 1000 });
    wl.push({ x: X * cs - Y * sn, y: X * sn + Y * cs, z: f.wl[i * 3 + 2] / 1000 });
  }
  const label = mirror ? (f.label === 'Right' ? 'Left' : 'Right') : f.label;
  return { label, score: 0.98, landmarks: lm, world: wl, w: f.w, h: f.h };
}

const waitFor = (page, fn, arg, timeout = 30000) => page.waitForFunction(fn, arg, { timeout, polling: 100 }).then(() => true, () => false);

async function testViewer(browser) {
  console.log('\n[1] viewer and data');
  const { page, errors } = await openApp(browser, speechMock());
  check(errors.length === 0, `loads without errors ${errors.length ? JSON.stringify(errors) : ''}`);

  const fidelity = await page.evaluate(() => {
    const { model, loaded, viewer } = window.app;
    const Box3 = viewer.boxOf().constructor;
    const off = viewer.model.position;
    const lift = viewer.modelRoot.position.y;
    let worst = 0, worstId = null;
    for (const id of model.partIds) {
      const n = model.node(id);
      const b = new Box3().setFromObject(loaded.objects.get(id), true);
      const exp = [n.bboxMin, n.bboxMax];
      const got = [b.min, b.max];
      for (let k = 0; k < 2; k++) {
        const d = Math.max(Math.abs(got[k].x - off.x - exp[k][0]), Math.abs(got[k].y - off.y - lift - exp[k][1]), Math.abs(got[k].z - off.z - exp[k][2]));
        if (d > worst) { worst = d; worstId = n.cad; }
      }
    }
    return { worstMm: worst * 1000, worstId, parts: model.partIds.length };
  });
  check(fidelity.worstMm < 0.75, `${fidelity.parts} parts at CAD position; max bbox deviation ${fidelity.worstMm.toFixed(3)} mm (${fidelity.worstId})`);

  console.log('\n[2] exploded view ×3');
  const ex = await page.evaluate(() => {
    const { explode, model } = window.app;
    let worstLen = 0, worstDir = 0, hw = 0, parts = 0, asms = 0;
    for (const e of explode.entries) {
      const v = model.node(e.id).explode;
      const len0 = Math.hypot(v[0], v[1], v[2]);
      const len = e.vec.length();
      worstLen = Math.max(worstLen, Math.abs(len - 3 * len0));
      const cos = (e.vec.x * v[0] + e.vec.y * v[1] + e.vec.z * v[2]) / (len * len0);
      worstDir = Math.max(worstDir, 1 - cos);
      const n = model.node(e.id);
      if (n.kind === 'assembly') asms++; else if (model.steps[n.step] && model.steps[n.step].kind === 'fasten') hw++; else parts++;
    }
    return { scale: explode.scale, worstLen, worstDir, n: explode.entries.length, hw, parts, asms };
  });
  check(ex.scale === 3 && ex.worstLen < 1e-9 && ex.worstDir < 1e-9,
    `${ex.n} displacement vectors (${ex.hw} hardware, ${ex.parts} parts, ${ex.asms} sub-assemblies) are exactly 3× the pipeline vectors, same direction`);
  const back = await page.evaluate(() => {
    const { seq, explode } = window.app;
    seq.goTo(-1, { animate: false });
    let maxEx = 0;
    for (const e of explode.entries) maxEx = Math.max(maxEx, e.obj.position.distanceTo(e.base) / e.baseVec.length());
    seq.goTo(seq.last, { animate: false });
    let maxOff = 0;
    for (const e of explode.entries) maxOff = Math.max(maxOff, e.obj.position.distanceTo(e.base));
    return { maxEx, maxOff };
  });
  check(Math.abs(back.maxEx - 3) < 1e-6, `parts-kit offsets measured in the scene are 3.000× the original (${back.maxEx.toFixed(6)})`);
  check(back.maxOff === 0, `after the final step every component is back at its exact CAD position (max offset ${back.maxOff})`);
  const usdz = await page.evaluate(async () => {
    const ql = window.app.quickLook;
    const url = await ql.prepare(null, { kind: 'step', pos: 28 });
    const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
    const head = new TextDecoder().decode(buf.subarray(0, 200000));
    return { size: buf.length, zip: buf[0] === 0x50 && buf[1] === 0x4b, anim: head.includes('timeSamples') };
  });
  check(usdz.zip && usdz.size > 1e6 && usdz.anim, `iOS Quick Look USDZ of step 29 generated in the browser (${(usdz.size / 1e6).toFixed(1)} MB, animated)`);

  console.log('\n[3] synchronisation for every step');
  const sync = await page.evaluate(async () => {
    const { model, seq, explode, appearance, activeParts } = window.app;
    const { narrationText } = await import('./js/audio/narrationScript.js');
    const { stepFacts, plural } = await import('./js/ui/text.js');
    const { numberWords } = await import('./js/audio/spokenScript.js');
    const problems = [];
    for (let k = 0; k < model.stepCount; k++) {
      seq.goTo(k, { animate: false });
      for (let i = 0; i < explode.entries.length; i++) {
        const e = explode.entries[i];
        const want = e.step === null || e.step <= k ? 0 : 1;
        if (Math.abs(explode.f[i] - want) > 1e-6) { problems.push(`step ${k + 1}: ${e.id} factor ${explode.f[i]} != ${want}`); break; }
      }
      const active = new Set(model.partIds.filter((id) => appearance.get(id) === 2));
      const expected = activeParts[k];
      if (active.size !== expected.size || [...expected].some((id) => !active.has(id))) problems.push(`step ${k + 1}: highlight mismatch`);
      const curRows = [...document.querySelectorAll('#bom-table tr.is-current')].map((tr) => tr.dataset.item).sort();
      const wantRows = [...new Set(model.steps[k].nodes.map((id) => model.rowByNode.get(id).item))].sort();
      if (curRows.join() !== wantRows.join()) problems.push(`step ${k + 1}: BOM rows ${curRows} != ${wantRows}`);
      const card = document.getElementById('step-badge').textContent;
      if (card !== `Step ${k + 1} / ${model.stepCount}`) problems.push(`step ${k + 1}: card shows ${card}`);
      // the voice describes the same operation as the card: component, quantity, target, direction
      const script = narrationText(model, k);
      const desc = document.getElementById('step-desc').textContent.toLowerCase();
      const title = document.getElementById('step-title').textContent.toLowerCase();
      const f = stepFacts(model, k);
      const names = [f.label.toLowerCase(), plural(f.label).toLowerCase()];
      const cardText = `${title} ${desc}`;
      const same = script.startsWith(`Step ${k + 1}. `)
        && names.some((n) => script.includes(n) && cardText.includes(n))
        && (f.kind === 'base' || (script.includes(`to the ${f.target}`) && desc.includes(`to the ${f.target}`)) || script.includes('to the first'))
        && (!f.direction || (script.includes(f.direction) && desc.includes(f.direction)))
        && (f.per === 1 || (script.includes(`${numberWords(f.per)} `) && desc.includes(`${f.per} `)))
        && (f.instances < 2 || (/Repeat this on/.test(script) && /repeat on/.test(desc)))
        && (!f.last || script.endsWith('The assembly is complete.'));
      if (!same) problems.push(`step ${k + 1}: spoken script ("${script}") does not match the card`);
    }
    return { problems, steps: model.stepCount };
  });
  check(sync.problems.length === 0, `${sync.steps} steps: positions, highlight, BOM row, step card and spoken script (same component, quantity, target, direction) in sync ${sync.problems.slice(0, 3).join('; ')}`);
  await page.close();
}

async function testNavigationAndVoice(browser) {
  console.log('\n[4] manual navigation');
  const { page, errors } = await openApp(browser, speechMock({ msPerChar: 40 }));
  const st = () => page.evaluate(() => ({
    pos: app.seq.pos, animating: app.seq.animating, status: app.narrator.status, id: app.narrator.id,
    prev: document.getElementById('btn-prev').disabled, next: document.getElementById('btn-next').disabled,
    badge: document.getElementById('step-badge').textContent, label: document.getElementById('progress-label').textContent,
  }));
  await page.evaluate(() => app.seq.goTo(-2, { animate: false }));
  let s = await st();
  check(s.pos === -2 && s.prev && !s.next, `overview: PREVIOUS disabled, NEXT enabled (${s.label})`);
  await page.click('#btn-next');
  s = await st();
  check(s.pos === -1, `NEXT STEP → parts kit (${s.badge})`);
  await page.click('#btn-next');
  s = await st();
  check(s.pos === 0 && s.badge === 'Step 1 / 69', `NEXT STEP → ${s.badge}`);
  await page.click('#btn-prev');
  s = await st();
  check(s.pos === -1, 'PREVIOUS STEP → parts kit');
  await page.evaluate(() => app.seq.goTo(app.seq.last));
  s = await st();
  check(s.next && !s.prev && s.label === 'Step 69 / 69', `final step: NEXT disabled (${s.label})`);
  await page.click('#btn-next', { force: true }).catch(() => {});
  s = await st();
  check(s.pos === 68, 'clicking the disabled NEXT on the final step does nothing');

  // no automatic advance; the step's motion loops, the narration is not repeated
  await page.evaluate(() => app.seq.goTo(10));
  const ended = await waitFor(page, () => app.narrator.status === 'ended' && !app.seq.animating, null, 60000);
  const loops = await waitFor(page, () => app.seq.loopCount >= 2, null, 90000);
  s = await st();
  const loopInfo = await page.evaluate(() => ({
    loops: app.seq.loopCount, engine: app.narrator.engine,
    plays: __audioLog.filter((x) => x.t === 'play' && x.key === 'step-11').length,
    ends: __audioLog.filter((x) => x.t === 'ended' && x.key === 'step-11').length,
    log: __audioLog.filter((x) => x.key === 'step-11').map((x) => x.t).join(','),
  }));
  check(ended && loops && s.pos === 10 && loopInfo.plays === 1 && loopInfo.ends === 1 && loopInfo.engine === 'natural',
    `step 11: animation repeated ${loopInfo.loops}× without changing step; natural-voice narration played once to the end (status ${s.status}${loopInfo.plays === 1 ? '' : `; ${loopInfo.log}`})`);

  // navigation during animation, and rapid clicks
  await page.evaluate(() => { app.seq.speed = 0.25; app.seq.goTo(20); });
  const during = await page.evaluate(() => app.seq.animating);
  await page.click('#btn-prev');
  s = await st();
  check(during && s.pos === 19 && s.animating, 'PREVIOUS during an animation: new step animates (no overlap)');
  await page.evaluate(() => { app.seq.speed = 1; });
  for (let i = 0; i < 5; i++) await page.click('#btn-next', { delay: 0 });
  const mark = await page.evaluate(() => __audioLog.length);
  await page.click('#btn-next', { delay: 0 });
  s = await st();
  check(s.pos === 25, `6 rapid NEXT clicks → step ${s.pos + 1}`);
  const cur = await waitFor(page, () => app.narrator.id === app.seq.pos && app.narrator.status === 'speaking' && window.__audioActive(), null, 20000);
  await page.waitForTimeout(400);
  const overlap = await page.evaluate((n) => ({
    plays: __audioLog.slice(n).filter((x) => x.t === 'play').map((x) => x.key),
    stale: __audioLog.filter((x) => x.t === 'play' && x.seq >= 0 && x.key !== `step-${String(x.seq + 1).padStart(2, '0')}`).map((x) => `${x.key}@${x.seq + 1}`),
    current: app.narrator.recorded.current, text: app.narrator.recorded.manifest.entries[app.narrator.recorded.current].text === app.narrator.text,
  }), mark);
  check(cur && overlap.current === 'step-26' && overlap.text && overlap.plays.slice(-1)[0] === 'step-26' && overlap.stale.length === 0,
    `after rapid clicks only the current step's recording plays; no recording ever started for a step the user had left (${overlap.stale.join(', ') || 'none'})`);

  // a slow download for a step the user has already left must never play
  await page.route('**/assets/narration/**/step-29-*.mp3', async (route) => { await new Promise((r) => setTimeout(r, 4000)); await route.continue().catch(() => {}); });
  const mark2 = await page.evaluate(() => __audioLog.length);
  const raced = await page.evaluate(async () => {
    const n = app.narrator;
    n.recorded.cache.delete('step-29');
    app.seq.goTo(28);
    const t0 = performance.now();
    while (!(n.id === 28 && n.recorded.pending.has('step-29')) && performance.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 20));
    const waiting = n.recorded.pending.has('step-29');
    app.seq.goTo(29);                                       // leave while step 29's recording is still downloading
    return waiting;
  });
  await waitFor(page, () => app.narrator.id === 29 && app.narrator.status === 'speaking', null, 15000);
  await page.waitForTimeout(4500);                          // the delayed step-29 response would have arrived by now
  const late = await page.evaluate((n) => ({ keys: __audioLog.slice(n).filter((x) => x.t === 'play').map((x) => x.key), current: app.narrator.recorded.current }), mark2);
  await page.unroute('**/assets/narration/**/step-29-*.mp3');
  check(raced && !late.keys.includes('step-29') && late.current === 'step-30',
    `a recording that arrives after the user moved on is dropped (played: ${late.keys.join(', ')})`);

  console.log('\n[5] natural voice narration');
  // DOM clicks: same click event on the same buttons, without Playwright's actionability round-trips
  const domClick = (sel) => page.evaluate((q) => document.querySelector(q).click(), sel);
  const audio = () => page.evaluate(() => { const a = app.narrator.recorded.audio; return { t: a.currentTime, paused: a.paused, rate: a.playbackRate, vol: a.volume, key: app.narrator.recorded.current }; });
  await page.evaluate(() => app.seq.goTo(30));
  await waitFor(page, () => app.narrator.id === 30 && app.narrator.status === 'speaking' && window.__audioActive() && app.narrator.recorded.audio.currentTime > 0.8);
  s = await st();
  const playing = await page.evaluate(() => ({ engine: app.narrator.engine, key: app.narrator.recorded.current, same: app.narrator.recorded.manifest.entries['step-31'].text === app.narrator.text, voice: app.narrator.voice.name }));
  check(s.status === 'speaking' && s.id === 30 && playing.engine === 'natural' && playing.key === 'step-31' && playing.same,
    `narration starts automatically when entering a step: recording "step-31" (${playing.voice}), script identical to step 31's spoken text`);
  await domClick('#nar-play');
  s = await st();
  const label1 = await page.textContent('#nar-play-label');
  const p1 = await audio();
  check(s.status === 'paused' && label1 === 'Resume' && p1.paused, `Pause → status ${s.status}, button "${label1}", audio paused at ${p1.t.toFixed(2)} s`);
  const lastPlay = () => page.evaluate(() => __audioLog.filter((x) => x.t === 'play').slice(-1)[0]);
  const plays = () => page.evaluate(() => __audioLog.filter((x) => x.t === 'play').length);
  await domClick('#nar-play');
  await waitFor(page, () => app.narrator.status === 'speaking' && window.__audioActive(), null, 10000);
  const p2 = await lastPlay();
  check(p2.key === 'step-31' && Math.abs(p2.at - p1.t) < 0.1, `Resume → continues from the same point (paused at ${p1.t.toFixed(2)} s, resumed at ${p2.at.toFixed(2)} s), not from the beginning`);
  // speed and volume apply to the narration that is playing, without restarting it
  const n0 = await plays();
  await page.evaluate(() => {
    document.getElementById('nar-settings').click();
    const r = document.getElementById('nar-rate'); r.value = '1.25'; r.dispatchEvent(new Event('change', { bubbles: true }));
    const v = document.getElementById('nar-volume'); v.value = '60'; v.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const p3 = await audio();
  const saved = await page.evaluate(() => ({ rate: localStorage.getItem('mf550.narration.rate'), vol: localStorage.getItem('mf550.narration.volume'), out: document.getElementById('nar-volume-out').textContent }));
  check(p3.rate === 1.25 && Math.abs(p3.vol - 0.6) < 1e-6 && p3.key === 'step-31' && (await plays()) === n0 && saved.rate === '1.25' && saved.vol === '0.6' && saved.out === '60%',
    `speed 1.25× and volume 60 % apply at once to the playing recording (no restart) and are remembered`);
  await page.evaluate(() => {
    const r = document.getElementById('nar-rate'); r.value = '1'; r.dispatchEvent(new Event('change', { bubbles: true }));
    const v = document.getElementById('nar-volume'); v.value = '100'; v.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('nar-settings').click();
  });
  const n1 = await plays();
  await domClick('#nar-replay');
  s = await st();
  check(s.pos === 30 && s.animating, 'Replay → same step, animation restarts');
  await waitFor(page, (k) => __audioLog.filter((x) => x.t === 'play').length > k && app.narrator.status === 'speaking', n1, 10000);
  const p4 = await lastPlay();
  check(p4.key === 'step-31' && p4.at < 0.05, `Replay → narration restarts from the beginning (${p4.at.toFixed(2)} s)`);
  await page.click('#nar-mute');
  s = await st();
  check(s.status === 'muted' && !(await page.evaluate(() => window.__audioActive())), 'Mute → narration stops immediately');
  const before = await page.evaluate(() => __audioLog.length);
  await page.click('#btn-next');
  await page.waitForTimeout(800);
  const playedWhileMuted = await page.evaluate((n) => __audioLog.slice(n).some((x) => x.t === 'play'), before);
  check(!playedWhileMuted, 'NEXT while muted → no audio');
  await page.click('#nar-mute');
  const unmuted = await waitFor(page, () => app.narrator.status === 'speaking' && app.narrator.id === 31 && app.narrator.recorded.current === 'step-32');
  check(unmuted, 'Unmute → narrates the current step');
  const pre = await waitFor(page, () => app.narrator.recorded.cache.has('step-33'), null, 10000);
  const prePlayed = await page.evaluate(() => __audioLog.some((x) => x.t === 'play' && x.key === 'step-33'));
  check(pre && !prePlayed && (await audio()).key === 'step-32', 'the next step\'s recording is preloaded in the background without interrupting the current one');
  await domClick('#nar-replay');
  await waitFor(page, () => app.narrator.status === 'speaking' && window.__audioActive(), null, 10000);
  await page.keyboard.press('Space');
  check((await st()).status === 'paused', 'Space key pauses the narration');
  await page.keyboard.press('ArrowRight');
  const kb = await waitFor(page, () => app.seq.pos === 32 && app.narrator.id === 32 && app.narrator.status === 'speaking' && app.narrator.recorded.current === 'step-33');
  check(kb, '→ key: next step, new narration starts (from the preloaded recording)');
  const voiceInfo = await page.evaluate(() => ({ v: app.narrator.voice.name, kind: document.getElementById('nar-voice-kind').textContent, options: document.querySelectorAll('#nar-voice option').length, sel: document.getElementById('nar-voice').value }));
  check(/Heart \(natural voice\)/.test(voiceInfo.v) && /neural/.test(voiceInfo.kind) && voiceInfo.sel === 'natural' && voiceInfo.options === 3,
    `natural voice used by default (${voiceInfo.v}); ${voiceInfo.options - 1} browser voices offered as alternatives`);
  // switching to a browser voice and back while narrating (the real <select>, inside the page)
  const pick = (v) => page.evaluate((val) => { app.narrator.replay(); const sel = document.getElementById('nar-voice'); sel.value = val; sel.dispatchEvent(new Event('change', { bubbles: true })); }, v);
  await pick('jenny');
  const sw = await waitFor(page, () => app.narrator.engine === 'browser' && app.narrator.status === 'speaking' && window.__speechActive() && !window.__audioActive(), null, 10000);
  const savedPick = await page.evaluate(() => localStorage.getItem('mf550.narration.voicePref'));
  await pick('natural');
  const back = await waitFor(page, () => app.narrator.engine === 'natural' && app.narrator.status === 'speaking' && window.__audioActive() && !window.__speechActive(), null, 10000);
  check(sw && back && savedPick === '"jenny"', 'choosing a browser voice switches engines without overlap (choice remembered); choosing the natural voice switches back');
  check(errors.length === 0, `no page errors ${errors.length ? JSON.stringify(errors.slice(0, 3)) : ''}`);
  await page.close();

  // a browser voice picked in v1.1–v1.3 (stored as "voice") does not hide the natural voice after the update
  const old = await openApp(browser, speechMock() + `try { localStorage.setItem('mf550.narration.voice', JSON.stringify('jenny')); } catch {}`);
  await old.page.evaluate(() => app.seq.goTo(4));
  const oldNat = await waitFor(old.page, () => app.narrator.id === 4 && app.narrator.status === 'speaking' && app.narrator.engine === 'natural' && window.__audioActive() && !window.__speechActive(), null, 15000);
  const oldSel = await old.page.evaluate(() => document.getElementById('nar-voice').value);
  check(oldNat && oldSel === 'natural' && old.errors.length === 0, 'returning visitor with a v1.3 browser-voice choice: the natural voice is used (the old choice is not carried over)');
  await old.page.close();

  // browsers that block sound until the first user gesture
  const g = await openApp(browser, speechMock({ requireGesture: true }), undefined, { audio: { requireGesture: true } });
  await g.page.evaluate(() => app.seq.goTo(3));
  const blocked = await waitFor(g.page, () => app.narrator.status === 'blocked');
  const hint = await g.page.textContent('#nar-status');
  await g.page.mouse.click(600, 400);
  const unlocked = await waitFor(g.page, () => app.narrator.status === 'speaking' && window.__audioActive() && app.narrator.recorded.current === 'step-04');
  check(blocked && unlocked, `audio blocked before the first gesture ("${hint}"), starts on the first tap`);
  await g.page.close();

  // browser without the Web Speech API: the recorded voice does not need it
  const u = await openApp(browser, noSpeech);
  await u.page.evaluate(() => app.seq.goTo(5));
  const ns = await waitFor(u.page, () => app.narrator.status === 'speaking' && app.narrator.engine === 'natural' && window.__audioActive(), null, 15000);
  check(ns && u.errors.length === 0, 'no Web Speech API: the natural voice still narrates');
  await u.page.close();

  // neither audio playback nor speech synthesis: controls disabled, everything else works
  const n = await openApp(browser, noSpeech + 'window.Audio = undefined;');
  const un = await n.page.evaluate(() => ({
    status: app.narrator.status, disabled: document.getElementById('nar-play').disabled,
    text: document.getElementById('nar-status').textContent, card: document.getElementById('step-desc').textContent.length,
  }));
  await n.page.click('#btn-next');
  const moved = await n.page.evaluate(() => app.seq.pos);
  check(un.status === 'unsupported' && un.disabled && un.card > 20 && moved === -1 && n.errors.length === 0,
    `no audio and no speech: controls disabled ("${un.text}"), written instructions and navigation still work`);
  await n.page.close();

  console.log('\n[5b] browser-voice fallback (recordings unavailable)');
  const offline = (page) => page.route('**/assets/narration/**', (r) => r.abort('internetdisconnected'));
  const f = await openApp(browser, speechMock({ msPerChar: 40 }), undefined, { setup: offline });
  const fst = () => f.page.evaluate(() => ({ pos: app.seq.pos, animating: app.seq.animating, status: app.narrator.status, id: app.narrator.id, engine: app.narrator.engine }));
  const fClick = (sel) => f.page.evaluate((q) => document.querySelector(q).click(), sel);
  await f.page.evaluate(() => app.seq.goTo(30));
  await waitFor(f.page, () => app.narrator.id === 30 && app.narrator.status === 'speaking' && window.__speechActive());
  s = await fst();
  const notice = await f.page.evaluate(() => ({ text: document.getElementById('toast').textContent, pe: getComputedStyle(document.getElementById('toast')).pointerEvents }));
  check(s.status === 'speaking' && s.id === 30 && s.engine === 'browser' && /browser voice/.test(notice.text) && notice.pe === 'none',
    `recordings unreachable → the browser voice narrates; notice "${notice.text}" (does not block the step buttons)`);
  const spoken = await f.page.evaluate(() => { const t = __speechLog.filter((x) => x.t === 'start').slice(-1)[0].text; return { t, ok: app.narrator.text.startsWith('Step 31.') && app.narrator.text.includes(t) }; });
  check(spoken.ok, `the sentence being spoken belongs to step 31: "${spoken.t.slice(0, 70)}"`);
  await fClick('#nar-play');
  s = await fst();
  const flabel = await f.page.textContent('#nar-play-label');
  check(s.status === 'paused' && flabel === 'Resume', `Pause → status ${s.status}, button "${flabel}"`);
  const paused = await f.page.evaluate(() => ({ idx: app.narrator.index, text: app.narrator.chunks[app.narrator.index], n: __speechLog.length }));
  await fClick('#nar-play');
  s = await fst();
  await waitFor(f.page, (k) => __speechLog.slice(k).some((x) => x.t === 'speak'), paused.n, 10000);
  const resumed = await f.page.evaluate((k) => __speechLog.slice(k).find((x) => x.t === 'speak').text, paused.n);
  check(s.status === 'speaking' && resumed === paused.text, `Resume → continues from the interrupted sentence ("${paused.text.slice(0, 50)}")`);
  await waitFor(f.page, () => app.narrator.index >= 1);
  await fClick('#nar-replay');
  const freplayed = await waitFor(f.page, () => app.narrator.index === 0 && app.narrator.status === 'speaking' && app.narrator.id === 30, null, 10000);
  check(freplayed, 'Replay → narration restarts from the beginning');
  await f.page.evaluate(() => app.seq.goTo(10));
  const fended = await waitFor(f.page, () => app.narrator.status === 'ended' && !app.seq.animating, null, 60000);
  const floops = await waitFor(f.page, () => app.seq.loopCount >= 2, null, 90000);
  const fonce = await f.page.evaluate(() => ({ pos: app.seq.pos, n: __speechLog.filter((x) => x.t === 'speak' && x.text === app.narrator.chunks[0]).length, toasts: 1 }));
  check(fended && floops && fonce.pos === 10 && fonce.n === 1, 'browser voice: narration spoken once per step while the animation loops, no automatic advance');
  const fvoice = await f.page.evaluate(() => ({ v: app.narrator.voice.name, kind: document.getElementById('nar-voice-kind').textContent, options: document.querySelectorAll('#nar-voice option').length }));
  check(/Natural/.test(fvoice.v) && /neural/.test(fvoice.kind) && fvoice.options === 2,
    `best English browser voice chosen automatically (${fvoice.v}); ${fvoice.options} English voices offered`);
  check(f.errors.filter((e) => !/narration|ERR_INTERNET_DISCONNECTED|Failed to load resource/.test(e)).length === 0, `no page errors ${JSON.stringify(f.errors.filter((e) => !/narration|ERR_INTERNET_DISCONNECTED|Failed to load resource/.test(e)).slice(0, 3))}`);
  await f.page.close();

  // one recording missing (404): that step falls back, the next step uses the natural voice again
  const m = await openApp(browser, speechMock(), undefined, { setup: (page) => page.route('**/assets/narration/**/step-13-*.mp3', (r) => r.fulfill({ status: 404, body: 'not found' })) });
  await m.page.evaluate(() => app.seq.goTo(12));
  const miss = await waitFor(m.page, () => app.narrator.id === 12 && app.narrator.engine === 'browser' && app.narrator.status === 'speaking' && window.__speechActive(), null, 15000);
  await m.page.evaluate(() => app.seq.goTo(13));
  const next = await waitFor(m.page, () => app.narrator.id === 13 && app.narrator.engine === 'natural' && app.narrator.status === 'speaking' && window.__audioActive() && !window.__speechActive(), null, 15000);
  check(miss && next, 'missing recording (HTTP 404) → browser voice for that step only; the next step plays its recording');
  await m.page.close();

  // web speech also unavailable: an explicit message, written instructions and navigation unaffected
  const e = await openApp(browser, noSpeech, undefined, { setup: offline });
  await e.page.evaluate(() => app.seq.goTo(2));
  await waitFor(e.page, () => app.narrator.status === 'error', null, 15000);
  const er = await e.page.evaluate(() => ({ status: app.narrator.status, text: document.getElementById('nar-status').textContent, toast: document.getElementById('toast').textContent, card: document.getElementById('step-desc').textContent }));
  await e.page.click('#btn-next');
  const emoved = await e.page.evaluate(() => app.seq.pos);
  check(er.status === 'error' && /written instructions/.test(er.text) && /not available/.test(er.toast) && er.card.length > 20 && emoved === 3,
    `no recordings and no speech: "${er.text}"; notice shown; navigation continues (step ${emoved + 1})`);
  await e.page.close();
}

async function testIntegration(browser) {
  console.log('\n[7] new STEP integration, instructions, step loop');
  const { page, errors } = await openApp(browser, speechMock());
  const d = await page.evaluate(async () => {
    const { model } = window.app;
    const { positionText } = await import('./js/ui/text.js');
    const { spokenText, forSpeech } = await import('./js/audio/spokenScript.js');
    const m = model.meta;
    const parts = model.partIds.map((id) => model.node(id));
    const texts = model.steps.map((s, k) => positionText(model, k));
    return {
      source: m.sourceFile, structure: m.structureSource,
      labelled: parts.filter((n) => n.label).length, parts: parts.length,
      names: new Set(parts.map((n) => n.label)).size,
      bomLabelled: model.bom.filter((r) => r.label || r.insideUnit).length, bom: model.bom.length,
      bomCell: document.querySelector('#bom-table tr[data-item="1.1.2"] .pn-label')?.textContent,
      longestTitle: Math.max(...texts.map((t) => t.title.length)),
      longestDesc: Math.max(...texts.map((t) => t.desc.length)),
      longestSpeechWords: Math.max(...texts.map((t) => t.speech.split(/\s+/).length)),
      sample: texts[17].speech,
      noPartNumbersSpoken: texts.every((t) => !/[A-Z0-9]{3,}-[A-Z0-9]{3,}/.test(t.speech)),
      spoken: model.steps.map((s, k) => forSpeech(spokenText(model, k))),
    };
  });
  check(d.source === 'MF-550-210-B_MIST_FIT_550_FINAL_NAMED.STEP' && d.structure && d.structure.verification.otherDifferences === 0
    && d.structure.verification.renamedBodies === 220,
  `model converted from ${d.source}; hierarchy/part numbers from ${d.structure && d.structure.structureFrom} (verified identical geometry)`);
  check(d.labelled === d.parts && d.names === 46 && d.bomLabelled === d.bom && d.bomCell === 'Back Panel',
    `all ${d.parts} parts carry their STEP name (${d.names} distinct); BOM shows names (item 1.1.2 = "${d.bomCell}")`);
  check(d.longestTitle <= 60 && d.longestDesc <= 170 && d.longestSpeechWords <= 40 && d.noPartNumbersSpoken,
    `instructions are short: title ≤ ${d.longestTitle} chars, instruction ≤ ${d.longestDesc} chars, speech ≤ ${d.longestSpeechWords} words, no part numbers read aloud — e.g. "${d.sample}"`);
  const sw = Math.max(...d.spoken.map((t) => t.split(/\s+/).length));
  check(sw <= 30 && d.spoken.every((t) => !/[A-Z0-9]{3,}-[A-Z0-9]{3,}|\(\d\/\d\)|\d\s*\/\s*\d/.test(t)),
    `spoken script: ≤ ${sw} words per step, no part numbers or "(1/2)" marks read aloud — e.g. "${d.spoken[34]}"`);
  check(errors.length === 0, `no page errors ${errors.length ? JSON.stringify(errors.slice(0, 3)) : ''}`);
  await page.close();
}

async function testGestures(browser) {
  console.log('\n[8] right-hand gesture navigation');
  // ---- pure modules on real MediaPipe landmarks ---------------------------------
  const { page, errors } = await openApp(browser, speechMock({ msPerChar: 60 }) + fakeTracker);
  const cases = {
    'thumbs up (photo)': [hand('thumb_up.jpg'), 'up'],
    'thumbs up tilted +25°': [hand('thumb_up.jpg', { rot: 25 }), 'up'],
    'thumbs up tilted −25°': [hand('thumb_up.jpg', { rot: -25 }), 'up'],
    'thumbs down (rotated photo)': [hand('thumb_up.jpg', { rot: 180 }), 'down'],
    'thumbs down tilted': [hand('thumb_up.jpg', { rot: 155 }), 'down'],
    'left-hand thumbs up (mirrored)': [hand('thumb_up.jpg', { mirror: true }), 'up'],
    'fist': [hand('fist.jpg'), 'none'],
    'fist rotated 90°': [hand('fist.jpg', { rot: 90 }), 'none'],
    'pointing up': [hand('pointing_up.jpg'), 'none'],
    'pointing down': [hand('pointing_up.jpg', { rot: 180 }), 'none'],
    'victory': [hand('victory.jpg'), 'none'],
    'open hand': [hand('right_hands.jpg'), 'none'],
    'open hand upside down': [hand('right_hands.jpg', { rot: 180 }), 'none'],
  };
  const cls = await page.evaluate(async (cases) => {
    const { classifyGesture } = await import('./js/gesture/GestureClassifier.js');
    const out = {};
    for (const [k, [h, want]] of Object.entries(cases)) {
      const r = classifyGesture(h.landmarks, h.world, { aspect: h.w / h.h });
      out[k] = { got: r.gesture, want, reason: r.reason };
    }
    return out;
  }, cases);
  const bad = Object.entries(cls).filter(([, v]) => v.got !== v.want);
  check(bad.length === 0, `classifier on real landmarks: ${Object.keys(cls).length} poses correct ${bad.map(([k, v]) => `${k}: ${v.got} (${v.reason})`).join('; ')}`);

  const unit = await page.evaluate(async () => {
    const { GestureTrigger } = await import('./js/gesture/GestureTrigger.js');
    const { physicalHand } = await import('./js/gesture/HandTracker.js');
    const T = new GestureTrigger({ stableFrames: 5, minHoldMs: 300, cooldownMs: 1000, neutralFrames: 4, maxGapFrames: 1 });
    const fires = [];
    let t = 0;
    const feed = (g, n, dt = 66) => { for (let i = 0; i < n; i++) { t += dt; const r = T.update(g, t); if (r.fire) fires.push([r.fire, t]); } };
    feed('up', 1); const single = fires.length;
    feed('none', 3);
    feed('up', 4); const four = fires.length;            // 4 frames: not stable yet
    feed('up', 40); const held = fires.length;           // held ~3 s: exactly one
    feed('down', 20); const otherWhileLocked = fires.length; // switching gesture without neutral: ignored
    feed('none', 4); feed('down', 6); const rearmed = fires.length;
    feed(null, 20); feed('up', 2); feed(null, 1); feed('up', 4); const gap = fires.length;  // 1-frame gap tolerated
    return {
      single, four, held, otherWhileLocked, rearmed, gap, fires: fires.map((f) => f[0]).join(','),
      hands: [physicalHand('Right'), physicalHand('Right', { inputMirrored: true }), physicalHand('Right', { swap: true }),
        physicalHand('Right', { inputMirrored: true, swap: true }), physicalHand('Left')].join(','),
    };
  });
  check(unit.single === 0 && unit.four === 0 && unit.held === 1 && unit.otherWhileLocked === 1 && unit.rearmed === 2 && unit.gap === 3,
    `trigger: 1 frame / 4 frames do not fire, a 3 s hold fires once, re-armed only after neutral, 1-frame drop-out tolerated (${unit.fires})`);
  check(unit.hands === 'Right,Left,Left,Right,Left', `handedness: raw frames = physical hand, mirrored input or swap option invert it (${unit.hands})`);

  // ---- end to end: fake camera (Chromium) + scripted tracker -----------------------
  const set = (h) => page.evaluate((h) => { window.__fakeHands = h; }, h);
  const pos = () => page.evaluate(() => app.seq.pos);
  const UP = [hand('thumb_up.jpg')], DOWN = [hand('thumb_up.jpg', { rot: 180 })];
  const LEFT_UP = [hand('thumb_up.jpg', { mirror: true })], LEFT_DOWN = [hand('thumb_up.jpg', { mirror: true, rot: 180 })];
  const OPEN = [hand('right_hands.jpg')];
  // headless SwiftShader renders slowly, so waits count processed camera frames, not seconds
  const frames = async (n) => {
    const c0 = await page.evaluate(() => window.__detectCalls);
    await waitFor(page, (c) => window.__detectCalls >= c, c0 + n, 60000);
  };
  const neutral = async () => {
    await set(OPEN); await frames(3); await set([]);
    await waitFor(page, () => app.gestures.trigger.state === 'ready', null, 30000);
  };

  if (process.env.GESTURE_DEBUG) {
    page.on('console', (m) => { if (m.text().startsWith('[dbg]')) console.log('    ' + m.text()); });
    await page.evaluate(() => {
      app.gestures.addEventListener('trigger', (e) => console.log(`[dbg] trigger ${e.detail.gesture} at pos ${app.seq.pos}`));
      app.gestures.addEventListener('status', (e) => console.log(`[dbg] status ${JSON.stringify(e.detail)}`));
    });
  }
  await page.click('#btn-gestures');
  const off = await page.evaluate(() => ({ panel: !document.getElementById('gesture-panel').hidden, cam: !!app.gestures.camera.stream }));
  check(off.panel && !off.cam, 'Gesture Control panel opens; the camera stays off until the user enables it');
  await page.click('#gp-toggle');
  const on = await waitFor(page, () => app.gestures.status.phase === 'on' && app.gestures.camera.active, null, 30000);   // fake camera start is slow under SwiftShader
  const ui = await page.evaluate(() => ({ cam: document.getElementById('gp-camera').textContent, chip: !document.getElementById('gesture-chip').hidden }));
  check(on && ui.chip, `enable → camera permission, tracker loaded, status "${ui.cam}", status chip on the 3D view`);

  await page.evaluate(() => app.seq.goTo(4));
  await waitFor(page, () => app.narrator.id === 4 && app.narrator.status === 'speaking');
  const logBefore = await page.evaluate(() => __audioLog.length);
  await set(UP);
  const moved = await waitFor(page, () => app.seq.pos === 5, null, 30000);
  const toast = await page.textContent('#gesture-toast');
  await frames(30);                                      // keep holding the thumbs up (~2 s at 15 fps)
  const held = await pos();
  const nar = await page.evaluate((n) => {
    const after = __audioLog.slice(n);
    return { id: app.narrator.id, src: app.state.get('lastNavigation').source,
      // step 5's recording was stopped by the gesture (or had already finished), step 6's plays alone
      cancelled: (after.some((x) => x.t === 'pause' && x.key === 'step-05') || __audioLog.some((x) => x.t === 'ended' && x.key === 'step-05'))
        && after.some((x) => x.t === 'play' && x.key === 'step-06') && app.narrator.recorded.current === 'step-06' };
  }, logBefore);
  check(moved && held === 5 && toast.includes('NEXT STEP ACTIVATED') && nar.src === 'gesture',
    `right thumbs up → NEXT once (step 6), held 2 s → still step ${held + 1}; feedback "${toast}"`);
  check(nar.id === 5 && nar.cancelled, 'gesture during narration: previous narration stopped, step 6 narration started');
  await neutral();
  await set(UP);
  const second = await waitFor(page, () => app.seq.pos === 6, null, 30000);
  await neutral();
  await set(DOWN);
  const back = await waitFor(page, () => app.seq.pos === 5, null, 30000);
  const toast2 = await page.textContent('#gesture-toast');
  check(second && back && toast2.includes('PREVIOUS STEP ACTIVATED'), `after returning to neutral: thumbs up → step 7, thumbs down → step 6 ("${toast2}")`);
  await neutral();
  await set(LEFT_UP);
  await frames(20);
  const leftHand = await page.evaluate(() => ({ pos: app.seq.pos, hand: app.gestures.status.hand }));
  await set(LEFT_DOWN);
  await frames(20);
  const leftDown = await pos();
  await set([...LEFT_UP, ...OPEN]);
  await frames(15);
  const both = await page.evaluate(() => ({ pos: app.seq.pos, hand: app.gestures.status.hand }));
  check(leftHand.pos === 5 && leftHand.hand === 'left' && leftDown === 5 && both.pos === 5 && both.hand === 'both',
    'left-hand thumbs up / down never navigate (also with the right hand in view)');
  await page.check('#gp-swap');
  await neutral();
  await set(LEFT_UP);
  const swapped = await waitFor(page, () => app.seq.pos === 6, null, 30000);
  await page.uncheck('#gp-swap');
  check(swapped, '"Swap left / right" option: a hand labelled Left is then treated as the right hand');
  await neutral();

  // during an animation, and at the boundaries
  await page.evaluate(() => { app.seq.speed = 0.25; app.seq.goTo(20); });
  await set(UP);
  const anim = await waitFor(page, () => app.seq.pos === 21 && app.seq.animating, null, 30000);
  await page.evaluate(() => { app.seq.speed = 1; });
  check(anim, 'thumbs up during an animation: transitions to the next step and animates it');
  await neutral();
  await page.evaluate(() => app.seq.goTo(app.seq.last));
  await set(UP);
  await waitFor(page, () => !document.getElementById('gesture-toast').hidden && document.getElementById('gesture-toast').textContent.includes('Final'), null, 30000);
  const atEnd = await page.evaluate(() => ({ pos: app.seq.pos, last: app.seq.last, toast: document.getElementById('gesture-toast').textContent }));
  await neutral();
  await page.evaluate(() => app.seq.goTo(-2));
  await set(DOWN);
  await waitFor(page, () => document.getElementById('gesture-toast').textContent.includes('first'), null, 30000);
  const atStart = await page.evaluate(() => ({ pos: app.seq.pos, toast: document.getElementById('gesture-toast').textContent }));
  check(atEnd.pos === atEnd.last && atStart.pos === -2, `boundaries: thumbs up on the final step ("${atEnd.toast}") and thumbs down on the overview ("${atStart.toast}") are ignored`);
  await neutral();

  // button and gesture share one navigation function
  await page.evaluate(() => app.seq.goTo(8));
  await page.click('#btn-next');
  const viaButton = await page.evaluate(() => ({ pos: app.seq.pos, src: app.state.get('lastNavigation').source, nar: app.narrator.id }));
  await set(UP);
  await waitFor(page, () => app.seq.pos === 10, null, 30000);
  const viaGesture = await page.evaluate(() => ({ pos: app.seq.pos, src: app.state.get('lastNavigation').source }));
  check(viaButton.pos === 9 && viaButton.src === 'button' && viaGesture.pos === 10 && viaGesture.src === 'gesture',
    'NEXT STEP button and thumbs up use the same App.next() (step 9 → 10 → 11)');
  await neutral();

  // disable: camera released, gestures ignored
  await page.click('#gp-toggle');
  const calls = await page.evaluate(() => window.__detectCalls);
  await set(UP);
  await page.waitForTimeout(1500);
  const dis = await page.evaluate((c) => ({ pos: app.seq.pos, cam: app.gestures.camera.stream, calls: window.__detectCalls - c, phase: app.gestures.status.phase, chip: document.getElementById('gesture-chip').hidden }), calls);
  check(dis.pos === 10 && dis.cam === null && dis.calls === 0 && dis.phase === 'off' && dis.chip,
    'disable → camera released, no tracking, thumbs up ignored');
  check(errors.length === 0, `no page errors ${errors.length ? JSON.stringify(errors.slice(0, 3)) : ''}`);
  await page.close();

  // permission denied / no camera API: manual navigation unaffected
  const deny = `navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));`;
  const p2 = await openApp(browser, speechMock() + fakeTracker + deny);
  await p2.page.click('#btn-gestures');
  await p2.page.click('#gp-toggle');
  await waitFor(p2.page, () => app.gestures.status.phase === 'error');
  const msg = await p2.page.textContent('#gp-msg');
  await p2.page.click('#btn-next');
  const mpos = await p2.page.evaluate(() => app.seq.pos);
  check(/denied/i.test(msg) && mpos === -1 && p2.errors.length === 0, `camera permission denied → "${msg.slice(0, 60)}…"; NEXT STEP button still works`);
  await p2.page.close();
  const p3 = await openApp(browser, speechMock() + 'Object.defineProperty(navigator, "mediaDevices", { value: undefined });');
  const un = await p3.page.evaluate(() => ({ dis: document.getElementById('gp-toggle').disabled, msg: document.getElementById('gp-msg').textContent }));
  await p3.page.click('#btn-next');
  const upos = await p3.page.evaluate(() => app.seq.pos);
  check(un.dis && un.msg.length > 10 && upos === -1, 'browser without camera access: gesture control disabled with an explanation, buttons work');
  await p3.page.close();
}

async function testAR(browser) {
  console.log('\n[6] WebXR AR flow (IWER emulation)');
  const nm = (p) => path.join(ROOT, 'node_modules', p);
  if (!fs.existsSync(nm('iwer')) || !fs.existsSync(nm('@iwer/sem'))) {
    console.log('  – skipped: run `npm install` to get iwer and @iwer/sem (devDependencies)');
    return;
  }
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.addInitScript(pinProfile('high'));
  await page.addInitScript(speechMock() + fakeTracker);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/__iwer/iwer.js', (r) => r.fulfill({ path: nm('iwer/build/iwer.module.js'), contentType: 'text/javascript' }));
  await page.route('**/__iwer/sem.js', (r) => r.fulfill({ path: nm('@iwer/sem/build/es/index.js'), contentType: 'text/javascript' }));
  await page.route('**/__iwer/room.json', (r) => r.fulfill({ path: nm('@iwer/sem/captures/living_room.json'), contentType: 'application/json' }));
  await page.route(`${BASE}/`, async (route) => {
    const res = await route.fetch();
    let html = await res.text();
    html = html.replace('"three/addons/": "./vendor/three/addons/"', '"three/addons/": "./vendor/three/addons/", "iwer": "./__iwer/iwer.js"');
    html = html.replace('<script type="module" src="js/main.js"></script>', `<script type="module">
      import { XRDevice, metaQuest3 } from 'iwer';
      import { SyntheticEnvironmentModule } from './__iwer/sem.js';
      const d = new XRDevice(metaQuest3); d.installRuntime({ forceInstall: true }); d.installSEM(SyntheticEnvironmentModule);
      window.xrDevice = d;
      window.semReady = fetch('./__iwer/room.json').then((r) => r.json()).then((j) => d.sem.loadEnvironment(j));
    </script><script type="module" src="js/main.js"></script>`);
    route.fulfill({ response: res, body: html, headers: { ...res.headers(), 'content-type': 'text/html' } });
  });
  await page.goto(`${BASE}/`);
  await page.waitForFunction(() => window.app && window.app.arCaps, null, { timeout: 120000 });
  await page.evaluate(() => window.semReady);
  const caps = await page.evaluate(() => ({ mode: app.arCaps.mode, state: app.arCaps.state, btn: document.getElementById('btn-ar').dataset.ar, label: document.getElementById('btn-ar-label').textContent }));
  check(caps.mode === 'webxr' && caps.state === 'supported' && caps.btn === 'supported', `AR detected: ${caps.mode}, state ${caps.state}, button "${caps.label}" (green status)`);
  await page.evaluate(() => window.xrDevice.quaternion.set(-0.5, 0, 0, 0.866));
  await page.evaluate(() => app.gestures.enable());
  const gOn = await waitFor(page, () => app.gestures.status.phase === 'on', null, 10000);
  await page.click('#btn-ar');
  await page.waitForFunction(() => window.app.xr && window.app.xr.reticle.visible, null, { timeout: 20000 }).catch(() => {});
  let s = await page.evaluate(() => ({ presenting: app.viewer.renderer.xr.isPresenting, reticle: app.xr.reticle.visible, btn: document.getElementById('btn-ar').dataset.ar, cam: app.cameraCtl.mode }));
  check(s.presenting && s.reticle, 'immersive-ar session started from the AR button, floor found by hit-test');
  check(s.btn === 'active' && s.cam === 'ar', `AR state shown as active; automatic 3D camera hands over to the device (${s.cam})`);
  const gAR = await page.evaluate(() => ({ phase: app.gestures.status.phase, reason: app.gestures.status.reason, cam: app.gestures.camera.stream }));
  check(gOn && gAR.phase === 'paused' && gAR.reason === 'ar' && gAR.cam === null, 'gesture camera released while WebXR owns the camera (tracking paused)');
  await page.evaluate(async () => { const c = window.xrDevice.controllers.right; c.updateButtonValue('trigger', 1); await new Promise((r) => setTimeout(r, 300)); c.updateButtonValue('trigger', 0); });
  await page.waitForFunction(() => !window.app.xr.placing, null, { timeout: 10000 }).catch(() => {});
  s = await page.evaluate(() => ({ placed: !app.xr.placing, visible: app.viewer.stage.visible, y: app.viewer.stage.position.y }));
  check(s.placed && s.visible, `model placed on the detected floor (stage y = ${s.y.toFixed(2)} m)`);
  s = await page.evaluate(async () => {
    app.seq.speed = 30; app.seq.goTo(10);
    document.getElementById('ar-next').click();
    await new Promise((r) => setTimeout(r, 1500));
    app.xr.setScale(0.5);
    return { pos: app.seq.pos, title: document.getElementById('ar-step-badge').textContent, scale: app.viewer.stage.scale.x, narr: app.narrator.id };
  });
  check(s.pos === 11 && s.title === 'Step 12 / 69' && s.scale === 0.5 && s.narr === 11, `NEXT, narration and scaling inside AR (${s.title}, scale ${s.scale})`);
  await page.evaluate(() => app.xr.end());
  await page.waitForFunction(() => !window.app.inAR, null, { timeout: 10000 }).catch(() => {});
  s = await page.evaluate(() => ({ inAR: app.inAR, stage: app.viewer.stage.position.length(), btn: document.getElementById('btn-ar').dataset.ar, cam: app.cameraCtl.mode }));
  check(!s.inAR && s.stage === 0 && s.btn === 'supported' && s.cam === 'auto', 'session ends cleanly; 3D viewer, AR button and automatic camera restored');
  const gBack = await waitFor(page, () => app.gestures.status.phase === 'on' && app.gestures.camera.active, null, 10000);
  check(gBack, 'gesture tracking resumes automatically after the AR session');
  check(errors.length === 0, `no page errors during AR ${errors.length ? JSON.stringify(errors.slice(0, 3)) : ''}`);
  await page.close();
}

async function testCamera(browser) {
  console.log('\n[9] automatic step camera');
  const { page, errors } = await openApp(browser, speechMock() + fakeTracker);
  // every step: target = the components listed in assembly.json steps[k].nodes
  const rv = await page.evaluate(() => {
    const r = app.cameraCtl.review();
    const ok = r.filter((x) => x.source === 'steps[k].nodes' && x.parts > 0 && Number.isFinite(x.radiusMm) && x.radiusMm > 0);
    const views = new Set(r.map((x) => `${x.elevationDeg}/${x.azimuthDeg}`));
    const sameParts = app.model.steps.every((s, k) => app.cameraCtl.stepParts[k].size === new Set(s.nodes.flatMap((id) => app.model.partsUnder(id))).size);
    return { n: r.length, ok: ok.length, views: views.size, sameParts, flagged: r.filter((x) => x.flags.some((f) => f.startsWith('enclosed'))).map((x) => x.step) };
  });
  check(rv.n === 69 && rv.ok === 69 && rv.sameParts, `camera targets computed for ${rv.ok} / ${rv.n} steps from steps[k].nodes (no invented targets)`);
  check(rv.views >= 8, `${rv.views} different viewpoints chosen from the geometry (not one fixed position)`);
  console.log(`    review: enclosed steps (x-ray highlight, flagged for manual review): ${rv.flagged.join(', ') || 'none'}`);

  // representative steps: first, single part, fasteners, large part, sub-assembly install, other area, final
  const cases = { 0: 'first', 2: 'fasteners ×6', 3: 'large structural part', 17: 'single part', 21: 'sub-assembly', 40: 'motor area washers', 55: 'rivets all over the unit', 68: 'final' };
  const bad = [];
  for (const [k, what] of Object.entries(cases)) {
    await page.evaluate((k) => app.next && app.seq.goTo(+k), k);
    // steady state: entry animation finished, camera arrived on the final (fully evaluated) view
    await waitFor(page, (k) => app.cameraCtl.goal && app.cameraCtl.goal.pos === +k && app.cameraCtl.goal.final && !app.cameraCtl.tween && !app.seq.animating, k, 60000);
    await page.waitForTimeout(300);
    const r = await page.evaluate((k) => {
      const THREE = app.viewer.camera.constructor;   // just to reach Vector3 via a projection helper below
      const cam = app.viewer.camera;
      cam.updateMatrixWorld(); cam.updateProjectionMatrix();
      const vp = document.getElementById('viewport').getBoundingClientRect();
      const card = document.getElementById('step-card').getBoundingClientRect();
      const left = card.width < vp.width * 0.6 ? card.right - vp.left : 0;
      const top = card.width < vp.width * 0.6 ? 0 : card.bottom - vp.top;
      const ids = [...app.cameraCtl.stepParts[k]];
      let inside = 0;
      // final (CAD) position of each component: its box centre with this step's entries at f = 0
      for (const id of ids) {
        const box = app.viewer.boxOf(app.loaded.objects.get(id));
        const c = box.getCenter(app.viewer.camera.position.clone());
        // parts may be mid-loop: use the CAD position = current minus the step offset
        const e = app.explode.entries.find((x) => x.step === +k && app.model.partsUnder(x.id).includes(id));
        if (e) c.addScaledVector(e.vec.clone(), -app.explode.f[app.explode.index.get(e.id)]);
        const p = c.project(cam);
        const x = (p.x + 1) / 2 * vp.width, y = (1 - p.y) / 2 * vp.height;
        if (p.z < 1 && x >= left - 2 && x <= vp.width + 2 && y >= top - 2 && y <= vp.height + 2) inside++;
      }
      const dist = cam.position.distanceTo(app.viewer.controls.target);
      return { inside, n: ids.length, dist, radius: app.cameraCtl.goal.radius, modelR: app.cameraCtl.modelRadius };
    }, k);
    if (r.inside < r.n || r.dist < r.radius) bad.push(`step ${+k + 1} (${what}): ${r.inside}/${r.n} visible`);
    else console.log(`    step ${String(+k + 1).padStart(2)} ${what.padEnd(26)} ${r.n} components in view, camera ${r.dist.toFixed(2)} m from target (focus radius ${(r.radius * 1000).toFixed(0)} mm)`);
  }
  check(bad.length === 0, `representative steps: all components of the step inside the uncovered viewport ${bad.join('; ')}`);

  // smooth transition: no jumps, orbit around the target
  const smooth = await page.evaluate(async () => {
    app.seq.goTo(10);
    await new Promise((r) => setTimeout(r, 50));
    const samples = [];
    await new Promise((resolve) => {
      const t0 = performance.now();
      const tick = () => {
        samples.push(app.viewer.camera.position.clone());
        if (app.cameraCtl.tween || performance.now() - t0 < 300) requestAnimationFrame(tick); else resolve();
      };
      requestAnimationFrame(tick);
    });
    let path = 0, maxStep = 0;
    for (let i = 1; i < samples.length; i++) { const d = samples[i].distanceTo(samples[i - 1]); path += d; maxStep = Math.max(maxStep, d); }
    return { frames: samples.length, path, maxStep };
  });
  check(smooth.frames > 5 && smooth.maxStep < Math.max(0.35 * smooth.path, 0.02), `smooth move: ${smooth.frames} frames, largest frame step ${(smooth.maxStep * 100).toFixed(1)} cm of a ${(smooth.path * 100).toFixed(0)} cm path`);

  // the step loop: each cycle moves the step's parts out and back in; PREVIOUS removes a part without snapping back
  const loopShape = await page.evaluate(async () => {
    app.seq.goTo(40);
    const e = app.explode.entries.findIndex((x) => x.step === 40);
    const seen = [];
    await new Promise((resolve) => {
      const tick = () => { seen.push([app.seq.loopCount, app.explode.f[e]]); if (app.seq.loopCount < 3) requestAnimationFrame(tick); else resolve(); };
      requestAnimationFrame(tick);
    });
    const byCycle = {};
    for (const [c, f] of seen) (byCycle[c] = byCycle[c] || []).push(f);
    const cycles = [1, 2].map((c) => ({ max: Math.max(...byCycle[c]), last: byCycle[c][byCycle[c].length - 1] }));
    app.seq.goTo(41);
    await new Promise((r) => { const w = () => (app.seq.animating ? requestAnimationFrame(w) : r()); w(); });
    const e41 = app.explode.entries.findIndex((x) => x.step === 41);
    app.seq.speed = 0.5; app.seq.goTo(40);
    const path = [];
    await new Promise((resolve) => { const tick = () => { path.push(app.explode.f[e41]); if (app.seq.animating) requestAnimationFrame(tick); else resolve(); }; requestAnimationFrame(tick); });
    app.seq.speed = 1;
    let back = 0;
    for (let i = 1; i < path.length; i++) back = Math.max(back, path[i - 1] - path[i]);
    return { cycles, prevEnd: path[path.length - 1], back };
  });
  check(loopShape.cycles.every((c) => c.max > 0.95 && c.last < 0.02) && loopShape.prevEnd > 0.99 && loopShape.back < 1e-6,
    `loop: every cycle moves the parts out (f ${loopShape.cycles.map((c) => c.max.toFixed(2)).join(', ')}) and back to the CAD position; PREVIOUS removes the next step's part smoothly (no snap-back)`);

  // the user takes over: drag → paused, camera left alone while the step loops; Refocus / next step resume
  await waitFor(page, () => !app.cameraCtl.tween, null, 20000);
  const vp = await page.evaluate(() => { const r = document.querySelector('#viewport canvas').getBoundingClientRect(); return { x: r.left + r.width * 0.72, y: r.top + r.height * 0.5 }; });
  await page.mouse.move(vp.x, vp.y); await page.mouse.down(); await page.mouse.move(vp.x + 120, vp.y + 30, { steps: 6 }); await page.mouse.up();
  // orbit damping is frame-based: wait until the user's orbit has fully come to rest
  await page.evaluate(async () => {
    let last = app.viewer.camera.position.clone();
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setTimeout(r, 150));
      const now = app.viewer.camera.position.clone();
      if (now.distanceTo(last) < 1e-5) break;
      last = now;
    }
  });
  const p1 = await page.evaluate(() => ({ mode: app.cameraCtl.mode, chip: !document.getElementById('cam-chip').hidden, pos: app.viewer.camera.position.toArray(), loops: app.seq.loopCount, step: app.seq.pos }));
  await waitFor(page, (l) => app.seq.loopCount > l, p1.loops, 30000);
  const p2 = await page.evaluate(() => ({ pos: app.viewer.camera.position.toArray(), loops: app.seq.loopCount, step: app.seq.pos }));
  const still = p1.pos.every((v, i) => Math.abs(v - p2.pos[i]) < 1e-3);
  check(p1.mode === 'paused' && p1.chip && still && p2.step === p1.step && p2.loops > p1.loops,
    `manual orbit pauses the automatic camera ("Auto camera paused" + Refocus shown); view kept while the step keeps looping (${p1.mode}, still ${still}, loops ${p1.loops}→${p2.loops})`);
  await page.click('#cam-refocus');
  const re = await waitFor(page, () => app.cameraCtl.mode === 'auto' && document.getElementById('cam-chip').hidden && !app.cameraCtl.tween, null, 20000);
  check(re, 'Refocus restores the recommended view of the current step');
  await page.mouse.move(vp.x, vp.y); await page.mouse.wheel(0, -300); await page.waitForTimeout(300);
  const zoomPaused = await page.evaluate(() => app.cameraCtl.mode);
  await page.click('#btn-next');
  const resumed = await page.evaluate(() => ({ mode: app.cameraCtl.mode, goal: app.cameraCtl.goal.pos, pos: app.seq.pos, src: app.state.get('lastNavigation').source }));
  check(zoomPaused === 'paused' && resumed.mode === 'auto' && resumed.goal === resumed.pos, 'zooming pauses it too; NEXT STEP resumes automatic focus on the new step');

  // every navigation input moves the camera through the same path
  const inputs = [];
  await page.keyboard.press('ArrowRight'); inputs.push(await page.evaluate(() => [app.state.get('lastNavigation').source, app.cameraCtl.goal.pos === app.seq.pos]));
  await page.click('#btn-prev'); inputs.push(await page.evaluate(() => [app.state.get('lastNavigation').source, app.cameraCtl.goal.pos === app.seq.pos]));
  await page.click('#btn-gestures'); await page.click('#gp-toggle');
  await waitFor(page, () => app.gestures.status.phase === 'on', null, 15000);
  const before = await page.evaluate(() => app.seq.pos);
  await page.evaluate((h) => { window.__fakeHands = h; }, [hand('thumb_up.jpg')]);
  await waitFor(page, (b) => app.seq.pos === b + 1, before, 30000);
  await page.evaluate(() => { window.__fakeHands = []; });
  inputs.push(await page.evaluate(() => [app.state.get('lastNavigation').source, app.cameraCtl.goal.pos === app.seq.pos]));
  await page.click('#gp-toggle');
  check(inputs.every((x) => x[1]) && inputs.map((x) => x[0]).join(',') === 'key,button,gesture', `camera follows every input: ${inputs.map((x) => x[0]).join(', ')}`);

  // narration once per step, loop never advances, with the camera running
  await page.evaluate(() => app.seq.goTo(30));
  const loopOk = await waitFor(page, () => app.seq.loopCount >= 2, null, 90000);
  const lo = await page.evaluate(() => ({ pos: app.seq.pos, spoken: __audioLog.filter((x) => x.t === 'play' && x.key === 'step-31').length }));
  check(loopOk && lo.pos === 30 && lo.spoken === 1, 'with the camera active the loop still never advances and the narration is spoken once');

  // turn the automatic camera off: steps no longer move the view; setting persists
  await page.click('#tool-focus');
  const offPos = await page.evaluate(() => app.viewer.camera.position.toArray());
  await page.click('#btn-next');
  await page.waitForTimeout(1500);
  const off = await page.evaluate((p0) => ({ mode: app.cameraCtl.mode, same: app.viewer.camera.position.toArray().every((v, i) => Math.abs(v - p0[i]) < 1e-3), saved: localStorage.getItem('mf550.camera.auto') }), offPos);
  await page.click('#tool-focus');
  const on = await page.evaluate(() => app.cameraCtl.mode);
  check(off.mode === 'off' && off.same && off.saved === 'false' && on === 'auto', 'Auto camera toggle: off keeps the view on step changes (saved), on refocuses');
  check(errors.length === 0, `no page errors ${errors.length ? JSON.stringify(errors.slice(0, 3)) : ''}`);
  await page.close();
}

async function testARCapabilities(browser) {
  console.log('\n[10] AR capability detection (Chrome) and camera overlay');
  const { page, errors } = await openApp(browser, speechMock() + fakeTracker);
  const det = await page.evaluate(async () => {
    const { detectAR, arErrorText } = await import('./js/ar/ARSupport.js');
    const nav = (o) => ({
      userAgent: o.ua, userAgentData: o.brands ? { brands: o.brands.map((b) => ({ brand: b })) } : undefined, platform: o.platform || '', maxTouchPoints: o.touch || 0,
      xr: o.xr === undefined ? undefined : { isSessionSupported: async () => o.xr },
      permissions: { query: async () => ({ state: o.cam || 'prompt' }) },
      mediaDevices: { getUserMedia: () => {} },
    });
    const doc = (o) => ({ createElement: () => ({ relList: { supports: (t) => !!o.ql && t === 'ar' } }), permissionsPolicy: { allowsFeature: () => o.policy !== false } });
    const win = (o) => ({ isSecureContext: o.secure !== false });
    const run = async (o) => { const r = await detectAR({ nav: nav(o), doc: doc(o), win: win(o) }); return `${r.mode}/${r.state}: ${r.reason}`; };
    const androidChrome = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36';
    const deskChrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
    const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
    return {
      androidOk: await run({ ua: androidChrome, brands: ['Google Chrome'], xr: true }),
      androidDenied: await run({ ua: androidChrome, brands: ['Google Chrome'], xr: true, cam: 'denied' }),
      androidPolicy: await run({ ua: androidChrome, brands: ['Google Chrome'], xr: true, policy: false }),
      androidNoArcore: await run({ ua: androidChrome, brands: ['Google Chrome'], xr: false }),
      desktopChrome: await run({ ua: deskChrome, brands: ['Google Chrome'], xr: false }),
      iphone: await run({ ua: iphone, ql: true }),
      insecure: await run({ ua: androidChrome, brands: ['Google Chrome'], xr: true, secure: false }),
      err: arErrorText({ name: 'NotAllowedError' }, 'Chrome'),
    };
  });
  for (const [k, v] of Object.entries(det)) console.log(`    ${k.padEnd(15)} ${v.slice(0, 120)}`);
  check(det.androidOk.startsWith('webxr/supported') && det.androidDenied.startsWith('webxr/needs-permission') && det.androidPolicy.startsWith('webxr/needs-permission')
    && det.androidNoArcore.startsWith('none/unavailable') && /ARCore/.test(det.androidNoArcore) && det.desktopChrome.startsWith('none/unavailable') && /phone or tablet/.test(det.desktopChrome)
    && det.iphone.startsWith('quicklook/supported') && det.insecure.startsWith('webxr/unavailable') && /HTTPS/.test(det.insecure) && /allow camera access/.test(det.err),
  'states: supported (Android Chrome + ARCore), needs-permission (camera denied / embedded), unavailable with reason (no ARCore, desktop Chrome, no HTTPS), Quick Look on iPhone');

  // this headless desktop Chromium: no immersive AR → never presented as AR
  const ui = await page.evaluate(() => ({ state: document.getElementById('btn-ar').dataset.ar, label: document.getElementById('btn-ar-label').textContent, title: document.getElementById('btn-ar').title }));
  await page.click('#btn-ar');
  await page.waitForSelector('#ar-dialog[open]');
  const dlg = await page.evaluate(() => ({ text: document.getElementById('ar-dialog-body').innerText, overlay: !!document.getElementById('ar-overlay-start') }));
  check(ui.state === 'unavailable' && ui.label !== 'View in AR' && /no AR tracking|no WebXR AR/.test(ui.title) && /not available here/.test(dlg.text) && dlg.overlay,
    `unsupported browser: button "${ui.label}" (grey) with the reason; dialog explains and offers the camera overlay`);

  // camera overlay fallback: labelled "not AR", pauses gesture tracking, resumes after
  await page.click('#ar-dialog [value=close]');
  await page.click('#btn-gestures'); await page.click('#gp-toggle');
  await waitFor(page, () => app.gestures.status.phase === 'on', null, 15000);
  await page.click('#btn-ar'); await page.waitForSelector('#ar-dialog[open]');
  await page.click('#ar-overlay-start');
  const ov = await waitFor(page, () => app.cameraView.active && !document.getElementById('overlay-video').paused, null, 30000);
  const o = await page.evaluate(() => ({
    banner: document.getElementById('overlay-banner').innerText, btn: document.getElementById('btn-ar').dataset.ar,
    g: app.gestures.status.phase + '/' + app.gestures.status.reason, xr: app.viewer.renderer.xr.isPresenting,
  }));
  await page.click('#btn-next');
  const nav = await page.evaluate(() => app.seq.pos);
  await page.click('#overlay-exit');
  const back = await waitFor(page, () => !app.cameraView.active && app.gestures.status.phase === 'on', null, 15000);
  check(ov && /not AR/.test(o.banner) && o.btn === 'overlay' && o.g === 'paused/overlay' && !o.xr && nav === -1 && back,
    `camera overlay: camera picture behind the 3D view, labelled "not AR", gestures paused and resumed, navigation works (${JSON.stringify({ ov, banner: o.banner.slice(0, 40), btn: o.btn, g: o.g, xr: o.xr, nav, back })})`);
  check(errors.length === 0, `no page errors ${errors.length ? JSON.stringify(errors.slice(0, 3)) : ''}`);
  await page.close();
}

async function testBrandingAndBom(browser) {
  console.log('\n[11] Mist-Fit 550 branding, hidden source file name, BOM without item numbers');
  const { page, errors } = await openApp(browser, speechMock());
  const OLD = 'MF-550-210-B', FILE = 'MF-550-210-B_MIST_FIT_550_FINAL_NAMED.STEP';
  const visible = () => page.evaluate(() => {
    const attrs = [...document.querySelectorAll('*')].flatMap((e) => ['title', 'aria-label', 'alt', 'placeholder'].map((a) => e.getAttribute(a) || ''));
    const dialogs = [...document.querySelectorAll('dialog')].map((d) => d.textContent);
    return [document.title, document.body.innerText, ...attrs, ...dialogs].join('\n');
  });
  const texts = [];
  const brand = await page.evaluate(() => ({ title: document.title, head: document.getElementById('product-title').textContent, overview: document.getElementById('step-title').textContent, speech: app.narrator.text || '' }));
  texts.push(await visible());
  for (const k of [0, 10, 20, 50, 68]) { await page.evaluate((k) => app.seq.goTo(k), k); await page.waitForTimeout(200); texts.push(await visible()); }
  // details of a top-level row and of a part instance, the AR dialog and help
  await page.evaluate(() => app.select({ row: app.model.rowByItem.get('1') }));
  texts.push(await visible());
  await page.evaluate(() => app.select({ row: app.model.rowByItem.get('1.1.2'), partId: app.model.rowByItem.get('1.1.2').nodes[0] }));
  texts.push(await visible());
  const all = texts.join('\n');
  check(brand.title.startsWith('Mist-Fit 550') && brand.head === 'Mist-Fit 550' && /Mist-Fit 550/.test(brand.overview) && !all.includes(OLD),
    `visible name "Mist-Fit 550" (tab title, header, overview, details path); "${OLD}" not shown anywhere`);
  check(!all.includes(FILE) && !/MIST_FIT|\.STEP\b/.test(all), 'the STEP source file name is not shown (viewer, panels, dialogs, tooltips)');

  // v1.4: AEROEX symbol (supplied artwork) in the header and loading screen, favicon
  const logo = await page.evaluate(async () => {
    const img = document.querySelector('.brand-logo');
    const r = img.getBoundingClientRect();
    const title = document.getElementById('product-title').getBoundingClientRect();
    const view = document.getElementById('viewport').getBoundingClientRect();
    const icons = [...document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"]')];
    const iconOk = await Promise.all(icons.map(async (l) => {
      const res = await fetch(l.href); const b = await createImageBitmap(await res.blob());
      return { href: l.getAttribute('href'), ok: res.ok, square: b.width === b.height, size: b.width };
    }));
    const orig = await Promise.all(['assets/brand/original/images.png', 'assets/brand/original/Logo.jpg'].map(async (u) => (await fetch(u)).ok));
    return {
      loaded: img.complete && img.naturalWidth > 0, alt: img.alt, ratio: r.width / r.height, natural: img.naturalWidth / img.naturalHeight,
      h: r.height, beforeTitle: r.right <= title.left, insideHeader: r.bottom <= view.top + 1,
      loader: !!document.querySelector('#loader .loader-logo'), iconOk, orig,
      productTitle: document.getElementById('product-title').textContent, docTitle: document.title,
    };
  });
  check(logo.loaded && logo.alt === 'AEROEX Technologies' && Math.abs(logo.ratio - logo.natural) < 0.01 && logo.h >= 20 && logo.h <= 32
    && logo.beforeTitle && logo.insideHeader && logo.loader && logo.productTitle === 'Mist-Fit 550' && logo.docTitle.startsWith('Mist-Fit 550'),
  `AEROEX symbol in the header (${logo.h}px high, proportions ${logo.ratio.toFixed(3)} = artwork ${logo.natural.toFixed(3)}) and on the loading screen; product title stays "${logo.productTitle}"`);
  check(logo.iconOk.length >= 3 && logo.iconOk.every((i) => i.ok && i.square) && logo.orig.every(Boolean),
    `favicon / touch icons from the AEROEX symbol (${logo.iconOk.map((i) => `${i.size}px`).join(', ')}); original artwork kept (images.png, Logo.jpg)`);

  const bom = await page.evaluate(() => {
    const t = document.getElementById('bom-table');
    const head = [...t.querySelectorAll('th')].map((x) => x.textContent);
    const rows = [...t.querySelectorAll('tbody tr')];
    const hier = /(^|\s)\d+(\.\d+)+(\s|$)/;
    return {
      head, items: rows.filter((r) => hier.test(r.innerText)).length, rows: rows.length, cItem: t.querySelectorAll('.c-item').length,
      card: document.getElementById('step-components').textContent, detailsHead: document.getElementById('details-item').textContent,
      callouts: [...document.querySelectorAll('.callout-label')].map((c) => c.textContent).join(' | '),
      parts: [...document.querySelectorAll('#parts-table tbody tr')].filter((r) => hier.test(r.innerText)).length,
      dataItems: rows.filter((r) => r.dataset.item).length, rowByItem: app.model.rowByItem.size,
      nested: app.model.bom.filter((r) => r.item.split('.').length > 2).length, parents: app.model.bom.filter((r) => r.parent).length,
    };
  });
  check(bom.head.join('|') === 'Component|Qty|Step' && bom.items === 0 && bom.cItem === 0 && bom.parts === 0
    && !/\d+\.\d+\.\d+|BOM item/.test(bom.card + bom.detailsHead + bom.callouts) && !/^Item /.test(bom.detailsHead),
  `no hierarchical item numbers in the BOM (${bom.rows} rows), parts list, step card, details or balloons — columns: ${bom.head.join(' / ')}`);
  check(bom.dataItems === 78 && bom.rowByItem === 78 && bom.nested > 0 && bom.parents > 0,
    `internal structure intact: ${bom.rowByItem} BOM rows keyed by item, ${bom.nested} nested rows, parent links, part numbers unchanged`);
  // selection, highlight and step sync still work from the BOM
  await page.click('#bom-table tr[data-item="1.1.4"]');
  const sel = await page.evaluate(() => ({ sel: app.state.get('selection'), title: document.getElementById('details-title').textContent, hi: [...app.selection.partSet].length }));
  await page.click('#details-goto');
  const go = await page.evaluate(() => ({ pos: app.seq.pos, cur: document.querySelector('#bom-table tr.is-current')?.dataset.item }));
  check(sel.sel === '1.1.4' && sel.title === 'Filter Element Track' && sel.hi === 1 && go.pos === 6 && go.cur === '1.1.4',
    `BOM row click selects + highlights "${sel.title}"; "Go to step" → step ${go.pos + 1}, BOM row current`);
  check(errors.length === 0, `no page errors ${errors.length ? JSON.stringify(errors.slice(0, 3)) : ''}`);
  await page.close();
}

async function testVoiceAssets(browser) {
  console.log('\n[12] natural-voice recordings');
  const { page, errors } = await openApp(browser, speechMock());
  const r = await page.evaluate(async () => {
    const { narrationText, narrationKeys } = await import('./js/audio/narrationScript.js');
    const { model } = window.app;
    const man = await (await fetch('assets/narration/manifest.json', { cache: 'no-store' })).json();
    const ctx = new OfflineAudioContext(1, 24000, 24000);
    const missing = [], textDiff = [], bad = [], durDiff = [], names = [];
    let positions = 0, bytes = 0;
    const jobs = [];
    for (let pos = -2; pos <= model.stepCount; pos++) {
      positions++;
      const { key } = narrationKeys(model, pos);
      const e = man.entries[key];
      if (!e) { missing.push(key); continue; }
      if (e.text !== narrationText(model, pos)) textDiff.push(key);
      names.push(e.file);
      jobs.push(fetch(`assets/narration/${e.file}`).then(async (res) => {
        const buf = await res.arrayBuffer();
        bytes += buf.byteLength;
        if (!res.ok || buf.byteLength !== e.bytes || !/audio\/mpeg/.test(res.headers.get('content-type') || '')) {
          bad.push(`${key}: HTTP ${res.status}, ${buf.byteLength} bytes, ${res.headers.get('content-type')}`); return;
        }
        try {
          const ab = await ctx.decodeAudioData(buf);
          if (Math.abs(ab.duration - e.duration) > 0.15) durDiff.push(`${key}: ${ab.duration.toFixed(2)} s vs ${e.duration}`);
        } catch (err) { bad.push(`${key}: ${err.name}`); }
      }));
    }
    await Promise.all(jobs);
    return { positions, count: man.count, voice: man.voice, format: man.format, missing, textDiff, bad, durDiff, bytes,
      descriptive: names.every((f) => /^en-US-heart\/(overview|parts-kit|complete|step-\d\d-[a-z0-9-]+)\.mp3$/.test(f)),
      unique: new Set(names).size === names.length, sample: names[10] };
  });
  check(r.positions === 72 && r.count === 72 && r.missing.length === 0 && r.textDiff.length === 0,
    `${r.count} recordings for ${r.positions} positions (overview, parts kit, 69 steps, completion), each of exactly the spoken script ${[...r.missing, ...r.textDiff].join(' ')}`);
  check(r.bad.length === 0 && r.durDiff.length === 0,
    `every MP3 downloads (audio/mpeg) and decodes in the browser with its listed duration (${(r.bytes / 1e6).toFixed(2)} MB) ${[...r.bad, ...r.durDiff].slice(0, 3).join('; ')}`);
  check(r.descriptive && r.unique && r.voice.model === 'Kokoro-82M v1.0' && r.voice.voice === 'af_heart' && r.format.loudnessLUFS === -17 && r.format.codec === 'mp3',
    `${r.voice.model} voice "${r.voice.voiceName}" (${r.voice.lang}), loudness-normalised to ${r.format.loudnessLUFS} LUFS, descriptive file names (e.g. ${r.sample})`);
  // real playback in the browser's media pipeline (plain page: the software-rendered 3D loop of
  // headless SwiftShader would delay event delivery): plays to its end, in real time
  const file = await page.evaluate(() => app.narrator.recorded.manifest.entries['step-06'].file);
  const plain = await browser.newPage();
  await plain.goto(`${BASE}/assets/narration/manifest.json`);
  const real = await plain.evaluate(async (f) => {
    const a = new Audio(f);                       // relative to assets/narration/
    let tp = 0;
    a.onplaying = () => { tp = performance.now(); };
    await a.play();
    await new Promise((res, rej) => { a.onended = res; a.onerror = rej; setTimeout(() => rej(new Error('timeout')), 20000); });
    return { secs: (performance.now() - tp) / 1000, dur: a.duration, end: a.currentTime };
  }, file).catch((e) => ({ error: e.message }));
  await plain.close();
  check(!real.error && Math.abs(real.secs - real.dur) < 0.6 && Math.abs(real.end - real.dur) < 0.05,
    `real playback of step 6: ${real.secs?.toFixed(2)} s for a ${real.dur?.toFixed(2)} s recording, played to the end ${real.error || ''}`);
  check(errors.length === 0, `no page errors ${errors.length ? JSON.stringify(errors.slice(0, 3)) : ''}`);
  await page.close();
}


async function testPerformance(browser) {
  console.log('\n[13] performance profiles (v1.5)');
  // automatic choice from the WebGL renderer string (pure function)
  {
    const { page } = await openApp(browser, speechMock());
    const det = await page.evaluate(async () => {
      const { detectProfile, isSoftware } = await import('./js/perf/Profiles.js');
      const nav = { hardwareConcurrency: 8, deviceMemory: 8 };
      const d = (renderer) => detectProfile({ renderer, software: isSoftware(renderer) }, nav).id;
      return {
        pi5: d('ANGLE (Broadcom, V3D 7.1.10.2, OpenGL ES 3.1 Mesa 25.0.7)'), pi4: d('V3D 4.2.14.0'),
        llvmpipe: d('llvmpipe (LLVM 19.1.7, 128 bits)'), swiftshader: d('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)'),
        nvidia: d('ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)'),
        mali: d('Mali-G610'), small: detectProfile({ renderer: 'Intel(R) UHD Graphics' }, { hardwareConcurrency: 4, deviceMemory: 4 }).id,
      };
    });
    check(det.pi5 === 'balanced' && det.pi4 === 'low' && det.llvmpipe === 'low' && det.swiftshader === 'low' && det.nvidia === 'high' && det.mali === 'balanced' && det.small === 'balanced',
      `automatic profile: Pi 5 (V3D 7) → ${det.pi5}, Pi 4 (V3D 4) → ${det.pi4}, llvmpipe / SwiftShader → ${det.llvmpipe} / ${det.swiftshader}, desktop GPU → ${det.nvidia}, Mali → ${det.mali}, 4 cores + 4 GB → ${det.small}`);

    // the three model tiers: same components, names, BOM ids, transforms; geometry within the stated tolerance
    const tiers = await page.evaluate(async () => {
      const THREE = await import('three');
      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
      const { MeshoptDecoder } = await import('three/addons/libs/meshopt_decoder.module.js');
      const info = await (await fetch('assets/model/model-tiers.json', { cache: 'no-store' })).json();
      const loader = new GLTFLoader(); loader.setMeshoptDecoder(MeshoptDecoder);
      const load = async (file) => (await loader.loadAsync('assets/model/' + file)).scene;
      const describe = (root) => {
        root.updateMatrixWorld(true);
        const nodes = [], boxes = new Map();
        let tris = 0, meshes = 0;
        root.traverse((o) => {
          nodes.push(`${o.name}|${o.userData.nid || ''}|${o.position.toArray().map((x) => x.toFixed(9))}|${o.quaternion.toArray().map((x) => x.toFixed(9))}|${o.scale.toArray().map((x) => x.toFixed(9))}|${o.isMesh ? o.material.name : ''}`);
          if (o.isMesh) { meshes++; tris += o.geometry.index.count / 3; }
          if (o.userData.nid) boxes.set(o.userData.nid, new THREE.Box3().setFromObject(o));
        });
        return { sig: nodes.join('\n'), tris, meshes, boxes };
      };
      const high = describe(await load(info.high.file));
      const out = { high: { tris: high.tris, meshes: high.meshes } };
      for (const t of ['balanced', 'low']) {
        const d = describe(await load(info.tiers[t].file));
        let dev = 0;
        for (const [id, b] of high.boxes) {
          const o = d.boxes.get(id);
          dev = Math.max(dev, Math.abs(o.min.x - b.min.x), Math.abs(o.min.y - b.min.y), Math.abs(o.min.z - b.min.z), Math.abs(o.max.x - b.max.x), Math.abs(o.max.y - b.max.y), Math.abs(o.max.z - b.max.z));
        }
        out[t] = { same: d.sig === high.sig, tris: d.tris, meshes: d.meshes, maxBoxDevMm: +(dev * 1000).toFixed(3), limitMm: info.tiers[t].maxErrorMm,
          recordedMm: info.tiers[t].measuredBoundsMm, kB: Math.round(info.tiers[t].bytes / 1024) };
      }
      return out;
    });
    for (const t of ['balanced', 'low']) {
      const x = tiers[t];
      // the error target is meshoptimizer's metric, not a hard bound: the measured change is recorded by the tool
      check(x.same && x.meshes === tiers.high.meshes && x.tris < tiers.high.tris * 0.3 && x.maxBoxDevMm <= x.recordedMm + 0.005 && x.maxBoxDevMm <= 1.5 * x.limitMm,
        `${t} model: identical node tree (names, BOM ids, transforms, materials, ${x.meshes} meshes), ${tiers.high.tris} → ${x.tris} triangles, component bounds moved ≤ ${x.maxBoxDevMm} mm (target ${x.limitMm} mm, recorded ${x.recordedMm} mm), ${x.kB} kB`);
    }

    // precomputed camera plans = the runtime planner (both ghosting options)
    const plans = await page.evaluate(() => {
      const c = app.cameraCtl;
      const pre = c.precomputed;
      if (!pre) return { loaded: false };
      const steps = [0, 12, 29, 40, 55, 68];
      let worstVis = 0, worstT = 0, worstR = 0, same = true;
      for (const ghost of [true, false]) {
        app.setOption('ghost', ghost);
        for (const k of steps) {
          const p = c.plan(k);
          c.usePrecomputed(null, '');
          const r = c.plan(k);
          worstT = Math.max(worstT, p.target.distanceTo(r.target));
          worstR = Math.max(worstR, Math.abs(p.radius - r.radius));
          p.candidates.forEach((x, i) => { worstVis = Math.max(worstVis, Math.abs(x.visibility - r.candidates[i].visibility)); });
          same = same && p.precomputed && !r.precomputed;
          c.usePrecomputed(pre, pre.key);
        }
      }
      app.setOption('ghost', true);
      const stale = c.usePrecomputed({ ...pre, key: 'other model' }, pre.key);
      c.usePrecomputed(pre, pre.key);
      return { loaded: true, same, worstVis, worstTmm: worstT * 1000, worstRmm: worstR * 1000, staleIgnored: !stale };
    });
    check(plans.loaded && plans.same && plans.worstVis < 2e-4 && plans.worstTmm < 0.01 && plans.worstRmm < 0.01 && plans.staleIgnored,
      `precomputed camera plans equal the runtime planner (6 steps × 2 ghost options: visibility Δ ${plans.worstVis?.toExponential(1)}, target Δ ${plans.worstTmm?.toFixed(4)} mm); a file for another model is ignored`);
    await page.close();
  }

  // profiles as loaded by the app
  for (const prof of ['balanced', 'low']) {
    const { page, errors } = await openApp(browser, speechMock(), undefined, { profile: null, query: `?profile=${prof}` });
    await waitFor(page, () => document.getElementById('loader').style.display === 'none', null, 20000);
    const r = await page.evaluate(() => ({ id: app.perf.id, tier: app.modelTier, pr: app.viewer.renderer.getPixelRatio(), aa: app.viewer.renderer.getContext().getContextAttributes().antialias,
      cap: app.perf.settings.maxFps, edgesOn: app.opts.edges, blur: getComputedStyle(document.querySelector('.step-card')).backdropFilter, plans: !!app.cameraCtl.precomputed,
      worker: app.gestures.cfg.worker, gfps: app.gestures.cfg.fps, aw: app.gestures.cfg.analysisWidth, cam: app.cameraView.constraints }));
    const ok = prof === 'balanced'
      ? r.tier === 'balanced' && r.pr <= 1 && r.aa === true && r.cap === 30 && r.edgesOn && r.blur === 'none' && r.gfps === 12 && r.cam.width === 1280
      : r.tier === 'low' && r.pr <= 0.75 && r.aa === false && r.cap === 30 && !r.edgesOn && r.blur === 'none' && r.gfps === 8 && r.aw === 320 && r.cam.width === 640;
    check(ok && r.id === prof && r.plans && r.worker && errors.length === 0,
      `?profile=${prof}: model ${r.tier}, pixel ratio ${r.pr}, MSAA ${r.aa}, ${r.cap} fps cap, edges ${r.edgesOn ? 'on' : 'off'}, no backdrop blur, gestures ${r.gfps} Hz at ${r.aw} px in a worker, camera ${r.cam.width}×${r.cam.height}@${r.cam.frameRate}`);
    await page.close();
  }

  // demand rendering, static transforms, analytic floor lift (High profile)
  {
    const { page, errors } = await openApp(browser, speechMock());
    await waitFor(page, () => document.getElementById('loader').style.display === 'none', null, 20000);
    await page.evaluate(() => app.seq.goTo(-2, { animate: false }));
    // frame-based windows (independent of how fast this machine renders)
    const settled = await waitFor(page, () => {
      const s = app.viewer.stats;
      if (window.__lr !== s.renders) { window.__lr = s.renders; window.__lt = s.ticks; return false; }
      return s.ticks - window.__lt >= 3;
    }, null, 120000);
    const ticksWindow = (n, action) => page.evaluate(async ([n, action]) => {
      const s = app.viewer.stats; const r0 = s.renders, t0 = s.ticks;
      if (action === 'select') app.select({ row: app.model.bom[3] });
      if (action === 'step') app.seq.goTo(10);
      while (s.ticks - t0 < n) await new Promise((r) => setTimeout(r, 20));
      if (action === 'select') app.select(null);
      return { renders: s.renders - r0, ticks: s.ticks - t0 };
    }, [n, action]);
    const idle = await ticksWindow(4);
    const sel = (await ticksWindow(2, 'select')).renders;
    const anim = await ticksWindow(4, 'step');
    check(settled && idle.ticks >= 4 && idle.renders === 0 && sel >= 1 && anim.renders >= anim.ticks - 1,
      `on-demand rendering: still view ${idle.renders} draws in ${idle.ticks} loop frames; a BOM selection draws (${sel}); the step animation draws every frame (${anim.renders} / ${anim.ticks})`);
    // invariant: every world matrix equals a full forced recomputation (no stale transforms), at several poses
    const inv = await page.evaluate(async () => {
      const THREE = await import('three');
      const v = app.viewer;
      let worst = 0, worstLift = 0, checked = 0;
      for (const pos of [-1, 3, 29, 40, 68, -2]) {
        app.seq.goTo(pos);
        for (let i = 0; i < 6; i++) { await new Promise((r) => setTimeout(r, 300)); }
        app.cameraCtl.focus(pos);                                          // also uses localToWorld paths
        v.scene.updateMatrixWorld();                                       // what the renderer does
        const snap = [];
        v.scene.traverse((o) => snap.push([o, o.matrixWorld.clone()]));
        v.scene.traverse((o) => { if (o.matrixAutoUpdate) THREE.Object3D.prototype.updateMatrix.call(o); });
        v.scene.updateMatrixWorld(true);                                   // stock three.js: recompute everything
        for (const [o, m] of snap) { for (let i = 0; i < 16; i++) worst = Math.max(worst, Math.abs(m.elements[i] - o.matrixWorld.elements[i])); checked++; }
        const y = v.modelRoot.position.y; v.modelRoot.position.y = 0; v.modelRoot.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(v.model);
        v.modelRoot.position.y = y; v.modelRoot.updateMatrixWorld(true);
        worstLift = Math.max(worstLift, Math.abs(box.min.y - app.explode.lowestPoint()));
      }
      return { worst, worstLift, checked };
    });
    check(inv.worst < 1e-9 && inv.worstLift < 1e-9,
      `static transforms: ${inv.checked} world matrices at 6 poses equal a full recomputation (max Δ ${inv.worst.toExponential(1)}); analytic floor lift = bounding-box lift (Δ ${inv.worstLift.toExponential(1)} m)`);
    check(errors.length === 0, `no page errors ${errors.length ? JSON.stringify(errors.slice(0, 3)) : ''}`);
    await page.close();
  }

  // gesture tracking off the main thread: async trackers keep at most one frame in flight; late results are dropped
  {
    const asyncTracker = `(() => {
      window.__fakeHands = []; window.__detectCalls = 0; window.__inflight = 0; window.__maxInflight = 0;
      window.__MF550_TEST_TRACKER__ = () => ({
        landmarker: null, delegate: null, async: true, stats: { mode: 'worker', inferMs: 0, mainMs: 0 },
        async init() { this.landmarker = {}; this.delegate = 'TEST'; },
        detect() { throw new Error('sync detect must not be used'); },
        detectAsync() { window.__detectCalls++; window.__inflight++; window.__maxInflight = Math.max(window.__maxInflight, window.__inflight);
          return new Promise((r) => setTimeout(() => { window.__inflight--; this.stats.inferMs = 120; r({ hands: window.__fakeHands }); }, 120)); },
        close() { this.landmarker = null; },
      });
    })();`;
    const { page, errors } = await openApp(browser, speechMock() + asyncTracker);
    await page.evaluate(() => app.gestures.enable());
    await waitFor(page, () => app.gestures.status.phase === 'on', null, 20000);
    await page.waitForTimeout(2000);
    const g = await page.evaluate(() => ({ calls: window.__detectCalls, max: window.__maxInflight, stats: app.gestures.perfStats }));
    await page.evaluate(() => app.gestures.disable());
    const after = await page.evaluate(async () => { const n = window.__detectCalls; await new Promise((r) => setTimeout(r, 600)); return window.__detectCalls - n; });
    check(g.calls >= 3 && g.max === 1 && after === 0 && g.stats.mode === 'worker' && errors.length === 0,
      `async (worker) tracking: ${g.calls} frames analysed in 2 s with a 120 ms model, never more than ${g.max} in flight, nothing after disabling; dashboard reports ${g.stats.mode}, ${g.stats.inferMs} ms`);
    await page.close();
  }

  // development dashboard (hidden by default) and the display-quality setting
  {
    const { page, errors } = await openApp(browser, speechMock());
    await waitFor(page, () => document.getElementById('loader').style.display === 'none', null, 20000);
    const hud0 = await page.evaluate(() => document.querySelector('.perf-hud').hidden);
    await page.keyboard.press('Control+Shift+P');
    await page.waitForTimeout(700);
    const hud = await page.evaluate(() => ({ hidden: document.querySelector('.perf-hud').hidden, text: document.querySelector('.perf-hud').innerText }));
    await page.keyboard.press('Control+Shift+P');
    const opts = await page.evaluate(() => [...document.querySelectorAll('#perf-profile option')].map((o) => o.value));
    const loaderGone = await page.evaluate(() => getComputedStyle(document.getElementById('loader')).display);
    const want = ['Frames / s', 'Frame time', 'Draw calls', 'Triangles', 'Meshes', 'JS heap', 'Gestures', 'Camera', 'Model', 'GPU', 'Acceleration'];
    check(hud0 && !hud.hidden && want.every((w) => hud.text.includes(w)) && /SOFTWARE/.test(hud.text),
      `performance dashboard hidden by default, Ctrl+Shift+P shows FPS, frame time, draw calls, triangles, meshes, memory, camera/gesture rates, model load and the WebGL renderer (here: software rendering flagged)`);
    check(opts.join() === 'auto,high,balanced,low' && loaderGone === 'none' && errors.length === 0,
      `Display quality offers ${opts.join(' / ')}; the loader (and its spinner) leaves the page after loading`);
    await page.close();
  }

  // on-device benchmark (?bench): runs the scripted sequence and reports every phase
  {
    const { page, errors } = await openApp(browser, speechMock(), undefined, { query: '?bench' });
    const done = await waitFor(page, () => !!window.__benchReport, null, 120000);
    const r = await page.evaluate(() => window.__benchReport);
    check(done && r.phases.length === 6 && r.phases.every((p) => p.seconds > 0) && r.profile === 'high' && errors.length === 0,
      `?bench: ${r ? r.phases.length : 0} phases measured (${r ? r.phases.map((p) => `${p.phase}: ${p.drawnFps} fps`).join('; ') : ''})`);
    await page.close();
  }
}

(async () => {
  await startServer();
  const browser = await launch();
  try {
    const only = process.env.ONLY;     // e.g. ONLY=gestures npm test
    const run = (name) => !only || only.split(',').includes(name);
    if (run('viewer')) await testViewer(browser);
    if (run('navigation')) await testNavigationAndVoice(browser);
    if (run('integration')) await testIntegration(browser);
    if (run('gestures')) await testGestures(browser);
    if (run('ar')) await testAR(browser);
    if (run('camera')) await testCamera(browser);
    if (run('archrome')) await testARCapabilities(browser);
    if (run('branding')) await testBrandingAndBom(browser);
    if (run('voice')) await testVoiceAssets(browser);
    if (run('perf')) await testPerformance(browser);
  } finally {
    await browser.close();
    if (server) server.kill();
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})();
