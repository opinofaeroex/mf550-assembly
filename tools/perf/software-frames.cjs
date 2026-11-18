#!/usr/bin/env node
/**
 * software-frames.cjs — time for Chromium's CPU rasteriser (SwiftShader) to draw one frame
 * (render + readPixels, median of 3) at the overview and at step 30, per profile.
 * A stand-in for GPU geometry / fill load (and the real situation on a machine without GPU
 * acceleration) — not a Raspberry Pi number.
 *
 *   node tools/perf/software-frames.cjs [v1.4-checkout]     → perf-results/software-frames.json
 */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..', '..');
const runs = [['high', ROOT, '?profile=high'], ['balanced', ROOT, '?profile=balanced'], ['low', ROOT, '?profile=low']];
if (process.argv[2]) runs.unshift(['v1.4', path.resolve(process.argv[2]), '']);

(async () => {
  const res = {};
  let port = 8661;
  for (const [label, root, q] of runs) {
    port++;
    const srv = spawn(process.execPath, [path.join(root, 'tools/serve.mjs'), '--port', String(port), '--host', '127.0.0.1'], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 1000));
    const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.addInitScript(() => { try { localStorage.setItem('mf550.narration.muted', 'true'); } catch { /* none */ } });
      await page.goto(`http://127.0.0.1:${port}/${q}`);
      await page.waitForFunction(() => window.app && app.seq && document.getElementById('loader').classList.contains('is-done'), null, { timeout: 120000 });
      await page.evaluate(() => app.appearance.edgeBuild);   // v1.5: wait for the profile's CAD edges
      res[label] = await page.evaluate(() => {
        app.viewer.renderer.setAnimationLoop(null);
        const { renderer: R, scene, camera } = app.viewer;
        const gl = R.getContext(); const px = new Uint8Array(4);
        const out = {};
        for (const [name, pos] of [['overview', -2], ['step30', 29]]) {
          app.seq.goTo(pos, { animate: false });
          app.cameraCtl.focus(pos, { instant: true });
          app.viewer.controls.update();
          const t = [];
          for (let i = 0; i < 3; i++) { const a = performance.now(); R.render(scene, camera); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); t.push(performance.now() - a); }
          t.sort((x, y) => x - y);
          out[name] = { ms: Math.round(t[1]), calls: R.info.render.calls, triangles: R.info.render.triangles, buffer: `${gl.drawingBufferWidth}x${gl.drawingBufferHeight}` };
        }
        return out;
      });
      console.log(label, JSON.stringify(res[label]));
    } finally { await browser.close(); srv.kill(); }
  }
  fs.mkdirSync('perf-results', { recursive: true });
  fs.writeFileSync('perf-results/software-frames.json', JSON.stringify(res, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
