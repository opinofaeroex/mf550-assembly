/**
 * AR capability detection — what this browser / device can really do.
 *
 * mode   webxr      WebXR immersive-ar + hit-test: markerless surface tracking. In Chrome this
 *                   is Android + ARCore (Google Play Services for AR); also Samsung Internet,
 *                   Edge for Android and Meta Quest Browser.
 *        quicklook  iPhone / iPad: no WebXR; AR Quick Look (ARKit) with a USDZ generated here.
 *        none       no immersive AR (desktop browsers, unsupported phones).
 *
 * state  supported         AR can be started now
 *        needs-permission  AR exists but is blocked: camera permission denied, or the page is
 *                          embedded without the xr-spatial-tracking permission
 *        unavailable       not possible on this browser / device (`reason` says why)
 *        (active is set by the app while a session runs)
 *
 * overlay  true when a camera-backed 3D view is possible as a fallback. It is NOT AR: the
 *          model is drawn over the camera picture without any tracking.
 */
export function browserInfo(nav = navigator) {
  const ua = nav.userAgent || '';
  const brands = (nav.userAgentData && nav.userAgentData.brands || []).map((b) => b.brand).join(' ');
  const ios = /iPad|iPhone|iPod/.test(ua) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
  const android = /Android/i.test(ua);
  const edge = /Edg(e|A|iOS)?\//.test(ua) || /Microsoft Edge/.test(brands);
  const samsung = /SamsungBrowser/.test(ua);
  const firefox = /Firefox|FxiOS/.test(ua);
  const chrome = !edge && !samsung && (/Google Chrome/.test(brands) || /Chrome\/|CriOS\//.test(ua));
  const safari = ios ? !/CriOS|FxiOS|EdgiOS/.test(ua) : /Safari\//.test(ua) && !/Chrome|Chromium|Edg/.test(ua);
  const name = chrome ? 'Chrome' : edge ? 'Edge' : samsung ? 'Samsung Internet' : firefox ? 'Firefox' : safari ? 'Safari' : 'this browser';
  return { ios, android, desktop: !ios && !android, chrome, edge, samsung, firefox, safari, name };
}

async function cameraPermission(nav) {
  try {
    if (!nav.permissions || !nav.permissions.query) return 'unknown';
    return (await nav.permissions.query({ name: 'camera' })).state;   // granted | denied | prompt
  } catch { return 'unknown'; }
}

function xrPolicyAllowed(doc) {
  try {
    const pp = doc.permissionsPolicy || doc.featurePolicy;
    return pp && pp.allowsFeature ? pp.allowsFeature('xr-spatial-tracking') : true;
  } catch { return true; }
}

export async function detectAR({ nav = navigator, doc = document, win = window } = {}) {
  const b = browserInfo(nav);
  const r = {
    browser: b,
    secureContext: !!win.isSecureContext,
    webxrApi: 'xr' in nav && !!nav.xr,
    immersiveAR: false,
    quickLook: false,
    policyAllowed: xrPolicyAllowed(doc),
    camera: await cameraPermission(nav),
    overlay: !!(win.isSecureContext && nav.mediaDevices && nav.mediaDevices.getUserMedia),
    ios: b.ios,
    android: b.android,
    mode: 'none',
    state: 'unavailable',
    reason: '',
  };
  if (r.webxrApi) {
    try { r.immersiveAR = await nav.xr.isSessionSupported('immersive-ar'); } catch { r.immersiveAR = false; }
  }
  const a = doc.createElement('a');
  r.quickLook = !!(a.relList && a.relList.supports && a.relList.supports('ar'));
  r.mode = r.immersiveAR ? 'webxr' : r.quickLook ? 'quicklook' : 'none';

  if (!r.secureContext) {
    r.reason = 'AR and the camera need a secure (HTTPS) page. Open the published https:// address.';
  } else if (r.mode === 'webxr') {
    if (!r.policyAllowed) {
      r.state = 'needs-permission';
      r.reason = 'This page is embedded without permission for AR (xr-spatial-tracking). Open it directly in the browser.';
    } else if (r.camera === 'denied') {
      r.state = 'needs-permission';
      r.reason = `Camera access is blocked for this site. Allow it in ${b.name} (site settings › Camera), then start AR again.`;
    } else {
      r.state = 'supported';
      r.reason = `Markerless AR with WebXR in ${b.name}${b.android ? ' (ARCore)' : ''}.`;
    }
  } else if (r.mode === 'quicklook') {
    r.state = 'supported';
    r.reason = 'AR Quick Look (ARKit) — opens in Apple\'s AR viewer.';
  } else if (b.desktop) {
    r.reason = r.webxrApi
      ? `${b.name} on this computer supports WebXR, but immersive AR needs a phone or tablet with AR sensors (Android + ARCore). Computers have no AR tracking.`
      : `${b.name} on this computer has no WebXR AR. Use Chrome on an ARCore Android phone, or Safari on an iPhone / iPad.`;
  } else if (b.android) {
    r.reason = b.chrome
      ? 'Chrome on this device reports no WebXR AR. It needs an ARCore-supported device with Google Play Services for AR installed and up to date.'
      : `${b.name} on this device has no WebXR AR. Open this page in Chrome (ARCore device).`;
  } else if (b.ios) {
    r.reason = 'This iPhone / iPad browser cannot open AR Quick Look. Open this page in Safari.';
  } else {
    r.reason = 'This browser has no immersive AR.';
  }
  return r;
}

/** Explain a failed requestSession in words a user can act on. */
export function arErrorText(err, browserName = 'the browser') {
  const n = err && err.name;
  if (n === 'NotAllowedError' || n === 'SecurityError') {
    return `AR was blocked: allow camera access for this site in ${browserName} (site settings › Camera) and try again.`;
  }
  if (n === 'NotSupportedError') {
    return 'This device cannot start an AR session (ARCore missing or not supported). Use the 3D viewer, or the camera overlay.';
  }
  if (n === 'InvalidStateError') return 'An AR session is already running.';
  return `Could not start AR${err && err.message ? `: ${err.message}` : ''}.`;
}
