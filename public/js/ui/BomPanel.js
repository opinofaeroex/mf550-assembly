import { esc, positionText } from './text.js';

/**
 * BomPanel — indented BOM (tree), flat parts list and step list.
 * Emits: 'select-row' {row}, 'select-part-group' {entry}, 'goto-step' {index}
 */
export class BomPanel extends EventTarget {
  constructor(model, els) {
    super();
    this.model = model;
    this.els = els;
    this.collapsed = new Set();
    this.filter = '';
    this.current = null;
    this.selectedItem = null;
    // purchased/imported units start collapsed
    for (const r of model.bom) if (r.unit) this.collapsed.add(r.item);
    this.#renderBom();
    this.#renderParts();
    this.#renderSteps();
    this.#bind();
  }

  #renderBom() {
    const rows = this.model.bom.map((r) => {
      const isAsm = r.kind === 'sub-assembly';
      const pn = r.partNumber
        ? `<span class="pn-main">${esc(r.partNumber)}</span>`
        : `<span class="pn-main">${esc(r.name)}</span><span class="pn-name pn-missing">No part number in CAD data</span>`;
      const badges = (r.unit ? '<span class="badge badge-unit">Purchased unit</span>' : isAsm ? '<span class="badge badge-asm">Sub-asm</span>' : '');
      const toggle = isAsm
        ? `<button class="tree-toggle ${this.collapsed.has(r.item) ? '' : 'open'}" data-toggle="${r.item}" aria-label="Expand"><svg><use href="#i-chev"/></svg></button>`
        : '<span class="tree-spacer"></span>';
      const steps = r.steps.length ? r.steps.map((s) => s + 1).join(', ') : (r.insideUnit ? 'unit' : '—');
      return `<tr data-item="${r.item}" class="${r.insideUnit ? 'is-unit-child' : ''}">
        <td class="c-item">${r.item}</td>
        <td class="c-pn"><div class="pn-cell" style="padding-left:${r.level * 14}px">${toggle}<div>${pn}${badges}</div></div></td>
        <td class="c-qty">${r.qty}</td>
        <td class="c-step" title="Assembly step">${steps}</td></tr>`;
    });
    this.els.bomBody.innerHTML = rows.join('');
    this.rowEls = new Map([...this.els.bomBody.querySelectorAll('tr')].map((tr) => [tr.dataset.item, tr]));
    this.#applyVisibility();
  }

  #renderParts() {
    const rows = this.model.partsList.map((p, i) => {
      const items = this.model.bom.filter((r) => r.kind === 'part' && r.name === p.name).map((r) => r.item);
      const pn = p.partNumber
        ? `<span class="pn-main">${esc(p.partNumber)}</span>`
        : `<span class="pn-main">${esc(p.name)}</span><span class="pn-name pn-missing">No part number in CAD data</span>`;
      return `<tr data-part="${i}" class="${p.insideUnit ? 'is-unit-child' : ''}"><td class="c-pn"><div class="pn-cell"><div>${pn}${p.insideUnit ? '<span class="badge badge-unit">Unit</span>' : ''}</div></div></td>
        <td class="c-qty">${p.qty}</td><td class="c-step" title="BOM items">${items.slice(0, 3).join(', ')}${items.length > 3 ? '…' : ''}</td></tr>`;
    });
    this.els.partsBody.innerHTML = rows.join('');
  }

  #renderSteps() {
    const items = this.model.steps.map((s, i) => {
      const t = positionText(this.model, i);
      const asm = this.model.node(s.assembly);
      return `<li data-step="${i}"><span class="sn">${String(i + 1).padStart(2, '0')}</span><span class="st">${t.title}<span class="ss">${esc(t.kind)} · in ${esc(asm.name)}${s.assemblyInstances.length > 1 ? ' ×' + s.assemblyInstances.length : ''}${s.flag ? ' · <span class="badge badge-flag">check</span>' : ''}</span></span></li>`;
    });
    this.els.stepsList.innerHTML = items.join('');
    this.stepEls = [...this.els.stepsList.querySelectorAll('li')];
  }

  #bind() {
    this.els.bomBody.addEventListener('click', (e) => {
      const t = e.target.closest('[data-toggle]');
      if (t) {
        const it = t.dataset.toggle;
        this.collapsed.has(it) ? this.collapsed.delete(it) : this.collapsed.add(it);
        t.classList.toggle('open', !this.collapsed.has(it));
        this.#applyVisibility();
        return;
      }
      const tr = e.target.closest('tr[data-item]');
      if (tr) this.dispatchEvent(new CustomEvent('select-row', { detail: { row: this.model.rowByItem.get(tr.dataset.item) } }));
    });
    this.els.partsBody.addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-part]');
      if (tr) this.dispatchEvent(new CustomEvent('select-part-group', { detail: { entry: this.model.partsList[+tr.dataset.part] } }));
    });
    this.els.stepsList.addEventListener('click', (e) => {
      const li = e.target.closest('li[data-step]');
      if (li) this.dispatchEvent(new CustomEvent('goto-step', { detail: { index: +li.dataset.step } }));
    });
    this.els.search.addEventListener('input', () => {
      this.filter = this.els.search.value.trim().toLowerCase();
      this.#applyVisibility();
    });
    for (const tab of this.els.tabs) {
      tab.addEventListener('click', () => this.showTab(tab.dataset.tab));
    }
  }

  showTab(name) {
    for (const tab of this.els.tabs) {
      const on = tab.dataset.tab === name;
      tab.classList.toggle('is-active', on);
      tab.setAttribute('aria-selected', on);
    }
    for (const p of this.els.panels) p.hidden = p.dataset.panel !== name;
    this.els.searchBox.hidden = name === 'steps';
    this.tab = name;
    this.#scrollToCurrent();
  }

  #applyVisibility() {
    const f = this.filter;
    const visibleByFilter = new Set();
    if (f) {
      for (const r of this.model.bom) {
        const hay = `${r.item} ${r.name} ${r.partNumber ?? ''}`.toLowerCase();
        if (hay.includes(f)) {
          visibleByFilter.add(r.item);
          // keep ancestors visible for context
          let p = r.item.split('.');
          while (p.length > 1) { p = p.slice(0, -1); visibleByFilter.add(p.join('.')); }
        }
      }
    }
    for (const r of this.model.bom) {
      const tr = this.rowEls.get(r.item);
      let show = true;
      if (f) show = visibleByFilter.has(r.item);
      else {
        const parts = r.item.split('.');
        for (let i = 1; i < parts.length; i++) {
          if (this.collapsed.has(parts.slice(0, i).join('.'))) { show = false; break; }
        }
      }
      tr.hidden = !show;
    }
    for (const tr of this.els.partsBody.querySelectorAll('tr')) {
      const p = this.model.partsList[+tr.dataset.part];
      tr.hidden = !!f && !`${p.name} ${p.partNumber ?? ''}`.toLowerCase().includes(f);
    }
  }

  /** Expand all ancestors of an item so the row becomes visible. */
  #reveal(item) {
    const parts = item.split('.');
    let changed = false;
    for (let i = 1; i < parts.length; i++) {
      const anc = parts.slice(0, i).join('.');
      if (this.collapsed.delete(anc)) {
        changed = true;
        const t = this.els.bomBody.querySelector(`[data-toggle="${anc}"]`);
        t && t.classList.add('open');
      }
    }
    if (changed) this.#applyVisibility();
  }

  /** Mark BOM rows/steps for the sequencer position. */
  setPosition(pos) {
    this.current = pos;
    const N = this.model.stepCount;
    const curItems = new Set();
    if (pos >= 0 && pos < N) {
      for (const id of this.model.steps[pos].nodes) {
        const r = this.model.rowByNode.get(id);
        if (r) curItems.add(r.item);
      }
    }
    for (const r of this.model.bom) {
      const tr = this.rowEls.get(r.item);
      tr.classList.toggle('is-current', curItems.has(r.item));
      const done = r.steps.length > 0 && (pos >= N || r.steps.every((s) => s < pos));
      tr.classList.toggle('is-done', done);
    }
    this.stepEls.forEach((li, i) => {
      li.classList.toggle('is-current', i === pos);
      li.classList.toggle('is-done', pos >= 0 && i < pos);
    });
    for (const it of curItems) this.#reveal(it);
    this.curItems = curItems;
    this.#scrollToCurrent();
  }

  #scrollToCurrent() {
    let el = null;
    if (this.tab === 'steps' && this.current >= 0) el = this.stepEls[this.current];
    else if (this.tab !== 'parts' && this.curItems && this.curItems.size) el = this.rowEls.get([...this.curItems][0]);
    if (el && !el.hidden) this.#scrollTo(el);
  }

  /** Scroll only the panel (scrollIntoView would also scroll the page / bottom sheet). */
  #scrollTo(el) {
    const box = this.els.scroll;
    const head = 34;   // sticky table header
    const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
    const bottom = top + el.offsetHeight;
    if (top - head < box.scrollTop) box.scrollTo({ top: top - head - 8, behavior: 'smooth' });
    else if (bottom > box.scrollTop + box.clientHeight) box.scrollTo({ top: bottom - box.clientHeight + 8, behavior: 'smooth' });
  }

  setSelected(item) {
    if (this.selectedItem) this.rowEls.get(this.selectedItem)?.classList.remove('is-selected');
    this.selectedItem = item;
    if (item) {
      this.#reveal(item);
      const tr = this.rowEls.get(item);
      tr?.classList.add('is-selected');
      if (tr && this.tab === 'bom') this.#scrollTo(tr);
    }
  }
}
