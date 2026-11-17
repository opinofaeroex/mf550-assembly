/**
 * Narration of every sequencer position.
 *
 * v1.4: the voice speaks the spoken script (audio/spokenScript.js) — the same operation,
 * component, quantity, target and direction as the step card, phrased to be heard rather
 * than read. Nothing is added that is not in assembly.json: no torques, tools or safety
 * statements. The natural voice plays the recording of exactly this text; if the text
 * and the recording ever differ, the browser voice speaks the text instead.
 */
import { ASSEMBLED } from '../scene/Sequencer.js';
import { spokenText, narrationKey } from './spokenScript.js';

/** Spoken script of a position. */
export function narrationText(model, pos) {
  return spokenText(model, pos);
}

/** Recording key of a position and of the position after it (preloaded in the background). */
export function narrationKeys(model, pos) {
  const next = pos < model.stepCount ? pos + 1 : null;
  return { key: narrationKey(model, pos), next: next === null ? null : narrationKey(model, Math.max(next, ASSEMBLED)) };
}

/** "M05SUE-0016-XC" → "M 0 5 S U E, 0 0 1 6, X C" (read character by character). */
export function speakCode(code) {
  return String(code)
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((seg) => (seg.match(/[A-Za-z]+|\d+/g) || [])
      .map((tok) => tok.split('').join(' ').toUpperCase())
      .join(' '))
    .join(', ');
}
