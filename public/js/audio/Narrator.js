/**
 * Narrator — spoken assembly instructions with the Web Speech API (speechSynthesis).
 *
 * Voice technology: the browser's own text-to-speech. No API keys, no audio files.
 *  - Microsoft Edge exposes Microsoft's online "Natural" voices (neural TTS run by
 *    Microsoft); they are preferred automatically and labelled "Natural voice".
 *  - Other browsers use the voices installed on the device (Google, Apple, Microsoft
 *    desktop voices…); they are labelled "Browser voice" — no neural claim is made.
 *
 * Behaviour guarantees:
 *  - one narration at a time: every new request cancels the previous one, and stale
 *    utterance events are ignored through a generation token;
 *  - text is spoken sentence by sentence (avoids the Chrome cut-off on long utterances
 *    and gives reliable pause/resume: resume restarts the interrupted sentence);
 *  - the narrator never navigates: 'ended' is only reported, never acted upon;
 *  - browsers block speech until the first user gesture: status becomes 'blocked'
 *    and the narration starts automatically on the next tap/click/key press.
 *
 * Events: 'state' (detail: snapshot), 'voices'.
 */
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

export class Narrator extends EventTarget {
  constructor({ lang = 'en', defaultRate = 1 } = {}) {
    super();
    this.synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
    this.supported = !!(this.synth && typeof window.SpeechSynthesisUtterance === 'function');
    this.lang = lang;
    this.rate = load('rate', defaultRate);
    this.muted = !!load('muted', false);
    this.voiceURI = load('voice', null);
    this.voices = [];
    this.voice = null;
    this.id = null;
    this.text = '';
    this.chunks = [];
    this.index = 0;
    this.token = 0;
    this.status = this.supported ? (this.muted ? 'muted' : 'idle') : 'unsupported';
    if (!this.supported) return;

    this.#loadVoices();
    const onVoices = () => this.#loadVoices();
    if (this.synth.addEventListener) this.synth.addEventListener('voiceschanged', onVoices);
    else this.synth.onvoiceschanged = onVoices;

    // speech is only allowed after a user gesture: retry the current narration then
    const unlock = () => { if (this.status === 'blocked' && !this.muted) this.#speakFrom(this.index); };
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
    window.addEventListener('pagehide', () => this.stop());
  }

  // ------------------------------------------------------------------ voices
  static isNatural(v) { return !!v && /natural|neural/i.test(v.name); }

  static score(v, lang) {
    let s = 0;
    const vl = (v.lang || '').toLowerCase().replace('_', '-');
    if (vl.startsWith(lang)) s += 100; else return -1;
    if (Narrator.isNatural(v)) s += 60;                 // Edge online neural voices
    if (/premium|enhanced/i.test(v.name)) s += 40;       // Apple downloadable high-quality voices
    if (/google/i.test(v.name)) s += 25;                 // Chrome network voices
    if (/online/i.test(v.name)) s += 10;
    if (vl === `${lang}-us`) s += 8;
    else if (vl === `${lang}-gb`) s += 5;
    if (v.default) s += 2;
    return s;
  }

  #loadVoices() {
    const all = this.synth.getVoices() || [];
    const ranked = all
      .map((v) => ({ v, s: Narrator.score(v, this.lang) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.v);
    this.voices = ranked.length ? ranked : all;     // no voice for the language: offer all
    this.voice = this.voices.find((v) => v.voiceURI === this.voiceURI) || this.voices[0] || null;
    this.dispatchEvent(new Event('voices'));
    this.#emit();
  }

  setVoice(uri) {
    const v = this.voices.find((x) => x.voiceURI === uri);
    if (!v) return;
    this.voice = v;
    this.voiceURI = uri;
    save('voice', uri);
    if (this.status === 'speaking') this.#speakFrom(this.index);
    this.#emit();
  }

  setRate(rate) {
    this.rate = rate;
    save('rate', rate);
    if (this.status === 'speaking') this.#speakFrom(this.index);
    this.#emit();
  }

  // ---------------------------------------------------------------- control
  /** Load the narration of a new step and start it (unless muted / unsupported). */
  load(id, text, { autoplay = true } = {}) {
    this.#cancel();
    this.id = id;
    this.text = text;
    this.chunks = splitSentences(text);
    this.index = 0;
    if (!this.supported) { this.#emit(); return; }
    if (this.muted) { this.status = 'muted'; this.#emit(); return; }
    if (autoplay) this.#speakFrom(0);
    else { this.status = 'idle'; this.#emit(); }
  }

  /** Play (from the start), or resume when paused. */
  play() {
    if (!this.supported || !this.chunks.length) return;
    if (this.muted) this.setMuted(false);
    if (this.status === 'paused') { this.resume(); return; }
    if (this.status === 'speaking') return;
    this.#speakFrom(this.status === 'blocked' ? this.index : 0);
  }

  pause() {
    if (this.status !== 'speaking') return;
    this.#cancel();
    this.status = 'paused';
    this.#emit();
  }

  resume() {
    if (this.status !== 'paused') return;
    this.#speakFrom(this.index);
  }

  /** Play ↔ pause ↔ resume, for a single toggle button / the Space key. */
  toggle() {
    if (this.status === 'speaking') this.pause();
    else this.play();
  }

  replay() {
    if (!this.supported || !this.chunks.length) return;
    if (this.muted) this.setMuted(false);
    this.#speakFrom(0);
  }

  stop() {
    if (!this.supported) return;
    this.#cancel();
    if (this.status !== 'muted') this.status = 'idle';
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
      this.#speakFrom(0);               // unmute → narrate the current step
    }
  }

  // ---------------------------------------------------------------- engine
  #cancel() {
    this.token++;
    clearTimeout(this.startTimer);
    clearTimeout(this.watchdog);
    if (this.supported && (this.synth.speaking || this.synth.pending)) this.synth.cancel();
  }

  #speakFrom(i) {
    if (!this.supported || this.muted) return;
    this.#cancel();
    const token = this.token;
    this.index = Math.max(0, Math.min(i, this.chunks.length));
    this.status = 'speaking';
    this.#emit();
    // a short gap after cancel(): some engines drop an utterance queued in the same tick
    this.startTimer = setTimeout(() => { if (token === this.token) this.#utter(this.index, token); }, 60);
  }

  #utter(i, token) {
    if (i >= this.chunks.length) {
      this.status = 'ended';
      this.#emit();
      return;
    }
    const u = new SpeechSynthesisUtterance(this.chunks[i]);
    u.lang = this.voice ? this.voice.lang : this.lang;
    if (this.voice) { try { u.voice = this.voice; } catch { /* engine rejected the voice: keep lang */ } }
    u.rate = this.rate;
    let started = false;
    u.onstart = () => {
      if (token !== this.token) return;
      started = true;
      clearTimeout(this.watchdog);
      this.index = i;
    };
    u.onend = () => {
      if (token !== this.token) return;
      clearTimeout(this.watchdog);
      this.#utter(i + 1, token);
    };
    u.onerror = (e) => {
      if (token !== this.token) return;
      clearTimeout(this.watchdog);
      const err = e && e.error;
      if (err === 'interrupted' || err === 'canceled') return;
      this.index = i;
      this.status = err === 'not-allowed' ? 'blocked' : 'error';
      this.lastError = err || 'unknown';
      this.#emit();
    };
    this.index = i;
    if (this.synth.paused) this.synth.resume();
    this.synth.speak(u);
    // engines that silently refuse to speak (no gesture yet) never fire onstart
    this.watchdog = setTimeout(() => {
      if (token === this.token && !started && !this.synth.speaking) {
        this.status = 'blocked';
        this.#emit();
      }
    }, 2500);
  }

  #emit() {
    this.dispatchEvent(new CustomEvent('state', {
      detail: {
        status: this.status,
        muted: this.muted,
        id: this.id,
        sentence: this.index,
        sentences: this.chunks.length,
        voice: this.voice ? { name: this.voice.name, lang: this.voice.lang, natural: Narrator.isNatural(this.voice) } : null,
      },
    }));
  }
}
