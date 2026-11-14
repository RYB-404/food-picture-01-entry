// food-picture-01 — "Morning Rosetta"
//
// A top-down latte in a warm ceramic cup on a saucer, on a wooden table in
// morning light: rosetta latte art poured down the center (a fern of cream
// leaves under-shadowed so the foam sits proud of the crema, a heart at the
// top, a pull-through groove down the stem), a gloss arc across the surface,
// microfoam bubbles at the edge, and two roasted coffee beans beside the
// saucer. Soft directional shadow, warm brown palette.
//
// Pure Node standard library: the scene is rendered with signed distance
// fields (supersampled 3x, box-downscaled for clean anti-aliasing; smooth
// radial and directional shading everywhere), then encoded by hand as a
// 1024x1024 8-bit RGB PNG (per-row adaptive filtering, zlib + CRC32) and
// written to $MAKEFUN_OUTPUT_DIR/entry.png (default /output/entry.png).
//
// Deterministic: no randomness, no clock in the output, no network. Two runs
// write identical bytes.
// Run: node main.ts   (dev: mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts)

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { deflateSync } from 'node:zlib';

const W = 1024;
const H = 1024;
const SS = 3; // supersampling factor
const AA = W * SS; // coverage sharpness for a 1-SS-pixel anti-aliased edge

// ---------------------------------------------------------------- colors
function hx(s: string): [number, number, number] {
  return [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
}
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
function mixC(a: number[], b: number[], t: number) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
const smooth = (t: number) => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};

// ---------------------------------------------------------------- layout (unit coords, y down)
const CUP = { x: 0.505, y: 0.470, r: 0.335 }; // outer ceramic wall
const CAF = { x: 0.505, y: 0.480, r: 0.268 }; // coffee surface
const SAU = { x: 0.505, y: 0.525, r: 0.500 }; // saucer
const LIGHT = { x: -0.553, y: -0.833 }; // light direction (from upper left)

// ---------------------------------------------------------------- SDF helpers
function sdCircle(px: number, py: number, cx: number, cy: number, r: number) {
  const dx = px - cx, dy = py - cy;
  return Math.sqrt(dx * dx + dy * dy) - r;
}
function sdEllipse(px: number, py: number, cx: number, cy: number, rx: number, ry: number) {
  const dx = (px - cx) / rx, dy = (py - cy) / ry;
  return (Math.sqrt(dx * dx + dy * dy) - 1) * Math.min(rx, ry);
}
function sdArc(px: number, py: number, cx: number, cy: number, r: number, mid: number, halfSpan: number, w: number) {
  let d = Math.atan2(py - cy, px - cx) - mid;
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  const cl = clamp(d, -halfSpan, halfSpan);
  const qx = cx + r * Math.cos(mid + cl);
  const qy = cy + r * Math.sin(mid + cl);
  const dx = px - qx, dy = py - qy;
  return Math.sqrt(dx * dx + dy * dy) - w * 0.5;
}
function makeConvex(pts: number[][]) {
  const n = pts.length;
  const edges: number[][] = [];
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p[0]; cy += p[1]; }
  cx /= n; cy /= n;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const len = Math.sqrt(ex * ex + ey * ey) || 1;
    let nx = ey / len, ny = -ex / len;
    if ((cx - a[0]) * nx + (cy - a[1]) * ny > 0) { nx = -nx; ny = -ny; }
    edges.push([a[0], a[1], nx, ny]);
  }
  return function (px: number, py: number) {
    let d = -1e9;
    for (let i = 0; i < n; i++) {
      const e = edges[i];
      const dist = (px - e[0]) * e[2] + (py - e[1]) * e[3];
      if (dist > d) d = dist;
    }
    return d;
  };
}
function smin(a: number, b: number, k: number) {
  const h = clamp(0.5 + 0.5 * (b - a) / k, 0, 1);
  return b + (a - b) * h - k * h * (1 - h);
}
function quad(p0: number[], p1: number[], p2: number[], t: number) {
  const u = 1 - t;
  return [
    u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
    u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
  ];
}
function sampleQuad(p0: number[], p1: number[], p2: number[], n: number) {
  const pts: number[][] = [];
  for (let i = 0; i <= n; i++) pts.push(quad(p0, p1, p2, i / n));
  return pts;
}

// ---------------------------------------------------------------- shape plumbing
const out = { a: 0, r: 0, g: 0, b: 0 };
const shapes: { x0: number; y0: number; x1: number; y1: number; f: (px: number, py: number, o: { a: number; r: number; g: number; b: number }) => void }[] = [];
function marginFor(K: number) { return 1.6 / K + 0.001; }
function addShape(x0: number, y0: number, x1: number, y1: number, f: (px: number, py: number, o: { a: number; r: number; g: number; b: number }) => void) {
  shapes.push({ x0, y0, x1, y1, f });
}
// coverage of a disc boundary (1 inside, 0 outside, AA-smooth)
function discCov(px: number, py: number, cx: number, cy: number, r: number, K = AA) {
  return clamp(0.5 - sdCircle(px, py, cx, cy, r) * K, 0, 1);
}
// Tapered stroke: distance to a chain of capsules with linearly interpolated
// width; optional smooth clip to a disc (the coffee surface) and optional
// per-pixel color callback (cream shading across the foam).
function taperedStroke(
  pts: number[][], ws: number[], color: number[], alpha: number, K: number,
  clip?: [number, number, number],
  colorAt?: (px: number, py: number) => number[],
) {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  let wmax = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]);
    y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
    if (ws[i] > wmax) wmax = ws[i];
  }
  const m = wmax * 0.5 + 2.5 / K + 0.002;
  addShape(x0 - m, y0 - m, x1 + m, y1 + m, (px, py, o) => {
    let sd = 1e9;
    for (let i = 0; i < pts.length - 1; i++) {
      const ax = pts[i][0], ay = pts[i][1];
      const bx = pts[i + 1][0], by = pts[i + 1][1];
      const ex = bx - ax, ey = by - ay;
      const l2 = ex * ex + ey * ey;
      let t = l2 > 0 ? ((px - ax) * ex + (py - ay) * ey) / l2 : 0;
      t = clamp(t, 0, 1);
      const dx = px - (ax + ex * t), dy = py - (ay + ey * t);
      const dd = Math.sqrt(dx * dx + dy * dy);
      const w = ws[i] + (ws[i + 1] - ws[i]) * t;
      const s = dd - w * 0.5;
      if (s < sd) sd = s;
    }
    let a = clamp(0.5 - sd * K, 0, 1) * alpha;
    if (a <= 0) return;
    if (clip) {
      a *= discCov(px, py, clip[0], clip[1], clip[2] + 1.5 / AA);
      if (a <= 0) return;
    }
    const c = colorAt ? colorAt(px, py) : color;
    o.a = a; o.r = c[0]; o.g = c[1]; o.b = c[2];
  });
}
// Soft radial blob (light crema swirl), optionally clipped to the coffee disc.
function blob(cx: number, cy: number, R: number, color: number[], A: number, softK: number, clip?: [number, number, number]) {
  const m = R + marginFor(softK) + 0.004;
  addShape(cx - m, cy - m, cx + m, cy + m, (px, py, o) => {
    const d = sdCircle(px, py, cx, cy, R);
    let a = A * clamp(0.5 - d * softK, 0, 1);
    if (a <= 0) return;
    if (clip) {
      a *= discCov(px, py, clip[0], clip[1], clip[2] + 1.5 / AA);
      if (a <= 0) return;
    }
    o.a = a; o.r = color[0]; o.g = color[1]; o.b = color[2];
  });
}
function disc(cx: number, cy: number, r: number, color: number[], K = AA, alpha = 1) {
  const m = marginFor(K);
  addShape(cx - r - m, cy - r - m, cx + r + m, cy + r + m, (px, py, o) => {
    const a = discCov(px, py, cx, cy, r, K) * alpha;
    if (a <= 0) return;
    o.a = a; o.r = color[0]; o.g = color[1]; o.b = color[2];
  });
}
function arcStroke(cx: number, cy: number, r: number, mid: number, halfSpan: number, w: number, color: number[], alpha = 1, K = AA) {
  const m = r + w * 0.5 + marginFor(K);
  addShape(cx - m, cy - m, cx + m, cy + m, (px, py, o) => {
    const d = sdArc(px, py, cx, cy, r, mid, halfSpan, w);
    const a = clamp(0.5 - d * K, 0, 1) * alpha;
    if (a <= 0) return;
    o.a = a; o.r = color[0]; o.g = color[1]; o.b = color[2];
  });
}

// ---------------------------------------------------------------- background: wooden table
const WOOD = {
  p1: hx('#B07947'), p2: hx('#A5713F'), p3: hx('#B98250'),
  seam: hx('#6B4425'),
};
function background(x: number, y: number, o: Float64Array) {
  // plank seams: two gently waving vertical lines
  const wob = 0.011 * Math.sin(y * 8.2 + 1.7) + 0.005 * Math.sin(y * 21.0 + x * 2.0);
  const s1 = x - (0.300 + wob);
  const s2 = x - (0.718 + 0.6 * wob);
  let c: number[];
  if (x < 0.300 + wob) c = WOOD.p1.slice();
  else if (x < 0.718 + 0.6 * wob) c = WOOD.p2.slice();
  else c = WOOD.p3.slice();
  // wood grain: thin vertical streaks that wave with y (two octaves)
  const gx = x + 0.018 * Math.sin(y * 5.3 + x * 3.1) + 0.006 * Math.sin(y * 13.7);
  const g1 = Math.sin(gx * 251 + 2.4 * Math.sin(y * 6.1 + x * 5));
  const g2 = Math.sin(gx * 493 + 1.3 * Math.sin(y * 9.7));
  const grain = 0.55 * g1 + 0.30 * g2;
  const gg = grain * 11;
  let r = c[0] + gg, g = c[1] + gg * 0.85, b = c[2] + gg * 0.62;
  // seams
  const sd = Math.min(Math.abs(s1), Math.abs(s2));
  if (sd < 0.006) {
    const t = smooth(1 - sd / 0.006);
    r += (WOOD.seam[0] - r) * t * 0.75;
    g += (WOOD.seam[1] - g) * t * 0.75;
    b += (WOOD.seam[2] - b) * t * 0.75;
  }
  // soft light pool from the upper left + vignette
  const dxp = x - 0.30, dyp = y - 0.24;
  const pool = 1 - Math.min((dxp * dxp + dyp * dyp) / 0.85, 1);
  const lp = 26 * pool * pool;
  r += lp; g += lp * 0.92; b += lp * 0.72;
  const dv = Math.sqrt((x - 0.5) * (x - 0.5) + (y - 0.5) * (y - 0.5));
  const vg = smooth((dv - 0.47) / 0.30) * 0.34;
  const m = 1 - vg;
  o[0] = r * m; o[1] = g * m; o[2] = b * m;
}

// ---------------------------------------------------------------- palette
const C = {
  saucerHi: hx('#F4EEDF'), saucerLo: hx('#CFC5B1'), saucerEdge: hx('#B7AC96'),
  cupHi: hx('#FFFCF3'), cupLo: hx('#D8D0BF'), cupEdge: hx('#B9AE99'),
  coffeeIn: hx('#A9713C'), coffeeMid: hx('#8A5527'), coffeeOut: hx('#54300F'),
  meniscus: hx('#38200C'),
  foam: hx('#F6EEDA'), foamLo: hx('#E8DABE'),
  grove: hx('#6E4119'),
  cremaSwirl: hx('#C2894E'),
  shadow1: hx('#33200F'),
  specWarm: hx('#FFE7BE'),
  beanA: hx('#5E3A1F'), beanB: hx('#7A4E2B'), beanCrease: hx('#38200E'),
};

// ---------------------------------------------------------------- scene build
// saucer drop shadow (two soft layers, offset to the lower right)
function softShadow(cx: number, cy: number, r: number, ox: number, oy: number, fade: number, A: number) {
  const sx = cx + ox, sy = cy + oy;
  const m = r + fade + marginFor(AA);
  addShape(sx - m, sy - m, sx + m, sy + m, (px, py, o) => {
    const d = sdCircle(px, py, sx, sy, r);
    if (d > fade) return;
    const a = A * (1 - smooth(d / fade));
    if (a <= 0) return;
    o.a = a; o.r = C.shadow1[0]; o.g = C.shadow1[1]; o.b = C.shadow1[2];
  });
}
softShadow(SAU.x, SAU.y, SAU.r * 0.985, 0.022, 0.034, 0.075, 0.34);
softShadow(SAU.x, SAU.y, SAU.r * 0.965, 0.010, 0.016, 0.030, 0.30);

// saucer: radial + directional ceramic shading
addShape(SAU.x - SAU.r - 0.01, SAU.y - SAU.r - 0.01, SAU.x + SAU.r + 0.01, SAU.y + SAU.r + 0.01, (px, py, o) => {
  const d = sdCircle(px, py, SAU.x, SAU.y, SAU.r);
  const a = clamp(0.5 - d * AA, 0, 1);
  if (a <= 0) return;
  const dx = px - SAU.x, dy = py - SAU.y;
  const n = Math.sqrt(dx * dx + dy * dy) || 1e-6;
  const s = (dx * LIGHT.x + dy * LIGHT.y) / n; // +1 toward the light
  const t = clamp((dx * LIGHT.x + dy * LIGHT.y) / (SAU.r * 1.6) + 0.5, 0, 1);
  let c = mixC(C.saucerLo, C.saucerHi, t);
  // outer edge darkening + inner well dip shading
  const rn = n / SAU.r;
  const edge = smooth((rn - 0.82) / 0.18);
  c = mixC(c, C.saucerEdge, edge * 0.55);
  const dip = smooth((rn - 0.66) / 0.10) * (1 - smooth((rn - 0.80) / 0.06));
  c = mixC(c, C.saucerLo, dip * 0.5 * (0.6 + 0.4 * (1 - t)));
  // directional fine shading
  const sh = (0.5 + 0.5 * s) * 10 - 5;
  o.a = a; o.r = c[0] + sh; o.g = c[1] + sh * 0.9; o.b = c[2] + sh * 0.7;
});
// saucer rim specular arc (upper left) + reflected rim light (lower right)
arcStroke(SAU.x, SAU.y, SAU.r * 0.965, -2.30, 0.85, 0.022, C.cupHi, 0.55, 900);
arcStroke(SAU.x, SAU.y, SAU.r * 0.940, 0.92, 0.75, 0.020, C.cupHi, 0.20, 900);
arcStroke(SAU.x, SAU.y, SAU.r * 0.680, -2.10, 0.80, 0.010, C.cupHi, 0.22, 1200);

// cup contact shadow on the saucer well (directional)
addShape(CUP.x - 0.50, CUP.y - 0.50, CUP.x + 0.50, CUP.y + 0.50, (px, py, o) => {
  const d = sdCircle(px, py, CUP.x, CUP.y, CUP.r * 1.04);
  if (d > 0.09) return;
  const dx = px - CUP.x, dy = py - CUP.y;
  const n = Math.sqrt(dx * dx + dy * dy) || 1e-6;
  const s = (dx * LIGHT.x + dy * LIGHT.y) / n;
  const a = 0.30 * (1 - smooth(d / 0.09)) * (0.55 + 0.45 * (0.5 - 0.5 * s));
  if (a <= 0) return;
  o.a = a; o.r = C.shadow1[0]; o.g = C.shadow1[1]; o.b = C.shadow1[2];
});

// handle (right side): ceramic loop, drawn under the cup body
{
  const hx0 = CUP.x + CUP.r * 0.88, hy0 = CUP.y;
  const hr = 0.098, hw = 0.062;
  const m = hr + hw + marginFor(AA) + 0.01;
  // handle shadow on saucer
  addShape(hx0 - m + 0.012, hy0 - m + 0.016, hx0 + m + 0.012, hy0 + m + 0.016, (px, py, o) => {
    const d = sdArc(px - 0.012, py - 0.016, hx0, hy0, hr, 0, 1.30, hw * 1.10);
    const a = clamp(0.5 - d * AA, 0, 1) * 0.22;
    if (a <= 0) return;
    o.a = a; o.r = C.shadow1[0]; o.g = C.shadow1[1]; o.b = C.shadow1[2];
  });
  addShape(hx0 - m, hy0 - m, hx0 + m, hy0 + m, (px, py, o) => {
    const d = sdArc(px, py, hx0, hy0, hr, 0, 1.30, hw);
    const a = clamp(0.5 - d * AA, 0, 1);
    if (a <= 0) return;
    const ang = Math.atan2(py - hy0, px - hx0);
    const s = Math.cos(ang - 0.9); // simple directional shading over the loop
    const c = mixC(C.cupLo, C.cupHi, 0.5 + 0.5 * s);
    o.a = a; o.r = c[0]; o.g = c[1]; o.b = c[2];
  });
  // inner shade where the loop meets its hole
  arcStroke(hx0, hy0, hr - hw * 0.42, 0.55, 1.15, 0.016, C.cupLo, 0.45, 1100);
}

// cup outer wall: white ceramic, radial + directional shading
addShape(CUP.x - CUP.r - 0.01, CUP.y - CUP.r - 0.01, CUP.x + CUP.r + 0.01, CUP.y + CUP.r + 0.01, (px, py, o) => {
  const d = sdCircle(px, py, CUP.x, CUP.y, CUP.r);
  const a = clamp(0.5 - d * AA, 0, 1);
  if (a <= 0) return;
  const dx = px - CUP.x, dy = py - CUP.y;
  const n = Math.sqrt(dx * dx + dy * dy) || 1e-6;
  const t = clamp((dx * LIGHT.x + dy * LIGHT.y) / (CUP.r * 1.7) + 0.5, 0, 1);
  let c = mixC(C.cupLo, C.cupHi, t);
  const rn = n / CUP.r;
  c = mixC(c, C.cupEdge, smooth((rn - 0.88) / 0.12) * 0.6); // outer edge turn
  const sh = (0.5 + 0.5 * (dx * LIGHT.x + dy * LIGHT.y) / n) * 8 - 4;
  o.a = a; o.r = c[0] + sh; o.g = c[1] + sh * 0.9; o.b = c[2] + sh * 0.7;
});
// ceramic rim specular arc (upper left)
arcStroke(CUP.x, CUP.y, CUP.r * 0.955, -2.25, 0.80, 0.018, hx('#FFFFFF'), 0.45, 1000);
arcStroke(CUP.x, CUP.y, CUP.r * 0.870, -2.45, 0.55, 0.009, hx('#FFFFFF'), 0.22, 1200);

// contact shadow line right at the coffee edge (recessed liquid), strongest
// on the side away from the light
addShape(CAF.x - 0.36, CAF.y - 0.36, CAF.x + 0.36, CAF.y + 0.36, (px, py, o) => {
  const d = sdCircle(px, py, CAF.x, CAF.y, CAF.r);
  if (d < -0.002 || d > 0.030) return;
  const dx = px - CAF.x, dy = py - CAF.y;
  const n = Math.sqrt(dx * dx + dy * dy) || 1e-6;
  const s = (dx * LIGHT.x + dy * LIGHT.y) / n;
  const band = 1 - smooth(d / 0.026);
  const a = 0.20 * band * (0.45 + 0.55 * (0.5 - 0.5 * s));
  if (a <= 0) return;
  o.a = a; o.r = C.meniscus[0]; o.g = C.meniscus[1]; o.b = C.meniscus[2];
});

// coffee surface: radial crema gradient + directional light + meniscus
addShape(CAF.x - CAF.r - 0.01, CAF.y - CAF.r - 0.01, CAF.x + CAF.r + 0.01, CAF.y + CAF.r + 0.01, (px, py, o) => {
  const d = sdCircle(px, py, CAF.x, CAF.y, CAF.r);
  const a = clamp(0.5 - d * AA, 0, 1);
  if (a <= 0) return;
  const dx = px - CAF.x, dy = py - CAF.y;
  const rn = Math.sqrt(dx * dx + dy * dy) / CAF.r;
  let c = mixC(C.coffeeIn, C.coffeeMid, smooth((rn - 0.10) / 0.75));
  c = mixC(c, C.coffeeOut, smooth((rn - 0.72) / 0.28));
  const s = (dx * LIGHT.x + dy * LIGHT.y) / (Math.sqrt(dx * dx + dy * dy) || 1e-6);
  c = mixC(c, C.cremaSwirl, 0.16 * (0.5 + 0.5 * s));
  c = mixC(c, C.meniscus, smooth((rn - 0.88) / 0.12) * 0.75); // dark edge pool
  o.a = a; o.r = c[0]; o.g = c[1]; o.b = c[2];
});

// crema swirls under the rosetta (clipped to the coffee)
const clipCaf: [number, number, number] = [CAF.x, CAF.y, CAF.r - 0.004];
blob(0.395, 0.400, 0.105, C.cremaSwirl, 0.16, 120, clipCaf);
blob(0.615, 0.385, 0.095, C.cremaSwirl, 0.14, 120, clipCaf);
blob(0.410, 0.625, 0.095, C.cremaSwirl, 0.14, 120, clipCaf);
blob(0.620, 0.640, 0.105, C.cremaSwirl, 0.16, 120, clipCaf);
blob(0.505, 0.295, 0.075, C.cremaSwirl, 0.12, 120, clipCaf);
blob(0.505, 0.705, 0.070, C.cremaSwirl, 0.12, 120, clipCaf);
blob(CAF.x, CAF.y, 0.16, hx('#B57E3F'), 0.10, 90, clipCaf);
arcStroke(CAF.x, CAF.y, CAF.r * 0.845, -1.9, 1.0, 0.034, C.cremaSwirl, 0.13, 260);
arcStroke(CAF.x, CAF.y, CAF.r * 0.760, 0.9, 0.9, 0.030, C.cremaSwirl, 0.11, 260);

// ---------------------------------------------------------------- rosetta latte art
const ROX = 0.505;
const STEM_TOP = 0.430; // stem reaches up into the heart cleft
const STEM_BOT = 0.700;
const HEART = { x: ROX, y: 0.398, s: 1.0 };

function heartD(px: number, py: number) {
  const lx = px - HEART.x, ly = (py - HEART.y); // point-up heart
  const c1 = sdCircle(lx, ly, -0.0225, 0.013, 0.0270);
  const c2 = sdCircle(lx, ly, 0.0225, 0.013, 0.0270);
  const tri = makeConvex([[-0.030, 0.018], [0.030, 0.018], [0.0, -0.044]]);
  return smin(smin(c1, c2, 0.018), tri(lx, ly) - 0.009, 0.018);
}
// heart shadow, then heart foam
{
  const m = 0.11;
  addShape(HEART.x - m, HEART.y - m, HEART.x + m, HEART.y + m, (px, py, o) => {
    const d = heartD(px - 0.004, py - 0.006);
    let a = clamp(0.5 - d * 620, 0, 1) * 0.40;
    if (a <= 0) return;
    a *= discCov(px, py, clipCaf[0], clipCaf[1], clipCaf[2] + 1.5 / AA);
    if (a <= 0) return;
    o.a = a; o.r = C.shadow1[0]; o.g = C.shadow1[1]; o.b = C.shadow1[2];
  });
  addShape(HEART.x - m, HEART.y - m, HEART.x + m, HEART.y + m, (px, py, o) => {
    const d = heartD(px, py);
    let a = clamp(0.5 - d * 1500, 0, 1);
    if (a <= 0) return;
    a *= discCov(px, py, clipCaf[0], clipCaf[1], clipCaf[2] + 1.5 / AA);
    if (a <= 0) return;
    // slight cream shading toward the lower edge of the foam
    const ly = py - HEART.y;
    const c = mixC(C.foam, C.foamLo, smooth((ly - 0.005) / 0.055) * 0.45);
    o.a = a; o.r = c[0]; o.g = c[1]; o.b = c[2];
  });
}
// rosetta: fat cream crescents stacked up the center, each one crossing it;
// every leaf's soft under-shadow draws over the leaf below, leaving the thin
// brown chevron seams a real rosetta shows. A white stem column fills the
// center under the leaves, and the pull-through groove is dragged over all of
// it, ending in a small nick at the heart.
{
  // stem column (under the leaves), tapering to nothing at both ends
  const stem = sampleQuad([ROX, STEM_BOT], [ROX - 0.006, 0.560], [ROX, STEM_TOP], 12);
  const sws: number[] = [];
  for (let i = 0; i < stem.length; i++) {
    const u = i / (stem.length - 1);
    sws.push((0.0160 - 0.0055 * u) * Math.min(1, u * 8) * Math.min(1, (1 - u) * 6));
  }
  taperedStroke(stem.map((p) => [p[0] + 0.004, p[1] + 0.006]), sws.map((w) => w * 1.22), C.shadow1, 0.34, 560, clipCaf);
  taperedStroke(stem, sws, C.foam, 1.0, 1250, clipCaf, (px, py) =>
    mixC(C.foam, C.foamLo, smooth((py - 0.52) / 0.20) * 0.4));

  const N = 9;
  for (let k = 0; k < N; k++) {
    const t = k / (N - 1);
    const yk = 0.676 - 0.0276 * k;
    const L = 0.106 * (1 - 0.70 * t) * (k % 2 === 1 ? 0.955 : 1.0);
    const wb = 0.034 * (1 - 0.62 * t) + 0.007;
    // one continuous crescent from the left tip, through the center, to the right
    const p0 = [ROX - L, yk + L * 0.14];
    const p1 = [ROX, yk - L * 0.18];
    const p2 = [ROX + L, yk + L * 0.14];
    const pts = sampleQuad(p0, p1, p2, 13);
    const ws: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const u = i / (pts.length - 1);
      ws.push(wb * (1 - 0.70 * u * u));
    }
    // under-shadow (foam sits proud of the crema)
    taperedStroke(
      pts.map((p) => [p[0] + 0.004, p[1] + 0.006]),
      ws.map((w) => w * 1.20),
      C.shadow1, 0.40, 560, clipCaf,
    );
    // foam, cream-shaded toward the drooping lower edge
    taperedStroke(pts, ws, C.foam, 1.0, 1250, clipCaf, (px, py) =>
      mixC(C.foam, C.foamLo, smooth((py - (yk - 0.02 * L)) / (0.20 * L + 0.025)) * 0.5));
  }

  // pull-through groove: a thin coffee line dragged up the white column,
  // fading to nothing at both ends
  taperedStroke(
    stem,
    sws.map((w) => w * 0.20),
    C.grove, 0.70, 1500, clipCaf,
    undefined,
  );
  // the drag ends in a small nick where the stem meets the heart
  taperedStroke(
    sampleQuad([ROX, 0.434], [ROX - 0.001, 0.428], [ROX, 0.423], 8),
    [0.0050, 0.0044, 0.0038, 0.0030, 0.0023, 0.0017, 0.0011, 0.0006, 0.0004],
    C.grove, 0.90, 1500, clipCaf,
  );
}
// microfoam bubbles at the coffee edge (small, soft, dim)
{
  const bub: number[][] = [
    [0.352, 0.418, 0.0055, 0.40], [0.648, 0.408, 0.0060, 0.45], [0.612, 0.560, 0.0045, 0.35],
    [0.385, 0.590, 0.0050, 0.40], [0.555, 0.298, 0.0040, 0.30], [0.448, 0.292, 0.0036, 0.28],
    [0.668, 0.486, 0.0050, 0.35], [0.336, 0.502, 0.0040, 0.30], [0.505, 0.742, 0.0055, 0.38],
    [0.572, 0.672, 0.0040, 0.30], [0.428, 0.678, 0.0036, 0.28], [0.298, 0.445, 0.0034, 0.25],
    [0.712, 0.438, 0.0032, 0.25], [0.608, 0.342, 0.0032, 0.28],
  ];
  for (const [x, y, r, a0] of bub) disc(x, y, r, hx('#EFE2C8'), 1600, a0 * 0.8);
}

// gloss: specular arc across the liquid near the rim (upper left)
arcStroke(CAF.x, CAF.y, CAF.r * 0.900, -2.20, 0.95, 0.030, C.specWarm, 0.34, 800);
arcStroke(CAF.x, CAF.y, CAF.r * 0.925, -2.28, 0.55, 0.012, hx('#FFF4DC'), 0.60, 1200);
// faint counter-reflection, lower right
arcStroke(CAF.x, CAF.y, CAF.r * 0.905, 0.95, 0.45, 0.010, hx('#FFDFAE'), 0.16, 1200);

// ---------------------------------------------------------------- coffee beans
function bean(bx: number, by: number, rot: number, scale: number) {
  const ca = Math.cos(rot), sa = Math.sin(rot);
  const local = (px: number, py: number) => {
    const dx = px - bx, dy = py - by;
    return [dx * ca + dy * sa, -dx * sa + dy * ca];
  };
  const rx = 0.052 * scale, ry = 0.034 * scale;
  // drop shadow
  {
    const m = rx + 0.02;
    addShape(bx - m + 0.010, by - m + 0.017, bx + m + 0.010, by + m + 0.017, (px, py, o) => {
      const [lx, ly] = local(px - 0.010, py - 0.017);
      const d = sdEllipse(lx, ly, 0, 0, rx * 1.06, ry * 1.10);
      const a = clamp(0.5 - d * 320, 0, 1) * 0.32;
      if (a <= 0) return;
      o.a = a; o.r = C.shadow1[0]; o.g = C.shadow1[1]; o.b = C.shadow1[2];
    });
  }
  const m = rx + 0.015;
  addShape(bx - m, by - m, bx + m, by + m, (px, py, o) => {
    const [lx, ly] = local(px, py);
    const d = sdEllipse(lx, ly, 0, 0, rx, ry);
    const a = clamp(0.5 - d * AA, 0, 1);
    if (a <= 0) return;
    // roast shading: lighter toward the light, darker rim
    const t = clamp((lx * LIGHT.x + ly * LIGHT.y) / (rx * 1.8) + 0.5, 0, 1);
    let c = mixC(C.beanA, C.beanB, t);
    const rn = Math.sqrt((lx / rx) * (lx / rx) + (ly / ry) * (ly / ry));
    c = mixC(c, C.beanCrease, smooth((rn - 0.62) / 0.42) * 0.5);
    o.a = a; o.r = c[0]; o.g = c[1]; o.b = c[2];
  });
  // center crease: slight S-curve along the long axis
  {
    const crease = sampleQuad([-rx * 0.86, 0], [-rx * 0.15, ry * 0.30], [rx * 0.86, 0], 10);
    taperedStroke(
      crease.map((p) => {
        const wx = bx + p[0] * ca - p[1] * sa;
        const wy = by + p[0] * sa + p[1] * ca;
        return [wx, wy];
      }),
      Array(11).fill(0.0062 * scale),
      C.beanCrease, 0.85, 1400,
    );
    // glossy highlight on the upper face
    const hi = sampleQuad([-rx * 0.45, -ry * 0.42], [0, -ry * 0.62], [rx * 0.45, -ry * 0.40], 8);
    taperedStroke(
      hi.map((p) => {
        const wx = bx + p[0] * ca - p[1] * sa;
        const wy = by + p[0] * sa + p[1] * ca;
        return [wx, wy];
      }),
      Array(9).fill(0.0080 * scale),
      hx('#C99A66'), 0.40, 900,
    );
  }
}
bean(0.160, 0.845, -0.42, 1.0);
bean(0.245, 0.912, 0.35, 0.88);

// ---------------------------------------------------------------- render
const t0 = Date.now();
const bg = new Float64Array(3);
const bgRow = new Float64Array(W * 3);
const acc = new Float64Array(W * 3);
const curBytes = Buffer.alloc(W * 3);
const prevBytes = Buffer.alloc(W * 3);
const filtBuf = Buffer.alloc(W * 3);
const raw = Buffer.alloc(H * (1 + W * 3));
const nShapes = shapes.length;

// per-row adaptive filter selection (minimum sum of absolute differences)
function filterScore(f: number, cur: Buffer, prev: Buffer, buf: Buffer) {
  let score = 0;
  for (let i = 0; i < buf.length; i++) {
    const x = cur[i];
    const a = i >= 3 ? cur[i - 3] : 0;
    const b = prev[i];
    const c = i >= 3 ? prev[i - 3] : 0;
    let v: number;
    if (f === 0) v = x;
    else if (f === 1) v = x - a;
    else if (f === 2) v = x - b;
    else if (f === 3) v = x - ((a + b - c) >> 1);
    else {
      const p = a + b - c;
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      v = x - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
    }
    buf[i] = v & 255;
    score += v < 128 ? v : 256 - v;
  }
  return score;
}

for (let y = 0; y < H; y++) {
  const yc = (y + 0.5) / H;
  for (let x = 0; x < W; x++) {
    background((x + 0.5) / W, yc, bg);
    bgRow[x * 3] = bg[0]; bgRow[x * 3 + 1] = bg[1]; bgRow[x * 3 + 2] = bg[2];
  }
  acc.fill(0);
  for (let sy = 0; sy < SS; sy++) {
    const py = (y + (sy + 0.5) / SS) / H;
    for (let sx = 0; sx < SS; sx++) {
      for (let x = 0; x < W; x++) {
        const px = (x + (sx + 0.5) / SS) / W;
        let r = bgRow[x * 3], g = bgRow[x * 3 + 1], b = bgRow[x * 3 + 2];
        for (let i = 0; i < nShapes; i++) {
          const s = shapes[i];
          if (px < s.x0 || px > s.x1 || py < s.y0 || py > s.y1) continue;
          out.a = 0;
          s.f(px, py, out);
          const a = out.a;
          if (a > 0) {
            const ia = 1 - a;
            r = out.r * a + r * ia;
            g = out.g * a + g * ia;
            b = out.b * a + b * ia;
          }
        }
        acc[x * 3] += r; acc[x * 3 + 1] += g; acc[x * 3 + 2] += b;
      }
    }
  }
  for (let i = 0; i < W * 3; i++) {
    curBytes[i] = clamp(Math.round(acc[i] / (SS * SS)), 0, 255);
  }
  const rowStart = y * (1 + W * 3);
  let bestF = 0, bestScore = Infinity;
  for (let f = 0; f <= 4; f++) {
    const sc = filterScore(f, curBytes, prevBytes, filtBuf);
    if (sc < bestScore) {
      bestScore = sc;
      bestF = f;
      raw.set(filtBuf, rowStart + 1);
    }
  }
  raw[rowStart] = bestF;
  curBytes.copy(prevBytes);
}

// ---------------------------------------------------------------- PNG encode
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}
function chunk(type: string, data: Buffer) {
  const o = Buffer.alloc(12 + data.length);
  o.writeUInt32BE(data.length, 0);
  o.write(type, 4, 'ascii');
  data.copy(o, 8);
  o.writeUInt32BE(crc32(o.subarray(4, 8 + data.length)), 8 + data.length);
  return o;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 2;  // color type: truecolor RGB
ihdr[10] = 0; // compression
ihdr[11] = 0; // filter method
ihdr[12] = 0; // interlace

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const outDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';
const outPath = join(outDir, 'entry.png');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, png);
console.log(`wrote ${outPath}: ${png.length} bytes, ${W}x${H}, in ${Date.now() - t0} ms`);
