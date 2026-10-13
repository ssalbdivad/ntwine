import { test } from "node:test"
import assert from "node:assert/strict"
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { Bus } from "./bus.ts"
import { createStorage, type SessionRow } from "./storage.ts"
import { applyEvent, createTailer, leadingCd, newTailState } from "./tailer.ts"
import { resetCheckoutMemo } from "./thread-cwd.ts"
import type { Project } from "./project.ts"

// WHERE THE AGENT IS WORKING, AND WHERE EACH OF ITS SHELLS STARTED — folded from the transcript the tailer
// already reads, over real folders (a linked worktree's `.git` is a FILE, as in thread-cwd.test.ts).

function world(opts: { shellCwd?: (outputFile: string) => string | undefined; deps?: Partial<Parameters<typeof createTailer>[0]> } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-tail-cwd-")))
  const project = join(root, "repo")
  mkdirSync(join(project, ".git"), { recursive: true })
  mkdirSync(join(project, "packages", "web"), { recursive: true })
  const worktree = join(project, ".ntwine", "worktrees", "probe")
  mkdirSync(join(worktree, "src"), { recursive: true })
  writeFileSync(join(worktree, ".git"), `gitdir: ${join(project, ".git", "worktrees", "probe")}\n`)
  const logDir = join(root, "projects", "-repo")
  mkdirSync(logDir, { recursive: true })
  const storage = createStorage(join(root, "ui.db"), "p")
  const row: SessionRow = { slug: "t", session_id: "sid", thread_name: "ntwine-t", spawned_at: "2026-07-01T00:00:00.000Z", last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0, title: null, state: null, meta: null, seen_at: null, transcript_id: null }
  storage.upsertSession(row)
  const changes = { n: 0 }
  const transcript = join(logDir, "sid.jsonl")
  writeFileSync(transcript, "")
  const append = (...records: unknown[]) => appendFileSync(transcript, records.map((r) => JSON.stringify(r) + "\n").join(""))
  resetCheckoutMemo()
  const tailer = createTailer({
    project: { cwdSlug: "x", dir: project } as Project,
    storage,
    bus: new Bus(),
    onChange: () => changes.n++,
    now: () => Date.parse("2026-07-01T00:01:00.000Z"),
    paneDead: () => false,
    sessionLogDir: logDir,
    ...(opts.shellCwd ? { shellCwd: opts.shellCwd } : {}),
    ...opts.deps,
  })
  return { root, project, worktree, tailer, append, changes, cleanup: () => { resetCheckoutMemo(); rmSync(root, { recursive: true, force: true }) } }
}

let n = 0
const at = () => `2026-07-01T00:00:${String(++n % 60).padStart(2, "0")}.000Z`
const user = (cwd: string, extra: Record<string, unknown> = {}) => ({ type: "user", timestamp: at(), cwd, message: { role: "user", content: "go" }, ...extra })
const bash = (id: string, command: string, cwd: string, background = true) => ({
  type: "assistant",
  timestamp: at(),
  cwd,
  message: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "Bash", id, input: { command, description: `run ${id}`, ...(background ? { run_in_background: true } : {}) } }] },
})
const monitor = (id: string, cwd: string) => ({
  type: "assistant",
  timestamp: at(),
  cwd,
  message: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "Monitor", id, input: { command: "tail -f log", description: "watch the log", persistent: true } }] },
})
const result = (id: string, text: string, cwd: string) => ({ type: "user", timestamp: at(), cwd, message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }] }] } })
const bgAck = (taskId: string, path: string) => `Command running in background with ID: ${taskId}. Output is being written to: ${path}. You will be notified when it completes.`

test("leadingCd: one literal leading cd moves the start folder; anything cleverer does not", () => {
  const base = "/home/u/repo"
  assert.equal(leadingCd("cd /home/u/repo/packages/web && nubx vite", base), "/home/u/repo/packages/web")
  assert.equal(leadingCd("cd .ntwine/worktrees/x && nub test", base), "/home/u/repo/.ntwine/worktrees/x")
  assert.equal(leadingCd(`cd "packages/web" ; ls`, base), "/home/u/repo/packages/web")
  assert.equal(leadingCd("cd 'a b' && ls", base), "/home/u/repo/a b")
  assert.equal(leadingCd("cd ~/other && ls", base), join(homedir(), "other"))
  assert.equal(leadingCd(`cd "$D" && ls`, base), undefined, "a variable is not a folder we can name")
  assert.equal(leadingCd("cd $(git rev-parse --show-toplevel) && ls", base), undefined)
  assert.equal(leadingCd("cd packages/* && ls", base), undefined)
  assert.equal(leadingCd("cd - && ls", base), undefined)
  assert.equal(leadingCd("cd packages/web", base), undefined, "a cd with nothing after it starts nothing there")
  assert.equal(leadingCd("npm test && cd x", base), undefined, "only a LEADING cd")
  assert.equal(leadingCd("cd x && ls", undefined), undefined)
})

test("a background shell's start folder rides its view; the thread's checkout flips on the move into a worktree", () => {
  const w = world()
  try {
    w.append(user(w.project), bash("toolu_a", "npm run dev", w.project), result("toolu_a", bgAck("ba", "/nowhere/tasks/ba.output"), w.project))
    w.tailer.tick()
    let tele = w.tailer.get("t")!
    assert.deepEqual(tele.bgShells.map((s) => [s.id, s.cwd, s.checkout]), [["toolu_a", w.project, undefined]], "a shell in the root carries its folder and no checkout hint")
    assert.equal(tele.workingDir, w.project, "the fold has a reading: the project root")
    assert.equal(tele.checkout, undefined, "and the root draws nothing")

    // Isolate the SIGNATURE: a bookkeeping record that carries only `cwd` moves no clock, no turn and
    // no preview, so whatever the board hears about it is the checkout alone. (Every record type in a
    // real transcript carries `cwd`; an `attachment` is one of the quiet ones.)
    const moveTo = (cwd: string) => ({ type: "attachment", cwd, attachment: { type: "hook_success" } })
    // A `cd packages/web` lifts to the same checkout: no board delta for it.
    const before = w.changes.n
    w.append(moveTo(join(w.project, "packages", "web")))
    w.tailer.tick()
    assert.equal(w.tailer.get("t")!.checkout, undefined)
    assert.equal(w.changes.n, before, "moving within the root does not change the board")

    // EnterWorktree / a `cd` into the worktree: every later record carries its folder.
    w.append(moveTo(join(w.worktree, "src")))
    w.tailer.tick()
    tele = w.tailer.get("t")!
    assert.deepEqual(tele.checkout, { dir: w.worktree, kind: "worktree" })
    assert.equal(tele.workingDir, w.worktree)
    assert.equal(w.changes.n, before + 1, "the move into a worktree is exactly one board change")

    // The next shell starts there, and says so; the first one still says the root.
    w.append(bash("toolu_b", "nub test --watch", join(w.worktree, "src")), result("toolu_b", bgAck("bb", "/nowhere/tasks/bb.output"), join(w.worktree, "src")))
    w.tailer.tick()
    tele = w.tailer.get("t")!
    assert.deepEqual(tele.bgShells.map((s) => [s.id, s.cwd, s.checkout?.kind]), [["toolu_a", w.project, undefined], ["toolu_b", join(w.worktree, "src"), "worktree"]])
  } finally {
    w.cleanup()
  }
})

test("a sub-agent's record elsewhere is not where the thread is", () => {
  const w = world()
  try {
    w.append(user(w.project), user(w.worktree, { isSidechain: true }))
    w.tailer.tick()
    assert.equal(w.tailer.get("t")!.workingDir, w.project)
    assert.equal(w.tailer.get("t")!.checkout, undefined)
  } finally {
    w.cleanup()
  }
})

test("a leading literal cd sets the start folder; `cd \"$D\"` keeps the session's", () => {
  const w = world()
  try {
    w.append(
      user(w.project),
      bash("toolu_cd", "cd .ntwine/worktrees/probe && nub test", w.project),
      result("toolu_cd", bgAck("bc", "/nowhere/tasks/bc.output"), w.project),
      bash("toolu_var", `cd "$D" && nub test`, w.project),
      result("toolu_var", bgAck("bv", "/nowhere/tasks/bv.output"), w.project),
    )
    w.tailer.tick()
    const shells = w.tailer.get("t")!.bgShells
    assert.deepEqual(shells.find((s) => s.id === "toolu_cd")?.cwd, w.worktree)
    assert.deepEqual(shells.find((s) => s.id === "toolu_cd")?.checkout, { dir: w.worktree, kind: "worktree" })
    assert.equal(shells.find((s) => s.id === "toolu_var")?.cwd, w.project)
    assert.equal(shells.find((s) => s.id === "toolu_var")?.checkout, undefined)
  } finally {
    w.cleanup()
  }
})

test("an auto-backgrounded foreground Bash keeps the folder its CALL started in", () => {
  const w = world()
  try {
    w.append(
      user(w.project),
      bash("toolu_fg", "nub test", w.worktree, false),
      // The result record is written after the session has moved on — it is the CALL's folder that counts.
      result("toolu_fg", "Command did not complete within its 5s timeout and was moved to the background (ID: bfg). Output is being written to: /nowhere/tasks/bfg.output. You will be notified when it completes.", w.project),
    )
    w.tailer.tick()
    const shell = w.tailer.get("t")!.bgShells.find((s) => s.id === "toolu_fg")
    assert.equal(shell?.cwd, w.worktree)
    assert.equal(shell?.checkout?.kind, "worktree")
  } finally {
    w.cleanup()
  }
})

test("a finished shell keeps its start folder for an open drawer", () => {
  const w = world()
  try {
    w.append(
      user(w.project),
      bash("toolu_done", "nub test", w.worktree),
      result("toolu_done", bgAck("bd", "/nowhere/tasks/bd.output"), w.worktree),
      { type: "queue-operation", operation: "enqueue", timestamp: at(), content: "<task-notification>\n<task-id>bd</task-id>\n<tool-use-id>toolu_done</tool-use-id>\n<status>completed</status>\n<summary>done</summary>\n</task-notification>" },
    )
    w.tailer.tick()
    assert.deepEqual(w.tailer.get("t")!.bgShells, [], "it has left every live surface")
    assert.deepEqual(w.tailer.backgroundShell?.("t", "toolu_done"), { command: "nub test", outputNamed: true, state: "done", cwd: w.worktree })
  } finally {
    w.cleanup()
  }
})

test("a Monitor's log is found beside the session's Bash logs, and only once it exists", () => {
  const w = world()
  try {
    const tasks = join(w.root, "claude-1000", "-repo", "sid", "tasks")
    mkdirSync(tasks, { recursive: true })
    writeFileSync(join(tasks, "bsh.output"), "bash output\n")
    w.append(
      user(w.project),
      // A Monitor's ack names its task and no path.
      monitor("toolu_mon", w.project),
      result("toolu_mon", "Monitor started (task bmon1, timeout 3600000ms). You will be notified on each event.", w.project),
    )
    w.tailer.tick()
    assert.deepEqual(w.tailer.backgroundShell?.("t", "toolu_mon"), { command: "tail -f log", state: "running", monitor: true, cwd: w.project }, "no Bash ack yet: nowhere to look")
    // A Bash ack teaches the session's task directory…
    w.append(bash("toolu_sh", "npm run dev", w.project), result("toolu_sh", bgAck("bsh", join(tasks, "bsh.output")), w.project))
    w.tailer.tick()
    assert.equal(w.tailer.backgroundShell?.("t", "toolu_mon")?.outputFile, undefined, "…but the Monitor's candidate must exist before it is read")
    // Not NAMED either: no ack gave this path, and a Monitor that has printed nothing may simply not have
    // written its file yet — the drawer says "waiting", not "the output file is gone".
    assert.equal(w.tailer.backgroundShell?.("t", "toolu_mon")?.outputNamed, undefined)
    writeFileSync(join(tasks, "bmon1.output"), "event 1\n")
    assert.equal(w.tailer.backgroundShell?.("t", "toolu_mon")?.outputFile, join(tasks, "bmon1.output"))
    assert.equal(w.tailer.backgroundShell?.("t", "toolu_sh")?.outputFile, join(tasks, "bsh.output"))
  } finally {
    w.cleanup()
  }
})

test("codex: a tool call's workdir is the agent's folder — absolute, or relative to the project", () => {
  const s = newTailState("t", "sid", "/x")
  applyEvent(s, { kind: "tool-call", at: "2026-07-01T00:00:01.000Z", id: "c1", name: "exec_command", input: { cmd: "ls", workdir: "/repo/.ntwine/worktrees/a" } })
  assert.equal(s.cwd, "/repo/.ntwine/worktrees/a")
  applyEvent(s, { kind: "tool-call", at: "2026-07-01T00:00:02.000Z", id: "c2", name: "exec_command", input: { cmd: "ls", workdir: "packages/web" } })
  assert.equal(s.cwd, "packages/web", "kept raw — the tailer resolves it against the project")
  applyEvent(s, { kind: "tool-call", at: "2026-07-01T00:00:03.000Z", id: "c3", name: "apply_patch", input: "*** Begin Patch" })
  assert.equal(s.cwd, "packages/web", "a call naming no folder moves nothing")
})

test("the OS outranks the transcript on where a running shell is — the batch-stamped cwd case", () => {
  // MEASURED 2026-09-29 on a real haiku worker: it started a shell in the root, then `git worktree add
  // … && cd` into the worktree, and the harness wrote that whole turn's records at once, every one
  // stamped with the worktree. So the fold says worktree; the shell's process is in the root.
  const asked: string[] = []
  let os: string | undefined
  const w = world({ shellCwd: (file) => (asked.push(file), os) })
  os = w.project
  try {
    const file = "/nowhere/tasks/bm.output"
    w.append(user(w.project), bash("toolu_main", "npm run dev", w.worktree), result("toolu_main", bgAck("bm", file), w.worktree))
    w.tailer.tick()
    const before = w.changes.n
    let [row] = w.tailer.get("t")!.bgShells
    assert.equal(row?.cwd, w.project, "the process's folder, not the batch's stamp")
    assert.equal(row?.checkout, undefined, "so no worktree hint on a root shell")
    assert.deepEqual(asked, [file])
    // Asked once: the answer is kept, and written onto the entry the drawer's lookup reads.
    w.tailer.tick()
    ;[row] = w.tailer.get("t")!.bgShells
    assert.equal(row?.cwd, w.project)
    assert.deepEqual(asked, [file], "one OS question per shell, not one per tick")
    assert.equal(w.tailer.backgroundShell?.("t", "toolu_main")?.cwd, w.project)
    assert.equal(w.changes.n, before, "a settled reading moves nothing")
    // And it outlives the shell: the retired ring carries the corrected folder.
    w.append({ type: "queue-operation", operation: "enqueue", timestamp: at(), content: "<task-notification>\n<task-id>bm</task-id>\n<tool-use-id>toolu_main</tool-use-id>\n<status>completed</status>\n<summary>done</summary>\n</task-notification>" })
    w.tailer.tick()
    assert.equal(w.tailer.backgroundShell?.("t", "toolu_main")?.cwd, w.project)
  } finally {
    w.cleanup()
  }
})

// "RUNS IN" IS WHERE IT IS NOW. A running shell's folder was asked once and kept for the shell's life, so a
// `cd` the command made later, or one bad sample, stood forever. It is asked again once a minute while the
// shell runs; the last answer stands in between.
test("a running shell's folder is asked again after a minute, and a move is seen", () => {
  let clock = Date.parse("2026-07-01T00:01:00.000Z")
  const asked: string[] = []
  let os: string | undefined
  const w = world({ shellCwd: (file) => (asked.push(file), os), deps: { now: () => clock } })
  os = w.project
  try {
    const file = "/nowhere/tasks/bc.output"
    w.append(user(w.project), bash("toolu_cd", "npm run dev", w.project), result("toolu_cd", bgAck("bc", file), w.project))
    w.tailer.tick()
    assert.equal(w.tailer.get("t")!.bgShells[0]?.cwd, w.project)
    // The command moved into the worktree. Within the minute, nothing asks.
    os = w.worktree
    clock += 30_000
    w.tailer.tick()
    assert.equal(w.tailer.get("t")!.bgShells[0]?.cwd, w.project)
    assert.equal(asked.length, 1)
    clock += 31_000
    w.tailer.tick()
    const [row] = w.tailer.get("t")!.bgShells
    assert.equal(asked.length, 2, "asked again once the reading is a minute old")
    assert.equal(row?.cwd, w.worktree, "the move is seen")
    assert.equal(row?.checkout?.kind, "worktree")
    // No answer on a later ask (the shell is ending) leaves the last reading, not the transcript's.
    os = undefined
    clock += 61_000
    w.tailer.tick()
    assert.equal(w.tailer.get("t")!.bgShells[0]?.cwd, w.worktree)
  } finally {
    w.cleanup()
  }
})

// THE FOLD STAYS THE TRANSCRIPT'S. The tail cache persists folded states as a pure function of the
// transcript's bytes, and a retired shell is never probed again — so an OS answer written onto the entry
// rode into the retired ring and the cache, and a cached boot then told a different folder from a cold one.
test("the OS's answer is read beside the fold, and never persisted as part of it", () => {
  const puts: { state: string }[] = []
  const tailCache = { load: () => new Map(), put: (entries: { state: string }[]) => void puts.push(...entries), prune: () => {} }
  let os: string | undefined
  const w = world({ shellCwd: () => os, deps: { tailCache: tailCache as never } })
  os = w.project
  try {
    w.append(user(w.project), bash("toolu_main", "npm run dev", w.worktree), result("toolu_main", bgAck("bm", "/nowhere/tasks/bm.output"), w.worktree))
    w.tailer.tick()
    assert.equal(w.tailer.get("t")!.bgShells[0]?.cwd, w.project, "the row reads the OS")
    w.append({ type: "queue-operation", operation: "enqueue", timestamp: at(), content: "<task-notification>\n<task-id>bm</task-id>\n<tool-use-id>toolu_main</tool-use-id>\n<status>completed</status>\n<summary>done</summary>\n</task-notification>" })
    w.tailer.tick()
    assert.equal(w.tailer.backgroundShell?.("t", "toolu_main")?.cwd, w.project, "so does the retired shell's drawer, in this process")
    w.tailer.stop()
    const cached = puts.at(-1)?.state ?? ""
    assert.ok(cached.includes('"toolu_main"'), "the retired shell was persisted")
    assert.ok(cached.includes(`"cwd":${JSON.stringify(w.worktree)}`), "with the transcript's own reading")
    const retired = /"retiredShells":\{"__map":\[\["toolu_main",(\{[^}]*\})/.exec(cached)?.[1] ?? ""
    assert.match(retired, new RegExp(`"cwd":${JSON.stringify(w.worktree).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}`), "the ring keeps the transcript's folder")
  } finally {
    w.cleanup()
  }
})

// THE BATCHED PROBE, which the inline `shellCwd` seam above skips. A shell that asks while a probe is in
// flight lands in the wanted set, its own flush returns into the in-flight guard, and every later ask sees
// it already wanted — so nothing asked for it again until some unrelated shell arrived. The probe's own
// settle has to re-arm for whatever queued behind it.
test("a shell that asks while a folder probe is in flight is probed when that probe settles", async () => {
  const calls: string[][] = []
  const pending: Array<(answer: Map<string, string | undefined>) => void> = []
  const w = world({
    deps: {
      probeShellCwds: (files) => {
        calls.push([...files])
        return new Promise((resolve) => pending.push(resolve))
      },
      shellAlive: () => undefined, // keep the real lsof liveness probe out of this
    },
  })
  const macrotask = () => new Promise((resolve) => setTimeout(resolve, 5))
  try {
    const tasks = join(w.root, "claude-1000", "-repo", "sid", "tasks")
    mkdirSync(tasks, { recursive: true })
    writeFileSync(join(tasks, "b1.output"), "")
    writeFileSync(join(tasks, "b2.output"), "")
    w.append(user(w.project), bash("toolu_1", "npm run dev", w.worktree), result("toolu_1", bgAck("b1", join(tasks, "b1.output")), w.worktree))
    w.tailer.tick()
    await macrotask()
    assert.deepEqual(calls, [[join(tasks, "b1.output")]], "the first shell is asked about")
    // A second shell arrives while that probe is still out.
    w.append(bash("toolu_2", "nub test --watch", w.worktree), result("toolu_2", bgAck("b2", join(tasks, "b2.output")), w.worktree))
    w.tailer.tick()
    await macrotask()
    w.tailer.tick()
    await macrotask()
    assert.equal(calls.length, 1, "one probe at a time")
    pending.shift()!(new Map([[join(tasks, "b1.output"), w.project]]))
    await macrotask()
    assert.ok(calls[1]?.includes(join(tasks, "b2.output")), "the shell that queued behind it is asked about as soon as it settles")
    pending.shift()!(new Map([[join(tasks, "b2.output"), w.project]]))
    await macrotask()
    w.tailer.tick()
    const rows = w.tailer.get("t")!.bgShells
    assert.deepEqual(rows.map((r) => [r.id, r.cwd, r.checkout]), [["toolu_1", w.project, undefined], ["toolu_2", w.project, undefined]], "both carry the OS's folder")
  } finally {
    w.cleanup()
  }
})

test("no OS answer leaves the transcript's reading, and the question is not asked forever", () => {
  const asked: string[] = []
  const w = world({ shellCwd: (file) => (asked.push(file), undefined) })
  try {
    w.append(user(w.project), bash("toolu_w", "nub test --watch", w.worktree), result("toolu_w", bgAck("bw", "/nowhere/tasks/bw.output"), w.worktree))
    for (let i = 0; i < 6; i++) w.tailer.tick()
    const [row] = w.tailer.get("t")!.bgShells
    assert.equal(row?.cwd, w.worktree)
    assert.equal(row?.checkout?.kind, "worktree")
    assert.ok(asked.length >= 1 && asked.length <= 3, `a bounded number of asks, got ${asked.length}`)
  } finally {
    w.cleanup()
  }
})
