/**
 * RecordedVoice — plays the pre-recorded natural-voice narration (v1.4).
 *
 * The recordings are static MP3 files listed in assets/narration/manifest.json, made with
 * tools/narration/generate.py (Kokoro-82M neural TTS). No API key and no speech service
 * are involved at runtime, so the app stays a static GitHub Pages site.
 *
 *  - one HTMLAudioElement for the whole session: once the browser allowed it to play (first
 *    tap / click / key), later steps — also those reached by hand gestures — play at once;
 *  - recordings are fetched into memory (Blob URLs): the current one first, then the next
 *    step's in the background (low priority), at most CACHE entries are kept;
 *  - every start carries a token: an answer for a step the user already left is dropped,
 *    and its download is aborted, so old audio can never play;
 *  - an entry is used only if its script text equals the text the app wants to speak,
 *    so out-of-date recordings fall back to the browser voice instead of saying
 *    something else.
 *
 * Callbacks (set by Narrator): onPlaying(), onEnded(), onBlocked(), onError(kind, err).
 */
const CACHE = 10;

export class RecordedVoice {
  constructor({ manifestUrl, fetchTimeoutMs = 12000, startTimeoutMs = 8000 } = {}) {
    this.manifestUrl = manifestUrl;
    this.fetchTimeoutMs = fetchTimeoutMs;
    this.startTimeoutMs = startTimeoutMs;
    this.manifest = null;
    this.base = '';
    this.cache = new Map();          // key -> object URL (insertion order = LRU)
    this.pending = new Map();        // key -> { promise, ctrl }
    this.failures = 0;
    this.disabled = false;
    this.token = 0;
    this.current = null;             // key being played
    this.supported = typeof Audio === 'function' && !!new Audio().canPlayType && new Audio().canPlayType('audio/mpeg') !== '';
    this.audio = this.supported ? new Audio() : null;
    if (this.audio) {
      this.audio.preload = 'auto';
      this.audio.preservesPitch = true;                    // speed changes keep the voice's pitch
      this.audio.addEventListener('ended', () => { if (this.live) { this.live = false; this.onEnded && this.onEnded(); } });
      this.audio.addEventListener('playing', () => { clearTimeout(this.watchdog); });
      this.audio.addEventListener('error', () => {
        if (!this.live) return;
        this.live = false;
        this.#fail('decode', this.audio.error);
      });
    }
    this.ready = this.supported ? this.#loadManifest() : Promise.resolve(false);
  }

  async #loadManifest() {
    try {
      const res = await fetch(this.manifestUrl, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.manifest = await res.json();
      this.base = new URL('.', new URL(this.manifestUrl, location.href)).href;
      return true;
    } catch (err) {
      this.manifestError = err;
      return false;
    }
  }

  get info() { return this.manifest ? this.manifest.voice : null; }

  /** Is there a valid recording of exactly this text? */
  has(key, text) {
    if (!this.supported || this.disabled || !this.manifest) return false;
    const e = this.manifest.entries[key];
    return !!e && e.text === text;
  }

  isStale(key, text) {
    const e = this.manifest && this.manifest.entries[key];
    return !!e && e.text !== text;
  }

  url(key) { return this.base + this.manifest.entries[key].file; }

  /** Recording as a Blob URL (cached; concurrent requests share one download). */
  #get(key, { priority = 'high' } = {}) {
    if (this.cache.has(key)) {
      const u = this.cache.get(key);
      this.cache.delete(key);                       // refresh LRU position
      this.cache.set(key, u);
      return Promise.resolve(u);
    }
    if (this.pending.has(key)) return this.pending.get(key).promise;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new DOMException('timeout', 'TimeoutError')), this.fetchTimeoutMs);
    const promise = fetch(this.url(key), { signal: ctrl.signal, priority })
      .then((res) => {
        if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { kind: res.status === 404 ? 'missing' : 'network' });
        return res.blob();
      })
      .then((blob) => {
        const u = URL.createObjectURL(blob);
        this.cache.set(key, u);
        while (this.cache.size > CACHE) {
          const [old, ou] = this.cache.entries().next().value;
          if (old === this.current) { this.cache.delete(old); this.cache.set(old, ou); continue; }
          this.cache.delete(old);
          URL.revokeObjectURL(ou);
        }
        return u;
      })
      .finally(() => { clearTimeout(timer); this.pending.delete(key); });
    this.pending.set(key, { promise, ctrl, priority });
    return promise;
  }

  /** Background download of a recording the user will probably need next. */
  preload(key) {
    if (!this.manifest || !this.manifest.entries[key] || this.cache.has(key) || this.pending.has(key)) return;
    this.#get(key, { priority: 'low' }).catch(() => { /* a later play reports problems */ });
  }

  /** Abort downloads that are no longer useful (another step was chosen). */
  #abortOthers(keep) {
    for (const [k, p] of this.pending) if (k !== keep && p.priority !== 'low') p.ctrl.abort(new DOMException('stale', 'AbortError'));
  }

  /** Play a recording from `from` seconds. Resolves when playback started (or was refused). */
  async start(key, { rate = 1, volume = 1, from = 0 } = {}) {
    const token = ++this.token;
    this.live = false;
    clearTimeout(this.watchdog);
    this.current = key;
    this.#abortOthers(key);
    this.audio.pause();
    let u;
    try {
      u = await this.#get(key);
    } catch (err) {
      if (token !== this.token) return;           // user moved on: nothing to report
      this.#fail(err.kind || (err.name === 'TimeoutError' ? 'timeout' : 'network'), err);
      return;
    }
    if (token !== this.token) return;             // stale answer: never play it
    const a = this.audio;
    if (a.src !== u) a.src = u;
    a.playbackRate = rate;
    a.volume = volume;
    try { a.currentTime = from; } catch { /* not seekable yet: starts at 0 */ }
    this.live = true;
    this.#play(token);
  }

  #play(token) {
    const a = this.audio;
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      if (token === this.token && this.live && a.paused === false && a.currentTime === 0) {
        this.live = false;
        a.pause();
        this.#fail('stalled', new Error('playback did not start'));
      }
    }, this.startTimeoutMs);
    let p;
    try { p = a.play(); } catch (err) { p = Promise.reject(err); }
    Promise.resolve(p).then(() => {
      if (token !== this.token || !this.live) return;
      this.failures = 0;
      this.onPlaying && this.onPlaying();
    }, (err) => {
      if (token !== this.token || !this.live) return;
      clearTimeout(this.watchdog);
      if (err && err.name === 'NotAllowedError') { this.onBlocked && this.onBlocked(); return; }
      if (err && err.name === 'AbortError') return;             // replaced by a newer start
      this.live = false;
      this.#fail('decode', err);
    });
  }

  /** Retry inside a user gesture after the browser refused autoplay. */
  unlock() {
    if (!this.audio || !this.live || !this.audio.paused) return false;
    this.#play(this.token);
    return true;
  }

  pause() {
    if (!this.audio) return 0;
    this.token++;
    this.live = false;
    clearTimeout(this.watchdog);
    this.audio.pause();
    return this.audio.currentTime || 0;
  }

  stop() {
    if (!this.audio) return;
    this.token++;
    this.live = false;
    clearTimeout(this.watchdog);
    this.#abortOthers(null);
    this.audio.pause();
  }

  get position() { return this.audio ? this.audio.currentTime || 0 : 0; }
  get duration() { return this.audio && Number.isFinite(this.audio.duration) ? this.audio.duration : 0; }

  setRate(r) { if (this.audio) this.audio.playbackRate = r; }
  setVolume(v) { if (this.audio) this.audio.volume = v; }

  /** iOS Safari ignores element volume (hardware buttons only). */
  get volumeControllable() {
    if (!this.audio) return false;
    const a = new Audio();
    a.volume = 0.5;
    return a.volume === 0.5;
  }

  #fail(kind, err) {
    this.failures++;
    if (this.failures >= 3) this.disabled = true;     // keep the session usable: stop retrying
    this.onError && this.onError(kind, err);
  }
}
