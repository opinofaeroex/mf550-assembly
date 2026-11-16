/**
 * GestureTrigger — turns per-frame gesture observations into single navigation events.
 *
 *   ready ──(same gesture for ≥ stableFrames AND ≥ minHoldMs)──► FIRE once ──► locked
 *   locked ──(neutral for ≥ neutralFrames AND cooldownMs elapsed)──► ready
 *
 * - "neutral" = no right hand in view, or a right hand that is not doing thumbs up/down;
 * - holding the gesture never fires again: the hand has to return to neutral first;
 * - a short drop-out while arming (≤ maxGapFrames frames) is tolerated, a different
 *   gesture restarts the count — a single frame can never trigger.
 * Pure and clock-agnostic (`t` in ms), so it is unit-tested without a camera.
 */
export const DEFAULT_TRIGGER = {
  stableFrames: 5,     // consecutive frames with the same gesture
  minHoldMs: 300,      // …held for at least this long
  cooldownMs: 1000,    // minimum time between two triggers
  neutralFrames: 4,    // neutral frames required before the next trigger
  maxGapFrames: 1,     // tolerated missing / neutral frames while arming
};

export class GestureTrigger {
  constructor(cfg = {}) {
    this.cfg = { ...DEFAULT_TRIGGER, ...cfg };
    this.reset();
  }

  reset() {
    this.state = 'ready';        // 'ready' | 'arming' | 'locked'
    this.candidate = null;
    this.count = 0;
    this.gap = 0;
    this.since = 0;
    this.neutral = 0;
    this.lockedAt = -Infinity;
    this.lastFired = null;
  }

  /**
   * @param {'up'|'down'|'none'|null} obs  gesture of the user's right hand this frame (null: no right hand)
   * @param {number} t  timestamp in ms
   * @returns {{fire: 'up'|'down'|null, state: string, candidate: string|null, progress: number}}
   */
  update(obs, t) {
    const c = this.cfg;
    const g = obs === 'up' || obs === 'down' ? obs : 'none';

    if (this.state === 'locked') {
      this.neutral = g === 'none' ? this.neutral + 1 : 0;
      if (this.neutral >= c.neutralFrames && t - this.lockedAt >= c.cooldownMs) {
        this.state = 'ready';
        this.candidate = null;
        this.count = 0;
      }
      return this.#out(null, 0);
    }

    if (g === 'none') {
      if (this.candidate && this.gap < c.maxGapFrames) { this.gap++; return this.#out(null, this.#progress(t)); }
      this.state = 'ready';
      this.candidate = null;
      this.count = 0;
      this.gap = 0;
      return this.#out(null, 0);
    }
    if (g !== this.candidate) {
      this.candidate = g;
      this.count = 1;
      this.since = t;
    } else {
      this.count++;
    }
    this.gap = 0;
    this.state = 'arming';
    if (this.count >= c.stableFrames && t - this.since >= c.minHoldMs) {
      this.state = 'locked';
      this.lockedAt = t;
      this.neutral = 0;
      this.lastFired = g;
      this.candidate = null;
      this.count = 0;
      return this.#out(g, 1);
    }
    return this.#out(null, this.#progress(t));
  }

  #progress(t) {
    const c = this.cfg;
    return Math.min(1, this.count / c.stableFrames, (t - this.since) / Math.max(1, c.minHoldMs));
  }

  #out(fire, progress) {
    return { fire, state: this.state, candidate: this.candidate, progress };
  }
}
