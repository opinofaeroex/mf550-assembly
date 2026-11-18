#!/usr/bin/env node
/**
 * gestures.cjs — MediaPipe hand tracking on the main thread (v1.4) vs in a Web Worker (v1.5):
 * analysis rate, inference time, main-thread cost, long tasks and display-frame cadence, with the
 * real library and model (network needed) and Chromium's fake camera. Not a Raspberry Pi number.
 *
 *   node tools/perf/gestures.cjs                 → perf-results/gestures.json
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'serve.mjs'), '--port', '8670', '--host', '127.0.0.1'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1000));
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const out = {};
  for (const [label, worker, aw] of [['main-thread 640px (v1.4)', false, 640], ['worker 640px', true, 640], ['worker 320px (Low)', true, 320]]) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['camera'] });
    const page = await ctx.newPage();
    const logs = [];
    page.on('console', (m) => { if (/gestures|worker/i.test(m.text())) logs.push(m.text().slice(0, 160)); });
    await page.addInitScript(() => { try { localStorage.setItem('mf550.narration.muted', 'true'); localStorage.setItem('mf550.perf.profile', 'high'); } catch {} });
    await page.goto('http://127.0.0.1:8670/');
    await page.waitForFunction(() => window.app && app.gestures && document.getElementById('loader').style.display === 'none', null, { timeout: 120000 });
    await page.evaluate(() => app.appearance.edgeBuild);
    await page.evaluate(([w, aw]) => { Object.assign(app.gestures.cfg, { worker: w, delegate: 'CPU', analysisWidth: aw, fps: 15 }); app.gestures.enable(); }, [worker, aw]);
    const on = await page.waitForFunction(() => app.gestures.status.phase === 'on' || app.gestures.status.phase === 'error', null, { timeout: 120000 }).then(() => page.evaluate(() => app.gestures.status.phase));
    await page.waitForTimeout(3000);
    const r = await page.evaluate(async () => {
      const lt = []; const obs = new PerformanceObserver((l) => { for (const e of l.getEntries()) lt.push(e.duration); }); obs.observe({ type: 'longtask' });
      const gaps = []; let last = performance.now(); let run = true;
      const f = (t) => { gaps.push(t - last); last = t; if (run) requestAnimationFrame(f); }; requestAnimationFrame(f);
      const samples = [];
      for (let i = 0; i < 10; i++) { await new Promise((res) => setTimeout(res, 1000)); samples.push(app.gestures.perfStats); }
      run = false; obs.disconnect();
      gaps.sort((a, b) => a - b);
      const s = samples.slice(2);
      const avg = (k) => +(s.reduce((a, x) => a + x[k], 0) / s.length).toFixed(1);
      return { mode: s[s.length - 1].mode, hz: avg('hz'), inferMs: avg('inferMs'), mainMs: avg('mainMs'), longTasks: lt.length, longTaskMs: Math.round(lt.reduce((a, b) => a + b, 0)),
        rafP50: +gaps[Math.floor(gaps.length / 2)].toFixed(1), rafP95: +gaps[Math.floor(gaps.length * 0.95)].toFixed(1), rafMax: Math.round(gaps[gaps.length - 1]) };
    });
    out[label] = { phase: on, ...r };
    console.log(label, JSON.stringify(out[label]), logs.slice(0, 2).join(' | '));
    await ctx.close();
  }
  fs.mkdirSync('perf-results', { recursive: true });
  fs.writeFileSync('perf-results/gestures.json', JSON.stringify(out, null, 2));
  await browser.close(); srv.kill();
})();
