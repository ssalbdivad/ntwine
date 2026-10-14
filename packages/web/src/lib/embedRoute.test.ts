import assert from "node:assert/strict"
import test from "node:test"
import { pageHref, queueReading, sidebarRoute } from "./embedRoute.ts"

// What VS Code's title row says over an editor's sidebar (lib/embedRoute.ts). The poster's dedupe and its
// repost after ready need embed mode, so they are tested in embedMode.test.ts.

const base = { settings: false, thread: null, other: null, scope: "acme-api", reading: "5 ready" }

test("the queue is named by its scope, with its counts beside it", () => {
  assert.deepEqual(sidebarRoute(base), { view: "queue", title: "acme-api", description: "5 ready" })
  assert.deepEqual(sidebarRoute({ ...base, scope: "All projects" }).title, "All projects")
  // Still loading: the name alone, never a count that is not yet true.
  assert.deepEqual(sidebarRoute({ ...base, reading: null }), { view: "queue", title: "acme-api" })
})

test("an open thread is named by its title, and Settings wins over everything", () => {
  assert.deepEqual(sidebarRoute({ ...base, thread: "Split the constants" }), { view: "thread", title: "Split the constants" })
  assert.deepEqual(sidebarRoute({ ...base, thread: "Split the constants", settings: true }), { view: "settings", title: "Settings" })
  // A file opened over the page with no thread under it.
  assert.deepEqual(sidebarRoute({ ...base, other: "README.md" }), { view: "other", title: "README.md" })
})

test("the counts are the desktop's READY, every card, and what is working beside it", () => {
  // A question is a card: 1 ask and 6 handoffs read 7 ready, as the READY header over the cards does.
  assert.equal(queueReading({ ready: 7, working: 2 }), "7 ready · 2 working")
  assert.equal(queueReading({ ready: 7, working: 0 }), "7 ready")
  assert.equal(queueReading({ ready: 0, working: 1 }), "1 working")
  assert.equal(queueReading({ ready: 0, working: 0 }), "Nothing needs you")
})

test("the page's address for a browser tab drops the embed switch, the theme and any fragment", () => {
  assert.equal(pageHref("http://127.0.0.1:9393/?embed=vscode&theme=dark&project=acme-api"), "http://127.0.0.1:9393/?project=acme-api")
  assert.equal(pageHref("http://127.0.0.1:9393/?embed=vscode&theme=light"), "http://127.0.0.1:9393/")
  assert.equal(pageHref("http://127.0.0.1:9393/all/acme-api/thread/split-constants#x"), "http://127.0.0.1:9393/all/acme-api/thread/split-constants")
  // Only those two: anything else in the query is the view's own.
  assert.equal(pageHref("http://localhost:9393/all/acme-api/thread/a/full?embed=vscode&q=1"), "http://localhost:9393/all/acme-api/thread/a/full?q=1")
})
