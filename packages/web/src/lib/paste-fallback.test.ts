import { test } from "node:test"
import assert from "node:assert/strict"
import { createPasteFallbackHandler, dropsQuickPastes } from "./paste-fallback.ts"

const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)"

test("only Chromium 155 and 156 on macOS get the fallback", () => {
  assert.equal(dropsQuickPastes(`${MAC} Chrome/155.0.0.0 Safari/537.36`), true)
  assert.equal(dropsQuickPastes(`${MAC} Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0`), true)
  assert.equal(dropsQuickPastes(`${MAC} Chrome/154.0.0.0 Safari/537.36`), false)
  assert.equal(dropsQuickPastes(`${MAC} Chrome/157.0.0.0 Safari/537.36`), false)
  assert.equal(dropsQuickPastes(`${MAC} Chrome/1550.0.0.0 Safari/537.36`), false)
  assert.equal(dropsQuickPastes(`${MAC} Version/26.0 Safari/605.1.15`), false)
  assert.equal(dropsQuickPastes("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"), false)
  assert.equal(dropsQuickPastes("Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/155.0.0.0 Mobile/15E148 Safari/604.1"), false)
})

function paste(overrides: { tag?: string; types?: string[]; text?: string; defaultPrevented?: boolean } = {}) {
  const event = {
    defaultPrevented: overrides.defaultPrevented ?? false,
    prevented: false,
    target: { tagName: overrides.tag ?? "TEXTAREA" },
    clipboardData: {
      types: overrides.types ?? ["text/plain"],
      getData: (type: string) => (type === "text/plain" ? (overrides.text ?? "dictated words") : ""),
    },
    preventDefault() { this.prevented = true },
  }
  return event
}

function run(event: ReturnType<typeof paste>, accepts = true) {
  const inserted: string[] = []
  createPasteFallbackHandler((text) => { inserted.push(text); return accepts })(event as unknown as ClipboardEvent)
  return inserted
}

test("a plain-text paste into a text field is inserted by the app and the native paste cancelled", () => {
  for (const tag of ["TEXTAREA", "INPUT"]) {
    const event = paste({ tag })
    assert.deepEqual(run(event), ["dictated words"])
    assert.equal(event.prevented, true)
  }
})

test("line endings are normalized the way a native paste normalizes them", () => {
  assert.deepEqual(run(paste({ text: "one\r\ntwo\rthree\nfour" })), ["one\ntwo\nthree\nfour"])
})

test("the native paste is left alone when the app should not or cannot insert", () => {
  const cases = [
    paste({ defaultPrevented: true }),
    paste({ tag: "DIV" }),
    paste({ types: ["Files", "text/plain"] }),
    paste({ text: "" }),
  ]
  for (const event of cases) {
    assert.deepEqual(run(event), [])
    assert.equal(event.prevented, false)
  }
  // The field refused the text (read-only): nothing was inserted, so the browser's own paste still runs.
  const refused = paste()
  assert.deepEqual(run(refused, false), ["dictated words"])
  assert.equal(refused.prevented, false)
})
