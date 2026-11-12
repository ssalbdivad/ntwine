// Keep a source checkout's `main` in step with `origin/main`, both ways, without anyone remembering.
//
// The maintainer runs ntwine from source on more than one machine, and on each one many agents commit
// to local `main` all day. This is the ONE routine that reconciles a checkout with origin; two things
// call it:
//
//   • the `post-commit` / `post-merge` hooks in scripts/githooks, the moment a commit lands on `main`
//     (workers land worktree branches with `git merge`, which fires post-merge, not post-commit), and
//   • the source dev server (src/dev.ts → startAutosyncPoller), on start and every 5m, so commits pushed
//     from the OTHER machine arrive here without a local commit happening first.
//
// A sync is: fetch origin/main; if it has commits main lacks, MERGE them (never rebase: the shared tree
// is usually dirty with other agents' edits, and a merge only refuses when a dirty file overlaps what it
// would write, where a rebase rewrites every local commit through the working tree); then push main.
// Nothing here stashes, resets, checks out or discards anything. When the merge cannot go cleanly the
// sync logs why, leaves everything as it was, and the next commit or poll tries again:
//   - committed edits that conflict are detected BEFORE the working tree is touched (`git merge-tree`),
//     so no agent ever sees conflict markers or a half-merged MERGE_HEAD in the shared tree;
//   - a dirty file in the way makes `git merge` itself refuse before it writes anything;
//   - if a merge still stops conflicted (main moved between the preview and the merge), it is aborted.
//
// It is opt-in per clone and gated three ways, all re-checked on every run: `git config ntwine.autosync
// true` (set by `pnpm run autosync:on`), an `origin` that IS ssalbdivad/ntwine (a fork or a stranger's
// clone never pushes upstream), and `HEAD` on `main`. `NTWINE_AUTOSYNC=0` turns it off for a process
// tree, `pnpm run autosync:off` for the clone. The published package never runs it: nothing in
// src/production.ts imports this file, and the hooks only exist in a checkout.
//
// One sync at a time per repository: a lockfile in the common git dir. A sync requested while another
// runs leaves a `pending` marker instead of waiting, and the running sync goes round again before it
// exits, so a commit that lands mid-sync is still pushed by that sync. Everything is logged to
// `.git/ntwine-sync.log` (rotated at 1MB); the CLI prints one line per run.
//
//   node src/autosync.ts sync [--reason <why>] [--json] [--detach]
//   node src/autosync.ts on | off | status
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { appendFileSync, closeSync, existsSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const BRANCH = "main"
const LOCAL_REF = `refs/heads/${BRANCH}`
const REMOTE_REF = `refs/remotes/origin/${BRANCH}`
const HOOKS_PATH = "scripts/githooks"
const ENTRY = fileURLToPath(import.meta.url)
/** The checkout this file lives in — what the dev server serves, and what its poller syncs. */
const CHECKOUT = resolve(dirname(ENTRY), "..")
const NETWORK_TIMEOUT_MS = 120_000
const INSTALL_TIMEOUT_MS = 600_000
/** A lock older than this is abandoned even if its pid is alive again (pid reuse). Every step below has
 *  a timeout, and the longest path (fetch + merge + push + install) stays well inside it. */
const LOCK_STALE_MS = 30 * 60_000
/** Rounds of fetch → merge → push. More than one only when origin moves under the push. */
const MAX_ROUNDS = 5
const LOG_LIMIT_BYTES = 1_000_000
export const AUTOSYNC_POLL_MS = 5 * 60_000

/** Set on every git process a sync starts, so the post-merge hook its own merge fires does not recurse. */
const RUNNING_ENV = "NTWINE_AUTOSYNC_RUNNING"

/** ssalbdivad/ntwine over https or ssh, with or without `.git`. Nothing else is ever pushed to. */
export function isAutosyncOrigin(url: string): boolean {
  return /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)ssalbdivad\/ntwine(?:\.git)?\/?$/i.test(url.trim())
}

// ── git ──────────────────────────────────────────────────────────────────────────────────────────

interface Run {
  ok: boolean
  status: number | null
  out: string
  err: string
}

/**
 * The environment every child of a sync gets. A hook inherits the committing git's own variables
 * (git 2.53's post-commit gets GIT_INDEX_FILE, GIT_PREFIX, GIT_EDITOR and the commit's GIT_AUTHOR_*,
 * including its date), and a sync must run as a fresh git in the checkout, not as a continuation of
 * that commit: the merge would otherwise carry the triggering commit's author and date, and a
 * repository- or index-naming variable from a worktree hook would point it somewhere else. So every
 * GIT_* variable is dropped except config, ssh/askpass and tracing.
 */
function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("GIT_") && !/^GIT_(?:CONFIG|SSH|ASKPASS|TRACE|TERMINAL_PROMPT)/.test(key)) continue
    clean[key] = value
  }
  // A credential prompt must fail, not hang a detached process that has no terminal to ask on.
  clean.GIT_TERMINAL_PROMPT = "0"
  clean[RUNNING_ENV] = "1"
  return clean
}

function run(cwd: string, command: string, args: string[], env: NodeJS.ProcessEnv, timeout = 30_000): Run {
  const result = spawnSync(command, args, { cwd, env: childEnv(env), encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] })
  const timedOut = result.error && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT"
  return {
    ok: result.status === 0,
    status: result.status,
    out: (result.stdout ?? "").trim(),
    err: timedOut ? `timed out after ${Math.round(timeout / 1000)}s` : ((result.stderr ?? "").trim() || result.error?.message || ""),
  }
}

const git = (cwd: string, args: string[], env: NodeJS.ProcessEnv, timeout?: number) => run(cwd, "git", args, env, timeout)

function firstLines(text: string, count = 3): string {
  return text.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, count).join(" / ")
}

// ── gate ─────────────────────────────────────────────────────────────────────────────────────────

export type Gate =
  | { ok: true; root: string; commonDir: string }
  | { ok: false; reason: string }

/** Everything that must hold before a sync touches the repository. Re-read on every run. */
export function autosyncGate(cwd: string, env: NodeJS.ProcessEnv = process.env): Gate {
  if (env.NTWINE_AUTOSYNC === "0") return { ok: false, reason: "off for this process (NTWINE_AUTOSYNC=0)" }
  const top = git(cwd, ["rev-parse", "--show-toplevel"], env)
  if (!top.ok) return { ok: false, reason: "not a git checkout" }
  const root = top.out
  if (git(root, ["config", "--bool", "ntwine.autosync"], env).out !== "true") {
    return { ok: false, reason: "autosync is off in this clone (pnpm run autosync:on)" }
  }
  const origin = git(root, ["remote", "get-url", "origin"], env)
  if (!origin.ok) return { ok: false, reason: "this clone has no origin remote" }
  // The one test seam: the end-to-end tests push to a throwaway bare repo, never to GitHub.
  if (!isAutosyncOrigin(origin.out) && env.NTWINE_AUTOSYNC_ANY_ORIGIN !== "1") {
    return { ok: false, reason: `origin is ${origin.out}, not ssalbdivad/ntwine` }
  }
  const branch = currentBranch(root, env)
  if (branch !== BRANCH) return { ok: false, reason: `HEAD is ${branch ?? "detached"}, not ${BRANCH}` }
  const common = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"], env)
  if (!common.ok) return { ok: false, reason: `cannot find the git dir: ${common.err}` }
  return { ok: true, root, commonDir: common.out }
}

function currentBranch(root: string, env: NodeJS.ProcessEnv): string | undefined {
  const head = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], env)
  return head.ok ? head.out : undefined
}

// ── log and lock ─────────────────────────────────────────────────────────────────────────────────

type Log = (message: string) => void

function openLog(commonDir: string, reason: string): Log {
  const file = join(commonDir, "ntwine-sync.log")
  return (message) => {
    try {
      if (existsSync(file) && statSync(file).size > LOG_LIMIT_BYTES) renameSync(file, `${file}.1`)
      appendFileSync(file, `${new Date().toISOString()} [${reason} ${process.pid}] ${message}\n`)
    } catch {
      // The log is for a human reading after the fact; failing to write it must not fail a sync.
    }
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** O_EXCL create; a lock whose owner is dead (or that is older than LOCK_STALE_MS) is taken over. */
function acquireLock(path: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx")
      writeSync(fd, `${process.pid} ${Date.now()}\n`)
      closeSync(fd)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
    let held: string
    try {
      held = readFileSync(path, "utf8")
    } catch {
      continue // released between our create and our read: try the create again
    }
    const [pid, since] = held.trim().split(" ").map(Number)
    const stale = !pid || !pidAlive(pid) || !since || Date.now() - since > LOCK_STALE_MS
    if (!stale) return false
    // Remove it only if it is still the SAME stale lock; another taker may have replaced it already.
    try {
      if (readFileSync(path, "utf8") === held) rmSync(path)
    } catch {
      // gone already
    }
  }
  return false
}

function releaseLock(path: string): void {
  try {
    if (readFileSync(path, "utf8").startsWith(`${process.pid} `)) rmSync(path)
  } catch {
    // not ours, or already gone
  }
}

// ── sync ─────────────────────────────────────────────────────────────────────────────────────────

export interface SyncOutcome {
  /** skipped: gated off · busy: another sync took the request · in-sync: nothing to do · synced: moved
   *  commits · blocked: a merge could not go cleanly (needs a person or a later commit) · failed: git or
   *  the network said no. */
  state: "skipped" | "busy" | "in-sync" | "synced" | "blocked" | "failed"
  message: string
  pulled: number
  pushed: number
}

export interface SyncOptions {
  cwd?: string
  reason?: string
  env?: NodeJS.ProcessEnv
}

/** Run one sync, serialized against every other sync of this repository. Never throws for git's sake. */
export function runSync({ cwd = process.cwd(), reason = "manual", env = process.env }: SyncOptions = {}): SyncOutcome {
  const gate = autosyncGate(cwd, env)
  if (!gate.ok) return { state: "skipped", message: gate.reason, pulled: 0, pushed: 0 }
  const log = openLog(gate.commonDir, reason)
  const lock = join(gate.commonDir, "ntwine-sync.lock")
  const pending = join(gate.commonDir, "ntwine-sync.pending")

  if (!acquireLock(lock)) {
    // Ask the running sync for another round, THEN try once more: if it released in between, its
    // post-release check may already have missed the marker, so this run must take the work itself.
    writeFileSync(pending, `${reason}\n`)
    if (!acquireLock(lock)) {
      log("another sync is running; it will go round again for this one")
      return { state: "busy", message: "another sync is running", pulled: 0, pushed: 0 }
    }
  }

  const total: SyncOutcome = { state: "in-sync", message: "main is in sync with origin", pulled: 0, pushed: 0 }
  let held = true
  try {
    do {
      rmSync(pending, { force: true })
      const round = syncOnce(gate.root, env, log)
      total.pulled += round.pulled
      total.pushed += round.pushed
      total.state = round.state === "in-sync" && total.pulled + total.pushed > 0 ? "synced" : round.state
      total.message = round.state === "in-sync" && total.pulled + total.pushed > 0 ? describeMoves(total) : round.message
      releaseLock(lock)
      held = false
      // Release BEFORE looking: a requester that found the lock held wrote the marker first, so either
      // it is visible now or that requester's own second try got the lock.
      if (!existsSync(pending)) break
      held = acquireLock(lock)
    } while (held)
  } finally {
    if (held) releaseLock(lock)
  }
  return total
}

function describeMoves({ pulled, pushed }: { pulled: number; pushed: number }): string {
  const parts: string[] = []
  if (pulled) parts.push(`pulled ${pulled} commit${pulled === 1 ? "" : "s"} from origin/main`)
  if (pushed) parts.push(`pushed ${pushed} commit${pushed === 1 ? "" : "s"} to origin/main`)
  return parts.join(", ")
}

function inProgress(root: string, env: NodeJS.ProcessEnv): string | undefined {
  const states: Array<[string, string]> = [
    ["MERGE_HEAD", "merge"],
    ["rebase-merge", "rebase"],
    ["rebase-apply", "rebase"],
    ["CHERRY_PICK_HEAD", "cherry-pick"],
    ["REVERT_HEAD", "revert"],
  ]
  for (const [name, label] of states) {
    const path = git(root, ["rev-parse", "--path-format=absolute", "--git-path", name], env).out
    if (path && existsSync(path)) return label
  }
  return undefined
}

function count(root: string, range: string, env: NodeJS.ProcessEnv): number {
  return Number(git(root, ["rev-list", "--count", range], env).out) || 0
}

/** Another fetch in this clone (an agent's own, or the other trigger's) can move origin/main between
 *  this fetch's read and its write; git then refuses the ref update. That is a race, not a failure. */
function fetchOrigin(root: string, env: NodeJS.ProcessEnv): Run {
  for (let attempt = 0; ; attempt++) {
    const fetch = git(root, ["fetch", "--quiet", "origin", `+${LOCAL_REF}:${REMOTE_REF}`], env, NETWORK_TIMEOUT_MS)
    if (fetch.ok || attempt === 2 || !/incorrect old value|cannot lock ref|unable to update local ref/i.test(fetch.err)) return fetch
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250)
  }
}

/** Files whose change means node_modules may no longer match the tree. */
function touchesDependencies(path: string): boolean {
  return path === "pnpm-lock.yaml" || path === "pnpm-workspace.yaml" || path === ".npmrc" || path.endsWith("package.json")
}

function syncOnce(root: string, env: NodeJS.ProcessEnv, log: Log): SyncOutcome {
  let pulled = 0
  let pushed = 0
  const changed = new Set<string>()
  const result = (state: SyncOutcome["state"], message: string): SyncOutcome => {
    log(message)
    if (changed.size) refreshDependencies(root, [...changed], env, log)
    return { state, message, pulled, pushed }
  }

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const fetch = fetchOrigin(root, env)
    if (!fetch.ok) return result("failed", `can't fetch origin/main: ${firstLines(fetch.err)}`)
    // An agent may have switched the shared checkout off main since the gate looked.
    if (currentBranch(root, env) !== BRANCH) return result("skipped", `HEAD left ${BRANCH}; stopped`)

    const local = git(root, ["rev-parse", LOCAL_REF], env).out
    const remote = git(root, ["rev-parse", REMOTE_REF], env).out
    if (local === remote) return result("in-sync", pulled + pushed ? describeMoves({ pulled, pushed }) : "main is in sync with origin")

    const behind = count(root, `${LOCAL_REF}..${REMOTE_REF}`, env)
    if (behind > 0) {
      const busy = inProgress(root, env)
      if (busy) return result("blocked", `can't pull origin/main: a ${busy} is in progress in this checkout`)
      // Preview the merge in the object store only. A conflict here never reaches the shared tree.
      const preview = git(root, ["merge-tree", "--write-tree", "--name-only", "--no-messages", LOCAL_REF, REMOTE_REF], env)
      if (preview.status === 1) {
        const files = preview.out.split("\n").slice(1).filter(Boolean)
        return result("blocked", `can't pull origin/main: it conflicts with local main in ${files.slice(0, 5).join(", ")}${files.length > 5 ? ` and ${files.length - 5} more` : ""}`)
      }
      if (!preview.ok) return result("failed", `can't preview the merge: ${firstLines(preview.err)}`)

      // --ff: fast-forward when main has nothing of its own, whatever merge.ff says.
      const merge = git(root, ["merge", "--ff", "--no-edit", "origin/main"], env, NETWORK_TIMEOUT_MS)
      if (!merge.ok) {
        const mergeHead = git(root, ["rev-parse", "--path-format=absolute", "--git-path", "MERGE_HEAD"], env).out
        if (mergeHead && existsSync(mergeHead)) {
          const abort = git(root, ["merge", "--abort"], env)
          log(abort.ok ? "aborted a conflicted merge" : `merge --abort failed: ${firstLines(abort.err)}`)
        }
        // Usually "your local changes would be overwritten": a dirty file overlaps the incoming change.
        return result("blocked", `can't pull origin/main: ${firstLines(merge.err || merge.out, 4)}`)
      }
      pulled += behind
      for (const path of git(root, ["diff", "--name-only", local, "HEAD"], env).out.split("\n")) if (path) changed.add(path)
      log(`merged ${behind} commit${behind === 1 ? "" : "s"} from origin/main`)
    }

    const ahead = count(root, `${REMOTE_REF}..${LOCAL_REF}`, env)
    // Nothing of our own: the merge above was a fast-forward, and main now IS origin/main.
    if (ahead === 0) return result("in-sync", describeMoves({ pulled, pushed }) || "main is in sync with origin")
    const push = git(root, ["push", "--quiet", "origin", `${LOCAL_REF}:${LOCAL_REF}`], env, NETWORK_TIMEOUT_MS)
    if (!push.ok) {
      // Origin moved between our fetch and our push (the other machine pushed): go round again.
      if (/rejected|non-fast-forward|fetch first|stale info/i.test(push.err)) {
        log("origin moved under the push; fetching again")
        continue
      }
      return result("failed", `can't push main: ${firstLines(push.err)}`)
    }
    pushed += ahead
    log(`pushed ${ahead} commit${ahead === 1 ? "" : "s"}`)
    // The push moved origin/main to main. If main moved again meanwhile, the next round pushes that too.
    if (git(root, ["rev-parse", LOCAL_REF], env).out === git(root, ["rev-parse", REMOTE_REF], env).out) {
      return result("in-sync", describeMoves({ pulled, pushed }))
    }
  }
  return result("failed", `main still differs from origin after ${MAX_ROUNDS} rounds`)
}

/**
 * A merge that changed a manifest or the lockfile leaves node_modules describing the OLD tree, and the
 * dev server's watcher ignores node_modules entirely. So install, then rewrite the lockfile with its own
 * bytes: that write is the watcher event that restarts the dev server on the installed dependencies
 * (the merge's own lockfile event may already have restarted it, mid-install, on the old ones).
 */
function refreshDependencies(root: string, changed: string[], env: NodeJS.ProcessEnv, log: Log): void {
  const manifests = changed.filter(touchesDependencies)
  if (manifests.length === 0) return
  log(`dependencies changed (${manifests.slice(0, 3).join(", ")}${manifests.length > 3 ? ", …" : ""}); running pnpm install`)
  const install = run(root, "pnpm", ["install", "--frozen-lockfile"], env, INSTALL_TIMEOUT_MS)
  if (!install.ok) {
    log(`pnpm install failed — run it by hand: ${firstLines(install.err || install.out, 4)}`)
    return
  }
  const lockfile = join(root, "pnpm-lock.yaml")
  try {
    writeFileSync(lockfile, readFileSync(lockfile))
  } catch {
    // no lockfile: nothing to nudge
  }
  log("pnpm install done")
}

// ── the dev server's poller ──────────────────────────────────────────────────────────────────────

export interface AutosyncPoller {
  stop(): void
}

/**
 * The pull side: sync this checkout on start and every `intervalMs`, so the other machine's pushes
 * arrive with no local commit to trigger the hook. Each run is a DETACHED `node src/autosync.ts sync`,
 * so a dev server stopped mid-merge never kills git halfway through writing the shared tree. A merged
 * update then takes effect the way any edit does: the dev supervisor's watcher restarts the control
 * plane (and re-execs itself for launcher/config files), and Vite hot-reloads the web app.
 *
 * `say` hears a run that moved commits or could not, once per distinct message, so a sync that stays
 * blocked does not repeat itself every five minutes.
 */
export function startAutosyncPoller({
  say,
  cwd = CHECKOUT,
  intervalMs = AUTOSYNC_POLL_MS,
  env = process.env,
}: { say: (line: string) => void; cwd?: string; intervalMs?: number; env?: NodeJS.ProcessEnv }): AutosyncPoller {
  if (env.NTWINE_AUTOSYNC === "0") return { stop() {} }
  let child: ChildProcess | undefined
  let lastSaid = ""
  const tick = () => {
    if (child) return
    // Pass the environment through raw: the CLI scrubs it itself, and RUNNING_ENV must not be set here.
    const spawned = spawn(process.execPath, [ENTRY, "sync", "--reason", "dev-poll", "--json"], {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    })
    child = spawned
    let out = ""
    spawned.stdout?.setEncoding("utf8").on("data", (chunk: string) => { out += chunk })
    spawned.on("error", () => { child = undefined })
    spawned.on("close", () => {
      child = undefined
      let outcome: SyncOutcome | undefined
      try {
        outcome = JSON.parse(out.trim().split("\n").at(-1) ?? "") as SyncOutcome
      } catch {
        return
      }
      if (outcome.state === "synced" || outcome.state === "blocked" || outcome.state === "failed") {
        if (outcome.message !== lastSaid) say(outcome.message)
        lastSaid = outcome.message
      } else if (outcome.state === "in-sync") {
        lastSaid = ""
      }
    })
  }
  tick()
  const timer = setInterval(tick, intervalMs)
  timer.unref()
  return { stop: () => clearInterval(timer) }
}

// ── on / off / status ────────────────────────────────────────────────────────────────────────────

/** Hooks a person put in .git/hooks themselves, which pointing core.hooksPath elsewhere would silence. */
function customHooks(root: string, env: NodeJS.ProcessEnv): string[] {
  const dir = git(root, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"], env).out
  try {
    return readdirSync(dir).filter((name) => !name.endsWith(".sample"))
  } catch {
    return []
  }
}

function turnOn(cwd: string, env: NodeJS.ProcessEnv): number {
  const top = git(cwd, ["rev-parse", "--show-toplevel"], env)
  if (!top.ok) return fail("not a git checkout")
  const root = top.out
  const origin = git(root, ["remote", "get-url", "origin"], env).out
  if (!isAutosyncOrigin(origin) && env.NTWINE_AUTOSYNC_ANY_ORIGIN !== "1") {
    return fail(`origin is ${origin || "unset"}; autosync only pushes to ssalbdivad/ntwine. From a fork, open a pull request instead.`)
  }
  const hooksPath = git(root, ["config", "core.hooksPath"], env).out
  if (hooksPath && hooksPath !== HOOKS_PATH && resolve(root, hooksPath) !== resolve(root, HOOKS_PATH)) {
    return fail(`core.hooksPath is ${hooksPath}; point it at ${HOOKS_PATH} (or call its post-commit and post-merge from yours) and run this again`)
  }
  if (!hooksPath) {
    const custom = customHooks(root, env)
    if (custom.length) return fail(`.git/hooks has ${custom.join(", ")}, which core.hooksPath would switch off; move them into ${HOOKS_PATH} first`)
  }
  // Relative, always: an absolute path silently runs no hooks once the checkout moves (AGENTS.local.md).
  git(root, ["config", "core.hooksPath", HOOKS_PATH], env)
  git(root, ["config", "--bool", "ntwine.autosync", "true"], env)
  console.log(`autosync on: commits to main push to origin, and the dev server pulls every ${AUTOSYNC_POLL_MS / 60_000}m`)
  // Prove this machine can push without a prompt now, rather than in a detached hook nobody watches.
  const probe = git(root, ["push", "--dry-run", "--quiet", "origin", `${LOCAL_REF}:${LOCAL_REF}`], env, NETWORK_TIMEOUT_MS)
  if (probe.ok || /rejected|non-fast-forward|fetch first/i.test(probe.err)) console.log("push access to origin: ok")
  else console.log(`push access to origin FAILED, so syncs will too: ${firstLines(probe.err)}`)
  console.log("pnpm run autosync syncs now · pnpm run autosync:status · pnpm run autosync:off")
  return 0
}

function turnOff(cwd: string, env: NodeJS.ProcessEnv): number {
  const top = git(cwd, ["rev-parse", "--show-toplevel"], env)
  if (!top.ok) return fail("not a git checkout")
  git(top.out, ["config", "--bool", "ntwine.autosync", "false"], env)
  // core.hooksPath stays: it also carries the pre-commit guard, and the sync hooks are inert when off.
  console.log("autosync off for this clone (pnpm run autosync:on turns it back on)")
  return 0
}

function status(cwd: string, env: NodeJS.ProcessEnv): number {
  const gate = autosyncGate(cwd, env)
  const top = git(cwd, ["rev-parse", "--show-toplevel"], env)
  if (!top.ok) return fail("not a git checkout")
  const root = top.out
  console.log(gate.ok ? "autosync: on" : `autosync: not running — ${gate.reason}`)
  console.log(`hooks: ${git(root, ["config", "core.hooksPath"], env).out || "(core.hooksPath unset: hooks will not fire)"}`)
  const ahead = count(root, `${REMOTE_REF}..${LOCAL_REF}`, env)
  const behind = count(root, `${LOCAL_REF}..${REMOTE_REF}`, env)
  console.log(`main vs origin/main as last fetched: ${ahead} ahead, ${behind} behind`)
  const commonDir = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"], env).out
  const logFile = join(commonDir, "ntwine-sync.log")
  if (existsSync(logFile)) {
    console.log(`last runs (${logFile}):`)
    for (const line of readFileSync(logFile, "utf8").trimEnd().split("\n").slice(-8)) console.log(`  ${line}`)
  }
  return 0
}

function fail(message: string): number {
  console.error(`autosync: ${message}`)
  return 1
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────

function main(argv: string[]): number {
  const [command = "sync", ...rest] = argv
  const flag = (name: string) => rest.includes(name)
  const value = (name: string) => {
    const at = rest.indexOf(name)
    return at >= 0 ? rest[at + 1] : undefined
  }
  const env = process.env
  switch (command) {
    case "sync": {
      // A merge this sync made fires post-merge; that hook's run is this one, already going.
      if (env[RUNNING_ENV] === "1") return 0
      if (flag("--detach")) {
        // From a hook: leave the committing process's session so neither its exit nor a kill of its
        // process group can stop git halfway, and return at once so the commit is not held up.
        spawn(process.execPath, [ENTRY, "sync", ...rest.filter((arg) => arg !== "--detach")], {
          cwd: process.cwd(),
          env,
          detached: true,
          stdio: "ignore",
        }).unref()
        return 0
      }
      const outcome = runSync({ cwd: process.cwd(), reason: value("--reason") ?? "manual", env })
      console.log(flag("--json") ? JSON.stringify(outcome) : `autosync: ${outcome.message}`)
      return outcome.state === "failed" ? 1 : 0
    }
    case "on":
      return turnOn(process.cwd(), env)
    case "off":
      return turnOff(process.cwd(), env)
    case "status":
      return status(process.cwd(), env)
    default:
      return fail(`unknown command ${command}; use sync, on, off or status`)
  }
}

if (import.meta.main) {
  // The dev poller reads this process's stdout through a pipe that dies with the dev server; a write
  // after that must not crash a sync that is still finishing.
  process.stdout.on("error", () => {})
  process.exitCode = main(process.argv.slice(2))
}
