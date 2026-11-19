import assert from "node:assert/strict"
import test from "node:test"
import { clipboardImageToFile } from "./embedEditKeys.ts"

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

test("clipboardImageToFile decodes host clipboard images into File objects with the right name and MIME", async () => {
  const png = clipboardImageToFile({ mime: "image/png", base64: PNG_BASE64 })
  assert.ok(png)
  assert.equal(png.name, "pasted.png")
  assert.equal(png.type, "image/png")
  const bytes = new Uint8Array(await png.arrayBuffer())
  assert.deepEqual(bytes, new Uint8Array(Buffer.from(PNG_BASE64, "base64")))

  const jpg = clipboardImageToFile({ mime: "image/jpeg", base64: PNG_BASE64 })
  assert.ok(jpg)
  assert.equal(jpg.name, "pasted.jpg")
  assert.equal(jpg.type, "image/jpeg")

  const named = clipboardImageToFile({ mime: "image/png", base64: PNG_BASE64, name: "Screenshot 2026-11-19.png" })
  assert.ok(named)
  assert.equal(named.name, "Screenshot 2026-11-19.png")

  assert.equal(clipboardImageToFile({ mime: "image/png", base64: "!!!not-base64!!!" }), null)
})
