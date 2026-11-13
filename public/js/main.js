/**
 * MF-550 WebAR assembly instructions — application bootstrap.
 *
 * Data flow (single direction, so 3D, BOM and step card always agree):
 *
 *   Sequencer.pos ──► ExplodeController (component positions)
 *        │        ──► Appearance (active / ghost / selected materials)
 *        │        ──► BomPanel, step card, progress bar, callout, AR overlay
 *   Selection ──────► Appearance, BomPanel, Details, callout
 */
import * as THREE from 'three';
import { loadAssembly } from './data/AssemblyModel.js';
import { Viewer } from './scene/Viewer.js';
import { loadModel } from './scene/ModelLoader.js';
import { Appearance, STATE } from './scene/Appearance.js';
import { ExplodeController } from './scene/Explode.js';
import { Sequencer, ASSEMBLED, EXPLODED } from './scene/Sequencer.js';
import { Picker } from './scene/Picker.js';
import { Callout } from './scene/Callout.js';
import { BomPanel } from './ui/BomPanel.js';
import { Details } from './ui/Details.js';
import { positionText, esc, displayId } from './ui/text.js';
import { detectAR } from './ar/ARSupport.js';
import { WebXRSession } from './ar/WebXRSession.js';
import { QuickLook } from './ar/QuickLook.js';

const CONFIG = {
  assemblyUrl: 'assets/model/assembly.json',
  modelDir: 'assets/model/',
};

const $ = (id) => document.getElementById(id);

class App {
  constructor() {
    this.opts = { ghost: true, edges: true, focus: true, isolate: false };
    this.selection = null;
    this.inAR = false;
  }

  // ------------------------------------------------------------------ boot
  async init() {
    this.viewer = new Viewer($('viewport'));
    try {
      this.#loader('Loading assembly data…', 0.05);
      this.model = await loadAssembly(CONFIG.assemblyUrl);
      this.#loader('Loading 3D model…', 0.1);
      this.loaded = await loadModel(CONFIG.modelDir + this.model.meta.glb, this.model,
        (p) => this.#loader('Loading 3D model…', 0.1 + p * 0.8));
    } catch (err) {
      this.#loaderError(err);
      return;
    }
    this.#loader('Preparing scene…', 0.95);

    const { model, loaded, viewer } = this;
    viewer.setModel(loaded.root);
    this.appearance = new Appearance(loaded);
    this.explode = new ExplodeController(model, loaded.objects);
    this.seq = new Sequencer(model, this.explode);
    this.picker = new Picker(viewer, this.appearance);
    this.stepCallout = new Callout($('callout-layer'), 'step');
    this.selCallout = new Callout($('callout-layer'), 'sel');
    this.activeParts = model.steps.map((s) => new Set(s.nodes.flatMap((id) => model.partsUnder(id))));
    // parts of the (sub-)assembly being worked on; null = whole product
    this.stepContext = model.steps.map((s) => (s.assembly === model.rootId ? null
      : new Set(s.assemblyInstances.flatMap((id) => model.partsUnder(id)))));

    viewer.onUpdate.push((dt) => {
      this.seq.update(dt);
      this.#updateCallouts();
    });
    viewer.controls.addEventListener('start', () => viewer.cancelCameraTween());

    this.#initHeader();
    this.#initPanels();
    this.#initTransport();
    this.#initViewportInput();
    this.#initKeyboard();

    this.seq.addEventListener('change', () => this.#onPosition());
    this.seq.addEventListener('stepstart', () => this.#focusCamera());
    this.seq.addEventListener('playstate', () => this.#updatePlayButtons());
    this.seq.addEventListener('ended', () => this.#toast('Assembly sequence complete.'));

    const startStep = this.#deepLinkStep();
    this.seq.goTo(ASSEMBLED, { animate: false });
    if (startStep !== null) this.seq.goTo(startStep);
    this.#updatePlayButtons();

    // CAD edges are built after the first frame so the model appears quickly
    setTimeout(() => {
      this.appearance.buildEdges();
      this.appearance.setEdgesVisible(this.opts.edges);
    }, 60);

    this.#loader('Ready', 1);
    setTimeout(() => $('loader').classList.add('is-done'), 150);
    this.#initAR();
    if (new URLSearchParams(location.search).has('autoplay')) this.seq.play();
    window.app = this; // handy for debugging / automation
  }

  #loader(text, p) {
    $('loader-text').textContent = text;
    $('loader-bar').style.width = `${Math.round(p * 100)}%`;
  }

  #loaderError(err) {
    console.error(err);
    const l = $('loader');
    l.classList.add('is-error');
    const hint = location.protocol === 'file:'
      ? 'Browsers block loading model files from file://. Start a local web server (see README: <code>npm start</code>).'
      : 'Check that public/assets/model/ contains the GLB and assembly.json produced by the pipeline.';
    $('loader-text').innerHTML = `Could not load the assembly.<code>${esc(err.message)}</code><br>${hint}`;
  }

  #deepLinkStep() {
    const m = /step=(\d+)/.exec(location.hash + location.search);
    if (!m) return null;
    const k = parseInt(m[1], 10) - 1;
    return k >= 0 && k < this.model.stepCount ? k : null;
  }

  // ---------------------------------------------------------------- header
  #initHeader() {
    const m = this.model.meta;
    $('product-title').textContent = m.product;
    document.title = `${m.product} · Interactive Assembly Instructions`;
    $('meta-chips').innerHTML = [
      `<span class="chip"><b>${m.partInstances}</b> part instances</span>`,
      `<span class="chip"><b>${this.model.bom.length}</b> BOM lines</span>`,
      `<span class="chip"><b>${this.model.stepCount}</b> steps</span>`,
      `<span class="chip">Source: ${esc(m.sourceFile)}</span>`,
    ].join('');
    $('btn-help').addEventListener('click', () => $('help-dialog').showModal());
    const note = `Data source: ${m.sourceFile}, converted with ${m.converter}. The STEP file contains geometry, colours, component names and the hierarchy (encoded in body names). `
      + `It does not contain ${m.unavailable.join(', ')}; these are shown as "Not in STEP file"${m.bomSource ? ` unless supplied by the BOM export ${m.bomSource}` : ''}. The assembly order is ${m.sequenceSource}.`;
    $('help-data-note').textContent = note;
    $('sidebar-foot').textContent = `${m.sourceFile} · ${m.partInstances} instances · ${m.uniqueMeshes} unique meshes · order derived from geometry (STEP has no assembly sequence)`;
  }

  // ---------------------------------------------------------------- panels
  #initPanels() {
    this.bom = new BomPanel(this.model, {
      bomBody: document.querySelector('#bom-table tbody'),
      partsBody: document.querySelector('#parts-table tbody'),
      stepsList: $('steps-list'),
      scroll: $('panel-scroll'),
      search: $('search'),
      searchBox: document.querySelector('.search'),
      tabs: [...document.querySelectorAll('.tab')],
      panels: [...document.querySelectorAll('[data-panel]')],
    });
    this.bom.showTab('bom');
    this.bom.addEventListener('select-row', (e) => this.select({ row: e.detail.row }));
    this.bom.addEventListener('select-part-group', (e) => {
      const entry = e.detail.entry;
      this.select({ row: this.model.rowByNode.get(entry.nodes[0]), nodeIds: entry.nodes });
    });
    this.bom.addEventListener('goto-step', (e) => this.seq.goTo(e.detail.index));

    this.details = new Details(this.model, {
      root: $('details'), item: $('details-item'), title: $('details-title'), grid: $('details-grid'), goto: $('details-goto'),
    });
    $('details-close').addEventListener('click', () => this.select(null));
    $('details-goto').addEventListener('click', () => {
      if (this.selection && this.selection.row.steps.length) this.seq.goTo(this.selection.row.steps[0]);
    });
    $('details-zoom').addEventListener('click', () => this.#zoomToSelection());
    $('details-isolate').addEventListener('click', () => this.#setOpt('isolate', !this.opts.isolate));

    $('sheet-handle').addEventListener('click', () => $('sidebar').classList.toggle('is-open'));

    const tool = (id, opt, after) => {
      const b = $(id);
      b.addEventListener('click', () => { this.#setOpt(opt, !this.opts[opt]); after && after(); });
    };
    tool('tool-ghost', 'ghost');
    tool('tool-edges', 'edges');
    tool('tool-focus', 'focus', () => this.opts.focus && this.#focusCamera());
    tool('tool-isolate', 'isolate');
    $('tool-frame').addEventListener('click', () => this.viewer.frame());
  }

  #setOpt(name, value) {
    this.opts[name] = value;
    const map = { ghost: 'tool-ghost', edges: 'tool-edges', focus: 'tool-focus', isolate: 'tool-isolate' };
    const b = $(map[name]);
    b.classList.toggle('is-on', value);
    b.setAttribute('aria-pressed', value);
    if (name === 'edges') this.appearance.setEdgesVisible(value);
    if (name === 'isolate') $('details-isolate').textContent = value ? 'Show all' : 'Isolate';
    this.#refreshAppearance();
  }

  // ------------------------------------------------------------- transport
  #initTransport() {
    const N = this.model.stepCount;
    const ticks = [];
    for (let k = 0; k < N; k++) {
      const s = this.model.steps[k];
      const left = ((k + 2) / (N + 2)) * 100;
      ticks.push(`<i data-k="${k}" class="${s.kind === 'base' || s.assembly === this.model.rootId ? '' : 'sub'}" style="left:${left}%"></i>`);
    }
    $('progress-ticks').innerHTML = ticks.join('');
    this.tickEls = [...$('progress-ticks').children];

    $('btn-play').addEventListener('click', () => this.seq.toggle());
    $('btn-next').addEventListener('click', () => this.seq.next());
    $('btn-prev').addEventListener('click', () => this.seq.prev());
    $('btn-restart').addEventListener('click', () => { this.seq.restart(); });
    $('btn-explode').addEventListener('click', () => this.#toggleExplode());
    $('speed').addEventListener('change', (e) => { this.seq.speed = parseFloat(e.target.value); });

    const prog = $('progress');
    const seek = (clientX) => {
      const r = prog.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
      this.seq.goTo(Math.round(frac * (N + 2)) - 2);
    };
    prog.addEventListener('click', (e) => seek(e.clientX));
    prog.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') { this.seq.next(); e.preventDefault(); }
      if (e.key === 'ArrowLeft') { this.seq.prev(); e.preventDefault(); }
    });
  }

  #toggleExplode() {
    this.seq.pause();
    this.seq.goTo(this.seq.pos === EXPLODED ? ASSEMBLED : EXPLODED);
  }

  #updatePlayButtons() {
    const icon = this.seq.playing ? '#i-pause' : '#i-play';
    for (const id of ['btn-play', 'ar-play']) {
      const b = $(id);
      b.querySelector('use').setAttribute('href', icon);
      b.setAttribute('aria-label', this.seq.playing ? 'Pause' : 'Play');
    }
  }

  // ------------------------------------------------------- position change
  #onPosition() {
    const { seq, model } = this;
    const pos = seq.pos;
    const N = model.stepCount;
    const t = positionText(model, pos);

    $('step-badge').textContent = t.badge;
    $('step-kind').textContent = t.kind;
    $('step-title').innerHTML = t.title;
    $('step-desc').textContent = t.desc;
    const note = $('step-note');
    note.hidden = !t.note;
    if (t.note) note.innerHTML = `<svg><use href="#i-warn"/></svg><span>${esc(t.note)}</span>`;

    this.bom.setPosition(pos);
    this.#refreshAppearance();

    // progress
    $('progress-fill').style.width = `${seq.progress() * 100}%`;
    this.tickEls.forEach((el, k) => {
      el.classList.toggle('done', k < pos);
      el.classList.toggle('cur', k === pos);
    });
    const installed = model.partsInstalledBefore(pos >= N ? N : Math.max(0, pos) + (seq.isStep ? 1 : 0));
    $('progress-label').textContent = seq.isStep ? `Step ${pos + 1} / ${N}` : pos === ASSEMBLED ? 'Overview' : pos === EXPLODED ? 'Exploded view' : 'Complete';
    const where = seq.isStep ? ` · in ${model.node(model.steps[pos].assembly).name}` : '';
    $('progress-sub').textContent = `${pos === ASSEMBLED ? model.meta.partInstances : installed} / ${model.meta.partInstances} parts placed${where}`;
    $('progress').setAttribute('aria-valuenow', String(pos + 2));
    $('progress').setAttribute('aria-valuetext', $('progress-label').textContent);
    $('btn-prev').disabled = pos <= ASSEMBLED;
    $('btn-next').disabled = pos >= N;
    const exploded = pos === EXPLODED;
    $('btn-explode').setAttribute('aria-pressed', exploded);
    $('ar-explode').classList.toggle('is-on', exploded);

    this.#syncStepCallout();

    const hash = seq.isStep ? `#step=${pos + 1}` : '';
    if (location.hash !== hash) history.replaceState(null, '', location.pathname + location.search + hash);
    this.#updateAROverlay();
  }

  /** Step balloon; hidden when the selection balloon already points at the same BOM item. */
  #syncStepCallout() {
    const { seq, model } = this;
    if (!seq.isStep) { this.stepCallout.hide(); return; }
    const s = model.steps[seq.pos];
    if (this.selection && this.selection.row.item === s.item) { this.stepCallout.hide(); return; }
    this.stepCallout.set(s.nodes.map((id) => this.loaded.objects.get(id)), s.item, `${s.qty > 1 ? s.qty + '× ' : ''}${displayId(s)}`);
  }

  #refreshAppearance() {
    if (!this.appearance) return;
    const { seq, model } = this;
    const pos = seq.pos;
    const active = seq.isStep ? this.activeParts[pos] : null;
    const context = seq.isStep ? this.stepContext[pos] : null;
    const sel = this.selection ? this.selection.partSet : null;
    for (const id of model.partIds) {
      let st = STATE.NORMAL;
      if (active) {
        if (active.has(id)) st = STATE.ACTIVE;
        else if (this.opts.ghost) {
          // outside the sub-assembly being built, or not installed yet → ghost
          const s = model.node(id).effectiveStep;
          if ((context && !context.has(id)) || (s !== null && s > pos)) st = STATE.GHOST;
        }
      }
      if (sel) {
        if (sel.has(id)) st = STATE.SELECTED;
        else if (this.opts.isolate) st = STATE.GHOST;
      }
      this.appearance.set(id, st);
    }
  }

  #focusCamera() {
    if (!this.opts.focus || this.inAR) return;
    const { seq, model, viewer } = this;
    if (!seq.isStep) { viewer.frame(); return; }
    const s = model.steps[seq.pos];
    if (s.assembly === model.rootId) { viewer.frame(); return; }
    const box = new THREE.Box3();
    for (const id of s.assemblyInstances) box.union(viewer.boxOf(this.loaded.objects.get(id)));
    viewer.frame(box, true, 1.2);
  }

  // -------------------------------------------------------------- selection
  /**
   * @param {{row: object, partId?: string, nodeIds?: string[]}|null} sel
   */
  select(sel) {
    const m = this.model;
    if (!sel || !sel.row) {
      this.selection = null;
      this.bom.setSelected(null);
      this.details.show(null);
      this.selCallout.hide();
      if (this.opts.isolate) this.#setOpt('isolate', false);
      this.#syncStepCallout();
      this.#refreshAppearance();
      this.#updateAROverlay();
      return;
    }
    const nodeIds = sel.nodeIds ?? (sel.partId ? [sel.partId] : sel.row.nodes);
    const partSet = new Set(nodeIds.flatMap((id) => m.partsUnder(id)));
    this.selection = { ...sel, nodeIds, partSet };
    this.details.show(this.selection);          // first: it changes the BOM panel height
    this.bom.setSelected(sel.row.item);
    this.selCallout.set(nodeIds.map((id) => this.loaded.objects.get(id)), sel.row.item, displayId(sel.row));
    this.#syncStepCallout();
    this.#refreshAppearance();
    this.#updateAROverlay();
    if (window.matchMedia('(max-width: 860px)').matches && !this.inAR) $('sidebar').classList.add('is-open');
  }

  #zoomToSelection() {
    if (!this.selection) return;
    const box = new THREE.Box3();
    for (const id of this.selection.nodeIds) box.union(this.viewer.boxOf(this.loaded.objects.get(id)));
    const size = box.getSize(new THREE.Vector3()).length();
    box.expandByScalar(Math.max(size * 0.8, 0.08));
    this.viewer.frame(box, true, 1.1);
  }

  #onPick(partId) {
    if (!partId) { this.select(null); return; }
    this.select({ row: this.model.rowByNode.get(partId), partId });
  }

  #initViewportInput() {
    const canvas = this.viewer.renderer.domElement;
    let down = null;
    canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
    canvas.addEventListener('pointerup', (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      const dt = performance.now() - down.t;
      down = null;
      if (moved > 6 || dt > 500) return;
      this.#onPick(this.picker.pick(e.clientX, e.clientY, canvas.getBoundingClientRect()));
    });
  }

  #initKeyboard() {
    window.addEventListener('keydown', (e) => {
      if (e.target.closest && e.target.closest('input, select, textarea, dialog')) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key;
      if (k === ' ') { this.seq.toggle(); e.preventDefault(); }
      else if (k === 'ArrowRight') { this.seq.next(); e.preventDefault(); }
      else if (k === 'ArrowLeft') { this.seq.prev(); e.preventDefault(); }
      else if (k === 'e' || k === 'E') this.#toggleExplode();
      else if (k === 'r' || k === 'R') this.seq.restart();
      else if (k === 'f' || k === 'F') this.viewer.frame();
      else if (k === 'g' || k === 'G') this.#setOpt('ghost', !this.opts.ghost);
      else if (k === 'i' || k === 'I') this.#setOpt('isolate', !this.opts.isolate);
      else if (k === 'Escape') this.select(null);
    });
  }

  #updateCallouts() {
    const cam = this.viewer.activeCamera();
    let w, h;
    if (this.inAR) { w = window.innerWidth; h = window.innerHeight; }
    else { const r = this.viewer.container; w = r.clientWidth; h = r.clientHeight; }
    this.stepCallout.update(cam, w, h);
    this.selCallout.update(cam, w, h);
  }

  // --------------------------------------------------------------------- AR
  async #initAR() {
    this.arCaps = await detectAR();
    const btn = $('btn-ar');
    btn.disabled = false;
    const mode = this.arCaps.mode;
    btn.title = mode === 'webxr' ? 'Start markerless AR (WebXR)' : mode === 'quicklook' ? 'Open in AR Quick Look' : 'AR availability on this device';
    btn.addEventListener('click', () => (mode === 'webxr' ? this.#startWebXR() : this.#openARDialog()));
    this.quickLook = new QuickLook({
      viewer: this.viewer, appearance: this.appearance, model: this.model, explode: this.explode,
      fileName: `${this.model.meta.product}-assembly.usdz`,
      staticUrl: `${CONFIG.modelDir}${this.model.meta.product}-assembly.usdz`,
    });
    this.#bindAROverlay();
  }

  async #startWebXR() {
    if (!this.xr) {
      this.xr = new WebXRSession({
        viewer: this.viewer,
        overlay: $('ar-overlay'),
        picker: this.picker,
        onSelect: (id) => this.#onPick(id),
        onStart: () => {
          this.inAR = true;
          this.edgesBeforeAR = this.opts.edges;
          if (this.opts.edges) this.#setOpt('edges', false);
          $('ar-overlay').prepend($('callout-layer'));
          $('ar-hint').hidden = false;
          $('ar-controls').hidden = true;
          $('ar-info').hidden = true;
          this.#updateAROverlay();
        },
        onEnd: () => {
          this.inAR = false;
          $('viewport').prepend($('callout-layer'));
          if (this.edgesBeforeAR) this.#setOpt('edges', true);
          setTimeout(() => this.viewer.frame(undefined, false), 50);
        },
        onScale: (s) => {
          const r = Math.abs(s - 1) < 0.01 ? '1:1' : s < 1 ? `1:${(1 / s).toFixed(1)}` : `${s.toFixed(1)}:1`;
          $('ar-scale').textContent = `Scale ${r}`;
          $('ar-scale-toggle').textContent = r;
        },
      });
    }
    try {
      await this.xr.start();
      this.xr.onScale(this.xr.scale);
    } catch (err) {
      console.error(err);
      this.#toast(`Could not start AR: ${err.message}`);
    }
  }

  #bindAROverlay() {
    const ov = $('ar-overlay');
    $('ar-exit').addEventListener('click', () => this.xr && this.xr.end());
    $('ar-reposition').addEventListener('click', () => {
      this.xr && this.xr.reposition();
      $('ar-hint').hidden = false;
    });
    $('ar-prev').addEventListener('click', () => this.seq.prev());
    $('ar-next').addEventListener('click', () => this.seq.next());
    $('ar-play').addEventListener('click', () => this.seq.toggle());
    $('ar-explode').addEventListener('click', () => this.#toggleExplode());
    $('ar-scale-toggle').addEventListener('click', () => {
      const steps = [1, 0.5, 0.25];
      const cur = this.xr.scale;
      const i = steps.findIndex((s) => Math.abs(s - cur) < 0.01);
      this.xr.setScale(steps[(i + 1) % steps.length]);
    });
    ov.addEventListener('ar-tracking', (e) => {
      if (!this.xr || !this.xr.placing) return;
      $('ar-hint').textContent = e.detail.found ? 'Tap to place the assembly' : 'Move your phone slowly to detect the floor';
    });
    ov.addEventListener('ar-placed', () => {
      $('ar-hint').hidden = true;
      $('ar-controls').hidden = false;
      $('ar-info').hidden = false;
      const g = $('ar-gesture-hint');
      g.hidden = false;
      clearTimeout(this.gestureTimer);
      this.gestureTimer = setTimeout(() => { g.hidden = true; }, 5000);
    });
  }

  #updateAROverlay() {
    if (!this.inAR) return;
    const t = positionText(this.model, this.seq.pos);
    $('ar-step-badge').textContent = t.badge;
    const tmp = document.createElement('div');
    tmp.innerHTML = t.title;
    $('ar-step-title').textContent = tmp.textContent;
    const selEl = $('ar-selection');
    if (this.selection) {
      const r = this.selection.row;
      const inst = this.selection.partId ? this.model.node(this.selection.partId) : null;
      selEl.innerHTML = `Item ${esc(r.item)} · <b>${esc(r.partNumber ?? r.name)}</b> · qty ${r.qty}${r.steps.length ? ' · step ' + r.steps.map((s) => s + 1).join(', ') : ''}${inst ? `<br>Instance ${esc(inst.cad)}` : ''}`;
      selEl.hidden = false;
    } else {
      selEl.hidden = true;
    }
  }

  #openARDialog() {
    const caps = this.arCaps;
    const body = $('ar-dialog-body');
    const li = (ok, text) => `<li class="${ok ? 'yes' : 'no'}"><span class="dot"></span>${text}</li>`;
    if (caps.mode === 'quicklook') {
      body.innerHTML = `
        <p>This device uses <b>AR Quick Look</b> (ARKit). Safari on iOS/iPadOS does not support WebXR, so the assembly is exported to a USDZ file in your browser. The exploded view and the full ${this.model.stepCount}-step assembly animation play on a detected surface; tap and pinch to place and scale. The interactive BOM stays in this page.</p>
        <p class="muted" id="ql-status">Preparing…</p>
        <div class="ar-dialog-actions"><button type="button" class="btn btn-accent" id="ql-open" disabled>Open AR Quick Look</button></div>`;
      $('ar-dialog').showModal();
      this.quickLook.prepare((s) => { $('ql-status').textContent = s; }).then(() => {
        $('ql-status').textContent = `Ready (${(this.quickLook.size / 1e6).toFixed(1)} MB USDZ).`;
        const b = $('ql-open');
        b.disabled = false;
        b.onclick = () => this.quickLook.open();
      }).catch((err) => { $('ql-status').textContent = `USDZ export failed: ${err.message}`; });
      return;
    }
    body.innerHTML = `
      <p>Markerless AR is not available in this browser. The full 3D viewer, exploded view, assembly sequence and BOM work here; for AR open this page on:</p>
      <ul class="ar-support">
        ${li(true, 'Android phone/tablet with ARCore — Chrome (WebXR, full interactive AR)')}
        ${li(true, 'iPhone / iPad — Safari (AR Quick Look with the assembly animation)')}
      </ul>
      <p>Checks for this browser:</p>
      <ul class="ar-support">
        ${li(caps.secureContext, 'Secure context (HTTPS or localhost)')}
        ${li(caps.webxrApi, 'WebXR Device API')}
        ${li(caps.immersiveAR, 'immersive-ar sessions')}
        ${li(caps.quickLook, 'AR Quick Look')}
      </ul>
      <div class="url-box">${esc(location.href)}</div>
      <div class="ar-dialog-actions">
        <button type="button" class="btn" id="ar-copy">Copy link</button>
        <button type="button" class="btn" id="ar-usdz">Download animated USDZ</button>
      </div>
      <p class="muted" id="ql-status"></p>`;
    $('ar-dialog').showModal();
    $('ar-copy').onclick = () => navigator.clipboard?.writeText(location.href).then(() => this.#toast('Link copied'));
    $('ar-usdz').onclick = async () => {
      try {
        const url = await this.quickLook.prepare((s) => { $('ql-status').textContent = s; });
        $('ql-status').textContent = `USDZ ready (${(this.quickLook.size / 1e6).toFixed(1)} MB).`;
        const a = document.createElement('a');
        a.href = url; a.download = this.quickLook.fileName; a.click();
      } catch (err) { $('ql-status').textContent = `USDZ export failed: ${err.message}`; }
    };
  }

  #toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
  }
}

new App().init();
