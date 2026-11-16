/**
 * Spoken instructions for every sequencer position.
 *
 * v1.2: the voice says exactly what the step card shows — the step number, the
 * short title and the one-line instruction (ui/text.js positionText().speech) —
 * so written and spoken instructions can never drift apart. Nothing is added
 * that is not in assembly.json: no torques, tools or safety statements.
 */
import { positionText } from '../ui/text.js';

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

export function narrationText(model, pos) {
  return positionText(model, pos).speech;
}
