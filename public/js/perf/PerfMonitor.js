/**
 * PerfMonitor — development-only performance dashboard (v1.5).
 *
 * Hidden by default. Open with ?perf=1 (this visit) or Ctrl+Shift+P (toggle, remembered on this
 * device); ?perf=0 closes it. Updated twice per second from counters the viewer and the gesture
 * tracker keep anyway, so it costs almost nothing while open and nothing while closed.
 *
 * Shows: display / drawn frames per second, frame time (median, p95), JS time of the last draw,
 * draw calls, triangles, visible meshes, JS heap, camera / gesture analysis rate and cost,
 * model tier and load time, long tasks, WebGL renderer and whether it is hardware accelerated.
 */
const STORE = 'mf550.perf.hud';

export class PerfMonitor {
  constructor(app) {
    this.app = app;
    this.el = document.createElement('div');
    this.el.className = 'perf-hud';
    this.el.hidden = true;
    this.el.setAttribute('aria-hidden', 'true');
    document.body.appendChild(this.el);
    this.longTasks = { n: 0, ms: 0, max: 0 };
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) { this.longTasks.n++; this.longTasks.ms += e.duration; this.longTasks.max = Math.max(this.longTasks.max, e.duration); }
      }).observe({ type: 'longtask', buffered: true });
    } catch { /* not supported */ }
    const q = new URLSearchParams(location.search).get('perf');
    let on = false;
    try { on = localStorage.getItem(STORE) === '1'; } catch { /* storage unavailable */ }
    if (q === '1') on = true;
    if (q === '0') on = false;
    addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.shiftKey && (e.key === 'P' || e.key === 'p')) { e.preventDefault(); this.toggle(); }
    });
    if (on) this.show(true, false);
  }

  toggle() { this.show(this.el.hidden, true); }

  show(on, remember) {
    this.el.hidden = !on;
    if (remember) { try { localStorage.setItem(STORE, on ? '1' : '0'); } catch { /* storage unavailable */ } }
    clearInterval(this.timer);
    if (on) { this.update(); this.timer = setInterval(() => this.update(), 500); }
  }

  /** Numbers shown by the dashboard (also used by the benchmark report). */
  snapshot() {
    const a = this.app;
    const v = a.viewer;
    const st = v.stats;
    const now = performance.now();
    const intervals = [];
    const ft = st.frameTimes;
    const recent = [];
    for (let i = 0; i < ft.length; i++) if (ft[i] > 0 && now - ft[i] < 2000) recent.push(ft[i]);
    recent.sort((x, y) => x - y);
    for (let i = 1; i < recent.length; i++) intervals.push(recent[i] - recent[i - 1]);
    let drawn = 0;
    for (const t of st.renderStamps) if (t > 0 && now - t < 1000) drawn++;
    const sorted = intervals.slice().sort((x, y) => x - y);
    const q = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0);
    let meshes = 0, visible = 0;
    v.scene.traverseVisible((o) => { if (o.isMesh || o.isLineSegments) visible++; });
    v.scene.traverse((o) => { if (o.isMesh || o.isLineSegments) meshes++; });
    const mem = performance.memory;
    const g = a.gestures && a.gestures.perfStats;
    const cam = a.cameraView && a.cameraView.active ? a.cameraView.video : null;
    const p = a.perf;
    return {
      profile: `${p.id} (${p.source === 'url' ? 'URL' : p.source === 'saved' ? 'chosen' : 'automatic'})`,
      displayFps: recent.length > 1 ? Math.round((recent.length - 1) / ((recent[recent.length - 1] - recent[0]) / 1000)) : 0,
      drawnFps: drawn,
      frameMs: [q(0.5), q(0.95)].map((x) => Math.round(x * 10) / 10),
      renderJsMs: Math.round(st.lastRenderMs * 100) / 100,
      calls: st.calls, triangles: st.triangles, meshes: `${visible} / ${meshes}`,
      heapMB: mem ? Math.round(mem.usedJSHeapSize / 1048576) : null,
      gestures: g && g.running ? `${g.hz.toFixed(1)} Hz · ${g.mode}${g.delegate ? ' ' + g.delegate : ''} · infer ${g.inferMs.toFixed(0)} ms · main ${g.mainMs.toFixed(1)} ms · ${g.analysisWidth}px` : 'off',
      camera: cam ? `${cam.videoWidth}×${cam.videoHeight}` : 'off',
      model: `${a.modelTier} · ${a.metrics.modelLoadMs} ms`,
      longTasks: `${this.longTasks.n} · max ${Math.round(this.longTasks.max)} ms`,
      gpu: p.gpu.renderer,
      accel: p.gpu.software ? 'SOFTWARE rendering' : p.gpu.webgl2 ? 'hardware · WebGL 2' : 'hardware · WebGL 1',
      canvas: `${v.renderer.domElement.width}×${v.renderer.domElement.height} @${v.renderer.getPixelRatio().toFixed(2)}${p.settings.antialias ? ' MSAA' : ''}`,
      mode: `${p.settings.demandRendering ? 'on demand' : 'continuous'}${p.settings.maxFps ? ` · cap ${p.settings.maxFps}` : ''}`,
    };
  }

  update() {
    const s = this.snapshot();
    const row = (k, v, cls = '') => `<div class="ph-row ${cls}"><span>${k}</span><b>${v}</b></div>`;
    this.el.innerHTML = '<div class="ph-title">Performance <small>Ctrl+Shift+P</small></div>'
      + row('Profile', s.profile)
      + row('Frames / s', `${s.displayFps} loop · ${s.drawnFps} drawn`)
      + row('Frame time', `${s.frameMs[0]} ms · p95 ${s.frameMs[1]} ms`)
      + row('Draw (JS)', `${s.renderJsMs} ms`)
      + row('Draw calls', s.calls)
      + row('Triangles', s.triangles.toLocaleString('en-US'))
      + row('Meshes', s.meshes)
      + row('JS heap', s.heapMB === null ? 'n/a' : `${s.heapMB} MB`)
      + row('Gestures', s.gestures)
      + row('Camera', s.camera)
      + row('Model', s.model)
      + row('Long tasks', s.longTasks)
      + row('Canvas', s.canvas)
      + row('Rendering', s.mode)
      + row('GPU', s.gpu, 'ph-wrap')
      + row('Acceleration', s.accel, s.accel.startsWith('SOFTWARE') ? 'ph-bad' : 'ph-ok');
  }
}
