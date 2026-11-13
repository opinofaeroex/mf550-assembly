/**
 * AppState — small observable store for the UI-relevant application state.
 *
 *   position   sequencer position (-2 overview, -1 parts kit, 0…N-1 steps)
 *   animating  true while components are moving
 *   narration  narrator status: idle | speaking | paused | ended | blocked | muted | unsupported | error
 *   muted      narration muted by the user
 *   voice      { name, natural } of the voice in use, or null
 *   selection  BOM item number of the selected row, or null
 *
 * Producers (Sequencer, Narrator, selection) call set(); views subscribe to
 * 'change' and re-render from the snapshot, so every control shows the same truth.
 */
export class AppState extends EventTarget {
  constructor(initial = {}) {
    super();
    this.state = { ...initial };
  }

  get(key) { return this.state[key]; }

  set(patch) {
    const changed = [];
    for (const [k, v] of Object.entries(patch)) {
      if (this.state[k] !== v) { this.state[k] = v; changed.push(k); }
    }
    if (changed.length) {
      this.dispatchEvent(new CustomEvent('change', { detail: { changed, state: this.state } }));
    }
    return changed;
  }
}
