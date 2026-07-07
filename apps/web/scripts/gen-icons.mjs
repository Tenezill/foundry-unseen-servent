/**
 * Generates the PWA PNG icons (no dependencies — raw PNG encoding via zlib).
 * Run once: node scripts/gen-icons.mjs
 * Output: public/icons/icon-192.png, icon-512.png, icon-512-maskable.png,
 *         apple-touch-icon.png
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons')
mkdirSync(outDir, { recursive: true })

/* ---- minimal PNG encoder -------------------------------------------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** pixelFn(x, y) -> [r, g, b, a] */
function png(size, pixelFn) {
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1)
    raw[rowStart] = 0 // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelFn(x, y)
      const o = rowStart + 1 + x * 4
      raw[o] = r
      raw[o + 1] = g
      raw[o + 2] = b
      raw[o + 3] = a
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/* ---- the icon: amber d20 silhouette on dark rounded tile ------------------ */

const BG = [0x11, 0x13, 0x18]
const ACCENT = [0xe2, 0xa6, 0x3d]
const LINE = [0x6b, 0x4f, 0x1d]

function drawIcon(size, { pad = 0.16, cornerRadius = 0.22, fullBleed = false }) {
  const c = size / 2
  const rCorner = size * cornerRadius
  // hexagon (d20 silhouette) metrics
  const hexR = size * (0.5 - pad)

  function insideRoundedRect(x, y) {
    if (fullBleed) return true
    const dx = Math.max(rCorner - x, x - (size - 1 - rCorner), 0)
    const dy = Math.max(rCorner - y, y - (size - 1 - rCorner), 0)
    return dx * dx + dy * dy <= rCorner * rCorner
  }

  function insideHex(x, y, r) {
    const px = Math.abs(x - c)
    const py = Math.abs(y - c)
    // flat-top-ish hexagon: |y| <= r*cos30 and the slanted edges
    return py <= r * 0.866 && r * 0.866 * px + r * 0.5 * py <= r * r * 0.866
  }

  return png(size, (x, y) => {
    if (!insideRoundedRect(x, y)) return [0, 0, 0, 0]
    if (insideHex(x, y, hexR)) {
      // inner darker hex to give a facet feel
      if (insideHex(x, y, hexR * 0.55)) return [...LINE, 255]
      return [...ACCENT, 255]
    }
    return [...BG, 255]
  })
}

const targets = [
  ['icon-192.png', 192, { pad: 0.16 }],
  ['icon-512.png', 512, { pad: 0.16 }],
  ['icon-512-maskable.png', 512, { pad: 0.26, fullBleed: true }],
  ['apple-touch-icon.png', 180, { pad: 0.18, fullBleed: true }],
]

for (const [name, size, opts] of targets) {
  writeFileSync(join(outDir, name), drawIcon(size, opts))
  console.log(`wrote public/icons/${name} (${size}x${size})`)
}
