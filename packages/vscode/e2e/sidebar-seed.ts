// WHAT THE REAL-PAGE SIDEBAR RUN SEEDS — a board that looks like an operator's, in the stack e2e/stack.ts
// booted, the ntwine-stack way: session rows and JSONL transcripts the REAL tailer reads, never a worker.
//
//  - scripts/seed-all-queues.mjs: every project's queue — handoffs, done cards, a registered question,
//    threads mid-turn, archived ones (it knows `acme-api` and `marketing-site` by slug).
//  - in the WORKSPACE project (the folder VS Code opens): the files the run selects, links and breaks
//    (src/sample.ts, a.ts, b.ts, and broken.ts with a real TypeScript error), and one rested thread,
//    "Tidy the sample loop", whose handoff links a code file with a range, a Markdown file and a web page.
//    Its worker is SIMULATED (e2e/fake-broker.ts): a process the server adopts as that thread's broker
//    daemon, which takes a follow-up the page sends and writes it into the transcript as Claude would.
//
// Runs in the harness (Node), never inside the editor.

import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { closeSync, existsSync, mkdirSync, openSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Stack, StackProject } from "./stack.ts"
import { stubbedPath } from "./stack.ts"

export const SAMPLE = [
  "export function sample(xs: number[]): number {",
  "  let total = 0",
  "  for (const x of xs) {",
  "    total += x",
  "  } // the loop's end, long enough for a column",
  "  return total",
  "}",
  "",
].join("\n")

/** The TypeScript error the run asks ntwine to fix, at line 3 (1-based). */
export const BROKEN = ["// A real type error for the quick fix.", "", 'export const count: number = "three"', ""].join("\n")

export interface SeededThread {
  slug: string
  title: string
  /** How the page's list names it: a thread's handle, its title in kebab case (web/src/groups.ts displayTitle). */
  handle: string
  sessionId: string
  jsonl: string
}

export interface Seeded {
  workspace: StackProject
  files: { sample: string; a: string; b: string; broken: string; readme: string }
  thread: SeededThread
  /** The simulated worker's process; the inputs it took are JSON lines in `inputs`. */
  broker: ChildProcess
  inputs: string
}

const q = (value: string) => `'${value.replace(/'/gu, "''")}'`

export async function seedSidebarStack(options: { stack: Stack; workspace: StackProject; scratch: string; log(line: string): void }): Promise<Seeded> {
  const { stack, workspace, scratch, log } = options
  const { home } = stack.info
  const repo = join(import.meta.dirname, "..", "..", "..")
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, PATH: stubbedPath(stack.stubs) }
  delete env.NTWINE_E2E_UNDER_XVFB

  // The workspace's files, before anything reads the project.
  const dir = workspace.dir
  mkdirSync(join(dir, "src"), { recursive: true })
  const files = {
    sample: join(dir, "src", "sample.ts"),
    a: join(dir, "src", "a.ts"),
    b: join(dir, "src", "b.ts"),
    broken: join(dir, "src", "broken.ts"),
    readme: join(dir, "README.md"),
  }
  writeFileSync(files.sample, SAMPLE)
  writeFileSync(files.a, "export const alpha = 1\nexport const beta = 2\nexport const gamma = 3\n")
  writeFileSync(files.b, "export const b = 1\n")
  writeFileSync(files.broken, BROKEN)
  writeFileSync(join(dir, "tsconfig.json"), `${JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: "es2022", module: "esnext" }, include: ["src"] }, null, 2)}\n`)
  writeFileSync(files.readme, "# marketing-site\n\nNotes on the sample loop live here.\n")

  // Every project's queue. Its stand-in daemon (a `sleep`) carries the sandbox HOME, so the stack's
  // teardown finds it; a terminal it opens lives on the server and goes with it.
  const seedLog = join(scratch, "seed.log")
  const out = openSync(seedLog, "w")
  try {
    execFileSync(process.execPath, ["scripts/seed-all-queues.mjs", `--stack=${stack.logFile}`], { cwd: repo, env, stdio: ["ignore", out, out], timeout: 120_000 })
  } catch (error) {
    throw new Error(`scripts/seed-all-queues.mjs failed (${(error as Error).message}); see ${seedLog}`)
  } finally {
    closeSync(out)
  }
  log(`seeded every project's queue (${seedLog})`)

  // The workspace's own thread, with a simulated worker.
  const thread: SeededThread = { slug: "tidy-sample-loop", title: "Tidy the sample loop", handle: "tidy-the-sample-loop", sessionId: "e2e51de0-0000-4000-8000-0000000051de", jsonl: "" }
  const transcripts = join(home, ".claude", "projects", dir.replace(/[/.]/gu, "-"))
  mkdirSync(transcripts, { recursive: true })
  thread.jsonl = join(transcripts, `${thread.sessionId}.jsonl`)
  const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
  const closing = [
    "**Done** — the sample's loop is tidied, and the constants it reads are split out.",
    "",
    `The change is in [a.ts](${files.a}#L2-L3), and the notes are in [the readme](${files.readme}).`,
    "",
    "The format follows [the spec](https://example.com/spec).",
  ].join("\n")
  const records = [
    { type: "user", sessionId: thread.sessionId, cwd: dir, timestamp: at(14), message: { role: "user", content: [{ type: "text", text: "TASK:\nTidy the sample loop and split out its constants" }] } },
    { type: "assistant", sessionId: thread.sessionId, cwd: dir, timestamp: at(5), message: { role: "assistant", id: "m-tidy", stop_reason: "end_turn", content: [{ type: "text", text: closing }], usage: { input_tokens: 2, output_tokens: 60 } } },
  ]
  writeFileSync(thread.jsonl, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`)

  // The simulated worker first, so the record below names a live process.
  const socketPath = join(scratch, "broker.sock")
  const inputs = join(scratch, "broker-inputs.jsonl")
  writeFileSync(inputs, "")
  const brokerLog = openSync(join(scratch, "fake-broker.log"), "w")
  const broker = spawn(process.execPath, [join(import.meta.dirname, "fake-broker.ts"), `--socket=${socketPath}`, `--jsonl=${thread.jsonl}`, `--session=${thread.sessionId}`, `--cwd=${dir}`, `--inputs=${inputs}`], {
    env, stdio: ["ignore", brokerLog, brokerLog],
  })
  closeSync(brokerLog)
  const deadline = Date.now() + 15_000
  while (!existsSync(socketPath)) {
    if (broker.exitCode !== null || Date.now() > deadline) throw new Error(`the simulated worker did not listen; see ${join(scratch, "fake-broker.log")}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const stateDir = join(home, ".ntwine", "projects", workspace.id)
  const key = createHash("sha256").update(thread.sessionId).digest("hex").slice(0, 16)
  mkdirSync(join(stateDir, "claude-broker"), { recursive: true })
  writeFileSync(join(stateDir, "claude-broker", `${key}.json`), JSON.stringify({ daemonPid: broker.pid, socketPath, sessionId: thread.sessionId, generation: "e2e-simulated", createdAt: at(14), capabilities: [] }))
  execFileSync("sqlite3", ["-cmd", ".timeout 10000", join(home, ".ntwine", "ui.db"),
    `INSERT OR REPLACE INTO session (project_id, slug, session_id, thread_name, spawned_at, title, title_auto, backend, claude_runtime, model, effort, permission_mode, state, unread, exited, archived, rested_at)
     VALUES (${q(workspace.id)}, ${q(thread.slug)}, ${q(thread.sessionId)}, ${q(`ntwine-${thread.slug}`)}, ${q(at(15))}, ${q(thread.title)}, 0, 'claude', 'broker', 'opus', 'high', 'default', 'open', 1, 0, 0, ${q(at(5))})`])
  log(`seeded ${workspace.slug}/${thread.slug}, its simulated worker pid ${broker.pid} on ${socketPath}`)

  // The board reads it in.
  const board = await fetch(`${stack.origin}/_ntwine/${workspace.id}/rpc/board`, { headers: { "sec-fetch-site": "same-origin" } })
  const body = (await board.json()) as { result?: { threads?: { id: string }[] } }
  if (!body.result?.threads?.some((t) => t.id === thread.slug)) {
    // The tailer picks a new row up on its own pass; give it one.
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
  return { workspace, files, thread, broker, inputs }
}

/**
 * A thread working in its OWN git worktree of the workspace, at `.ntwine/worktrees/<slug>` as ntwine's
 * worktree hook makes one — for the run whose window is opened ON that worktree (e2e-sidebar.ts
 * `--worktree`, check c12). No worker: the transcript's `cwd` is the worktree, and that is what the REAL
 * tailer lifts into the thread's `checkout`, exactly as it does for a Claude worker that works there.
 * Resolves once the board says the thread works in that worktree, so the window opened next finds it.
 *
 * Its handoff links a file by its path IN THE WORKTREE that only the main checkout has (`onlyMain`, written
 * after the worktree was made and never committed) — the shape of a link after Done removed the worktree
 * the work was merged from, without having to remove it under the open window.
 */
export async function seedWorktreeThread(options: { stack: Stack; workspace: StackProject; log(line: string): void }): Promise<SeededThread & { dir: string; onlyMain: { linked: string; main: string } }> {
  const { stack, workspace, log } = options
  const { home } = stack.info
  const thread: SeededThread & { dir: string } = {
    slug: "polish-pricing", title: "Polish the pricing page", handle: "polish-the-pricing-page",
    sessionId: "e2e5170e-0000-4000-8000-00000000017e", jsonl: "", dir: join(workspace.dir, ".ntwine", "worktrees", "polish-pricing"),
  }
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=ntwine e2e", "-c", "user.email=e2e@ntwine.invalid", "-C", workspace.dir, ...args], { stdio: "ignore" })
  git("worktree", "add", "-q", thread.dir, "-b", thread.slug)
  const onlyMain = { linked: join(thread.dir, "src", "only-main.ts"), main: join(workspace.dir, "src", "only-main.ts") }
  mkdirSync(join(workspace.dir, "src"), { recursive: true })
  writeFileSync(onlyMain.main, "// Only the main checkout has this file.\nexport const merged = true\n")
  const transcripts = join(home, ".claude", "projects", workspace.dir.replace(/[/.]/gu, "-"))
  mkdirSync(transcripts, { recursive: true })
  thread.jsonl = join(transcripts, `${thread.sessionId}.jsonl`)
  const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
  const records = [
    { type: "user", sessionId: thread.sessionId, cwd: thread.dir, timestamp: at(30), message: { role: "user", content: [{ type: "text", text: `TASK:\n${thread.title}` }] } },
    { type: "assistant", sessionId: thread.sessionId, cwd: thread.dir, timestamp: at(20), message: { role: "assistant", id: "m-polish", stop_reason: "end_turn", content: [{ type: "text", text: `The pricing page is polished in this worktree; the flag is in [only-main.ts](${onlyMain.linked}#L2).` }], usage: { input_tokens: 2, output_tokens: 12 } } },
  ]
  writeFileSync(thread.jsonl, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`)
  execFileSync("sqlite3", ["-cmd", ".timeout 10000", join(home, ".ntwine", "ui.db"),
    `INSERT OR REPLACE INTO session (project_id, slug, session_id, thread_name, spawned_at, title, title_auto, backend, claude_runtime, model, effort, permission_mode, state, unread, exited, archived, rested_at)
     VALUES (${q(workspace.id)}, ${q(thread.slug)}, ${q(thread.sessionId)}, ${q(`ntwine-${thread.slug}`)}, ${q(at(31))}, ${q(thread.title)}, 0, 'claude', 'broker', 'opus', 'high', 'default', 'open', 0, 0, 0, ${q(at(20))})`])
  const deadline = Date.now() + 60_000
  for (;;) {
    const board = await fetch(`${stack.origin}/_ntwine/${workspace.id}/rpc/board`, { headers: { "sec-fetch-site": "same-origin" } })
    const body = (await board.json()) as { result?: { threads?: { id: string; checkout?: { dir: string } }[] } }
    if (body.result?.threads?.some((t) => t.id === thread.slug && t.checkout?.dir === thread.dir)) break
    if (Date.now() > deadline) throw new Error(`the board never read ${thread.slug} as working in ${thread.dir}`)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  log(`seeded ${workspace.slug}/${thread.slug}, working in its worktree ${thread.dir}`)
  return { ...thread, onlyMain }
}
