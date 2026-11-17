/**
 * Narrator — spoken assembly instructions (v1.4: natural recorded voice + browser fallback).
 *
 * Engines
 *  - RecordedVoice (default): pre-recorded natural neural voice, one MP3 per position
 *    (assets/narration, made with tools/narration/generate.py). Static files: no API key,
 *    no speech service at runtime, works on GitHub Pages.
 *  - BrowserVoice (fallback): the browser's Web Speech API. Used when a recording cannot be
 *    loaded or played (missing file, network down, unsupported audio, out-of-date script),
 *    or when the user chooses a browser voice in the settings.
 *
 * Behaviour guarantees (unchanged from v1.1–v1.3):
 *  - one narration at a time: every new request stops the previous one at once, and
 *    late answers (downloads, utterance events) of a previous step are ignored (tokens);
 *  - each position is narrated once when it is entered; the step loop never restarts it;
 *  - the narrator never navigates: 'ended' is only reported, never acted upon;
 *  - browsers block sound until the first user gesture: status becomes 'blocked' and the
 *    narration starts on the next tap / click / key press.
 *
 * Status: idle | loading | speaking | paused | ended | blocked | muted | error | unsupported
 * Events: 'state' (detail: snapshot), 'voices', 'notice' (detail: { kind, message }).
 */
import { RecordedVoice } from './RecordedVoice.js';
import { BrowserVoice } from './BrowserVoice.js';
import { forSpeech } from './spokenScript.js';

const STORE = 'mf550.narration.';
const load = (k, d) => { try { const v = localStorage.getItem(STORE + k); return v === null ? d : JSON.parse(v); } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(STORE + k, JSON.stringify(v)); } catch { /* storage unavailable */ } };

export function splitSentences(text) {
  return String(text)
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const NOTICES = {
  fallback: 'The natural voice could not be played here, so the browser voice reads the instructions.',
  stale: 'The natural-voice recording of this step is out of date, so the browser voice reads it.',
  unavailable: 'Voice narration is not available in this browser. Follow the written instructions.',
};

export class Narrator extends EventTarget {
  constructor({ lang = 'en', defaultRate = 1, manifestUrl = null, fetchTimeoutMs, startTimeoutMs } = {}) {
    super();
    this.lang = lang;
    this.rate = load('rate', defaultRate);
    this.volume = Math.min(1, Math.max(0, Number(load('volume', 1)) || 0));
    this.muted = !!load('muted', false);
    // 'natural' | browser voiceURI. Stored under a new key: a browser voice picked in v1.1–v1.3
    // ('voice', when no natural voice existed) must not hide the natural voice after the update.
    this.pref = load('voicePref', 'natural');
    this.recorded = new RecordedVoice({ manifestUrl, fetchTimeoutMs, startTimeoutMs });
    this.browser = new BrowserVoice({ lang });
    if (this.pref !== 'natural' && !this.browser.setVoice(this.pref)) this.browser.voiceURI = this.pref;
    this.supported = this.recorded.supported || this.browser.supported;
    this.id = null;
    this.key = null;
    this.next = null;
    this.text = '';
    this.chunks = [];
    this.index = 0;
    this.offset = 0;                  // seconds into the recording (natural voice)
    this.engine = null;               // engine of the current narration: 'natural' | 'browser'
    this.gen = 0;
    this.noticed = new Set();
    this.status = !this.supported ? 'unsupported' : this.muted ? 'muted' : 'idle';

    const r = this.recorded;
    r.onPlaying = () => {
      if (this.engine !== 'natural') return;
      this.status = 'speaking';
      this.#emit();
      if (this.next) setTimeout(() => this.recorded.preload(this.next), 400);    // next step, in the background
    };
    r.onEnded = () => { if (this.engine === 'natural') { this.index = this.chunks.length; this.offset = 0; this.status = 'ended'; this.#emit(); } };
    r.onBlocked = () => { if (this.engine === 'natural') { this.status = 'blocked'; this.#emit(); } };
    r.onError = (kind) => { if (this.engine === 'natural') this.#fallback(kind); };

    const b = this.browser;
    b.onSentence = (i) => { if (this.engine === 'browser') { this.index = i; if (this.status !== 'speaking') { this.status = 'speaking'; this.#emit(); } } };
    b.onEnded = () => { if (this.engine === 'browser') { this.index = this.chunks.length; this.status = 'ended'; this.#emit(); } };
    b.onBlocked = (i) => { if (this.engine === 'browser') { this.index = i; this.status = 'blocked'; this.#emit(); } };
    b.onError = (code, i) => { if (this.engine === 'browser') { this.index = i; this.lastError = code; this.status = 'error'; this.#emit(); } };
    b.onVoices = () => {
      if (this.pref !== 'natural') b.setVoice(this.pref);
      this.dispatchEvent(new Event('voices'));
      this.#emit();
    };
    r.ready.then(() => { this.dispatchEvent(new Event('voices')); this.#emit(); });

    if (typeof window !== 'undefined') {
      // sound is only allowed after a user gesture: retry the current narration then
      const unlock = () => { if (this.status === 'blocked' && !this.muted) this.#unlock(); };
      window.addEventListener('pointerdown', unlock, true);
      window.addEventListener('keydown', unlock, true);
      window.addEventListener('pagehide', () => this.stop());
    }
  }

  // ------------------------------------------------------------------ voices
  /** Browser voices (fallback / manual choice). */
  get voices() { return this.browser.voices; }
  get naturalInfo() { return this.recorded.info; }
  get naturalAvailable() { return !!this.recorded.manifest && !this.recorded.disabled; }
  get volumeControllable() { return this.recorded.volumeControllable || this.browser.supported; }

  /** Descriptor of the voice in use (or that will be used). */
  get voice() {
    const useNatural = this.engine ? this.engine === 'natural' : this.pref === 'natural' && this.naturalAvailable;
    if (useNatural && this.recorded.info) {
      const v = this.recorded.info;
      return { name: `${v.voiceName} (natural voice)`, lang: v.lang, natural: true, kind: 'recorded', model: v.model };
    }
    return this.browser.descriptor;
  }

  /** 'natural' or a browser voiceURI. */
  setVoice(v) {
    if (v === 'natural') this.pref = 'natural';
    else if (this.browser.setVoice(v)) this.pref = v;
    else return;
    save('voicePref', this.pref);
    if (this.status === 'speaking' || this.status === 'loading') { this.offset = 0; this.#start(); }
    this.#emit();
  }

  setRate(rate) {
    this.rate = rate;
    save('rate', rate);
    if (this.engine === 'natural') this.recorded.setRate(rate);          // live, keeps the pitch
    else if (this.status === 'speaking') this.#start();                 // browser: restart the sentence
    this.#emit();
  }

  setVolume(v) {
    this.volume = Math.min(1, Math.max(0, v));
    save('volume', this.volume);
    this.recorded.setVolume(this.volume);                              // browser voice: from the next sentence
    this.#emit();
  }

  // ---------------------------------------------------------------- control
  /**
   * Load the narration of a new position and start it (unless muted / unsupported).
   * @param {string} text   spoken script (audio/spokenScript.js)
   * @param {object} o      key: manifest key of the recording; next: key to preload
   */
  load(id, text, { key = null, next = null, autoplay = true } = {}) {
    this.#cancel();
    this.id = id;
    this.key = key;
    this.next = next;
    this.text = text;
    this.chunks = splitSentences(forSpeech(text));
    this.index = 0;
    this.offset = 0;
    this.engine = null;
    if (!this.supported) { this.#emit(); return; }
    if (this.muted) { this.status = 'muted'; this.#emit(); return; }
    if (autoplay) this.#start();
    else { this.status = 'idle'; this.#emit(); }
  }

  /** Play (from the start), or resume when paused. */
  play() {
    if (!this.supported || !this.chunks.length) return;
    if (this.muted) { this.setMuted(false); return; }
    if (this.status === 'paused') { this.resume(); return; }
    if (this.status === 'speaking' || this.status === 'loading') return;
    if (this.status === 'blocked') { this.#unlock(); return; }
    this.index = 0;
    this.offset = 0;
    this.#start();
  }

  pause() {
    if (this.status !== 'speaking' && this.status !== 'loading') return;
    if (this.engine === 'natural' && this.status === 'speaking') this.offset = this.recorded.pause();
    this.#cancel();
    this.status = 'paused';
    this.#emit();
  }

  resume() {
    if (this.status !== 'paused') return;
    this.#start();
  }

  /** Play ↔ pause ↔ resume, for a single toggle button / the Space key. */
  toggle() {
    if (this.status === 'speaking' || this.status === 'loading') this.pause();
    else this.play();
  }

  replay() {
    if (!this.supported || !this.chunks.length) return;
    if (this.muted) { this.setMuted(false); return; }
    this.index = 0;
    this.offset = 0;
    this.#start();
  }

  stop() {
    this.#cancel();
    if (this.status !== 'muted' && this.status !== 'unsupported') this.status = 'idle';
    this.#emit();
  }

  setMuted(m) {
    this.muted = !!m;
    save('muted', this.muted);
    if (!this.supported) { this.#emit(); return; }
    if (this.muted) {
      this.#cancel();
      this.status = 'muted';
      this.#emit();
    } else {
      this.status = 'idle';
      this.index = 0;
      this.offset = 0;
      if (this.chunks.length) this.#start();          // unmute → narrate the current step
      else this.#emit();
    }
  }

  // ---------------------------------------------------------------- engine
  #cancel() {
    this.gen++;
    this.recorded.stop();
    this.browser.cancel();
  }

  async #start() {
    if (!this.supported || this.muted || !this.chunks.length) return;
    this.#cancel();
    const gen = this.gen;
    this.status = 'loading';
    this.#emit();
    await this.recorded.ready;                      // manifest: fetched once per session
    if (gen !== this.gen) return;                   // the user moved on meanwhile
    const wantNatural = this.pref === 'natural' && this.key;
    if (wantNatural && this.recorded.has(this.key, this.text)) {
      this.engine = 'natural';
      this.#emit();
      this.recorded.start(this.key, { rate: this.rate, volume: this.volume, from: this.offset });
      return;
    }
    if (wantNatural && this.recorded.isStale(this.key, this.text)) this.#notice('stale');
    else if (wantNatural && (!this.recorded.supported || !this.recorded.manifest)) this.#notice('fallback');
    this.#speakBrowser();
  }

  #speakBrowser() {
    this.engine = 'browser';
    if (!this.browser.supported) {
      this.status = 'error';
      this.lastError = 'no-voice';
      this.#notice('unavailable');
      this.#emit();
      return;
    }
    this.status = 'speaking';
    this.#emit();
    this.browser.speak(this.chunks, this.index, { rate: this.rate, volume: this.volume });
  }

  /** The recording failed: continue with the browser voice from the start of the instruction. */
  #fallback(kind) {
    this.lastError = kind;
    this.#notice('fallback');
    this.index = 0;
    this.offset = 0;
    this.#speakBrowser();
  }

  #unlock() {
    if (this.engine === 'natural') {
      if (!this.recorded.unlock()) this.#start();
    } else {
      this.status = 'speaking';
      this.#emit();
      this.browser.speak(this.chunks, this.index, { rate: this.rate, volume: this.volume });
    }
  }

  #notice(kind) {
    if (this.noticed.has(kind)) return;
    this.noticed.add(kind);
    this.dispatchEvent(new CustomEvent('notice', { detail: { kind, message: NOTICES[kind] } }));
  }

  #emit() {
    this.dispatchEvent(new CustomEvent('state', {
      detail: {
        status: this.status,
        muted: this.muted,
        id: this.id,
        engine: this.engine,
        sentence: this.index,
        sentences: this.chunks.length,
        voice: this.voice,
      },
    }));
  }
}
