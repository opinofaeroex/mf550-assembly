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
 * [6] WebXR AR flow under the Immersive Web Emulation Runtime (IWER + SEM), incl. NEXT in AR.
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

/** In-page Web Speech API mock. opts.requireGesture: refuse ('not-allowed') until a pointerdown. */
const speechMock = (opts = {}) => `(() => {
  const log = []; let queue = []; let cur = null; let speaking = false; let gesture = ${opts.requireGesture ? 'false' : 'true'};
  addEventListener('pointerdown', () => { gesture = true; }, true);
  const fire = (u, type, extra) => u.dispatchEvent(Object.assign(new Event(type), extra || {}));
  const pump = () => {
    if (cur || !queue.length) { speaking = !!cur; return; }
    cur = queue.shift(); speaking = true;
    const u = cur;
    setTimeout(() => { if (cur === u) { log.push({ t: 'start', text: u.text }); fire(u, 'start'); } }, 5);
    setTimeout(() => { if (cur !== u) return; cur = null; log.push({ t: 'end', text: u.text }); fire(u, 'end'); pump(); }, 30 + u.text.length * 10);
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
  return chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
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
      if (!script.startsWith(`Step ${k + 1} of ${model.stepCount}.`) || !script.includes(`BOM item`)) problems.push(`step ${k + 1}: narration script`);
    }
    return { problems, steps: model.stepCount };
  });
  check(sync.problems.length === 0, `${sync.steps} steps: positions, highlight, BOM row, step card and narration script in sync ${sync.problems.slice(0, 3).join('; ')}`);
  await page.close();
}

async function testNavigationAndVoice(browser) {
  console.log('\n[4] manual navigation');
  const { page, errors } = await openApp(browser, speechMock());
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

  // no automatic advance after the animation and the narration
  await page.evaluate(() => app.seq.goTo(10));
  const ended = await waitFor(page, () => app.narrator.status === 'ended' && !app.seq.animating, null, 60000);
  await page.waitForTimeout(2500);
  s = await st();
  check(ended && s.pos === 10, `animation + narration finished, still on step 11 after waiting (status ${s.status})`);

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
  await page.evaluate(() => app.seq.goTo(30));
  await waitFor(page, () => app.narrator.id === 30 && app.narrator.status === 'speaking' && window.__speechActive());
  s = await st();
  check(s.status === 'speaking' && s.id === 30, 'narration starts automatically when entering a step');
  const spoken = await page.evaluate(() => { const t = __speechLog.filter((x) => x.t === 'start').slice(-1)[0].text; return { t, ok: app.narrator.text.startsWith('Step 31 of 69.') && app.narrator.text.includes(t) }; });
  check(spoken.ok, `the sentence being spoken belongs to step 31: "${spoken.t.slice(0, 70)}"`);
  await page.click('#nar-play');
  s = await st();
  const label1 = await page.textContent('#nar-play-label');
  check(s.status === 'paused' && label1 === 'Resume', `Pause → status ${s.status}, button "${label1}"`);
  const paused = await page.evaluate(() => ({ idx: app.narrator.index, text: app.narrator.chunks[app.narrator.index], n: __speechLog.length }));
  await page.click('#nar-play');
  s = await st();
  await waitFor(page, (n) => __speechLog.slice(n).some((x) => x.t === 'speak'), paused.n, 10000);
  const resumed = await page.evaluate((n) => __speechLog.slice(n).find((x) => x.t === 'speak').text, paused.n);
  check(s.status === 'speaking' && resumed === paused.text, `Resume → continues from the interrupted sentence ("${paused.text.slice(0, 50)}")`);
  await waitFor(page, () => app.narrator.index >= 1);
  await page.click('#nar-replay');
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

async function testAR(browser) {
  console.log('\n[6] WebXR AR flow (IWER emulation)');
  const nm = (p) => path.join(ROOT, 'node_modules', p);
  if (!fs.existsSync(nm('iwer')) || !fs.existsSync(nm('@iwer/sem'))) {
    console.log('  – skipped: run `npm install` to get iwer and @iwer/sem (devDependencies)');
    return;
  }
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.addInitScript(speechMock());
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
  const caps = await page.evaluate(() => window.app.arCaps.mode);
  check(caps === 'webxr', `AR method detected: ${caps}`);
  await page.evaluate(() => window.xrDevice.quaternion.set(-0.5, 0, 0, 0.866));
  await page.click('#btn-ar');
  await page.waitForFunction(() => window.app.xr && window.app.xr.reticle.visible, null, { timeout: 20000 }).catch(() => {});
  let s = await page.evaluate(() => ({ presenting: app.viewer.renderer.xr.isPresenting, reticle: app.xr.reticle.visible }));
  check(s.presenting && s.reticle, 'immersive-ar session started, floor found by hit-test');
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
  s = await page.evaluate(() => ({ inAR: app.inAR, stage: app.viewer.stage.position.length() }));
  check(!s.inAR && s.stage === 0, 'session ends cleanly and the 3D viewer is restored');
  check(errors.length === 0, `no page errors during AR ${errors.length ? JSON.stringify(errors.slice(0, 3)) : ''}`);
  await page.close();
}

(async () => {
  await startServer();
  const browser = await launch();
  try {
    await testViewer(browser);
    await testNavigationAndVoice(browser);
    await testAR(browser);
  } finally {
    await browser.close();
    if (server) server.kill();
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})();
