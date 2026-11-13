import { AssemblyModel } from '../data/AssemblyModel.js';
import { ASSEMBLED, EXPLODED } from '../scene/Sequencer.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmt = (n, d = 0) => Number(n).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });

/** Part number when the CAD name is one, otherwise the CAD name. */
export function displayId(rowOrStep) {
  return rowOrStep.partNumber ?? rowOrStep.name;
}

function assemblyLabel(model, asm) {
  return asm.id === model.rootId ? `the main assembly ${asm.name}` : `sub-assembly ${asm.name}`;
}

/**
 * Instruction text for a sequencer position. Generated only from data in
 * assembly.json (names, quantities, hierarchy, install direction, flags).
 */
export function positionText(model, pos) {
  const N = model.stepCount;
  const m = model.meta;
  if (pos === ASSEMBLED) {
    return {
      badge: 'Overview', kind: 'Complete product',
      title: `<span class="pn">${esc(m.product)}</span> — assembled`,
      desc: `${m.partInstances} part instances in ${m.assemblies - 1} sub-assemblies, at their original CAD positions. Press NEXT STEP to see the parts kit and then go through the ${N} assembly steps at your own pace.`,
    };
  }
  if (pos === EXPLODED) {
    return {
      badge: 'Parts kit', kind: 'Exploded view',
      title: 'All components separated',
      desc: 'Each component is moved away along the removal direction found by collision analysis of the CAD geometry. Nested sub-assemblies are exploded inside their parent. Press NEXT STEP to start with step 1.',
    };
  }
  if (pos >= N) {
    return {
      badge: 'Done', kind: 'Assembly complete',
      title: `<span class="pn">${esc(m.product)}</span> assembled`,
      desc: `All ${m.partInstances} components are back at their exact CAD positions.`,
    };
  }
  const s = model.steps[pos];
  const asm = model.node(s.assembly);
  const id = `<span class="pn">${esc(displayId(s))}</span>`;
  const dirText = AssemblyModel.directionText(s.direction);
  const perAsm = s.assemblyInstances.length > 1 ? s.qty / s.assemblyInstances.length : s.qty;
  const qty = s.qty > 1 ? `${s.qty}× ` : '';
  let title, desc, kind;
  switch (s.kind) {
    case 'base':
      kind = 'Base component';
      title = `Position ${qty}${id}`;
      desc = `Place ${s.name} as the base of ${assemblyLabel(model, asm)}. The next components of this ${asm.id === model.rootId ? 'product' : 'sub-assembly'} are fitted to it.`;
      break;
    case 'subassembly': {
      const n = model.partsUnder(s.nodes[0]).length;
      kind = 'Install sub-assembly';
      title = `Install sub-assembly ${id}`;
      desc = `Bring the completed sub-assembly ${s.name} (${n} parts)${dirText ? ' ' + dirText : ''} and fit it into ${assemblyLabel(model, asm)}.`;
      break;
    }
    case 'fasten':
      kind = 'Hardware';
      title = `Fit ${qty}${id}`;
      desc = `Fit ${perAsm} × ${s.name}${dirText ? ' ' + dirText : ''} into ${assemblyLabel(model, asm)}.`;
      break;
    default:
      kind = 'Install component';
      title = `Install ${qty}${id}`;
      desc = `Install ${perAsm} × ${s.name}${dirText ? ' ' + dirText : ''} into ${assemblyLabel(model, asm)}.`;
  }
  if (s.set) desc += ` Batch ${s.set[0]} of ${s.set[1]} for this part number.`;
  if (s.assemblyInstances.length > 1) desc += ` Done on ${s.assemblyInstances.length === 2 ? 'both' : `all ${s.assemblyInstances.length}`} identical ${asm.name} sub-assemblies at once (${s.qty} pcs in total).`;
  if (!s.partNumber) desc += ' No part number in the CAD data — the CAD component name is shown.';
  desc += ` BOM item ${s.item}.`;
  if (pos === N - 1) desc += ` This is the final step: the ${m.product} assembly is complete.`;
  let note = null;
  if (s.flag) note = 'Geometry check: ' + s.flag.charAt(0).toUpperCase() + s.flag.slice(1) + '.';
  return { badge: `Step ${pos + 1} / ${N}`, kind, title, desc, note };
}
