/**
 * Sequencer — the single source of truth for "where are we in the instructions".
 *
 * Positions (navigation track):
 *   ASSEMBLED (-2)  overview: complete product, CAD positions        ← first position
 *   EXPLODED  (-1)  parts kit: every component at its exploded position
 *   0 … N-1         assembly steps from assembly.json                 ← N-1 is the final step
 *
 * Navigation is strictly manual (v1.1): the sequencer never advances on its own.
 * next()/prev()/goTo() are the only ways to change the position; the end of an
 * animation or of the narration only emits 'idle'.
 *
 * The exploded factor of every component is a pure function of the position,
 * so the BOM highlight, the step card and the 3D state can never drift apart:
 *   step k → components of steps < k assembled, step k animating, steps > k exploded.
 *
 * Events: 'change' (position), 'stepstart' (position reached, camera may frame),
 *         'animstate' (this.animating changed), 'idle'.
 */
export const ASSEMBLED = -2;
export const EXPLODED = -1;

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export class Sequencer extends EventTarget {
  constructor(model, explode, opts = {}) {
    super();
    this.model = model;
    this.explode = explode;
    this.N = model.stepCount;
    this.pos = ASSEMBLED;
    this.speed = 1;
    this.animating = false;
    this.timing = { quick: 0.45, step: 1.6, dwell: 0.4, explode: 2.6, collapse: 1.4, ...opts.timing };
    this.queue = [];
  }

  get first() { return ASSEMBLED; }
  get last() { return this.N - 1; }
  get isStep() { return this.pos >= 0 && this.pos < this.N; }
  get isIdle() { return this.queue.length === 0; }
  get canPrev() { return this.pos > this.first; }
  get canNext() { return this.pos < this.last; }

  /** Target factor of an explode entry for a given position (end of that position). */
  #target(pos, step) {
    if (pos === EXPLODED) return 1;
    if (pos === ASSEMBLED || pos >= this.N) return 0;
    if (step === null || step === undefined) return 0;
    return step < pos ? 0 : 1;
  }

  #transition(targetFn, { dur, delayFn, durFn } = {}) {
    const { entries, f } = this.explode;
    const items = [];
    let total = 0;
    for (let i = 0; i < entries.length; i++) {
      const to = targetFn(entries[i], i);
      if (Math.abs(to - f[i]) < 1e-4) continue;
      const delay = delayFn ? delayFn(entries[i]) : 0;
      const d = durFn ? durFn(entries[i]) : dur;
      items.push({ i, from: f[i], to, delay, dur: d });
      total = Math.max(total, delay + d);
    }
    return { kind: 'anim', items, t: 0, total };
  }

  #setAnimating(v) {
    if (this.animating === v) return;
    this.animating = v;
    this.#emit('animstate');
  }

  /**
   * Jump to a position and animate into it. Any running animation is replaced
   * (never queued), so rapid navigation cannot overlap animations.
   */
  goTo(pos, { animate = true } = {}) {
    pos = Math.max(this.first, Math.min(this.last, Math.round(pos)));
    this.pos = pos;
    this.queue = [];
    const T = this.timing;
    const { entries, f } = this.explode;

    if (!animate) {
      for (let i = 0; i < entries.length; i++) {
        f[i] = this.isStep && entries[i].step === pos ? 0 : this.#target(pos, entries[i].step);
      }
      this.explode.apply();
      this.#setAnimating(false);
      this.#emit('change');
      this.#emit('stepstart');
      return;
    }

    if (pos === EXPLODED) {
      // reverse-order cascade: the last components installed leave first
      const N = Math.max(1, this.N);
      this.queue.push(this.#transition(() => 1, {
        delayFn: (e) => (e.step === null ? 0 : (1 - e.step / N) * (T.explode - 0.9)),
        durFn: () => 0.9,
      }));
      this.queue.push({ kind: 'dwell', t: 0, total: T.dwell, onStart: () => this.#emit('stepstart') });
    } else if (pos === ASSEMBLED) {
      this.queue.push(this.#transition(() => 0, { dur: T.collapse }));
      this.queue.push({ kind: 'dwell', t: 0, total: T.dwell, onStart: () => this.#emit('stepstart') });
    } else {
      // 1) bring every other component to its state for this step (quick)
      this.queue.push(this.#transition((e) => (e.step === pos ? 1 : this.#target(pos, e.step)), { dur: T.quick }));
      // 2) animate this step's components from exploded to CAD position
      this.queue.push({ kind: 'mark', onStart: () => this.#emit('stepstart') });
      this.queue.push(this.#transition((e) => (e.step === pos ? 0 : this.#target(pos, e.step)), { dur: T.step }));
      // 3) settle
      this.queue.push({ kind: 'dwell', t: 0, total: T.dwell });
    }
    this.#setAnimating(true);
    this.#emit('change');
  }

  next() { if (this.canNext) this.goTo(this.pos + 1); return this.canNext; }
  prev() { if (this.canPrev) this.goTo(this.pos - 1); return this.canPrev; }
  restart() { this.goTo(ASSEMBLED); }
  /** Re-run the animation of the current position (and re-emit 'change'). */
  replay() { this.goTo(this.pos); }

  /** Advance the timeline; leftover time flows into the next phase (frame-rate independent). */
  update(dt) {
    let budget = dt * this.speed;
    let guard = 0;
    while (this.queue.length && guard++ < 64) {
      const ph = this.queue[0];
      if (!ph.started) { ph.started = true; ph.onStart && ph.onStart(); }
      if (ph.kind === 'mark') { this.queue.shift(); continue; }
      const use = Math.min(budget, ph.total - ph.t);
      ph.t += use;
      budget -= use;
      if (ph.kind === 'anim') {
        const { f } = this.explode;
        for (const it of ph.items) {
          const u = Math.min(1, Math.max(0, (ph.t - it.delay) / it.dur));
          f[it.i] = it.from + (it.to - it.from) * ease(u);
        }
        this.explode.apply();
      }
      if (ph.t < ph.total - 1e-9) break;           // phase still running: frame budget spent
      this.queue.shift();
      if (this.queue.length === 0) {
        this.#setAnimating(false);
        this.#emit('idle');                       // never advances: navigation is manual
        break;
      }
    }
  }

  /** Fraction 0..1 of the navigation track (overview … final step). */
  progress() {
    return (this.pos - this.first) / (this.last - this.first);
  }

  #emit(type) { this.dispatchEvent(new Event(type)); }
}
