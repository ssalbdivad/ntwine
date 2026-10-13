import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { pathToFileURL } from "node:url"
import { byteRange, localImageHeaders, localImageStream, resolveLocalImage, type LocalImageFile } from "./local-image.ts"

test("a Windows image URL pathname reads the same file as either drive separator", { skip: process.platform !== "win32" }, (t) => {
  const root = mkdtempSync(join(tmpdir(), "ntwine-local-image-win-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, "shot space %.png")
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64")
  writeFileSync(file, png)
  for (const path of [file, file.replaceAll("\\", "/"), decodeURIComponent(pathToFileURL(file).pathname), `/${file}`]) {
    const served = resolveLocalImage(path)
    assert.equal(served.status, 200, path)
    if (served.status === 200) assert.deepEqual([served.contentType, served.size, served.start, served.end], ["image/png", png.length, 0, png.length - 1])
  }
  const directory = join(root, "directory.png")
  mkdirSync(directory)
  assert.equal(resolveLocalImage(decodeURIComponent(pathToFileURL(directory).pathname)).status, 404)
  assert.equal(resolveLocalImage(decodeURIComponent(pathToFileURL(join(root, "missing.png")).pathname)).status, 404)
  assert.equal(resolveLocalImage("shot.png").status, 400)
  assert.equal(resolveLocalImage(file.replace(/\.png$/, ".txt")).status, 400)
})

async function bytesOf(result: LocalImageFile): Promise<Buffer> {
  const stream = localImageStream(result)
  if (!stream) return Buffer.alloc(0)
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

test("a byte range is a span, an open end or a suffix, clamped to the file's last byte", () => {
  assert.deepEqual(byteRange("bytes=0-99", 1000), { start: 0, end: 99 })
  assert.deepEqual(byteRange("bytes=500-", 1000), { start: 500, end: 999 })
  assert.deepEqual(byteRange("bytes=-100", 1000), { start: 900, end: 999 })
  assert.deepEqual(byteRange("bytes=-5000", 1000), { start: 0, end: 999 })
  assert.deepEqual(byteRange("bytes=900-5000", 1000), { start: 900, end: 999 })
  assert.deepEqual(byteRange(" bytes=0-0 ", 1000), { start: 0, end: 0 })
})

test("a range past the end is unsatisfiable; one this does not serve is ignored for the whole file", () => {
  assert.equal(byteRange("bytes=1000-", 1000), "unsatisfiable")
  assert.equal(byteRange("bytes=-0", 1000), "unsatisfiable")
  assert.equal(byteRange("bytes=0-", 0), "unsatisfiable")
  // Several ranges, another unit, garbage, an empty spec and a backwards span all mean "send it whole".
  for (const header of ["bytes=0-1,5-6", "items=0-1", "bytes=abc", "bytes=-", "bytes=9-3"]) {
    assert.equal(byteRange(header, 1000), null, header)
  }
})

test("a video resolves like a picture, and answers a range with exactly those bytes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ntwine-local-video-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, "flow.webm")
  const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251))
  writeFileSync(file, bytes)
  const real = realpathSync(file)

  const whole = resolveLocalImage(file)
  assert.deepEqual(whole, { status: 200, contentType: "video/webm", file: real, size: 1000, start: 0, end: 999 })
  if (whole.status === 200) assert.deepEqual(await bytesOf(whole), bytes)

  const part = resolveLocalImage(file, "bytes=100-199")
  assert.deepEqual(part, { status: 206, contentType: "video/webm", file: real, size: 1000, start: 100, end: 199 })
  if (part.status === 206) {
    assert.deepEqual(await bytesOf(part), bytes.subarray(100, 200))
    assert.deepEqual(localImageHeaders(part), {
      "content-type": "video/webm",
      "content-length": "100",
      "accept-ranges": "bytes",
      "cache-control": "private, max-age=60",
      "content-range": "bytes 100-199/1000",
    })
  }
  assert.deepEqual(resolveLocalImage(file, "bytes=1000-"), { status: 416, size: 1000 })

  for (const [ext, type] of [[".mp4", "video/mp4"], [".m4v", "video/mp4"], [".MOV", "video/quicktime"]]) {
    const other = join(root, `clip${ext}`)
    writeFileSync(other, bytes)
    const served = resolveLocalImage(other)
    assert.equal(served.status === 200 && served.contentType, type, ext)
  }
  // A container no browser can be counted on to play is not served at all.
  writeFileSync(join(root, "clip.avi"), bytes)
  assert.equal(resolveLocalImage(join(root, "clip.avi")).status, 400)
})

test("an empty file is an empty answer, never a span the reader cannot express", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ntwine-local-empty-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, "empty.png")
  writeFileSync(file, "")
  const served = resolveLocalImage(file)
  assert.equal(served.status, 200)
  if (served.status === 200) {
    assert.equal(localImageHeaders(served)["content-length"], "0")
    assert.equal(localImageStream(served), null)
  }
  assert.deepEqual(resolveLocalImage(file, "bytes=0-"), { status: 416, size: 0 })
})
