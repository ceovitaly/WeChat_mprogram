// Minimal QR Code Model 2 encoder — byte mode, error-correction level M,
// versions 1-10 (up to ~210 data bytes; the door token is ~60). Pure JS, no
// platform APIs, so it runs identically in the mini-program and in Node tests.
//
// Design notes:
// - Fixed mask pattern 2. The spec allows ANY mask (the chosen id is encoded
//   in the format bits); penalty-based selection only optimizes readability
//   and is deliberately skipped — the door QR is large and high-contrast.
// - The output is a module matrix; rendering (canvas) is the page's job.

// ─── GF(256), polynomial 0x11D ───────────────────────────────────────────────
const GEXP = new Array(256)
const GLOG = new Array(256)
;(function initTables() {
  let x = 1
  for (let i = 0; i < 255; i++) {
    GEXP[i] = x
    GLOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 256; i++) GEXP[i] = GEXP[i - 255]
})()

const gmul = (a, b) => (a === 0 || b === 0) ? 0 : GEXP[(GLOG[a] + GLOG[b]) % 255]

function polyMul(a, b) {
  const out = new Array(a.length + b.length - 1).fill(0)
  for (let i = 0; i < a.length; i++) {
    if (!a[i]) continue
    for (let j = 0; j < b.length; j++) {
      if (b[j]) out[i + j] ^= gmul(a[i], b[j])
    }
  }
  return out
}

// Generator polynomial (x - α^0)(x - α^1)…(x - α^(ecLen-1)), monic.
function rsGenPoly(ecLen) {
  let poly = [1]
  for (let i = 0; i < ecLen; i++) poly = polyMul(poly, [1, GEXP[i % 255]])
  return poly
}

// Reed-Solomon remainder: data*poly(x^ecLen) mod generator.
function rsRemainder(data, ecLen) {
  const gen = rsGenPoly(ecLen)
  const res = data.concat(new Array(ecLen).fill(0))
  for (let i = 0; i < data.length; i++) {
    const coef = res[i]
    if (!coef) continue
    for (let j = 0; j < gen.length; j++) {
      if (gen[j]) res[i + j] ^= gmul(gen[j], coef)
    }
  }
  return res.slice(data.length)
}

// ─── version tables (EC level M only) ────────────────────────────────────────
// total = full codeword count; blocks = [numBlocks, dataPerBlock] (all M-level
// structures are uniform); EC codewords per block = (total - data) / numBlocks.
const VERSIONS = {
  1:  { total: 26,  data: 16,  blocks: [[1, 16]] },
  2:  { total: 44,  data: 28,  blocks: [[1, 28]] },
  3:  { total: 70,  data: 44,  blocks: [[1, 44]] },
  4:  { total: 100, data: 64,  blocks: [[2, 32]] },
  5:  { total: 134, data: 86,  blocks: [[2, 43]] },
  6:  { total: 172, data: 108, blocks: [[4, 27]] },
  7:  { total: 196, data: 124, blocks: [[4, 31]] },
  8:  { total: 242, data: 154, blocks: [[2, 38]] },
  9:  { total: 292, data: 182, blocks: [[3, 36]] },
  10: { total: 346, data: 216, blocks: [[4, 43]] }
}

// Byte-mode data capacity for level M (mode + count + terminator accounted).
const BYTE_CAPACITY_M = {
  1: 14, 2: 26, 3: 42, 4: 62, 5: 84, 6: 106, 7: 122, 8: 152, 9: 180, 10: 213
}

const ALIGNMENT = {
  2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
  7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50]
}

// UTF-8 encode (the token is ASCII, but be safe for any future content).
function toUtf8Bytes(str) {
  const out = []
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      c = 0x10000 + ((c - 0xd800) << 10) + (str.charCodeAt(++i) - 0xdc00)
    }
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return out
}

// Data bitstream → interleaved codeword array (data blocks + RS blocks).
function buildCodewords(bytes, version) {
  const spec = VERSIONS[version]
  const countBits = version <= 9 ? 8 : 16

  // Bit buffer with mode indicator + char count + payload + terminator.
  const bits = []
  const put = (value, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1)
  }
  put(4, 4) // byte mode
  put(bytes.length, countBits)
  bytes.forEach(b => put(b, 8))
  const capacityBits = spec.data * 8
  // Terminator: up to 4 zero bits, then byte-align.
  for (let i = 0; i < 4 && bits.length < capacityBits; i++) bits.push(0)
  while (bits.length % 8 !== 0) bits.push(0)
  const data = []
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]
    data.push(b)
  }
  // Pad codewords to capacity.
  const pads = [0xec, 0x11]
  let padIdx = 0
  while (data.length < spec.data) data.push(pads[padIdx++ % 2])

  // Split into blocks, compute RS per block, interleave.
  const blockCount = spec.blocks.reduce((n, [num]) => n + num, 0)
  const ecLen = Math.round((spec.total - spec.data) / blockCount)
  const blocks = []
  let offset = 0
  spec.blocks.forEach(([num, len]) => {
    for (let b = 0; b < num; b++) {
      const blockData = data.slice(offset, offset + len)
      offset += len
      blocks.push({ data: blockData, ec: rsRemainder(blockData, ecLen) })
    }
  })

  const out = []
  const maxData = Math.max.apply(null, blocks.map(b => b.data.length))
  for (let i = 0; i < maxData; i++) {
    blocks.forEach(b => { if (i < b.data.length) out.push(b.data[i]) })
  }
  const ecBlockLen = blocks[0].ec.length
  for (let i = 0; i < ecBlockLen; i++) {
    blocks.forEach(b => out.push(b.ec[i]))
  }
  return out
}

// ─── format / version info ───────────────────────────────────────────────────
function bitLength(v) {
  let n = 0
  while (v) { n++; v >>>= 1 }
  return n
}

// 15-bit format: 5 data bits (EC level '00' for M + 3 mask bits) + BCH + mask 0x5412.
function formatBits(maskId) {
  const data = (0 << 3) | maskId // EC level M = 00
  let d = data << 10
  while (bitLength(d) >= 11) d ^= 0b10100110111 << (bitLength(d) - 11)
  return (((data << 10) | d) ^ 0x5412) & 0x7fff
}

// 18-bit version info (only versions ≥ 7).
function versionBits(version) {
  let d = version << 12
  while (bitLength(d) >= 13) d ^= 0b1111100100101 << (bitLength(d) - 13)
  return ((version << 12) | d) & 0x3ffff
}

// ─── matrix construction ─────────────────────────────────────────────────────
function setupProbe(modules, n, row, col) {
  for (let r = -1; r <= 7; r++) {
    if (row + r < 0 || n <= row + r) continue
    for (let c = -1; c <= 7; c++) {
      if (col + c < 0 || n <= col + c) continue
      const dark = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                   (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
                   (r >= 2 && r <= 4 && c >= 2 && c <= 4)
      modules[row + r][col + c] = dark
    }
  }
}

const MASK_FN = [
  (i, j) => (i + j) % 2 === 0,
  (i) => i % 2 === 0,
  (i, j) => j % 3 === 0,
  (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
  (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
  (i, j) => (((i * j) % 3) + ((i + j) % 2)) % 2 === 0
]

// Builds the module matrix for `text`. Returns { size, modules, maskId, version }.
function createMatrix(text, maskId) {
  const mask = maskId === undefined ? 2 : maskId
  const bytes = toUtf8Bytes(String(text))
  let version = 0
  for (let v = 1; v <= 10; v++) {
    if (bytes.length <= BYTE_CAPACITY_M[v]) { version = v; break }
  }
  if (!version) throw new Error('qrCode: data too long for versions 1-10')

  const codewords = buildCodewords(bytes, version)
  const n = 17 + version * 4
  const modules = []
  for (let r = 0; r < n; r++) modules.push(new Array(n).fill(null))

  setupProbe(modules, n, 0, 0)
  setupProbe(modules, n, n - 7, 0)
  setupProbe(modules, n, 0, n - 7)

  // Alignment patterns (skip any overlapping the probes).
  const centers = ALIGNMENT[version] || []
  centers.forEach((row) => {
    centers.forEach((col) => {
      if (modules[row][col] !== null) return
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          modules[row + r][col + c] = (r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0))
        }
      }
    })
  })

  // Timing patterns.
  for (let i = 8; i < n - 8; i++) {
    if (modules[i][6] === null) modules[i][6] = i % 2 === 0
    if (modules[6][i] === null) modules[6][i] = i % 2 === 0
  }

  // Dark module. The format regions are reserved by their true extent only —
  // col/row 8 rows 0-8 & n-8..n-1; rows/cols 9-12 of strip 8 are DATA cells.
  modules[n - 8][8] = true

  // Reserve the format regions explicitly so mapData skips them.
  const fmtPositions = (n) => {
    const list = []
    for (let i = 0; i <= 8; i++) { list.push([i, 8]); list.push([8, i]) }
    for (let i = 0; i < 8; i++) { list.push([8, n - 1 - i]); list.push([n - 1 - i, 8]) }
    return list
  }
  fmtPositions(n).forEach(([r, c]) => { if (modules[r][c] === null) modules[r][c] = false })

  // Version info (v ≥ 7).
  if (version >= 7) {
    const vb = versionBits(version)
    for (let i = 0; i < 18; i++) {
      const bit = ((vb >> i) & 1) === 1
      const r = Math.floor(i / 3)
      const c = (i % 3) + n - 11
      modules[r][c] = bit
      modules[c][r] = bit
    }
  }

  // Payload zigzag placement (bottom-right, two-column pairs, skipping col 6).
  let inc = -1
  let row = n - 1
  let bitIndex = 7
  let byteIndex = 0
  for (let col = n - 1; col > 0; col -= 2) {
    if (col === 6) col--
    while (true) {
      for (let c = 0; c < 2; c++) {
        if (modules[row][col - c] === null) {
          let dark = false
          if (byteIndex < codewords.length) dark = ((codewords[byteIndex] >>> bitIndex) & 1) === 1
          if (MASK_FN[mask](row, col - c)) dark = !dark
          modules[row][col - c] = dark
          bitIndex--
          if (bitIndex === -1) { byteIndex++; bitIndex = 7 }
        }
      }
      row += inc
      if (row < 0 || row >= n) { row -= inc; inc = -inc; break }
    }
  }

  // Format info (final values, mask applied at write time is already in fmt).
  const fb = formatBits(mask)
  for (let i = 0; i < 15; i++) {
    const bit = ((fb >> i) & 1) === 1
    if (i < 6) modules[i][8] = bit
    else if (i < 8) modules[i + 1][8] = bit
    else modules[n - 15 + i][8] = bit
  }
  for (let i = 0; i < 15; i++) {
    const bit = ((fb >> i) & 1) === 1
    if (i < 8) modules[8][n - 1 - i] = bit
    else if (i < 9) modules[8][15 - i] = bit // col 7 → position 15-8+1=8
    else modules[8][15 - i - 1] = bit
  }
  modules[n - 8][8] = true // dark module, re-asserted after format writes

  return { size: n, modules, maskId: mask, version }
}

module.exports = { createMatrix, toUtf8Bytes }
