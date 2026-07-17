import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const buildDir = path.join(root, 'build');

function hexToRgb(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return [r, g, b];
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function gradientColor(c1, c2, t) {
  return [
    Math.round(lerp(c1[0], c2[0], t)),
    Math.round(lerp(c1[1], c2[1], t)),
    Math.round(lerp(c1[2], c2[2], t)),
  ];
}

function dist(x1, y1, x2, y2) {
  return Math.sqrt((x1 - x2) ** 2 + (y1 - y2) ** 2);
}

function createBMP(width, height, getPixel) {
  const rowBytes = Math.ceil(width * 3 / 4) * 4;
  const pixelOffset = 54;
  const fileSize = pixelOffset + rowBytes * height;
  const buf = Buffer.alloc(fileSize);

  buf.write('BM', 0);
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(pixelOffset, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = getPixel(x, y);
      const offset = pixelOffset + (height - 1 - y) * rowBytes + x * 3;
      buf.writeUInt8(clamp(b, 0, 255), offset);
      buf.writeUInt8(clamp(g, 0, 255), offset + 1);
      buf.writeUInt8(clamp(r, 0, 255), offset + 2);
    }
  }

  return buf;
}

const SURFACE = hexToRgb('#161b22');
const ACCENT_1 = hexToRgb('#7c5cff');
const ACCENT_2 = hexToRgb('#4da3ff');

function makeSmallImage() {
  const W = 55, H = 58;
  const cx = 28, cy = 29, r = 16;

  const tentacles = [
    { angle: -1.2, len: 10, width: 2 },
    { angle: 1.2, len: 10, width: 2 },
    { angle: -0.4, len: 12, width: 1.8 },
    { angle: 0.4, len: 12, width: 1.8 },
    { angle: -1.8, len: 9, width: 1.5 },
    { angle: 1.8, len: 9, width: 1.5 },
  ];

  return createBMP(W, H, (x, y) => {
    const d = dist(x, y, cx, cy);

    for (const t of tentacles) {
      for (let step = 0; step <= 1; step += 0.03) {
        const bx = cx + Math.cos(t.angle + step) * t.len * step;
        const by = cy + Math.sin(t.angle + step) * t.len * step * 0.6;
        if (dist(x, y, bx, by) < t.width * (1 - step * 0.5)) {
          return gradientColor(ACCENT_1, ACCENT_2, step);
        }
      }
    }

    if (d < r) {
      const t = (y - (cy - r)) / (r * 2);
      const col = gradientColor(ACCENT_1, ACCENT_2, clamp(t, 0, 1));
      const alpha = 1 - (d / r) * 0.2;
      return [
        Math.round(col[0] * alpha + SURFACE[0] * (1 - alpha)),
        Math.round(col[1] * alpha + SURFACE[1] * (1 - alpha)),
        Math.round(col[2] * alpha + SURFACE[2] * (1 - alpha)),
      ];
    }

    return SURFACE;
  });
}

if (!existsSync(buildDir)) mkdirSync(buildDir, { recursive: true });

writeFileSync(path.join(buildDir, 'wizard-small.bmp'), makeSmallImage());
console.log('[installer-bmps] build/wizard-small.bmp generado (55×58)');
console.log('[installer-bmps] wizard-image.bmp: reusa build/installer-sidebar.bmp');
console.log('[installer-bmps] OK');
