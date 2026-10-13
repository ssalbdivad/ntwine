import assert from "node:assert/strict"
import test from "node:test"
import type { EditedFile } from "@ntwine/shared"
import { editedFileSegments, editedFileTree, flattenEditedFileTree } from "./editedFileTree.ts"

const file = (path: string): EditedFile => ({ path, edits: 1 })

// The rows as the rail draws them: `depth·kind·name`, so a test reads like the rail looks.
function rows(files: EditedFile[], projectDir?: string, homeDir?: string): string[] {
  return flattenEditedFileTree(editedFileTree(files, projectDir, homeDir)).map((n) => `${n.depth}${n.kind === "dir" ? "d" : "f"} ${n.name}`)
}

test("a chain of single-child directories collapses into one row, like GitHub", () => {
  assert.deepEqual(
    rows([file("/repo/packages/web/src/components/ChatView.tsx"), file("/repo/packages/web/src/components/Sidebar.tsx")], "/repo"),
    ["0d packages/web/src/components", "1f ChatView.tsx", "1f Sidebar.tsx"],
  )
})

test("a directory that branches keeps its own row, and the chains below it collapse", () => {
  assert.deepEqual(
    rows([
      file("/repo/packages/web/src/components/ChatView.tsx"),
      file("/repo/packages/server/src/router.ts"),
      file("/repo/packages/server/src/router.test.ts"),
    ], "/repo"),
    ["0d packages", "1d server/src", "2f router.test.ts", "2f router.ts", "1d web/src/components", "2f ChatView.tsx"],
  )
})

test("a file beside a subdirectory is a branch: the directory keeps its row and the file sits under it", () => {
  assert.deepEqual(
    rows([file("/repo/src/index.ts"), file("/repo/src/lib/util.ts")], "/repo"),
    ["0d src", "1d lib", "2f util.ts", "1f index.ts"],
  )
})

test("directories come before files, each alphabetical and case-insensitive, at every level", () => {
  assert.deepEqual(
    rows([file("/repo/zeta.ts"), file("/repo/Alpha.ts"), file("/repo/b/x.ts"), file("/repo/README.md"), file("/repo/a/y.ts")], "/repo"),
    ["0d a", "1f y.ts", "0d b", "1f x.ts", "0f Alpha.ts", "0f README.md", "0f zeta.ts"],
  )
})

test("a file at the project root is a depth-0 file row", () => {
  assert.deepEqual(rows([file("/repo/package.json")], "/repo"), ["0f package.json"])
})

test("a file outside the project keeps its absolute path, rooted at / and collapsed the same way", () => {
  assert.deepEqual(
    rows([file("/Users/me/.claude/CLAUDE.md"), file("/repo/src/a.ts")], "/repo"),
    ["0d /Users/me/.claude", "1f CLAUDE.md", "0d src", "1f a.ts"],
  )
})

test("a file under the home directory is rooted at ~ (maintainer 2026-10-05), the project still wins inside it, and /tmp stays absolute", () => {
  const home = "/Users/me"
  const files = [
    "/Users/me/proj/README.md",
    "/Users/me/proj/src/a.ts",
    "/Users/me/.claude/CLAUDE.md",
    "/Users/me/.claude/projects/-demo-/memory/note.md",
    "/Users/me/.agents/skills/demo/SKILL.md",
    "/tmp/ntwine-x/scratch.md",
  ].map(file)
  assert.deepEqual(rows(files, "/Users/me/proj", home), [
    "0d /tmp/ntwine-x",
    "1f scratch.md",
    "0d ~",
    "1d .agents/skills/demo",
    "2f SKILL.md",
    "1d .claude",
    "2d projects/-demo-/memory",
    "3f note.md",
    "2f CLAUDE.md",
    "0d src",
    "1f a.ts",
    "0f README.md",
  ])
  // A lone chain collapses onto the `~` root the way it does onto any name.
  assert.deepEqual(rows([file("/Users/me/.claude/CLAUDE.md")], "/Users/me/proj", home), ["0d ~/.claude", "1f CLAUDE.md"])
  assert.deepEqual(rows([file("/Users/me/notes.md")], "/Users/me/proj", home), ["0d ~", "1f notes.md"])
  // The directory paths the rail keys on: `~` does not double, and nothing under it reads `/`.
  const dirs = flattenEditedFileTree(editedFileTree(files, "/Users/me/proj", home)).flatMap((n) => (n.kind === "dir" ? [n.path] : []))
  assert.deepEqual(dirs, ["/tmp/ntwine-x", "~", "~/.agents/skills/demo", "~/.claude", "~/.claude/projects/-demo-/memory", "src"])
  // A sibling user's home is not this one.
  assert.deepEqual(editedFileSegments("/Users/meow/a.ts", "/Users/me/proj", home), ["/", "Users", "meow", "a.ts"])
})

test("without a project directory every path is absolute", () => {
  assert.deepEqual(rows([file("/repo/src/a.ts")]), ["0d /repo/src", "1f a.ts"])
})

test("a directory's path is unique where its name repeats: two `lib` rows at one depth", () => {
  const files = ["/p/one/x.ts", "/p/one/lib/a.ts", "/p/two/y.ts", "/p/two/lib/b.ts"].map((path) => ({ path, edits: 1 }))
  const dirs = flattenEditedFileTree(editedFileTree(files, "/p")).flatMap((n) => (n.kind === "dir" ? [n.path] : []))
  assert.deepEqual(dirs, ["one", "one/lib", "two", "two/lib"])
  // Outside the project the root is `/`, and it does not double.
  const outside = flattenEditedFileTree(editedFileTree([{ path: "/etc/a/b.conf", edits: 1 }, { path: "/etc/c.conf", edits: 1 }]))
  assert.deepEqual(outside.flatMap((n) => (n.kind === "dir" ? [n.path] : [])), ["/etc", "/etc/a"])
})

test("segments: a trailing slash on either side is not a segment, and the project dir itself is not under itself", () => {
  assert.deepEqual(editedFileSegments("/repo/src/a.ts/", "/repo/"), ["src", "a.ts"])
  assert.deepEqual(editedFileSegments("/repo", "/repo"), ["/", "repo"])
  assert.deepEqual(editedFileSegments("/repo-other/a.ts", "/repo"), ["/", "repo-other", "a.ts"])
})

test("the file node carries the edited file, diffstat and all", () => {
  const edited: EditedFile = { path: "/repo/a.ts", edits: 3, added: 10, removed: 2 }
  const [node] = editedFileTree([edited], "/repo")
  assert.equal(node.kind, "file")
  if (node.kind === "file") assert.deepEqual(node.file, edited)
})

test("a Windows project nests the same tree: either separator, drive letter case-insensitive (Windows audit 2026-09-11, finding 12)", () => {
  // Before the audit each of these was one flat node carrying the whole `C:\…` path.
  const project = "C:\\Users\\x\\proj"
  assert.deepEqual(
    rows([
      file("C:\\Users\\x\\proj\\src\\components\\ChatView.tsx"),
      file("c:/Users/x/proj/src/components/Sidebar.tsx"),
      file("C:\\Users\\x\\proj\\src\\index.ts"),
    ], project),
    ["0d src", "1d components", "2f ChatView.tsx", "2f Sidebar.tsx", "1f index.ts"],
  )
  // Outside the project the drive is the first segment, and the chain collapses with `/` as every
  // chain does — `C:/Users/x/.claude` is a spelling Windows accepts.
  assert.deepEqual(rows([file("C:\\Users\\x\\.claude\\CLAUDE.md")], project), ["0d C:/Users/x/.claude", "1f CLAUDE.md"])
  // With the board's home, the same file is rooted at `~`, matched in either separator and drive case;
  // a path on another drive keeps the drive as its root.
  assert.deepEqual(
    rows([file("C:\\Users\\x\\.claude\\CLAUDE.md"), file("D:\\scratch\\a.ts")], project, "c:/Users/x"),
    ["0d ~/.claude", "1f CLAUDE.md", "0d D:/scratch", "1f a.ts"],
  )
  assert.deepEqual(editedFileSegments("C:\\Users\\x\\proj\\src\\a.ts\\", "C:\\Users\\x\\proj\\"), ["src", "a.ts"])
  assert.deepEqual(editedFileSegments("C:\\Users\\x\\proj", project), ["C:", "Users", "x", "proj"])
  assert.deepEqual(editedFileSegments("C:\\Users\\x\\proj-other\\a.ts", project), ["C:", "Users", "x", "proj-other", "a.ts"])
  assert.deepEqual(editedFileSegments("D:\\Users\\x\\proj\\a.ts", project), ["D:", "Users", "x", "proj", "a.ts"])
  assert.deepEqual(editedFileSegments("C:\\Users\\x/proj\\src/a.ts", "C:/Users/x/proj"), ["src", "a.ts"])
})
