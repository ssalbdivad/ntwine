import assert from "node:assert/strict"
import { test } from "node:test"
import { apiBase, basePath, crossProjectHref, innerPath, isCrossProjectPath, isProjectBoardPath, isRetiredAppPath, outerPath, prefixedAppRoute, projectSlug, setHomeFocus } from "./base-path.ts"

// The launching project's fullscreen page is still served unprefixed, so an empty base is a supported state.
test("an unprefixed page has no base and addresses the unprefixed API", () => {
  for (const path of ["/", "/thread/fix-auth", "/thread/fix-auth/full", "/status/active", "/thread/a%2Fb"]) {
    assert.equal(basePath(path), "", path)
    assert.equal(innerPath(path), path, path)
    assert.equal(apiBase(path), "/_ntwine", path)
    assert.equal(projectSlug(path), undefined, path)
  }
})

test("a drawer's project lives under /all, and its API stays flat", () => {
  assert.equal(basePath("/all/nub/thread/fix-auth"), "/all/nub")
  assert.equal(projectSlug("/all/pullfrog-app/thread/x/full"), "pullfrog-app")
  // The API is already inside a reserved namespace, so it has no root to protect: `/all` would buy
  // nothing there, and the server's split stays a two-part one.
  assert.equal(apiBase("/all/nub/thread/fix-auth"), "/_ntwine/nub")
})

// A PROJECT'S BOARD IS `/project/<slug>` (upstream's scheme, restored 2026-10-06): its board, a thread on it,
// that thread's /full and its status list all name the project, address its API and feed, and keep the
// board as the page's root.
test("/project/<slug> is that project's board", () => {
  for (const path of ["/project/nub", "/project/nub/", "/project/nub/thread/fix-auth", "/project/nub/thread/x/full", "/project/nub/status/active"]) {
    assert.equal(projectSlug(path), "nub", path)
    assert.equal(basePath(path), "/project/nub", path)
    assert.equal(apiBase(path), "/_ntwine/nub", path)
    assert.equal(isCrossProjectPath(path), true, path)
    assert.equal(isProjectBoardPath(path), true, path)
  }
  assert.equal(innerPath("/project/nub"), "/")
  assert.equal(innerPath("/project/nub/"), "/")
  assert.equal(innerPath("/project/nub/thread/fix-auth"), "/thread/fix-auth")
  assert.equal(innerPath("/project/nub/status/active"), "/status/active")
  // Closing the last drawer on a board goes back to the board, not to All projects.
  assert.equal(outerPath("/", "/project/nub/thread/fix-auth"), "/project/nub")
  assert.equal(outerPath("/thread/other", "/project/nub"), "/project/nub/thread/other")
  assert.equal(outerPath("/status/blocked", "/project/nub"), "/project/nub/status/blocked")
  // A thread opened in place keeps the page's view: a board's links stay on boards.
  assert.equal(crossProjectHref("zod", "/project/nub/thread/x"), "/project/zod")
  assert.equal(crossProjectHref("zod", "/project/nub"), "/project/zod")
  assert.equal(prefixedAppRoute("/thread/other", "/project/nub"), "/project/nub/thread/other")
  assert.equal(prefixedAppRoute("/project/zod/thread/x", "/project/nub"), null, "already names its project")
})

// EXACTLY those shapes: `/project` is a real directory on plenty of machines, and the markdown sanitizer
// asks projectSlug whether a link is in-app (markdownTargets.ts isNtwineRoute).
test("nothing else under /project/ is a page", () => {
  for (const path of ["/project", "/project/", "/project/acme/src/main.rs", "/project/acme/thread/x/notes.md", "/project/acme/status", "/project/acme/status/a/b"]) {
    assert.equal(projectSlug(path), undefined, path)
    assert.equal(basePath(path), "", path)
    assert.equal(isProjectBoardPath(path), false, path)
  }
})

// A bare `/status/<s>` was the launching project's status list before the singleton; it is still an
// address Ntwine minted, so a link to one is in-app (markdownTargets.ts isNtwineRoute) and is left exactly as
// written: re-pointed under a drawer's prefix it would name a route that never existed there, and it lands
// on the page either way.
test("a retired address is recognised, and never re-pointed", () => {
  for (const path of ["/status/active", "/status/active/"]) {
    assert.equal(isRetiredAppPath(path), true, path)
    assert.equal(prefixedAppRoute(path, "/all/zod/thread/x"), null, path)
  }
  for (const path of ["/project/nub", "/project/nub/thread/x", "/project", "/status", "/status/a/b", "/thread/x", "/all/nub"])
    assert.equal(isRetiredAppPath(path), false, path)
})

// The router reasons about the inner path, so a prefixed and an unprefixed page look identical to it.
test("inner and outer paths round-trip", () => {
  assert.equal(innerPath("/all/nub/thread/fix-auth"), "/thread/fix-auth")
  assert.equal(innerPath("/all/nub"), "/")
  assert.equal(outerPath("/thread/fix-auth", "/all/nub/thread/other"), "/all/nub/thread/fix-auth")
  // Closing the last drawer goes home: the page's root is `/all` whichever project the drawer named.
  assert.equal(outerPath("/", "/all/nub/thread/other"), "/")
  assert.equal(outerPath("/", "/all"), "/")
  // Unprefixed, outer is a no-op — which is what keeps the launching project's /full working.
  assert.equal(outerPath("/thread/fix-auth/full", "/thread/other/full"), "/thread/fix-auth/full")
  // `/` is its own root: a phone's projects list, which must not become All projects under it.
  assert.equal(outerPath("/", "/"), "/")
})

// THE POINT of moving projects under a segment of their own: the root namespace stays Ntwine's.
test("only /all/<slug> and /project/<slug> name a project, so the root is free for other pages", () => {
  assert.equal(basePath("/thread/nub"), "", "a thread called `nub` is not a project")
  assert.equal(basePath("/status/blocked"), "")
  // A future top-level page cannot be shadowed by a directory somebody happens to have.
  assert.equal(basePath("/settings"), "")
  assert.equal(basePath("/docs/getting-started"), "")
  assert.equal(projectSlug("/settings"), undefined)
  // …and `/all` with nothing after it is not a project either.
  assert.equal(basePath("/all"), "")
  assert.equal(projectSlug("/all/"), undefined)
  // The machine pages name no project.
  for (const path of ["/", "/projects", "/queues", "/all"]) {
    assert.equal(projectSlug(path), undefined, path)
    assert.equal(isCrossProjectPath(path), false, path)
  }
})

// THE CROSS-PROJECT PAGE'S FOCUS IS THE PAGE PROJECT. `/all/nub/thread/x` must answer every "which
// project" question for `nub` — the same API, the same feed, the same cache scope — so the drawer stack
// and composer work for it; and closing that drawer lands on `/`, the page itself.
test("the cross-project page is focused on a project", () => {
  const page = "/all/nub/thread/fix-auth"
  assert.equal(projectSlug(page), "nub")
  assert.equal(apiBase(page), "/_ntwine/nub")
  assert.equal(basePath(page), "/all/nub")
  assert.equal(innerPath(page), "/thread/fix-auth")
  assert.equal(innerPath("/all/nub"), "/")
  assert.equal(outerPath("/thread/other", page), "/all/nub/thread/other")
  assert.equal(outerPath("/", page), "/")
  assert.equal(isCrossProjectPath(page), true)
  assert.equal(isProjectBoardPath(page), false)
  assert.equal(crossProjectHref("nub", page), "/all/nub")
  assert.equal(crossProjectHref("nub", "/all"), "/all/nub", "All projects' own drawers stay on All projects")
  assert.equal(crossProjectHref("nub", "/"), "/all/nub")
  // An agent's `/thread/<slug>` link opens in place, on this page.
  assert.equal(prefixedAppRoute("/thread/other", page), "/all/nub/thread/other")
  // …and an agent's `@thread.child` mention keeps the child's address in the fragment (mentionAutolink.ts).
  assert.equal(prefixedAppRoute("/thread/other#port-the-parser.cache-keys", page), "/all/nub/thread/other#port-the-parser.cache-keys")
  assert.equal(prefixedAppRoute("/all/zod/thread/x", page), null, "already names its project")
})

// A worker writes `[label](/thread/<slug>)` — the shape from when one server meant one project. Under
// a prefix that raw href addresses whichever project LAUNCHED the server, so every modified click
// (⌘, middle, "open in new tab") on an agent's own cross-reference landed on a stranger's thread.
test("an agent's unprefixed in-app link is re-pointed at the project the page is showing", () => {
  const page = "/all/nub/thread/fix-auth"
  assert.equal(prefixedAppRoute("/thread/other", page), "/all/nub/thread/other")
  assert.equal(prefixedAppRoute("/thread/other/full", page), "/all/nub/thread/other/full")
  // Query and fragment ride along rather than being dropped or re-pointed at the base.
  assert.equal(prefixedAppRoute("/thread/other?x=1#y", page), "/all/nub/thread/other?x=1#y")

  // Everything that must be left exactly as written.
  assert.equal(prefixedAppRoute("/all/other/thread/x", page), null, "already names its project")
  assert.equal(prefixedAppRoute("/", page), null, "the cross-project page is the same page everywhere")
  assert.equal(prefixedAppRoute("/Users/me/notes.md", page), null, "a filesystem path is not a route")
  assert.equal(prefixedAppRoute("//cdn.example/a", page), null, "protocol-relative is a web URL")
  assert.equal(prefixedAppRoute("docs/x", page), null)
  assert.equal(prefixedAppRoute(null, page), null)
  // On the launching project there is nothing to add, so the href is left alone rather than churned.
  assert.equal(prefixedAppRoute("/thread/other", "/thread/fix-auth/full"), null)
})

// AT `/all` (AND A PHONE'S `/`) THE PAGE PROJECT IS NOT IN THE PATH. The route resolves it — All projects'
// pick — and hands it over with `setHomeFocus`, and from then on the page answers every "which project"
// question as a drawer's `/all/<focus>/…` would, whatever the query says.
test("All projects at /all, and a phone's /, are bound to a project the path does not name", () => {
  try {
    setHomeFocus("nub")
    for (const home of ["/all", "/all/", "/"]) {
      assert.equal(projectSlug(home), "nub", home)
      assert.equal(apiBase(home), "/_ntwine/nub", home)
      assert.equal(isCrossProjectPath(home), true, home)
      assert.equal(innerPath(home), "/", home)
      assert.equal(outerPath("/thread/x", home), "/all/nub/thread/x", "a drawer's address names its project")
      assert.equal(prefixedAppRoute("/thread/x", home), "/all/nub/thread/x", home)
    }
    // Closing a drawer goes home to All projects, `/`.
    assert.equal(outerPath("/", "/all"), "/")
    assert.equal(outerPath("/", "/"), "/")
    // Only these — every other machine page still names nothing.
    assert.equal(projectSlug("/projects"), undefined)
  } finally {
    setHomeFocus(undefined)
  }
  for (const home of ["/all", "/"]) {
    assert.equal(projectSlug(home), undefined, home)
    assert.equal(isCrossProjectPath(home), false, home)
  }
})
