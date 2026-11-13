/**
 * Application configuration (single place for tunable behaviour).
 */
export const CONFIG = {
  assemblyUrl: 'assets/model/assembly.json',
  modelDir: 'assets/model/',

  /**
   * Exploded-view distance multiplier.
   * assembly.json stores the displacement vectors computed by the pipeline's
   * collision analysis (pipeline/disassembly.py). The viewer multiplies every
   * vector — hardware, parts and sub-assemblies alike — by this factor, so the
   * directions and the assembly relationships are unchanged and f = 0 is still
   * the exact CAD position. v1.0 used 1, v1.1 uses 3.
   */
  explodeScale: 3,

  narration: {
    lang: 'en',            // narration scripts are written in English
    startDelayMs: 150,     // debounce: rapid step changes never queue several narrations
    rates: [0.8, 0.9, 1, 1.1, 1.25],
    defaultRate: 1,
  },
};
