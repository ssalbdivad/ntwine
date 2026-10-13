// LIVE probe (not a unit test; excluded from the *.test.ts glob). Answers ONE question, because the
// answer decides whether scratch-directory re-orientation can reach a Codex worker at all:
//
//   Do Codex lifecycle hooks fire when they are delivered through the per-conversation `config`
//   override that ntwine's CodexAppServerBridge already supports?
//
// This matters because ntwine drives Codex over `codex app-server`, NOT `codex exec`. Measured first:
// in codex-cli 0.144.6 `codex exec` runs NO hooks at all — not from `<repo>/.codex/hooks.json`, not
// from `$CODEX_HOME/hooks.json`, not from `-c hooks.…` overrides, with or without
// `bypass_hook_trust=true`, in a git repo or out of one, even though the `hooks` feature flag reports
// as enabled. So the exec surface is dead for this; the app-server surface is the one that counts.
//
// The probe separates the two variables an earlier attempt conflated: the hook script writes a MARKER
// FILE (did it RUN?) and returns additionalContext (did its output REACH the model?). Without the
// marker, "the model didn't mention the token" is unreadable — it could mean the hook never ran, or
// ran and its output was dropped.
//
// Run:
//   nub packages/server/src/backend/_live_codex_hooks.mts
import { spawn as spawnChild } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Database from "../sqlite.ts"
import { createInteractionStore } from "../interaction-store.ts"
import { CodexAppServerBridge, type CodexAppServerSpawn } from "./codex-app-server.ts"

const CODEX_BIN = process.env.CODEX_BIN || "codex"
const dir = mkdtempSync(join(tmpdir(), "ntwine-live-codex-hooks-"))
const marker = join(dir, "RAN.log")
const hook = join(dir, "hook.sh")
const REAL_HOOK = join(process.cwd(), "../cc-worker/hooks/scratchpad.mjs")
const SID = "codex-probe-session"

// Records WHICH event fired (stdin carries hook_event_name) and returns a sentinel the model could
// only know from the injection.
writeFileSync(
  hook,
  `#!/bin/sh
IN=$(cat)
echo "FIRED $IN" >> ${marker}
printf '%s' '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"The verification token is TANGERINE-IBIS-6621."}}'
`
)
chmodSync(hook, 0o755)

const oneHook = { hooks: [{ type: "command", command: hook }] }

// A REAL scratch directory for the REAL hook, carrying a sentinel the model can only know from the
// injection. THE SENTINEL IS THE FILENAME, deliberately: since 2026-08-06 the hook emits a LISTING and
// never file content, so a token hidden INSIDE a file is one the model could not recite even with the
// hook working perfectly — the probe would report a false negative and read as "codex hooks are dead".
mkdirSync(join(dir, ".ntwine", "threads", SID), { recursive: true })
writeFileSync(
  join(dir, ".ntwine", "threads", SID, "rollback-token-MARIGOLD-SABLE-7734.md"),
  "the plan, whose CONTENT the hook deliberately does not inject\n"
)
// No `--enabled`: the opt-in flag was removed when re-grounding became unconditional.
const realCmd = (mode: string) => ({
  hooks: [{ type: "command", command: `node ${JSON.stringify(REAL_HOOK)} ${mode}` }],
})

const db = new Database(join(dir, "ui.db"))
db.pragma("journal_mode = WAL")
let iid = 0
let cid = 0
const interactions = createInteractionStore(db, { now: () => new Date(), id: () => `i-${++iid}` })
const spawn: CodexAppServerSpawn = (binary, args, options) =>
  spawnChild(binary, [...args], { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] })
const bridge = new CodexAppServerBridge({
  projectId: "live",
  projectDir: dir,
  db,
  interactions,
  codexBin: CODEX_BIN,
  spawn,
  now: () => new Date(),
  id: () => `c-${++cid}`,
  requestTimeoutMs: 30_000,
  diagnostic: () => {},
})

const slug = "hook-probe"
const sessionId = "hook-probe-session"
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  try {
    console.log("cwd:", dir)
    await bridge.startDisposableSession({
      threadSlug: slug,
      sessionId,
      cwd: dir,
      sandbox: "read-only",
      ephemeral: false,
      config: {
        bypass_hook_trust: true,
        hooks: {
          SessionStart: [oneHook],
          UserPromptSubmit: [oneHook],
          PostToolUse: [oneHook],
          Stop: [oneHook],
        },
      },
    })
    console.log("session started")

    await bridge.startTurn({
      threadSlug: slug,
      sessionId,
      text: "Answer from context only, do not use tools: what is the verification token?",
    })

    // Let the turn finish.
    const t0 = Date.now()
    while (Date.now() - t0 < 90_000) {
      if (bridge.binding(slug, sessionId)?.currentTurnId == null) break
      await sleep(250)
    }

    console.log("\n=== PHASE 2: the REAL scratchpad.mjs, wired exactly as ntwine wires it ===")
    await bridge.startDisposableSession({
      threadSlug: "real-probe", sessionId: SID, cwd: dir, sandbox: "read-only", ephemeral: false,
      config: {
        bypass_hook_trust: true,
        hooks: { SessionStart: [realCmd("--mode=session-start")], UserPromptSubmit: [realCmd("--mode=nudge")] },
      },
    })
    await bridge.startTurn({
      threadSlug: "real-probe", sessionId: SID,
      text: "Answer from context only, do not use tools: name the file in my scratch directory.",
    })
    const t2 = Date.now()
    while (Date.now() - t2 < 90_000) {
      if (bridge.binding("real-probe", SID)?.currentTurnId == null) break
      await sleep(250)
    }
    const kept = readdirSync(join(dir, ".ntwine", "threads", SID))
    console.log("  scratch dir still intact:", kept.some((f) => f.includes("MARIGOLD-SABLE-7734")))

    console.log("\n=== DID ANY HOOK RUN? ===")
    if (existsSync(marker)) {
      for (const line of readFileSync(marker, "utf8").trim().split("\n")) {
        let ev = "?"
        try {
          ev = JSON.parse(line.slice(6)).hook_event_name ?? "?"
        } catch {
          /* keep ? */
        }
        console.log("  fired:", ev)
      }
    } else {
      console.log("  NO — the marker file was never written; no hook executed.")
    }
  } catch (e) {
    console.log("PROBE ERROR:", (e as Error).message)
  } finally {
    try {
      await bridge.shutdown?.()
    } catch {
      /* best effort */
    }
    process.exit(0)
  }
})()
