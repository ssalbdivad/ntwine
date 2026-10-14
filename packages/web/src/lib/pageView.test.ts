import assert from "node:assert/strict"
import { test } from "node:test"
import { ALL_PROJECTS, homeHref, legacyViewRedirect, projectViewHref, resolveView, sameView, viewAt, viewHref } from "./pageView.ts"

const cards = [{ slug: "acme" }, { slug: "billing" }, { slug: "gone" }]

// THE PATH NAMES THE VIEW (2026-10-06): `/project/<slug>…` is that project's board, anything else is All
// projects — a drawer on All projects included, whatever project its thread is in.
test("a project's board is /project/<slug>, and every address under it is that board", () => {
  for (const path of ["/project/acme", "/project/acme/", "/project/acme/thread/fix-x", "/project/acme/thread/fix-x/full", "/project/acme/status/blocked"]) {
    assert.deepEqual(viewAt(path), { kind: "project", slug: "acme" }, path)
  }
  assert.deepEqual(viewAt("/project/a%20b"), { kind: "project", slug: "a b" })
  for (const view of [{ kind: "project", slug: "acme" } as const, { kind: "project", slug: "a b/c" } as const]) {
    assert.ok(sameView(viewAt(viewHref(view)), view), JSON.stringify(view))
  }
  assert.equal(projectViewHref("acme"), "/project/acme")
})

test("All projects is /, and its drawers stay on it", () => {
  assert.equal(viewHref(ALL_PROJECTS), "/")
  assert.deepEqual(viewAt("/"), ALL_PROJECTS)
  assert.deepEqual(viewAt("/all/acme/thread/fix-x"), ALL_PROJECTS, "a drawer's project is not the page's view")
  assert.deepEqual(viewAt("/all/acme/thread/fix-x/full"), ALL_PROJECTS)
  assert.deepEqual(viewAt("/projects"), ALL_PROJECTS)
})

// A drawer goes back to the view it was opened over.
test("home is the page under the drawers: the board it is on, else /", () => {
  assert.equal(homeHref("/project/acme/thread/fix-x"), "/project/acme")
  assert.equal(homeHref("/project/acme/status/blocked"), "/project/acme")
  assert.equal(homeHref("/all/acme/thread/fix-x"), "/")
  assert.equal(homeHref("/"), "/")
})

test("a board for a slug nobody has is reported rather than swallowed", () => {
  assert.deepEqual(resolveView(cards, undefined), { view: ALL_PROJECTS })
  assert.deepEqual(resolveView(cards, ALL_PROJECTS), { view: ALL_PROJECTS })
  assert.deepEqual(resolveView(cards, { kind: "project", slug: "acme" }), { view: { kind: "project", slug: "acme" } })
  assert.deepEqual(resolveView(cards, { kind: "project", slug: "typo" }), { view: ALL_PROJECTS, unknown: "typo" })
})

// The view lived in the query from 2026-09-29 to 2026-10-06 (`?focus=` before that, `?all` for All projects
// until 2026-09-30), and launchers, extensions, bookmarks and handoffs from then still send it.
test("an address that names its view in the query lands on the path that names it now", () => {
  assert.equal(legacyViewRedirect("/", "?project=acme"), "/project/acme")
  assert.equal(legacyViewRedirect("/", "?focus=acme"), "/project/acme", "a pre-2026-09-29 launcher's landing URL")
  assert.equal(legacyViewRedirect("/", "?project=a%20b"), "/project/a%20b")
  assert.equal(legacyViewRedirect("/", "?all"), "/")
  assert.equal(legacyViewRedirect("/", "?all=1&add=%2Ftmp%2Fx"), "/?add=%2Ftmp%2Fx", "a launcher's other queries ride along")
  // An editor's sidebar from before 2026-10-06 framed `/?embed=vscode&theme=dark&project=<slug>` for a
  // board, and a bare `/?embed=vscode&theme=dark` for All projects.
  assert.equal(legacyViewRedirect("/", "?embed=vscode&theme=dark&project=acme"), "/project/acme?embed=vscode&theme=dark")
  assert.equal(legacyViewRedirect("/", "?embed=vscode&theme=dark"), undefined, "All projects is `/` again")
  // A drawer's old address: the thread in the path, the tab's board in the query. It lands on the board of
  // the thread's own project, which is what it opens.
  assert.equal(legacyViewRedirect("/all/acme/thread/fix-x", "?project=acme"), "/project/acme/thread/fix-x")
  assert.equal(legacyViewRedirect("/all/acme/thread/fix-x", "?embed=vscode&theme=light&project=acme"), "/project/acme/thread/fix-x?embed=vscode&theme=light")
  assert.equal(legacyViewRedirect("/all/acme/thread/fix-x/full", "?project=billing"), "/project/acme/thread/fix-x/full")
  // Nothing to redirect: no view in the query.
  assert.equal(legacyViewRedirect("/", ""), undefined)
  assert.equal(legacyViewRedirect("/", "?add=/tmp/x"), undefined)
  assert.equal(legacyViewRedirect("/project/acme", "?embed=vscode"), undefined)
  assert.equal(legacyViewRedirect("/all", "?embed=vscode&theme=dark"), undefined, "today's sidebar for All projects")
  assert.equal(legacyViewRedirect("/all", ""), undefined)
  assert.equal(legacyViewRedirect("/all/acme/thread/fix-x", ""), undefined)
})
