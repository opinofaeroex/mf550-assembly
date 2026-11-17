import { esc } from './text.js';

/**
 * NarrationControls — Play / Pause / Resume, Replay, Mute and voice settings
 * (voice: natural recorded voice or a browser voice, speed, volume).
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
    // volume: element volume where the platform allows it (iOS uses the hardware buttons)
    els.volume.value = String(Math.round(n.volume * 100));
    els.volumeOut.textContent = `${els.volume.value}%`;
    els.volume.addEventListener('input', () => {
      n.setVolume(parseInt(els.volume.value, 10) / 100);
      els.volumeOut.textContent = `${els.volume.value}%`;
    });
    els.volumeRow.hidden = !n.volumeControllable;
    els.rateSel.innerHTML = rates.map((r) => `<option value="${r}">${r}×</option>`).join('');
    els.rateSel.value = String(n.rate);
    els.rateSel.addEventListener('change', () => n.setRate(parseFloat(els.rateSel.value)));
    n.addEventListener('voices', () => this.#renderVoices());
    this.#renderVoices();
    state.addEventListener('change', () => this.render());
    this.render();
  }

  /** Natural (recorded) voice first, then the browser's voices as alternatives. */
  #renderVoices() {
    const n = this.narrator;
    const nat = n.naturalInfo;
    const natural = n.naturalAvailable && nat
      ? `<option value="natural">${esc(nat.voiceName)} · natural voice (recommended)</option>` : '';
    const browser = n.voices.map((v) => `<option value="${esc(v.voiceURI)}">${esc(v.name)} (${esc(v.lang)})</option>`).join('');
    const html = natural + (browser ? `<optgroup label="Browser voices">${browser}</optgroup>` : '');
    this.els.voiceSel.innerHTML = html || '<option>No voices available</option>';
    this.els.voiceSel.disabled = !html;
    const want = n.pref === 'natural' && natural ? 'natural' : n.browser.voice ? n.browser.voice.voiceURI : '';
    if (want) this.els.voiceSel.value = want;
  }

  render() {
    const { els } = this;
    const st = this.state.get('narration');
    const muted = this.state.get('muted');
    const voice = this.state.get('voice');
    const unsupported = st === 'unsupported';

    const busy = st === 'speaking' || st === 'loading';
    const label = busy ? 'Pause' : st === 'paused' ? 'Resume' : 'Play';
    const icon = busy ? '#i-pause' : '#i-play';
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
      loading: 'Loading voice…',
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
      : voice.kind === 'recorded'
        ? `${voice.name}: neural text-to-speech (${voice.model}), recorded for every step and played from this site.`
      : voice.natural && /microsoft/i.test(voice.name)
        ? `${voice.name}: a Microsoft "Natural" (neural) voice supplied by your browser.`
        : voice.natural
          ? `${voice.name}: marked "Natural/Neural" by its provider; supplied by your browser.`
          : `${voice.name}: a standard voice supplied by your browser or operating system.`;
  }
}
