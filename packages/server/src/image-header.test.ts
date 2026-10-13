import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { imageDimensions, svgDeclaresColour } from "./image-header.ts"

// The scan ranks icons by size, so every wrong number here is a project wearing the wrong picture.
// These build each format's header by hand rather than checking in binaries: the point is to pin the
// byte offsets, and a fixture whose bytes you cannot read in the diff pins nothing.

function withFile(bytes: Buffer | string, name: string, assertion: (path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "ntwine-image-"))
  try {
    const path = join(directory, name)
    writeFileSync(path, bytes)
    assertion(path)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function png(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(33)
  buffer.writeUInt32BE(0x89504e47, 0)
  buffer.writeUInt32BE(0x0d0a1a0a, 4)
  buffer.writeUInt32BE(13, 8)
  buffer.write("IHDR", 12, "ascii")
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  return buffer
}

test("reads PNG dimensions from the IHDR chunk", () => {
  withFile(png(512, 512), "icon.png", (path) => {
    assert.deepEqual(imageDimensions(path), { width: 512, height: 512, scalable: false })
  })
})

test("reads GIF dimensions, which are little-endian unlike every other raster here", () => {
  const buffer = Buffer.alloc(10)
  buffer.write("GIF89a", 0, "ascii")
  buffer.writeUInt16LE(64, 6)
  buffer.writeUInt16LE(48, 8)
  withFile(buffer, "icon.gif", (path) => {
    assert.deepEqual(imageDimensions(path), { width: 64, height: 48, scalable: false })
  })
})

test("reads all three WebP chunk layouts", () => {
  const riff = (chunk: string, fill: (buffer: Buffer) => void) => {
    const buffer = Buffer.alloc(64)
    buffer.write("RIFF", 0, "ascii")
    buffer.write("WEBP", 8, "ascii")
    buffer.write(chunk, 12, "ascii")
    fill(buffer)
    return buffer
  }
  // Lossy: 14-bit fields, the upper two bits are scaling and must be masked off.
  withFile(riff("VP8 ", (b) => { b.writeUInt16LE(256 | 0xc000, 26); b.writeUInt16LE(256 | 0xc000, 28) }), "a.webp", (path) => {
    assert.deepEqual(imageDimensions(path), { width: 256, height: 256, scalable: false })
  })
  // Lossless: two 14-bit fields in one uint32, each stored one less than the real value.
  withFile(riff("VP8L", (b) => { b.writeUInt32LE((199) | (149 << 14), 21) }), "b.webp", (path) => {
    assert.deepEqual(imageDimensions(path), { width: 200, height: 150, scalable: false })
  })
  // Extended — the container used whenever there is alpha, which is most icons.
  withFile(riff("VP8X", (b) => {
    b.writeUIntLE(511, 24, 3)
    b.writeUIntLE(511, 27, 3)
  }), "c.webp", (path) => {
    assert.deepEqual(imageDimensions(path), { width: 512, height: 512, scalable: false })
  })
})

test("an ICO reports its LARGEST frame, and reads 0 as 256", () => {
  // The exact shape of a real favicon.ico: 16, 32 and 48 in one file, plus the 256 that has to be
  // stored as zero because the field is one byte wide. Reading the first entry would rank this 16px.
  const sizes = [16, 32, 48, 0]
  const buffer = Buffer.alloc(6 + sizes.length * 16)
  buffer.writeUInt16LE(0, 0)
  buffer.writeUInt16LE(1, 2)
  buffer.writeUInt16LE(sizes.length, 4)
  sizes.forEach((size, index) => {
    buffer[6 + index * 16] = size
    buffer[6 + index * 16 + 1] = size
  })
  withFile(buffer, "favicon.ico", (path) => {
    assert.deepEqual(imageDimensions(path), { width: 256, height: 256, scalable: false })
  })
})

test("walks JPEG segments to the start-of-frame, and reads height before width", () => {
  const parts = [
    Buffer.from([0xff, 0xd8]),
    // An APP0/JFIF segment first, so the walk has to skip a length-carrying segment to get there.
    Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(14)]),
    Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x00, 0xc8]),
  ]
  withFile(Buffer.concat(parts), "photo.jpg", (path) => {
    assert.deepEqual(imageDimensions(path), { width: 200, height: 300, scalable: false })
  })
})

test("an SVG falls back to its viewBox when width/height are absent or relative", () => {
  const cases: [string, { width: number; height: number }][] = [
    [`<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"></svg>`, { width: 48, height: 48 }],
    [`<svg width="2em" height="2em" viewBox="0 0 24 24"></svg>`, { width: 2, height: 2 }],
    // The inline-use shape: sized by its container, so only the viewBox says anything.
    [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"></svg>`, { width: 512, height: 512 }],
    [`<svg width="100%" height="100%" viewBox="0 0 120 40"></svg>`, { width: 120, height: 40 }],
    [`<?xml version="1.0"?>\n<!-- a comment -->\n<svg viewBox="0,0,64,64"></svg>`, { width: 64, height: 64 }],
  ]
  for (const [source, expected] of cases) {
    withFile(source, "logo.svg", (path) => {
      assert.deepEqual(imageDimensions(path), { ...expected, scalable: true }, source)
    })
  }
})

test("dispatches on magic bytes, so a PNG named .ico is still measured", () => {
  // Every "convert my png to ico" site emits these, and trusting the extension misreports them.
  withFile(png(180, 180), "favicon.ico", (path) => {
    assert.deepEqual(imageDimensions(path), { width: 180, height: 180, scalable: false })
  })
})

test("unreadable, empty and unrecognised files are undefined rather than a throw", () => {
  withFile(Buffer.alloc(0), "empty.png", (path) => assert.equal(imageDimensions(path), undefined))
  withFile("not an image at all", "nope.svg", (path) => assert.equal(imageDimensions(path), undefined))
  withFile(Buffer.from([0x00, 0x00, 0x01, 0x00, 0x00, 0x00]), "truncated.ico", (path) => {
    assert.equal(imageDimensions(path), undefined)
  })
  assert.equal(imageDimensions("/nonexistent/definitely/not/here.png"), undefined)
})

test("an SVG that paints no colour of its own is recognised as a glyph, not a logo", () => {
  // The Simple Icons shape: role="img", a 24x24 viewBox, one path, and NO fill anywhere. Through an
  // <img> there is nothing to inherit from, so it paints solid black — which on a dark rail is a
  // black tile. bun shipped exactly this as `site/public/icon.svg` beside its real colour logo.
  const glyph = `<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>Bun</title><path d="M11 22c6 0 11-4 11-9Z"/></svg>`
  withFile(glyph, "icon.svg", (path) => assert.equal(svgDeclaresColour(path), false))

  for (const [name, source] of [
    ["currentColor is the giveaway — it means 'whatever the text colour is'", `<svg viewBox="0 0 24 24"><path fill="currentColor" d="M0 0h24v24H0z"/></svg>`],
    ["black only", `<svg viewBox="0 0 24 24"><path fill="#000" d="M0 0z"/><path fill="black" d="M1 1z"/></svg>`],
    ["black and white only", `<svg viewBox="0 0 24 24"><rect fill="#ffffff"/><path fill="#000000" d="M0 0z"/></svg>`],
    ["none is not a colour", `<svg viewBox="0 0 24 24"><path fill="none" stroke="none" d="M0 0z"/></svg>`],
  ] as const) {
    withFile(source, "icon.svg", (path) => assert.equal(svgDeclaresColour(path), false, name))
  }
})

test("any single genuine colour counts — a one-colour brand mark is still a brand mark", () => {
  for (const [name, source] of [
    ["a fill", `<svg viewBox="0 0 80 70"><path style="fill:#fbf0df" d="M0 0z"/></svg>`],
    ["an attribute fill", `<svg viewBox="0 0 24 24"><path fill="#B71422" d="M0 0z"/></svg>`],
    ["a stroke", `<svg viewBox="0 0 24 24"><path stroke="#4ac97e" d="M0 0z"/></svg>`],
    ["a gradient stop", `<svg viewBox="0 0 24 24"><defs><linearGradient><stop stop-color="#ff6164"/></linearGradient></defs><path fill="url(#g)" d="M0 0z"/></svg>`],
    // A colour deep in the file, past any header budget a dimension read would use.
    ["a colour far down the document", `<svg viewBox="0 0 24 24">${"<!-- pad -->".repeat(500)}<path fill="#e8b923" d="M0 0z"/></svg>`],
  ] as const) {
    withFile(source, "logo.svg", (path) => assert.equal(svgDeclaresColour(path), true, name))
  }
})

test("colour is an SVG-only question — anything else is undefined, not false", () => {
  withFile(png(64, 64), "icon.png", (path) => assert.equal(svgDeclaresColour(path), undefined))
  withFile("not an svg at all", "icon.svg", (path) => assert.equal(svgDeclaresColour(path), undefined))
  assert.equal(svgDeclaresColour("/nonexistent/nope.svg"), undefined)
})
