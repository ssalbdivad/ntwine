// These pin the packaging invariant that a detached daemon must be a REAL FILE at runtime. The
// end-to-end proof — that a promoted artifact actually ships each daemon and that node can load it
// from there — lives in src/artifacts.test.ts, because only a real build can show it.
import assert from "node:assert/strict"
import { test } from "node:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import {
  DETACHED_DAEMON_ENTRIES,
  detachedDaemonOutputName,
  resolveDetachedDaemonEntry,
} from "./detached-daemons.ts"

const workspaceRoot = resolve(import.meta.dirname, "..", "..", "..")

test("every declared detached daemon entry exists in the source tree", () => {
  for (const entry of DETACHED_DAEMON_ENTRIES) {
    assert.ok(existsSync(join(workspaceRoot, entry)), `${entry} is missing — the build would emit nothing for it`)
  }
})

test("detached daemon output names strip the .ts and drop the directory", () => {
  assert.equal(detachedDaemonOutputName("packages/server/src/backend/codex-app-server-daemon.ts"), "codex-app-server-daemon.js")
  assert.equal(detachedDaemonOutputName("packages/server/src/dev-bootstrap.ts"), "dev-bootstrap.js")
})

test("the entry resolver prefers the bundled .js, falls back to source .ts, and names both when neither is there", () => {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-daemon-entry-"))
  const callerUrl = pathToFileURL(join(dir, "index.js")).href

  // A promoted artifact: one bundle plus the daemons emitted beside it.
  assert.throws(
    () => resolveDetachedDaemonEntry(callerUrl, "codex-app-server-daemon"),
    /missing the codex-app-server-daemon entry — looked for .*codex-app-server-daemon\.js and .*codex-app-server-daemon\.ts/,
    "a missing daemon reads as a packaging bug, not a mystery",
  )

  writeFileSync(join(dir, "codex-app-server-daemon.ts"), "")
  assert.equal(resolveDetachedDaemonEntry(callerUrl, "codex-app-server-daemon"), join(dir, "codex-app-server-daemon.ts"))

  writeFileSync(join(dir, "codex-app-server-daemon.js"), "")
  assert.equal(resolveDetachedDaemonEntry(callerUrl, "codex-app-server-daemon"), join(dir, "codex-app-server-daemon.js"))
})

// The ORIGINAL mistake, made unrepeatable. `new URL("./x.ts", import.meta.url)` is how a module names
// a sibling SOURCE file at runtime — correct in a checkout, a dangling path in the single-bundle
// artifact that ships to users, and silent until a spawned process dies with MODULE_NOT_FOUND.
// codex-app-server-host.ts did exactly this and took every Codex turn down (2026-07-23).
//
// Anything that must exist as a real file at runtime belongs in DETACHED_DAEMON_ENTRIES, which the
// artifact build emits and then asserts. So the pattern itself is banned in shipped server/CLI code:
// reintroducing it fails here, naming the file, instead of on a user's machine a build later.
test("no shipped module resolves a sibling .ts at runtime — that path does not exist in an artifact", () => {
  const roots = [join(workspaceRoot, "packages", "server", "src"), join(workspaceRoot, "src")]
  // The ONE exemption, and it is a knowing one. dev-supervisor.ts forks dev-bootstrap.ts, but the dev
  // supervisor is the SOURCE launcher — `ntwine-dev` runs from a checkout where that file exists.
  // Emitting it into artifacts to close the gap was tried and REVERTED: it woke a control-plane fork
  // that had been failing fast in every artifact ever built, and the woken path crashed on an
  // unguarded IPC send and left delegates registered against the developer's live project, wedging
  // two repos (2026-07-23). Until that path is safe to run from an artifact, failing fast is the
  // better bug. Anything else that reaches for this pattern still fails below.
  const EXEMPT = new Set(["packages/server/src/dev-supervisor.ts"])
  // Both the exemption and the failure message are spelled with `/`, on every platform: `path.slice()`
  // yields `packages\\server\\src\\dev-supervisor.ts` on win32, which no POSIX-spelled EXEMPT entry can
  // match — the exemption silently lapsed there and the one knowing offender failed the suite.
  const relative = (path: string) => path.slice(workspaceRoot.length + 1).replaceAll("\\", "/")
  const offenders: string[] = []
  const sibling = /new URL\(\s*["'`]\.\/[^"'`]*\.ts["'`]\s*,\s*import\.meta\.url/

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) { walk(path); continue }
      // Test files never ship, and the fixtures deliberately contain odd source.
      if (!entry.name.endsWith(".ts") || entry.name.includes(".test.")) continue
      if (EXEMPT.has(relative(path))) continue
      readFileSync(path, "utf8").split("\n").forEach((line, index) => {
        // Prose is exempt: the ban is on CODE, and detached-daemons.ts documents the very pattern
        // it bans. A line-comment check is enough — nobody hides a spawn inside a block comment.
        const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "")
        if (sibling.test(code)) offenders.push(`${relative(path)}:${index + 1}`)
      })
    }
  }
  for (const root of roots) walk(root)

  assert.deepEqual(
    offenders,
    [],
    "these resolve a sibling .ts at runtime, which does not exist in a promoted artifact — declare the " +
      `file in DETACHED_DAEMON_ENTRIES and resolve it with resolveDetachedDaemonEntry():\n  ${offenders.join("\n  ")}`,
  )
})
