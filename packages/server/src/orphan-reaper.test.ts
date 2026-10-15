import { test } from "node:test"
import assert from "node:assert/strict"
import { setTimeout as delay } from "node:timers/promises"
import {
  firstTokenBasename,
  isSessionRoot,
  isTmuxServer,
  isTerminalDaemon,
  decideOrphans,
  selfAndAncestors,
  subtreeKillOrder,
  parseEtimeMs,
  enumerateProcs,
  parseCpuTimeMs,
  detectRunawayAux,
  summarizeRunaways,
  reapSubtrees,
  sweepOrphansOnce,
  startOrphanReaper,
  acquireSharedOrphanReaper,
  type ProcRow,
  type Exec,
} from "./orphan-reaper.ts"

const OLD = 10 * 60_000 // comfortably past the age guard
const ORPHAN_GUARD = 120_000

function row(p: Partial<ProcRow> & { pid: number }): ProcRow {
  return { ppid: 1, ageMs: OLD, command: "node x", slug: null, ...p }
}

test("firstTokenBasename strips path and args", () => {
  assert.equal(firstTokenBasename("/usr/bin/node --foo bar"), "node")
  assert.equal(firstTokenBasename("claude --session-id abc"), "claude")
  assert.equal(firstTokenBasename("  /a/b/Google Chrome for Testing --x"), "Google")
  assert.equal(firstTokenBasename(""), "")
})

test("isSessionRoot: claude/codex binary or --session-id anywhere", () => {
  assert.ok(isSessionRoot("claude --session-id abc"))
  assert.ok(isSessionRoot("/opt/claude"))
  assert.ok(isSessionRoot("codex --cd /x -m gpt"))
  assert.ok(isSessionRoot("node /path/cli.js --session-id zzz")) // node-launched agent
  assert.ok(!isSessionRoot("node /path/chrome-devtools-mcp"))
  assert.ok(!isSessionRoot("Google Chrome for Testing --remote-debugging-port=0"))
})

test("isTmuxServer matches only a leftover pre-cutover tmux binary", () => {
  assert.ok(isTmuxServer("tmux -L ntwine-repo-x new-session -d"))
  assert.ok(!isTmuxServer("node tmux-thing"))
})

test("decideOrphans: reap aux whose slug has no live root; keep everything protected", () => {
  const rows: ProcRow[] = [
    row({ pid: 100, command: "claude --session-id A", slug: "alpha" }), // live root alpha
    row({ pid: 101, command: "node chrome-devtools-mcp", slug: "alpha" }), // aux of LIVE alpha → keep
    row({ pid: 200, command: "Google Chrome for Testing --remote-debugging-port=0", slug: "beta" }), // aux, dead beta → REAP
    row({ pid: 201, command: "node --watch server.js", slug: "beta" }), // aux, dead beta → REAP
    row({ pid: 300, command: "codex --cd /x", slug: "gamma" }), // a session root with no aux; dead-ish but NEVER reaped
    row({ pid: 400, command: "tmux -L ntwine-repo-x new-session", slug: "delta" }), // a pre-cutover leftover, dead → keep
  ]
  const { reap, liveSlugs } = decideOrphans(rows, { minAgeMs: ORPHAN_GUARD, protectedPids: new Set() })
  assert.deepEqual([...reap].sort((a, b) => a - b), [200, 201])
  assert.deepEqual([...liveSlugs].sort(), ["alpha", "gamma"])
})

test("a thread terminal's daemon and its pty are never reaped, even under a dead thread's tag", () => {
  const daemon = "/usr/bin/node /x/packages/server/src/backend/terminal-daemon.ts"
  assert.ok(isTerminalDaemon(daemon))
  assert.ok(isTerminalDaemon("node /artifact/runtime/src/terminal-daemon.js"))
  assert.ok(!isTerminalDaemon("node my-terminal-daemon.tsx"))
  const rows: ProcRow[] = [
    row({ pid: 200, command: daemon, slug: "beta" }), // tagged by a stray env, dead slug → still kept
    row({ pid: 210, ppid: 200, command: "/bin/sh -l -c npm run dev", slug: "beta" }),
    row({ pid: 300, command: "node mcp", slug: "beta" }), // genuine aux of the dead thread → reaped
    row({ pid: 310, ppid: 300, command: daemon, slug: "beta" }), // a daemon nested under a target is spared
  ]
  const { reap } = decideOrphans(rows, { minAgeMs: ORPHAN_GUARD, protectedPids: new Set() })
  assert.deepEqual(reap, [300])
  const killed: number[] = []
  reapSubtrees(reap, rows, new Set(), new Set(), (pid) => killed.push(pid))
  assert.deepEqual(killed, [300])
})

test("decideOrphans: age guard spares just-spawned aux", () => {
  const rows: ProcRow[] = [
    row({ pid: 200, ageMs: 5_000, command: "Google Chrome for Testing --x", slug: "beta" }), // fresh → keep
    row({ pid: 201, ageMs: OLD, command: "Google Chrome for Testing --x", slug: "beta" }), // old → reap
  ]
  const { reap } = decideOrphans(rows, { minAgeMs: ORPHAN_GUARD, protectedPids: new Set() })
  assert.deepEqual(reap, [201])
})

test("decideOrphans: protected pids (self/ancestors) are never reaped", () => {
  const rows: ProcRow[] = [row({ pid: 200, command: "node orphan.js", slug: "beta" })]
  const { reap } = decideOrphans(rows, { minAgeMs: ORPHAN_GUARD, protectedPids: new Set([200]) })
  assert.deepEqual(reap, [])
})

test("decideOrphans: a dead slug shared with a still-live root elsewhere is kept (never false-kill)", () => {
  // Same slug string owned by a live root — its aux must survive even if another proc has it too.
  const rows: ProcRow[] = [
    row({ pid: 100, command: "claude --session-id X", slug: "shared" }),
    row({ pid: 101, command: "node agent-browser", slug: "shared" }),
  ]
  const { reap } = decideOrphans(rows, { minAgeMs: ORPHAN_GUARD, protectedPids: new Set() })
  assert.deepEqual(reap, [])
})

test("selfAndAncestors walks the parent chain", () => {
  const rows: ProcRow[] = [
    row({ pid: 10, ppid: 1 }),
    row({ pid: 20, ppid: 10 }),
    row({ pid: 30, ppid: 20 }),
  ]
  // includes the terminal ppid (1); harmless — protecting a pid only means "never reap it"
  assert.deepEqual([...selfAndAncestors(rows, 30)].sort((a, b) => a - b), [1, 10, 20, 30])
})

test("selfAndAncestors tolerates cycles", () => {
  const rows: ProcRow[] = [row({ pid: 10, ppid: 20 }), row({ pid: 20, ppid: 10 })]
  const set = selfAndAncestors(rows, 10)
  assert.ok(set.has(10) && set.has(20))
})

test("subtreeKillOrder: leaves before parents, drops kept procs", () => {
  const rows: ProcRow[] = [
    row({ pid: 100, ppid: 1, command: "node mcp", slug: "beta" }),
    row({ pid: 110, ppid: 100, command: "Chrome main", slug: "beta" }),
    row({ pid: 120, ppid: 110, command: "Chrome renderer", slug: "beta" }),
    row({ pid: 130, ppid: 100, command: "claude --session-id keepme", slug: "gamma" }), // must be dropped
  ]
  const keep = (r: ProcRow) => isSessionRoot(r.command)
  const order = subtreeKillOrder([100], rows, keep)
  assert.ok(!order.includes(130), "live session root nested under a target is never killed")
  // deepest first: 120 before 110 before 100
  assert.ok(order.indexOf(120) < order.indexOf(110))
  assert.ok(order.indexOf(110) < order.indexOf(100))
  assert.deepEqual([...order].sort((a, b) => a - b), [100, 110, 120])
})

test("parseEtimeMs handles all ps formats", () => {
  assert.equal(parseEtimeMs("05"), 5_000)
  assert.equal(parseEtimeMs("01:30"), 90_000)
  assert.equal(parseEtimeMs("02:00:00"), 2 * 3600_000)
  assert.equal(parseEtimeMs("3-04:00:00"), (3 * 24 + 4) * 3600_000)
  assert.equal(parseEtimeMs("garbage"), 0)
  assert.equal(parseEtimeMs(""), 0)
})

// ---- enumeration + reap with a fake `ps` ----------------------------------------------------------

function fakePs(base: string, env: string): Exec {
  return (file, args) => {
    assert.equal(file, "ps")
    if (args.includes("-Eww")) return env
    return base
  }
}

test("enumerateProcs joins argv pass with env pass, slug from the ENV segment only", async () => {
  const base = [
    "  100        1 10:00 claude --session-id A",
    "  200      100 09:00 Google Chrome for Testing --remote-debugging-port=0",
    // A leftover tmux server carries a NTWINE_THREAD literal in ARGV (the `-e` flag); its OWN env has a different one
    "  400        1 20:00 tmux -L ntwine-repo-x new-session -d -e NTWINE_THREAD=argvslug",
  ].join("\n")
  const env = [
    "100 claude --session-id A NTWINE_THREAD=alpha",
    "200 Google Chrome for Testing --remote-debugging-port=0 NTWINE_THREAD=alpha",
    "400 tmux -L ntwine-repo-x new-session -d -e NTWINE_THREAD=argvslug HOME=/x NTWINE_THREAD=envslug",
  ].join("\n")
  const procs = await enumerateProcs(fakePs(base, env), { platform: "darwin" })
  const byPid = new Map(procs.map((p) => [p.pid, p]))
  assert.equal(byPid.get(100)!.slug, "alpha")
  assert.equal(byPid.get(200)!.slug, "alpha")
  assert.equal(byPid.get(400)!.ppid, 1)
  assert.equal(byPid.get(200)!.ageMs, 9 * 60_000)
  // the ENV slug wins over the argv `-e NTWINE_THREAD=argvslug` literal
  assert.equal(byPid.get(400)!.slug, "envslug")
})

test("enumerateProcs: a NTWINE_THREAD literal in a ROOT's argv never overrides its real env slug", async () => {
  // Reproduces the critical mis-attribution: a worker whose task text pasted `NTWINE_THREAD=other`
  // into its argv. Ownership must come from ENV, or the root's real slug would be lost from `live`.
  const base = ["  100 1 10:00 claude --session-id A pasted:NTWINE_THREAD=other-slug"].join("\n")
  const env = ["100 claude --session-id A pasted:NTWINE_THREAD=other-slug NTWINE_THREAD=realroot"].join("\n")
  const procs = await enumerateProcs(fakePs(base, env), { platform: "darwin" })
  assert.equal(procs[0]!.slug, "realroot")
})

test("enumerateProcs: reads the slug across a multiline env value and re-merges false splits", async () => {
  const base = ["  100 1 10:00 node dev.js"].join("\n")
  // env contains a PEM key with newlines, AND a line that starts with a digit+space (a false record
  // boundary that must be re-merged), with the real slug appearing AFTER all of it.
  const env = [
    "100 node dev.js KEY=-----BEGIN-----",
    "500 not-a-real-record continues the KEY value",
    "-----END----- NTWINE_THREAD=realslug",
  ].join("\n")
  const procs = await enumerateProcs(fakePs(base, env), { platform: "darwin" })
  assert.equal(procs[0]!.slug, "realslug")
})

// `ps -o pid=` RIGHT-ALIGNS the pid in a fixed-width column, so every record for a pid narrower than
// that column starts with PADDING. The fixtures above all happen to use flush-left pass-2 lines, which
// is why this went unseen: in production the pass-2 splitter dropped every sub-10000 pid's record into
// its predecessor's, leaving its own slug null. When the pid that lost its slug was a worker's `claude`
// SESSION ROOT, its thread vanished from `live` — and the reaper SIGKILLed that live worker's aux,
// including the adhoc-stack verification servers it had booted. Measured on the maintainer's machine
// 2026-08-19: 3 of 3 session roots with a 4-digit pid unattributed, 34 of 34 with a 5-digit pid fine.
test("enumerateProcs: a pid narrower than ps's right-aligned pid column still gets its slug", async () => {
  const base = [
    "  1154        1 21:44:15 claude --session-id A",
    " 48311     1154 03:00 node scripts/adhoc-stack.mjs --port=48311",
    " 65816     1154 03:00 Google Chrome for Testing --headless",
  ].join("\n")
  // Exactly what `ps -Eww -o pid=,command=` emits: the pid column is 5 wide, so a 5-digit pid is flush
  // left and everything shorter carries leading blanks.
  const env = [
    " 1154 claude --session-id A HOME=/Users/x NTWINE_THREAD=live-worker",
    "48311 node scripts/adhoc-stack.mjs --port=48311 HOME=/tmp/sandbox NTWINE_THREAD=live-worker",
    "65816 Google Chrome for Testing --headless NTWINE_THREAD=live-worker",
  ].join("\n")
  const procs = await enumerateProcs(fakePs(base, env), { platform: "darwin" })
  const byPid = new Map(procs.map((p) => [p.pid, p]))
  assert.equal(byPid.get(1154)!.slug, "live-worker") // the padded record is a record, not a merge artifact
  assert.equal(byPid.get(48311)!.slug, "live-worker")

  // …and the consequence that actually bit: the thread reads LIVE, so its adhoc stack is never reaped.
  const decision = decideOrphans(procs, { minAgeMs: ORPHAN_GUARD, protectedPids: new Set() })
  assert.deepEqual(decision.liveSlugs, ["live-worker"])
  assert.deepEqual(decision.reap, [])
})

test("enumerateProcs: a pid whose pass-2 argv does not match pass-1 (reuse) yields no slug (fail-safe)", async () => {
  const base = ["  100 1 10:00 node real-argv"].join("\n")
  const env = ["100 node DIFFERENT-argv NTWINE_THREAD=whatever"].join("\n") // marker mismatch
  const procs = await enumerateProcs(fakePs(base, env), { platform: "darwin" })
  assert.equal(procs[0]!.slug, null)
})

test("enumerateProcs fails closed when the env pass throws", async () => {
  const exec: Exec = (_file, args) => {
    if (args.includes("-Eww")) throw new Error("boom")
    return "  100 1 10:00 node x"
  }
  const procs = await enumerateProcs(exec, { platform: "darwin" })
  assert.equal(procs.length, 1)
  assert.equal(procs[0]!.slug, null) // no slug → never reaped
})

// ---- Linux: one ps pass + /proc/<pid>/environ (procps rejects `-E` with "unsupported SysV option",
// which is why the env read cannot be a second ps pass there) -----------------------------------------

/** Serves pass 1 only; a second ps call is the regression (the `-Eww` pass Linux rejects). */
function linuxPs(base: string): Exec {
  let calls = 0
  return (file, args) => {
    assert.equal(file, "ps")
    assert.deepEqual(args, ["-Aww", "-o", "pid=,ppid=,etime=,command="])
    assert.equal(++calls, 1, "the linux path must never run a second (env) ps pass")
    return base
  }
}

function environ(entries: Record<number, string[]>): (pid: number) => string | null {
  return (pid) => (entries[pid] ? `${entries[pid]!.join("\0")}\0` : null)
}

test("enumerateProcs (linux): slug from an exact environ entry; a literal inside another value never spoofs", async () => {
  const base = [
    "  100        1 10:00 claude --session-id A",
    "  200      100 09:00 node chrome-devtools-mcp",
    "  300        1 08:00 node bystander.js",
  ].join("\n")
  const procs = await enumerateProcs(
    linuxPs(base),
    {
      platform: "linux",
      readEnv: environ({
        100: ["HOME=/home/x", "NTWINE_THREAD=alpha"],
        // the pasted `NTWINE_THREAD=spoofed` lives INSIDE another variable's value → not an entry
        200: ["TASK_TEXT=note NTWINE_THREAD=spoofed here", "NTWINE_THREAD=alpha"],
        300: ["TASK_TEXT=note NTWINE_THREAD=spoofed here"],
      }),
    },
  )
  const byPid = new Map(procs.map((p) => [p.pid, p]))
  assert.equal(byPid.get(100)!.slug, "alpha")
  assert.equal(byPid.get(200)!.slug, "alpha")
  assert.equal(byPid.get(300)!.slug, null)
  assert.equal(byPid.get(200)!.ageMs, 9 * 60_000)
})

test("enumerateProcs (linux): an unreadable environ (gone, or another user's) leaves the slug null", async () => {
  const base = ["  100 1 10:00 node x"].join("\n")
  const procs = await enumerateProcs(linuxPs(base), { platform: "linux", readEnv: () => null })
  assert.equal(procs.length, 1)
  assert.equal(procs[0]!.slug, null) // no slug → never reaped
})

test("sweepOrphansOnce (linux) end-to-end: reaps dead-slug aux, spares live + self", async () => {
  const base = [
    "  100     1 10:00 claude --session-id A",
    "  101   100 10:00 node chrome-devtools-mcp",
    "  200     1 10:00 chrome --headless",
    "  999     1 10:00 node server.js",
  ].join("\n")
  const killed: number[] = []
  const res = await sweepOrphansOnce({
    exec: linuxPs(base),
    platform: "linux",
    readEnv: environ({
      100: ["NTWINE_THREAD=alpha"],
      101: ["NTWINE_THREAD=alpha"],
      200: ["NTWINE_THREAD=beta"],
      999: ["NTWINE_THREAD=beta"], // self → protected even under a dead slug
    }),
    kill: (pid) => killed.push(pid),
    selfPid: 999,
    minAgeMs: 120_000,
    runawayReport: false, // the runaway pass is a second exec call; linuxPs pins exactly one
  })
  assert.deepEqual(killed, [200])
  assert.equal(res.reaped, 1)
  assert.deepEqual(res.deadSlugs, ["beta"])
  assert.deepEqual(res.liveSlugs, ["alpha"])
})

test("sweepOrphansOnce end-to-end with fakes: reaps dead-slug Chrome, spares live + self", async () => {
  const base = [
    "  100     1 10:00 claude --session-id A",
    "  101   100 10:00 node chrome-devtools-mcp",
    "  200     1 10:00 Google Chrome for Testing --remote-debugging-port=0",
    "  201   200 10:00 Google Chrome Helper (Renderer)",
    "  999     1 10:00 node server.js", // the reaper's own process (self)
  ].join("\n")
  const env = [
    "100 claude --session-id A NTWINE_THREAD=alpha",
    "101 node chrome-devtools-mcp NTWINE_THREAD=alpha",
    "200 Google Chrome for Testing --remote-debugging-port=0 NTWINE_THREAD=beta",
    "201 Google Chrome Helper (Renderer) NTWINE_THREAD=beta",
    "999 node server.js NTWINE_THREAD=beta", // even if tagged beta, it is self → protected
  ].join("\n")
  const killed: number[] = []
  const res = await sweepOrphansOnce({
    exec: fakePs(base, env),
    platform: "darwin",
    kill: (pid) => killed.push(pid),
    selfPid: 999,
    minAgeMs: 120_000,
  })
  assert.deepEqual(killed.sort((a, b) => a - b), [200, 201]) // beta subtree only
  assert.ok(!killed.includes(999), "self never reaped even when tagged with a dead slug")
  assert.ok(!killed.includes(100) && !killed.includes(101), "live alpha kept")
  assert.equal(res.reaped, 2)
  assert.deepEqual(res.deadSlugs, ["beta"])
  assert.deepEqual(res.liveSlugs, ["alpha"])
})

test("sweepOrphansOnce: a live root whose argv holds a stray NTWINE_THREAD literal never gets its aux reaped", async () => {
  // The critical false-kill regression: root's REAL slug is `realthread` (env); its argv also contains
  // a pasted `NTWINE_THREAD=spoofed`. If ownership were read from argv, `realthread` would look dead
  // and the live aux (101) would be reaped mid-verification. It must not be.
  const base = [
    "  100 1 10:00 claude --session-id A note:NTWINE_THREAD=spoofed",
    "  101 100 10:00 node chrome-devtools-mcp",
  ].join("\n")
  const env = [
    "100 claude --session-id A note:NTWINE_THREAD=spoofed NTWINE_THREAD=realthread",
    "101 node chrome-devtools-mcp NTWINE_THREAD=realthread",
  ].join("\n")
  const killed: number[] = []
  const res = await sweepOrphansOnce({ exec: fakePs(base, env), platform: "darwin", kill: (p) => killed.push(p), selfPid: 999, minAgeMs: 120_000 })
  assert.deepEqual(killed, [], "no aux reaped — realthread is live via its root")
  assert.deepEqual(res.liveSlugs, ["realthread"])
})

test("reapSubtrees never signals a protected or live-slug pid even if seeded", () => {
  const rows: ProcRow[] = [
    row({ pid: 200, ppid: 1, command: "node x", slug: "beta" }),
    row({ pid: 201, ppid: 200, command: "claude --session-id L", slug: "live" }),
  ]
  const killed: number[] = []
  reapSubtrees([200], rows, new Set(), new Set(["live"]), (p) => killed.push(p))
  assert.deepEqual(killed, [200]) // 201 is a session root → dropped
})

// ---- Runaway detection (report-only; the reaper never kills a LIVE thread's work) ----

test("parseCpuTimeMs handles ps's [dd-]hh:mm:ss[.ff] accumulated-CPU format", () => {
  assert.equal(parseCpuTimeMs("0:00.50"), 500)
  assert.equal(parseCpuTimeMs("1:30"), 90_000)
  assert.equal(parseCpuTimeMs("2:03:04"), (2 * 3600 + 3 * 60 + 4) * 1000)
  assert.equal(parseCpuTimeMs("1-00:00:00"), 86_400_000)
  assert.equal(parseCpuTimeMs("garbage"), 0, "unparseable is 0, so it can never be reported")
  assert.equal(parseCpuTimeMs(""), 0)
})

test("detectRunawayAux names a LIVE thread's long-burning aux, and nothing else", async () => {
  const HOUR = 3_600_000
  const rows: ProcRow[] = [
    // the runaway: 2h old, 1.9h of CPU ⇒ ~0.95 cores sustained
    { pid: 10, ppid: 1, ageMs: 2 * HOUR, command: "node build.js", slug: "busy" },
    // the agent itself — never a runaway, it is the thing the operator asked for
    { pid: 11, ppid: 1, ageMs: 2 * HOUR, command: "claude --session-id A", slug: "busy" },
    // a healthy aux: same age, almost no CPU
    { pid: 12, ppid: 11, ageMs: 2 * HOUR, command: "node watch.js", slug: "busy" },
    // busy but far too young to judge
    { pid: 13, ppid: 11, ageMs: 60_000, command: "node quick.js", slug: "busy" },
    // busy, but its thread is DEAD — that is the reaper's business, not this report's
    { pid: 14, ppid: 1, ageMs: 2 * HOUR, command: "node zombie.js", slug: "gone" },
    // untagged: not ours
    { pid: 15, ppid: 1, ageMs: 2 * HOUR, command: "node someone-else.js", slug: null },
  ]
  const cpu = ["10 1:54:00", "11 1:54:00", "12 0:03.00", "13 0:59.00", "14 1:54:00", "15 1:54:00"].join("\n")
  const out = await detectRunawayAux(rows, new Set(["busy"]), () => cpu)
  assert.deepEqual(out.map((r) => r.pid), [10])
  assert.ok(out[0].cores > 0.9 && out[0].cores < 1.0, `cores was ${out[0].cores}`)
})

test("detectRunawayAux fails silent when ps is unavailable — telemetry never perturbs the sweep", async () => {
  const rows: ProcRow[] = [{ pid: 1, ppid: 0, ageMs: 9_999_999, command: "node x.js", slug: "s" }]
  assert.deepEqual(await detectRunawayAux(rows, new Set(["s"]), () => { throw new Error("no ps") }), [])
})

test("summarizeRunaways reports per THREAD, summing cores, worst first", () => {
  const HOUR = 3_600_000
  const lines = summarizeRunaways([
    { pid: 1, slug: "hot", ageMs: 4 * HOUR, cpuMs: 4 * HOUR, cores: 1 },
    { pid: 2, slug: "hot", ageMs: 2 * HOUR, cpuMs: 2 * HOUR, cores: 1 },
    { pid: 3, slug: "warm", ageMs: 1 * HOUR, cpuMs: 0.6 * HOUR, cores: 0.6 },
  ])
  assert.equal(lines.length, 2, "one line per thread, not per process")
  assert.match(lines[0], /thread "hot" is holding ~2\.0 core\(s\) across 2 background process\(es\), oldest 4\.0h/)
  assert.match(lines[1], /thread "warm"/)
})

// ---- Where the reaper cannot run, it says so ONCE and stays off (Windows audit 2026-09-11, finding 6) --

test("startOrphanReaper on win32: one clear log line, no ps, no interval", () => {
  const log: string[] = []
  const stop = startOrphanReaper({ platform: "win32", intervalMs: 1, log: (m) => log.push(m), exec: () => { throw new Error("must not run ps on win32") } })
  stop()
  assert.equal(log.length, 1)
  assert.match(log[0]!, /^orphan-reaper: unavailable on Windows — .*not collected here/u)
})

test("sweepOrphansOnce: `ps` missing (ENOENT) is reported as unavailable; any other failure is one closed sweep", async () => {
  const enoent: Exec = () => { throw Object.assign(new Error("spawnSync ps ENOENT"), { code: "ENOENT" }) }
  assert.deepEqual(await sweepOrphansOnce({ exec: enoent, platform: "darwin" }), { reaped: 0, deadSlugs: [], liveSlugs: [], unavailable: "`ps` is not on PATH" })
  const timeout: Exec = () => { throw Object.assign(new Error("spawnSync ps ETIMEDOUT"), { code: "ETIMEDOUT" }) }
  assert.deepEqual(await sweepOrphansOnce({ exec: timeout, platform: "darwin" }), { reaped: 0, deadSlugs: [], liveSlugs: [] })
})

test("startOrphanReaper on a POSIX box without ps: the first sweep says so and the interval never starts", async () => {
  // Until 2026-09-11 this was `spawn ps ENOENT` swallowed once a minute forever, with nothing in the log.
  const log: string[] = []
  let calls = 0
  const enoent: Exec = () => { calls++; throw Object.assign(new Error("spawnSync ps ENOENT"), { code: "ENOENT" }) }
  const stop = startOrphanReaper({ platform: "darwin", intervalMs: 2, log: (m) => log.push(m), exec: enoent })
  await delay(30)
  stop()
  assert.equal(calls, 1, "ps was tried once, not once per interval tick")
  assert.deepEqual(log, ["orphan-reaper: unavailable on this machine — `ps` is not on PATH; background processes a stopped thread leaves behind are not collected here"])

  // Control: a ps that merely times out keeps the interval alive (the failure is this sweep's alone).
  let ticks = 0
  const flaky: Exec = () => { ticks++; throw Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" }) }
  const stopFlaky = startOrphanReaper({ platform: "darwin", intervalMs: 2, exec: flaky, log: (m) => log.push(m) })
  await delay(30)
  stopFlaky()
  assert.ok(ticks > 2, `the interval kept sweeping (${ticks} ticks)`)
  assert.equal(log.length, 1, "and said nothing more")
})

// Until 2026-09-30 every `ps` pass was execFileSync inside the server's event loop, and every project's
// context started its own reaper: 22 projects, 22 machine-wide sweeps a minute, the loop blocked ~95% of
// the time and a pin took seconds to land. These pin the three properties that fixed it.

test("sweepOrphansOnce yields the event loop while ps runs", async () => {
  let ticked = false
  const slowPs: Exec = async () => {
    await delay(20)
    return ""
  }
  const sweep = sweepOrphansOnce({ exec: slowPs, platform: "darwin" })
  setImmediate(() => { ticked = true })
  await delay(5)
  assert.equal(ticked, true, "a timer callback ran while the sweep was still waiting on ps")
  assert.deepEqual(await sweep, { reaped: 0, deadSlugs: [], liveSlugs: [] })
})

test("startOrphanReaper never runs a second sweep while one is still in flight", async () => {
  let inFlight = 0
  let maxInFlight = 0
  let calls = 0
  const slowPs: Exec = async () => {
    calls++
    maxInFlight = Math.max(maxInFlight, ++inFlight)
    await delay(15)
    inFlight--
    return ""
  }
  const stop = startOrphanReaper({ platform: "darwin", intervalMs: 1, exec: slowPs })
  await delay(80)
  stop()
  assert.ok(calls >= 2, `the interval kept sweeping (${calls} ps calls)`)
  assert.equal(maxInFlight, 1, "sweeps are serialized, not stacked on a 1ms interval")
})

test("acquireSharedOrphanReaper: N projects share ONE reaper, which stops when the last one releases", async () => {
  let calls = 0
  const countingPs: Exec = () => {
    calls++
    return ""
  }
  const deps = { platform: "darwin" as const, intervalMs: 5, exec: countingPs }
  const releases = Array.from({ length: 5 }, () => acquireSharedOrphanReaper(deps))
  await delay(60)
  // One reaper at a 5ms interval sweeps at most ~13 times in 60ms (one `ps` each — no rows, no env
  // pass); five independent ones would have made ~65 calls.
  assert.ok(calls >= 2 && calls <= 20, `one reaper's worth of sweeps, got ${calls} ps calls`)
  for (const release of releases.slice(0, 4)) release()
  releases[0]!() // a double release is a no-op, not a second decrement
  const beforeLast = calls
  await delay(30)
  assert.ok(calls > beforeLast, "still sweeping while one project holds it")
  releases[4]!()
  await delay(5)
  const afterStop = calls
  await delay(30)
  assert.equal(calls, afterStop, "the last release stopped it")
})
