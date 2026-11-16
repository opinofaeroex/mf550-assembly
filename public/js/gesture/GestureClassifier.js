/**
 * GestureClassifier — thumbs-up / thumbs-down from the 21 MediaPipe hand landmarks.
 *
 * Landmarks (MediaPipe Hand Landmarker): 0 wrist; thumb 1–4 (CMC, MCP, IP, tip);
 * index 5–8, middle 9–12, ring 13–16, pinky 17–20 (MCP, PIP, DIP, tip).
 *
 * A pose is "thumbs up/down" only when ALL of these hold (several landmarks, never one):
 *   1. the four fingers are curled  — tip close to the palm (rotation-invariant, 3D
 *      world landmarks when available);
 *   2. the thumb is extended        — tip far from the index knuckle and the thumb
 *      joints nearly in line;
 *   3. the thumb points up / down   — thumb MCP→tip within `maxTiltDeg` of the image
 *      vertical (camera roll is assumed small: phone/webcam held upright);
 *   4. the thumb tip is the topmost / bottommost point of the hand.
 * Everything else (open hand, pointing, fist, partial hand) is 'none' = neutral.
 *
 * Pure function: no DOM, no MediaPipe import, so it is unit-tested with real landmark
 * fixtures (tests/fixtures/hand-landmarks.json).
 */
export const DEFAULT_CLASSIFIER = {
  // tuned on real Hand Landmarker output (tests/fixtures/hand-landmarks.json):
  // curled fingers 0.62–0.84, extended ≥ 1.3 · thumb reach: thumbs-up 0.71–0.80, fist 0.44–0.46
  // thumb straightness: thumbs-up ≥ 0.98, fist 0.80, pointing 0.88 · thumb-tip margin: ≥ 0.56
  maxCurlRatio: 1.0,       // finger curled if |tip − wrist| < ratio × max(|PIP − wrist|, |MCP − wrist|)
  minCurledFingers: 3,     // of index, middle, ring, pinky
  minThumbReach: 0.6,      // |thumb tip − index MCP| / palm size
  minThumbStraight: 0.9,   // |MCP→tip| / (|MCP→IP| + |IP→tip|)
  maxTiltDeg: 65,          // thumb direction vs. image vertical (a natural thumbs-up leans ~30°)
  extremeMargin: 0.2,      // thumb tip beyond every other landmark by margin × palm size (image)
};

const FINGERS = [[5, 6, 8], [9, 10, 12], [13, 14, 16], [17, 18, 20]];   // MCP, PIP, tip

const sub = (a, b) => a.map((v, i) => v - b[i]);
const len = (v) => Math.hypot(...v);
const dist = (a, b) => len(sub(a, b));

function toArrays(points, scaleX = 1) {
  return points.map((p) => (Array.isArray(p) ? [p[0] * scaleX, p[1], p[2] ?? 0] : [p.x * scaleX, p.y, p.z ?? 0]));
}

/**
 * @param {Array} landmarks  21 normalised image landmarks ({x,y,z} or [x,y,z]; y down)
 * @param {Array} [world]    21 world landmarks (metres, any unit) — preferred for shape tests
 * @param {{aspect?: number}} [frame]  image width / height (normalised x is scaled by it)
 * @param {object} [cfg]
 * @returns {{gesture: 'up'|'down'|'none', reason: string, metrics: object}}
 */
export function classifyGesture(landmarks, world, frame = {}, cfg = DEFAULT_CLASSIFIER) {
  const c = { ...DEFAULT_CLASSIFIER, ...cfg };
  if (!landmarks || landmarks.length < 21) return { gesture: 'none', reason: 'incomplete hand', metrics: {} };
  const img = toArrays(landmarks, frame.aspect || 1);
  const shp = world && world.length >= 21 ? toArrays(world) : img;

  // palm size (shape space): wrist–index MCP, wrist–pinky MCP, index MCP–pinky MCP
  const palm = (dist(shp[0], shp[5]) + dist(shp[0], shp[17]) + dist(shp[5], shp[17])) / 3 || 1e-6;

  // 1. curled fingers: the tip is not further from the wrist than its PIP joint (plus slack)
  let curled = 0;
  for (const [mcp, pip, tip] of FINGERS) {
    const reach = dist(shp[tip], shp[0]);
    const ref = Math.max(dist(shp[pip], shp[0]), dist(shp[mcp], shp[0]));
    if (reach < c.maxCurlRatio * ref) curled++;
  }

  // 2. thumb extended
  const thumbReach = dist(shp[4], shp[5]) / palm;
  const thumbStraight = dist(shp[2], shp[4]) / ((dist(shp[2], shp[3]) + dist(shp[3], shp[4])) || 1e-6);

  // 3. thumb direction in the image (y down)
  const v = sub(img[4], img[2]);
  const vl = Math.hypot(v[0], v[1]) || 1e-6;
  const upCos = -v[1] / vl;
  const tilt = Math.acos(Math.min(1, Math.abs(upCos))) * 180 / Math.PI;

  // 4. thumb tip is the extreme point of the hand along the vertical
  const palmImg = (dist(img[0], img[5]) + dist(img[0], img[17]) + dist(img[5], img[17])) / 3 || 1e-6;
  let minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < 21; i++) {
    if (i >= 1 && i <= 4) continue;
    minY = Math.min(minY, img[i][1]); maxY = Math.max(maxY, img[i][1]);
  }
  const m = c.extremeMargin * palmImg;
  const topmost = img[4][1] < minY - m;
  const bottommost = img[4][1] > maxY + m;

  const metrics = {
    curled, thumbReach: +thumbReach.toFixed(3), thumbStraight: +thumbStraight.toFixed(3),
    tiltDeg: +tilt.toFixed(1), upCos: +upCos.toFixed(3), topmost, bottommost,
  };
  if (curled < c.minCurledFingers) return { gesture: 'none', reason: 'fingers not curled', metrics };
  if (thumbReach < c.minThumbReach || thumbStraight < c.minThumbStraight) {
    return { gesture: 'none', reason: 'thumb not extended', metrics };
  }
  if (tilt > c.maxTiltDeg) return { gesture: 'none', reason: 'thumb not vertical', metrics };
  if (upCos > 0 && topmost) return { gesture: 'up', reason: 'thumbs up', metrics };
  if (upCos < 0 && bottommost) return { gesture: 'down', reason: 'thumbs down', metrics };
  return { gesture: 'none', reason: 'thumb not the extreme point', metrics };
}
