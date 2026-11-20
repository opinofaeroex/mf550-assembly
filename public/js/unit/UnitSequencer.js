/**
 * UnitSequencer — navigation + timeline of the unit-installation tutorial (v2.0).
 *
 * Same interface and events as scene/Sequencer.js (so the step card, BOM, narration,
 * gestures, camera, AR overlay and benchmark work unchanged):
 *   positions  ASSEMBLED (-2) completed unit · EXPLODED (-1) components at their starting
 *              points · 0 … N-1 installation steps
 *   events     'change' · 'stepstart' · 'animstate' · 'idle' · 'loop'
 *
 * A step plays its timeline once (animating = true), then repeats it after a short hold for
 * as long as the operator stays on the step (looping). Navigation is manual only: the end of
 * a step never advances the sequence. Each repeat replays the SAME objects from their starting
 * poses — nothing is duplicated, and the end pose of every motion is the CAD position.
 */
import { ASSEMBLED, EXPLODED } from '../scene/Sequencer.js';

export class UnitSequencer extends EventTarget {
  constructor(model, rig, opts = {}) {
    super();
    this.model = model;
    this.rig = rig;
    this.N = model.stepCount;
    this.pos = ASSEMBLED;
    this.speed = 1;
    this.t = 0;
    this.hold = opts.hold ?? 1.6;
    this.loop = opts.loop !== false;
    this.animating = false;
    this.looping = false;
    this.loopCount = 0;
    this.queue = [];                    // kept for API compatibility (isIdle)
  }

  get first() { return ASSEMBLED; }
  get last() { return this.N - 1; }
  get isStep() { return this.pos >= 0 && this.pos < this.N; }
  get isIdle() { return !this.animating; }
  get canPrev() { return this.pos > this.first; }
  get canNext() { return this.pos < this.last; }
  get duration() { return this.isStep ? this.model.steps[this.pos].duration : 0; }

  goTo(pos, { animate = true } = {}) {
    pos = Math.max(this.first, Math.min(this.last, Math.round(pos)));
    this.pos = pos;
    this.looping = false;
    this.loopCount = 0;
    this.rig.setPosition(pos);
    this.t = this.isStep && !animate ? this.duration : 0;
    if (this.isStep) this.rig.apply(pos, this.t);
    this.#setAnimating(this.isStep && animate);
    this.#emit('change');
    this.#emit('stepstart');
    if (this.isStep && !animate) this.#emit('idle');
  }

  next() { if (this.canNext) this.goTo(this.pos + 1); return this.canNext; }
  prev() { if (this.canPrev) this.goTo(this.pos - 1); return this.canPrev; }
  restart() { this.goTo(ASSEMBLED); }
  replay() { this.goTo(this.pos); }

  update(dt) {
    if (!this.isStep) return;
    const dur = this.duration;
    this.t += dt * this.speed;
    if (this.t >= dur && this.animating) {
      this.#setAnimating(false);
      this.#emit('idle');                         // never advances: navigation is manual
    }
    if (this.loop && this.t >= dur + this.hold) {
      this.t = 0;                                 // repeat this step only, from the starting poses
      this.looping = true;
      this.loopCount++;
      this.#emit('loop');
    }
    this.rig.apply(this.pos, Math.min(this.t, dur));
  }

  progress() { return (this.pos - this.first) / (this.last - this.first); }

  #setAnimating(v) {
    if (this.animating === v) return;
    this.animating = v;
    this.#emit('animstate');
  }

  #emit(type) { this.dispatchEvent(new Event(type)); }
}

export { ASSEMBLED, EXPLODED };
