import { test } from "node:test"
import assert from "node:assert/strict"
import { setHomeFocus } from "./base-path.ts"
import { isLocalMarkdownFile, labelPosition, localFileDir, localImageUrl, localImageUrlForTarget, localMarkdownTarget, positionFragment, resolveRelativeLocalPath, resolveRelativeLocalTarget } from "./markdownTargets.ts"

test("absolute POSIX and file URLs become local targets with decoded proxy paths", () => {
  assert.deepEqual(
    localMarkdownTarget("/Users/me/visual%20review/shot.png"),
    { display: "/Users/me/visual review/shot.png", filePath: "/Users/me/visual review/shot.png" },
  )
  assert.deepEqual(
    localMarkdownTarget("file:///Users/me/visual%20review/shot.png"),
    { display: "/Users/me/visual review/shot.png", filePath: "/Users/me/visual review/shot.png" },
  )
  assert.equal(
    localImageUrl("/Users/me/visual review/shot.png"),
    "/_ntwine/local-image?path=%2FUsers%2Fme%2Fvisual%20review%2Fshot.png",
  )
  assert.equal(
    localImageUrlForTarget(localMarkdownTarget("/Users/me/visual%20review/shot.png")!),
    "/_ntwine/local-image?path=%2FUsers%2Fme%2Fvisual%20review%2Fshot.png",
  )
})

test("an absolute path's #section or ?query tail is not part of the path", () => {
  const path = "/Users/me/repo/AGENTS.md"
  for (const href of [`${path}#cutting-a-release`, `${path}?plain=1`]) {
    assert.deepEqual(localMarkdownTarget(href), { display: path, filePath: path }, href)
    assert.ok(isLocalMarkdownFile(localMarkdownTarget(href)!.filePath!), href)
  }
  // …but a `#L3` tail is the place in the file — GitHub's own line link carries `?plain=1` before it.
  assert.deepEqual(localMarkdownTarget(`${path}?plain=1#L3`), { display: `${path}:3`, filePath: path, position: { line: 3 } })
  // An ENCODED `#` is a character in the file name, not a fragment.
  assert.deepEqual(localMarkdownTarget("/tmp/issue%23482.md"), { display: "/tmp/issue#482.md", filePath: "/tmp/issue#482.md" })
})

test("only server-supported local image extensions become proxy URLs", () => {
  for (const path of ["/tmp/shot.png", "/tmp/shot.JPG", "/tmp/shot.jpeg", "/tmp/shot.gif", "/tmp/shot.webp"]) {
    assert.ok(localImageUrlForTarget(localMarkdownTarget(path)!), path)
  }
  assert.equal(localImageUrlForTarget(localMarkdownTarget("/tmp/shot.svg")!), null)
  // A Windows screenshot is proxied like any other: the route resolves a drive path when the server
  // runs there, and dropping the image left a Windows write-up with no picture in it at all.
  assert.equal(
    localImageUrlForTarget(localMarkdownTarget("C:\\Users\\me\\shot.png")!),
    "/_ntwine/local-image?path=C%3A%5CUsers%5Cme%5Cshot.png",
  )
})

test("editor deep links resolve to the local path they name", () => {
  // Both slash forms of the VS Code URL grammar, every recognized scheme, and a percent-escaped path.
  assert.deepEqual(
    localMarkdownTarget("cursor://file/Users/me/plan.md"),
    { display: "/Users/me/plan.md", filePath: "/Users/me/plan.md" },
  )
  assert.deepEqual(
    localMarkdownTarget("vscode://file//Users/me/visual%20review/shot.png"),
    { display: "/Users/me/visual review/shot.png", filePath: "/Users/me/visual review/shot.png" },
  )
  assert.deepEqual(
    localMarkdownTarget("vscode-insiders://file/tmp/a.ts"),
    { display: "/tmp/a.ts", filePath: "/tmp/a.ts" },
  )
  assert.deepEqual(
    localMarkdownTarget("windsurf://file/tmp/a.ts"),
    { display: "/tmp/a.ts", filePath: "/tmp/a.ts" },
  )
  // The editor cursor suffix is the place the link opens at: it comes off the path as `position`, so
  // the reader is handed a file that exists (it said "not found" while the suffix rode on the path).
  // A query tail is the editor's and is dropped.
  assert.deepEqual(
    localMarkdownTarget("cursor://file/repo/AGENTS.md:42:7"),
    { display: "/repo/AGENTS.md:42", filePath: "/repo/AGENTS.md", position: { line: 42, column: 7 } },
  )
  assert.deepEqual(
    localMarkdownTarget("vscode://file//repo/a.ts:3:2?windowId=_blank"),
    { display: "/repo/a.ts:3", filePath: "/repo/a.ts", position: { line: 3, column: 2 } },
  )
  assert.deepEqual(
    localMarkdownTarget("vscode://file/c:/Users/me/a.ts:12"),
    { display: "c:/Users/me/a.ts:12", filePath: "c:/Users/me/a.ts", position: { line: 12 } },
  )
  assert.deepEqual(
    localMarkdownTarget("vscode://file/tmp/a.ts?windowId=_blank"),
    { display: "/tmp/a.ts", filePath: "/tmp/a.ts" },
  )
  // A Windows drive path the route carries is a file path too, and an empty path is nothing.
  assert.deepEqual(localMarkdownTarget("vscode://file/c:/Users/me/shot.png"), { display: "c:/Users/me/shot.png", filePath: "c:/Users/me/shot.png" })
  assert.equal(localMarkdownTarget("cursor://file/"), null)
  // Unrecognized schemes stay ordinary links.
  assert.equal(localMarkdownTarget("zed://file/tmp/a.ts"), null)
})

test("a Windows drive path is a file path the server can act on; a remote host is not", () => {
  // Every one of these was a chip with NO path until 2026-09-14, which made a file link on Windows a
  // button whose click did nothing and an inline screenshot vanish from the prose.
  assert.deepEqual(localMarkdownTarget("C:\\Users\\me\\shot.png"), { display: "C:\\Users\\me\\shot.png", filePath: "C:\\Users\\me\\shot.png" })
  assert.deepEqual(localMarkdownTarget("C:%5CUsers%5Cme%5Cshot.png"), { display: "C:\\Users\\me\\shot.png", filePath: "C:\\Users\\me\\shot.png" })
  assert.deepEqual(localMarkdownTarget("D:/Development/ntwine/AGENTS.md"), { display: "D:/Development/ntwine/AGENTS.md", filePath: "D:/Development/ntwine/AGENTS.md" })
  // Only the server knows whether the URL's leading slash belongs to a POSIX filename.
  assert.deepEqual(localMarkdownTarget("file:///D:/Development/ntwine/AGENTS.md"), { display: "/D:/Development/ntwine/AGENTS.md", filePath: "/D:/Development/ntwine/AGENTS.md" })
  assert.deepEqual(localMarkdownTarget("/D:/Development/ntwine/AGENTS.md"), { display: "/D:/Development/ntwine/AGENTS.md", filePath: "/D:/Development/ntwine/AGENTS.md" })
  assert.deepEqual(localMarkdownTarget("cursor://file//C:/Users/me/plan.md"), { display: "C:/Users/me/plan.md", filePath: "C:/Users/me/plan.md" })
  // A one-character URL scheme shares the drive path's prefix and must NOT become a file button. The
  // separator count is the whole difference: a path has one, a URL has two.
  assert.equal(localMarkdownTarget("x://host/p"), null)
  assert.equal(localMarkdownTarget("m://mail/inbox"), null)
  // A UNC share is still not a file this machine's server resolves.
  assert.deepEqual(localMarkdownTarget("file://fileserver/share/shot.png"), { display: "file://fileserver/share/shot.png" })
})

test("a POSIX directory named after a drive keeps its root in links and image URLs", () => {
  for (const path of ["/C:/docs/plan.md", "/D:/docs/shot.png"]) {
    for (const href of [path, `file://${path}`]) {
      assert.deepEqual(localMarkdownTarget(href), { display: path, filePath: path })
    }
  }
  assert.equal(
    localImageUrlForTarget(localMarkdownTarget("/D:/docs/shot.png")!),
    "/_ntwine/local-image?path=%2FD%3A%2Fdocs%2Fshot.png",
  )
})

test("normal web, relative app, anchor, and mail links remain links", () => {
  for (const href of [
    "https://example.com/shot.png",
    "//cdn.example.com/shot.png",
    "thread/a",
    "/thread/a",
    "/status/active",
    "/",
    "/?filter=active",
    "#details",
    "mailto:dev@example.com",
    // The machine pages and the cross-project page are in-app too.
    "/projects",
    "/queues",
    "/all/nub",
    "/all/nub/thread/fix-auth",
  ]) assert.equal(localMarkdownTarget(href), null, href)
})

// ONE PAGE (2026-09-28). A worker's handoff is read on `/` and in a drawer at `/all/<slug>/thread/<t>`
// (and an old `/thread/<t>/full` address still loads before it redirects), and a link in it must classify
// the same on each: the shapes are matched on the link alone. The page is stubbed per reading, `/` with a focus as the route sets it.
test("an in-app link classifies the same on /, in a drawer and on a retired /full", () => {
  const globals = globalThis as { location?: unknown }
  const previous = globals.location
  const links = ["/", "/thread/a", "/thread/a/full", "/all/nub/thread/a", "/all/zod/thread/a/full", "/all/zod"]
  try {
    for (const [page, focus] of [["/", "nub"], ["/all/nub/thread/fix-auth", undefined], ["/thread/fix-auth/full", undefined]] as const) {
      globals.location = { pathname: page }
      setHomeFocus(focus)
      for (const href of links) assert.equal(localMarkdownTarget(href), null, `${href} on ${page}`)
      assert.equal(localMarkdownTarget("/Users/me/notes.md")?.filePath, "/Users/me/notes.md", `a file on ${page}`)
    }
  } finally {
    globals.location = previous
    setHomeFocus(undefined)
  }
})

// A project's board and the addresses under it (`/project/<slug>…`, live again since 2026-10-06), and the
// retired bare `/status/<s>`: in-app, all of them — read as a file, each became a chip whose click asked
// the server to open `/project/nub/thread/x`.
test("a board's address, and a retired ntwine address, are in-app, not a file the server is asked to open", () => {
  for (const href of [
    "/project/nub",
    "/project/nub/",
    "/project/nub/thread/fix-auth",
    "/project/nub/thread/fix-auth/full",
    "/project/nub/thread/fix-auth?x=1#y",
    "/project/nub/status/active",
    "/status/blocked",
  ]) assert.equal(localMarkdownTarget(href), null, href)
})

test("…but EXACTLY those shapes: a `/project` directory is somebody's files", () => {
  for (const path of ["/project/acme/src/main.rs", "/project/acme/README.md", "/project/acme/thread/x/notes.md", "/project", "/status/a/b.log"])
    assert.equal(localMarkdownTarget(path)?.filePath, path, path)
})

test("a machine page's NAME at the root of a filesystem path is still a file", () => {
  assert.equal(localMarkdownTarget("/projects/acme/README.md")?.filePath, "/projects/acme/README.md")
  assert.equal(localMarkdownTarget("/queues/today.md")?.filePath, "/queues/today.md")
})

test("malformed URL encoding cannot throw or become an app navigation", () => {
  assert.deepEqual(localMarkdownTarget("/Users/me/bad%ZZ.png"), {
    display: "/Users/me/bad%ZZ.png",
    filePath: "/Users/me/bad%ZZ.png",
  })
})

test("a local Markdown file is recognized by extension, editor suffix and all", () => {
  for (const path of ["/repo/README.md", "/repo/docs/a.MARKDOWN", "~/.claude/CLAUDE.md", "/repo/AGENTS.md:42", "/repo/AGENTS.md:42:7", "/repo/content/blog/post.mdx"])
    assert.equal(isLocalMarkdownFile(path), true, path)
  for (const path of ["/repo/notes.txt", "/repo/md", "/repo/a.md.bak", "/repo/docs", "/repo/a.mdxx"])
    assert.equal(isLocalMarkdownFile(path), false, path)
})

test("a document's relative links resolve against its own directory", () => {
  const base = "/repo/docs"
  assert.equal(resolveRelativeLocalPath("guide.md", base), "/repo/docs/guide.md")
  assert.equal(resolveRelativeLocalPath("./guide.md", base), "/repo/docs/guide.md")
  assert.equal(resolveRelativeLocalPath("../AGENTS.md", base), "/repo/AGENTS.md")
  assert.equal(resolveRelativeLocalPath("a/../b/c.md", base), "/repo/docs/b/c.md")
  assert.equal(resolveRelativeLocalPath("shots/one%20two.png", base), "/repo/docs/shots/one two.png")
  // A filesystem path has no query or fragment; the tail is dropped rather than baked into the name.
  assert.equal(resolveRelativeLocalPath("guide.md#section", base), "/repo/docs/guide.md")
})

test("only a genuinely relative destination is rebased", () => {
  const base = "/repo/docs"
  for (const href of ["/abs/x.md", "https://example.com/x.md", "mailto:a@b.c", "file:///x.md", "#anchor", "?q=1", "", "   "])
    assert.equal(resolveRelativeLocalPath(href, base), null, JSON.stringify(href))
  // No base at all (a page whose board keyframe has not landed yet) means no rebasing.
  assert.equal(resolveRelativeLocalPath("guide.md", ""), null)
})

test("chat prose rebases a project-relative path the way a worker writes it", () => {
  // The reported bug verbatim: a worker linking its own scratch file wrote the path relative to the
  // project root, the anchor stayed relative, and the browser resolved it against the THREAD PAGE.
  const project = "/Users/me/projects/nub"
  assert.equal(
    resolveRelativeLocalPath(".ntwine/threads/6d56ea2f/HANDOFF.md", project),
    "/Users/me/projects/nub/.ntwine/threads/6d56ea2f/HANDOFF.md",
  )
  assert.equal(resolveRelativeLocalPath("packages/web/src/App.tsx", project), "/Users/me/projects/nub/packages/web/src/App.tsx")
})

test("a home-anchored path expands against home, never onto the base directory", () => {
  const base = "/repo/docs"
  const home = "/Users/me"
  assert.equal(resolveRelativeLocalPath("~/.claude/CLAUDE.md", base, home), "/Users/me/.claude/CLAUDE.md")
  assert.equal(resolveRelativeLocalPath("~", base, home), "/Users/me")
  // Without a home from the board there is nothing to expand against, and gluing `~` onto the base
  // would invent a directory nobody has: leave it alone so it renders as plain text.
  assert.equal(resolveRelativeLocalPath("~/.claude/CLAUDE.md", base), null)
  // `~` only anchors at the START. A file whose own name begins with one is still relative.
  assert.equal(resolveRelativeLocalPath("notes/~draft.md", base, home), "/repo/docs/notes/~draft.md")
})

test("a document's base directory is its parent", () => {
  assert.equal(localFileDir("/repo/docs/guide.md"), "/repo/docs")
  assert.equal(localFileDir("/README.md"), "/")
})

test("a Windows base resolves relative links in its own separator and under its drive (Windows audit 2026-09-11, finding 12)", () => {
  // Before the audit every case here was null — no relative link in a rendered local Markdown file
  // ever opened on Windows. The link is written with `/` whatever the platform; the base decides.
  const base = "C:\\Users\\x\\proj\\docs"
  assert.equal(resolveRelativeLocalPath("guide.md", base), "C:\\Users\\x\\proj\\docs\\guide.md")
  assert.equal(resolveRelativeLocalPath("./guide.md", base), "C:\\Users\\x\\proj\\docs\\guide.md")
  assert.equal(resolveRelativeLocalPath("../AGENTS.md", base), "C:\\Users\\x\\proj\\AGENTS.md")
  assert.equal(resolveRelativeLocalPath("a/../b/c.md", base), "C:\\Users\\x\\proj\\docs\\b\\c.md")
  assert.equal(resolveRelativeLocalPath("shots/one%20two.png", base), "C:\\Users\\x\\proj\\docs\\shots\\one two.png")
  assert.equal(resolveRelativeLocalPath("guide.md#section", base), "C:\\Users\\x\\proj\\docs\\guide.md")
  // A `..` escape climbs no higher than the drive, as it climbs no higher than `/` on POSIX.
  assert.equal(resolveRelativeLocalPath("../../../../../etc/passwd", base), "C:\\etc\\passwd")
  // A forward-slash drive path (how some tools spell it) keeps its own spelling; a mixed base takes
  // its first separator.
  assert.equal(resolveRelativeLocalPath("docs/guide.md", "C:/Users/x/proj"), "C:/Users/x/proj/docs/guide.md")
  assert.equal(resolveRelativeLocalPath("src/a.ts", "C:\\Users\\x/proj"), "C:\\Users\\x\\proj\\src\\a.ts")
  // A Windows home expands `~` the same way.
  assert.equal(resolveRelativeLocalPath("~/.claude/CLAUDE.md", base, "C:\\Users\\x"), "C:\\Users\\x\\.claude\\CLAUDE.md")
  assert.equal(resolveRelativeLocalPath("~", base, "C:\\Users\\x"), "C:\\Users\\x")
  // Already absolute is not relative: a drive path reads as a scheme (`c:`), a `\`-rooted one as a root.
  assert.equal(resolveRelativeLocalPath("C:\\Users\\x\\other.md", base), null)
  assert.equal(resolveRelativeLocalPath("\\abs\\x.md", base), null)
  // The base itself must be rooted; a bare drive is drive-relative and is not.
  assert.equal(resolveRelativeLocalPath("guide.md", "proj\\docs"), null)
  assert.equal(resolveRelativeLocalPath("guide.md", "C:"), null)
})

test("a Windows document's base directory is its parent, in its own separator", () => {
  assert.equal(localFileDir("C:\\Users\\x\\proj\\docs\\guide.md"), "C:\\Users\\x\\proj\\docs")
  assert.equal(localFileDir("C:/Users/x/proj/README.md"), "C:/Users/x/proj")
  assert.equal(localFileDir("C:\\README.md"), "C:\\")
})

// EVERY SPELLING OF A PLACE IN A FILE, on every absolute destination kind — split off the path, never
// left on it: the reader is handed the bare path, the external app the line (lib/localFilePosition.ts).
test("an absolute destination's line comes off the path as a position", () => {
  const cases: [string, string, { line: number; column?: number; endLine?: number }][] = [
    ["/repo/src/a.ts:12", "/repo/src/a.ts", { line: 12 }],
    ["/repo/src/a.ts:12:3", "/repo/src/a.ts", { line: 12, column: 3 }],
    ["/repo/src/a.ts:12-20", "/repo/src/a.ts", { line: 12, endLine: 20 }],
    ["/repo/src/a.ts#L12", "/repo/src/a.ts", { line: 12 }],
    ["/repo/src/a.ts#L12-L20", "/repo/src/a.ts", { line: 12, endLine: 20 }],
    ["/repo/src/a.ts#L12C4", "/repo/src/a.ts", { line: 12, column: 4 }],
    ["/repo/one%20two.ts#L5", "/repo/one two.ts", { line: 5 }],
    ["file:///repo/src/a.ts#L4", "/repo/src/a.ts", { line: 4 }],
    ["file:///repo/src/a.ts:4:2", "/repo/src/a.ts", { line: 4, column: 2 }],
    ["C:\\repo\\a.ts:7", "C:\\repo\\a.ts", { line: 7 }],
    ["D:/repo/a.ts#L7-L9", "D:/repo/a.ts", { line: 7, endLine: 9 }],
  ]
  for (const [href, filePath, position] of cases) {
    const target = localMarkdownTarget(href)
    assert.equal(target?.filePath, filePath, href)
    assert.deepEqual(target?.position, position, href)
  }
  // Negative controls: a section anchor, a line 0 and a non-numeric tail name no line.
  for (const href of ["/repo/AGENTS.md#setup", "/repo/a.ts:0", "/repo/a.ts:x", "/repo/a.ts#Lx"]) {
    assert.equal(localMarkdownTarget(href)?.position, undefined, href)
  }
})

// A bare filename at the base's root with a line passes the scheme test (`app.tsx:` is a legal scheme)
// and was a dead anchor, while `src/a.ts:12` resolved.
test("a bare filename with a line is a file at the base's root, not a scheme", () => {
  const base = "/repo"
  assert.deepEqual(resolveRelativeLocalTarget("App.tsx:42", base), { path: "/repo/App.tsx", position: { line: 42 } })
  assert.deepEqual(resolveRelativeLocalTarget("README.md:3", base), { path: "/repo/README.md", position: { line: 3 } })
  assert.deepEqual(resolveRelativeLocalTarget("a.ts:12-20", base), { path: "/repo/a.ts", position: { line: 12, endLine: 20 } })
  assert.deepEqual(resolveRelativeLocalTarget("a.ts:12:3", base), { path: "/repo/a.ts", position: { line: 12, column: 3 } })
  assert.equal(resolveRelativeLocalPath("App.tsx:42", base), "/repo/App.tsx")
  // Real schemes stay links — including the ones whose payload is digits — and so does a drive path.
  for (const href of [
    "mailto:x", "mailto:a@b.c", "http:", "http://h:80", "https://example.com:8080/a.ts:3", "javascript:alert(1)", "javascript:1",
    "tel:5551234", "localhost:3000", "vscode://file/repo/a.ts:12", "file:///repo/a.ts:3", "c:\\repo\\a.ts:3", "C:/repo/a.ts:3",
    // A bare name with no position is still whatever scheme it reads as.
    "App.tsx:", "App.tsx:x",
  ]) assert.equal(resolveRelativeLocalTarget(href, base), null, JSON.stringify(href))
})

test("a relative link keeps its line, and the rebase hands it on through the href", () => {
  const base = "/repo"
  assert.deepEqual(resolveRelativeLocalTarget("src/a.ts:12", base), { path: "/repo/src/a.ts", position: { line: 12 } })
  assert.deepEqual(resolveRelativeLocalTarget("./docs/guide.md#L3-L9", base), { path: "/repo/docs/guide.md", position: { line: 3, endLine: 9 } })
  assert.deepEqual(resolveRelativeLocalTarget("~/notes.md#L2", base, "/home/me"), { path: "/home/me/notes.md", position: { line: 2 } })
  assert.deepEqual(resolveRelativeLocalTarget("guide.md#section", base), { path: "/repo/guide.md" })
  // The path-only reading is the same path, never with a suffix glued on.
  assert.equal(resolveRelativeLocalPath("src/a.ts:12", base), "/repo/src/a.ts")
  // The fragment the rebase writes reads back as the very position it came from.
  for (const position of [{ line: 12 }, { line: 12, column: 3 }, { line: 12, endLine: 20 }, { line: 12, column: 3, endLine: 20 }]) {
    assert.deepEqual(localMarkdownTarget(`/repo/a.ts${positionFragment(position)}`)?.position, position)
    assert.deepEqual(localMarkdownTarget(`C:\\repo\\a.ts${positionFragment(position)}`)?.position, position)
  }
  assert.equal(positionFragment(undefined), "")
})

test("a link whose label names the line opens there when its destination names none", () => {
  const path = "/repo/ark/type/__tests__/cyclic.test.ts"
  const linked = localMarkdownTarget(path)!
  const at = { display: `${path}:1473`, filePath: path, position: { line: 1473 } }
  assert.deepEqual(labelPosition(linked, "cyclic.test.ts:1473"), at)
  assert.deepEqual(labelPosition(linked, " __tests__/cyclic.test.ts#L1473 "), at)
  assert.deepEqual(labelPosition(linked, path + ":1473"), at)
  // The label must name THIS file; a destination's own line always wins.
  assert.deepEqual(labelPosition(linked, "scope.ts:1473"), linked)
  assert.deepEqual(labelPosition(linked, "test.ts:1473"), linked)
  assert.deepEqual(labelPosition(linked, "cyclic.test.ts"), linked)
  const own = localMarkdownTarget(`${path}:9`)!
  assert.deepEqual(labelPosition(own, "cyclic.test.ts:1473"), own)
})
