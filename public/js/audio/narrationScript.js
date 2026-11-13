/**
 * Spoken instructions for every sequencer position.
 *
 * Built only from data in assembly.json (sequence, hierarchy, BOM rows, install
 * direction, geometry flags, optional ERP descriptions). Nothing is invented:
 * the "purpose" of a step is stated as its place in the assembly structure
 * (which sub-assembly it builds and in which step that sub-assembly is installed),
 * and "considerations" are the documented geometry-check notes.
 */
import { AssemblyModel } from '../data/AssemblyModel.js';
import { ASSEMBLED, EXPLODED } from '../scene/Sequencer.js';

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

/** "14.1.3" → "14 point 1 point 3" */
export const speakItem = (item) => String(item).split('.').join(' point ');

const NUM = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const qtyWord = (n) => (n <= 12 ? NUM[n] : String(n));

function speakDirection(dir) {
  const t = AssemblyModel.directionText(dir);
  if (!t) return '';
  return t.replace('+', 'plus ').replace('−', 'minus ').replace(/\s*\(([^)]*)\)/, ', $1');
}

/** How a component is named aloud: its part number, or its CAD name when it has none. */
function speakComponent(row) {
  if (row.partNumber) return `part number ${speakCode(row.partNumber)}`;
  if (row.unit || /\.(stp|step)$/i.test(row.name)) return `the purchased unit listed as BOM item ${speakItem(row.item)}`;
  return row.name.replace(/\b([A-Z]{1,3})-(\d+)\b/g, '$1 $2');
}

function speakAssembly(model, asm) {
  if (asm.id === model.rootId) return `the main assembly ${speakCode(asm.name)}`;
  return `sub-assembly ${speakCode(asm.name)}`;
}

/** Last sequence index of the work done inside an assembly instance (its own steps and nested builds). */
function buildEnd(model, asmId) {
  const ids = new Set();
  const walk = (id) => { ids.add(id); for (const c of model.node(id).children) if (model.node(c).kind === 'assembly') walk(c); };
  walk(asmId);
  let last = -1;
  model.steps.forEach((s, k) => { if (s.assemblyInstances.some((a) => ids.has(a))) last = Math.max(last, k); });
  return last;
}

export function narrationText(model, pos) {
  const N = model.stepCount;
  const m = model.meta;
  if (pos === ASSEMBLED) {
    return `Welcome. This is the ${speakCode(m.product)} assembly. It has ${m.partInstances} parts in ${m.assemblies - 1} sub-assemblies, `
      + `shown at their original CAD positions. The assembly is explained in ${N} steps. `
      + 'Press Next step to see all components separated.';
  }
  if (pos === EXPLODED) {
    return 'This is the parts kit. Every component is shown separated from the assembly, '
      + 'moved along the removal direction found by collision analysis of the CAD geometry. '
      + 'Sub-assemblies are exploded inside their parent. Press Next step to start with step 1.';
  }
  if (pos >= N) return `The ${speakCode(m.product)} assembly is complete.`;

  const s = model.steps[pos];
  const asm = model.node(s.assembly);
  const row = model.rowByNode.get(s.nodes[0]);
  const instances = s.assemblyInstances.length;
  const per = instances > 1 ? s.qty / instances : s.qty;
  const dir = speakDirection(s.direction);
  const what = speakComponent(row);
  const into = speakAssembly(model, asm);
  const parts = [`Step ${pos + 1} of ${N}.`];

  // operation
  switch (s.kind) {
    case 'base':
      parts.push(`Position the base component, ${what}. It is the base of ${into}; the following parts are fitted to it.`);
      break;
    case 'subassembly': {
      const n = model.partsUnder(s.nodes[0]).length;
      parts.push(`Install the completed sub-assembly ${speakCode(s.name)}, made of ${n} parts${dir ? `, ${dir}` : ''}, into ${into}.`);
      break;
    }
    case 'fasten':
      parts.push(`Fit ${qtyWord(per)} ${per === 1 ? 'piece' : 'pieces'} of hardware, ${what}${dir ? `, ${dir}` : ''}, into ${into}.`);
      break;
    default:
      parts.push(`Install ${qtyWord(per)} ${per === 1 ? 'piece' : 'pieces'} of ${what}${dir ? `, ${dir}` : ''}, into ${into}.`);
  }
  if (instances > 1) parts.push(`Do this on ${instances === 2 ? 'both' : `all ${qtyWord(instances)}`} identical sub-assemblies, ${s.qty} pieces in total.`);
  if (s.set) parts.push(`This is batch ${s.set[0]} of ${s.set[1]} for this part number.`);

  // BOM information
  let bom = `BOM item ${speakItem(s.item)}, quantity ${row.qty} per ${asm.id === model.rootId ? 'product' : 'sub-assembly'}.`;
  if (row.description) bom += ` Description: ${row.description}.`;
  if (row.material) bom += ` Material: ${row.material}.`;
  if (!row.partNumber && !row.unit) bom += ' This component has no part number in the CAD data.';
  parts.push(bom);

  // purpose: the step's place in the assembly structure
  if (asm.id !== model.rootId) {
    const name = speakCode(asm.name);
    const installs = s.assemblyInstances
      .map((id) => model.node(id))
      .filter((a) => a.step !== null && a.step !== undefined)
      .map((a) => ({ step: a.step + 1, parent: model.parentOf(a.id) }));
    const steps = [...new Set(installs.map((x) => x.step))].sort((a, b) => a - b);
    const stepList = steps.length > 1 ? `steps ${steps.slice(0, -1).join(', ')} and ${steps[steps.length - 1]}` : `step ${steps[0]}`;
    const complete = pos === buildEnd(model, asm.id);
    if (steps.length && instances > 1) {
      parts.push(complete
        ? `This completes the ${qtyWord(instances)} identical sub-assemblies ${name}. They are installed in ${stepList}.`
        : `This is part of building the ${qtyWord(instances)} identical sub-assemblies ${name}, which are installed in ${stepList}.`);
    } else if (steps.length) {
      const parent = installs[0].parent;
      const target = parent ? speakAssembly(model, parent) : 'the product';
      parts.push(complete
        ? `This completes sub-assembly ${name}. It is installed into ${target} in ${stepList}.`
        : `This is part of building sub-assembly ${name}, which is installed into ${target} in ${stepList}.`);
    }
  } else if (s.kind === 'subassembly') {
    parts.push('This brings the sub-assembly into the final product.');
  }

  // documented considerations (geometry checks)
  if (s.flag) {
    if (/axial path/.test(s.flag)) {
      parts.push('Note: the CAD model shows no free path along the axis of these parts, which is typical for rivets, clinch fasteners or threaded parts. The animation shows them head first.');
    } else if (/clips|captive/.test(s.flag)) {
      parts.push('Note: the CAD model shows no free path for this hardware, which is typical for clips or captive parts. The animated direction is approximate.');
    } else {
      parts.push('Note: in the CAD model this component is enclosed by surrounding parts, so the animated direction is approximate. Check the real access path on the unit.');
    }
  }

  parts.push('The parts of this step are highlighted in orange.');
  if (pos === N - 1) parts.push(`This is the final step. The ${speakCode(m.product)} assembly is now complete.`);
  else parts.push('Press Next step when you are ready.');
  return parts.join(' ');
}
