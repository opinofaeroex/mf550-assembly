/**
 * standards.js — shared run-time parameters of the unit-installation tutorial.
 *
 * The values of the v2.1 reference implementation, in one place so that the camera, the
 * operation indicators, the components view and the tool materials stay consistent. Documented
 * in docs/ANIMATION_AND_INTERACTION_STANDARDS.md (§ 10); build-time counterparts (timing,
 * clearances, collision tolerances, camera shot rules) are in pipeline/unit/standards.py.
 *
 * Changing a value changes what the operator sees: compare the frames with
 * `npm run unit:review -- --compare <baseline>` and run `npm test` before committing.
 * Units: metres, seconds, radians (model frame, Y up, front = +X).
 */

/** Automatic camera following the build-time shots (UnitCamera.js). */
export const CAMERA_FOLLOW = Object.freeze({
  smoothing: 3.2,          // 1/s: exponential approach of target, direction and distance
  maxFrameDt: 0.1,         // s: frame time cap (a stalled frame never jumps the camera)
  maxLead: 0.9,            // s: the move towards the next shot starts at most this early …
  leadShare: 0.7,          // … or this share of the interval between the two shots
  padding: 1.12,           // viewer.fitDistance padding around the shot's framing sphere
});

/** Orange rotation arrow shown while a fastener is tightened (fx 'spinArrow', UnitRig.js). */
export const SPIN_ARROW = Object.freeze({
  colour: 0xff7a1a,        // the app's accent orange (--accent)
  arc: Math.PI * 1.5,      // 270° arc + one arrowhead
  tubeShare: 0.07,         // tube radius = max(minTube, arrow radius × tubeShare)
  minTube: 0.0009,
  radialSegments: 6,
  tubularSegments: 40,
  headRadius: 3,           // × tube
  headLength: 7,           // × tube
  headOffset: 2,           // × tube, along the direction of motion
  headSegments: 12,
  opacity: 0.95,
  fade: 0.15,              // s fade in / out at the start / end of the tightening
  turnRatePi: 1.2,         // the arrow turns at turnRatePi × π rad/s in the tightening sense
  renderOrder: 3,
});

/** Components view (sequencer position −1): staging offsets × scale, capped (UnitRig.js). */
export const KIT_VIEW = Object.freeze({
  scale: 2,                // v2.1: twice the v2.0 separation
  maxOffset: 0.75,         // m: long approach paths are not stretched beyond this (never shorter than v2.0)
});

/** X-ray steps (camera.xray): the rest of the unit is ghosted (main.js). */
export const XRAY = Object.freeze({
  decalAlpha: 0.18,        // decals fade with the ghosted body so they do not hide the parts inside
});

/**
 * Rivet-gun materials (UnitRig.js, styleRivetGun). The supplied STEP has no colours: materials
 * per solid by mechanical function, matte to satin (roughness ≥ 0.38), no textures (no UVs).
 * [colour, metalness, roughness]; s1 (housing + grip, one solid) uses vertex colours split at gripBelowX.
 */
export const RIVET_GUN_STYLE = Object.freeze({
  orange: 0xe8731a,
  rubber: 0x2a2c30,
  gripBelowX: -0.060,      // m, tool frame: the grip lies behind the head housing
  housing: [0xffffff, 0.05, 0.6],               // with vertex colours (orange / rubber)
  parts: Object.freeze({
    s2: [0x3b3f45, 0.15, 0.62],                 // mandrel collector
    s3: [0xb9bec4, 0.85, 0.38],                 // nose piece (steel)
    s4: [0x8e949b, 0.8, 0.45], s5: [0x8e949b, 0.8, 0.45],   // screws
    s6: [0x232529, 0.1, 0.7],                   // battery pack
    s7: [0xe8731a, 0.05, 0.55],                 // battery label plate (accent)
    s8: [0x3b3f45, 0.2, 0.6], s9: [0x3b3f45, 0.2, 0.6], s10: [0x3b3f45, 0.2, 0.6],
    s11: [0x2a2c30, 0.0, 0.85],                 // guard loop (rubber)
    s12: [0x1d1f22, 0.1, 0.6],                  // button
    s13: [0x1d1f22, 0.1, 0.6],                  // trigger
    s14: [0x5b6066, 0.5, 0.5],                  // release lever
  }),
});

/** Step loop (UnitSequencer.js): pause at the end of a step before it repeats. */
export const LOOP = Object.freeze({ hold: 1.6 });
