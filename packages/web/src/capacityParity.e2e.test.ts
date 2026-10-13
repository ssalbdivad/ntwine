import assert from "node:assert/strict"
import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import net from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import { fileURLToPath } from "node:url"
import type { Browser } from "puppeteer"

// CAPACITY PARITY — the gate on "the default shows at least as much as upstream's default".
//
// Opt-in, and unlike every other *.e2e.test.ts here it needs NOTHING running: it boots its own three
// disposable Ntwine stacks (`scripts/adhoc-stack.mjs`, sandbox HOME, throwaway port), seeds each, renders
// it in its own headless Chrome and tears all of it down, pass or fail. One command runs it end to end:
//   NTWINE_CAPACITY_E2E=1 nub run test packages/web/src/capacityParity.e2e.test.ts
// Set NTWINE_CAPACITY_E2E_SHOTS=/abs/dir to also keep a screenshot of every measurement. It is listed in
// scripts/e2e-web.mjs's NEEDS_REAL_STACK (it drives the real app, not a fixture page), so neither
// `nub run test` nor `nub run test:e2e` boots its stacks: three Vite-served servers and six page loads
// took 2.5-3.5 minutes on 2026-10-06, which the unit suite should not pay on every run.
//
// WHY THE BAR EXISTS. Upstream's standup (S3) put the scale question as a real machine: 17 projects and
// about 70 open threads. David's first answer (2026-10-06, plans/upstream-superset.md § Capacity parity)
// was that there is no view setting and All projects stays home at `/` — so the DEFAULT had to carry that
// load, and "carries it" is defined against the original Frizz design: the default must show at least as
// much, without scrolling, as upstream's default does. That is a number, so it is pinned as one. Later
// that day a project's BOARD became the default (`/` goes back to the last view, a board for a browser
// that never chose) and All projects moved to `/all`, one click away; both views keep the bar, since
// either can be the one a browser opens.
//
// WITH THE RAIL ON AND OFF. Upstream's project rail came back the same day, opt-in (Settings → Project
// sidebar, `projectRail`). It takes 57px of width on both views, which can wrap a title onto a second
// line and so cost rows, so every measurement is taken twice — the rail off (the default) and on, set
// through settingsSet before the page loads — and both must meet the bar. Each reading says whether the
// rail was actually drawn, so a run that silently measured the same thing twice fails.
//
// WHERE 22 AND 28 COME FROM. Upstream's own board (upstream Frizz at 0a3b9139), seeded with every one
// of the 70 open threads in ONE project and rendered by this same visibility rule, shows 22 thread rows
// at 1440x900 and 28 at 1920x1080, its band headers and rules included. The baseline is a measurement
// of that commit, not a design target; re-measure on a newer upstream before moving it.
//
// WHAT IS COUNTED. A row counts only when its WHOLE box lies inside the viewport and inside every
// clipping (overflow != visible) ancestor — fully readable without scrolling, not peeking out under a
// fold. Two views, three loads:
//   - All projects at `/all`, the heavy load (17 projects, 70 open threads skewed across projects and across
//     pinned / queue / running / snoozed, plus three done per project). LINES = thread rows
//     `[data-sidebar-item]` + project header rows `[data-xq-project-row]`: a header is a line of the
//     same height carrying that project's counts, which is information upstream's board, one project
//     at a time, does not show at all. Must be >= 22 / >= 28.
//   - All projects at `/all`, David's load (4 projects, 10 threads). Every loud row — pinned, queue,
//     running — must be fully visible: at a light load nothing that wants the human may sit below a fold.
//   - The project board at `/project/<slug>`, the capacity load (the same 70 in ONE project). ROWS =
//     `[data-sidebar-item]` alone, the like-for-like with upstream's sidebar. Must be >= 22 / >= 28.
// The test reads only that DOM contract (`data-sidebar-item`, `data-xq-project-row`, `data-xq-band`), so
// the views can be restyled freely as long as they still fit the numbers.
//
// SEEDING. Each thread is a `session` row in the stack's sqlite, a transcript JSONL the real tailer
// reads, and — for every open thread — a broker liveness record naming a stand-in `sleep` daemon, the
// recipe of scripts/seed-all-queues.mjs. No RPC creates a thread without a real agent, and a Running
// thread is precisely one whose broker daemon is alive mid-turn, so the row is the fixture and the
// server's real tailer → board → push → render path does the rest. The daemon is this test's to kill.
//
// Measured on David's fork when this landed (2026-10-06, 48ea0568, before All projects was compacted),
// at 1440x900 / 1920x1080: the project board 22 / 29 rows (passes); All projects at the heavy load
// 17 / 22 lines, i.e. 11 rows + 6 headers / 14 rows + 8 headers (FAILS — each project group then cost
// ~60px beyond its rows: a header, a "N more" row and a rule); David's load 8 of 8 loud rows at both.
// The rail-on readings start with the commit that restored the rail (2026-10-06, on us-default).
const enabled = process.env.NTWINE_CAPACITY_E2E === "1"
const shotsDir = process.env.NTWINE_CAPACITY_E2E_SHOTS

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url))

// upstream 0a3b9139, measured as above.
const BAR = { "1440x900": 22, "1920x1080": 28 } as const
/** The project rail's two states (Settings → Project sidebar); every view is measured in both. */
const RAIL_STATES = [false, true] as const
type Viewport = keyof typeof BAR
const VIEWPORTS: { key: Viewport; width: number; height: number }[] = [
  { key: "1440x900", width: 1440, height: 900 },
  { key: "1920x1080", width: 1920, height: 1080 },
]

// ── The loads ────────────────────────────────────────────────────────────────────────────────────────

type Band = "pinned" | "ready" | "working" | "snoozed" | "done"
const LOUD: ReadonlySet<Band> = new Set(["pinned", "ready", "working"])
type SeedThread = { slug: string; title: string; band: Band }
type Load = { name: string; projects: { name: string; threads: SeedThread[] }[] }

// Titles at the length agents actually title threads (30-75 chars), so a row is one line as it is on a
// real machine — a run of short titles would flatter every view equally and prove nothing.
const TITLES = [
  "Fix the flaky login test",
  "Return rate-limit headers on every response",
  "Upgrade the Postgres driver to v9 and fix what breaks",
  "Trace the slow checkout endpoint",
  "Line up the pricing tiers on narrow screens",
  "Generate OG images at build time",
  "Add an RSS feed for the blog",
  "Cache CORS preflight responses",
  "Decide the audit log retention window",
  "Regenerate the SDK types after the schema lands",
  "Accept idempotency keys on POST",
  "Migrate the session schema to the unified table",
  "Rewrite the terms copy",
  "Watch the deploy error rate after the rollout",
  "Re-run the quota estimator once the window resets",
  "Kill the tailer flake",
  "Make the composer icons optically centred",
  "Port the webhook retries onto the job queue",
  "Investigate why the nightly export doubles rows",
  "Tighten the CSP for the admin console",
  "Add keyboard navigation to the command palette",
  "Split the monolith's billing module into its own service",
  "Backfill missing invoice line items for September",
  "Review the dependency bump PR from renovate",
]
// Every ten open threads: 4 queue, 3 running, 2 snoozed, 1 pinned. 70 of them is 28 / 21 / 14 / 7.
const BAND_CYCLE: Band[] = ["ready", "working", "snoozed", "ready", "working", "ready", "pinned", "ready", "working", "snoozed"]
const PROJECT_NAMES = [
  "acme-api", "marketing-site", "billing-service", "design-system", "mobile-app", "data-pipeline",
  "auth-gateway", "docs-portal", "search-indexer", "notifications", "admin-console", "analytics-dash",
  "infra-terraform", "sdk-typescript", "cli-tools", "ml-ranker", "status-page",
]

function load(name: string, counts: number[]): Load {
  let k = 0
  return {
    name,
    projects: counts.map((count, pi) => ({
      name: PROJECT_NAMES[pi]!,
      threads: [
        ...Array.from({ length: count }, (_, i) => {
          const band = BAND_CYCLE[k % BAND_CYCLE.length]!
          const title = TITLES[(k * 7 + pi) % TITLES.length]!
          k++
          return { slug: `t${pi}-${i}`, title, band }
        }),
        // Three done per project: collapsed everywhere, but a real board carries them.
        ...Array.from({ length: 3 }, (_, i) => ({ slug: `d${pi}-${i}`, title: TITLES[(pi + i * 5) % TITLES.length]!, band: "done" as const })),
      ],
    })),
  }
}
// Skewed like a real machine: a few busy projects, a long tail. Sums to 70.
const HEAVY = load("heavy", [10, 8, 7, 6, 5, 5, 4, 4, 4, 3, 3, 3, 2, 2, 2, 1, 1])
const DAVID = load("david", [4, 3, 2, 1])
const CAPACITY = load("capacity", [70])

// ── Owned processes: everything this file starts, it kills — on a pass, a failure or a Ctrl-C ────────

// Pids, by exact identity — never a name or a pattern: other agents run stacks on this machine too.
const ownedPids = new Set<number>()
const ownedDirs = new Set<string>()
if (enabled) {
  // The stacks are DETACHED (their own process group, so a stray terminal signal cannot half-kill one),
  // which also means a Ctrl-C on the runner never reaches them. So the runner's own exit takes them
  // down: SIGTERM, on which adhoc-stack deletes its sandbox HOME.
  process.on("exit", () => {
    for (const pid of ownedPids) { try { process.kill(pid, "SIGTERM") } catch {} }
    for (const dir of ownedDirs) { try { rmSync(dir, { recursive: true, force: true }) } catch {} }
  })
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => process.exit(130))
}

function descendants(pid: number): number[] {
  // `ps` rather than /proc so the same code reads on macOS. `nub` re-execs node in a NEW process group
  // (measured 2026-10-06), so the group of the pid we hold is not the whole stack.
  const table = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" })
    .split("\n").map((l) => l.trim().split(/\s+/).map(Number)).filter((p) => p.length === 2 && !Number.isNaN(p[0]))
  const out: number[] = []
  const walk = (parent: number) => {
    for (const [child, ppid] of table) if (ppid === parent) { out.push(child!); walk(child!) }
  }
  walk(pid)
  return out
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

// ── A stack ──────────────────────────────────────────────────────────────────────────────────────────

type Project = { id: string; slug: string; dir: string; threads: SeedThread[] }
type Stack = { base: string; home: string; db: string; projects: Project[]; stop: () => Promise<void>; log: string }

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo
      server.close(() => resolve(port))
    })
  })
}

async function bootStack(seed: Load): Promise<Stack> {
  const scratch = mkdtempSync(join(tmpdir(), `ntwine-capacity-${seed.name}-`))
  ownedDirs.add(scratch)
  // Plain git repos named for the project: the slug is the folder's name, so the views read like a
  // real machine's (and the first one is the launcher).
  const dirs = seed.projects.map(({ name }) => {
    const dir = join(scratch, name)
    mkdirSync(dir)
    execFileSync("git", ["init", "-q"], { cwd: dir })
    writeFileSync(join(dir, "README.md"), `# ${name}\n`)
    return realpathSync(dir)
  })
  const port = await freePort()
  const log = join(scratch, "stack.log")
  const fd = openSync(log, "w")
  // stdout to a FILE, never a pipe we might stop reading: the stack logs every Vite update, and a write
  // to a closed pipe kills it with SIGPIPE mid-run (ntwine-stack skill).
  const child = spawn("nub", ["scripts/adhoc-stack.mjs", `--port=${port}`, `--project=${dirs[0]}`, ...dirs.slice(1).map((d) => `--also-project=${d}`)], {
    cwd: repoRoot, stdio: ["ignore", fd, fd], detached: true,
  })
  closeSync(fd)
  let tree = [child.pid!]
  ownedPids.add(child.pid!)
  const own = () => {
    tree = [...new Set([...tree, ...descendants(child.pid!)])]
    for (const pid of tree) ownedPids.add(pid)
  }
  const stop = async () => {
    own()
    // SIGTERM first: adhoc-stack closes the server and deletes its sandbox HOME on it. Then SIGKILL
    // whatever has not gone in 15s, so a wedged stack still cannot outlive the run.
    for (const pid of tree) { try { process.kill(pid, "SIGTERM") } catch {} }
    const deadline = Date.now() + 15_000
    while (tree.some(alive) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
    for (const pid of tree) { try { process.kill(pid, "SIGKILL") } catch {} ownedPids.delete(pid) }
    rmSync(scratch, { recursive: true, force: true })
    ownedDirs.delete(scratch)
  }
  try {
    const deadline = Date.now() + 120_000
    let line: string | undefined
    while (!line) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`adhoc-stack exited before booting:\n${readFileSync(log, "utf8").slice(-3000)}`)
      if (Date.now() > deadline) throw new Error(`adhoc-stack never announced itself:\n${readFileSync(log, "utf8").slice(-3000)}`)
      await new Promise((r) => setTimeout(r, 250))
      line = readFileSync(log, "utf8").split("\n").find((l) => l.startsWith('{"url"'))
    }
    own()
    const info = JSON.parse(line) as { home: string; launcher: { id: string; slug: string }; tenants: { id: string; slug: string; dir: string }[] }
    const all = [{ id: info.launcher.id, slug: info.launcher.slug, dir: dirs[0]! }, ...info.tenants]
    assert.equal(all.length, seed.projects.length, `the stack registered ${all.length} of ${seed.projects.length} projects:\n${readFileSync(log, "utf8").slice(-3000)}`)
    const projects = all.map((p, i) => ({ ...p, dir: realpathSync(p.dir), threads: seed.projects[i]!.threads }))
    return { base: `http://127.0.0.1:${port}`, home: info.home, db: join(info.home, ".ntwine", "ui.db"), projects, stop, log }
  } catch (error) {
    await stop()
    throw error
  }
}

// ── Seeding ──────────────────────────────────────────────────────────────────────────────────────────

function seedStack(stack: Stack): ChildProcess {
  // ONE stand-in broker daemon for every open thread — its only job is to own a pid that answers
  // `kill -0`, which is what makes a mid-turn thread Running rather than stalled.
  const daemon = spawn("sleep", ["3600"], { stdio: "ignore" })
  daemon.unref()
  ownedPids.add(daemon.pid!)
  const now = Date.now()
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString()
  const later = (hours: number) => new Date(now + hours * 3_600_000).toISOString()
  const db = new DatabaseSync(stack.db)
  try {
    db.exec("PRAGMA busy_timeout = 10000")
    const insert = db.prepare(`INSERT OR REPLACE INTO session (project_id, slug, session_id, thread_name, spawned_at, title, title_auto, backend,
      claude_runtime, model, effort, permission_mode, state, unread, exited, archived, rested_at, snoozed_until, pinned_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, 'claude', ?, 'opus', 'high', 'default', ?, 0, 0, ?, ?, ?, ?)`)
    let n = 0
    for (const project of stack.projects) {
      const transcriptDir = join(stack.home, ".claude", "projects", project.dir.replace(/[/.]/g, "-"))
      mkdirSync(transcriptDir, { recursive: true })
      const brokerDir = join(stack.home, ".ntwine", "projects", project.id, "claude-broker")
      mkdirSync(brokerDir, { recursive: true })
      for (const t of project.threads) {
        const h = createHash("sha256").update(`capacity/${project.slug}/${t.slug}`).digest("hex")
        const sessionId = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-9${h.slice(17, 20)}-${h.slice(20, 32)}`
        // Rests staggered three minutes apart, so the order inside a band is stable and realistic.
        const rest = 5 + n++ * 3
        const inFlight = t.band === "working"
        const done = t.band === "done"
        const records = [
          { type: "user", sessionId, cwd: project.dir, timestamp: ago(rest + 12), message: { role: "user", content: [{ type: "text", text: `TASK:\n${t.title}` }] } },
          inFlight
            ? { type: "assistant", sessionId, cwd: project.dir, timestamp: ago(1), message: { role: "assistant", id: `m-${t.slug}`, stop_reason: "tool_use", content: [{ type: "tool_use", id: `b-${t.slug}`, name: "Bash", input: { command: "pnpm test", description: "Running the test suite" } }] } }
            : { type: "assistant", sessionId, cwd: project.dir, timestamp: ago(rest), message: { role: "assistant", id: `m-${t.slug}`, stop_reason: "end_turn", content: [{ type: "text", text: "Done — the change is on main and the suite is green." }], usage: { input_tokens: 2, output_tokens: 40 } } },
        ]
        writeFileSync(join(transcriptDir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")
        if (!done) {
          // Where claude-broker-host.ts looks for this session's daemon (claudeBrokerRecordPath).
          const key = createHash("sha256").update(sessionId).digest("hex").slice(0, 16)
          writeFileSync(join(brokerDir, `${key}.json`), JSON.stringify({ sessionId, daemonPid: daemon.pid, socketPath: join(brokerDir, `${t.slug}.sock`) }))
        }
        insert.run(
          project.id, t.slug, sessionId, `ntwine-${t.slug}`, ago(rest + 13), t.title,
          done ? null : "broker", done ? "archived" : "open", done ? 1 : 0,
          inFlight ? null : ago(rest), t.band === "snoozed" ? later(6) : null, t.band === "pinned" ? ago(rest + 5) : null,
        )
      }
    }
  } finally {
    db.close()
  }
  return daemon
}

// Every project's board, asked for until it carries every seeded thread. The request also OPENS a
// tenant (the server activates one lazily), and the browser is only pointed at a stack whose server
// already holds the whole load, so a slow tailer reads as a timeout here rather than a short count.
async function waitForBoards(stack: Stack) {
  const headers = { origin: stack.base }
  const deadline = Date.now() + 60_000
  for (const project of stack.projects) {
    const want = new Set(project.threads.map((t) => t.slug))
    let seen = 0
    for (;;) {
      const res = await fetch(`${stack.base}/_ntwine/${project.slug}/rpc/board`, { headers }).catch(() => undefined)
      const body = res?.ok ? ((await res.json()) as { result?: { threads?: { slug?: string; id?: string }[] } }) : undefined
      const threads = body?.result?.threads ?? []
      seen = threads.filter((t) => want.has(String(t.slug ?? t.id))).length
      if (seen === want.size) break
      if (Date.now() > deadline) throw new Error(`${project.slug}'s board carries ${seen} of the ${want.size} threads seeded into it (first: ${JSON.stringify(threads[0])?.slice(0, 400)})`)
      await new Promise((r) => setTimeout(r, 500))
    }
  }
}

// ── Measuring ────────────────────────────────────────────────────────────────────────────────────────

type Measurement = {
  viewport: Viewport
  /** Whether the project rail was asked for, and whether the page drew it. */
  railAsked: boolean
  railDrawn: boolean
  rowsVisible: number
  headersVisible: number
  rowsMounted: number
  headersMounted: number
  visibleByBand: Record<string, number>
  visibleIds: string[]
}

/** Turn the project rail on or off: a machine setting, written through the server's own RPC. */
async function setRail(stack: Stack, on: boolean): Promise<void> {
  const headers = { origin: stack.base, "content-type": "application/json" }
  const current = (await (await fetch(`${stack.base}/_ntwine/rpc/settingsGet`, { headers })).json()) as { result: Record<string, unknown> }
  const res = await fetch(`${stack.base}/_ntwine/rpc/settingsSet`, { method: "POST", headers, body: JSON.stringify({ ...current.result, projectRail: on }) })
  assert.equal(res.status, 200, `settingsSet projectRail=${on}: ${await res.text()}`)
}

/** Every viewport, with the rail off and then on. */
async function measureAll(stack: Stack, browser: Browser, url: string, label: string): Promise<Measurement[]> {
  const out: Measurement[] = []
  for (const rail of RAIL_STATES) {
    await setRail(stack, rail)
    for (const viewport of VIEWPORTS) out.push(await measure(browser, url, viewport, `${label}-rail-${rail ? "on" : "off"}`, rail))
  }
  await setRail(stack, false)
  return out
}

async function measure(browser: Browser, url: string, viewport: (typeof VIEWPORTS)[number], label: string, railAsked: boolean): Promise<Measurement> {
  const page = await browser.newPage()
  try {
    await page.setViewport({ width: viewport.width, height: viewport.height, deviceScaleFactor: 1 })
    await page.goto(url, { waitUntil: "networkidle2", timeout: 120_000 })
    await page.waitForSelector("[data-sidebar-item]", { timeout: 60_000 })
    await page.evaluate(() => document.fonts.ready.then(() => undefined))
    // The count, taken once it holds still: rows arrive over the live feed and a band can settle a
    // frame or two after the first, so one sample could catch the list mid-assembly. Two seconds of
    // identical readings is settled.
    const read = () => page.evaluate(() => {
      // measure.ts's rule, verbatim: the whole box inside the viewport and inside every ancestor
      // whose overflow clips.
      const visible = (el: Element) => {
        const r = el.getBoundingClientRect()
        if (r.height === 0) return false
        let top = 0, bottom = innerHeight, left = 0, right = innerWidth
        for (let a = el.parentElement; a; a = a.parentElement) {
          const cs = getComputedStyle(a)
          if (cs.overflowY !== "visible" || cs.overflowX !== "visible") {
            const ar = a.getBoundingClientRect()
            top = Math.max(top, ar.top); bottom = Math.min(bottom, ar.bottom)
            left = Math.max(left, ar.left); right = Math.min(right, ar.right)
          }
        }
        return r.top >= top - 0.5 && r.bottom <= bottom + 0.5 && r.left >= left - 0.5 && r.right <= right + 0.5
      }
      const rows = [...document.querySelectorAll<HTMLElement>("[data-sidebar-item]")]
      const headers = [...document.querySelectorAll("[data-xq-project-row]")]
      const shown = rows.filter(visible)
      const visibleByBand: Record<string, number> = {}
      for (const row of shown) { const band = row.dataset.xqBand ?? "unbanded"; visibleByBand[band] = (visibleByBand[band] ?? 0) + 1 }
      return {
        railDrawn: document.querySelector('nav[aria-label="Projects"]') !== null,
        rowsVisible: shown.length,
        headersVisible: headers.filter(visible).length,
        rowsMounted: rows.length,
        headersMounted: headers.length,
        visibleByBand,
        visibleIds: shown.map((row) => row.dataset.sidebarItem ?? ""),
      }
    })
    let last = ""
    let steady = 0
    let reading = await read()
    const deadline = Date.now() + 30_000
    while (steady < 4 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500))
      reading = await read()
      const key = JSON.stringify(reading)
      steady = key === last ? steady + 1 : 0
      last = key
    }
    if (shotsDir) {
      mkdirSync(shotsDir, { recursive: true })
      await page.screenshot({ path: join(shotsDir, `capacity-${label}-${viewport.key}.png`) })
    }
    return { viewport: viewport.key, railAsked, ...reading }
  } finally {
    await page.close()
  }
}

async function withLoad<T>(seed: Load, run: (stack: Stack, browser: Browser) => Promise<T>): Promise<T> {
  const stack = await bootStack(seed)
  let daemon: ChildProcess | undefined
  let browser: Browser | undefined
  try {
    daemon = seedStack(stack)
    await waitForBoards(stack)
    // The one launcher (scripts/lib/headless-browser.mjs): the headless shell, --use-mock-keychain.
    // `mouse` makes it a desktop with a mouse (scripts/lib/mouse-pointer.mjs): both viewports are
    // desktops, and a touch screen would show hover-gated row actions at rest. The counts came out
    // identical either way on 2026-10-06.
    const { launchHeadless } = await import("../../../scripts/lib/headless-browser.mjs")
    browser = await launchHeadless({ mouse: true, protocolTimeout: 120_000 })
    return await run(stack, browser)
  } finally {
    if (browser) await browser.close().catch(() => {})
    if (daemon) { try { daemon.kill("SIGKILL") } catch {} ownedPids.delete(daemon.pid!) }
    await stack.stop()
  }
}

// One line per measurement, printed on a pass as well as a failure: the numbers ARE the evidence.
function report(load: string, view: string, unit: string, measured: { viewport: Viewport; railAsked: boolean; count: number; detail: string }[], bar: (v: Viewport) => number) {
  const lines = measured.map(({ viewport, railAsked, count, detail }) =>
    `  ${load.padEnd(9)} ${view.padEnd(13)} ${(railAsked ? "rail on" : "rail off").padEnd(9)} ${viewport.padEnd(10)} ${String(count).padStart(3)} ${unit} (${detail})  bar ${bar(viewport)}  ${count >= bar(viewport) ? "ok" : "SHORT"}`)
  console.log(`capacity parity:\n${lines.join("\n")}`)
  return lines.join("\n")
}

/** A rail-on reading of a page that drew no rail, or the reverse, measured the wrong thing. */
function assertRail(measured: Measurement[], table: string): void {
  for (const m of measured) assert.equal(m.railDrawn, m.railAsked, `the project rail was ${m.railAsked ? "asked for" : "off"} at ${m.viewport} but the page ${m.railDrawn ? "drew" : "did not draw"} it\n${table}`)
}

test("All projects at the heavy load shows at least upstream's 22 / 28 lines without scrolling, rail off and on", { skip: !enabled, timeout: 900_000 }, async () => {
  const measured = await withLoad(HEAVY, (stack, browser) => measureAll(stack, browser, `${stack.base}/all`, "all-projects-heavy"))
  const rows = measured.map((m) => ({
    viewport: m.viewport,
    railAsked: m.railAsked,
    count: m.rowsVisible + m.headersVisible,
    detail: `${m.rowsVisible} thread rows + ${m.headersVisible} project headers; ${m.rowsMounted} rows / ${m.headersMounted} headers mounted`,
  }))
  const table = report("heavy", "all-projects", "lines", rows, (v) => BAR[v])
  assertRail(measured, table)
  for (const { viewport, railAsked, count } of rows) {
    assert.ok(count >= BAR[viewport], `All projects at the heavy load (17 projects, 70 open), rail ${railAsked ? "on" : "off"}, shows ${count} lines at ${viewport} without scrolling; upstream's board shows ${BAR[viewport]} (0a3b9139). Capacity parity needs the default to show at least as much.\n${table}`)
  }
})

test("All projects at David's load shows every pinned, queue and running row without scrolling, rail off and on", { skip: !enabled, timeout: 900_000 }, async () => {
  const loud = DAVID.projects.flatMap((p) => p.threads.filter((t) => LOUD.has(t.band)).map((t) => t.slug))
  const measured = await withLoad(DAVID, (stack, browser) => measureAll(stack, browser, `${stack.base}/all`, "all-projects-david"))
  const rows = measured.map((m) => {
    const shown = new Set(m.visibleIds)
    const missing = loud.filter((slug) => !shown.has(slug))
    return { viewport: m.viewport, railAsked: m.railAsked, count: loud.length - missing.length, missing, detail: `of ${loud.length} loud; ${m.rowsVisible} rows + ${m.headersVisible} headers visible${missing.length ? `; below the fold: ${missing.join(", ")}` : ""}` }
  })
  const table = report("david", "all-projects", "loud rows", rows, () => loud.length)
  assertRail(measured, table)
  for (const { viewport, railAsked, missing } of rows) {
    assert.deepEqual(missing, [], `All projects at David's load (4 projects, 10 threads), rail ${railAsked ? "on" : "off"}, hides loud rows below the fold at ${viewport}: ${missing.join(", ")}\n${table}`)
  }
})

test("the project board at the capacity load shows at least upstream's 22 / 28 rows without scrolling, rail off and on", { skip: !enabled, timeout: 900_000 }, async () => {
  const measured = await withLoad(CAPACITY, (stack, browser) => measureAll(stack, browser, `${stack.base}/project/${stack.projects[0]!.slug}`, "project-board-capacity"))
  const rows = measured.map((m) => ({
    viewport: m.viewport,
    railAsked: m.railAsked,
    count: m.rowsVisible,
    detail: `${Object.entries(m.visibleByBand).map(([band, n]) => `${n} ${band}`).join(", ")}; ${m.rowsMounted} rows mounted`,
  }))
  const table = report("capacity", "project-board", "rows", rows, (v) => BAR[v])
  assertRail(measured, table)
  for (const { viewport, railAsked, count } of rows) {
    assert.ok(count >= BAR[viewport], `The project board with 70 open threads in one project, rail ${railAsked ? "on" : "off"}, shows ${count} thread rows at ${viewport} without scrolling; upstream's board shows ${BAR[viewport]} (0a3b9139).\n${table}`)
  }
})
