import { test } from "node:test"
import assert from "node:assert/strict"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { queryCodexRateLimits } from "./codex-quota.ts"

// A write into a child that has stopped reading fails on the STREAM, a tick after the call returned —
// so the `try` around the write never sees it, and an 'error' event nobody listens for is an uncaught
// exception, which exits the server. It took a disposable stack down on 2026-10-11:
//   [adhoc-stack] uncaught Error: write EPIPE … at send (codex-quota.ts)
// The stand-in answers the handshake with its stdin already closed, so the two requests that follow
// the reply are written to a pipe with no reader.
test("codex: a quota read whose app-server has stopped reading resolves, and throws nothing past itself", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "frizz-codex-quota-pipe-"))
  const bin = join(dir, "codex-stand-in")
  const uncaught: unknown[] = []
  const onUncaught = (error: unknown) => { uncaught.push(error) }
  process.on("uncaughtException", onUncaught)
  try {
    await writeFile(bin, `#!/bin/sh
exec 0<&-
printf '%s\\n' '{"id":1,"result":{}}'
sleep 1
`)
    await chmod(bin, 0o755)
    assert.equal(await queryCodexRateLimits(dir, bin, 5_000), undefined)
    // The stream reports its failed write on a later tick than the one that resolved the read.
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.deepEqual(uncaught, [])
  } finally {
    process.off("uncaughtException", onUncaught)
    await rm(dir, { recursive: true, force: true })
  }
})
