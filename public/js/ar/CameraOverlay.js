/**
 * CameraOverlay — fallback for browsers without immersive AR: the device camera is shown
 * behind the transparent 3D canvas, so the assembly can be looked at "in the room".
 *
 * This is NOT augmented reality: there is no tracking, the model is not anchored to any
 * surface and does not move with the phone. The UI labels it "Camera overlay (not AR)".
 * Navigation, narration, BOM and the automatic camera keep working as in the 3D viewer.
 *
 * Camera use is exclusive: the app pauses gesture tracking while the overlay runs.
 * Events: 'state' {active, error?}
 */
export class CameraOverlay extends EventTarget {
  constructor({ container, video }) {
    super();
    this.container = container;
    this.video = video;
    this.stream = null;
  }

  get active() { return !!this.stream; }

  async start() {
    if (this.stream) return;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      });
    } catch (err) {
      this.stream = null;
      this.#emit(err);
      throw err;
    }
    const v = this.video;
    v.srcObject = this.stream;
    v.muted = true;
    v.playsInline = true;
    // a rear camera needs no mirroring; a front camera / webcam reads naturally mirrored
    const facing = this.stream.getVideoTracks()[0]?.getSettings?.().facingMode;
    v.classList.toggle('mirrored', facing !== 'environment');
    // show first: a play() promise on a display:none video may not settle until it is rendered
    v.hidden = false;
    this.container.classList.add('camera-overlay-on');
    this.stream.getVideoTracks()[0]?.addEventListener('ended', () => this.stop(), { once: true });
    this.#emit();
    v.play().catch(() => { /* muted inline video started by a click: autoplay is allowed */ });
  }

  stop() {
    if (!this.stream) return;
    for (const t of this.stream.getTracks()) t.stop();
    this.stream = null;
    this.video.srcObject = null;
    this.video.hidden = true;
    this.container.classList.remove('camera-overlay-on');
    this.#emit();
  }

  #emit(error) {
    this.dispatchEvent(new CustomEvent('state', { detail: { active: this.active, error: error || null } }));
  }
}
