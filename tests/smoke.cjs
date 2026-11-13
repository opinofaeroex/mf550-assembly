/**
 * End-to-end checks (headless Chromium via Playwright).
 *
 *   npm test                      # starts tools/serve.mjs on :8099 and runs all checks
 *   BASE_URL=http://host:port npm test
 *
 * 1. App loads without errors; GLB and assembly.json match.
 * 2. Geometry fidelity: each part's world bounding box in the browser equals the
 *    bounding box OpenCascade computed from the STEP solid (tolerance 0.75 mm =
 *    max. tessellation chord error 0.6 mm + quantisation).
 * 3. Sequence/BOM/highlight synchronisation for every step:
 *      – components of steps < k at their CAD position, step k active, steps > k exploded
 *      – highlighted (ACTIVE) parts == parts of step k
 *      – BOM row(s) marked current == rows of step k's components
 * 4. After the last step every component is back at its exact CAD position.
 * 5. WebXR AR flow under the Immersive Web Emulation Runtime (IWER + SEM):
 *    session start → floor hit-test → placement → step navigation → exit.
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

async function startServer() {
  if (BASE) return;
  server = spawn(process.execPath, [path.join(ROOT, 'tools/serve.mjs'), '--port', String(PORT), '--host', '127.0.0.1'], { stdio: 'pipe' });
  BASE = `http://127.0.0.1:${PORT}`;
  await new Promise((r) => server.stdout.once('data', r));
}

async function launch() {
  return chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
}

async function testApp(browser) {
  console.log('\n[1-4] viewer, fidelity, synchronisation');
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${BASE}/`);
  await page.waitForFunction(() => window.app && window.app.seq, null, { timeout: 120000 });
  check(errors.length === 0, `loads without errors ${errors.length ? JSON.stringify(errors) : ''}`);

  const fidelity = await page.evaluate(() => {
    const { model, loaded, viewer } = window.app;
    const THREE_Box3 = viewer.boxOf().constructor;
    const off = viewer.model.position;                 // centring offset applied by the viewer
    const lift = viewer.modelRoot.position.y;
    let worst = 0, worstId = null;
    for (const id of model.partIds) {
      const n = model.node(id);
      const b = new THREE_Box3().setFromObject(loaded.objects.get(id), true);
      const exp = [n.bboxMin, n.bboxMax];
      const got = [b.min, b.max];
      for (let k = 0; k < 2; k++) {
        const d = Math.max(
          Math.abs(got[k].x - off.x - exp[k][0]),
          Math.abs(got[k].y - off.y - lift - exp[k][1]),
          Math.abs(got[k].z - off.z - exp[k][2]));
        if (d > worst) { worst = d; worstId = n.cad; }
      }
    }
    return { worstMm: worst * 1000, worstId, parts: model.partIds.length };
  });
  check(fidelity.worstMm < 0.75, `${fidelity.parts} parts at CAD position; max bbox deviation (mesh vs. exact B-rep, incl. tessellation chord error) ${fidelity.worstMm.toFixed(3)} mm (${fidelity.worstId})`);

  const sync = await page.evaluate(() => {
    const { model, seq, explode, appearance, bom, activeParts } = window.app;
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
    }
    seq.goTo(model.stepCount, { animate: false });
    let maxOff = 0;
    for (const e of explode.entries) maxOff = Math.max(maxOff, e.obj.position.distanceTo(e.base));
    return { problems, maxOff, steps: model.stepCount };
  });
  check(sync.problems.length === 0, `${sync.steps} steps: positions, highlight, BOM row and step card in sync ${sync.problems.slice(0, 3).join('; ')}`);
  check(sync.maxOff === 0, `after the last step every component is back at its exact CAD position (max offset ${sync.maxOff})`);

  // play through the animated program quickly
  const played = await page.evaluate(async () => {
    const { seq } = window.app;
    seq.speed = 60; seq.goTo(-2, { animate: false }); seq.play();
    const t0 = performance.now();
    while (seq.pos < seq.N && performance.now() - t0 < 90000) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 500));
    return { pos: seq.pos, N: seq.N, playing: seq.playing };
  });
  check(played.pos === played.N && !played.playing, `autoplay runs to completion (${played.pos}/${played.N})`);
  await page.close();
}

async function testAR(browser) {
  console.log('\n[5] WebXR AR flow (IWER emulation)');
  const nm = (p) => path.join(ROOT, 'node_modules', p);
  if (!fs.existsSync(nm('iwer')) || !fs.existsSync(nm('@iwer/sem'))) {
    console.log('  – skipped: run `npm install` to get iwer and @iwer/sem (devDependencies)');
    return;
  }
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
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
  await page.evaluate(() => window.xrDevice.quaternion.set(-0.5, 0, 0, 0.866)); // look at the floor
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
    await new Promise((r) => setTimeout(r, 1500));
    app.xr.setScale(0.5);
    return { title: document.getElementById('ar-step-badge').textContent, scale: app.viewer.stage.scale.x };
  });
  check(s.title === `Step 11 / ${await page.evaluate(() => app.model.stepCount)}` && s.scale === 0.5, `sequence + scaling inside AR (${s.title}, scale ${s.scale})`);
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
    await testApp(browser);
    await testAR(browser);
  } finally {
    await browser.close();
    if (server) server.kill();
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})();
