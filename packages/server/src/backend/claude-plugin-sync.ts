// A WORKER KEEPS ITS OWN PLUGIN CLOSURE CURRENT. Nobody presses a button, and the server asks for nothing.
//
// A Claude worker loads its closure — hook registrations, skills, sub-agent profiles, commands — once,
// when its session starts, and the daemon holding that session outlives the Frizz that forked it by
// hours. Two things change under it meanwhile:
//
//  • FRIZZ'S OWN PLUGIN. Frizz publishes it at a path that MOVES when a newer version boots
//    (stable-plugin-path.ts), and a source checkout's `cc-worker/` is edited where it stands.
//  • THE OPERATOR'S. A skill added to the project, an agent profile edited, a plugin installed. A live
//    session does not notice any of these by itself — measured against claude 2.1.296, a project skill
//    written after the session started was not invocable a turn later, and was after a reload.
//
// Until 2026-10-11 the only way across that gap was a "Reload plugins" button on the thread, which an
// operator had to know to press on every live thread after every change — and which could not help at
// all with the first kind, because workers were launched against a version-specific directory that
// never changed.
//
// So the daemon asks the question itself, at the two moments a session is between turns: when a turn
// ENDS, and when an input arrives for a session that is idle. If the closure's fingerprint has moved
// since the copy this session loaded, it re-reads it in place (`Query.reloadPlugins()`, 40–85ms
// measured): same process, same conversation, same in-memory sub-agents.
//
// BETWEEN TURNS, NEVER DURING ONE. A reload swaps the hook registrations under the session, and a
// tool call that lands while they are being swapped can miss its hook — a permission request the
// policy hook would have settled reaches the operator as a card, a sub-agent launch goes unbound. A
// turn boundary is the one place nothing is in flight to miss. That is also why an input waits behind
// a reload already under way instead of racing it: the turn it starts must see one plugin, not two.
//
// What it does NOT move is an MCP server: a reload reports the plugin's servers and re-spawns none of
// them (measured, plans/live-worker-updates.md §0). The Frizz MCP shim is written so that does not
// matter — it re-resolves the server it talks to on every call.

import { createHash } from "node:crypto"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { pluginFingerprint } from "../stable-plugin-path.ts"

/** Opt-out, for the day a reload itself is what is breaking workers: `FRIZZ_PLUGIN_SYNC_OFF=1` in the
 *  environment Frizz is started with. Read by the daemon at fork, so it reaches newly started workers. */
export function claudePluginSyncEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FRIZZ_PLUGIN_SYNC_OFF !== "1"
}

// A held input is answered inside the bridge's 30s acknowledgement deadline or the operator's send
// fails, so a reload that has not come back by now is abandoned and the input goes ahead without it.
const RELOAD_DEADLINE_MS = 8_000
// One plugin state gets this many tries. A plugin that cannot be reloaded would otherwise cost a
// failed reload at every turn boundary for the rest of the session.
const RELOAD_ATTEMPTS = 2

/** A closure source that could not be read right now, as opposed to one that is simply not there. */
class ClosureUnreadable extends Error {}

// What ONE `.claude` directory contributes to a session's closure, as stats — cheap enough to take at
// every turn boundary (a few dozen syscalls on a machine with a lot of skills), and deliberately
// narrower than "everything under .claude":
//
//  • `skills/<name>/SKILL.md` only. A skill's listing is its front matter; the scripts beside it are
//    read when it runs, so a change to those needs no reload and must not cause one.
//  • `agents/` and `commands/`, recursively, markdown only.
//  • `enabledPlugins` out of the two settings files, by VALUE. A stat would be wrong here: Claude Code
//    rewrites `settings.local.json` every time a permission is granted, and that would reload every
//    live worker in the project on every grant.
//  • `plugins/installed_plugins.json`, which is rewritten when a plugin is installed, updated or
//    removed. Present under the user's directory only.
//
// Hooks declared in a settings file are absent on purpose: Claude Code snapshots those at session start
// and a reload does not re-read them.
function claudeDirEntries(root: string, entries: string[]): void {
  const stamp = (path: string): void => {
    try {
      const stat = statSync(path)
      if (stat.isFile()) entries.push(`${path}\0${stat.size}\0${stat.mtimeMs}`)
    } catch { /* absent, or gone between the listing and the stat: not part of the closure */ }
  }
  const list = (dir: string): string[] => {
    try { return readdirSync(dir).sort() } catch { return [] }
  }
  for (const name of list(join(root, "skills"))) stamp(join(root, "skills", name, "SKILL.md"))
  const markdownUnder = (dir: string, depth: number): void => {
    for (const name of list(dir)) {
      const path = join(dir, name)
      if (name.endsWith(".md")) stamp(path)
      // Bounded: these are hand-kept directories a few levels deep, and a link cycle must not hang a daemon.
      else if (depth < 4) markdownUnder(path, depth + 1)
    }
  }
  markdownUnder(join(root, "agents"), 0)
  markdownUnder(join(root, "commands"), 0)
  for (const file of ["settings.json", "settings.local.json"]) {
    let raw: string
    try { raw = readFileSync(join(root, file), "utf8") } catch { continue }
    // Caught mid-write, a settings file is not valid JSON for an instant. That is "ask again at the
    // next boundary", never "the operator disabled every plugin".
    let enabled: unknown
    try { enabled = (JSON.parse(raw) as { enabledPlugins?: unknown } | null)?.enabledPlugins } catch { throw new ClosureUnreadable(file) }
    entries.push(`${join(root, file)}\0${JSON.stringify(enabled ?? null)}`)
  }
  stamp(join(root, "plugins", "installed_plugins.json"))
}

/**
 * The closure a reload would re-read, as it is on disk right now: Frizz's plugin (where its path leads
 * and every file there — `pluginFingerprint`), plus the project's and the operator's own `.claude`
 * directories. Undefined when any of it cannot be read at this moment, which is never a reason to
 * reload.
 */
export function claudeClosureFingerprint(closure: { pluginDir?: string; projectDir: string; configDir: string }): string | undefined {
  const plugin = closure.pluginDir ? pluginFingerprint(closure.pluginDir) : ""
  if (plugin === undefined) return undefined
  const entries: string[] = [plugin]
  try {
    claudeDirEntries(join(closure.projectDir, ".claude"), entries)
    claudeDirEntries(closure.configDir, entries)
  } catch {
    return undefined
  }
  return createHash("sha1").update(entries.join("\n")).digest("hex")
}

export interface ClaudePluginSync {
  /**
   * An input is about to be handed to the session. Resolves when it may go; null means now.
   *
   * `startsTurn` is false for a message addressed to a running sub-agent, which joins a conversation
   * already under way instead of opening a turn on the thread. It still waits behind a reload in
   * flight, and never starts one.
   */
  beforeInput(startsTurn: boolean): Promise<void> | null
  /** Something is about to READ the closure (the composer listing skills). Same check, no turn. */
  beforeRead(): Promise<void> | null
  /** The session produced output, so a turn is running — including one it opened by itself, on a
   *  background task's completion, with no input from anyone. */
  turnActive(): void
  turnEnded(): void
}

export function createClaudePluginSync(deps: {
  /** The closure as it is on disk right now; undefined when it cannot be read. */
  fingerprint: () => string | undefined
  reload: () => Promise<{ errorCount?: number }>
  log: (message: string) => void
  deadlineMs?: number
}): ClaudePluginSync {
  // What the session is running. Taken before the session starts, so a plugin that moves while the
  // CLI is still reading it costs one redundant reload rather than a missed one.
  let loaded = deps.fingerprint()
  let busy = false
  let inFlight: Promise<void> | null = null
  let failed: { fingerprint: string; attempts: number } | undefined

  // Logging is the one thing in here that calls out, and nothing it does may reach the promise an
  // input is waiting on.
  const say = (message: string): void => { try { deps.log(message) } catch { /* forensics only */ } }

  const reloadWithinDeadline = (): Promise<{ errorCount?: number }> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the session did not answer in time")), deps.deadlineMs ?? RELOAD_DEADLINE_MS)
    // Never the thing holding a process open: a daemon shutting down mid-reload must be able to exit.
    timer.unref?.()
    deps.reload().then(
      (result) => { clearTimeout(timer); resolve(result) },
      (error: unknown) => { clearTimeout(timer); reject(error) },
    )
  })

  const check = (): void => {
    if (inFlight) return
    const current = deps.fingerprint()
    if (current === undefined || current === loaded) return
    if (failed?.fingerprint === current && failed.attempts >= RELOAD_ATTEMPTS) return
    // THIS PROMISE NEVER REJECTS. Inputs wait on it, and one that rejected would strand them: the
    // operator's message accepted by the daemon and handed to nobody. A reload that fails is a line in
    // the log and a session still on the closure it had.
    const attempt: Promise<void> = reloadWithinDeadline().then(
      (result) => {
        loaded = current
        failed = undefined
        say(`plugin closure changed on disk; reloaded in place${result.errorCount ? ` with ${result.errorCount} load error(s)` : ""}`)
      },
      (error: unknown) => {
        failed = { fingerprint: current, attempts: failed?.fingerprint === current ? failed.attempts + 1 : 1 }
        say(`plugin closure changed on disk but the reload failed (attempt ${failed.attempts}/${RELOAD_ATTEMPTS}): ${error instanceof Error ? error.message : String(error)}`)
      },
    ).catch(() => undefined).finally(() => { if (inFlight === attempt) inFlight = null })
    inFlight = attempt
  }

  return {
    beforeInput(startsTurn) {
      if (startsTurn) {
        if (!busy) check()
        busy = true
      }
      return inFlight
    },
    beforeRead() {
      if (!busy) check()
      return inFlight
    },
    turnActive() { busy = true },
    turnEnded() {
      busy = false
      check()
    },
  }
}
