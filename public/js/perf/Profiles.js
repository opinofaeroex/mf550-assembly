/**
 * Performance profiles (v1.5).
 *
 *   high      powerful computers: full CAD tessellation, native resolution up to 2×, MSAA, all edges
 *   balanced  Raspberry Pi 5: lighter model (0.2 mm simplification target), 1× resolution, 30 fps cap
 *   low       Raspberry Pi 4: lightest model (0.45 mm target), 75 % resolution, no MSAA, no edges
 *   legacy    v1.4 behaviour (for before/after measurements on the same device: ?profile=legacy)
 *
 * Every optimisation is a flag here, so a profile is a plain data record and `legacy`
 * reproduces version 1.4 (continuous rendering, per-frame bounding boxes, runtime camera
 * planning, gesture tracking on the main thread...).
 *
 * Choice: URL ?profile=… (this visit) > saved choice (Display quality in the help dialog)
 * > automatic detection from the WebGL renderer string.
 */
const BASE = {
  // rendering
  model: 'high',            // 'high' | 'balanced' | 'low' → MF-550-210-B[.tier].glb (tools/optimize-model.mjs)
  pixelRatioMax: 2,         // devicePixelRatio cap
  renderScale: 1,           // fraction of the CSS size rendered (upscaled by the browser)
  antialias: true,          // MSAA of the WebGL default framebuffer
  maxFps: 0,                // 0 = display refresh rate
  demandRendering: true,    // draw only when something changed (camera, parts, highlight, size)
  edges: 'all',             // CAD feature edges: 'all' | 'parts' (no fasteners/hardware) | 'none'
  edgeBuild: 'idle',        // 'idle' = computed in small slices; 'sync' = one blocking pass (v1.4)
  staticMatrices: true,     // only moved components recompute their transforms
  analyticLift: true,       // floor lift from precomputed bounds (v1.4: two Box3 passes per frame)
  calloutsOnRender: true,   // re-project callouts only when the view changed
  cameraPlans: 'precomputed',   // 'precomputed' (assets/model/camera-plans.json) | 'runtime' (v1.4)
  planningBudgetMs: 4,      // runtime planning slice per frame (fallback when no precomputed plans)
  backdropBlur: true,       // CSS blur behind the step card
  // camera / AR / gestures
  overlayCamera: { width: 1280, height: 720, frameRate: 30 },
  gestures: { worker: true, fps: 15, width: 640, height: 480, analysisWidth: 640, delegate: 'GPU' },
};

export const PROFILES = {
  high: { ...BASE, label: 'High quality', hint: 'Powerful computers' },
  balanced: {
    ...BASE, label: 'Balanced', hint: 'Raspberry Pi 5',
    model: 'balanced', pixelRatioMax: 1, maxFps: 30, edges: 'parts', backdropBlur: false,
    overlayCamera: { width: 1280, height: 720, frameRate: 30 },
    gestures: { worker: true, fps: 12, width: 640, height: 480, analysisWidth: 480, delegate: 'CPU' },
  },
  low: {
    ...BASE, label: 'Low performance', hint: 'Raspberry Pi 4',
    model: 'low', pixelRatioMax: 1, renderScale: 0.75, antialias: false, maxFps: 30, edges: 'none', backdropBlur: false,
    overlayCamera: { width: 640, height: 480, frameRate: 24 },
    gestures: { worker: true, fps: 8, width: 640, height: 480, analysisWidth: 320, delegate: 'CPU' },
  },
  legacy: {
    ...BASE, label: 'v1.4 behaviour (comparison)', hint: 'For before/after measurements',
    demandRendering: false, edgeBuild: 'sync', staticMatrices: false, analyticLift: false, calloutsOnRender: false,
    cameraPlans: 'runtime', gestures: { worker: false, fps: 15, width: 640, height: 480, analysisWidth: 640, delegate: 'GPU' },
  },
};
export const SELECTABLE = ['auto', 'high', 'balanced', 'low'];
const STORE = 'mf550.perf.profile';

/** WebGL renderer facts, read from a throw-away context (before the real renderer exists). */
export function probeGPU() {
  const out = { renderer: 'unknown', vendor: 'unknown', webgl2: false, software: false, maxTexture: 0 };
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return { ...out, webgl: false };
    out.webgl = true;
    out.webgl2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    out.renderer = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    out.vendor = String(ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR));
    out.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    out.software = isSoftware(out.renderer);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  } catch { /* no WebGL */ }
  return out;
}

/** Software rasterisers: the GPU is not used (Chromium without hardware acceleration). */
export const isSoftware = (r) => /swiftshader|llvmpipe|softpipe|software|basic render|lavapipe/i.test(r || '');

/** Recommended profile for a GPU (Raspberry Pi 5 = V3D 7.x, Raspberry Pi 4 = V3D 4.x). */
export function detectProfile(gpu = probeGPU(), nav = navigator) {
  const r = gpu.renderer || '';
  if (/V3D\s*7|VideoCore\s*VII/i.test(r)) return { id: 'balanced', reason: 'Raspberry Pi 5 GPU (V3D 7)' };
  if (/V3D\s*[34]|VideoCore\s*(VI|IV)\b/i.test(r)) return { id: 'low', reason: 'Raspberry Pi 4 GPU (V3D 4)' };
  if (gpu.software) return { id: 'low', reason: 'software rendering (no GPU acceleration)' };
  if (/Mali|Adreno|PowerVR|Vivante|Immortalis/i.test(r)) return { id: 'balanced', reason: 'mobile / embedded GPU' };
  const cores = nav.hardwareConcurrency || 8;
  const mem = nav.deviceMemory || 8;
  if (cores <= 4 && mem <= 4) return { id: 'balanced', reason: `${cores} CPU cores, ${mem} GB memory` };
  return { id: 'high', reason: 'desktop-class GPU' };
}

/** Resolve the profile for this visit. */
export function chooseProfile({ search = location.search, storage = safeStorage() } = {}) {
  const gpu = probeGPU();
  const detected = detectProfile(gpu);
  const q = new URLSearchParams(search).get('profile');
  const saved = storage.get();
  let id = detected.id, source = 'auto';
  if (q && PROFILES[q]) { id = q; source = 'url'; }
  else if (saved && saved !== 'auto' && PROFILES[saved]) { id = saved; source = 'saved'; }
  return { id, source, saved: saved || 'auto', detected, gpu, settings: PROFILES[id] };
}

export function saveProfile(id) { safeStorage().set(id); }

function safeStorage() {
  return {
    get() { try { return localStorage.getItem(STORE); } catch { return null; } },
    set(v) { try { localStorage.setItem(STORE, v); } catch { /* storage unavailable */ } },
  };
}
