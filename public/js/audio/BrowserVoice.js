/**
 * BrowserVoice — the browser's own text-to-speech (Web Speech API), used as the
 * fallback when the recorded natural voice cannot be played, or when the user picks
 * one of the browser's voices in the voice settings.
 *
 *  - text is spoken sentence by sentence (avoids the Chrome cut-off on long utterances
 *    and gives reliable pause/resume: resume restarts the interrupted sentence);
 *  - every start carries a token: events of cancelled utterances are ignored;
 *  - engines that silently refuse to speak before a user gesture are detected by a
 *    watchdog and reported as blocked.
 *
 * Callbacks (set by Narrator): onSentence(i), onEnded(), onBlocked(), onError(code), onVoices().
 */
export class BrowserVoice {
  constructor({ lang = 'en' } = {}) {
    this.synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
    this.supported = !!(this.synth && typeof window.SpeechSynthesisUtterance === 'function');
    this.lang = lang;
    this.voices = [];
    this.voice = null;
    this.voiceURI = null;
    this.token = 0;
    if (!this.supported) return;
    this.#loadVoices();
    const onVoices = () => this.#loadVoices();
    if (this.synth.addEventListener) this.synth.addEventListener('voiceschanged', onVoices);
    else this.synth.onvoiceschanged = onVoices;
  }

  static isNatural(v) { return !!v && /natural|neural/i.test(v.name); }

  static score(v, lang) {
    let s = 0;
    const vl = (v.lang || '').toLowerCase().replace('_', '-');
    if (vl.startsWith(lang)) s += 100; else return -1;
    if (BrowserVoice.isNatural(v)) s += 60;              // Edge online neural voices
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
      .map((v) => ({ v, s: BrowserVoice.score(v, this.lang) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.v);
    this.voices = ranked.length ? ranked : all;     // no voice for the language: offer all
    this.voice = this.voices.find((v) => v.voiceURI === this.voiceURI) || this.voices[0] || null;
    this.onVoices && this.onVoices();
  }

  setVoice(uri) {
    const v = this.voices.find((x) => x.voiceURI === uri);
    if (!v) return false;
    this.voice = v;
    this.voiceURI = uri;
    return true;
  }

  get descriptor() {
    return this.voice ? { name: this.voice.name, lang: this.voice.lang, natural: BrowserVoice.isNatural(this.voice), kind: 'browser' } : null;
  }

  cancel() {
    this.token++;
    clearTimeout(this.startTimer);
    clearTimeout(this.watchdog);
    if (this.supported && (this.synth.speaking || this.synth.pending)) this.synth.cancel();
  }

  /** Speak chunks[i…] (after a short gap: some engines drop an utterance queued right after cancel). */
  speak(chunks, i, { rate = 1, volume = 1 } = {}) {
    this.cancel();
    const token = this.token;
    this.startTimer = setTimeout(() => { if (token === this.token) this.#utter(chunks, i, token, rate, volume); }, 60);
  }

  #utter(chunks, i, token, rate, volume) {
    if (i >= chunks.length) { this.onEnded && this.onEnded(); return; }
    const u = new SpeechSynthesisUtterance(chunks[i]);
    u.lang = this.voice ? this.voice.lang : this.lang;
    if (this.voice) { try { u.voice = this.voice; } catch { /* engine rejected the voice: keep lang */ } }
    u.rate = rate;
    u.volume = volume;
    let started = false;
    u.onstart = () => {
      if (token !== this.token) return;
      started = true;
      clearTimeout(this.watchdog);
      this.onSentence && this.onSentence(i);
    };
    u.onend = () => {
      if (token !== this.token) return;
      clearTimeout(this.watchdog);
      this.#utter(chunks, i + 1, token, rate, volume);
    };
    u.onerror = (e) => {
      if (token !== this.token) return;
      clearTimeout(this.watchdog);
      const err = e && e.error;
      if (err === 'interrupted' || err === 'canceled') return;
      if (err === 'not-allowed') this.onBlocked && this.onBlocked(i);
      else this.onError && this.onError(err || 'unknown', i);
    };
    this.onSentence && this.onSentence(i);
    if (this.synth.paused) this.synth.resume();
    this.synth.speak(u);
    // engines that silently refuse to speak (no gesture yet) never fire onstart
    this.watchdog = setTimeout(() => {
      if (token === this.token && !started && !this.synth.speaking) this.onBlocked && this.onBlocked(i);
    }, 2500);
  }
}
