#!/usr/bin/env node
/**
 * precompute-camera.cjs — automatic-camera plans for every step, computed once (v1.5).
 *
 *   npm run camera:plans        (re-run after the model, the explode scale or CONFIG.camera change)
 *
 * Runs the app headless with the full-detail model and the runtime planner of
 * scene/CameraController.js (sight lines ray-cast against every solid part, 60 candidate
 * directions per step) for both ghosting options, and writes the results to
 * public/assets/model/camera-plans.json. At run time the app only looks them up, so a
 * Raspberry Pi does no ray casting. The file carries a fingerprint (model, explode scale,
 * camera settings); if it does not match, the app ignores it and plans at run time as before.
 */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'public', 'assets', 'model', 'camera-plans.json');
const PORT = 8097;

(async () => {
  const srv = spawn(process.execPath, [path.join(ROOT, 'tools/serve.mjs'), '--port', String(PORT), '--host', '127.0.0.1'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1000));
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.addInitScript(() => { try { localStorage.setItem('mf550.narration.muted', 'true'); } catch { /* none */ } });
    // the plans belong to the parts tutorial (v2.0 added the unit tutorial, which has its own camera)
    await page.addInitScript(() => { try { localStorage.setItem('mf550.tutorial', 'parts'); } catch { /* none */ } });
    await page.route('**/camera-plans.json', (r) => r.fulfill({ status: 404, body: '' }));   // force the runtime planner
    await page.goto(`http://127.0.0.1:${PORT}/?profile=high`);
    await page.waitForFunction(() => window.app && window.app.cameraCtl && window.app.modelTier === 'high', null, { timeout: 180000 });
    const data = await page.evaluate(async () => {
      const { CONFIG } = await import('./js/config.js');
      const a = window.app;
      const t0 = performance.now();
      a.setOption('ghost', true);
      const ghost = a.cameraCtl.exportPlans();
      a.setOption('ghost', false);
      const solid = a.cameraCtl.exportPlans();
      a.setOption('ghost', true);
      const key = a.cameraCtl.constructor.planKey(a.model, a.cameraCtl.cfg, a.viewer.camera.fov, [CONFIG.explodeScale, CONFIG.explodeSoftCap]);
      return { key, ms: Math.round(performance.now() - t0), variants: { ghost, solid } };
    });
    const file = {
      key: data.key,
      generatedBy: 'tools/precompute-camera.cjs (runtime planner of scene/CameraController.js, full-detail model)',
      candidates: 'ELEVATIONS × azimuth order of CameraController; vis = share of clear sight lines',
      variants: data.variants,
    };
    fs.writeFileSync(OUT, JSON.stringify(file) + '\n');
    console.log(`camera plans: ${data.variants.ghost.length} steps × 2 variants in ${data.ms} ms → ${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1024).toFixed(0)} kB)`);
  } finally {
    await browser.close();
    srv.kill();
  }
})().catch((e) => { console.error(e); process.exit(1); });
