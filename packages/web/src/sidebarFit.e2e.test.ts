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

// SIDEBAR FIT — the gate on "the list never scrolls, and never loses a thread" (plans/all-projects-first.md).
//
// Opt-in, and unlike every other *.e2e.test.ts here it needs NOTHING running: it boots its own disposable
// ntwine stacks (`scripts/adhoc-stack.mjs`, sandbox HOME, throwaway port), seeds each, renders it in its own
// headless Chrome and tears all of it down, pass or fail. One command runs it end to end:
//   NTWINE_SIDEBAR_FIT_E2E=1 pnpm run test packages/web/src/sidebarFit.e2e.test.ts
// Set NTWINE_SIDEBAR_FIT_E2E_SHOTS=/abs/dir to also keep a screenshot of every measurement. It is listed in
// scripts/e2e-web.mjs's NEEDS_REAL_STACK (it drives the real app, not a fixture page), so neither
// `pnpm run test` nor `pnpm run test:e2e` boots its stacks.
//
// THE BAR. All projects lists every project's threads by what they need (components/TierList.tsx) and
// budgets its own height (lib/sidebarBudget.ts): at the heavy load (17 projects, 70 open threads) its
// scroll box must not overflow at 1280x720, 1440x900 or 1920x1080, and every open thread must still be
// ACCOUNTED FOR — a row, a project's rollup line, a "N more" line that counts it, or the Snoozed header's
// count. At David's load (4 projects, 10 threads) nothing is compressed: every pinned, ready and working
// row is on screen. A project's own page (`/project/<slug>`, the same list for one project) holds the
// same bar with all 70 in one project.
//
// It replaced CAPACITY PARITY (2026-10-06 to 2026-10-14), which held All projects to the 22 / 28 thread
// rows upstream's board showed at 1440x900 / 1920x1080 (upstream 0a3b9139). The last per-project list
// measured 19 / 21 rows there with this seed, scrolling for the rest; the bar moved from "as many rows as
// upstream" to "nothing below a fold, nothing uncounted" when David chose the tier list.
//
// WHAT IS READ. Only a DOM contract: the list's scroll box `[data-xq-rail]`, each tier's
// `[data-xq-tier]` with its `data-xq-tier-count`, thread rows `[data-sidebar-item]`, rollups'
// `data-xq-rollup-count` and "N more" lines' `data-xq-more-count`.
//
// SEEDING. Each thread is a `session` row in the stack's sqlite, a transcript JSONL the real tailer
// reads, and — for every open thread — a broker liveness record naming a stand-in `sleep` daemon, the
// recipe of scripts/seed-all-queues.mjs. No RPC creates a thread without a real agent, and a Running
// thread is precisely one whose broker daemon is alive mid-turn, so the row is the fixture and the
// server's real tailer → board → push → render path does the rest. The daemon is this test's to kill.
const enabled = process.env.NTWINE_SIDEBAR_FIT_E2E === "1"
const shotsDir = process.env.NTWINE_SIDEBAR_FIT_E2E_SHOTS

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url))

type Viewport = "1280x720" | "1440x900" | "1920x1080"
const VIEWPORTS: { key: Viewport; width: number; height: number }[] = [
  { key: "1280x720", width: 1280, height: 720 },
  { key: "1440x900", width: 1440, height: 900 },
  { key: "1920x1080", width: 1920, height: 1080 },
]

// ── The loads ────────────────────────────────────────────────────────────────────────────────────────

type Band = "pinned" | "ready" | "working" | "waiting" | "snoozed" | "done"
// Waiting never folds either (2026-10-14): it gives rows up to a "N more waiting" line, never to a fold.
const LOUD: ReadonlySet<Band> = new Set(["pinned", "ready", "working", "waiting"])
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
// Every ten open threads: 4 queue, 3 running, 1 waiting, 1 snoozed, 1 pinned. 70 of them is 28 / 21 / 7 / 7 / 7.
const BAND_CYCLE: Band[] = ["ready", "working", "snoozed", "ready", "working", "ready", "pinned", "ready", "working", "waiting"]
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
  const scratch = mkdtempSync(join(tmpdir(), `ntwine-sidebar-fit-${seed.name}-`))
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
        const h = createHash("sha256").update(`sidebar-fit/${project.slug}/${t.slug}`).digest("hex")
        const sessionId = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-9${h.slice(17, 20)}-${h.slice(20, 32)}`
        // Rests staggered three minutes apart, so the order inside a band is stable and realistic.
        const rest = 5 + n++ * 3
        const inFlight = t.band === "working"
        const done = t.band === "done"
        const task = { type: "user", sessionId, cwd: project.dir, timestamp: ago(rest + 12), message: { role: "user", content: [{ type: "text", text: `TASK:\n${t.title}` }] } }
        // WAITING is a `status: watching` rest on something still live: here a background shell, launched
        // with the path-less ack so it stays running for as long as the daemon does (seed-resting-thread.mjs).
        const shellId = `toolu_watch_${t.slug.replace(/-/g, "_")}`
        const records = t.band === "waiting" ? [
          task,
          { type: "assistant", sessionId, cwd: project.dir, timestamp: ago(rest + 1), message: { role: "assistant", id: `m-${t.slug}-launch`, stop_reason: "tool_use", content: [{ type: "tool_use", id: shellId, name: "Bash", input: { command: "gh run watch --exit-status", description: "Watching the deploy run", run_in_background: true } }] } },
          { type: "user", sessionId, cwd: project.dir, timestamp: ago(rest + 1), message: { role: "user", content: [{ type: "tool_result", tool_use_id: shellId, content: "Command running in background" }] } },
          { type: "assistant", sessionId, cwd: project.dir, timestamp: ago(rest), message: { role: "assistant", id: `m-${t.slug}`, stop_reason: "end_turn", content: [{ type: "text", text: `\`\`\`awaiting\nshells: [${shellId}]\nstatus: watching\nfor: 1d\n\`\`\`` }], usage: { input_tokens: 2, output_tokens: 40 } } },
        ] : [
          task,
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

type Tier = { tier: string; count: number; rows: number; rollups: number; more: number }
type Measurement = {
  viewport: Viewport
  /** How far the list's scroll box overflows, in px; 0 when it fits. */
  overflow: number
  tiers: Tier[]
  /** Thread rows wholly on screen, by thread slug. */
  visibleIds: string[]
}

/** Every viewport. */
async function measureAll(browser: Browser, url: string, label: string): Promise<Measurement[]> {
  const out: Measurement[] = []
  for (const viewport of VIEWPORTS) out.push(await measure(browser, url, viewport, label))
  return out
}

async function measure(browser: Browser, url: string, viewport: (typeof VIEWPORTS)[number], label: string): Promise<Measurement> {
  const page = await browser.newPage()
  try {
    await page.setViewport({ width: viewport.width, height: viewport.height, deviceScaleFactor: 1 })
    await page.goto(url, { waitUntil: "networkidle2", timeout: 120_000 })
    await page.waitForSelector("[data-sidebar-item]", { timeout: 60_000 })
    await page.evaluate(() => document.fonts.ready.then(() => undefined))
    // Taken once it holds still: rows arrive over the live feed and the list re-budgets as they do, so one
    // sample could catch it mid-assembly. Two seconds of identical readings is settled.
    const read = () => page.evaluate(() => {
      // The whole box inside the viewport and inside every ancestor whose overflow clips.
      const visible = (el: Element) => {
        const r = el.getBoundingClientRect()
        if (r.height === 0) return false
        let top = 0, bottom = innerHeight
        for (let a = el.parentElement; a; a = a.parentElement) {
          const cs = getComputedStyle(a)
          if (cs.overflowY !== "visible") {
            const ar = a.getBoundingClientRect()
            top = Math.max(top, ar.top); bottom = Math.min(bottom, ar.bottom)
          }
        }
        return r.top >= top - 0.5 && r.bottom <= bottom + 0.5
      }
      const rail = document.querySelector<HTMLElement>("[data-xq-rail]")
      const sum = (els: Iterable<Element>, attr: string) => [...els].reduce((n, el) => n + Number(el.getAttribute(attr) ?? 0), 0)
      const tiers = [...document.querySelectorAll<HTMLElement>("[data-xq-tier]")].map((section) => ({
        tier: section.dataset.xqTier ?? "",
        count: Number(section.dataset.xqTierCount ?? 0),
        rows: [...section.querySelectorAll("[data-sidebar-item]")].filter(visible).length,
        rollups: sum([...section.querySelectorAll("[data-xq-rollup-count]")].filter(visible), "data-xq-rollup-count"),
        more: sum([...section.querySelectorAll("[data-xq-more-count]")].filter(visible), "data-xq-more-count"),
      }))
      return {
        overflow: rail ? Math.max(0, rail.scrollHeight - rail.clientHeight) : -1,
        tiers,
        visibleIds: [...document.querySelectorAll<HTMLElement>("[data-sidebar-item]")].filter(visible).map((row) => row.dataset.sidebarItem ?? ""),
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
      await page.screenshot({ path: join(shotsDir, `sidebar-fit-${label}-${viewport.key}.png`) })
    }
    return { viewport: viewport.key, ...reading }
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
function report(load: string, view: string, measured: Measurement[]): string {
  const lines = measured.map((m) => {
    const tiers = m.tiers.map((t) => `${t.tier} ${t.count} (${t.rows} rows${t.rollups ? ` + ${t.rollups} rolled` : ""}${t.more ? ` + ${t.more} more` : ""})`).join(", ")
    return `  ${load.padEnd(9)} ${view.padEnd(13)} ${m.viewport.padEnd(10)} overflow ${String(m.overflow).padStart(3)}px  ${m.visibleIds.length} rows on screen  ${tiers}`
  })
  console.log(`sidebar fit:\n${lines.join("\n")}`)
  return lines.join("\n")
}

const LOUD_TIERS = new Set(["pinned", "ready", "working", "waiting"])

/** The bar: nothing overflows, the tiers count every open thread, and each loud tier lists or counts all of its. */
function assertFits(measured: Measurement[], open: number, table: string, where: string) {
  for (const m of measured) {
    assert.equal(m.overflow, 0, `${where} scrolls by ${m.overflow}px at ${m.viewport}\n${table}`)
    const counted = m.tiers.filter((t) => t.tier !== "done").reduce((n, t) => n + t.count, 0)
    assert.equal(counted, open, `${where} at ${m.viewport} counts ${counted} open threads of ${open} in its tiers\n${table}`)
    for (const t of m.tiers.filter((t) => LOUD_TIERS.has(t.tier))) {
      assert.equal(t.rows + t.rollups + t.more, t.count, `${where} at ${m.viewport}: ${t.tier} holds ${t.count} but lists or counts ${t.rows + t.rollups + t.more} on screen\n${table}`)
    }
  }
}

test("All projects at the heavy load fits without scrolling and accounts for every open thread", { skip: !enabled, timeout: 900_000 }, async () => {
  const measured = await withLoad(HEAVY, (stack, browser) => measureAll(browser, `${stack.base}/all`, "all-projects-heavy"))
  const table = report("heavy", "all-projects", measured)
  assertFits(measured, 70, table, "All projects at the heavy load (17 projects, 70 open)")
})

test("All projects at David's load shows every pinned, ready and working row, uncompressed", { skip: !enabled, timeout: 900_000 }, async () => {
  const loud = DAVID.projects.flatMap((p) => p.threads.filter((t) => LOUD.has(t.band)).map((t) => t.slug))
  const measured = await withLoad(DAVID, (stack, browser) => measureAll(browser, `${stack.base}/all`, "all-projects-david"))
  const table = report("david", "all-projects", measured)
  for (const m of measured) {
    const shown = new Set(m.visibleIds)
    const missing = loud.filter((slug) => !shown.has(slug))
    assert.deepEqual(missing, [], `All projects at David's load (4 projects, 10 threads) hides loud rows at ${m.viewport}: ${missing.join(", ")}\n${table}`)
  }
})

test("a project's own page at the capacity load fits without scrolling and accounts for every open thread", { skip: !enabled, timeout: 900_000 }, async () => {
  const measured = await withLoad(CAPACITY, (stack, browser) => measureAll(browser, `${stack.base}/project/${stack.projects[0]!.slug}`, "project-capacity"))
  const table = report("capacity", "project", measured)
  assertFits(measured, 70, table, "A project's page with 70 open threads")
})
