# CLAUDE.md — Mist-Fit 550 assembly viewer

Instructions for every Claude Code session working in this repository. They apply to all branches and all future
sessions.

## Before any change to steps, animations, tools, camera or the interface

1. **Read [`docs/ANIMATION_AND_INTERACTION_STANDARDS.md`](docs/ANIMATION_AND_INTERACTION_STANDARDS.md) first.**
   It is the binding standard. The v2.1 implementation (`cc98332`) is the quality baseline: never go back to
   simpler, less realistic animations or generic camera moves.
2. **Inspect before modifying.** Check:
   - `git status` and `git log`;
   - the current branch;
   - the code you are about to touch (`pipeline/unit/`, `public/js/unit/`, `public/js/main.js`).

   Do not overwrite existing user changes. Work on a new feature branch from up-to-date `main`.
3. **Reuse the established techniques** instead of inventing new ones:
   - the Step API in `pipeline/unit/build_unit.py`;
   - shared parameters in `pipeline/unit/standards.py` (build time) and `public/js/unit/standards.js` (run time);
   - collision-checked paths;
   - per-operation camera shots;
   - the tool life cycle;
   - indicators such as the orange rotation arrow.

   Keep operation-specific behaviour specific.
4. **Validate** with standards § 8 before reporting anything as done:
   1. rebuild `build_unit.py`, then read the checks and the camera table in `docs/unit-engineering-report.md`;
   2. run `npm test`;
   3. run `npm run unit:review` on the changed steps and look at every frame;
   4. for refactors, add `--compare <baseline>` and compare the `assembly.json` hash.
5. **Update the standard** in the same branch when a new technique proves itself (standards § 12). Add a test for it.

## Hard rules

- **Mechanics.** No component or tool may pass through solid structure. If no clean path exists:
  1. find another real approach or supplied tool;
  2. otherwise flag it (`Step.flag`).

  Never widen collision `allow` sets to hide it.
- **Ending poses.** Every motion ends exactly at the CAD pose.
- **Missing data.** Never invent data the CAD or the supplied documents do not contain (sizes, torques, holes,
  wiring, tool models): show the honest closest representation and flag it.
- **Sequence.** It follows real dependencies. Every one of the 220 components is installed exactly once;
  pre-installed parts use `show()`.
- **Operator UI.** No warning colours or clutter. Engineering flags go to the engineering report; genuine safety
  requirements go into the instruction text.
- **Manual control.** Preserve it: navigation is manual only, and the user can always override the camera.
- **Git.** Never force-push, discard work or merge into `main` before validation. Never claim tests or a
  deployment that were not actually run and verified.

## Useful commands

```bash
npm start                                                   # serve the app locally
npm run unit:build                                          # rebuild unit step data from the repo (≈ 25 s)
npm test                                                    # 145 end-to-end checks (ONLY=unit for section 14)
npm run unit:review -- --steps 5-11                         # frames + contact sheet of selected steps
npm run unit:review -- --out /tmp/after --compare /tmp/base # prove a refactor changed nothing
npm run camera:plans                                        # parts tutorial: after explode / model / camera changes
```

Live app: https://opinofaeroex.github.io/mf550-assembly/public/ (GitHub Pages from `main`).
