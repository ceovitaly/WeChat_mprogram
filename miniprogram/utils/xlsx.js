// Minimal, dependency-free .xlsx (OOXML) writer.
//
// An .xlsx is a ZIP archive of XML parts. We used to emit SpreadsheetML (Excel
// XML 2003) into a file named .xls — some viewers coped, others showed an error
// or rendered the whole thing as one raw line. A real .xlsx opens everywhere.
//
// rows: array of arrays. Numbers become numeric cells, everything else text.
// Rows may be empty ([]) or short — missing trailing cells are simply absent.

// ---------------------------------------------------------------- XML helpers

// Strip chars illegal in XML 1.0 (control chars < 0x20 except tab/LF/CR).
// One stray control char in a guest name corrupts the whole file.
const esc = (s) => String(s)
  .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

// 0 -> A, 25 -> Z, 26 -> AA, 701 -> ZZ, 702 -> AAA (bijective base-26).
const colLetter = (i) => {
  let s = ''
  for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) {
    s = String.fromCharCode(65 + (n % 26)) + s
  }
  return s
}

// Only genuine numbers become numeric cells. Numeric-LOOKING strings stay text
// on purpose: phone numbers are all digits, and as Number Excel shows them as
// 1.38E+10 and strips leading zeros. Pass a real number for a numeric cell.
const cell = (v, ref) => {
  if (v === null || v === undefined || v === '') return ''
  if (typeof v === 'number' && isFinite(v)) {
    return '<c r="' + ref + '"><v>' + v + '</v></c>'
  }
  // Inline strings keep us free of a sharedStrings.xml part.
  return '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' +
    esc(v) + '</t></is></c>'
}

const sheetXml = (rows) => {
  const body = rows.map((row, r) =>
    '<row r="' + (r + 1) + '">' +
    (row || []).map((v, c) => cell(v, colLetter(c) + (r + 1))).join('') +
    '</row>'
  ).join('')
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetData>' + body + '</sheetData></worksheet>'
}

// ------------------------------------------------------------- bytes and CRC

// TextEncoder is not guaranteed in the mini-program runtime, so encode by hand.
const utf8 = (str) => {
  const out = []
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      // surrogate pair -> single code point
      c = 0x10000 + ((c - 0xd800) << 10) + (str.charCodeAt(++i) - 0xdc00)
    }
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return new Uint8Array(out)
}

// Standard table-driven CRC-32 (polynomial 0xEDB88320), as ZIP requires.
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    t[i] = c
  }
  return t
})()

const crc32 = (bytes) => {
  let c = -1
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

// ------------------------------------------------------------------ ZIP writer
//
// STORED entries only (compression method 0 — no deflate). These parts are a few
// KB; implementing deflate to save nothing would be code nobody can debug at 3am.
//
// Layout:
//   [local header + name + data] x N     signature 0x04034b50
//   [central directory header + name] x N signature 0x02014b50
//   [end of central directory]            signature 0x06054b50
// Everything is little-endian. The central directory repeats each entry's
// metadata plus the byte offset of its local header — that's what readers index on.

const zip = (files) => {
  const out = []                                   // byte accumulator
  const u8 = (v) => out.push(v & 0xff)
  const u16 = (v) => { u8(v); u8(v >>> 8) }
  const u32 = (v) => { u16(v); u16(v >>> 16) }
  const bytes = (b) => { for (let i = 0; i < b.length; i++) out.push(b[i]) }

  // Bit 11 = filenames/content are UTF-8. No DOS timestamp — 0 is legal.
  const FLAG_UTF8 = 0x0800
  const entries = files.map((f) => {
    const name = utf8(f.name)
    const data = utf8(f.data)
    const offset = out.length
    u32(0x04034b50)          // local file header signature
    u16(20)                  // version needed to extract (2.0)
    u16(FLAG_UTF8)           // general purpose bit flag
    u16(0)                   // compression method: 0 = stored
    u16(0); u16(0)           // last mod time, date
    const crc = crc32(data)
    u32(crc)
    u32(data.length)         // compressed size (== uncompressed, stored)
    u32(data.length)         // uncompressed size
    u16(name.length)         // file name length
    u16(0)                   // extra field length
    bytes(name)
    bytes(data)
    return { name, crc, size: data.length, offset }
  })

  const cdStart = out.length
  entries.forEach((e) => {
    u32(0x02014b50)          // central directory file header signature
    u16(20)                  // version made by
    u16(20)                  // version needed to extract
    u16(FLAG_UTF8)
    u16(0)                   // stored
    u16(0); u16(0)           // time, date
    u32(e.crc)
    u32(e.size); u32(e.size)
    u16(e.name.length)
    u16(0); u16(0)           // extra len, comment len
    u16(0)                   // disk number start
    u16(0)                   // internal file attributes
    u32(0)                   // external file attributes
    u32(e.offset)            // offset of local header
    bytes(e.name)
  })

  const cdSize = out.length - cdStart   // measure before the EOCD itself is added
  u32(0x06054b50)            // end of central directory
  u16(0); u16(0)             // this disk, disk with CD
  u16(entries.length); u16(entries.length)
  u32(cdSize)                // size of central directory
  u32(cdStart)               // offset of central directory
  u16(0)                     // comment length

  return new Uint8Array(out)
}

// ------------------------------------------------------------------- workbook

const buildXlsx = (rows, sheetName) => zip([
  {
    name: '[Content_Types].xml',
    data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '</Types>'
  },
  {
    name: '_rels/.rels',
    data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>'
  },
  {
    name: 'xl/workbook.xml',
    data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="' + esc(sheetName || 'Sheet1').slice(0, 31) +
      '" sheetId="1" r:id="rId1"/></sheets></workbook>'
  },
  {
    name: 'xl/_rels/workbook.xml.rels',
    data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '</Relationships>'
  },
  { name: 'xl/worksheets/sheet1.xml', data: sheetXml(rows) }
])

// Writes the rows to a temp .xlsx and opens it in the system viewer.
// Name kept as openAsXls so call sites don't change.
const openAsXls = (rows, fileBaseName, sheetName) => {
  const filePath = wx.env.USER_DATA_PATH + '/' + (fileBaseName || 'export') + '_' + Date.now() + '.xlsx'
  wx.getFileSystemManager().writeFile({
    filePath,
    // Binary: pass the ArrayBuffer and omit `encoding` entirely.
    data: buildXlsx(rows, sheetName).buffer,
    success: () => {
      wx.openDocument({
        filePath,
        fileType: 'xlsx',
        showMenu: true,
        fail: () => wx.showToast({ title: 'Export failed', icon: 'none' })
      })
    },
    fail: () => wx.showToast({ title: 'Export failed', icon: 'none' })
  })
}

module.exports = { buildXlsx, openAsXls, colLetter, crc32, zip }
