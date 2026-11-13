import { esc, fmt } from './text.js';

const MISSING = '<dd class="missing">Not in STEP file</dd>';   // optional: pipeline --bom-csv

/**
 * Details — data sheet for the selected BOM row / part instance.
 * Shows only what the CAD data contains; everything else is marked missing.
 */
export class Details {
  constructor(model, els) {
    this.model = model;
    this.els = els;
  }

  show(sel) {
    if (!sel) { this.els.root.hidden = true; return; }
    const m = this.model;
    const row = sel.row;
    const inst = sel.partId ? m.node(sel.partId) : null;
    const first = m.node(row.nodes[0]);
    const parent = m.node(row.parent);
    const total = m.partsList.find((p) => p.name === row.name);
    const ex = first.bboxMax.map((v, i) => (v - first.bboxMin[i]) * 1000);
    const type = row.unit ? 'Purchased / imported unit (handled as one component)'
      : row.kind === 'sub-assembly' ? `Sub-assembly (${m.partsUnder(first.id).length} parts)`
        : 'Part';
    const steps = row.steps.length ? row.steps.map((s) => s + 1).join(', ') : row.insideUnit ? 'Part of a purchased unit' : '—';
    const flag = (inst && inst.flag) || first.flag;

    this.els.item.textContent = `Item ${row.item}${inst ? ' · instance ' + inst.cad : ''}`;
    this.els.title.textContent = row.partNumber ?? row.name;
    const rows = [
      ['Component (CAD)', `<dd class="mono">${esc(row.name)}</dd>`],
      ['Part number', row.partNumber ? `<dd class="mono">${esc(row.partNumber)}</dd>` : '<dd class="missing">Not in STEP file — CAD name shown</dd>'],
      ['Quantity', `<dd>${row.qty} in ${esc(parent.name)}${total && row.kind === 'part' && total.qty !== row.qty ? ` · ${total.qty} in product` : ''}</dd>`],
      ['Type', `<dd>${esc(type)}</dd>`],
      ['Parent assembly', `<dd class="mono">${esc([...m.assemblyPath(first.id)].join(' › '))}</dd>`],
      ['Assembly step', `<dd>${steps}</dd>`],
      ['Envelope', `<dd>${ex.map((v) => fmt(v, 1)).join(' × ')} mm</dd>`],
      ['Volume', `<dd>${fmt(first.volumeMm3 / 1000, 2)} cm³ (from CAD solid)</dd>`],
      ['Description', row.description ? `<dd>${esc(row.description)}</dd>` : MISSING],
      ['Material', row.material ? `<dd>${esc(row.material)}</dd>` : MISSING],
    ];
    if (row.revision) rows.push(['Revision', `<dd class="mono">${esc(row.revision)}</dd>`]);
    if (flag) rows.push(['Geometry note', `<dd>${esc(flag)}</dd>`]);
    this.els.grid.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt>${v}`).join('');
    this.els.goto.disabled = row.steps.length === 0;
    this.els.root.hidden = false;
  }
}
