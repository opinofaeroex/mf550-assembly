/**
 * Sequencer — the single source of truth for "where are we in the instructions".
 *
 * Positions:
 *   ASSEMBLED (-2)  complete product, CAD positions
 *   EXPLODED  (-1)  parts kit: every component at its exploded position
 *   0 … N-1         assembly steps from assembly.json
 *   N               completed product
 *
 * The exploded factor of every component is a pure function of the position,
 * so the BOM highlight, the step card and the 3D state can never drift apart:
 *   step k → components of steps < k assembled, step k animating, steps > k exploded.
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
    this.playing = false;
    this.frozen = false;
    this.speed = 1;
    this.timing = { quick: 0.45, step: 1.6, dwell: 1.3, explode: 2.6, collapse: 1.4, ...opts.timing };
    this.queue = [];
  }

  get isStep() { return this.pos >= 0 && this.pos < this.N; }
  get isIdle() { return this.queue.length === 0; }

  /** Target factor of an explode entry for a given position (end of that position). */
  #target(pos, step) {
    if (pos === EXPLODED) return 1;
    if (pos === ASSEMBLED || pos >= this.N) return 0;
    if (step === null || step === undefined) return 0;
    return step < pos ? 0 : (step === pos ? 1 : 1);
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

  /** Jump to a position and animate into it. */
  goTo(pos, { animate = true } = {}) {
    pos = Math.max(ASSEMBLED, Math.min(this.N, Math.round(pos)));
    this.pos = pos;
    this.frozen = false;
    this.queue = [];
    const T = this.timing;
    const { entries, f } = this.explode;

    if (!animate) {
      for (let i = 0; i < entries.length; i++) {
        f[i] = this.isStep && entries[i].step === pos ? 0 : this.#target(pos, entries[i].step);
      }
      this.explode.apply();
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
    } else if (pos === ASSEMBLED || pos === this.N) {
      this.queue.push(this.#transition(() => 0, { dur: T.collapse }));
      this.queue.push({ kind: 'dwell', t: 0, total: pos === this.N ? 0.6 : T.dwell, onStart: () => this.#emit('stepstart') });
    } else {
      // 1) bring every other component to its state for this step (quick)
      this.queue.push(this.#transition((e) => (e.step === pos ? 1 : this.#target(pos, e.step)), { dur: T.quick }));
      // 2) animate this step's components from exploded to CAD position
      this.queue.push({ kind: 'mark', onStart: () => this.#emit('stepstart') });
      this.queue.push(this.#transition((e) => (e.step === pos ? 0 : this.#target(pos, e.step)), { dur: T.step }));
      // 3) hold
      this.queue.push({ kind: 'dwell', t: 0, total: T.dwell });
    }
    this.#emit('change');
  }

  play() {
    if (this.pos >= this.N) this.goTo(ASSEMBLED);
    this.playing = true;
    this.frozen = false;
    if (this.isIdle) this.#advance();
    this.#emit('playstate');
  }

  pause() {
    this.playing = false;
    this.frozen = !this.isIdle;
    this.#emit('playstate');
  }

  toggle() { (this.playing ? this.pause() : this.play()); }
  next() { this.goTo(this.pos + 1); }
  prev() { this.goTo(this.pos - 1); }
  restart() { this.goTo(ASSEMBLED); }

  #advance() {
    if (this.pos >= this.N) {
      this.playing = false;
      this.#emit('playstate');
      this.#emit('ended');
      return;
    }
    this.goTo(this.pos + 1);
  }

  /** Advance the timeline; leftover time flows into the next phase (frame-rate independent). */
  update(dt) {
    if (this.frozen) return;
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
        this.#emit('idle');
        if (this.playing && !this.frozen) this.#advance();   // queues the next position
        if (budget <= 0) break;
      }
    }
  }

  /** Fraction 0..1 of the whole program (for the progress bar). */
  progress() {
    const span = this.N + 2;
    return (this.pos + 2) / span;
  }

  #emit(type) { this.dispatchEvent(new Event(type)); }
}
