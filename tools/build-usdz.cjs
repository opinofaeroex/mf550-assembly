/**
 * Pre-builds the animated USDZ used by AR Quick Look on iPhone/iPad.
 *
 *   npm run build:usdz
 *
 * Runs the web app headlessly and exports the same exploded-view → assembly
 * program the app plays (js/ar/QuickLook.js), then writes
 * public/assets/model/<product>-assembly.usdz. Re-run after every conversion.
 * Without this file iOS still works: the app generates the USDZ in the browser.
 */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8098;

(async () => {
  const server = spawn(process.execPath, [path.join(ROOT, 'tools/serve.mjs'), '--port', String(PORT), '--host', '127.0.0.1'], { stdio: 'pipe' });
  await new Promise((r) => server.stdout.once('data', r));
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.error('page error:', e.message));
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.waitForFunction(() => window.app && window.app.quickLook, null, { timeout: 120000 });
    const out = await page.evaluate(async () => {
      const ql = window.app.quickLook;
      ql.staticUrl = null;            // force a fresh export
      const url = await ql.prepare();
      const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
      let s = '';
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      return { name: ql.fileName, b64: btoa(s) };
    });
    const file = path.join(ROOT, 'public/assets/model', out.name);
    fs.writeFileSync(file, Buffer.from(out.b64, 'base64'));
    console.log(`wrote ${path.relative(ROOT, file)} (${(fs.statSync(file).size / 1e6).toFixed(1)} MB)`);
  } finally {
    await browser.close();
    server.kill();
  }
})();
