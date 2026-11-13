import { esc } from './text.js';

/**
 * NarrationControls — Play / Pause / Resume, Replay, Mute and voice settings.
 * Rendered from AppState (narration, muted, voice, position) so the step card
 * controls and the AR overlay controls always show the same state.
 */
export class NarrationControls {
  constructor({ narrator, state, els, onReplay, rates, isLastStep }) {
    Object.assign(this, { narrator, state, els, onReplay, rates, isLastStep });
    const n = narrator;
    els.play.addEventListener('click', () => n.toggle());
    els.replay.addEventListener('click', () => onReplay());
    els.mute.addEventListener('click', () => n.setMuted(!n.muted));
    els.arVoice.addEventListener('click', () => n.toggle());
    els.arMute.addEventListener('click', () => n.setMuted(!n.muted));

    els.settings.addEventListener('click', (e) => {
      e.stopPropagation();
      els.pop.hidden = !els.pop.hidden;
      els.settings.setAttribute('aria-expanded', String(!els.pop.hidden));
    });
    document.addEventListener('click', (e) => {
      if (!els.pop.hidden && !els.pop.contains(e.target) && e.target !== els.settings) {
        els.pop.hidden = true;
        els.settings.setAttribute('aria-expanded', 'false');
      }
    });
    els.voiceSel.addEventListener('change', () => n.setVoice(els.voiceSel.value));
    els.rateSel.innerHTML = rates.map((r) => `<option value="${r}">${r}×</option>`).join('');
    els.rateSel.value = String(n.rate);
    els.rateSel.addEventListener('change', () => n.setRate(parseFloat(els.rateSel.value)));
    n.addEventListener('voices', () => this.#renderVoices());
    this.#renderVoices();
    state.addEventListener('change', () => this.render());
    this.render();
  }

  #renderVoices() {
    const n = this.narrator;
    const opts = n.voices.map((v) => `<option value="${esc(v.voiceURI)}">${esc(v.name)} (${esc(v.lang)})</option>`);
    this.els.voiceSel.innerHTML = opts.length ? opts.join('') : '<option>No voices available</option>';
    this.els.voiceSel.disabled = !opts.length;
    if (n.voice) this.els.voiceSel.value = n.voice.voiceURI;
  }

  render() {
    const { els } = this;
    const st = this.state.get('narration');
    const muted = this.state.get('muted');
    const voice = this.state.get('voice');
    const unsupported = st === 'unsupported';

    const label = st === 'speaking' ? 'Pause' : st === 'paused' ? 'Resume' : 'Play';
    const icon = st === 'speaking' ? '#i-pause' : '#i-play';
    els.playLabel.textContent = label;
    els.play.querySelector('use').setAttribute('href', icon);
    els.play.setAttribute('aria-label', `${label} narration`);
    els.play.title = `${label} narration (Space)`;
    els.arVoice.querySelector('use').setAttribute('href', icon);
    els.arVoice.setAttribute('aria-label', `${label} narration`);

    for (const b of [els.play, els.replay, els.mute, els.settings, els.arVoice, els.arMute]) b.disabled = unsupported;
    const muteIcon = muted ? '#i-volume-off' : '#i-volume';
    els.mute.querySelector('use').setAttribute('href', muteIcon);
    els.mute.setAttribute('aria-pressed', String(!!muted));
    els.muteLabel.textContent = muted ? 'Unmute' : 'Mute';
    els.mute.title = `${muted ? 'Unmute' : 'Mute'} narration (M)`;
    els.arMute.querySelector('use').setAttribute('href', muteIcon);
    els.arMute.classList.toggle('is-on', !!muted);
    els.arMute.setAttribute('aria-label', muted ? 'Unmute narration' : 'Mute narration');

    const text = {
      speaking: 'Speaking…',
      paused: 'Paused',
      ended: this.isLastStep() ? 'Narration finished' : 'Finished · press NEXT STEP to continue',
      blocked: 'Tap Play to hear the instructions',
      muted: 'Narration muted',
      idle: 'Narration ready',
      error: 'Voice unavailable · written instructions above',
      unsupported: 'Voice narration is not supported in this browser · follow the written instructions',
    }[st] || '';
    els.status.textContent = text;
    els.root.dataset.status = st;
    els.voiceKind.textContent = !voice ? 'No voice selected.'
      : voice.natural && /microsoft/i.test(voice.name)
        ? `${voice.name}: a Microsoft "Natural" (neural) voice supplied by your browser.`
        : voice.natural
          ? `${voice.name}: marked "Natural/Neural" by its provider; supplied by your browser.`
          : `${voice.name}: a standard voice supplied by your browser or operating system.`;
  }
}
