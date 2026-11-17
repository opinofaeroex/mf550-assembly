/**
 * GesturePanel — Gesture Control section, status chip, live preview and feedback toast.
 * Renders GestureController status; never navigates itself.
 */
const CAMERA_TEXT = {
  off: 'Off',
  starting: 'Waiting for camera permission…',
  loading: 'Loading hand tracking (first time only)…',
  on: 'On',
};
const PAUSE_TEXT = {
  ar: 'Paused while AR uses the camera',
  overlay: 'Paused while the camera overlay uses the camera',
  hidden: 'Paused (page in background)',
};
const ERROR_TEXT = {
  denied: 'Camera permission denied. Allow the camera for this site in the browser settings to use gestures.',
  'no-camera': 'No camera found on this device.',
  busy: 'The camera is in use by another app or was disconnected.',
  insecure: 'The camera needs a secure (HTTPS) page.',
  unsupported: 'This browser cannot access the camera.',
  model: 'The hand-tracking library could not be loaded (offline or blocked network).',
  error: 'The camera could not be started.',
};
const CONNECTIONS = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];

export class GesturePanel {
  constructor({ controller, els, prefs }) {
    this.ctl = controller;
    this.els = els;
    this.prefs = prefs;
    const e = els;
    e.open.addEventListener('click', () => this.toggle());
    e.close.addEventListener('click', () => this.toggle(false));
    e.chip.addEventListener('click', () => this.toggle(true));
    e.toggle.addEventListener('click', () => (this.ctl.enabled ? this.ctl.disable() : this.ctl.enable()));
    e.showPreview.checked = prefs.get('preview', true);
    e.swap.checked = prefs.get('swap', false);
    this.ctl.setSwap(e.swap.checked);
    e.showPreview.addEventListener('change', () => { prefs.set('preview', e.showPreview.checked); this.render(this.ctl.status); });
    e.swap.addEventListener('change', () => { prefs.set('swap', e.swap.checked); this.ctl.setSwap(e.swap.checked); });
    if (!controller.constructor.supported()) {
      e.toggle.disabled = true;
      this.message('Gesture control needs camera access, which this browser does not provide. Use the NEXT / PREVIOUS buttons.');
    }
    controller.addEventListener('status', (ev) => this.render(ev.detail));
    controller.addEventListener('frame', (ev) => this.draw(ev.detail));
    this.render(controller.status);
  }

  toggle(open = this.els.panel.hidden) {
    this.els.panel.hidden = !open;
    this.els.open.setAttribute('aria-expanded', String(open));
  }

  message(text) {
    this.els.msg.hidden = !text;
    this.els.msg.textContent = text || '';
  }

  render(s) {
    const e = this.els;
    const enabled = this.ctl.enabled;
    e.toggle.textContent = enabled ? 'Disable gesture control' : 'Enable gesture control';
    e.toggle.setAttribute('aria-pressed', String(enabled));
    e.toggle.classList.toggle('btn-accent', !enabled);
    e.panel.dataset.phase = s.phase;
    e.camera.textContent = s.phase === 'paused' ? (PAUSE_TEXT[s.reason] || 'Paused')
      : s.phase === 'error' ? 'Unavailable'
        : s.phase === 'on' ? `On${s.delegate ? ` · ${s.delegate === 'GPU' ? 'GPU' : 'CPU'} tracking` : ''}`
          : CAMERA_TEXT[s.phase] || s.phase;
    const live = s.phase === 'on';
    e.hand.textContent = !live ? '—'
      : { none: 'No hand in view', left: 'Left hand only (ignored)', right: 'Right hand ✓', both: 'Right hand ✓ · left ignored' }[s.hand];
    e.gesture.textContent = !live || !(s.hand === 'right' || s.hand === 'both') ? '—'
      : s.state === 'locked' ? 'Done · return hand to neutral'
        : s.gesture === 'up' ? '👍 Thumbs up — hold…'
          : s.gesture === 'down' ? '👎 Thumbs down — hold…' : 'Neutral · ready';
    e.meterFill.style.width = `${live && s.state === 'arming' ? Math.round(s.progress * 100) : s.state === 'locked' && live ? 100 : 0}%`;
    e.meter.dataset.state = live ? s.state : 'off';
    if (s.phase === 'error') this.message(`${ERROR_TEXT[s.reason] || ERROR_TEXT.error} The NEXT / PREVIOUS buttons keep working.`);
    else if (!e.toggle.disabled) this.message(null);
    const show = live && e.showPreview.checked;
    e.preview.hidden = !show;
    // the <video> stays in the page (1 px, invisible) when the preview is off: some mobile
    // browsers pause videos that are display:none; moving it keeps it playing
    if (show && e.video.parentNode !== e.preview) e.preview.prepend(e.video);
    else if (!show && e.video.parentNode === e.preview) e.home.appendChild(e.video);

    // status chip on the 3D view (visible while gestures are on, paused or failed)
    e.chip.hidden = s.phase === 'off';
    e.chip.dataset.phase = s.phase;
    e.chip.dataset.state = live ? s.state : '';
    e.chipText.textContent = s.phase === 'on'
      ? (s.state === 'locked' ? 'Return hand to neutral' : s.hand === 'right' || s.hand === 'both' ? (s.gesture === 'none' ? 'Right hand · ready' : 'Hold…') : 'Gestures on · show right hand')
      : s.phase === 'paused' ? 'Gestures paused'
        : s.phase === 'error' ? 'Gestures unavailable'
          : 'Starting gestures…';
  }

  /** Landmark overlay on the (mirrored) preview: right hand highlighted, left hand dimmed. */
  draw({ hands, frame }) {
    const e = this.els;
    if (e.preview.hidden) return;
    const c = e.canvas;
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const g = c.getContext('2d');
    g.clearRect(0, 0, w, h);
    // the video is shown with object-fit: cover — map normalised landmarks the same way
    const s = Math.max(w / frame.width, h / frame.height);
    const ox = (w - frame.width * s) / 2, oy = (h - frame.height * s) / 2;
    const P = (p) => [ox + (p.x ?? p[0]) * frame.width * s, oy + (p.y ?? p[1]) * frame.height * s];
    for (const hand of hands) {
      const right = hand.hand === 'Right';
      const col = !right ? 'rgba(160,170,180,.7)' : hand.gesture === 'up' || hand.gesture === 'down' ? '#3ddc84' : '#ff7a1a';
      g.strokeStyle = col; g.fillStyle = col; g.lineWidth = right ? 2.5 : 1.5;
      g.beginPath();
      for (const [a, b] of CONNECTIONS) {
        const [x0, y0] = P(hand.landmarks[a]); const [x1, y1] = P(hand.landmarks[b]);
        g.moveTo(x0, y0); g.lineTo(x1, y1);
      }
      g.stroke();
      for (const p of hand.landmarks) { const [x, y] = P(p); g.beginPath(); g.arc(x, y, right ? 2.6 : 1.8, 0, Math.PI * 2); g.fill(); }
    }
  }

  /** Temporary confirmation on the 3D view; never blocks it (pointer-events: none). */
  feedback(gesture, ok) {
    const t = this.els.toast;
    t.textContent = gesture === 'up'
      ? (ok ? '👍 NEXT STEP ACTIVATED' : '👍 Final step reached')
      : (ok ? '👎 PREVIOUS STEP ACTIVATED' : '👎 Already at the first position');
    t.dataset.kind = ok ? gesture : 'limit';
    t.hidden = false;
    t.classList.remove('show');
    void t.offsetWidth;          // restart the CSS animation
    t.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { t.hidden = true; }, 1600);
  }
}
