import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  imageMimeForPath,
  macPasteboardScript,
  parseClipboardOutput,
  readClipboardImage,
  readClipboardImageFile,
} from "./clipboard.ts"
import { actOnPage, type FrameLink, type PageHost } from "./framed-page.ts"

// 1x1 red PNG
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
const PNG_BYTES = Buffer.from(PNG_BASE64, "base64")

test("imageMimeForPath accepts raster image extensions and rejects everything else", () => {
  assert.equal(imageMimeForPath("/tmp/shot.png"), "image/png")
  assert.equal(imageMimeForPath("/tmp/PHOTO.JPG"), "image/jpeg")
  assert.equal(imageMimeForPath("/tmp/photo.jpeg"), "image/jpeg")
  assert.equal(imageMimeForPath("/tmp/anim.gif"), "image/gif")
  assert.equal(imageMimeForPath("/tmp/pic.webp"), "image/webp")
  assert.equal(imageMimeForPath("/tmp/icon.svg"), undefined)
  assert.equal(imageMimeForPath("/tmp/doc.pdf"), undefined)
  assert.equal(imageMimeForPath("/tmp/code.ts"), undefined)
  assert.equal(imageMimeForPath("/tmp/noext"), undefined)
})

test("parseClipboardOutput validates image payloads, file paths, and rejects junk", () => {
  assert.deepEqual(parseClipboardOutput(""), { kind: "none" })
  assert.deepEqual(parseClipboardOutput("not json"), { kind: "none" })
  assert.deepEqual(parseClipboardOutput(JSON.stringify({ filePath: "/tmp/shot.png" })), {
    kind: "file",
    filePath: "/tmp/shot.png",
  })
  assert.deepEqual(parseClipboardOutput(JSON.stringify({ mime: "image/png", base64: PNG_BASE64 })), {
    kind: "image",
    image: { mime: "image/png", base64: PNG_BASE64 },
  })
  // Unsupported MIME (e.g. svg, tiff) and empty or oversized base64 are dropped.
  assert.deepEqual(parseClipboardOutput(JSON.stringify({ mime: "image/svg+xml", base64: PNG_BASE64 })), { kind: "none" })
  assert.deepEqual(parseClipboardOutput(JSON.stringify({ mime: "image/tiff", base64: PNG_BASE64 })), { kind: "none" })
  assert.deepEqual(parseClipboardOutput(JSON.stringify({ mime: "image/png", base64: "" })), { kind: "none" })
  assert.deepEqual(parseClipboardOutput(JSON.stringify({ mime: "image/png", base64: PNG_BASE64 }), 10), { kind: "none" })
})

test("readClipboardImageFile reads allowed image files within the size cap and ignores non-images", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-clip-"))
  try {
    const png = join(dir, "Screenshot 2026-11-19.png")
    const ts = join(dir, "index.ts")
    writeFileSync(png, PNG_BYTES)
    writeFileSync(ts, "export const x = 1\n")

    assert.deepEqual(await readClipboardImageFile(png), {
      mime: "image/png",
      base64: PNG_BASE64,
      name: "Screenshot 2026-11-19.png",
    })
    assert.equal(await readClipboardImageFile(png, 10), undefined, "rejects file larger than maxBytes")
    assert.equal(await readClipboardImageFile(ts), undefined, "ignores non-image files")
    assert.equal(await readClipboardImageFile(dir), undefined, "ignores directories")
    assert.equal(await readClipboardImageFile(join(dir, "missing.png")), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("readClipboardImage returns undefined on non-macOS platforms", async () => {
  assert.equal(await readClipboardImage({ platform: "linux" }), undefined)
  assert.equal(await readClipboardImage({ platform: "win32" }), undefined)
})

test("macPasteboardScript converts TIFF to PNG, reads PNG directly, and never falls through to Finder's file icon", {
  skip: process.platform !== "darwin",
}, () => {
  // Exercise the real JXA script against a private in-process NSPasteboard when pboard is reachable,
  // or against an in-memory NSPasteboard shim backed by real AppKit NSData/NSBitmapImageRep/NSURL
  // when running under a macOS sandbox that blocks pboard. Never touches generalPasteboard.
  const runCase = (entries: { type: string; kind: "data" | "tiffFromPng" | "string"; value: string }[]): string => {
    const script = `
ObjC.import("AppKit");
const entries = ${JSON.stringify(entries)};
const testPb = $.NSPasteboard.pasteboardWithUniqueName;
const useReal = testPb && !(typeof testPb.isNil === "function" && testPb.isNil());
const store = {};
const typesList = [];
const makeData = (e) => {
  const d = $.NSData.alloc.initWithBase64EncodedStringOptions(e.value, 0);
  if (e.kind === "tiffFromPng") return $.NSBitmapImageRep.imageRepWithData(d).TIFFRepresentation;
  return d;
};
if (useReal) {
  testPb.clearContents;
  for (const e of entries) {
    if (e.kind === "string") testPb.setStringForType(e.value, e.type);
    else testPb.setDataForType(makeData(e), e.type);
  }
} else {
  for (const e of entries) {
    typesList.push(e.type);
    store[e.type] = e.kind === "string" ? $(e.value) : makeData(e);
  }
}
const fakePb = {
  types: $(typesList),
  dataForType: (t) => store[t] || $(),
  stringForType: (t) => store[t] || $(),
};
const pbExprValue = useReal ? $.NSPasteboard.pasteboardWithName(ObjC.unwrap(testPb.name)) : fakePb;
const res = (function() {
  ${macPasteboardScript(1024 * 1024, "__PB_NAME__").replace(`$.NSPasteboard.pasteboardWithName(${JSON.stringify("__PB_NAME__")})`, "pbExprValue").replace(/out;\s*$/u, "return out;")}
})();
if (useReal) testPb.releaseGlobally;
res;
`
    return execFileSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], { encoding: "utf8" }).trim()
  }

  // 1. Direct PNG on pasteboard (macOS screenshot)
  assert.deepEqual(
    parseClipboardOutput(runCase([{ type: "public.png", kind: "data", value: PNG_BASE64 }])),
    { kind: "image", image: { mime: "image/png", base64: PNG_BASE64 } },
  )

  // 2. TIFF-only on pasteboard (e.g. Preview / Safari Copy Image) -> converted to valid PNG
  const parsedTiff = parseClipboardOutput(runCase([{ type: "public.tiff", kind: "tiffFromPng", value: PNG_BASE64 }]))
  assert.equal(parsedTiff.kind, "image")
  assert.equal(parsedTiff.image.mime, "image/png")
  assert.equal(Buffer.from(parsedTiff.image.base64, "base64").subarray(1, 4).toString(), "PNG")

  // 3. Finder file copy (public.file-url + public.tiff icon): returns filePath, NOT the tiff icon
  assert.deepEqual(
    parseClipboardOutput(runCase([
      { type: "public.file-url", kind: "string", value: "file:///tmp/code.ts" },
      { type: "public.tiff", kind: "tiffFromPng", value: PNG_BASE64 },
    ])),
    { kind: "file", filePath: "/tmp/code.ts" },
  )

  // 4. Plain text only: returns empty
  assert.deepEqual(
    parseClipboardOutput(runCase([{ type: "public.utf8-plain-text", kind: "string", value: "hello world" }])),
    { kind: "none" },
  )
})

test("actOnPage answers ntwine:read-clipboard with both text and image when present", async () => {
  const posted: unknown[] = []
  const frame: FrameLink = {
    post: async (message) => {
      posted.push(message)
      return true
    },
    mac: () => true,
    runChord: async () => {},
  }
  const api = {
    env: { clipboard: { readText: async () => "" } },
  } as unknown as Parameters<typeof actOnPage>[0]
  const host = {
    readClipboardImage: async () => ({ mime: "image/png" as const, base64: PNG_BASE64 }),
    log: { info() {}, warn() {} },
  } as unknown as PageHost

  assert.equal(await actOnPage(api, { type: "ntwine:read-clipboard", id: "req-1" }, host, frame), "read-image")
  assert.deepEqual(posted, [{
    type: "ntwine:clipboard",
    id: "req-1",
    text: "",
    image: { mime: "image/png", base64: PNG_BASE64 },
  }])

  // Text only when no image is on the clipboard
  posted.length = 0
  const textApi = {
    env: { clipboard: { readText: async () => "hello" } },
  } as unknown as Parameters<typeof actOnPage>[0]
  const noImageHost = {
    readClipboardImage: async () => undefined,
    log: { info() {}, warn() {} },
  } as unknown as PageHost
  assert.equal(await actOnPage(textApi, { type: "ntwine:read-clipboard", id: "req-2" }, noImageHost, frame), "read")
  assert.deepEqual(posted, [{ type: "ntwine:clipboard", id: "req-2", text: "hello" }])
})
