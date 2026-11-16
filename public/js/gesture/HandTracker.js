/**
 * HandTracker — MediaPipe Hand Landmarker (21 landmarks + handedness per hand).
 *
 * The MediaPipe Tasks Vision library (JS + WebAssembly) and the hand model are loaded
 * on demand, the first time gesture control is enabled, from the URLs in
 * CONFIG.gestures (pinned versions; self-hosting is possible, see README).
 * GPU (WebGL) inference is tried first, CPU (WASM) is the fallback.
 *
 * Handedness: MediaPipe ≥ 1.2 labels the *subject's* hands for a non-mirrored image
 * and inverts the labels for a mirrored one. The app always feeds the raw camera
 * frames (the preview is mirrored with CSS only), so the label is the user's physical
 * hand; `physicalHand()` handles mirrored inputs and the user's swap option.
 */
export function physicalHand(label, { inputMirrored = false, swap = false } = {}) {
  if (label !== 'Left' && label !== 'Right') return null;
  const flip = inputMirrored !== swap;   // either one inverts, both cancel
  return flip ? (label === 'Left' ? 'Right' : 'Left') : label;
}

export class HandTracker {
  constructor(cfg) {
    this.cfg = cfg;
    this.landmarker = null;
    this.delegate = null;
  }

  async init() {
    if (this.landmarker) return;
    const c = this.cfg;
    const vision = await import(/* @vite-ignore */ c.visionBundle);
    const fileset = await vision.FilesetResolver.forVisionTasks(c.wasmBase);
    const opts = (delegate) => ({
      baseOptions: { modelAssetPath: c.model, delegate },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: c.detection.minHandDetectionConfidence,
      minHandPresenceConfidence: c.detection.minHandPresenceConfidence,
      minTrackingConfidence: c.detection.minTrackingConfidence,
    });
    try {
      this.landmarker = await vision.HandLandmarker.createFromOptions(fileset, opts(c.delegate || 'GPU'));
      this.delegate = c.delegate || 'GPU';
    } catch (e) {
      if ((c.delegate || 'GPU') === 'CPU') throw e;
      this.landmarker = await vision.HandLandmarker.createFromOptions(fileset, opts('CPU'));
      this.delegate = 'CPU';
    }
  }

  /** @returns {{hands: Array<{label, score, landmarks, world}>}} */
  detect(video, timestampMs) {
    const r = this.landmarker.detectForVideo(video, timestampMs);
    const hd = r.handedness || r.handednesses || [];
    return {
      hands: (r.landmarks || []).map((lm, k) => ({
        label: hd[k] && hd[k][0] ? hd[k][0].categoryName : null,
        score: hd[k] && hd[k][0] ? hd[k][0].score : 0,
        landmarks: lm,
        world: r.worldLandmarks ? r.worldLandmarks[k] : null,
      })),
    };
  }

  close() {
    try { this.landmarker && this.landmarker.close(); } catch { /* already closed */ }
    this.landmarker = null;
  }
}
