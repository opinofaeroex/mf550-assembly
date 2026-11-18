/**
 * Bench — scripted on-device benchmark (v1.5).
 *
 *   https://…/?bench                  current profile
 *   https://…/?bench&profile=legacy   the same device with version 1.4 behaviour (before)
 *   https://…/?bench&profile=balanced / low / high
 *
 * Runs a fixed sequence in real time (nothing is simulated): overview at rest, the exploded
 * parts kit, a looping step, step-by-step navigation, a camera orbit and BOM selections.
 * For each phase it records the drawn frame rate, the frame-time distribution, stalls
 * (frames ≥ 50 ms) and long main-thread tasks. The report can be copied or downloaded.
 * Narration is muted during the run and restored afterwards.
 */
import { CONFIG } from '../config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runBench(app, { onDone } = {}) {
  const v = app.viewer;
  const long = [];
  let obs = null;
  try { obs = new PerformanceObserver((l) => { for (const e of l.getEntries()) long.push(e); }); obs.observe({ type: 'longtask' }); } catch { /* unsupported */ }
  const muted = app.narrator ? app.narrator.muted : true;
  if (app.narrator) app.narrator.setMuted(true);
  const banner = document.createElement('div');
  banner.className = 'bench-banner';
  document.body.appendChild(banner);

  // rAF probe: real display-loop cadence (independent of whether the app draws)
  const ticks = [];
  let probing = true;
  const probe = (t) => { ticks.push(t); if (probing) requestAnimationFrame(probe); };
  requestAnimationFrame(probe);

  const phases = [];
  async function phase(name, ms, action) {
    banner.textContent = `Benchmark · ${name} …`;
    const r0 = v.stats.renders, l0 = long.length, k0 = ticks.length, t0 = performance.now();
    const stamps0 = v.stats.renderIdx;
    if (action) await action();
    await sleep(ms);
    const dur = performance.now() - t0;
    const drawn = v.stats.renders - r0;
    // drawn-frame intervals from the viewer's ring buffer
    const st = v.stats, n = Math.min(st.renderIdx - stamps0, st.renderStamps.length);
    const ts = [];
    for (let i = st.renderIdx - n; i < st.renderIdx; i++) ts.push(st.renderStamps[i % st.renderStamps.length]);
    const iv = [];
    for (let i = 1; i < ts.length; i++) iv.push(ts[i] - ts[i - 1]);
    iv.sort((a, b) => a - b);
    const q = (p) => (iv.length ? Math.round(iv[Math.min(iv.length - 1, Math.floor(p * iv.length))] * 10) / 10 : null);
    const tk = ticks.slice(k0);
    let stalls = 0;
    for (let i = 1; i < tk.length; i++) if (tk[i] - tk[i - 1] >= 50) stalls++;
    const lt = long.slice(l0);
    phases.push({
      phase: name, seconds: Math.round(dur / 100) / 10,
      drawnFps: Math.round((drawn / dur) * 10000) / 10,
      loopFps: Math.round(((tk.length - 1) / (dur / 1000)) * 10) / 10,
      frameMsP50: q(0.5), frameMsP95: q(0.95), frameMsMax: iv.length ? Math.round(iv[iv.length - 1]) : null,
      stalls50ms: stalls, longTasks: lt.length, longTaskMs: Math.round(lt.reduce((a, e) => a + e.duration, 0)),
      drawCalls: v.stats.calls, triangles: v.stats.triangles,
    });
  }

  banner.textContent = 'Benchmark · settling …';
  await sleep(2500);
  await phase('overview at rest', 4000, () => app.seq.goTo(-2, { animate: false }));
  await phase('parts kit (explode animation)', 5000, () => app.seq.goTo(-1));
  await phase('step 30 loop animation', 9000, () => app.seq.goTo(29));
  await phase('navigation steps 31→36', 9000, async () => {
    for (let k = 30; k < 36; k++) { app.seq.goTo(k); await sleep(1500); }
  });
  await phase('camera orbit', 4000, async () => {
    app.cameraCtl.pauseByUser();
    const c = v.camera, tgt = v.controls.target;
    const start = performance.now();
    const off = c.position.clone().sub(tgt);
    await new Promise((res) => {
      const spin = () => {
        const a = ((performance.now() - start) / 1000) * 0.8;
        const x = off.x * Math.cos(a) - off.z * Math.sin(a), z = off.x * Math.sin(a) + off.z * Math.cos(a);
        c.position.set(tgt.x + x, tgt.y + off.y, tgt.z + z);
        if (performance.now() - start < 4000) requestAnimationFrame(spin); else res();
      };
      requestAnimationFrame(spin);
    });
  });
  await phase('BOM selection', 3500, async () => {
    const rows = app.model.bom.slice(0, 6);
    for (const row of rows) { app.select({ row }); await sleep(500); }
    app.select(null);
  });
  probing = false;
  if (obs) obs.disconnect();
  app.cameraCtl.refocus();
  app.seq.goTo(-2);
  if (app.narrator) app.narrator.setMuted(muted);
  banner.remove();

  const p = app.perf;
  const mem = performance.memory;
  const report = {
    app: `${CONFIG.productName} ${CONFIG.version}`, date: new Date().toISOString(),
    profile: p.id, profileSource: p.source, detected: `${p.detected.id} (${p.detected.reason})`,
    gpu: p.gpu.renderer, hardwareAccelerated: !p.gpu.software, webgl2: p.gpu.webgl2,
    devicePixelRatio: window.devicePixelRatio, canvas: [v.renderer.domElement.width, v.renderer.domElement.height],
    settings: { model: app.modelTier, antialias: p.settings.antialias, pixelRatio: v.renderer.getPixelRatio(), maxFps: p.settings.maxFps,
      demandRendering: p.settings.demandRendering, edges: p.settings.edges, cameraPlans: app.cameraCtl.precomputed ? 'precomputed' : 'runtime' },
    modelLoadMs: app.metrics.modelLoadMs, startupMs: app.metrics.readyMs,
    heapMB: mem ? Math.round(mem.usedJSHeapSize / 1048576) : null,
    cpuCores: navigator.hardwareConcurrency || null, userAgent: navigator.userAgent,
    phases,
  };
  console.log('[bench]', JSON.stringify(report));
  showReport(report);
  if (onDone) onDone(report);
  return report;
}

function showReport(r) {
  const d = document.createElement('dialog');
  d.className = 'dialog bench-report';
  const rows = r.phases.map((x) => `<tr><td>${x.phase}</td><td>${x.drawnFps}</td><td>${x.frameMsP50 ?? '–'}</td><td>${x.frameMsP95 ?? '–'}</td><td>${x.stalls50ms}</td><td>${x.longTasks} / ${x.longTaskMs} ms</td></tr>`).join('');
  d.innerHTML = `<form method="dialog"><header><h3>Benchmark — ${r.profile}</h3><button class="btn btn-ghost" value="close">Close</button></header>
    <p class="muted">${r.gpu} · ${r.hardwareAccelerated ? 'hardware accelerated' : '<b>software rendering</b>'} · canvas ${r.canvas.join('×')} · model ${r.settings.model} · load ${r.modelLoadMs} ms</p>
    <table class="kbd-table bench-table"><thead><tr><th>Phase</th><th>Drawn fps</th><th>p50 ms</th><th>p95 ms</th><th>Stalls ≥50 ms</th><th>Long tasks</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="muted">"Drawn fps" counts frames actually drawn: with on-demand rendering a still view draws ~0 fps by design.</p>
    <div class="bench-actions"><button type="button" class="btn" id="bench-copy">Copy results</button><a class="btn" id="bench-dl" download="mf550-bench-${r.profile}.json">Download JSON</a></div></form>`;
  document.body.appendChild(d);
  const json = JSON.stringify(r, null, 2);
  d.querySelector('#bench-dl').href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  d.querySelector('#bench-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(json); d.querySelector('#bench-copy').textContent = 'Copied'; } catch { d.querySelector('#bench-copy').textContent = 'Copy failed — use Download'; }
  });
  d.showModal();
  window.__benchReport = r;
}
