/**
 * End-to-end checks (headless Chromium via Playwright).
 *
 *   npm test                      # starts tools/serve.mjs on :8099 and runs all checks
 *   BASE_URL=https://opinofaeroex.github.io/mf550-assembly/public npm test   # test the live site
 *
 * Headless Chromium has no speech voices, so the Web Speech API is replaced by a
 * deterministic in-page mock (speechSynthesis + SpeechSynthesisUtterance) that logs
 * every speak / start / end / cancel. The app code under test is unchanged.
 *
 * [1] Viewer & data: loads without errors; GLB ↔ assembly.json; geometry of every part
 *     within tolerance of the OpenCascade B-rep boxes.
 * [2] Exploded view ×3: every displayed vector = 3 × the pipeline vector, same direction;
 *     components return to their exact CAD positions.
 * [3] Synchronisation for all steps: positions, highlight, BOM row, step card, narration script.
 * [4] Manual navigation: NEXT/PREVIOUS buttons, boundaries, no automatic advance after the
 *     animation or the narration, navigation during animation, rapid clicks.
 * [5] Narration: auto-start on step entry, previous narration cancelled, pause / resume /
 *     replay / mute via the UI, blocked-until-gesture, unsupported browser fallback.
 * [6] WebXR AR flow under the Immersive Web Emulation Runtime (IWER + SEM), incl. NEXT in AR
 *     and the gesture camera being released during the AR session.
 * [7] New STEP integration: names from MF-550-210-B_MIST_FIT_550_FINAL_NAMED.STEP, structure
 *     map provenance, concise step instructions (card text == spoken text), step loop.
 * [8] Right-hand gestures: classifier on real MediaPipe landmarks (tests/fixtures), trigger
 *     state machine, and end-to-end with a fake camera + scripted tracker: thumbs up / down
 *     navigate exactly once, left hand ignored, boundaries, disable, permission denied.
 *     (The real MediaPipe model is checked on the live site, see README § Tests.)
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
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
}

async function openApp(browser, init, viewport = { width: 1280, height: 800 }) {
  const page = await browser.newPage({ viewport });
  if (init) await page.addInitScript(init);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${BASE}/`);
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
      const script = narrationText(model, k);
      const desc = document.getElementById('step-desc').textContent;
      const title = document.getElementById('step-title').textContent;
      if (script !== `Step ${k + 1}. ${title}. ${desc}`) problems.push(`step ${k + 1}: narration differs from the card`);
    }
    return { problems, steps: model.stepCount };
  });
  check(sync.problems.length === 0, `${sync.steps} steps: positions, highlight, BOM row, step card and narration script in sync ${sync.problems.slice(0, 3).join('; ')}`);
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
  const loopInfo = await page.evaluate(() => {
    const first = app.narrator.chunks[0];
    return { loops: app.seq.loopCount, spoken: __speechLog.filter((x) => x.t === 'speak' && x.text === first).length, first,
      log: __speechLog.filter((x) => x.text === first).map((x) => x.t).join(',') };
  });
  check(ended && loops && s.pos === 10 && loopInfo.spoken === 1,
    `step 11: animation repeated ${loopInfo.loops}× without changing step; narration spoken once (status ${s.status}${loopInfo.spoken === 1 ? '' : `; "${loopInfo.first}": ${loopInfo.log}`})`);

  // navigation during animation, and rapid clicks
  await page.evaluate(() => { app.seq.speed = 0.25; app.seq.goTo(20); });
  const during = await page.evaluate(() => app.seq.animating);
  await page.click('#btn-prev');
  s = await st();
  check(during && s.pos === 19 && s.animating, 'PREVIOUS during an animation: new step animates (no overlap)');
  await page.evaluate(() => { app.seq.speed = 1; });
  for (let i = 0; i < 6; i++) await page.click('#btn-next', { delay: 0 });
  s = await st();
  check(s.pos === 25, `6 rapid NEXT clicks → step ${s.pos + 1}`);
  await waitFor(page, () => app.narrator.id === app.seq.pos && __speechLog.some((x) => x.t === 'start' && x.text.startsWith(`Step ${app.seq.pos + 1} of`)), null, 20000);
  const overlap = await page.evaluate(() => {
    const log = __speechLog;
    const lastLoad = log.map((x) => x.text).lastIndexOf(`Step ${app.seq.pos + 1} of 69.`);
    const after = log.slice(lastLoad).filter((x) => x.t === 'speak').map((x) => x.text);
    return { after, current: app.narrator.text };
  });
  check(overlap.after.every((t) => overlap.current.includes(t)), 'after rapid clicks only the current step is narrated (stale narrations cancelled)');

  console.log('\n[5] voice narration');
  // DOM clicks: same click event on the same buttons, without Playwright's actionability round-trips
  // (headless SwiftShader is slow enough for a short sentence to end in between)
  const domClick = (sel) => page.evaluate((q) => document.querySelector(q).click(), sel);
  await page.evaluate(() => app.seq.goTo(30));
  await waitFor(page, () => app.narrator.id === 30 && app.narrator.status === 'speaking' && window.__speechActive());
  s = await st();
  check(s.status === 'speaking' && s.id === 30, 'narration starts automatically when entering a step');
  const spoken = await page.evaluate(() => { const t = __speechLog.filter((x) => x.t === 'start').slice(-1)[0].text; return { t, ok: app.narrator.text.startsWith('Step 31.') && app.narrator.text.includes(t) }; });
  check(spoken.ok, `the sentence being spoken belongs to step 31: "${spoken.t.slice(0, 70)}"`);
  await domClick('#nar-play');
  s = await st();
  const label1 = await page.textContent('#nar-play-label');
  check(s.status === 'paused' && label1 === 'Resume', `Pause → status ${s.status}, button "${label1}"`);
  const paused = await page.evaluate(() => ({ idx: app.narrator.index, text: app.narrator.chunks[app.narrator.index], n: __speechLog.length }));
  await domClick('#nar-play');
  s = await st();
  await waitFor(page, (n) => __speechLog.slice(n).some((x) => x.t === 'speak'), paused.n, 10000);
  const resumed = await page.evaluate((n) => __speechLog.slice(n).find((x) => x.t === 'speak').text, paused.n);
  check(s.status === 'speaking' && resumed === paused.text, `Resume → continues from the interrupted sentence ("${paused.text.slice(0, 50)}")`);
  await waitFor(page, () => app.narrator.index >= 1);
  await domClick('#nar-replay');
  s = await st();
  check(s.pos === 30 && s.animating, 'Replay → same step, animation restarts');
  const replayed = await waitFor(page, () => app.narrator.index === 0 && app.narrator.status === 'speaking' && app.narrator.id === 30, null, 10000);
  check(replayed, 'Replay → narration restarts from the beginning');
  await page.click('#nar-mute');
  s = await st();
  const speakingAfterMute = await page.evaluate(() => window.__speechActive());
  check(s.status === 'muted' && !speakingAfterMute, 'Mute → speech stops immediately');
  const before = await page.evaluate(() => __speechLog.length);
  await page.click('#btn-next');
  await page.waitForTimeout(600);
  const spokeWhileMuted = await page.evaluate((n) => __speechLog.slice(n).some((x) => x.t === 'speak'), before);
  check(!spokeWhileMuted, 'NEXT while muted → no speech');
  await page.click('#nar-mute');
  const unmuted = await waitFor(page, () => app.narrator.status === 'speaking' && app.narrator.id === 31);
  check(unmuted, 'Unmute → narrates the current step');
  await page.keyboard.press('Space');
  check((await st()).status === 'paused', 'Space key pauses the narration');
  await page.keyboard.press('ArrowRight');
  const kb = await waitFor(page, () => app.seq.pos === 32 && app.narrator.id === 32 && app.narrator.status === 'speaking');
  check(kb, '→ key: next step, new narration starts');
  const voiceInfo = await page.evaluate(() => ({ v: app.narrator.voice.name, kind: document.getElementById('nar-voice-kind').textContent, options: document.querySelectorAll('#nar-voice option').length }));
  check(/Natural/.test(voiceInfo.v) && /neural/.test(voiceInfo.kind) && voiceInfo.options === 2,
    `best English voice chosen automatically (${voiceInfo.v}); ${voiceInfo.options} English voices offered`);
  check(errors.length === 0, `no page errors ${errors.length ? JSON.stringify(errors.slice(0, 3)) : ''}`);
  await page.close();

  // browsers that block speech until the first user gesture
  const g = await openApp(browser, speechMock({ requireGesture: true }));
  await g.page.evaluate(() => app.seq.goTo(3));
  const blocked = await waitFor(g.page, () => app.narrator.status === 'blocked');
  const hint = await g.page.textContent('#nar-status');
  await g.page.mouse.click(600, 400);
  const unlocked = await waitFor(g.page, () => app.narrator.status === 'speaking' && window.__speechActive());
  check(blocked && unlocked, `speech blocked before the first gesture ("${hint}"), starts on the first tap`);
  await g.page.close();

  // browser without speech synthesis
  const u = await openApp(browser, noSpeech);
  const un = await u.page.evaluate(() => ({
    status: app.narrator.status, disabled: document.getElementById('nar-play').disabled,
    text: document.getElementById('nar-status').textContent, card: document.getElementById('step-desc').textContent.length,
  }));
  await u.page.click('#btn-next');
  const moved = await u.page.evaluate(() => app.seq.pos);
  check(un.status === 'unsupported' && un.disabled && un.card > 20 && moved === -1 && u.errors.length === 0,
    `no Web Speech API: controls disabled ("${un.text}"), written instructions and navigation still work`);
  await u.page.close();
}

async function testIntegration(browser) {
  console.log('\n[7] new STEP integration, instructions, step loop');
  const { page, errors } = await openApp(browser, speechMock());
  const d = await page.evaluate(async () => {
    const { model } = window.app;
    const { positionText } = await import('./js/ui/text.js');
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
    };
  });
  check(d.source === 'MF-550-210-B_MIST_FIT_550_FINAL_NAMED.STEP' && d.structure && d.structure.verification.otherDifferences === 0
    && d.structure.verification.renamedBodies === 220,
  `model converted from ${d.source}; hierarchy/part numbers from ${d.structure && d.structure.structureFrom} (verified identical geometry)`);
  check(d.labelled === d.parts && d.names === 46 && d.bomLabelled === d.bom && d.bomCell === 'Back Panel',
    `all ${d.parts} parts carry their STEP name (${d.names} distinct); BOM shows names (item 1.1.2 = "${d.bomCell}")`);
  check(d.longestTitle <= 60 && d.longestDesc <= 170 && d.longestSpeechWords <= 40 && d.noPartNumbersSpoken,
    `instructions are short: title ≤ ${d.longestTitle} chars, instruction ≤ ${d.longestDesc} chars, speech ≤ ${d.longestSpeechWords} words, no part numbers read aloud — e.g. "${d.sample}"`);
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
  const on = await waitFor(page, () => app.gestures.status.phase === 'on' && app.gestures.camera.active, null, 15000);
  const ui = await page.evaluate(() => ({ cam: document.getElementById('gp-camera').textContent, chip: !document.getElementById('gesture-chip').hidden }));
  check(on && ui.chip, `enable → camera permission, tracker loaded, status "${ui.cam}", status chip on the 3D view`);

  await page.evaluate(() => app.seq.goTo(4));
  await waitFor(page, () => app.narrator.id === 4 && app.narrator.status === 'speaking');
  const logBefore = await page.evaluate(() => __speechLog.length);
  await set(UP);
  const moved = await waitFor(page, () => app.seq.pos === 5, null, 30000);
  const toast = await page.textContent('#gesture-toast');
  await frames(30);                                      // keep holding the thumbs up (~2 s at 15 fps)
  const held = await pos();
  const nar = await page.evaluate((n) => ({ id: app.narrator.id, cancelled: __speechLog.slice(n).some((x) => x.t === 'cancel'), src: app.state.get('lastNavigation').source }), logBefore);
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
  const lo = await page.evaluate(() => ({ pos: app.seq.pos, spoken: __speechLog.filter((x) => x.t === 'speak' && x.text === app.narrator.chunks[0]).length }));
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
  const ov = await waitFor(page, () => app.cameraView.active && !document.getElementById('overlay-video').paused, null, 15000);
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
  } finally {
    await browser.close();
    if (server) server.kill();
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})();
