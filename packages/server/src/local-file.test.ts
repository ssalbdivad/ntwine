import { EventEmitter } from "node:events"
import { execFileSync } from "node:child_process"
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { tmpdir } from "node:os"
import { join } from "node:path"
import assert from "node:assert/strict"
import { test } from "node:test"
import type { LocalFileOpener } from "@ntwine/shared"
import {
  MARKDOWN_READ_LIMIT,
  editorKindsForOpener,
  localFileOpenCommand,
  awaitOpenerHandoff,
  openLocalFile,
  openLocalFolder,
  type LocalFileSpawn,
  readLocalMarkdown,
  readLocalTextFile,
  resolveLocalFile,
  resolveLocalFileAt,
  resolveOpenableFile,
  mainCheckoutCopy,
  resolveWatchableLocalFile,
} from "./local-file.ts"

interface SpawnCall { command: string; args: readonly string[]; options: Parameters<LocalFileSpawn>[2] }

test("Windows URL-shaped paths read, watch and open without bypassing trusted roots", { skip: process.platform !== "win32" }, async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-local-url-")))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const trusted = join(root, "trusted")
  mkdirSync(trusted)
  const file = join(trusted, "plan space %.md")
  writeFileSync(file, "# Plan\n")
  const urlPath = decodeURIComponent(pathToFileURL(file).pathname)
  assert.match(urlPath, /^\/[A-Za-z]:\//)
  assert.throws(() => realpathSync(urlPath), { code: "ENOENT" })
  for (const path of [file, urlPath, `/${file}`]) {
    assert.deepEqual(readLocalMarkdown(path, [trusted]), { path: file, markdown: "# Plan\n", truncated: false })
    assert.equal(readLocalTextFile(path, [trusted]).text, "# Plan\n")
    assert.equal(resolveWatchableLocalFile(path, [trusted]), file)
    assert.equal(resolveOpenableFile(path, trusted, [trusted]), file)
    assert.deepEqual(await openLocalFile(path, "copy", [trusted]), { action: "copy", path: file })
  }
  const outside = join(root, "secret.md")
  writeFileSync(outside, "secret")
  assert.throws(() => readLocalMarkdown(decodeURIComponent(pathToFileURL(outside).pathname), [trusted]), /trusted roots/)
  assert.throws(() => readLocalMarkdown(`${urlPath}/../gone.md`, [trusted]), /was not found/)
  assert.throws(() => resolveLocalFile("relative.md", [trusted]), /absolute/)
})

test("a Windows root and a path spelled in another case are one directory", { skip: process.platform !== "win32" }, (t) => {
  // `d:\dev\…` under a root git reported as `D:\Development\…` is the same file, and refusing it as
  // "outside Ntwine's trusted roots" is how a live file link died for a difference of case alone.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-local-case-")))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, "Plan.md")
  writeFileSync(file, "# Plan\n")
  assert.equal(resolveLocalFile(file.toLowerCase(), [root.toUpperCase()]), realpathSync(file.toLowerCase()))
  assert.equal(readLocalMarkdown(file.toUpperCase(), [root.toLowerCase()]).markdown, "# Plan\n")
  // Containment itself still holds: a sibling of the root is out however it is spelled.
  const outside = join(realpathSync(tmpdir()), `ntwine-local-case-outside-${process.pid}.md`)
  writeFileSync(outside, "secret")
  t.after(() => rmSync(outside, { force: true }))
  assert.throws(() => readLocalMarkdown(outside.toLowerCase(), [root]), /trusted roots/)
})

test("Windows containment rejects a case-distinct sibling and symlinks into it", { skip: process.platform !== "win32" }, async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-local-sensitive-")))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  // This needs NTFS per-directory case sensitivity (the WSL optional feature). Verification
  // hosts set NTWINE_REQUIRE_CASE_SENSITIVE_FS=1 so unavailable coverage cannot look like a pass.
  try {
    execFileSync("fsutil.exe", ["file", "setCaseSensitiveInfo", root, "enable"], { stdio: "pipe" })
  } catch (error) {
    if (process.env.NTWINE_REQUIRE_CASE_SENSITIVE_FS === "1") throw error
    t.skip("NTFS per-directory case sensitivity is unavailable")
    return
  }
  const trusted = join(root, "Repo")
  const sibling = join(root, "repo")
  mkdirSync(trusted)
  mkdirSync(sibling)
  assert.notEqual(statSync(trusted, { bigint: true }).ino, statSync(sibling, { bigint: true }).ino)
  const inside = join(trusted, "plan.md")
  const outside = join(sibling, "secret.md")
  writeFileSync(inside, "# Inside\n")
  writeFileSync(outside, "# Outside\n")
  assert.equal(readLocalMarkdown(inside, [trusted]).markdown, "# Inside\n")
  assert.throws(() => readLocalMarkdown(outside, [trusted]), /trusted roots/)
  assert.throws(() => readLocalTextFile(outside, [trusted]), /trusted roots/)
  assert.throws(() => resolveWatchableLocalFile(outside, [trusted]), /trusted roots/)
  assert.equal(resolveOpenableFile(outside, trusted, [trusted]), null)
  await assert.rejects(openLocalFile(outside, "copy", [trusted]), /trusted roots/)

  const escape = join(trusted, "escape.md")
  symlinkSync(outside, escape)
  assert.throws(() => resolveLocalFile(escape, [trusted]), /trusted roots/)
  const alias = join(root, "alias")
  symlinkSync(trusted, alias, "junction")
  assert.equal(readLocalMarkdown(join(alias, "plan.md"), [trusted]).markdown, "# Inside\n")
  const outsideHardlink = join(sibling, "hardlink.md")
  linkSync(inside, outsideHardlink)
  assert.throws(() => resolveLocalFile(outsideHardlink, [trusted]), /trusted roots/)
})

// A ChildProcess stand-in that settles the way a real spawn does: asynchronously, through a `spawn`
// or an `error` EVENT. The `error` is emitted with no listener of the fake's own, so an opener that
// forgot to attach one would throw out of the microtask and kill the test process — which is the
// production crash this pins, in miniature.
function fakeSpawn(calls: SpawnCall[], fail?: NodeJS.ErrnoException): LocalFileSpawn {
  return (command, args, options) => {
    calls.push({ command, args, options })
    const child = Object.assign(new EventEmitter(), { unref() {} })
    queueMicrotask(() => {
      if (fail) return void child.emit("error", fail)
      child.emit("spawn")
      child.emit("exit", 0, null)
    })
    return child
  }
}

test("local opener canonicalizes a regular file inside its trusted root and uses fixed argv", async () => {
  const root = mkdtempSync(join(tmpdir(), "ntwine-local-file-"))
  const file = join(root, "space ; $(not-a-command).md")
  writeFileSync(file, "safe")
  const calls: SpawnCall[] = []
  const result = await openLocalFile(file, "system", [root], { spawn: fakeSpawn(calls) })
  assert.deepEqual(result, { action: "opened", path: realpathSync(file) })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].args.at(-1), realpathSync(file))
  assert.equal(calls[0].options.shell, false)
  assert.equal(calls[0].options.windowsHide, true, "a console opener never flashes a window")
})

test("an opener that cannot start is the RPC's error, not an unhandled `error` event", async () => {
  // Windows audit 2026-09-11, finding 1: `xdg-open` does not exist on Windows, so the spawn emitted
  // ENOENT with nobody listening and the control-plane child exited. Now it is a rejection the
  // router answers with.
  const root = mkdtempSync(join(tmpdir(), "ntwine-local-file-enoent-"))
  const file = join(root, "README.md")
  writeFileSync(file, "safe")
  const enoent = Object.assign(new Error("spawn xdg-open ENOENT"), { code: "ENOENT" })
  await assert.rejects(
    openLocalFile(file, "system", [root], { platform: "linux", spawn: fakeSpawn([], enoent) }),
    /^Error: xdg-open is not installed or not on PATH$/u,
  )
  const eacces = Object.assign(new Error("spawn cursor EACCES"), { code: "EACCES" })
  await assert.rejects(
    openLocalFile(file, "cursor", [root], { platform: "linux", spawn: fakeSpawn([], eacces) }),
    /^Error: could not start cursor: spawn cursor EACCES$/u,
  )
})

test("an opener counts as open when its launcher EXITS: non-zero is its error, explorer's 1 is not, a hang is capped", async () => {
  const launched = (events: (child: EventEmitter) => void) => {
    const child = Object.assign(new EventEmitter(), { unref() {} })
    queueMicrotask(() => events(child))
    return child
  }
  let settled = false
  const handoff = awaitOpenerHandoff(launched((c) => { c.emit("spawn"); setTimeout(() => c.emit("exit", 0, null), 30) }), "code").then(() => { settled = true })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(settled, false, "started is not open: the window is still coming")
  await handoff
  await assert.rejects(awaitOpenerHandoff(launched((c) => { c.emit("spawn"); c.emit("exit", 2, null) }), "xdg-open"), /^Error: xdg-open exited with code 2$/u)
  await awaitOpenerHandoff(launched((c) => { c.emit("spawn"); c.emit("exit", 1, null) }), "explorer.exe")
  await awaitOpenerHandoff(launched((c) => c.emit("spawn")), "vim", 20)
})

test("Open in editor: a folder opens in the Local file links editor, else $EDITOR, else a reason", async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-local-folder-")))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const open = async (opener: LocalFileOpener, env: NodeJS.ProcessEnv) => {
    const calls: SpawnCall[] = []
    await openLocalFolder(dir, opener, { platform: "linux", env, spawn: fakeSpawn(calls) })
    return [calls[0]!.command, ...calls[0]!.args]
  }
  assert.deepEqual(await open("vscode", {}), ["code", dir])
  assert.deepEqual(await open("cursor", { EDITOR: "zed" }), ["cursor", dir], "the setting outranks $EDITOR")
  // System default, Reveal and Copy path would hand a folder to a file manager or to nothing.
  for (const opener of ["system", "finder", "copy"] as const) {
    assert.deepEqual(await open(opener, { VISUAL: "nvim", EDITOR: "subl -n" }), ["subl", "-n", dir], opener)
    await assert.rejects(open(opener, { EDITOR: "vim" }), /^Error: Set Local file links to an editor in Settings$/u)
  }
  await assert.rejects(open("vscode", {}).then(() => openLocalFolder(join(dir, "gone"), "vscode", { spawn: fakeSpawn([]) })), /is not a folder/)
})

test("windows: explorer opens and reveals, an installed editor runs its exe, a missing one runs its shim through cmd.exe", () => {
  const path = "C:\\Users\\op\\proj\\space & caret^.md"
  const env = { LOCALAPPDATA: "C:\\Users\\op\\AppData\\Local" }
  const cursorExe = join(env.LOCALAPPDATA, "Programs", "cursor", "Cursor.exe")
  const exists = (candidate: string) => candidate === cursorExe
  const opts = { platform: "win32" as const, env, exists }
  assert.deepEqual(localFileOpenCommand(path, "system", opts), { command: "explorer.exe", args: [path] })
  assert.deepEqual(localFileOpenCommand(path, "finder", opts), { command: "explorer.exe", args: [`/select,${path}`] })
  assert.deepEqual(localFileOpenCommand(path, "cursor", opts), { command: cursorExe, args: [path] })
  // No Code.exe under %LOCALAPPDATA%: the `code` shim runs through cmd.exe, in ONE verbatim argument
  // with the path quoted, so `&` and `^` stay characters of the path.
  assert.deepEqual(localFileOpenCommand(path, "vscode", opts), {
    command: "cmd.exe", args: ["/d", "/s", "/c", `"code "${path}""`], verbatim: true,
  })
  // A `%` would be expanded by cmd.exe even inside quotes, so that path is refused rather than run.
  assert.throws(() => localFileOpenCommand("C:\\p\\100%done.md", "vscode", opts), /cannot hand .* through cmd\.exe/u)
  // Without LOCALAPPDATA at all the shim path is still reachable.
  assert.equal(localFileOpenCommand(path, "cursor", { platform: "win32", env: {}, exists }).command, "cmd.exe")
})

test("windows: the cmd.exe shape reaches spawn with verbatim arguments, everything else without", async () => {
  const root = mkdtempSync(join(tmpdir(), "ntwine-local-file-win32-"))
  const file = join(root, "app.ts")
  writeFileSync(file, "safe")
  const calls: SpawnCall[] = []
  const win32 = { platform: "win32" as const, env: {}, exists: () => false, spawn: fakeSpawn(calls) }
  await openLocalFile(file, "vscode", [root], win32)
  await openLocalFile(file, "system", [root], win32)
  assert.equal(calls[0].command, "cmd.exe")
  assert.equal(calls[0].options.windowsVerbatimArguments, true)
  assert.equal(calls[0].options.shell, false, "never shell: true — the quoting is ours, inside one argument")
  assert.equal(calls[1].command, "explorer.exe")
  assert.equal(calls[1].options.windowsVerbatimArguments, undefined)
})

test("each opener preference selects its own app, and an image ignores the preference entirely", async () => {
  const root = mkdtempSync(join(tmpdir(), "ntwine-local-file-opener-"))
  const file = join(root, "app.ts")
  writeFileSync(file, "safe")
  const argvFor = async (opener: LocalFileOpener, forceSystem = false) => {
    const calls: SpawnCall[] = []
    await openLocalFile(file, opener, [root], { forceSystem, spawn: fakeSpawn(calls), env: {}, exists: () => false })
    return [calls[0]!.command, ...calls[0]!.args.slice(0, -1)]
  }
  // The reported bug was upstream of here — the transcript's file links carried a `cursor://` href the
  // OS resolved, so "VS Code" never reached this function at all — but nothing pinned the mapping the
  // setting is FOR, so a swap here would have gone unnoticed too.
  const expected = process.platform === "darwin"
    ? { system: ["open"], cursor: ["open", "-a", "Cursor"], vscode: ["open", "-a", "Visual Studio Code"], finder: ["open", "-R"] }
    : process.platform === "win32"
      ? { system: ["explorer.exe"], cursor: ["cmd.exe", "/d", "/s", "/c"], vscode: ["cmd.exe", "/d", "/s", "/c"], finder: ["explorer.exe"] }
    : { system: ["xdg-open"], cursor: ["cursor"], vscode: ["code"], finder: ["xdg-open"] }
  assert.deepEqual(await argvFor("system"), expected.system)
  assert.deepEqual(await argvFor("cursor"), expected.cursor)
  assert.deepEqual(await argvFor("vscode"), expected.vscode)
  assert.deepEqual(await argvFor("finder"), expected.finder)
  // An image has a viewer of its own, so it goes to the OS default whatever the editor preference says.
  assert.deepEqual(await argvFor("vscode", true), expected.system)
})

test("local opener refuses relative, outside, directory, and escaping symlink paths", () => {
  const root = mkdtempSync(join(tmpdir(), "ntwine-local-file-root-"))
  const outside = mkdtempSync(join(tmpdir(), "ntwine-local-file-outside-"))
  const outsideFile = join(outside, "secret.txt")
  writeFileSync(outsideFile, "no")
  const link = join(root, "escape.txt")
  symlinkSync(outsideFile, link)
  assert.throws(() => resolveLocalFile("relative.txt", [root]), /absolute/)
  assert.throws(() => resolveLocalFile(outsideFile, [root]), /trusted roots/)
  assert.throws(() => resolveLocalFile(root, [root]), /regular file/)
  assert.throws(() => resolveLocalFile(link, [root]), /trusted roots/)
})

test("copy preference returns only the canonical trusted path without spawning", async () => {
  const root = mkdtempSync(join(tmpdir(), "ntwine-local-file-copy-"))
  const file = join(root, "artifact.txt")
  writeFileSync(file, "safe")
  assert.deepEqual(await openLocalFile(file, "copy", [root], { spawn: () => { throw new Error("must not spawn") } }), { action: "copy", path: realpathSync(file) })
})

test("resolveOpenableFile classifies references: home (~), project-relative, absolute, :line, and misses", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-openable-home-")))
  const project = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-openable-proj-")))
  const roots = [home, project]
  writeFileSync(join(home, "CLAUDE.md"), "cfg")
  mkdirSync(join(project, "packages", "web", "src"), { recursive: true })
  writeFileSync(join(project, "packages", "web", "src", "App.tsx"), "code")

  // ~-relative expands to the home root
  assert.equal(resolveOpenableFile("~/CLAUDE.md", project, roots, home), join(home, "CLAUDE.md"))
  // A Windows worker spells the same reference with a backslash (2026-09-11).
  assert.equal(resolveOpenableFile("~\\CLAUDE.md", project, roots, home), join(home, "CLAUDE.md"))
  // repo-relative resolves against the project dir
  assert.equal(resolveOpenableFile("packages/web/src/App.tsx", project, roots, home), join(project, "packages", "web", "src", "App.tsx"))
  // an absolute path is taken as-is
  assert.equal(resolveOpenableFile(join(project, "packages/web/src/App.tsx"), project, roots, home), join(project, "packages", "web", "src", "App.tsx"))
  // a trailing :line[:col] editor suffix is stripped before resolving
  assert.equal(resolveOpenableFile("packages/web/src/App.tsx:42:7", project, roots, home), join(project, "packages", "web", "src", "App.tsx"))
  // misses → null (never throws): nonexistent, a directory, and a path outside the roots
  assert.equal(resolveOpenableFile("~/nope.md", project, roots, home), null)
  assert.equal(resolveOpenableFile("packages/web", project, roots, home), null) // a directory, not a file
  assert.equal(resolveOpenableFile("/etc/hosts", project, roots, home), null) // outside the openable roots
  assert.equal(resolveOpenableFile("   ", project, roots, home), null)
})

test("the Markdown reader admits only Markdown, only inside the roots, and only as a real file", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-local-md-")))
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-local-md-outside-")))
  writeFileSync(join(root, "README.md"), "# Title\n\nBody.\n")
  writeFileSync(join(root, "notes.txt"), "not markdown")
  writeFileSync(join(root, "post.mdx"), "import X from './x'\n\n# Post\n")
  writeFileSync(join(outside, "secret.md"), "no")
  // A `.md` name whose canonical target is something else: the extension is on the href, not the file.
  writeFileSync(join(root, "real.conf"), "PASSWORD=hunter2")
  symlinkSync(join(root, "real.conf"), join(root, "decoy.md"))
  // …while an ordinary symlinked doc (a skill file linked out of a shared tree) still reads.
  symlinkSync(join(root, "README.md"), join(root, "linked.md"))

  assert.deepEqual(readLocalMarkdown(join(root, "README.md"), [root]), {
    path: join(root, "README.md"),
    markdown: "# Title\n\nBody.\n",
    truncated: false,
  })
  assert.equal(readLocalMarkdown(join(root, "linked.md"), [root]).path, join(root, "README.md"))
  assert.equal(readLocalMarkdown(join(root, "post.mdx"), [root]).markdown, "import X from './x'\n\n# Post\n")
  assert.throws(() => readLocalMarkdown(join(root, "notes.txt"), [root]), /not a Markdown file/)
  assert.throws(() => readLocalMarkdown(join(root, "decoy.md"), [root]), /not a Markdown file/)
  assert.throws(() => readLocalMarkdown(join(outside, "secret.md"), [root]), /trusted roots/)
  assert.throws(() => readLocalMarkdown(join(root, "gone.md"), [root]), /was not found/)
  assert.throws(() => readLocalMarkdown("README.md", [root]), /absolute/)
})

test("an oversized Markdown file is cut at a line boundary and reports the cut", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-local-md-big-")))
  const file = join(root, "huge.md")
  const line = `${"x".repeat(99)}\n`
  writeFileSync(file, line.repeat(Math.ceil((MARKDOWN_READ_LIMIT * 1.5) / line.length)))
  const read = readLocalMarkdown(file, [root])
  assert.equal(read.truncated, true)
  assert.ok(read.markdown.length <= MARKDOWN_READ_LIMIT, "the cut respects the ceiling")
  assert.ok(read.markdown.length > MARKDOWN_READ_LIMIT - line.length, "the cut takes the whole prefix it can")
  // Whole lines only — the tail is never a half-written line (nor a split multi-byte character).
  assert.equal(read.markdown.endsWith("x".repeat(99)), true)
  assert.equal(read.markdown.split("\n").every((l) => l === "" || l.length === 99), true)
})

test("the text reader spans every openable root, not the project dir alone, and refuses binary", () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-local-text-project-")))
  // A worker's checkout is very often NOT the project directory — a git worktree, a sibling clone,
  // `/tmp` scratch. The viewer's gate is the reader's, so every one of those rows opens.
  const worktree = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-local-text-worktree-")))
  const untrusted = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-local-text-untrusted-")))
  const roots = [project, worktree]
  writeFileSync(join(project, "app.ts"), "export const a = 1\n")
  writeFileSync(join(worktree, "mod.rs"), "fn main() {}\n")
  writeFileSync(join(untrusted, "elsewhere.ts"), "no")
  writeFileSync(join(worktree, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d]))

  assert.equal(readLocalTextFile(join(project, "app.ts"), roots).text, "export const a = 1\n")
  assert.deepEqual(readLocalTextFile(join(worktree, "mod.rs"), roots), {
    path: join(worktree, "mod.rs"),
    text: "fn main() {}\n",
    truncated: false,
  })
  assert.throws(() => readLocalTextFile(join(untrusted, "elsewhere.ts"), roots), /trusted roots/)
  assert.throws(() => readLocalTextFile(join(worktree, "logo.png"), roots), /not a text file/)
})

test("a watch attaches exactly where the read is allowed, and a decoy .md arms nothing", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-local-watch-")))
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-local-watch-outside-")))
  writeFileSync(join(root, "README.md"), "# Title\n")
  writeFileSync(join(root, "app.ts"), "export const a = 1\n")
  writeFileSync(join(root, "real.conf"), "PASSWORD=hunter2")
  symlinkSync(join(root, "real.conf"), join(root, "decoy.md"))
  writeFileSync(join(outside, "other.ts"), "no")

  assert.equal(resolveWatchableLocalFile(join(root, "README.md"), [root]), join(root, "README.md"))
  assert.equal(resolveWatchableLocalFile(join(root, "app.ts"), [root]), join(root, "app.ts"))
  // The Markdown reader refuses a `.md` href whose canonical target is not Markdown, so the watch must
  // too — otherwise a file the reader cannot show still reports that it changed.
  assert.throws(() => resolveWatchableLocalFile(join(root, "decoy.md"), [root]), /not a Markdown file/)
  assert.throws(() => resolveWatchableLocalFile(join(outside, "other.ts"), [root]), /trusted roots/)
})

test("the $EDITOR opener runs $VISUAL/$EDITOR as an argv, skipping terminal editors, and says why it cannot", () => {
  const argv = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform = "linux") => {
    const spec = localFileOpenCommand("/p/app.ts", "editor", { env, platform })
    return [spec.command, ...spec.args]
  }
  assert.deepEqual(argv({ EDITOR: "code --wait" }), ["code", "--wait", "/p/app.ts"])
  assert.deepEqual(argv({ EDITOR: `"/opt/Sublime Text/subl" -w` }), ["/opt/Sublime Text/subl", "-w", "/p/app.ts"])
  // $VISUAL wins when it can open without a terminal…
  assert.deepEqual(argv({ VISUAL: "zed", EDITOR: "code" }), ["zed", "/p/app.ts"])
  // …and a terminal $VISUAL falls through to a GUI $EDITOR.
  assert.deepEqual(argv({ VISUAL: "nvim", EDITOR: "code -w" }), ["code", "-w", "/p/app.ts"])
  assert.deepEqual(argv({ EDITOR: "emacs" }), ["emacs", "/p/app.ts"])
  assert.throws(() => argv({ EDITOR: "emacs -nw" }), /needs a terminal/)
  assert.throws(() => argv({ EDITOR: "/usr/bin/vim" }), /vim, which needs a terminal/)
  assert.throws(() => argv({ EDITOR: "  " }), /not set/)
  assert.throws(() => argv({}), /not set/)
  // Windows: a bare name is a `.cmd` shim, so it goes through cmd.exe quoted; a real exe runs directly.
  assert.deepEqual(argv({ EDITOR: "code -w" }, "win32"), ["cmd.exe", "/d", "/s", "/c", `""code" "-w" "/p/app.ts""`])
  assert.deepEqual(argv({ EDITOR: "C:\\Zed\\zed.exe" }, "win32"), ["C:\\Zed\\zed.exe", "/p/app.ts"])
})

test("a position reaches every editor's argv: `-g path:line:col` for the VS Code family, the app bundle's own CLI on macOS, nothing for the system opener", () => {
  const at = { line: 12, column: 3, endLine: 20 }
  const argv = (selected: Parameters<typeof localFileOpenCommand>[1], platform: NodeJS.Platform, path: string, position?: typeof at | { line: number }, env: NodeJS.ProcessEnv = {}, exists = (_: string) => false) => {
    const spec = localFileOpenCommand(path, selected, { platform, env, exists, position })
    return [spec.command, ...spec.args]
  }
  // Linux (and WSL): the CLIs take the line through -g; the range end has no CLI spelling and is dropped.
  assert.deepEqual(argv("vscode", "linux", "/p/a.ts", at), ["code", "-g", "/p/a.ts:12:3"])
  assert.deepEqual(argv("cursor", "linux", "/p/a.ts", { line: 7 }), ["cursor", "-g", "/p/a.ts:7"])
  assert.deepEqual(argv("vscode", "linux", "/p/a.ts"), ["code", "/p/a.ts"], "no position: the argv is what it always was")
  assert.deepEqual(argv("system", "linux", "/p/a.ts", at), ["xdg-open", "/p/a.ts"], "the system opener cannot be told a line")
  // macOS: `open -a <app> a.ts:12` would open a file NAMED that, and `open vscode://file/…:12` makes VS
  // Code ask the human to confirm every one (security.promptForLocalFileProtocolHandling, on by default) —
  // so a position goes to the CLI inside the app bundle, under /Applications or ~/Applications, as an
  // argv: a space or `#` in the path is just part of it.
  const mac = { HOME: "/Users/me" }
  const codeCli = "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
  const userCodeCli = "/Users/me/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
  const cursorCli = "/Applications/Cursor.app/Contents/Resources/app/bin/cursor"
  const userCursorCli = "/Users/me/Applications/Cursor.app/Contents/Resources/app/bin/cursor"
  assert.deepEqual(argv("vscode", "darwin", "/Users/me/my app/a#b.ts", at, mac, (p) => p === codeCli), [codeCli, "-g", "/Users/me/my app/a#b.ts:12:3"])
  assert.deepEqual(argv("vscode", "darwin", "/p/a.ts", at, mac, (p) => p === userCodeCli), [userCodeCli, "-g", "/p/a.ts:12:3"], "a per-user install")
  assert.deepEqual(argv("vscode", "darwin", "/p/a.ts", at, mac, (p) => p === codeCli || p === userCodeCli), [codeCli, "-g", "/p/a.ts:12:3"], "/Applications first")
  assert.deepEqual(argv("cursor", "darwin", "/p/a.ts", { line: 7 }, mac, (p) => p === cursorCli), [cursorCli, "-g", "/p/a.ts:7"])
  assert.deepEqual(argv("cursor", "darwin", "/p/a.ts", { line: 7 }, mac, (p) => p === userCursorCli), [userCursorCli, "-g", "/p/a.ts:7"])
  assert.deepEqual(argv("cursor", "darwin", "/p/a.ts", { line: 7 }, mac, (p) => p === codeCli), ["open", "-a", "Cursor", "/p/a.ts"], "VS Code's CLI is not Cursor's")
  // No CLI where it should be (a renamed bundle, an install elsewhere): the file still opens, without the
  // line — never a URL that stops for a confirmation dialog.
  assert.deepEqual(argv("vscode", "darwin", "/p/a.ts", at, mac), ["open", "-a", "Visual Studio Code", "/p/a.ts"])
  assert.deepEqual(argv("cursor", "darwin", "/p/a.ts", at, mac), ["open", "-a", "Cursor", "/p/a.ts"])
  assert.deepEqual(argv("vscode", "darwin", "/p/a.ts", at, {}, (p) => p === userCodeCli), ["open", "-a", "Visual Studio Code", "/p/a.ts"], "no HOME, no ~/Applications to look in")
  // No position: `open -a`, as it always was, whatever is installed.
  assert.deepEqual(argv("vscode", "darwin", "/p/a.ts", undefined, mac, (p) => p === codeCli), ["open", "-a", "Visual Studio Code", "/p/a.ts"])
  assert.deepEqual(argv("finder", "darwin", "/p/a.ts", at), ["open", "-R", "/p/a.ts"])
  // Windows: the installed exe takes -g directly; the shim takes it inside the one quoted cmd.exe argument.
  const win = "C:\\p\\a.ts"
  const env = { LOCALAPPDATA: "C:\\L" }
  const codeExe = join("C:\\L", "Programs", "Microsoft VS Code", "Code.exe")
  assert.deepEqual(argv("vscode", "win32", win, at, env, (p) => p === codeExe), [codeExe, "-g", `${win}:12:3`])
  assert.deepEqual(argv("cursor", "win32", win, at, env), ["cmd.exe", "/d", "/s", "/c", `"cursor -g "${win}:12:3""`])
  assert.deepEqual(argv("cursor", "win32", win, undefined, env), ["cmd.exe", "/d", "/s", "/c", `"cursor "${win}""`])
  assert.deepEqual(argv("system", "win32", win, at, env), ["explorer.exe", win])
})

test("$EDITOR is told the position in its own dialect, and an editor with none gets the bare path", () => {
  const at = { line: 12, column: 3 }
  const argv = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform = "linux") => {
    const spec = localFileOpenCommand("/p/a.ts", "editor", { env, platform, position: at })
    return [spec.command, ...spec.args]
  }
  for (const name of ["code", "code-insiders", "cursor", "codium", "windsurf", "/usr/local/bin/code"]) {
    assert.deepEqual(argv({ EDITOR: `${name} --wait` }), [name, "--wait", "-g", "/p/a.ts:12:3"], name)
  }
  for (const name of ["subl", "sublime_text", "zed"]) assert.deepEqual(argv({ EDITOR: name }), [name, "/p/a.ts:12:3"], name)
  // Guessing a flag for an editor that takes none would open a file called `-g`.
  assert.deepEqual(argv({ EDITOR: "emacs" }), ["emacs", "/p/a.ts"])
  assert.deepEqual(argv({ EDITOR: "C:\\VS\\Code.exe" }, "win32"), ["C:\\VS\\Code.exe", "-g", "/p/a.ts:12:3"])
  assert.deepEqual(argv({ EDITOR: "code" }, "win32"), ["cmd.exe", "/d", "/s", "/c", `""code" "-g" "/p/a.ts:12:3""`])
})

test("the editor families the bridge may route to are the ones the Local file links app would have spawned", () => {
  assert.deepEqual(editorKindsForOpener("vscode", {}), ["vscode"])
  assert.deepEqual(editorKindsForOpener("cursor", { EDITOR: "windsurf" }), ["cursor"], "the setting outranks $EDITOR")
  for (const opener of ["system", "finder", "copy"] as const) assert.deepEqual(editorKindsForOpener(opener, { EDITOR: "code" }), [], opener)
  const viaEnv = (env: NodeJS.ProcessEnv) => editorKindsForOpener("editor", env)
  assert.deepEqual(viaEnv({ EDITOR: "code -w" }), ["vscode"])
  assert.deepEqual(viaEnv({ EDITOR: "/opt/bin/code-insiders" }), ["vscode"])
  assert.deepEqual(viaEnv({ VISUAL: "nvim", EDITOR: "cursor" }), ["cursor"], "a terminal $VISUAL falls through, as the spawn does")
  assert.deepEqual(viaEnv({ EDITOR: "windsurf" }), ["windsurf"])
  assert.deepEqual(viaEnv({ EDITOR: "C:\\Programs\\Cursor.exe" }), ["cursor"])
  assert.deepEqual(viaEnv({ EDITOR: "subl" }), [], "an editor no extension runs in")
  assert.deepEqual(viaEnv({}), [])
})

test("a path with a trailing position that does not exist as written opens the bare file AT that position", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-local-file-position-")))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, "a.ts")
  writeFileSync(file, "x")
  // `[x](vscode://file/…/a.ts:12)` reached the reader as `/…/a.ts:12` and read "not found" (2026-10-01).
  assert.equal(resolveLocalFile(`${file}:12`, [root]), file)
  assert.deepEqual(resolveLocalFileAt(`${file}:12:3`, [root]), { path: file, position: { line: 12, column: 3 } })
  assert.deepEqual(resolveLocalFileAt(`${file}#L4-L9`, [root]), { path: file, position: { line: 4, endLine: 9 } })
  assert.deepEqual(resolveLocalFileAt(file, [root]), { path: file })
  // The whole string first: a file genuinely named `notes:12` is that file, not `notes` at line 12.
  const named = join(root, "notes:12")
  writeFileSync(named, "y")
  writeFileSync(join(root, "notes"), "z")
  assert.deepEqual(resolveLocalFileAt(named, [root]), { path: named })
  assert.throws(() => resolveLocalFileAt(join(root, "gone.ts:12"), [root]), /not found/)
  // The split path passes the same gate as any other.
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-local-file-position-out-")))
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  writeFileSync(join(outside, "b.ts"), "x")
  assert.throws(() => resolveLocalFileAt(join(outside, "b.ts:3"), [root]), /trusted roots/)

  const calls: SpawnCall[] = []
  const linux = { platform: "linux" as const, spawn: fakeSpawn(calls) }
  assert.deepEqual(await openLocalFile(`${file}:12`, "vscode", [root], linux), { action: "opened", path: file })
  await openLocalFile(`${file}:12`, "vscode", [root], { ...linux, position: { line: 40 } })
  assert.deepEqual(calls.map((c) => c.args), [["-g", `${file}:12`], ["-g", `${file}:40`]], "an explicit position wins over the path's own")
})

// A link an agent wrote in its worktree names the worktree's copy; the worktree goes once merged. The same
// relative path in the main checkout is the file it meant (router.ts settleWorktreePath).
test("mainCheckoutCopy: a file in one of the project's worktrees is the same path in the main checkout", () => {
  const root = "/repo"
  const trees = "/repo/.ntwine/worktrees"
  assert.equal(mainCheckoutCopy("/repo/.ntwine/worktrees/tidy/src/a.ts", root, trees), "/repo/src/a.ts")
  assert.equal(mainCheckoutCopy("/repo/.ntwine/worktrees/tidy/.ntwine/threads/x/notes.md", root, trees), "/repo/.ntwine/threads/x/notes.md")
  assert.equal(mainCheckoutCopy("/repo/.ntwine/worktrees/tidy/src/a.ts:12", root, trees), "/repo/src/a.ts:12", "a trailing position rides along")
  // The worktree folder, a worktree itself, and anything outside the worktree folder: nothing.
  assert.equal(mainCheckoutCopy("/repo/.ntwine/worktrees", root, trees), undefined)
  assert.equal(mainCheckoutCopy("/repo/.ntwine/worktrees/tidy", root, trees), undefined)
  assert.equal(mainCheckoutCopy("/repo/src/a.ts", root, trees), undefined)
  assert.equal(mainCheckoutCopy("/elsewhere/.ntwine/worktrees/tidy/a.ts", root, trees), undefined)
  assert.equal(mainCheckoutCopy("/repo/.ntwine/worktrees-old/tidy/a.ts", root, trees), undefined)
  // The caller names the worktree folder, which need not be inside the project.
  assert.equal(mainCheckoutCopy("/trees/tidy/src/a.ts", root, "/trees"), "/repo/src/a.ts")
})

test("resolveOpenableFile lets the caller settle an absolute path before the gate", () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-openable-settle-")))
  writeFileSync(join(project, "a.ts"), "x")
  const gone = join(project, ".ntwine", "worktrees", "tidy", "a.ts")
  assert.equal(resolveOpenableFile(gone, project, [project]), null, "negative control: the worktree's file is gone")
  assert.equal(resolveOpenableFile(gone, project, [project], undefined, (abs) => mainCheckoutCopy(abs, project, join(project, ".ntwine", "worktrees")) ?? abs), join(project, "a.ts"))
  // The settled path still faces the gate.
  assert.equal(resolveOpenableFile(gone, project, [join(project, "nope")], undefined, () => join(project, "a.ts")), null)
})
