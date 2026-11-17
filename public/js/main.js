/**
 * MF-550 WebAR assembly instructions — application bootstrap.
 *
 * Data flow (single direction, so 3D, BOM, step card and voice always agree):
 *
 *   buttons · keys · AR overlay · right-hand gestures
 *        └─► App.next() / App.prev()  (one navigation path for every input)
 *              └─► Sequencer.pos ──► ExplodeController (positions, ×CONFIG.explodeScale)
 *                        │        ──► Appearance (active / ghost / selected materials)
 *                        │        ──► BomPanel, step card, progress bar, callout, AR overlay
 *                        │        ──► Narrator (stop previous, speak this step once)
 *                        └── step loop: the current step's motion repeats until the user moves on
 *   Selection ──────────────────────► Appearance, BomPanel, Details, callout
 *   AppState mirrors position / animating / narration / muted / voice / selection / gesture.
 *
 * Navigation is manual only — nothing (animation loop, narration end) advances a step.
 */
import * as THREE from 'three';
import { loadAssembly } from './data/AssemblyModel.js';
import { Viewer } from './scene/Viewer.js';
import { loadModel } from './scene/ModelLoader.js';
import { Appearance, STATE } from './scene/Appearance.js';
import { ExplodeController } from './scene/Explode.js';
import { CameraController } from './scene/CameraController.js';
import { Sequencer, ASSEMBLED, EXPLODED } from './scene/Sequencer.js';
import { Picker } from './scene/Picker.js';
import { Callout } from './scene/Callout.js';
import { BomPanel } from './ui/BomPanel.js';
import { Details } from './ui/Details.js';
import { NarrationControls } from './ui/NarrationControls.js';
import { positionText, esc, displayName } from './ui/text.js';
import { detectAR, arErrorText } from './ar/ARSupport.js';
import { CameraOverlay } from './ar/CameraOverlay.js';
import { WebXRSession } from './ar/WebXRSession.js';
import { QuickLook } from './ar/QuickLook.js';
import { Narrator } from './audio/Narrator.js';
import { narrationText } from './audio/narrationScript.js';
import { AppState } from './state/AppState.js';
import { GestureController } from './gesture/GestureController.js';
import { GesturePanel } from './ui/GesturePanel.js';
import { CONFIG } from './config.js';

const $ = (id) => document.getElementById(id);

class App {
  constructor() {
    this.opts = { ghost: true, edges: true, focus: true, isolate: false };
    this.selection = null;
    this.inAR = false;
    this.state = new AppState({
      position: ASSEMBLED, animating: false, narration: 'idle', muted: false, voice: null, selection: null,
      gesture: 'off', lastNavigation: null,
    });
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
    this.explode = new ExplodeController(model, loaded.objects, CONFIG.explodeScale);
    this.seq = new Sequencer(model, this.explode, { loop: CONFIG.animation.loop, timing: CONFIG.animation.timing });
    model.meta.displayName = CONFIG.productName;          // visible product name (internal id stays meta.product)
    model.root.label = CONFIG.productName;
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
    // automatic close-up of each step's components (scene/CameraController.js)
    this.cameraCtl = new CameraController({
      viewer, model, loaded, explode: this.explode, cfg: CONFIG.camera,
      isSolid: (id, pos) => this.#isSolid(id, pos),
    });
    viewer.controls.addEventListener('start', () => {   // user orbit / zoom / pan
      viewer.cancelCameraTween();
      this.cameraCtl.pauseByUser();
    });

    this.#initHeader();
    this.#initPanels();
    this.#initTransport();
    this.#initViewportInput();
    this.#initKeyboard();
    this.#initNarration();
    this.#initGestures();

    this.seq.addEventListener('change', () => this.#onPosition());
    this.seq.addEventListener('animstate', () => this.state.set({ animating: this.seq.animating }));
    this.state.addEventListener('change', () => this.#renderNavigation());
    this.#trackInsets();

    this.#initCameraUI();
    const startStep = this.#deepLinkStep();
    this.seq.goTo(ASSEMBLED, { animate: false });
    if (startStep !== null) this.seq.goTo(startStep);

    // CAD edges are built after the first frame so the model appears quickly
    setTimeout(() => {
      this.appearance.buildEdges();
      this.appearance.setEdgesVisible(this.opts.edges);
    }, 60);

    this.#loader('Ready', 1);
    setTimeout(() => $('loader').classList.add('is-done'), 150);
    this.#initAR();
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
    $('product-title').textContent = CONFIG.productName;
    document.title = `${CONFIG.productName} · Interactive Assembly Instructions`;
    $('meta-chips').innerHTML = [
      `<span class="chip"><b>${m.partInstances}</b> part instances</span>`,
      `<span class="chip"><b>${this.model.bom.length}</b> BOM lines</span>`,
      `<span class="chip"><b>${this.model.stepCount}</b> steps</span>`,
    ].join('');
    $('btn-help').addEventListener('click', () => $('help-dialog').showModal());
    const note = `Data source: the product's STEP CAD model, converted with ${m.converter}. The STEP file contains geometry, colours, component names and the hierarchy (encoded in body names). `
      + `It does not contain ${m.unavailable.join(', ')}; these are shown as "Not in STEP file"${m.bomSource ? ` unless supplied by the BOM export ${m.bomSource}` : ''}. The assembly order is ${m.sequenceSource}.`;
    $('help-data-note').textContent = note;
    $('sidebar-foot').textContent = `${m.partInstances} instances · ${m.uniqueMeshes} unique meshes · order derived from geometry (STEP has no assembly sequence)`;
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
    tool('tool-focus', 'focus');
    tool('tool-isolate', 'isolate');
    $('tool-frame').addEventListener('click', () => { this.cameraCtl.pauseByUser(); this.viewer.frame(); });
  }

  #setOpt(name, value) {
    this.opts[name] = value;
    const map = { ghost: 'tool-ghost', edges: 'tool-edges', focus: 'tool-focus', isolate: 'tool-isolate' };
    const b = $(map[name]);
    b.classList.toggle('is-on', value);
    b.setAttribute('aria-pressed', value);
    if (name === 'edges') this.appearance.setEdgesVisible(value);
    if (name === 'focus' && this.cameraCtl) {
      this.cameraCtl.setEnabled(value);
      try { localStorage.setItem('mf550.camera.auto', JSON.stringify(value)); } catch { /* storage unavailable */ }
    }
    if (name === 'ghost' && this.cameraCtl) this.cameraCtl.invalidate();   // sight lines depend on ghosting
    if (name === 'isolate') $('details-isolate').textContent = value ? 'Show all' : 'Isolate';
    this.#refreshAppearance();
  }

  // ------------------------------------------------------------- transport
  #initTransport() {
    const N = this.model.stepCount;
    const ticks = [];
    for (let k = 0; k < N; k++) {
      const s = this.model.steps[k];
      const left = ((k + 2) / (N + 1)) * 100;
      ticks.push(`<i data-k="${k}" class="${s.kind === 'base' || s.assembly === this.model.rootId ? '' : 'sub'}" style="left:${left}%"></i>`);
    }
    $('progress-ticks').innerHTML = ticks.join('');
    this.tickEls = [...$('progress-ticks').children];

    $('btn-next').addEventListener('click', () => this.next('button'));
    $('btn-prev').addEventListener('click', () => this.prev('button'));
    $('btn-restart').addEventListener('click', () => { this.seq.restart(); });
    $('btn-explode').addEventListener('click', () => this.#toggleExplode());
    $('speed').addEventListener('change', (e) => { this.seq.speed = parseFloat(e.target.value); });

    const prog = $('progress');
    const seek = (clientX) => {
      const r = prog.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
      this.seq.goTo(Math.round(frac * (N + 1)) - 2);
    };
    prog.addEventListener('click', (e) => seek(e.clientX));
    prog.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') { this.next('key'); e.preventDefault(); }
      if (e.key === 'ArrowLeft') { this.prev('key'); e.preventDefault(); }
    });
  }

  // ----------------------------------------------------- central navigation
  /**
   * The one NEXT / PREVIOUS used by the buttons, the keyboard, the AR overlay and the
   * hand gestures. Sequencer.goTo() replaces the running animation; the resulting
   * 'change' stops the previous narration, updates card / BOM / progress and starts
   * the new narration and the new step loop (#onPosition).
   */
  next(source = 'button') { return this.#navigate(1, source); }
  prev(source = 'button') { return this.#navigate(-1, source); }

  #navigate(dir, source) {
    const ok = dir > 0 ? this.seq.canNext : this.seq.canPrev;
    if (ok) {
      if (dir > 0) this.seq.next(); else this.seq.prev();
    }
    this.state.set({ lastNavigation: { dir, source, ok, pos: this.seq.pos, t: Date.now() } });
    return ok;
  }

  // ------------------------------------------------------------- gestures
  #initGestures() {
    const store = 'mf550.gestures.';
    const prefs = {
      get: (k, d) => { try { const v = localStorage.getItem(store + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
      set: (k, v) => { try { localStorage.setItem(store + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
    };
    // window.__MF550_TEST_TRACKER__ (set before load) replaces MediaPipe in automated tests only
    this.gestures = new GestureController(CONFIG.gestures, {
      video: $('gesture-video'),
      createTracker: window.__MF550_TEST_TRACKER__,
    });
    this.gesturePanel = new GesturePanel({
      controller: this.gestures,
      prefs,
      els: {
        panel: $('gesture-panel'), open: $('btn-gestures'), close: $('gp-close'), toggle: $('gp-toggle'),
        preview: $('gp-preview'), canvas: $('gp-canvas'), video: $('gesture-video'), home: $('viewport'),
        camera: $('gp-camera'), hand: $('gp-hand'), gesture: $('gp-gesture'),
        meter: $('gp-meter'), meterFill: $('gp-meter-fill'), msg: $('gp-msg'),
        showPreview: $('gp-show-preview'), swap: $('gp-swap'),
        chip: $('gesture-chip'), chipText: $('gesture-chip-text'), toast: $('gesture-toast'),
      },
    });
    this.gestures.addEventListener('trigger', (e) => {
      const up = e.detail.gesture === 'up';
      const ok = up ? this.next('gesture') : this.prev('gesture');
      this.gesturePanel.feedback(e.detail.gesture, ok);
    });
    this.gestures.addEventListener('status', (e) => this.state.set({ gesture: e.detail.phase }));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.gestures.suspend('hidden'); else this.gestures.resume('hidden');
    });
    window.addEventListener('pagehide', () => this.gestures.dispose());
  }

  #toggleExplode() {
    this.seq.goTo(this.seq.pos === EXPLODED ? ASSEMBLED : EXPLODED);
  }

  /** Keep the model framed beside (desktop) or below (phone) the step card. */
  #trackInsets() {
    let raf = 0;
    const update = () => {
      raf = 0;
      if (this.inAR) return;
      const vp = $('viewport').getBoundingClientRect();
      const c = $('step-card').getBoundingClientRect();
      if (!vp.width || !c.width) return;
      const beside = c.width < vp.width * 0.6;
      this.viewer.setInsets(beside
        ? { left: c.right - vp.left + 8, top: 0 }
        : { left: 0, top: Math.round((c.bottom - vp.top + 8) / 24) * 24 });   // quantised: no jitter per step
    };
    const ro = new ResizeObserver(() => { if (!raf) raf = requestAnimationFrame(update); });
    ro.observe($('viewport'));
    ro.observe($('step-card'));
    update();
  }

  /** Enable/disable PREVIOUS / NEXT (step card, transport and AR overlay) from the state. */
  #renderNavigation() {
    const { seq } = this;
    for (const id of ['btn-prev', 'ar-prev']) $(id).disabled = !seq.canPrev;
    for (const id of ['btn-next', 'ar-next']) $(id).disabled = !seq.canNext;
    const N = this.model.stepCount;
    $('btn-next').setAttribute('aria-label', seq.canNext
      ? `Next step (${seq.isStep ? `step ${seq.pos + 2} of ${N}` : seq.pos === ASSEMBLED ? 'parts kit' : `step 1 of ${N}`})`
      : 'Next step (final step reached)');
    $('btn-prev').setAttribute('aria-label', seq.canPrev ? 'Previous step' : 'Previous step (first position)');
  }

  // -------------------------------------------------------------- narration
  #initNarration() {
    this.narrator = new Narrator(CONFIG.narration);
    let lastVoice = null;
    const sync = (d) => {
      const v = d.voice;
      if (!v) lastVoice = null;
      else if (!lastVoice || lastVoice.name !== v.name) lastVoice = v;
      this.state.set({ narration: d.status, muted: d.muted, voice: lastVoice });
    };
    this.narrator.addEventListener('state', (e) => sync(e.detail));
    sync({ status: this.narrator.status, muted: this.narrator.muted, voice: null });
    this.narrationControls = new NarrationControls({
      narrator: this.narrator,
      state: this.state,
      rates: CONFIG.narration.rates,
      isLastStep: () => this.seq.pos === this.seq.last,
      onReplay: () => this.seq.replay(),
      els: {
        root: $('narration'), play: $('nar-play'), playLabel: $('nar-play-label'), replay: $('nar-replay'),
        mute: $('nar-mute'), muteLabel: $('nar-mute-label'), status: $('nar-status'), settings: $('nar-settings'),
        pop: $('nar-pop'), voiceSel: $('nar-voice'), rateSel: $('nar-rate'), voiceKind: $('nar-voice-kind'),
        arVoice: $('ar-voice'), arMute: $('ar-mute'),
      },
    });
  }

  /** Stop the previous narration at once; start this position's script after a short debounce. */
  #narrate(pos) {
    clearTimeout(this.narrationTimer);
    this.narrator.stop();
    this.narrationTimer = setTimeout(() => {
      if (this.seq.pos !== pos) return;            // user moved on in the meantime
      this.narrator.load(pos, narrationText(this.model, pos));
    }, CONFIG.narration.startDelayMs);
  }

  // ------------------------------------------------------- position change
  #onPosition() {
    const { seq, model } = this;
    const pos = seq.pos;
    const N = model.stepCount;
    this.cameraCtl.onPosition(pos);            // close-up of this step's components (smooth move)
    const t = positionText(model, pos);

    $('step-badge').textContent = t.badge;
    $('step-kind').textContent = t.kind;
    $('step-title').innerHTML = t.title;
    $('step-desc').textContent = t.desc;
    const comps = $('step-components');
    comps.hidden = !t.components;
    comps.innerHTML = t.components || '';
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
    $('progress-label').textContent = seq.isStep ? `Step ${pos + 1} / ${N}` : pos === ASSEMBLED ? `Overview · 0 / ${N}` : `Parts kit · 0 / ${N}`;
    const where = seq.isStep ? ` · in ${displayName(model.node(model.steps[pos].assembly))}` : '';
    $('progress-sub').textContent = `${pos === ASSEMBLED ? model.meta.partInstances : installed} / ${model.meta.partInstances} parts placed${where}`;
    $('progress').setAttribute('aria-valuenow', String(pos + 2));
    $('progress').setAttribute('aria-valuetext', $('progress-label').textContent);
    const exploded = pos === EXPLODED;
    $('btn-explode').setAttribute('aria-pressed', exploded);
    $('ar-explode').classList.toggle('is-on', exploded);

    this.#syncStepCallout();

    const hash = seq.isStep ? `#step=${pos + 1}` : '';
    if (location.hash !== hash) history.replaceState(null, '', location.pathname + location.search + hash);
    this.state.set({ position: pos });
    this.#renderNavigation();
    this.#updateAROverlay();
    this.#narrate(pos);
  }

  /** Step balloon; hidden when the selection balloon already points at the same BOM item. */
  #syncStepCallout() {
    const { seq, model } = this;
    if (!seq.isStep) { this.stepCallout.hide(); return; }
    const s = model.steps[seq.pos];
    if (this.selection && this.selection.row.item === s.item) { this.stepCallout.hide(); return; }
    this.stepCallout.set(s.nodes.map((id) => this.loaded.objects.get(id)), null, `${s.qty > 1 ? s.qty + '× ' : ''}${displayName(model.node(s.nodes[0]).kind === 'assembly' ? model.node(s.nodes[0]) : s)}`);
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

  /** Is a part drawn opaque at a position? (mirrors #refreshAppearance; used for camera sight lines) */
  #isSolid(id, pos) {
    if (!this.opts.ghost || pos < 0 || pos >= this.model.stepCount) return true;
    if (this.activeParts[pos].has(id)) return true;
    const context = this.stepContext[pos];
    const s = this.model.node(id).effectiveStep;
    return !((context && !context.has(id)) || (s !== null && s > pos));
  }

  /** Auto camera toggle (tool-focus), the "paused" chip with Refocus, and the C key. */
  #initCameraUI() {
    let auto = true;
    try { const v = localStorage.getItem('mf550.camera.auto'); if (v !== null) auto = JSON.parse(v) !== false; } catch { /* default */ }
    if (!auto) this.#setOpt('focus', false);
    const chip = $('cam-chip');
    const render = () => {
      const mode = this.cameraCtl.mode;
      chip.hidden = mode !== 'paused';
      $('tool-focus').classList.toggle('is-paused', mode === 'paused');
      $('tool-focus').title = mode === 'off' ? 'Automatic camera: off (click to turn on)'
        : mode === 'paused' ? 'Automatic camera: paused because you moved the view'
          : 'Automatic camera: follows each step (click to turn off)';
      this.state.set({ camera: mode });
    };
    this.cameraCtl.addEventListener('state', render);
    $('cam-refocus').addEventListener('click', () => this.cameraCtl.refocus());
    render();
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
      this.state.set({ selection: null });
      if (this.opts.isolate) this.#setOpt('isolate', false);
      this.#syncStepCallout();
      this.#refreshAppearance();
      this.#updateAROverlay();
      return;
    }
    const nodeIds = sel.nodeIds ?? (sel.partId ? [sel.partId] : sel.row.nodes);
    const partSet = new Set(nodeIds.flatMap((id) => m.partsUnder(id)));
    this.selection = { ...sel, nodeIds, partSet };
    this.state.set({ selection: sel.row.item });
    this.details.show(this.selection);          // first: it changes the BOM panel height
    this.bom.setSelected(sel.row.item);
    this.selCallout.set(nodeIds.map((id) => this.loaded.objects.get(id)), null, displayName(sel.row));
    this.#syncStepCallout();
    this.#refreshAppearance();
    this.#updateAROverlay();
    if (window.matchMedia('(max-width: 860px)').matches && !this.inAR) $('sidebar').classList.add('is-open');
  }

  #zoomToSelection() {
    if (!this.selection) return;
    this.cameraCtl.pauseByUser();
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
      if (k === ' ') { this.narrator.toggle(); e.preventDefault(); }
      else if (k === 'ArrowRight' || k === 'PageDown') { this.next('key'); e.preventDefault(); }
      else if (k === 'ArrowLeft' || k === 'PageUp') { this.prev('key'); e.preventDefault(); }
      else if (k === 'm' || k === 'M') this.narrator.setMuted(!this.narrator.muted);
      else if (k === 'p' || k === 'P') this.seq.replay();
      else if (k === 'e' || k === 'E') this.#toggleExplode();
      else if (k === 'r' || k === 'R') this.seq.restart();
      else if (k === 'f' || k === 'F') { this.cameraCtl.pauseByUser(); this.viewer.frame(); }
      else if (k === 'c' || k === 'C') this.cameraCtl.refocus();
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
    btn.addEventListener('click', () => this.#onARButton());
    const slug = CONFIG.productName.replace(/\s+/g, '-');
    this.quickLook = new QuickLook({
      viewer: this.viewer, appearance: this.appearance, model: this.model, explode: this.explode,
      fileName: `${slug}-assembly.usdz`,
      staticUrl: `${CONFIG.modelDir}${this.model.meta.product}-assembly.usdz`,   // optional pre-built file (internal name)
    });
    // fallback without immersive AR: the camera picture behind the 3D view (not AR)
    this.cameraView = new CameraOverlay({ container: $('viewport'), video: $('overlay-video') });
    this.cameraView.addEventListener('state', (e) => {
      const on = e.detail.active;
      $('overlay-banner').hidden = !on;
      if (!on) this.gestures.resume('overlay');
      if (e.detail.error) this.#toast(e.detail.error.name === 'NotAllowedError'
        ? 'Camera permission denied: the camera overlay needs the camera. The 3D viewer keeps working.'
        : `Camera overlay unavailable: ${e.detail.error.message || e.detail.error.name}`);
      this.#renderARButton();
    });
    $('overlay-exit').addEventListener('click', () => this.cameraView.stop());
    window.addEventListener('pagehide', () => this.cameraView.stop());
    this.#renderARButton();
    this.#bindAROverlay();
  }

  /** AR button: state dot + label + tooltip from the capability check (never claims AR it cannot start). */
  #renderARButton() {
    const btn = $('btn-ar');
    const caps = this.arCaps;
    if (!caps) return;
    const state = this.inAR ? 'active' : this.cameraView && this.cameraView.active ? 'overlay' : caps.state;
    btn.dataset.ar = state;
    const label = {
      active: 'AR active', overlay: 'Exit camera view', supported: 'View in AR',
      'needs-permission': 'AR: allow camera', unavailable: 'AR options',
    }[state] || 'View in AR';
    $('btn-ar-label').textContent = label;
    btn.title = state === 'overlay' ? 'Close the camera overlay (not AR)' : caps.reason;
    btn.setAttribute('aria-label', `${label}. ${caps.reason}`);
    this.state.set({ ar: state });
  }

  async #onARButton() {
    if (this.cameraView.active) { this.cameraView.stop(); return; }
    // start at once while the click still counts as a user gesture (required by requestSession)
    if (this.arCaps.mode === 'webxr' && this.arCaps.state === 'supported') { this.#startWebXR(); return; }
    this.arCaps = await detectAR();            // permissions may have changed since the page loaded
    this.#renderARButton();
    this.#openARDialog();
  }

  async #startCameraView() {
    $('ar-dialog').close();
    this.gestures.suspend('overlay');          // one camera user at a time
    try { await this.cameraView.start(); } catch { /* reported through the 'state' event */ }
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
          this.cameraCtl.setAR(true);
          this.#renderARButton();
          this.gestures.suspend('ar');        // WebXR owns the camera during the session
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
          this.cameraCtl.setAR(false);
          this.#renderARButton();
          this.gestures.resume('ar');
          $('viewport').prepend($('callout-layer'));
          if (this.edgesBeforeAR) this.#setOpt('edges', true);
          setTimeout(() => {
            if (this.cameraCtl.mode === 'auto') this.cameraCtl.focus(this.seq.pos, { instant: true });
            else this.viewer.frame(undefined, false);
          }, 50);
        },
        onScale: (s) => {
          const r = Math.abs(s - 1) < 0.01 ? '1:1' : s < 1 ? `1:${(1 / s).toFixed(1)}` : `${s.toFixed(1)}:1`;
          $('ar-scale').textContent = `Scale ${r}`;
          $('ar-scale-toggle').textContent = r;
        },
      });
    }
    // release the gesture camera / camera overlay before ARCore opens the camera (one camera user at a time)
    if (this.cameraView && this.cameraView.active) this.cameraView.stop();
    this.gestures.suspend('ar');
    try {
      await this.xr.start();
      this.xr.onScale(this.xr.scale);
    } catch (err) {
      this.gestures.resume('ar');
      console.error(err);
      if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) this.arCaps.state = 'needs-permission';
      this.arCaps.reason = arErrorText(err, this.arCaps.browser.name);
      this.#renderARButton();
      this.#toast(this.arCaps.reason);
    }
  }

  #bindAROverlay() {
    const ov = $('ar-overlay');
    $('ar-exit').addEventListener('click', () => this.xr && this.xr.end());
    $('ar-reposition').addEventListener('click', () => {
      this.xr && this.xr.reposition();
      $('ar-hint').hidden = false;
    });
    $('ar-prev').addEventListener('click', () => this.prev('ar'));
    $('ar-next').addEventListener('click', () => this.next('ar'));
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
      selEl.innerHTML = `<b>${esc(displayName(r))}</b>${r.partNumber && r.label ? ` (${esc(r.partNumber)})` : ''} · qty ${r.qty}${r.steps.length ? ' · step ' + r.steps.map((s) => s + 1).join(', ') : ''}${inst ? `<br>Instance ${esc(inst.cad)}` : ''}`;
      selEl.hidden = false;
    } else {
      selEl.hidden = true;
    }
  }

  #openARDialog() {
    const caps = this.arCaps;
    const body = $('ar-dialog-body');
    const li = (ok, text) => `<li class="${ok ? 'yes' : 'no'}"><span class="dot"></span><span>${text}</span></li>`;
    const pos = this.seq.pos;
    const posName = this.seq.isStep ? `step ${pos + 1}` : pos === ASSEMBLED ? 'the overview' : 'the parts kit';
    const slug = CONFIG.productName.replace(/\s+/g, '-');
    const stepFile = `${slug}-${this.seq.isStep ? `step-${pos + 1}` : 'overview'}.usdz`;
    const status = (t) => { $('ql-status').textContent = t; };
    const stateText = {
      supported: 'AR available', 'needs-permission': 'AR needs permission', unavailable: 'Immersive AR not available here',
    }[caps.state];
    const head = `<p class="ar-state" data-ar="${caps.state}"><b>${stateText}.</b>${esc(caps.reason)}</p>`;
    const overlayBtn = caps.overlay
      ? '<button type="button" class="btn" id="ar-overlay-start" title="Camera picture behind the 3D model — no tracking">Camera overlay (not AR)</button>' : '';
    /** Two-tap flow: Safari only opens Quick Look from a tap, so generate first, then open. */
    const wire = (btnId, opts, openLabel, fileName, download) => {
      const b = $(btnId);
      b.onclick = async () => {
        if (b.dataset.url) {
          if (download) { const a = document.createElement('a'); a.href = b.dataset.url; a.download = fileName; a.click(); }
          else this.quickLook.open(b.dataset.url, fileName);
          return;
        }
        b.disabled = true;
        try {
          const url = await this.quickLook.prepare(status, opts);
          b.dataset.url = url;
          status(`Ready (${(this.quickLook.size / 1e6).toFixed(1)} MB USDZ). Tap "${openLabel}".`);
          b.textContent = openLabel;
        } catch (err) { status(`USDZ export failed: ${err.message}`); }
        b.disabled = false;
      };
    };
    const bindOverlay = () => { const o = $('ar-overlay-start'); if (o) o.onclick = () => this.#startCameraView(); };

    if (caps.mode === 'quicklook') {
      body.innerHTML = `${head}
        <p>Safari on iOS/iPadOS has no WebXR, so the model is exported to a USDZ file in your browser, with the same ${CONFIG.explodeScale}× exploded view as this page.</p>
        <p>Quick Look is a separate viewer: it cannot show the BOM, the narration or the step buttons. Use <b>${posName}</b> to stay in step-by-step mode, then come back here and press NEXT STEP.</p>
        <p class="muted" id="ql-status">Choose what to place in your room.</p>
        <div class="ar-dialog-actions">
          <button type="button" class="btn btn-accent" id="ql-step">Prepare ${posName}</button>
          <button type="button" class="btn" id="ql-full">Prepare full sequence</button>
        </div>`;
      $('ar-dialog').showModal();
      wire('ql-step', { kind: 'step', pos }, `Open ${posName} in AR`, stepFile);
      wire('ql-full', { kind: 'full' }, 'Open full sequence in AR', `${slug}-assembly.usdz`);
      return;
    }
    if (caps.mode === 'webxr') {     // supported but blocked: explain, let the user retry after allowing the camera
      body.innerHTML = `${head}
        <p>AR in ${esc(caps.browser.name)} uses the camera to find the floor. When ${esc(caps.browser.name)} asks, choose <b>Allow</b>. If you blocked it before, open the site settings (lock icon next to the address) › Camera › Allow, then try again.</p>
        <div class="ar-dialog-actions">
          <button type="button" class="btn btn-accent" id="ar-retry">Try AR again</button>
          ${overlayBtn}
        </div>`;
      $('ar-dialog').showModal();
      $('ar-retry').onclick = () => { $('ar-dialog').close(); this.#startWebXR(); };
      bindOverlay();
      return;
    }
    body.innerHTML = `${head}
      <p>The 3D viewer, automatic camera, exploded view, steps, narration, gestures and BOM all work here. For real AR open this page on:</p>
      <ul class="ar-support">
        ${li(true, 'Android phone / tablet with ARCore — <b>Chrome</b> (WebXR: place the assembly on the floor at 1:1)')}
        ${li(true, 'iPhone / iPad — Safari (AR Quick Look)')}
      </ul>
      ${caps.overlay ? '<p><b>Camera overlay (not AR):</b> shows the 3D model over this device\'s camera picture. It is not anchored to the room and does not track movement.</p>' : ''}
      <p>Checks for this browser:</p>
      <ul class="ar-support">
        ${li(caps.secureContext, 'Secure context (HTTPS)')}
        ${li(caps.webxrApi, 'WebXR Device API')}
        ${li(caps.immersiveAR, 'immersive-ar sessions (AR tracking)')}
        ${li(caps.quickLook, 'AR Quick Look')}
        ${li(caps.overlay, 'Camera access API (for the camera overlay)')}
      </ul>
      <div class="url-box">${esc(location.href)}</div>
      <div class="ar-dialog-actions">
        ${overlayBtn}
        <button type="button" class="btn" id="ar-copy">Copy link</button>
        <button type="button" class="btn" id="ar-usdz-step">USDZ of ${posName}</button>
        <button type="button" class="btn" id="ar-usdz">USDZ full sequence</button>
      </div>
      <p class="muted" id="ql-status"></p>`;
    $('ar-dialog').showModal();
    bindOverlay();
    $('ar-copy').onclick = () => navigator.clipboard?.writeText(location.href).then(() => this.#toast('Link copied'));
    wire('ar-usdz-step', { kind: 'step', pos }, 'Download', stepFile, true);
    wire('ar-usdz', { kind: 'full' }, 'Download', `${slug}-assembly.usdz`, true);
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
