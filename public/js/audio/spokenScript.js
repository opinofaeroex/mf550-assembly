/**
 * Spoken script — what the voice says at each navigation position (v1.4).
 *
 * The step card is written to be read; this script is written to be heard. It is built
 * from the same step facts as the card (ui/text.js stepFacts), so both always describe
 * the same operation, component, quantity, target and direction — only the delivery
 * differs:
 *   - the card's title and instruction say the same thing twice; the voice says it once
 *     ("Step 3. Fit six pan head machine screws to the gauge box enclosure, from above.");
 *   - quantities are words, batch marks such as "(1/3)" become "the first of three …";
 *   - commas and full stops give the natural pauses of a spoken instruction.
 * Nothing is added that is not in assembly.json: no torques, tools or safety statements.
 *
 * Pronunciation is a separate layer (forSpeech): the screen keeps the real names.
 * The natural (recorded) voice also uses an IPA lexicon at generation time
 * (tools/narration/lexicon.json).
 */
import { ASSEMBLED, EXPLODED } from '../scene/Sequencer.js';
import { stepFacts, plural, displayName } from '../ui/text.js';

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const ORDINALS = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];

/** 0–99 as words ("thirty-eight"); larger numbers stay digits (the engines read them well). */
export function numberWords(n) {
  if (!Number.isInteger(n) || n < 0 || n > 99) return String(n);
  if (n < 20) return ONES[n];
  return TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : '');
}

const ordinal = (n) => ORDINALS[n] || `number ${n}`;
const lower = (s) => String(s).toLowerCase();

/**
 * Spoken-only substitutions applied to the text sent to any speech engine.
 * Visible names in the app and the BOM are never changed.
 */
export const SPOKEN_ALIASES = [
  [/\bMist-Fit 550\b/g, 'Mist-Fit five fifty'],     // model numbers are read in pairs
];

export function forSpeech(text) {
  return SPOKEN_ALIASES.reduce((t, [re, rep]) => t.replace(re, rep), String(text));
}

/** Key of a position in the narration manifest: overview, parts-kit, step-01 … step-69, complete. */
export function narrationKey(model, pos) {
  if (pos === ASSEMBLED) return 'overview';
  if (pos === EXPLODED) return 'parts-kit';
  if (pos >= model.stepCount) return 'complete';
  return `step-${String(pos + 1).padStart(2, '0')}`;
}

/** The sentence describing what is fitted and where. */
function fitSentence(f) {
  const lbl = lower(f.label);
  const dir = f.direction ? `, ${f.direction}` : '';
  let what;
  let setNote = '';
  if (f.kind === 'subassembly') {
    what = f.per === 1 ? `the completed ${lbl}` : `${numberWords(f.per)} completed ${lower(plural(f.label))}`;
  } else if (f.kind !== 'fasten' && f.per === 1 && lbl === f.target) {
    return `Fit the second ${f.target} to the first${dir}.`;
  } else if (f.per === 1 && f.set) {
    what = `the ${ordinal(f.set[0])} of ${numberWords(f.set[1])} ${lower(plural(f.label))}`;
  } else {
    what = f.per === 1 ? `the ${lbl}` : `${numberWords(f.per)} ${lower(plural(f.label))}`;
    if (f.set) setNote = ` This is the ${ordinal(f.set[0])} of ${numberWords(f.set[1])} sets.`;
  }
  return `Fit ${what} to the ${f.target}${dir}.${setNote}`;
}

/** Natural spoken instruction of a navigation position (see the header comment). */
export function spokenText(model, pos) {
  const N = model.stepCount;
  const m = model.meta;
  const product = m.displayName || m.product;
  if (pos === ASSEMBLED) {
    return `This is the ${product}, fully assembled: ${m.partInstances} parts, put together in ${N} steps. Press Next step to see the parts kit.`;
  }
  if (pos === EXPLODED) {
    return 'Here is the parts kit. Each component is shown along its removal direction. Press Next step to begin with step 1.';
  }
  if (pos >= N) {
    return `The ${product} assembly is complete. All ${m.partInstances} components are in their final positions.`;
  }
  const f = stepFacts(model, pos);
  let body;
  if (f.kind === 'base') {
    const start = f.assemblyName === null ? 'the final assembly' : `the ${lower(f.assemblyName)}`;
    const what = f.per === 1 ? `the ${lower(f.label)}` : `${numberWords(f.per)} ${lower(plural(f.label))}`;
    body = `Start ${start}. Place ${what}.`;
  } else {
    body = fitSentence(f);
  }
  if (f.instances > 1) {
    const asms = lower(plural(displayName(model.node(f.step.assembly))));
    body += ` Repeat this on ${f.instances === 2 ? 'both' : `all ${numberWords(f.instances)}`} ${asms}.`;
  }
  if (f.last) body += ' The assembly is complete.';
  return `Step ${pos + 1}. ${body}`;
}
