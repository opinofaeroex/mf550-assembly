#!/usr/bin/env node
/**
 * unit-review.cjs — visual review of the unit-installation tutorial (standard workflow, see
 * docs/ANIMATION_AND_INTERACTION_STANDARDS.md § 8).
 *
 *   npm run unit:review                         every step, 4 frames each
 *   npm run unit:review -- --steps 2,5-8        selected steps (1-based)
 *   npm run unit:review -- --frames 6 --out /tmp/review
 *   npm run unit:review -- --at 10:2.4,3.0      explicit step times (seconds) for one step
 *   npm run unit:review -- --compare <dir>      compare scene fingerprints with an earlier run
 *
 * Serves the app, opens the unit tutorial headless (software WebGL), and for every step
 * captures frames at its camera shots: the step clock is set exactly (animation paused), the
 * rig is posed, and the automatic camera is placed on the shot (UnitCamera.focus instant) —
 * so each frame is what an operator sees at that moment. Frames: sNN_i.png. A contact sheet
 * (index.html) lists every step with its frames, times, shot kinds and collision checks.
 * Every frame also gets an exact SCENE FINGERPRINT (world matrices of all parts, tool poses and
 * moving tool components, effect visibility / opacity / transforms, camera position + target,
 * floor shadow) written to fingerprints.json. Pixels differ slightly between identical runs in
 * software WebGL; the fingerprint does not, so `--compare` proves a refactor left every frame
 * unchanged (or lists the frames that changed).
 * Exits with code 1 if the page reports errors or a compared frame differs.
 */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const OUT = path.resolve(opt('out', path.join(os.tmpdir(), 'mf550-unit-review')));
const FRAMES = +opt('frames', 4);
const PORT = +opt('port', 8790);
const [VW, VH] = opt('viewport', '1280x800').split('x').map(Number);

function parseSteps(spec, n) {
  if (!spec) return [...Array(n).keys()];
  const out = new Set();
  for (const part of spec.split(',')) {
    const [a, b] = part.split('-').map(Number);
    for (let k = a; k <= (b || a); k++) if (k >= 1 && k <= n) out.add(k - 1);
  }
  return [...out].sort((x, y) => x - y);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const srv = spawn(process.execPath, [path.join(ROOT, 'tools/serve.mjs'), '--port', String(PORT), '--host', '127.0.0.1'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1000));
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: VW, height: VH } });
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error' && !/GL Driver|GPU stall|404/.test(m.text())) errors.push(m.text().slice(0, 200)); });
    await page.addInitScript(() => {
      try { localStorage.setItem('mf550.narration.muted', 'true'); localStorage.setItem('mf550.perf.profile', 'high'); localStorage.setItem('mf550.tutorial', 'unit'); } catch { /* none */ }
    });
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.waitForFunction(() => window.app && app.seq && app.rig && document.getElementById('loader').style.display === 'none', null, { timeout: 180000 });
    const N = await page.evaluate(() => app.model.stepCount);
    const at = opt('at', null);
    const explicit = new Map();
    if (at) { const [s, ts] = at.split(':'); explicit.set(+s - 1, ts.split(',').map(Number)); }
    const steps = explicit.size ? [...explicit.keys()] : parseSteps(opt('steps', null), N);
    const rows = [];
    const fingerprints = {};
    for (const k of steps) {
      const info = await page.evaluate(([k, n]) => {
        const s = app.model.steps[k]; const sh = s.camera.shots || []; const kinds = s.camera.shotKinds || [];
        let idx = sh.map((_, i) => i);
        if (idx.length > n) idx = [...new Set(Array.from({ length: n }, (_, j) => Math.round(j * (sh.length - 1) / (n - 1))))];
        return {
          title: s.title, phase: s.phase, duration: s.duration,
          times: idx.map((i, j) => Math.min(s.duration, sh[i][0] + (j === 0 ? 0.5 : 0.35))),
          kinds: idx.map((i) => kinds[i] || ''),
          checks: s.checks.length, unclear: s.checks.filter((c) => !c.clear).map((c) => c.what),
        };
      }, [k, FRAMES]);
      if (explicit.has(k)) { info.times = explicit.get(k); info.kinds = info.times.map(() => 'explicit'); }
      const files = [];
      for (let i = 0; i < info.times.length; i++) {
        await page.evaluate(([k, t]) => {
          if (app.seq.pos !== k) app.seq.goTo(k);
          app.seq.speed = 0; app.seq.t = t; app.rig.apply(k, t);
          app.cameraCtl.focus(k, { instant: true });
        }, [k, info.times[i]]);
        await page.waitForTimeout(250);
        const fp = await page.evaluate(() => {
          const r6 = (x) => Math.round(x * 1e6) / 1e6;
          const parts = []; app.viewer.scene.updateMatrixWorld(true);
          const vis = (o) => { let p = o; while (p) { if (p.visible === false) return 0; p = p.parent; } return 1; };
          for (const id of app.model.partIds) { const o = app.loaded.objects.get(id); parts.push(vis(o), ...o.matrixWorld.elements.map(r6)); }
          const tools = []; // sorted by id: the tool models finish loading in any order
          for (const [id, t] of Object.entries(app.rig.tools).sort((x, y) => (x[0] < y[0] ? -1 : 1))) { tools.push(id, vis(t.group)); if (t.group.visible) t.group.traverse((o) => tools.push(...o.matrixWorld.elements.map(r6))); }
          // only visible effects: hidden ones of steps visited earlier depend on navigation history
          const fx = []; for (const [k, list] of [...app.rig.fx.entries()].sort((a, b) => a[0] - b[0])) for (const o of list) {
            if (!o.visible) continue;
            fx.push(k, ...o.matrixWorld.elements.map(r6));
            if (o.material) fx.push(r6(o.material.opacity)); if (o.geometry && o.geometry.drawRange) fx.push(o.geometry.drawRange.count);
            if (o.userData.mat) fx.push(r6(o.userData.mat.opacity));
          }
          const v = app.viewer;
          const cam = [...v.camera.position.toArray(), ...v.controls.target.toArray()].map(r6);
          const H = (x) => { const str = JSON.stringify(x); let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, '0'); };
          const sub = { parts: H(parts), tools: H(tools), fx: H(fx), cam: H(cam), shadow: v.contactShadow.visible };
          return { hash: H(sub), sub, cam };
        });
        const f = `s${String(k + 1).padStart(2, '0')}_${i}.png`;
        fingerprints[f] = { step: k + 1, t: info.times[i], ...fp };
        await page.screenshot({ path: path.join(OUT, f) });
        files.push(f);
      }
      rows.push({ k, ...info, files });
      process.stdout.write(`step ${k + 1}/${N} ${info.title}: ${files.length} frames\n`);
    }
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Unit tutorial review</title>
<style>body{font:13px system-ui,sans-serif;margin:16px;background:#f4f5f7}h2{font-size:14px;margin:18px 0 6px}
.row{display:flex;gap:8px;flex-wrap:wrap}.f{background:#fff;padding:4px;border-radius:6px}.f img{width:420px;display:block}
.m{color:#555;font-size:12px}.bad{color:#b00}</style></head><body>
<h1>Unit installation tutorial — visual review</h1><p class="m">${new Date().toISOString()} · ${VW}×${VH} · frames at the camera shots (animation paused, automatic camera on the shot)</p>
${rows.map((r) => `<h2>Step ${r.k + 1} · Phase ${r.phase} · ${esc(r.title)}</h2>
<p class="m">${r.duration.toFixed(1)} s · ${r.checks} collision checks${r.unclear.length ? ` · <span class="bad">not clear: ${esc(r.unclear.join(', '))}</span>` : ' · all clear'}</p>
<div class="row">${r.files.map((f, i) => `<div class="f"><img src="${f}"><div class="m">t = ${r.times[i].toFixed(2)} s · ${esc(r.kinds[i])}</div></div>`).join('')}</div>`).join('\n')}
${errors.length ? `<h2 class="bad">Page errors</h2><pre>${esc(errors.join('\n'))}</pre>` : ''}
</body></html>`;
    fs.writeFileSync(path.join(OUT, 'index.html'), html);
    fs.writeFileSync(path.join(OUT, 'fingerprints.json'), JSON.stringify(fingerprints, null, 1));
    const cmp = opt('compare', null);
    if (cmp) {
      const old = JSON.parse(fs.readFileSync(path.join(path.resolve(cmp), 'fingerprints.json'), 'utf8'));
      const common = Object.keys(fingerprints).filter((f) => old[f] && Math.abs(old[f].t - fingerprints[f].t) < 1e-9);
      const changed = common.filter((f) => old[f].hash !== fingerprints[f].hash);
      const what = (f) => Object.keys(fingerprints[f].sub).filter((k) => !old[f].sub || old[f].sub[k] !== fingerprints[f].sub[k]).join('+');
      console.log(`compare with ${cmp}: ${common.length} frames compared, ${changed.length} changed${changed.length ? ': ' + changed.map((f) => `${f} (${what(f)})`).join(', ') : ' (scene state identical)'}`);
      if (changed.length) errors.push(`fingerprint changed: ${changed.join(', ')}`);
    }
    console.log(`\n${rows.reduce((a, r) => a + r.files.length, 0)} frames → ${OUT}/index.html${errors.length ? `\nPAGE ERRORS:\n${errors.join('\n')}` : ''}`);
  } finally {
    await browser.close();
    srv.kill();
  }
  process.exit(errors.length ? 1 : 0);
})();
