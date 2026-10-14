import assert from "node:assert/strict"
import { test } from "node:test"
import {
  groupThreadTrees, hibernatedThreads, readoutChain, isBrokerDaemon, parseMeminfo, renderTop, rowsFromBoards, serverTree, sessionIdOf,
  sizeLabel, swapInRate, type ProjectBoard, type TopProc, type TopReading,
} from "./top.ts"
import { classifyUnownedBrokers } from "./unowned-brokers.ts"

const MIN = 60_000
const BROKER = "/usr/bin/node /home/u/ntwine/packages/server/src/backend/claude-agent-broker.ts"
const CLAUDE = (flag: string) => `/home/u/.cache/ntwine/runtimes/claude/2.1.293/claude --output-format stream-json ${flag} --mcp-config /tmp/x.json`
const SID_A = "aaaaaaaa-1111-4111-8111-111111111111"
const SID_B = "bbbbbbbb-2222-4222-8222-222222222222"
const SID_LONE = "cccccccc-3333-4333-8333-333333333333"

const p = (pid: number, ppid: number, command: string, rssKB: number, slug: string | null = null, ageMs = 60 * MIN): TopProc =>
  ({ pid, ppid, command, rssKB, slug, ageMs })

// One machine's worth of rows: a launcher and its server, two threads, one orphan group, one lone
// broker whose `claude` is gone, and an unrelated process.
const ROWS: TopProc[] = [
  p(90, 1, "/bin/sh /home/u/.local/bin/ntwine-dev", 1_000),
  p(91, 90, "/usr/bin/node /home/u/ntwine/src/dev.ts", 100_000),
  p(100, 91, "/usr/bin/node /home/u/ntwine/packages/server/src/dev.ts", 800_000),
  // thread A: untagged broker → tagged claude → tagged ntwine MCP + a shell + a job that cleared its env
  p(200, 1, BROKER, 30_000, null, 120 * MIN),
  p(201, 200, CLAUDE(`--session-id=${SID_A}`), 300_000, "thread-a", 119 * MIN),
  p(202, 201, "/usr/bin/node /home/u/ntwine/cc-worker/bin/ntwine-mcp.mjs", 40_000, "thread-a"),
  p(203, 201, "/bin/bash -c pnpm test", 4_000, "thread-a"),
  p(204, 203, "node mocha", 2_000_000, null),
  p(205, 204, "tsgo", 500_000, null),
  // a tool an earlier incarnation of thread A left running: older than A's broker
  p(206, 1, "node --watch server.ts", 50_000, "thread-a", 3 * 24 * 60 * MIN),
  // thread B, resumed
  p(300, 1, BROKER, 20_000, null, 10 * MIN),
  p(301, 300, CLAUDE(`--resume=${SID_B}`), 250_000, "thread-b", 10 * MIN),
  // orphans of thread C: no session root anywhere
  p(400, 1, "chrome --headless", 150_000, "thread-c", 30 * MIN),
  p(401, 400, "chrome --type=renderer", 60_000, "thread-c", 30 * MIN),
  p(402, 1, "node vite", 70_000, "thread-c", 30_000),
  // a broker whose claude is gone
  p(600, 1, BROKER, 25_000, null, 400 * MIN),
  // not ntwine's
  p(700, 1, "/usr/bin/sshd", 9_000),
]

test("a thread tree is its tagged processes, its broker, and untagged descendants; RSS sums per thread", () => {
  const { threads } = groupThreadTrees(ROWS)
  assert.deepEqual(threads.map((t) => t.slug), ["thread-a", "thread-b"], "largest first")
  const a = threads[0]!
  assert.deepEqual(a.pids, [200, 201, 202, 203, 204, 205, 206])
  assert.equal(a.rssKB, 30_000 + 300_000 + 40_000 + 4_000 + 2_000_000 + 500_000 + 50_000)
  assert.equal(a.agentKB, 30_000 + 300_000 + 40_000, "broker + claude + ntwine MCP")
  assert.equal(a.workKB, a.rssKB - a.agentKB)
  assert.equal(a.sessionId, SID_A)
  assert.equal(a.brokerPid, 200)
  assert.equal(a.rootPid, 201)
  assert.equal(a.ageMs, 120 * MIN, "the broker's age, not the leftover tool's")
  const b = threads[1]!
  assert.deepEqual(b.pids, [300, 301])
  assert.equal(b.rssKB, 270_000)
  assert.equal(b.sessionId, SID_B, "a resumed session's id comes from --resume")
})

test("a slug with no session root is an orphan, and only the processes past the reaper's age guard count as reapable", () => {
  const { orphans, threads } = groupThreadTrees(ROWS)
  assert.equal(threads.some((t) => t.slug === "thread-c"), false)
  assert.deepEqual(orphans, [{ slug: "thread-c", pids: [400, 401, 402], rssKB: 280_000, reapable: 2 }])
})

test("the reaper's own ancestry is never reapable", () => {
  const rows = [...ROWS, p(800, 400, "node ntwine top", 30_000, "thread-c", 10 * MIN)]
  const { orphans } = groupThreadTrees(rows, { selfPid: 800 })
  // 400 is top's parent and 800 is top itself; 401 is aged and unprotected, 402 too young.
  assert.equal(orphans[0]!.reapable, 1)
})

test("the readout leaves itself and its launcher out, and stops at the first ancestor that is not running it", () => {
  const rows = [
    ...ROWS,
    p(810, 203, "/bin/bash -c ntwine-dev top", 4_000, "thread-a"),
    p(811, 810, "/bin/sh /home/u/.local/bin/ntwine-dev top", 1_000, "thread-a"),
    p(812, 811, "nub --no-env-file /home/u/ntwine/src/index.ts top --json", 150_000, "thread-a"),
  ]
  assert.deepEqual([...readoutChain(rows, 812)].sort(), [810, 811, 812])
  assert.deepEqual([...readoutChain(ROWS, 999)], [999], "a self missing from the rows is still excluded")
  const ancestorNamedTop = [...ROWS, p(820, 203, "htop", 3_000, "thread-a"), p(821, 820, "node top-child", 1_000, "thread-a")]
  assert.deepEqual([...readoutChain(ancestorNamedTop, 821)], [821], "`htop` is not a `top` argument")
})

test("a broker with no live session root belongs to no thread", () => {
  const { owner } = groupThreadTrees(ROWS)
  assert.equal(owner.has(600), false)
  assert.equal(owner.has(700), false)
  assert.equal(owner.has(100), false)
})

test("the server's tree climbs to its launcher and leaves thread processes out", () => {
  const { owner } = groupThreadTrees(ROWS)
  const tree = serverTree(ROWS, 100, owner)
  assert.deepEqual(tree.pids.sort((x, y) => x - y), [90, 91, 100])
  assert.equal(tree.rssKB, 901_000)
  assert.deepEqual(serverTree(ROWS, 999, owner), { pids: [], rssKB: 0 }, "a dead server pid reads empty")
})

test("parsers", () => {
  const mem = parseMeminfo("MemTotal:       32702512 kB\nMemFree:  1 kB\nMemAvailable:   10000000 kB\nSwapTotal:       8388608 kB\nSwapFree:        3388608 kB\n")
  assert.deepEqual(mem, { totalMB: 31936, availableMB: 9766, swapTotalMB: 8192, swapUsedMB: 4883 })
  assert.equal(swapInRate(1_000, 1_256, 1_000), 1, "256 pages of 4KB in 1s is 1MB/s")
  assert.equal(swapInRate(1_000, 900, 1_000), 0, "a counter that went backwards reads zero")
  assert.equal(sessionIdOf(CLAUDE(`--session-id ${SID_A}`)), SID_A)
  assert.equal(sessionIdOf("claude --print hi"), undefined)
  assert.equal(isBrokerDaemon("node /x/dist/claude-agent-broker.js"), true)
  assert.equal(isBrokerDaemon("vim claude-agent-broker.ts.bak"), false)
  assert.equal(sizeLabel(512 * 1024), "512MB")
  assert.equal(sizeLabel(3.44 * 1024 * 1024), "3.4GB")
})

const NOW = Date.parse("2026-10-09T00:00:00.000Z")
const thread = (over: Partial<ProjectBoard["threads"][number]>) => ({ id: "x", runtime: "turn-idle", archived: false, state: "open", backend: "claude", claudeRuntime: "broker", ...over }) as ProjectBoard["threads"][number]
const BOARDS: ProjectBoard[] = [{
  slug: "arktype",
  threads: [
    thread({ id: "thread-a", sessionId: SID_A }),
    thread({ id: "sleeping", sessionId: "dddddddd-4444-4444-8444-444444444444", lastActivityAt: new Date(NOW - 90 * MIN).toISOString() }),
    thread({ id: "done-one", sessionId: SID_LONE, archived: true, state: "archived" }),
    thread({ id: "never-ran" }),
    thread({ id: "external", sessionId: "eeeeeeee-5555-4555-8555-555555555555", foreign: true }),
  ],
}]

test("hibernated: open threads with a session and no live process; done, external and never-run threads are not", () => {
  assert.deepEqual(hibernatedThreads(BOARDS, new Set(["thread-a"]), NOW), [{ slug: "sleeping", project: "arktype", idleMs: 90 * MIN }])
})

test("board rows feed the unowned-broker check: an archived thread's broker and a row-less broker read as unowned", () => {
  const daemons = [
    { sessionId: SID_A, daemonPid: 200, createdAt: new Date(NOW - 120 * MIN).toISOString() },
    { sessionId: SID_LONE, daemonPid: 600, createdAt: new Date(NOW - 400 * MIN).toISOString() },
    { sessionId: "ffffffff-6666-4666-8666-666666666666", daemonPid: 601, createdAt: new Date(NOW - 400 * MIN).toISOString() },
  ]
  const out = classifyUnownedBrokers({ daemons, rows: rowsFromBoards(BOARDS), transcript: () => ({ kind: "absent" }), nowMs: NOW })
  assert.deepEqual(out.map((u) => [u.daemonPid, u.reason, u.verdict.end]), [[600, "archived", false], [601, "no-row", true]])
})

test("the readout says what it could not read, in sentence case and the house duration grammar", () => {
  const { threads, orphans } = groupThreadTrees(ROWS)
  const reading: TopReading = {
    at: new Date(NOW).toISOString(),
    host: { totalMB: 32_000, availableMB: 9_500, swapTotalMB: 8_192, swapUsedMB: 4_800, pressure: { kind: "swapin", mbPerSec: 0.4, windowMs: 1_020 } },
    gate: { enabled: true, dir: "/s", jobs: [
      { id: "1", pid: 1, session: "thread-a", signature: "arktype:ark/type|pnpm test", cmd: "pnpm test", cwd: "/", heavy: true, estimateMB: 2560, status: "running", enqueuedAt: NOW - 200_000, admittedAt: NOW - 155_000, rssMB: 2100, forMs: 155_000, waitedMs: 45_000 },
      { id: "2", pid: 2, session: "thread-b", signature: "arktype:.|tsc", cmd: "tsc", cwd: "/", heavy: true, estimateMB: 2048, status: "queued", enqueuedAt: NOW - 30_000, waitReason: "1 job ahead in the queue", forMs: 30_000 },
    ] },
    ntwine: { totalKB: 4_000_000, serverKB: 901_000, threadsKB: 3_000_000, orphansKB: 280_000 },
    server: null,
    threads: threads.map((t) => ({ ...t, idleMs: 2 * 60 * MIN + 35 * MIN })),
    orphans,
    unowned: null,
    hibernated: null,
  }
  const text = renderTop(reading)
  assert.match(text, /^Memory {2}9\.3GB available of 31\.3GB \(70% used\) · swap 4\.7GB of 8\.0GB · swap-in 0\.4MB\/s over 1\.0s \(no PSI on this kernel\)$/m)
  assert.match(text, /Job gate: 1 running, 1 queued/)
  assert.match(text, /running .*thread-a .*2\.1GB .*2\.5GB .*2m .*45s/)
  assert.match(text, /queued .*thread-b .*30s .*1 job ahead in the queue/)
  assert.match(text, /thread-a .*2\.8GB .*2h .* 2h 35m/)
  assert.match(text, /Hibernated threads and unowned brokers not shown: no ntwine server is running\./)
  assert.match(text, /Orphans .*: 1\n[\s\S]*thread-c .*273MB +3 +reaped on the next sweep/)
  for (const bad of [/\d+ ?min\b/, /\d+ ?hrs?\b/, /\d+ minutes/]) assert.doesNotMatch(text, bad)
})
