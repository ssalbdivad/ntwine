import assert from "node:assert/strict"
import { test } from "node:test"
import { apiBase, basePath, crossProjectHref, innerPath, isCrossProjectPath, modeProjectHref, outerPath, prefixedAppRoute, projectHref, projectSlug } from "./base-path.ts"

// The launching project is still served unprefixed, so an empty base is a supported state.
test("an unprefixed page has no base and addresses the unprefixed API", () => {
  for (const path of ["/", "/thread/fix-auth", "/status/active", "/thread/a%2Fb"]) {
    assert.equal(basePath(path), "", path)
    assert.equal(innerPath(path), path, path)
    assert.equal(apiBase(path), "/_frizz", path)
    assert.equal(projectSlug(path), undefined, path)
  }
})

test("a project page lives under /project, and its API stays flat", () => {
  assert.equal(basePath("/project/nub"), "/project/nub")
  assert.equal(basePath("/project/nub/thread/fix-auth"), "/project/nub")
  assert.equal(projectSlug("/project/pullfrog-app/status/active"), "pullfrog-app")
  assert.equal(projectHref("nub"), "/project/nub")
  // The API is already inside a reserved namespace, so it has no root to protect: `/project` would
  // buy nothing there, and the server's split stays a two-part one.
  assert.equal(apiBase("/project/nub/thread/fix-auth"), "/_frizz/nub")
})

// The router reasons about the inner path, so a prefixed and an unprefixed page look identical to it.
test("inner and outer paths round-trip", () => {
  assert.equal(innerPath("/project/nub/thread/fix-auth"), "/thread/fix-auth")
  assert.equal(innerPath("/project/nub"), "/")
  assert.equal(outerPath("/thread/fix-auth", "/project/nub/thread/other"), "/project/nub/thread/fix-auth")
  assert.equal(outerPath("/", "/project/nub/thread/other"), "/project/nub")
  // Unprefixed, outer is a no-op — which is what keeps the launching project's own URLs working.
  assert.equal(outerPath("/thread/fix-auth", "/thread/other"), "/thread/fix-auth")
  assert.equal(outerPath("/", "/"), "/")
})

// THE POINT of moving projects under a segment of their own: the root namespace stays Frizz's.
test("only /project/<slug> and /all/<slug> are projects, so the root is free for other pages", () => {
  assert.equal(basePath("/thread/nub"), "", "a thread called `nub` is not a project")
  assert.equal(basePath("/status/blocked"), "")
  // A future top-level page cannot be shadowed by a directory somebody happens to have.
  assert.equal(basePath("/settings"), "")
  assert.equal(basePath("/docs/getting-started"), "")
  assert.equal(projectSlug("/settings"), undefined)
  // …and `/project` with nothing after it is not a project either.
  assert.equal(basePath("/project"), "")
  assert.equal(projectSlug("/project"), undefined)
  // The machine pages name no project.
  for (const path of ["/", "/projects", "/queues", "/all"]) {
    assert.equal(projectSlug(path), undefined, path)
    assert.equal(isCrossProjectPath(path), false, path)
  }
})

// THE CROSS-PROJECT PAGE'S FOCUS IS THE PAGE PROJECT. `/all/nub` must answer every "which project"
// question exactly as `/project/nub` does — the same API, the same feed, the same cache scope — so the
// board's drawer stack and composer work there unchanged. What differs is the MODE, and a URL built on
// the page has to stay in it: closing a drawer on `/all/nub/thread/x` lands on `/all/nub`, never on the
// board, which is the whole complaint this page exists to fix.
test("the cross-project page is focused on a project, and keeps its mode", () => {
  const page = "/all/nub/thread/fix-auth"
  assert.equal(projectSlug(page), "nub")
  assert.equal(apiBase(page), "/_frizz/nub")
  assert.equal(basePath(page), "/all/nub")
  assert.equal(innerPath(page), "/thread/fix-auth")
  assert.equal(innerPath("/all/nub"), "/")
  assert.equal(outerPath("/thread/other", page), "/all/nub/thread/other")
  assert.equal(outerPath("/", page), "/all/nub")
  assert.equal(isCrossProjectPath(page), true)
  assert.equal(isCrossProjectPath("/project/nub/thread/fix-auth"), false)
  assert.equal(crossProjectHref("nub"), "/all/nub")
  // A door to "that project" follows the mode; a door to "that project's board" is always the board.
  assert.equal(modeProjectHref("zod", page), "/all/zod")
  assert.equal(modeProjectHref("zod", "/project/nub"), "/project/zod")
  assert.equal(modeProjectHref("zod", "/projects"), "/project/zod")
  assert.equal(projectHref("zod"), "/project/zod")
  // An agent's `/thread/<slug>` link opens in place, on this page.
  assert.equal(prefixedAppRoute("/thread/other", page), "/all/nub/thread/other")
  assert.equal(prefixedAppRoute("/all/zod/thread/x", page), null, "already names its project")
})

// A worker writes `[label](/thread/<slug>)` — the shape from when one server meant one project. Under
// a prefix that raw href addresses whichever project LAUNCHED the server, so every modified click
// (⌘, middle, "open in new tab") on an agent's own cross-reference landed on a stranger's board.
test("an agent's unprefixed in-app link is re-pointed at the project the page is showing", () => {
  const page = "/project/nub/thread/fix-auth"
  assert.equal(prefixedAppRoute("/thread/other", page), "/project/nub/thread/other")
  assert.equal(prefixedAppRoute("/status/active", page), "/project/nub/status/active")
  assert.equal(prefixedAppRoute("/thread/other/full", page), "/project/nub/thread/other/full")
  // Query and fragment ride along rather than being dropped or re-pointed at the base.
  assert.equal(prefixedAppRoute("/thread/other?x=1#y", page), "/project/nub/thread/other?x=1#y")

  // Everything that must be left exactly as written.
  assert.equal(prefixedAppRoute("/project/other/thread/x", page), null, "already names its project")
  assert.equal(prefixedAppRoute("/", page), null, "the cross-project page is the same page everywhere")
  assert.equal(prefixedAppRoute("/Users/me/notes.md", page), null, "a filesystem path is not a route")
  assert.equal(prefixedAppRoute("//cdn.example/a", page), null, "protocol-relative is a web URL")
  assert.equal(prefixedAppRoute("docs/x", page), null)
  assert.equal(prefixedAppRoute(null, page), null)
  // On the launching project there is nothing to add, so the href is left alone rather than churned.
  assert.equal(prefixedAppRoute("/thread/other", "/thread/fix-auth"), null)
})
