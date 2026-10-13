import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { initFont } from "./font.ts"

test("the interface is sans-serif despite old Mono preferences or unavailable storage", () => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document")
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
  try {
    for (const denied of [false, true]) {
      const document = { documentElement: { dataset: { font: "mono" } }, body: { style: { fontFamily: "" } } }
      const cache = new Map([["ntwine-font", "mono"]])
      Object.defineProperty(globalThis, "document", { configurable: true, value: document })
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: { removeItem(key: string) { if (denied) throw new Error("denied"); cache.delete(key) } },
      })
      initFont()
      assert.equal(document.documentElement.dataset.font, "sans")
      assert.match(document.body.style.fontFamily, /^system-ui,.*sans-serif$/)
      if (!denied) assert.equal(cache.has("ntwine-font"), false)
    }
  } finally {
    for (const [key, descriptor] of [["document", originalDocument], ["localStorage", originalStorage]] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})

test("first paint and code typography do not depend on a font preference", () => {
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8")
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8")
  assert.match(html, /<html[^>]*data-font="sans"/)
  assert.doesNotMatch(html, /ntwine-font/)
  assert.match(css, /body\s*\{[^}]*font-family: var\(--font-sans\)/)
  assert.match(css, /\.font-mono-keep\s*\{\s*font-family: var\(--font-mono\)/)
  assert.doesNotMatch(css, /html\[data-font=/)
})
