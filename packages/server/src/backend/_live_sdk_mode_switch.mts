// LIVE spike: WHAT A MID-SESSION PERMISSION-MODE SWITCH CAN AND CANNOT DO against real `claude`.
//   nub packages/server/src/backend/_live_sdk_mode_switch.mts
//
// This exists because the obvious implementation of a per-thread Auto/Bypass control is a live
// `setPermissionMode` on the running session, and that implementation is a LIE. The SDK query is started
// with `allowDangerouslySkipPermissions` only when the LAUNCH mode was bypass (claude-agent-sdk.ts), and
// the CLI enforces it:
//
//   "Cannot set permission mode to bypassPermissions because the session was not launched with
//    --dangerously-skip-permissions"
//
// So ntwine applies a Claude permission change by RETIRING THE WORKER PROCESS instead — the mode is a
// launch flag, and the next turn cold-resumes the same conversation under the new one (router
// `setThreadPermission` → bridge `retireDaemon`). This probe is the evidence for that design, and the
// regression guard on it: if a future `claude` starts ACCEPTING the flip, check 1 fails loudly and the
// restart can be reconsidered.
//
// `_live_sdk_session.mts` also calls setPermissionMode, but only asserts that the control frame
// RESOLVES — it moves to `acceptEdits`, which is always allowed. That is why this was missed.
//
//   1. auto ⇒ bypass is REFUSED                          (the finding)
//   2. …and the session SURVIVES the refusal              (so sending the frame is safe, just useless)
//   3. a session LAUNCHED under bypass accepts both ways  (the flag, not the mode, is what is fixed)
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { createClaudeQueryFactory } from "./claude-agent-sdk.ts"
import type { ClaudePermissionMode, ClaudePermissionRequest, ClaudeQueryEvent } from "./claude-agent-sdk-protocol.ts"

const claudeBin = execFileSync("which", ["claude"], { encoding: "utf8" }).trim()
let failures = 0
const ok = (label: string, cond: boolean, detail = "") => { if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`) }

const ALLOWLIST = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]
const env = Object.fromEntries(ALLOWLIST.filter((k) => process.env[k] != null).map((k) => [k, process.env[k]!])) as Record<string, string>

function makeSession(mode: ClaudePermissionMode) {
  const cwd = mkdtempSync(join(tmpdir(), "ntwine-mode-switch-"))
  execFileSync("git", ["init", "-q", cwd])
  const asks: ClaudePermissionRequest[] = []
  const collected: ClaudeQueryEvent[] = []
  let resolveTurn: () => void = () => {}
  const handle = createClaudeQueryFactory({ enabled: true, executablePath: claudeBin }).start({
    cwd,
    session: { kind: "new", sessionId: randomUUID() },
    permissionMode: mode,
    env,
    canUseTool: async (req) => { asks.push(req); return { behavior: "allow" } },
  })
  void (async () => { for await (const ev of handle) { collected.push(ev); if (ev.kind === "result") resolveTurn() } })().catch(() => {})
  const turn = async (text: string, ms = 150_000): Promise<void> => {
    const done = new Promise<void>((r) => { resolveTurn = r })
    await handle.send({ id: randomUUID(), text })
    let timer: NodeJS.Timeout
    await Promise.race([done, new Promise<void>((_, rej) => { timer = setTimeout(() => rej(new Error("turn timeout")), ms) })]).finally(() => clearTimeout(timer!))
  }
  const said = (word: string) => collected.some((e) => e.kind === "assistant" && e.text.join(" ").includes(word))
  return { cwd, asks, handle, turn, said }
}

try {
  // ---- 1 + 2: the refusal, and the survival.
  console.log("\n== a session launched under `auto` ==")
  const a = makeSession("auto")
  await a.turn("Reply with only READY.")
  let refusal: string | undefined
  await a.handle.setPermissionMode("bypassPermissions").catch((e: unknown) => { refusal = e instanceof Error ? e.message : String(e) })
  ok("auto ⇒ bypass is REFUSED", refusal !== undefined, refusal ?? "it was ACCEPTED — re-examine whether the worker still needs a restart")
  ok("the refusal names the launch flag", /dangerously-skip-permissions/.test(refusal ?? ""), refusal ?? "")
  // The refusal arrives as a "Claude SDK process failed" REJECTION, which reads like a death. It is not
  // one, and that matters: it is why ntwine can leave the retired-daemon path as the only mechanism
  // without also having to guarantee the frame is never sent.
  await a.turn("Reply with only ALIVE.", 60_000).catch(() => {})
  ok("the session SURVIVED the refusal", a.said("ALIVE"))
  await a.handle.close().catch(() => {})
  rmSync(a.cwd, { recursive: true, force: true })

  // ---- 3: the flag is what is fixed at launch, not the mode. A bypass-LAUNCHED session moves freely.
  console.log("\n== a session launched under `bypassPermissions` ==")
  const b = makeSession("bypassPermissions")
  await b.turn("Reply with only READY.")
  let toAuto: string | undefined
  await b.handle.setPermissionMode("auto").catch((e: unknown) => { toAuto = e instanceof Error ? e.message : String(e) })
  ok("bypass ⇒ auto is ACCEPTED", toAuto === undefined, toAuto ?? "")
  let back: string | undefined
  await b.handle.setPermissionMode("bypassPermissions").catch((e: unknown) => { back = e instanceof Error ? e.message : String(e) })
  ok("auto ⇒ bypass is ACCEPTED again once the session was LAUNCHED with the flag", back === undefined, back ?? "")
  await b.handle.close().catch(() => {})
  rmSync(b.cwd, { recursive: true, force: true })
} catch (err) {
  failures++
  console.log(`\nSPIKE ERROR: ${err instanceof Error ? err.message : String(err)}`)
} finally {
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}
