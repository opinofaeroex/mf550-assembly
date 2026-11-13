/**
 * AR capability detection — chooses the tracking method for this device.
 *
 *  webxr      WebXR immersive-ar + hit-test: markerless surface tracking (ARCore on
 *             Android Chrome, also Meta Quest Browser). Full interactive experience.
 *  quicklook  iOS / iPadOS Safari: no WebXR; AR Quick Look (ARKit) with a USDZ that
 *             is generated in the browser and carries the assembly animation.
 *  none       desktop / unsupported: 3D viewer only.
 */
export async function detectAR() {
  const ua = navigator.userAgent || '';
  const r = {
    secureContext: window.isSecureContext,
    webxrApi: 'xr' in navigator,
    immersiveAR: false,
    quickLook: false,
    ios: /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1),
    android: /Android/i.test(ua),
    mode: 'none',
  };
  if (r.webxrApi) {
    try { r.immersiveAR = await navigator.xr.isSessionSupported('immersive-ar'); } catch { r.immersiveAR = false; }
  }
  const a = document.createElement('a');
  r.quickLook = !!(a.relList && a.relList.supports && a.relList.supports('ar'));
  r.mode = r.immersiveAR ? 'webxr' : r.quickLook ? 'quicklook' : 'none';
  return r;
}
