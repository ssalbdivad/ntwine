#!/usr/bin/env node
// Seed a MULTI-PROJECT adhoc stack with a realistic spread of threads in every project, so the
// all-queues page (`/queues`) can be judged against something that looks like an operator's machine:
// several projects with queued rests of every shape (a done card, a bare handoff, a registered
// question), threads mid-turn, a snoozed one, archived ones — and one project that is entirely quiet.
//
// Follows the frizz-stack recipe: a session row + a JSONL the REAL tailer reads, and a
// `thread_question` row for a registered ask (no human-facing RPC registers one — only a worker's
// `ask` tool does — so the row IS the fixture and everything downstream of it runs for real).
//
// Usage: node scripts/seed-all-queues.mjs --stack=/abs/stack.log
//   where stack.log is the file adhoc-stack.mjs's stdout was redirected to (its first json line names
//   the sandbox HOME, the launcher and every `--also-project` tenant). Projects are matched by slug;
//   any project the seed has no script for is left empty.
import { execFileSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createRpcClient } from "./lib/rpc-client.mjs"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
)
if (!flags.stack) {
  console.error("usage: node scripts/seed-all-queues.mjs --stack=/abs/stack.log")
  process.exit(1)
}
const line = readFileSync(flags.stack, "utf8").split("\n").find((l) => l.startsWith("{\"url\""))
if (!line) throw new Error(`no stack json line in ${flags.stack} — has the stack finished booting?`)
const stack = JSON.parse(line)
const home = stack.home
const db = join(home, ".frizz", "ui.db")
const projects = [
  { id: stack.launcher.id, slug: stack.launcher.slug, dir: stack.launcher.dir },
  ...stack.tenants.map((t) => ({ id: t.id, slug: t.slug, dir: t.dir })),
]

// ONE stand-in daemon for every mid-turn thread — its only job is to own a pid that answers `kill -0`.
const daemon = spawn("sleep", ["14400"], { detached: true, stdio: "ignore" })
daemon.unref()

const now = Date.now()
const ago = (minutes) => new Date(now - minutes * 60_000).toISOString()
const agoMs = (minutes) => now - minutes * 60_000

function sessionIdFor(projectSlug, slug) {
  const h = createHash("sha256").update(`${projectSlug}/${slug}`).digest("hex")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-9${h.slice(17, 20)}-${h.slice(20, 32)}`
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`

/**
 * One thread.
 *   rest      — minutes ago it came to rest (queued/snoozed/archived shapes)
 *   closing   — the final assistant message (the handoff the queue card renders)
 *   inFlight  — leave the turn mid-tool-call instead, so the thread SPINS (Active band)
 *   question  — a registered question spec, asked at the rest
 *   archived  — Done
 */
function seed(project, t) {
  const dir = realpathSync(project.dir)
  const cwdSlug = dir.replace(/[/.]/g, "-")
  const transcriptDir = join(home, ".claude", "projects", cwdSlug)
  mkdirSync(transcriptDir, { recursive: true })
  const sessionId = sessionIdFor(project.slug, t.slug)
  const started = t.rest + (t.took ?? 18)
  const records = [
    { type: "user", sessionId, cwd: dir, timestamp: ago(started), message: { role: "user", content: [{ type: "text", text: `TASK:\n${t.prompt}` }] } },
    {
      type: "assistant", sessionId, cwd: dir, timestamp: ago(started - 1),
      message: { role: "assistant", id: `m1-${t.slug}`, content: [{ type: "tool_use", id: `r1-${t.slug}`, name: "Read", input: { file_path: `${dir}/README.md` } }] },
    },
    { type: "user", sessionId, cwd: dir, timestamp: ago(started - 1.5), message: { role: "user", content: [{ type: "tool_result", tool_use_id: `r1-${t.slug}`, content: "ok" }] } },
  ]
  if (t.inFlight) {
    records.push({
      type: "assistant", sessionId, cwd: dir, timestamp: ago(t.rest),
      message: { role: "assistant", id: `m2-${t.slug}`, stop_reason: "tool_use", content: [{ type: "tool_use", id: `b1-${t.slug}`, name: "Bash", input: { command: "pnpm test", description: t.gerund ?? "Running the test suite" } }] },
    })
  } else {
    records.push({
      type: "assistant", sessionId, cwd: dir, timestamp: ago(t.rest),
      message: { role: "assistant", id: `m2-${t.slug}`, stop_reason: "end_turn", content: [{ type: "text", text: t.closing }], usage: { input_tokens: 2, output_tokens: 120 } },
    })
  }
  writeFileSync(join(transcriptDir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")
  // A live broker record makes a rest read as an ordinary `turn-idle` rest rather than a dead worker
  // (`exited`), which is what every non-archived thread on a real board is.
  const live = !t.archived
  const broker = live ? "'broker'" : "NULL"
  if (live) {
    const stateDir = join(home, ".frizz", "projects", project.id)
    mkdirSync(join(stateDir, "claude-broker"), { recursive: true })
    const key = createHash("sha256").update(sessionId).digest("hex").slice(0, 16)
    writeFileSync(join(stateDir, "claude-broker", `${key}.json`), JSON.stringify({ sessionId, daemonPid: daemon.pid, socketPath: join(stateDir, "claude-broker", `${t.slug}.sock`) }))
  }
  execFileSync("sqlite3", [
    db,
    `INSERT OR REPLACE INTO session (project_id, slug, session_id, thread_name, spawned_at, title, title_auto, backend, claude_runtime, model, effort, permission_mode, state, unread, exited, archived, rested_at)
     VALUES (${q(project.id)}, ${q(t.slug)}, ${q(sessionId)}, ${q(`frizz-${t.slug}`)}, ${q(ago(started + 1))}, ${q(t.title)}, 0, 'claude', ${broker}, 'opus', 'high', 'default', ${t.archived ? "'archived'" : "'open'"}, ${t.unread ? 1 : 0}, 0, ${t.archived ? 1 : 0}, ${t.inFlight ? "NULL" : q(ago(t.rest))})`,
  ])
  if (t.question) {
    execFileSync("sqlite3", [
      db,
      `INSERT OR REPLACE INTO thread_question (id, project_id, thread_slug, spec, state, answer, delivered, asked_at, settled_at)
       VALUES (${q(`qst_${createHash("sha256").update(`${project.slug}/${t.slug}`).digest("hex").slice(0, 8)}`)}, ${q(project.id)}, ${q(t.slug)}, ${q(JSON.stringify(t.question))}, 'open', NULL, 0, ${agoMs(t.rest)}, NULL)`,
    ])
  }
  console.log(`seeded ${project.slug}/${t.slug}`)
}

const done = (lead, bullets) => `${lead}\n\n\`\`\`done\n${bullets.map((b) => `- ${b}`).join("\n")}\n\`\`\``

const SCRIPTS = {
  "acme-api": [
    {
      slug: "rate-limit-headers", title: "Return rate-limit headers on every response", rest: 4, unread: true,
      prompt: "Add the standard RateLimit-* headers to every API response.",
      closing: "**Needs you** — the headers are in, but the spec draft and GitHub disagree on the reset field.\n\nThe IETF draft sends `RateLimit-Reset` as delta-seconds; GitHub and Stripe send an epoch. Clients written against either will misread the other.",
      question: {
        question: "Send the reset time as seconds-until-reset (the IETF draft) or as an epoch timestamp (what GitHub and Stripe send)?",
        header: "Reset field", kind: "question",
        options: [
          { label: "Seconds until reset", description: "Matches the IETF RateLimit draft; immune to client clock skew", recommended: true },
          { label: "Epoch timestamp", description: "Matches GitHub and Stripe; what most existing SDKs already parse" },
        ],
      },
    },
    {
      slug: "fix-pagination-cursor", title: "Fix the pagination cursor skipping rows", rest: 22,
      prompt: "Customers report that paging through /v2/invoices skips rows when two invoices share a timestamp.",
      closing: done("**Fixed** — the cursor now encodes `(created_at, id)`, so ties no longer skip rows. Landed on `main` as `a41c9e2`.", [
        "**Fixed the tie-break** in `src/pagination/cursor.ts` — the cursor is a `(created_at, id)` pair, compared lexicographically.",
        "**Added a regression test** that pages 500 invoices sharing one timestamp; `pnpm test` green.",
      ]),
    },
    {
      slug: "upgrade-postgres-driver", title: "Upgrade the Postgres driver to v9", rest: 51,
      prompt: "Upgrade pg to v9 and fix whatever breaks.",
      closing: "**Fixed, except** the `LISTEN/NOTIFY` bridge — the driver upgrade is on `main`, but v9 drops the `notification` event's `processId` field and the bridge used it to ignore its own writes.\n\nI left the bridge on the old field behind a shim so nothing regresses; replacing it needs a decision about how the bridge should recognise its own notifications.",
    },
    // THE SAME SLUG AS marketing-site's — a slug is unique only within a project, and every action on
    // the all-queues page must land on the card's own project, never on its namesake's.
    {
      slug: "fix-flaky-login-test", title: "Fix the flaky login test", rest: 30,
      prompt: "The login e2e test fails about one run in ten on CI.",
      closing: done(
        "**Fixed** — the login test waited on a fixed 500ms timeout for the session cookie, and CI's slower runners set it later than that.\n\n" +
          "It now waits on the `Set-Cookie` response itself, so it is as fast as the fastest runner and as patient as the slowest. I ran it 200 times against a runner throttled to a quarter of its CPU and it passed every time; before the change the same loop failed 23 times.\n\n" +
          "Two other tests in `e2e/auth/` used the same fixed wait. They were not flaking yet, but they would on the same runners, so I moved them onto the same helper while I was there.\n\n" +
          "The helper lives in `e2e/support/waitForSession.ts` and is documented beside the other waits; nothing else in the suite used the pattern.",
        [
          "**Replaced the fixed wait** in `e2e/auth/login.spec.ts` with `waitForSession()`, which waits on the response that sets the cookie.",
          "**Moved two sibling tests** onto the same helper before they started flaking.",
          "**Ran it 200 times** on a throttled runner: 200/200 green, against 177/200 before.",
        ],
      ),
    },
    { slug: "trace-slow-checkout", title: "Trace the slow checkout endpoint", rest: 2, inFlight: true, gerund: "Profiling the checkout handler", prompt: "Checkout p99 doubled since Tuesday. Find out why." },
    { slug: "retire-v1-webhooks", title: "Retire the v1 webhook format", rest: 300, archived: true, prompt: "Remove the v1 webhook serializer.", closing: done("**Fixed** — v1 webhooks are gone.", ["**Removed** `src/webhooks/v1.ts` and its fixtures."]) },
  ],
  "marketing-site": [
    {
      slug: "pricing-page-tiers", title: "Line up the pricing tiers on narrow screens", rest: 9, unread: true,
      prompt: "The pricing tiers wrap badly under 420px.",
      closing: done("**Fixed** — the tiers stack cleanly at every width down to 320px, and the CTA stays optically centred.", [
        "**Rebuilt the tier grid** in `src/components/Pricing.tsx` as a container-query layout.",
        "**Captured before/after** at 320, 390 and 768px.",
      ]),
    },
    {
      slug: "hero-copy-variants", title: "Draft hero copy variants for the launch", rest: 35,
      prompt: "Draft three hero headline variants for the launch page.",
      closing: "**Needs you** — three variants are drafted in `copy/hero.md`. They differ in who the page speaks to, which is a positioning call rather than a writing one.",
      question: {
        question: "Which hero headline should the launch page ship with?",
        header: "Hero copy", kind: "question",
        options: [
          { label: "“Ship the queue, not the chaos”", description: "Speaks to team leads; strongest in the five-second test", recommended: true },
          { label: "“Every agent, one board”", description: "Speaks to individual developers; plainest" },
          { label: "“Your agents, finally in order”", description: "Warmest tone; weakest recall in the test" },
        ],
      },
    },
    // acme-api has a thread of the same slug (see there).
    {
      slug: "fix-flaky-login-test", title: "Fix the flaky login test", rest: 26,
      prompt: "The marketing site's login smoke test fails intermittently.",
      closing: done("**Fixed** — the smoke test clicked the login button before hydration finished; it now waits for the form to be interactive.", [
        "**Waited for hydration** in `tests/smoke/login.spec.ts` before clicking.",
      ]),
    },
    { slug: "og-image-generator", title: "Generate OG images at build time", rest: 1, inFlight: true, gerund: "Rendering the OG image templates", prompt: "Generate social cards for every blog post at build time." },
    { slug: "blog-rss-feed", title: "Add an RSS feed for the blog", rest: 3, inFlight: true, gerund: "Validating the feed against the RSS spec", prompt: "Add an RSS feed at /blog/rss.xml." },
  ],
  "billing-worker": [
    {
      slug: "dunning-retry-schedule", title: "Investigate failed dunning retries", rest: 14,
      prompt: "Some failed payments are never retried. Find out why.",
      closing: "**Not fixed** — the retries are scheduled, but the job runner drops any job whose `run_at` is in the past at enqueue time, and dunning computes `run_at` from the invoice date rather than now.\n\nThe fix is a one-line clamp in `jobs/enqueue.ts`, but it changes when 1,240 overdue retries fire — all of them at once on deploy. Next step is to stagger them before landing it.",
    },
    { slug: "stripe-api-bump", title: "Bump the Stripe API version", rest: 600, archived: true, prompt: "Bump Stripe to the 2026-08 API version.", closing: done("**Fixed** — on the 2026-08 API version.", ["**Bumped** the pinned version and regenerated fixtures."]) },
  ],
  "docs-portal": [
    { slug: "search-index-rebuild", title: "Rebuild the docs search index", rest: 1440, archived: true, prompt: "Rebuild the Algolia index.", closing: done("**Fixed** — the index is rebuilt.", ["**Reindexed** 412 pages."]) },
  ],
}

for (const project of projects) {
  for (const thread of SCRIPTS[project.slug] ?? []) seed(project, thread)
}

// FILES THE HANDOFFS NAME, in the projects that name them — and the same relative path in the LAUNCHER
// too. billing-worker's handoff says `jobs/enqueue.ts`; the server resolves a relative path against the
// ASKING project's directory, so on a page that names no project a card that asked through the page's
// own client would link the launcher's copy. The twin is what makes that mistake visible.
for (const project of projects) {
  if (project.slug !== "billing-worker" && project.id !== stack.launcher.id) continue
  mkdirSync(join(project.dir, "jobs"), { recursive: true })
  writeFileSync(join(project.dir, "jobs", "enqueue.ts"), `// ${project.slug}'s job runner\nexport {}\n`)
}
// OPEN every board. adhoc-stack registers its `--also-project` tenants after the server is up, which is
// after the boot-time priming pass has already walked the registry (server/tenant-prime.ts), so without a
// visit they stay closed and the page draws them as "Not open". One read each is the visit.
const origin = new URL(stack.url).origin
for (const project of projects) await createRpcClient(`${origin}/`, project.id).query("board")

// A FINISHED TERMINAL COMMAND in a tenant and in the launcher — the prompt box's Terminal tab, run for
// real through each project's own `commandStart`, so each pty lives on its own project's terminal server.
// A finished run queues with a card of its own, and that card's screen, Restart and Mark as done must
// reach the card's project: a bare `/term/<slug>` on a page that names no project is the LAUNCHER's.
const commands = { "billing-worker": "printf 'billing-worker ran\\n'; exit 3", [stack.launcher.slug]: "printf 'acme-api ran\\n'" }
for (const project of projects) {
  const command = commands[project.slug]
  if (!command) continue
  const api = createRpcClient(`${origin}/`, project.id)
  const { slug } = await api.mutate("commandStart", { command })
  const deadline = Date.now() + 15_000
  while ((await api.query("board")).threads.find((t) => t.id === slug)?.command?.state !== "exited") {
    if (Date.now() > deadline) throw new Error(`${project.slug}'s command ${slug} never finished`)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  console.log(`seeded ${project.slug}/${slug} (terminal command)`)
}
console.log(JSON.stringify({ seeded: projects.map((p) => p.slug), daemonPid: daemon.pid }))
