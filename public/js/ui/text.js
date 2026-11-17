import { ASSEMBLED, EXPLODED } from '../scene/Sequencer.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmt = (n, d = 0) => Number(n).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });

/** Part number when the CAD name is one, otherwise the CAD name. */
export function displayId(rowOrStep) {
  return rowOrStep.partNumber ?? rowOrStep.name;
}

/** Descriptive name (from the STEP solid names; derived for sub-assemblies), else the CAD name. */
export function displayName(rowOrNode) {
  return rowOrNode.label || rowOrNode.partNumber || rowOrNode.name;
}

/** "Filter Frame Half" → "Filter Frame Halves", "Clip Nut" → "Clip Nuts", "… sub-assembly" → "… sub-assemblies". */
export function plural(label) {
  const s = String(label);
  if (/half$/i.test(s)) return s.replace(/(h)alf$/i, (m, h) => `${h}alves`);
  if (/[^aeiou]y$/i.test(s)) return s.slice(0, -1) + 'ies';
  if (/(s|x|z|ch|sh)$/i.test(s)) return s + 'es';
  return s + 's';
}

const lower = (s) => String(s).toLowerCase();
const named = (label, n) => (n === 1 ? label : plural(label));

/** Only directions a fitter can use without a coordinate system. */
function directionPhrase(dir) {
  if (!dir) return '';
  const [x, y, z] = dir;
  if (Math.abs(y) >= 0.9 && Math.abs(y) >= Math.abs(x) && Math.abs(y) >= Math.abs(z)) {
    return y < 0 ? ' from above' : ' from below';   // the part travels along `dir`
  }
  return '';
}

/** Label of the component an assembly is built on (its 'base' step), used as the fitting target. */
function targetOf(model, asmId) {
  const base = model.steps.find((s) => s.kind === 'base' && s.assembly === asmId);
  const asm = model.node(asmId);
  if (!base) return displayName(asm);
  return displayName(model.node(base.nodes[0]));
}

/**
 * Text of a navigation position. One source for the step card, the step list,
 * the AR overlay and the voice: `speech` is the on-screen title + instruction.
 * Generated only from assembly.json (names, quantities, hierarchy, direction, flags).
 *
 * @returns {{badge, kind, title, desc, components, note, speech}}  title/components are HTML
 */
export function positionText(model, pos) {
  const N = model.stepCount;
  const m = model.meta;
  const product = m.displayName || m.product;      // visible name (CONFIG.productName)
  if (pos === ASSEMBLED) {
    return {
      badge: 'Overview', kind: 'Complete product',
      title: `${esc(product)} — assembled`,
      desc: `${m.partInstances} parts in ${m.assemblies - 1} sub-assemblies, at their CAD positions. ${N} steps. Press NEXT STEP to see the parts kit.`,
      components: null, note: null,
      speech: `${product} overview. ${m.partInstances} parts, ${N} steps. Press Next step to see the parts kit.`,
    };
  }
  if (pos === EXPLODED) {
    return {
      badge: 'Parts kit', kind: 'Exploded view',
      title: 'All components separated',
      desc: 'Each component is shown along its removal direction. Press NEXT STEP to start step 1.',
      components: null, note: null,
      speech: 'Parts kit. Each component is shown along its removal direction. Press Next step to start step 1.',
    };
  }
  if (pos >= N) {
    return {
      badge: 'Done', kind: 'Assembly complete',
      title: `${esc(product)} assembled`,
      desc: `All ${m.partInstances} components are at their CAD positions.`,
      components: null, note: null, speech: `The ${product} assembly is complete.`,
    };
  }

  const s = model.steps[pos];
  const asm = model.node(s.assembly);
  const inst = s.assemblyInstances.length;
  const per = inst > 1 ? s.qty / inst : s.qty;
  const comp = model.node(s.nodes[0]);
  const lbl = displayName(comp.kind === 'assembly' ? comp : s);
  const target = lower(targetOf(model, s.assembly));
  const dir = directionPhrase(s.direction);
  const batch = s.set ? ` (${s.set[0]}/${s.set[1]})` : '';
  const what = per === 1 ? `the ${lower(lbl)}` : `${per} ${lower(plural(lbl))}`;

  let kind, title, desc;
  switch (s.kind) {
    case 'base':
      kind = 'Base component';
      title = `Position the ${named(lbl, per)}`;
      desc = `Start the ${asm.id === model.rootId ? 'final assembly' : lower(displayName(asm))}: place ${what}.`;
      break;
    case 'subassembly':
      kind = 'Install sub-assembly';
      title = `Install the ${named(lbl, per)}`;
      desc = `Fit the completed ${per === 1 ? lower(lbl) : `${per} ${lower(plural(lbl))}`} to the ${target}${dir}.`;
      break;
    case 'fasten':
      kind = 'Hardware';
      title = `Fit the ${named(lbl, per)}${batch}`;
      desc = `Fit ${what} to the ${target}${dir}.`;
      break;
    default:
      kind = 'Install component';
      title = `Install the ${named(lbl, per)}${batch}`;
      desc = lower(lbl) === target && per === 1
        ? `Fit the second ${target} to the first${dir}.`
        : `Fit ${what} to the ${target}${dir}.`;
  }
  if (inst > 1) desc += ` Repeat on ${inst === 2 ? 'both' : `all ${inst}`} ${lower(plural(displayName(asm)))}.`;
  if (pos === N - 1) desc += ' The assembly is complete.';

  const pn = s.partNumber ? ` · <span class="pn">${esc(s.partNumber)}</span>` : '';
  const components = `${s.qty}× ${esc(lbl)}${pn}`;
  const note = s.flag ? 'Animated path approximate: the CAD model shows no collision-free path for this part.' : null;
  return {
    badge: `Step ${pos + 1} / ${N}`, kind, title: esc(title), desc, components, note,
    speech: `Step ${pos + 1}. ${title}. ${desc}`,
  };
}
