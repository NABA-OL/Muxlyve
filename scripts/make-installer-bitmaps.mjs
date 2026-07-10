// Desarrollado por BlacKraken Solutions (NABA-OL)
/**
 * Genera build/installer-sidebar.bmp (164×314) y build/installer-header.bmp (150×57)
 * con la paleta visual de Muxlyve. Sin dependencias externas.
 */
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT   = join(__dir, '../build');

// Paleta Muxlyve
const C = {
  bg:      [0x0d, 0x11, 0x17],
  surface: [0x16, 0x1b, 0x22],
  surface2:[0x1c, 0x22, 0x30],
  accent:  [0x7c, 0x5c, 0xff],
  accentD: [0x3d, 0x2e, 0x80],
  border:  [0x2a, 0x31, 0x40],
};

function lerp(a, b, t) { return Math.round(a + (b - a) * Math.max(0, Math.min(1, t))); }
function lerpRGB(c1, c2, t) { return c1.map((v, i) => lerp(v, c2[i], t)); }

/** BMP 24-bit bottom-up (estándar). pixelFn(x, y) → [r, g, b], y=0 es arriba. */
function makeBMP(w, h, pixelFn) {
  const rowPad  = (4 - ((w * 3) % 4)) % 4;
  const rowSize = w * 3 + rowPad;
  const buf     = Buffer.alloc(54 + rowSize * h, 0);

  buf[0] = 0x42; buf[1] = 0x4d;
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(h, 22);   // positivo = bottom-up (estándar)
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(rowSize * h, 34);

  for (let row = 0; row < h; row++) {
    const y = h - 1 - row; // fila en buffer → coordenada visual (0 = arriba)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = pixelFn(x, y);
      const off = 54 + row * rowSize + x * 3;
      buf[off] = b; buf[off + 1] = g; buf[off + 2] = r;
    }
  }
  return buf;
}

// ── Sidebar 164 × 314 ──────────────────────────────────────────────────────
//  Top 90px : degradado accent → surface
//  90–180px : surface → bg
//  180–314px: bg oscuro
//  Franja derecha 3px: accent
//  Franja inferior 3px: accent
const sidebar = makeBMP(164, 314, (x, y) => {
  const W = 164, H = 314;
  if (x >= W - 3) return C.accent;                        // franja dcha
  if (y >= H - 3) return C.accent;                        // franja inferior
  if (y < 90)     return lerpRGB(C.accent, C.surface, y / 90);
  if (y < 180)    return lerpRGB(C.surface, C.bg, (y - 90) / 90);
  return C.bg;
});

// ── Header 150 × 57 ────────────────────────────────────────────────────────
//  Fondo bg, franja izquierda 4px accent, línea inferior 2px accent
const header = makeBMP(150, 57, (x, y) => {
  const H = 57;
  if (x < 4)       return C.accent;                        // franja izda
  if (y >= H - 2)  return C.accent;                        // línea inferior
  if (x < 20)      return lerpRGB(C.surface2, C.bg, (x - 4) / 16);
  return C.bg;
});

writeFileSync(join(OUT, 'installer-sidebar.bmp'), sidebar);
writeFileSync(join(OUT, 'installer-header.bmp'),  header);
console.log('Bitmaps del instalador generados en build/.');
