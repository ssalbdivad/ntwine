// End-to-end proof that a codex thread whose app-server died mid-turn is ANSWERABLE again — driven
// through the REAL CodexAppServerBridge against the REAL `codex app-server` binary, not the in-repo
// fake. This is the second half of the 2026-07-22 stall: the board showing the thread as forever
// "running" was one bug; the thread refusing every follow-up afterwards was the other.
//
//   nub scripts/verify-codex-stall-recovery.mjs
//
// Needs a signed-in `codex` (0.144.x) on PATH. Spends a small amount of real model usage.
import { spawn } from "node:child_process"
import { mkdtempSync, statSync, readdirSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"
import { createRequire } from "node:module"
import { createInteractionStore } from "../packages/server/src/interaction-store.ts"
import { CodexAppServerBridge } from "../packages/server/src/backend/codex-app-server.ts"

// better-sqlite3 lives under the server package in pnpm's layout, not beside this script.
const Database = createRequire(new URL("../packages/server/package.json", import.meta.url))("better-sqlite3")

const dir = mkdtempSync(join(tmpdir(), "ntwine-codex-stall-recovery-"))
const dbPath = join(dir, "ui.db")
const db = new Database(dbPath)
db.pragma("journal_mode = WAL")
const interactions = createInteractionStore(db, { now: () => new Date(), id: () => `i-${Math.random().toString(16).slice(2)}` })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (ok, label, detail = "") => {
  if (!ok) failures++
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`)
}

// Every app-server this harness starts, captured through the bridge's own spawn seam so teardown can
// kill EXACTLY the children it owns. Never `pkill -f 'codex app-server'` — that would take out the
// maintainer's live board and every other agent's worker along with it.
const owned = []
const newBridge = () => new CodexAppServerBridge({
  projectId: "stall-recovery",
  projectDir: dir,
  dbPath,
  interactions,
  codexBin: process.env.CODEX_BIN ?? "codex",
  spawn: (binary, args, options) => {
    const child = spawn(binary, [...args], { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] })
    owned.push(child)
    return child
  },
})
const killOwned = () => {
  for (const child of owned) {
    try { if (child.pid && child.exitCode === null) process.kill(child.pid, "SIGKILL") } catch {}
  }
}

function rolloutPath(codexSessionId) {
  const root = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions")
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name)
      if (entry.isDirectory()) { const hit = walk(full); if (hit) return hit }
      else if (entry.name.includes(codexSessionId)) return full
    }
    return null
  }
  return walk(root)
}
const sizeOf = (p) => { try { return statSync(p).size } catch { return -1 } }

const slug = "stall-recovery-thread"
const sessionId = "ntwine-stall-recovery-session"
let first = newBridge()
let second
try {
  const binding = await first.spawnDispatch({
    threadSlug: slug,
    sessionId,
    cwd: dir,
    prompt: "Count from 1 to 200. Write each number on its own line with a short remark. Do not use any tools.",
    sandbox: "read-only",
  })
  // Let the turn stream before measuring — the rollout file appears a beat after thread/start.
  await sleep(12_000)
  const path = rolloutPath(binding.binding.codexSessionId)
  check(Boolean(path), "rollout located", path ?? "not found")
  const frozenAt = sizeOf(path)
  check(frozenAt > 0, "the dispatched turn is genuinely streaming", `${frozenAt}B`)
  check(
    first.turnLiveness(slug, sessionId)?.bridgeTurn === true,
    "turnLiveness reports a LIVE turn while the bridge is driving it",
  )

  // Kill the app-server mid-turn, exactly as happened live — no turn/completed is ever delivered.
  // SIGKILLing the child directly (not bridge.close()) models the crash rather than a clean shutdown,
  // so the registry is left claiming `active` exactly as it was found on the live board.
  killOwned()
  await sleep(2_000)
  const afterKill = sizeOf(path)

  // A NEW ntwine process picks the registry up. Its bridge inherits whatever the killed one left behind.
  second = newBridge()
  // (The still-live first bridge saw the child die and detached the row itself. The harder case — ntwine
  // ITSELF SIGKILLed, so no handler ever ran — is covered by the bridge's own boot-detach unit test.)
  const inherited = second.binding(slug, sessionId)
  check(inherited?.state === "detached", "the dead connection's binding is no longer active", String(inherited?.state))
  check(
    second.turnLiveness(slug, sessionId)?.bridgeTurn === false,
    "and reports NO live turn — which is what stops the board reading it as running forever",
  )

  // THE WEDGE: before the fix this steered a turn the new process had never heard of, then refused
  // with "Codex app-server session already has an active turn". It must now open a fresh turn.
  await second.resumeOwnedSession(slug, sessionId)
  check(second.binding(slug, sessionId)?.currentTurnId === null, "the rebind retired the dead turn")
  const delivered = await second.followUp({ threadSlug: slug, sessionId, text: "Stop counting. Reply with exactly: recovered" })
  check(delivered.mode === "start", "the follow-up opens a FRESH turn instead of steering a phantom one", delivered.mode)

  await sleep(12_000)
  const afterRecovery = sizeOf(path)
  console.log(`rollout: ${frozenAt}B streaming → ${afterKill}B frozen by the kill → ${afterRecovery}B after the follow-up`)
  check(afterRecovery > afterKill, "the thread is genuinely alive again — the rollout grew", `+${afterRecovery - afterKill}B`)
} finally {
  try { second?.close() } catch {}
  try { first.close() } catch {}
  try { interactions.dispose() } catch {}
  try { db.close() } catch {}
  killOwned()
}
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
