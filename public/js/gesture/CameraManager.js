/**
 * CameraManager — one camera stream for gesture tracking, opened only on request.
 *
 * The stream is released whenever it is not needed (gesture control off, AR session
 * running, page hidden) so it never competes with the AR camera and the camera light
 * is only on while gestures are active. Errors are mapped to user-facing reasons.
 */
export class CameraManager {
  constructor(video) {
    this.video = video;          // <video> that receives the stream (may be visually hidden)
    this.stream = null;
  }

  static supported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  get active() {
    return !!this.stream && this.stream.getVideoTracks().some((t) => t.readyState === 'live');
  }

  /** Ask for the camera (shows the browser permission prompt the first time). */
  async start({ width = 640, height = 480, facingMode = 'user' } = {}) {
    if (!window.isSecureContext) throw Object.assign(new Error('insecure'), { reason: 'insecure' });
    if (!CameraManager.supported()) throw Object.assign(new Error('unsupported'), { reason: 'unsupported' });
    this.stop();
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { width: { ideal: width }, height: { ideal: height }, facingMode, frameRate: { ideal: 30, max: 30 } },
      });
    } catch (e) {
      throw Object.assign(e, { reason: CameraManager.reason(e) });
    }
    this.stream = stream;
    const v = this.video;
    v.muted = true;
    v.playsInline = true;
    v.srcObject = stream;
    await v.play().catch(() => {});
    if (!v.videoWidth) {
      await new Promise((res) => {
        const done = () => { v.removeEventListener('loadeddata', done); res(); };
        v.addEventListener('loadeddata', done);
        setTimeout(done, 3000);
      });
    }
    return stream;
  }

  stop() {
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.stream = null;
    if (this.video) this.video.srcObject = null;
  }

  static reason(e) {
    switch (e && e.name) {
      case 'NotAllowedError': case 'SecurityError': case 'PermissionDeniedError': return 'denied';
      case 'NotFoundError': case 'DevicesNotFoundError': case 'OverconstrainedError': return 'no-camera';
      case 'NotReadableError': case 'TrackStartError': case 'AbortError': return 'busy';
      default: return 'error';
    }
  }
}
