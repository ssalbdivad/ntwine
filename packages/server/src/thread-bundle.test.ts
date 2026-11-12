import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { BundleError, packBundle, unpackBundle } from "./thread-bundle.ts"

const SIZE = 32 * 1024 * 1024
const blob = packBundle({ files: [{ root: "scratch", rel: "big.bin", size: SIZE, mode: 0o644 }] }, [Buffer.alloc(SIZE)])

describe("unpacking a moved thread's bundle", () => {
  it("inflates off the event loop, so the server keeps answering while a large bundle unpacks", async () => {
    // An immediate runs on the loop's next turn. A synchronous inflate finishes, and resolves, before it.
    let turned = false
    setImmediate(() => { turned = true })
    const unpacked = await unpackBundle(blob)
    assert.equal(turned, true)
    assert.equal(unpacked.files[0]?.data.length, SIZE)
  })

  it("refuses a bundle that inflates past the ceiling", async () => {
    await assert.rejects(unpackBundle(blob, 1024 * 1024), (error: unknown) => error instanceof BundleError && /could not be read/.test(error.message))
  })
})
