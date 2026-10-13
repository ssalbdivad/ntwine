import { test } from "node:test"
import assert from "node:assert/strict"
import {
  bundleNameMatchesManifest,
  defaultBrowserOpenCommand,
  launchBrowserTab,
  runUrlHandler,
} from "./browser.ts"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("default browser launch uses each platform's shell-free URL handler", () => {
  const url = "http://127.0.0.1:4917"
  assert.deepEqual(defaultBrowserOpenCommand(url, "darwin"), {
    command: "/usr/bin/open",
    args: ["http://127.0.0.1:4917/"],
  })
  assert.deepEqual(defaultBrowserOpenCommand(url, "linux"), {
    command: "xdg-open",
    args: ["http://127.0.0.1:4917/"],
  })
  assert.deepEqual(defaultBrowserOpenCommand(url, "win32"), {
    command: "rundll32.exe",
    args: ["url.dll,FileProtocolHandler", "http://127.0.0.1:4917/"],
  })
})

test("default browser launch accepts only absolute http(s) URLs", () => {
  assert.deepEqual(defaultBrowserOpenCommand("https://example.com/path?a=1", "darwin"), {
    command: "/usr/bin/open",
    args: ["https://example.com/path?a=1"],
  })
  assert.throws(() => defaultBrowserOpenCommand("not a URL", "darwin"), /invalid browser URL/)
  assert.throws(() => defaultBrowserOpenCommand("file:///tmp/ntwine", "darwin"), /unsupported browser URL scheme/)
  assert.throws(() => defaultBrowserOpenCommand("https://example.com", "aix"), /not supported/)
})

test("macOS makes exactly one awaited standard default-browser request", async () => {
  const calls: Array<{ command: string; args: string[] }> = []
  let accepted = false
  await launchBrowserTab("http://127.0.0.1:4917", {
    platform: "darwin",
    runCommand: async (command, args) => {
      calls.push({ command, args })
      accepted = true
      return ""
    },
  })

  assert.equal(accepted, true)
  assert.deepEqual(calls, [{
    command: "/usr/bin/open",
    args: ["http://127.0.0.1:4917/"],
  }])
})

test("browser launch reports OS-handler rejection", async () => {
  await assert.rejects(
    launchBrowserTab("http://127.0.0.1:4917", {
      platform: "darwin",
      runCommand: async () => { throw new Error("open failed") },
    }),
    /open failed/,
  )
})

test("non-macOS launch waits for the platform URL handler before reporting success", async () => {
  let completed = false
  await launchBrowserTab("http://127.0.0.1:4917", {
    platform: "linux",
    runCommand: async (command, args) => {
      assert.equal(command, "xdg-open")
      assert.deepEqual(args, ["http://127.0.0.1:4917/"])
      completed = true
      return ""
    },
  })
  assert.equal(completed, true)
})

test("a Chrome-disambiguated shim bundle is the same app, not a stale one", () => {
  // Chrome appends " 1", " 2", … when the bundle filename already exists, and that is the COMMON
  // case: manifestIdFor is origin-scoped, so every project's port installs its own bundle. Rejecting
  // the suffix made every project after the first reinstall its shim on each --app launch, which is
  // how a real machine ended up with Ntwine.app, Ntwine 1.app, Ntwine 2.app and Ntwine 3.app.
  assert.equal(bundleNameMatchesManifest("Ntwine"), true)
  assert.equal(bundleNameMatchesManifest("Ntwine 1"), true)
  assert.equal(bundleNameMatchesManifest("Ntwine 42"), true)

  // A genuine rename must still read as stale so the bundle gets reinstalled under the new name.
  assert.equal(bundleNameMatchesManifest("Ntwineed"), false)
  assert.equal(bundleNameMatchesManifest("Ntwine Board"), false)
  assert.equal(bundleNameMatchesManifest("Ntwine "), false)
  assert.equal(bundleNameMatchesManifest("Ntwine 1x"), false)
  assert.equal(bundleNameMatchesManifest(""), false)
})

// ── The real URL-handler runner, against real processes ────────────────────────────────────────────
// These spawn shell scripts standing in for xdg-open, because the bug lived in how the runner treats a
// live child — a stub runner cannot show it. Linux/macOS only: the stand-ins are POSIX sh.

function fakeOpener(body: string): { path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-url-handler-"))
  const path = join(dir, "xdg-open")
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return { path, dir }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test("a handler that runs the browser in the FOREGROUND is accepted promptly and left running", { skip: process.platform === "win32" }, async () => {
  // xdg-open starting snap Firefox does not return until Firefox quits. The old runner waited 10s,
  // SIGTERMed it and reported failure while the browser was already open.
  const { path, dir } = fakeOpener(`echo $$ > "${"$"}(dirname "$0")/pid"\necho "snapd: cannot change mount namespace" >&2\nexec sleep 30`)
  let pid = 0
  try {
    const started = performance.now()
    await runUrlHandler(path, ["http://127.0.0.1:4917/"], { acceptAfterMs: 300 })
    const elapsed = performance.now() - started
    assert.ok(elapsed < 3_000, `accepted after ${Math.round(elapsed)}ms — it must not wait for the browser to exit`)
    // The stand-in writes its pid as its first act, but on a loaded box that can land after 300ms.
    for (let waited = 0; !pid && waited < 10_000; waited += 50) {
      try {
        pid = Number(readFileSync(join(dir, "pid"), "utf8"))
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
    assert.equal(alive(pid), true, "the runner must never kill the browser it asked to open")
  } finally {
    if (pid && alive(pid)) process.kill(pid, "SIGKILL")
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a handler that exits 0 resolves at once, without waiting out the acceptance window", { skip: process.platform === "win32" }, async () => {
  const { path, dir } = fakeOpener("exit 0")
  try {
    const started = performance.now()
    await runUrlHandler(path, ["http://127.0.0.1:4917/"], { acceptAfterMs: 20_000 })
    assert.ok(performance.now() - started < 10_000)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a handler that refuses (nonzero exit) is a failure, named without the opener's stderr", { skip: process.platform === "win32" }, async () => {
  const { path, dir } = fakeOpener("echo 'xdg-open: no method available' >&2\nexit 3")
  try {
    await assert.rejects(runUrlHandler(path, ["http://127.0.0.1:4917/"], { acceptAfterMs: 20_000 }), (error: Error) => {
      assert.match(error.message, /exited with code 3$/)
      assert.doesNotMatch(error.message, /no method available/)
      return true
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a missing handler binary is a failure, not a hang", async () => {
  await assert.rejects(
    runUrlHandler(join(tmpdir(), "ntwine-no-such-opener-binary"), ["http://127.0.0.1:4917/"], { acceptAfterMs: 20_000 }),
    /ENOENT/,
  )
})
