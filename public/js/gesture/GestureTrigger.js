/**
 * GestureTrigger — turns per-frame gesture observations into single navigation events.
 *
 * v2.0: time-based recognition with temporal smoothing (faster, same at 8, 15 or 30 Hz):
 *
 *   evidence  e.up / e.down / e.none: exponential moving averages (time constant tauMs) of the
 *             per-frame observation, weighted by its confidence (hand score × thumb verticality);
 *             observations below minConfidence count as neutral
 *   arm       a gesture is a candidate while its evidence ≥ fireLevel AND leads both the other
 *             gesture and neutral by ≥ margin (thumbs-up vs thumbs-down never mix)
 *   FIRE      once the candidate has led for ≥ minHoldMs and was seen in ≥ minFrames frames
 *             (a single-frame blip can never fire) — ≈ 0.25 s instead of 5 frames (0.33 s at
 *             15 Hz, 0.63 s at 8 Hz before)
 *   re-arm    only after the hand returns to neutral (e.none ≥ neutralLevel) for ≥ neutralMs and
 *             cooldownMs has passed: holding a gesture never repeats it
 *
 * Pure and clock-agnostic (`t` in ms), so it is unit-tested without a camera.
 */
export const DEFAULT_TRIGGER = {
  tauMs: 110,          // smoothing time constant of the evidence
  fireLevel: 0.6,      // smoothed evidence needed for a gesture
  margin: 0.3,         // lead over the other gesture and over neutral
  minHoldMs: 120,      // candidate must lead for this long (time-based)
  minFrames: 2,        // …and be observed in at least this many frames
  neutralLevel: 0.6,   // re-arm: neutral evidence above this…
  neutralMs: 250,      // …for this long
  cooldownMs: 600,     // minimum time between two triggers
  minConfidence: 0.5,  // per-frame confidence below this counts as neutral
};

export class GestureTrigger {
  constructor(cfg = {}) {
    // v1.x keys (stableFrames, maxGapFrames, neutralFrames) are ignored: the trigger is time-based now
    this.cfg = { ...DEFAULT_TRIGGER, ...Object.fromEntries(Object.entries(cfg).filter(([k]) => k in DEFAULT_TRIGGER)) };
    this.reset();
  }

  reset() {
    this.state = 'ready';        // 'ready' | 'arming' | 'locked'
    this.e = { up: 0, down: 0, none: 1 };
    this.lastT = null;
    this.candidate = null;
    this.since = 0;
    this.frames = 0;
    this.neutralSince = null;
    this.lockedAt = -Infinity;
    this.lastFired = null;
  }

  /**
   * @param {'up'|'down'|'none'|null} obs  gesture of the user's right hand this frame (null: no right hand)
   * @param {number} t     timestamp in ms
   * @param {number} conf  confidence 0..1 of this observation (default 1)
   * @returns {{fire: 'up'|'down'|null, state: string, candidate: string|null, progress: number, evidence: object}}
   */
  update(obs, t, conf = 1) {
    const c = this.cfg;
    let g = obs === 'up' || obs === 'down' ? obs : 'none';
    if (g !== 'none' && conf < c.minConfidence) g = 'none';
    const dt = this.lastT === null ? c.tauMs * 0.7 : Math.max(0, Math.min(500, t - this.lastT));
    this.lastT = t;
    const a = 1 - Math.exp(-dt / c.tauMs);
    const w = g === 'none' ? 1 : Math.min(1, conf);
    const target = { up: 0, down: 0, none: 1 - (g === 'none' ? 0 : w) };
    if (g !== 'none') target[g] = w;
    for (const k of ['up', 'down', 'none']) this.e[k] += a * (target[k] - this.e[k]);
    const e = this.e;

    if (this.state === 'locked') {
      if (e.none >= c.neutralLevel) {
        if (this.neutralSince === null) this.neutralSince = t;
        if (t - this.neutralSince >= c.neutralMs && t - this.lockedAt >= c.cooldownMs) {
          this.state = 'ready';
          this.candidate = null;
        }
      } else {
        this.neutralSince = null;
      }
      return this.#out(null, 0);
    }

    const lead = (k) => e[k] - Math.max(e[k === 'up' ? 'down' : 'up'], e.none);
    const best = e.up >= e.down ? 'up' : 'down';
    const ok = e[best] >= c.fireLevel && lead(best) >= c.margin;
    if (ok) {
      if (this.candidate !== best) { this.candidate = best; this.since = t; this.frames = 0; }
      if (g === best) this.frames++;
      this.state = 'arming';
      if (t - this.since >= c.minHoldMs && this.frames >= c.minFrames) {
        this.state = 'locked';
        this.lockedAt = t;
        this.neutralSince = null;
        this.lastFired = best;
        this.candidate = null;
        return this.#out(best, 1);
      }
      return this.#out(null, Math.min(1, (t - this.since) / c.minHoldMs));
    }
    // not (or no longer) leading: keep a candidate briefly through a one-frame dip, else drop it
    if (this.candidate && e[this.candidate] < c.fireLevel * 0.75) this.candidate = null;
    this.state = this.candidate ? 'arming' : 'ready';
    return this.#out(null, this.candidate ? Math.min(1, (t - this.since) / c.minHoldMs) : Math.min(0.5, Math.max(e.up, e.down) / c.fireLevel / 2));
  }

  #out(fire, progress) {
    return { fire, state: this.state, candidate: this.candidate, progress, evidence: { ...this.e } };
  }
}
