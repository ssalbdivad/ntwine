import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { EditorProject } from "@ntwine/shared/editor-protocol"
import { projectForPath, relativeWithin, workspaceProjects } from "./projects.ts"

const identity = (path: string) => path
const posix = { realpath: identity, platform: "linux" as const }

const project = (id: string, dir: string, extra: Partial<EditorProject> = {}): EditorProject => ({ id, slug: id, name: id, dir, ...extra })
const home = project("home", "/home/me", { home: true })
const repo = project("repo", "/home/me/repo")
const nested = project("nested", "/home/me/repo/vendor/lib")
const sibling = project("repo2", "/home/me/repo2")
const all = [home, repo, nested, sibling]

test("a file belongs to the longest project folder that holds it, never a sibling that shares a prefix", () => {
  assert.equal(projectForPath("/home/me/repo/src/a.ts", all, posix)?.project.id, "repo")
  assert.equal(projectForPath("/home/me/repo/vendor/lib/x.ts", all, posix)?.project.id, "nested")
  assert.equal(projectForPath("/home/me/repo2/a.ts", all, posix)?.project.id, "repo2")
  assert.deepEqual(projectForPath("/home/me/repo/src/a.ts", all, posix), { project: repo, path: "/home/me/repo/src/a.ts", relative: "src/a.ts" })
  // Order of the push does not matter.
  assert.equal(projectForPath("/home/me/repo/vendor/lib/x.ts", [...all].reverse(), posix)?.project.id, "nested")
})

test("Home is last: it takes only what no registered project holds, however deep Home's folder is", () => {
  assert.equal(projectForPath("/home/me/notes/today.md", all, posix)?.project.id, "home")
  const deepHome = project("home", "/home/me/repo/sub", { home: true })
  assert.equal(projectForPath("/home/me/repo/sub/a.ts", [deepHome, repo], posix)?.project.id, "repo")
  assert.equal(projectForPath("/tmp/scratch.ts", all, posix), undefined, "outside every folder, Home included")
})

test("a file opened through a symlink matches the project by its real path, and says so", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-vscode-projects-")))
  try {
    mkdirSync(join(root, "real", "proj", "src"), { recursive: true })
    writeFileSync(join(root, "real", "proj", "src", "a.ts"), "")
    symlinkSync(join(root, "real"), join(root, "link"))
    const real = project("real", join(root, "real", "proj"))
    const viaLink = join(root, "link", "proj", "src", "a.ts")
    assert.deepEqual(projectForPath(viaLink, [real], { platform: "linux" }), { project: real, path: join(root, "real", "proj", "src", "a.ts"), relative: "src/a.ts" })
    // Negative control: compared by spelling alone, the link's path is in no project.
    assert.equal(projectForPath(viaLink, [real], posix), undefined)
    // And a project registered under the link's spelling still matches the canonical path.
    const linked = project("linked", join(root, "link", "proj"))
    assert.equal(projectForPath(join(root, "real", "proj", "src", "a.ts"), [linked], { platform: "linux" })?.project.id, "linked")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("Windows paths compare without case and with either separator, keeping the file's own spelling", () => {
  const win = { realpath: identity, platform: "win32" as const }
  const proj = project("proj", "C:\\Users\\Me\\proj")
  const winHome = project("home", "C:\\Users\\Me", { home: true })
  assert.deepEqual(projectForPath("c:\\users\\me\\proj\\src\\App.tsx", [winHome, proj], win), { project: proj, path: "c:\\users\\me\\proj\\src\\App.tsx", relative: "src\\App.tsx" })
  assert.equal(projectForPath("C:/Users/Me/proj/src/a.ts", [winHome, proj], win)?.relative, "src/a.ts")
  assert.equal(projectForPath("C:\\Users\\Me\\project2\\a.ts", [winHome, proj], win)?.project.id, "home")
  // Case and separators matter on POSIX: the same comparison off Windows is a different folder.
  assert.equal(relativeWithin("/Home/Me/proj", "/home/me/proj/a.ts", "linux"), undefined)
})

test("relativeWithin handles the folder itself, trailing separators and the filesystem root", () => {
  assert.equal(relativeWithin("/home/me/repo/", "/home/me/repo", "linux"), "")
  assert.equal(relativeWithin("/home/me/repo", "/home/me/repo/a.ts", "linux"), "a.ts")
  assert.equal(relativeWithin("/", "/etc/hosts", "linux"), "etc/hosts")
  assert.equal(relativeWithin("C:\\", "C:\\x\\y.ts", "win32"), "x\\y.ts")
})

test("a workspace is about the projects inside its folders, else the project holding them", () => {
  assert.deepEqual(workspaceProjects(["/home/me/repo"], all, posix).map((p) => p.id), ["repo", "nested"])
  assert.deepEqual(workspaceProjects(["/home/me/repo/src"], all, posix).map((p) => p.id), ["repo"])
  assert.deepEqual(workspaceProjects(["/home/me"], all, posix).map((p) => p.id), ["repo", "nested", "repo2"], "Home's folder holds projects; Home itself is not one of them")
  assert.deepEqual(workspaceProjects(["/home/me/notes"], all, posix).map((p) => p.id), ["home"])
  assert.deepEqual(workspaceProjects(["/srv/elsewhere"], all, posix), [])
  assert.deepEqual(workspaceProjects(["/home/me/repo2", "/home/me/repo2/a"], all, posix).map((p) => p.id), ["repo2"], "a project named twice counts once")
})
