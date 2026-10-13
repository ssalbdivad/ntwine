import assert from "node:assert/strict"
import { test } from "node:test"
import {
  type NativePanel,
  type PanelKind,
  openPanel,
  pickDirectory,
  pickImageFile,
  pickWindowsFolder,
  warmDirectoryPicker,
  warmImagePicker,
} from "./directory-picker.ts"

// The picker opens a real modal window, so the darwin/linux/win32 branches are exercised by hand
// rather than here — popping a dialog on the operator's desktop is not something a test suite may do.
// What IS testable is that an unsupported platform degrades to the typed-path fallback instead of
// throwing, which is the difference between "no picker here" and a broken Add button.
test("a platform with no folder picker reports it rather than throwing", async () => {
  for (const platform of ["freebsd", "aix", "sunos"] as const) {
    const result = await pickDirectory("Choose", platform)
    assert.equal(result.kind, "unavailable")
    assert.match(result.kind === "unavailable" ? result.reason : "", new RegExp(platform))
  }
})

// Windows tries `pwsh` (the modern dialog) and then `powershell` (the old tree), ENOENT deciding. Two
// editions nobody has installed stand in for a machine with neither, and the answer must be the
// typed-path fallback, not a rejection — the same contract as an unsupported platform.
test("windows walks its edition chain and degrades when none is installed", async () => {
  const result = await pickWindowsFolder("Choose", ["ntwine-no-such-shell-a", "ntwine-no-such-shell-b"])
  assert.equal(result.kind, "unavailable")
  assert.match(result.kind === "unavailable" ? result.reason : "", /no PowerShell/u)
})

// An edition that starts but rejects the script (a pwsh without WinForms, say) exits non-zero, and that
// is "the next edition" too — but when it was the LAST edition, its message is what the operator sees,
// not "no PowerShell found". `node` stands in: it starts everywhere and refuses `-NoProfile`.
test("windows reports the last edition's own failure when none ran the script", async () => {
  const result = await pickWindowsFolder("Choose", ["ntwine-no-such-shell", process.execPath])
  assert.equal(result.kind, "unavailable")
  const reason = result.kind === "unavailable" ? result.reason : ""
  assert.doesNotMatch(reason, /no PowerShell/u)
  assert.doesNotMatch(reason, /\u001b/u)
  assert.notEqual(reason, "")
})

// THE MACOS PANELS' PROTOCOL, driven by a stand-in for the JXA helper: it reads the one `{"prompt":…}`
// line, and answers the way the panel would — a picked path, or a cancel when the prompt says so. The
// real helper is a window on the operator's desktop, so it is exercised by hand. The stand-in answers
// with a trailing slash, as AppleScript's `POSIX path of` did for a folder, so the strip stays pinned.
const STAND_IN = `
let text = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  text += chunk
  if (!text.includes("\\n")) return
  const { prompt } = JSON.parse(text.slice(0, text.indexOf("\\n")))
  process.stdout.write("2026-10-03 osascript[1] a stray log line\\n")
  process.stdout.write(JSON.stringify(prompt === "cancel" ? { cancelled: true } : { path: "/picked/" + prompt + "/" }) + "\\n")
  process.exit(0)
})
process.stdin.on("end", () => process.exit(0))
`

function countingOpen(kind: PanelKind = "folder") {
  const open = () => {
    open.count++
    const panel = openPanel(kind, [process.execPath, "-e", STAND_IN])
    open.panels.push(panel)
    return panel
  }
  open.count = 0
  open.panels = [] as NativePanel[]
  return open
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

// The whole fix: the panel built when the pointer reached the button is the one the click shows, so
// the click does not pay the build. A second warm-up keeps that panel rather than building another.
test("a panel built ahead of the click is the one the click shows", async () => {
  const open = countingOpen()
  assert.equal(warmDirectoryPicker("darwin", open), true)
  assert.equal(warmDirectoryPicker("darwin", open), true)
  assert.equal(open.count, 1)
  assert.deepEqual(await pickDirectory("alpha", "darwin", open), { kind: "picked", path: "/picked/alpha" })
  assert.equal(open.count, 1)
  // That panel was used up, so a click nothing warned of builds its own.
  assert.deepEqual(await pickDirectory("cancel", "darwin", open), { kind: "cancelled" })
  assert.equal(open.count, 2)
})

test("only macOS builds a panel ahead", () => {
  const open = countingOpen()
  for (const platform of ["linux", "win32", "freebsd"] as const) {
    assert.equal(warmDirectoryPicker(platform, open), false)
    assert.equal(warmImagePicker("/projects/a", platform, open), false)
  }
  assert.equal(open.count, 0)
})

// The icon menu's panel opens in its project's directory, so one built for another project is not the
// one this click shows — and it is killed, not left waiting beside the panel the click builds. The
// folder panel waiting for "Add a project" is a different picker, and neither takes the other's.
test("an image panel is shown only by a click for the directory it was built in", async () => {
  const images = countingOpen("image")
  const folders = countingOpen("folder")
  warmDirectoryPicker("darwin", folders)
  assert.equal(warmImagePicker("/projects/a", "darwin", images), true)
  assert.equal(warmImagePicker("/projects/a", "darwin", images), true)
  assert.equal(images.count, 1)
  assert.deepEqual(await pickImageFile("/projects/a", "logo", "darwin", images), { kind: "picked", path: "/picked/logo" })
  assert.equal(images.count, 1)
  warmImagePicker("/projects/a", "darwin", images)
  assert.deepEqual(await pickImageFile("/projects/b", "cancel", "darwin", images), { kind: "cancelled" })
  assert.equal(images.count, 3)
  await until(() => images.panels[1]!.exited)
  assert.deepEqual(await pickDirectory("alpha", "darwin", folders), { kind: "picked", path: "/picked/alpha" })
  assert.equal(folders.count, 1)
})

// A helper that dies without answering — no window server, a broken JXA bridge — is "no picker here",
// and the operator reads the helper's own first line rather than a generic failure.
test("a panel that exits without answering is unavailable, with its own reason", async () => {
  const dies = () => openPanel("folder", [process.execPath, "-e", 'process.stderr.write("execution error: no window server (-1)\\nmore\\n"); process.exit(1)'])
  assert.deepEqual(await pickDirectory("Choose", "darwin", dies), {
    kind: "unavailable",
    reason: "execution error: no window server (-1)",
  })
})
