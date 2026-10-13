import { test } from "node:test"
import assert from "node:assert/strict"
import { embedLinkAction } from "./external-links.ts"

// In an editor's sidebar, the anchors a browser would open in a tab (lib/external-links.ts
// embedLinkAction): a webview opens none, so each is given the browser's destination in the editor's terms.

const HERE = "http://127.0.0.1:4917/all/acme/thread/links"
const plain = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, blank: true }

test("an in-app page a link would open in a new tab opens here instead", () => {
  assert.deepEqual(embedLinkAction("/", plain, HERE), { kind: "navigate", path: "/" })
  assert.deepEqual(embedLinkAction("/all/marketing-site", plain, HERE), { kind: "navigate", path: "/all/marketing-site" })
  assert.deepEqual(embedLinkAction("/project/docs", plain, HERE), { kind: "navigate", path: "/project/docs" })
  assert.deepEqual(embedLinkAction("http://127.0.0.1:4917/project/docs#x", plain, HERE), { kind: "navigate", path: "/project/docs#x" })
})

test("a thread's /full page goes to the browser, as f does; a thread's drawer is the thread-link handler's", () => {
  assert.deepEqual(embedLinkAction("/all/acme/thread/cursor-bug/full", plain, HERE), { kind: "external", url: "http://127.0.0.1:4917/all/acme/thread/cursor-bug/full" })
  assert.deepEqual(embedLinkAction("/thread/cursor-bug/full", plain, HERE), { kind: "external", url: "http://127.0.0.1:4917/thread/cursor-bug/full" })
  assert.equal(embedLinkAction("/thread/cursor-bug", plain, HERE), null)
  assert.equal(embedLinkAction("/all/acme/thread/cursor-bug", plain, HERE), null)
})

test("a modified or middle click on any in-app anchor opens its address in the browser", () => {
  for (const modifier of ["metaKey", "ctrlKey", "shiftKey", "altKey"] as const) {
    assert.deepEqual(embedLinkAction("/all/acme/thread/cursor-bug", { ...plain, blank: false, [modifier]: true }, HERE), { kind: "external", url: "http://127.0.0.1:4917/all/acme/thread/cursor-bug" }, modifier)
  }
  assert.deepEqual(embedLinkAction("/all/acme/thread/cursor-bug#port.cache", { ...plain, button: 1, blank: false }, HERE), { kind: "external", url: "http://127.0.0.1:4917/all/acme/thread/cursor-bug#port.cache" })
  assert.equal(embedLinkAction("/all/acme/thread/cursor-bug", { ...plain, button: 2 }, HERE), null, "a right click opens the menu")
})

test("mailto goes to the mail client through the editor", () => {
  assert.deepEqual(embedLinkAction("mailto:a@example.com", plain, HERE), { kind: "external", url: "mailto:a@example.com" })
  assert.deepEqual(embedLinkAction("mailto:a@example.com", { ...plain, button: 1, blank: false }, HERE), { kind: "external", url: "mailto:a@example.com" })
})

test("everything else is left alone: cross-origin, Ntwine's API, other schemes, a plain same-tab link", () => {
  assert.equal(embedLinkAction("https://example.com/spec", plain, HERE), null, "the external handler's")
  assert.equal(embedLinkAction("http://127.0.0.1:4918/", plain, HERE), null, "another port is another origin")
  assert.equal(embedLinkAction("/_ntwine/acme/local-image?path=/a.png", plain, HERE), null)
  assert.equal(embedLinkAction("javascript:alert(1)", plain, HERE), null)
  assert.equal(embedLinkAction("cursor://file/tmp/a.ts", plain, HERE), null)
  assert.equal(embedLinkAction("/", { ...plain, blank: false }, HERE), null, "a same-tab link loads in the frame, as written")
  assert.equal(embedLinkAction("http://[bad", plain, HERE), null)
})
