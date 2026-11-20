/**
 * Application configuration (single place for tunable behaviour).
 */
export const CONFIG = {
  /** Product name shown in the interface (the CAD/internal identifier stays MF-550-210-B). */
  productName: 'Mist-Fit 550',
  version: '2.0.0',

  assemblyUrl: 'assets/model/assembly.json',
  modelDir: 'assets/model/',

  /**
   * v2.0: two tutorials. 'unit' = installation of the complete unit (grouped CAD assembly,
   * data-driven steps with tools: pipeline/unit/), 'parts' = the original 69-step parts
   * assembly. Choice: URL ?tutorial= > saved choice > default.
   */
  tutorials: {
    default: 'unit',
    unit: { label: 'Unit installation', assemblyUrl: 'assets/unit/assembly.json', modelDir: 'assets/unit/' },
    parts: { label: 'Parts assembly', assemblyUrl: 'assets/model/assembly.json', modelDir: 'assets/model/' },
  },

  /**
   * Exploded-view distance multiplier.
   * assembly.json stores the displacement vectors computed by the pipeline's
   * collision analysis (pipeline/disassembly.py). The viewer multiplies every
   * vector — hardware, parts and sub-assemblies alike — by this factor, so the
   * directions and the assembly relationships are unchanged and f = 0 is still
   * the exact CAD position. v1.0 used 1, v1.1 uses 3.
   */
  explodeScale: 3,

  /**
   * Automatic camera (v1.3, scene/CameraController.js): close-up of each step's components.
   * radius / travel in metres, transition in seconds (scaled by the angle to turn).
   */
  camera: {
    padding: 1.3,            // margin around the focus sphere
    minRadius: 0.07,         // never closer than a 7 cm sphere: keeps context around small hardware
    maxTravelShown: 0.22,    // part of the approach path kept in view (longer paths enter from off-screen)
    transition: [0.9, 1.6],  // seconds for a small / a half-turn camera move
  },

  /** Continuous animation of the current step (v1.2). Never changes the step. */
  animation: {
    loop: true,
    timing: { loopHold: 1.2, loopReset: 0.6, loopGap: 0.3 },   // seconds, × animation speed
  },

  /**
   * Hands-free navigation (v1.2): right-hand thumbs up = NEXT STEP, thumbs down = PREVIOUS STEP.
   * MediaPipe Tasks Vision is loaded only when the user enables gesture control.
   * To self-host, copy the package's vision_bundle.mjs + wasm/ and the .task model into
   * public/vendor/mediapipe/ and point these three URLs there (see README).
   */
  gestures: {
    visionBundle: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/vision_bundle.mjs',
    wasmBase: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/wasm',
    model: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
    delegate: 'GPU',              // falls back to CPU automatically
    fps: 15,                      // hand-tracking rate (the 3D view keeps its own frame rate)
    camera: { width: 640, height: 480, facingMode: 'user' },
    worker: true,                 // v1.5: inference in a Web Worker (main thread if unavailable)
    analysisWidth: 640,           // v1.5: frames are downscaled to this width for analysis
    // fps, camera size, worker, analysisWidth and delegate are overridden by the performance
    // profile (perf/Profiles.js) — e.g. Raspberry Pi 4: 8 Hz, 320 px analysis, CPU in a worker
    detection: { minHandDetectionConfidence: 0.6, minHandPresenceConfidence: 0.6, minTrackingConfidence: 0.5 },
    minHandScore: 0.7,            // handedness confidence required to accept a hand as left/right
    inputMirrored: false,         // raw camera frames are analysed; the preview is mirrored by CSS only
    // v2.0: time-based, smoothed trigger (gesture/GestureTrigger.js): ≈0.25 s hold, short neutral re-arm
    trigger: { tauMs: 110, fireLevel: 0.6, margin: 0.3, minHoldMs: 120, minFrames: 2, neutralLevel: 0.6, neutralMs: 250, cooldownMs: 600, minConfidence: 0.5 },
    classifier: {},               // overrides of DEFAULT_CLASSIFIER (gesture/GestureClassifier.js)
  },

  narration: {
    lang: 'en',            // narration scripts are written in English
    startDelayMs: 150,     // debounce: rapid step changes never queue several narrations
    rates: [0.8, 0.9, 1, 1.1, 1.25],
    defaultRate: 1,
    /** v1.4 natural voice: pre-recorded MP3 per position (tools/narration/generate.py). */
    manifestUrl: 'assets/narration/manifest.json',
    fetchTimeoutMs: 12000, // a recording that takes longer → browser voice for that step
    startTimeoutMs: 8000,  // playback that never starts → browser voice
  },
};
