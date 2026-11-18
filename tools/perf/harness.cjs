/**
 * Reproducible performance harness (headless Chromium, SwiftShader).
 *
 *   node tools/perf/harness.cjs <rootDir> <label> [query] [--cpu N]
 *     rootDir  a checkout of this repository (e.g. . for v1.5, a v1.4 worktree for the baseline)
 *     label    name of the result file (perf-results/<label>.json)
 *     query    e.g. "?profile=balanced"
 *
 * Method
 *  - requestAnimationFrame is captured and frames are run one at a time on a virtual
 *    clock (exactly 1/30 s apart), so animations progress identically in every run.
 *  - WebGL draw calls are counted (calls, triangles) and then skipped, so the timing of
 *    each frame is the app's main-thread JavaScript (three.js render-list building,
 *    uniform/state upload, animation, camera, callouts...) without the software rasteriser.
 *  - Software-rasterised frame times: tools/perf/software-frames.cjs. Hand tracking: gestures.cjs.
 *  These are workload / main-thread measurements on the machine that runs them, NOT Raspberry Pi
 *  numbers (on the Pi use the in-app benchmark: ?bench).
 */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const [root, label, query = ''] = process.argv.slice(2);
const cpuIdx = process.argv.indexOf('--cpu');
const CPU = cpuIdx > 0 ? Number(process.argv[cpuIdx + 1]) : 1;
const PORT = 8200 + Math.floor(Math.random() * 500);

const INIT = `(() => {
  const realNow = performance.now.bind(performance);
  window.__realNow = realNow;
  let vt = null, frameStart = 0;
  performance.now = () => (vt === null ? realNow() : vt + (realNow() - frameStart));
  const q = new Map(); let id = 0;
  window.requestAnimationFrame = (cb) => { const i = ++id; q.set(i, cb); return i; };
  window.cancelAnimationFrame = (i) => { q.delete(i); };
  // draw-call accounting; draws skipped while __noDraw
  window.__noDraw = true;
  const st = window.__st = { calls: 0, tris: 0, renders: 0, renderMs: 0 };
  const tri = (mode, count) => (mode === 4 ? count / 3 : mode === 5 || mode === 6 ? Math.max(0, count - 2) : 0);
  for (const C of [WebGL2RenderingContext, WebGLRenderingContext]) {
    const P = C.prototype;
    for (const name of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced', 'drawRangeElements']) {
      const orig = P[name];
      if (!orig) continue;
      P[name] = function (...a) {
        const mode = a[0];
        const count = name === 'drawArrays' || name === 'drawArraysInstanced' ? a[2] : name === 'drawRangeElements' ? a[3] : a[1];
        const inst = name.endsWith('Instanced') ? a[a.length - 1] : 1;
        st.calls++; st.tris += tri(mode, count) * inst;
        if (window.__noDraw) return;
        return orig.apply(this, a);
      };
    }
  }
  window.__frame = () => {
    vt = vt === null ? realNow() : vt + 1000 / 30;
    frameStart = realNow();
    const cbs = [...q.values()]; q.clear();
    st.calls = 0; st.tris = 0; st.renders = 0; st.renderMs = 0;
    const t0 = realNow();
    for (const cb of cbs) { try { cb(vt); } catch (e) { console.error('frame cb', e); } }
    const ms = realNow() - t0;
    return { ms, renders: st.renders, renderMs: st.renderMs, calls: st.calls, tris: st.tris };
  };
  window.__frames = (n) => { const out = []; for (let i = 0; i < n; i++) out.push(window.__frame()); return out; };
  window.__wrapRender = () => {
    const r = window.app.viewer.renderer;
    if (r.__wrapped) return;
    const orig = r.render;
    r.render = function (s, c) { const t = realNow(); orig.call(this, s, c); st.renderMs += realNow() - t; st.renders++; };
    r.__wrapped = true;
  };
  window.__longtasks = [];
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__longtasks.push({ start: e.startTime, dur: e.duration }); }).observe({ type: 'longtask', buffered: true }); } catch {}
})();`;

const pct = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]; };
const summary = (fr) => {
  const ms = fr.map((f) => f.ms);
  const rendered = fr.filter((f) => f.renders > 0);
  return {
    frames: fr.length,
    renderedFrames: rendered.length,
    renderedPct: Math.round((rendered.length / Math.max(1, fr.length)) * 100),
    jsMsMedian: +pct(ms, 0.5).toFixed(2),
    jsMsP95: +pct(ms, 0.95).toFixed(2),
    jsMsMax: +Math.max(0, ...ms).toFixed(2),
    jsMsTotal: +ms.reduce((a, b) => a + b, 0).toFixed(1),
    renderMsMedian: +pct(rendered.map((f) => f.renderMs), 0.5).toFixed(2),
    drawCalls: rendered.length ? Math.round(pct(rendered.map((f) => f.calls), 0.5)) : 0,
    triangles: rendered.length ? Math.round(pct(rendered.map((f) => f.tris), 0.5)) : 0,
  };
};

(async () => {
  const srv = spawn(process.execPath, [path.join(root, 'tools/serve.mjs'), '--port', String(PORT), '--host', '127.0.0.1'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1200));
  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-precise-memory-info',
      '--autoplay-policy=no-user-gesture-required', '--js-flags=--expose-gc'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(INIT);
  // narration audio is irrelevant here: keep it muted so no audio element plays
  await page.addInitScript(() => { try { localStorage.setItem('mf550.narration.muted', 'true'); } catch {} });
  const cdp = await ctx.newCDPSession(page);
  if (CPU > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });

  const out = { label, query, cpuThrottle: CPU, date: new Date().toISOString() };
  const t0 = Date.now();
  await page.goto(`http://127.0.0.1:${PORT}/${query}`);
  // load: pump frames in (virtual) real time until the app is ready
  for (let i = 0; i < 2000; i++) {
    const ready = await page.evaluate(() => !!(window.app && window.app.seq && document.getElementById('loader').classList.contains('is-done')));
    if (ready) break;
    await page.evaluate(() => window.__frame());
    await page.waitForTimeout(20);
  }
  out.loadReadyMs = Date.now() - t0;
  await page.evaluate(() => window.__wrapRender());
  // let the deferred work (CAD edges, ...) start
  for (let i = 0; i < 10; i++) { await page.evaluate(() => window.__frame()); await page.waitForTimeout(20); }
  out.load = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    const res = performance.getEntriesByType('resource').filter((r) => /\.glb|assembly\.json|camera-plans/.test(r.name))
      .map((r) => ({ name: r.name.split('/').pop().split('?')[0], kB: Math.round(r.encodedBodySize / 1024), ms: Math.round(r.duration) }));
    return { domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd), resources: res, longTasks: window.__longtasks.length,
      longTaskMsTotal: Math.round(window.__longtasks.reduce((a, b) => a + b.dur, 0)), longTaskMsMax: Math.round(Math.max(0, ...window.__longtasks.map((l) => l.dur))) };
  });
  out.renderer = await page.evaluate(() => {
    const r = app.viewer.renderer; const gl = r.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return { webgl2: typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext,
      gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      pixelRatio: r.getPixelRatio(), drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight], antialias: gl.getContextAttributes().antialias,
      profile: app.perf ? app.perf.profile : '(none: v1.4)' };
  });
  out.scene = await page.evaluate(() => {
    let meshes = 0, lines = 0, objects = 0;
    app.viewer.scene.traverse((o) => { objects++; if (o.isMesh) meshes++; if (o.isLineSegments) lines++; });
    return { objects, meshes, lineSegments: lines, geometries: app.viewer.renderer.info.memory.geometries, programs: app.viewer.renderer.info.programs.length };
  });

  // camera planning (background sight-line evaluation) until finished
  {
    const fr = [];
    for (let i = 0; i < 4000; i++) {
      const f = await page.evaluate(() => window.__frame());
      fr.push(f);
      const done = await page.evaluate(() => !app.cameraCtl.queue || app.cameraCtl.queue.length === 0);
      if (done && i > 5) break;
    }
    out.cameraPlanning = { frames: fr.length, jsMsTotal: +fr.reduce((a, b) => a + b.ms, 0).toFixed(1), jsMsMax: +Math.max(...fr.map((f) => f.ms)).toFixed(1) };
  }
  // CAD edge computation cost (same EdgesGeometry call as Appearance.buildEdges, all unique geometries)
  out.edgesBuildMs = await page.evaluate(async () => {
    const THREE = await import('three');
    const geos = new Map();
    for (const ms of app.loaded.meshesByPart.values()) for (const m of ms) geos.set(m.geometry.uuid, m.geometry);
    const t = window.__realNow();
    for (const g of geos.values()) new THREE.EdgesGeometry(g, 28).dispose();
    return Math.round(window.__realNow() - t);
  });

  const runUntilIdle = async (max = 600) => {
    const fr = [];
    for (let i = 0; i < max; i++) {
      const f = await page.evaluate(() => window.__frame());
      fr.push(f);
      if (await page.evaluate(() => !app.seq.animating)) break;
    }
    return fr;
  };
  const states = {};
  // 1) overview, static
  await page.evaluate(() => app.seq.goTo(-2));
  await runUntilIdle();
  await page.evaluate(() => window.__frames(30));
  states.overviewIdle = summary(await page.evaluate(() => window.__frames(90)));
  // 2) parts kit: exploded animation, then static
  await page.evaluate(() => app.seq.goTo(-1));
  states.partsKitAnimation = summary(await runUntilIdle());
  await page.evaluate(() => window.__frames(30));
  states.partsKitIdle = summary(await page.evaluate(() => window.__frames(90)));
  // 3) a step: entry animation, then the looping step animation (one full cycle, 4.1 s)
  await page.evaluate(() => app.seq.goTo(29));
  states.stepEntry = summary(await runUntilIdle());
  states.stepLoop = summary(await page.evaluate(() => window.__frames(126)));
  // 4) BOM selection while the step loops
  await page.evaluate(() => { const id = app.model.partIds[40]; app.select(id); });
  states.bomSelect = summary(await page.evaluate(() => window.__frames(30)));
  await page.evaluate(() => app.select(null));
  // 5) user orbit (pointer drag on the canvas), one frame per mouse move
  {
    const box = await page.evaluate(() => { const r = app.viewer.renderer.domElement.getBoundingClientRect(); return { x: r.left + r.width * 0.6, y: r.top + r.height * 0.6 }; });
    await page.mouse.move(box.x, box.y);
    await page.mouse.down();
    const fr = [];
    for (let i = 0; i < 45; i++) { await page.mouse.move(box.x + i * 6, box.y + i * 1.5); fr.push(await page.evaluate(() => window.__frame())); }
    await page.mouse.up();
    for (let i = 0; i < 30; i++) fr.push(await page.evaluate(() => window.__frame()));   // damping tail
    states.orbit = summary(fr);
  }
  // 6) idle on a step after the user moved the camera (auto camera paused) — e.g. reading the BOM
  await page.evaluate(() => app.seq.goTo(-2));
  await runUntilIdle();
  out.states = states;

  // memory over repeated assembly sequences
  const heap = async () => { await cdp.send('HeapProfiler.collectGarbage'); const h = await cdp.send('Runtime.getHeapUsage'); return Math.round(h.usedSize / 1024 / 102.4) / 10; };
  const mem = { heapMB: [await heap()], rendererMemory: [], domNodes: [] };
  const snap = async () => {
    mem.rendererMemory.push(await page.evaluate(() => ({ ...app.viewer.renderer.info.memory })));
    mem.domNodes.push(await page.evaluate(() => document.getElementsByTagName('*').length));
  };
  await snap();
  for (let round = 0; round < 3; round++) {
    for (let k = -2; k < 69; k++) {
      await page.evaluate((p) => { app.seq.goTo(p); window.__frames(12); }, k);
    }
    mem.heapMB.push(await heap());
    await snap();
  }
  out.memory = mem;
  out.errors = errors.slice(0, 10);
  await browser.close();
  srv.kill();
  const file = path.join(process.cwd(), 'perf-results', `${label}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
