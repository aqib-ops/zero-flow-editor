/**
 * Generates `build/icon.png` (512x512) — the Zero Flow mark.
 *
 * A machined graphite tile with a single electric-indigo play/flow glyph,
 * matching the Precision Graphite palette in `src/styles.css`. Rendered at 4x
 * and box-filtered down so the edges and the glyph corners are properly
 * anti-aliased when Windows scales it to 16px in the taskbar.
 *
 * Run: node scripts/make-icon.mjs
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = 512;
const SS = 4;
const S = OUT * SS;
const RADIUS = 116;

// Gradient stops, top -> bottom.
const BG_TOP = [39, 43, 52];
const BG_BOTTOM = [20, 22, 27];
// Glyph, left -> right: electric blue -> violet.
const GLYPH_A = [108, 140, 255];
const GLYPH_B = [158, 123, 255];

// Play triangle, in 512-space.
const TRI = [
  [228, 144],
  [228, 368],
  [402, 256],
];
// Two speed bars to its left: [x0, x1, y, radius].
const BARS = [
  [110, 190, 214, 20],
  [146, 190, 298, 20],
];

const lerp = (a, b, t) => a + (b - a) * t;

function sign(px, py, ax, ay, bx, by) {
  return (px - ax) * (by - ay) - (py - ay) * (bx - ax);
}

function inTriangle(px, py) {
  const [[x1, y1], [x2, y2], [x3, y3]] = TRI;
  const d1 = sign(px, py, x1, y1, x2, y2);
  const d2 = sign(px, py, x2, y2, x3, y3);
  const d3 = sign(px, py, x3, y3, x1, y1);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

function inBar(px, py) {
  for (const [x0, x1, y, r] of BARS) {
    // Horizontal capsule: distance to the segment [x0,x1] at height y.
    const cx = Math.max(x0, Math.min(x1, px));
    const dx = px - cx;
    const dy = py - y;
    if (dx * dx + dy * dy <= r * r) return true;
  }
  return false;
}

const px = Buffer.alloc(S * S * 4);

for (let y = 0; y < S; y++) {
  const fy = ((y + 0.5) / S) * OUT;
  for (let x = 0; x < S; x++) {
    const fx = ((x + 0.5) / S) * OUT;
    const i = (y * S + x) * 4;

    // Rounded-square SDF — transparent outside the tile.
    const qx = Math.abs(fx - OUT / 2) - OUT / 2 + RADIUS;
    const qy = Math.abs(fy - OUT / 2) - OUT / 2 + RADIUS;
    const dist =
      Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) +
      Math.min(Math.max(qx, qy), 0) -
      RADIUS;
    if (dist > 0) continue;

    const t = fy / OUT;
    // Diagonal sheen so the tile reads as brushed metal, not flat fill.
    const sheen = (1 - (fx + fy) / (2 * OUT)) * 11;

    let r = lerp(BG_TOP[0], BG_BOTTOM[0], t) + sheen;
    let g = lerp(BG_TOP[1], BG_BOTTOM[1], t) + sheen;
    let b = lerp(BG_TOP[2], BG_BOTTOM[2], t) + sheen;

    if (inTriangle(fx, fy) || inBar(fx, fy)) {
      const gt = Math.min(1, Math.max(0, (fx - 90) / (402 - 90)));
      r = lerp(GLYPH_A[0], GLYPH_B[0], gt);
      g = lerp(GLYPH_A[1], GLYPH_B[1], gt);
      b = lerp(GLYPH_A[2], GLYPH_B[2], gt);
    }

    px[i] = Math.max(0, Math.min(255, Math.round(r)));
    px[i + 1] = Math.max(0, Math.min(255, Math.round(g)));
    px[i + 2] = Math.max(0, Math.min(255, Math.round(b)));
    px[i + 3] = 255;
  }
}

// Box-filter down, averaging premultiplied colour so transparent corners do not
// bleed black into the tile edge.
const out = Buffer.alloc(OUT * OUT * 4);
for (let y = 0; y < OUT; y++) {
  for (let x = 0; x < OUT; x++) {
    let ar = 0;
    let ag = 0;
    let ab = 0;
    let aa = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const i = ((y * SS + sy) * S + (x * SS + sx)) * 4;
        const a = px[i + 3];
        ar += px[i] * a;
        ag += px[i + 1] * a;
        ab += px[i + 2] * a;
        aa += a;
      }
    }
    const o = (y * OUT + x) * 4;
    if (aa === 0) continue;
    out[o] = Math.round(ar / aa);
    out[o + 1] = Math.round(ag / aa);
    out[o + 2] = Math.round(ab / aa);
    out[o + 3] = Math.round(aa / (SS * SS));
  }
}

// ── PNG encode (8-bit RGBA, filter 0) ────────────────────────────────────────
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(OUT, 0);
ihdr.writeUInt32BE(OUT, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // colour type: RGBA
// compression / filter / interlace = 0

const raw = Buffer.alloc(OUT * (OUT * 4 + 1));
for (let y = 0; y < OUT; y++) {
  raw[y * (OUT * 4 + 1)] = 0;
  out.copy(raw, y * (OUT * 4 + 1) + 1, y * OUT * 4, (y + 1) * OUT * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(root, "build", "icon.png");
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, png);
console.log(`wrote ${target} (${png.length} bytes, ${OUT}x${OUT})`);
