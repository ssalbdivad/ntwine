// END-TO-END: move a real Claude thread between two ntwine servers on this machine, and back
// (plans/thread-handoff.md § 7).
//
//   node scripts/verify-thread-move.ts [--model=haiku] [--keep] [--shots=<dir>]
//
// Two disposable stacks (scripts/adhoc-stack.mjs), each with its own sandbox HOME, data root, port and
// clone of one bare remote at a DIFFERENT path, so every path rule is exercised: the home, the
// checkout, the Claude bucket. They pair over loopback through the real routes. A real Claude worker
// (`--creds`, real tokens — a few cents on haiku) is told a code word and leaves uncommitted work in
// a worktree; it is moved while resting, asked on the other server for the code word and to keep
// working, then resumed from the mac's stub (Resume here) and asked again. Every check is on the real
// outcome: the files in each checkout, the transcript on each side, the board, the worker's own words.
// `--shots` also photographs the mac's drawer, headless, before and after it resumes the thread there.
//
// What it cannot reach: two real machines over a network (both servers are on 127.0.0.1), and Claude's
// own home being separate (`--creds` links the real ~/.claude into both sandboxes, so both buckets are
// under the real ~/.claude/projects; they are removed at the end).

import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type AddressInfo } from "node:net"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { cwdSlug } from "../packages/server/src/project.ts"
import { createRpcClient } from "./lib/rpc-client.mjs"

const args = process.argv.slice(2)
const model = args.find((a) => a.startsWith("--model="))?.slice(8) ?? "haiku"
const keep = args.includes("--keep")
const shots = args.find((a) => a.startsWith("--shots="))?.slice(8)
const repo = realpathSync(join(import.meta.dirname, ".."))
const root = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-move-e2e-")))
const realHome = homedir()
const stacks: ChildProcess[] = []
let failed = false
/** Set once there is a thread: on a failure, both boards' view of it, before the stacks stop. */
let dumpBoards: (() => Promise<void>) | undefined

const step = (text: string) => console.log(`\n▶ ${text}`)
const ok = (text: string) => console.log(`  ✔ ${text}`)
function check(condition: unknown, text: string): asserts condition {
  if (!condition) {
    failed = true
    throw new Error(`✘ ${text}`)
  }
  ok(text)
}
const git = (cwd: string, ...argv: string[]) => execFileSync("git", argv, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

interface Stack { port: number; slug: string; home: string; project: string }

/** A port nothing listens on now (other agents run stacks on fixed ports; `startServer` cannot take 0). */
const freePort = () => new Promise<number>((done, fail) => {
  const probe = createServer().once("error", fail).listen(0, "127.0.0.1", () => {
    const { port } = probe.address() as AddressInfo
    probe.close(() => done(port))
  })
})

async function boot(name: string, port: number, project: string): Promise<Stack> {
  const home = join(root, name)
  const out = join(root, `${name}.stdout`)
  const child = spawn(process.execPath, ["scripts/adhoc-stack.mjs", `--port=${port}`, `--home=${home}`, `--project=${project}`, "--creds", `--log=${join(root, `${name}.server.log`)}`], {
    cwd: repo, stdio: ["ignore", openSync(out, "w"), openSync(join(root, `${name}.stderr`), "w")], env: { ...process.env, HOME: realHome },
  })
  stacks.push(child)
  for (let i = 0; i < 600; i++) {
    const line = existsSync(out) ? readFileSync(out, "utf8").split("\n").find((l) => l.startsWith("{")) : undefined
    if (line) {
      const info = JSON.parse(line) as { slug: string }
      return { port, slug: info.slug, home, project }
    }
    if (child.exitCode !== null) break
    await sleep(250)
  }
  throw new Error(`${name} did not boot; see ${root}/${name}.stderr`)
}

const clients = new Map<number, { query(m: string, i?: unknown): Promise<unknown>; mutate(m: string, i?: unknown): Promise<unknown> }>()
async function rpc<T>(s: Stack, proc: string, input?: unknown, kind: "query" | "mutation" = "mutation"): Promise<T> {
  let client = clients.get(s.port)
  if (!client) clients.set(s.port, client = createRpcClient(`http://127.0.0.1:${s.port}/`))
  return (kind === "query" ? await client.query(proc, input) : await client.mutate(proc, input ?? {})) as T
}

interface ThreadRow { id: string; sessionId?: string; runtime: string; state?: "open" | "archived"; lastAssistant?: string; lastAssistantAt?: string; movedTo?: { peerName: string; pending?: boolean }; movedFrom?: { peerName: string } }
const thread = async (s: Stack, slug: string) => (await rpc<{ threads: ThreadRow[] }>(s, "board", undefined, "query")).threads.find((t) => t.id === slug)
/** The transcript read as a session ntwine did not start (keyed by its session id): what a moved thread's
 *  files look like to the tailer when its rows are not visible beside them. */
const foreignCopy = async (s: Stack, sessionId: string) =>
  (await rpc<{ threads: ThreadRow[] }>(s, "board", undefined, "query")).threads.some((t) => t.id === sessionId)
/** The board as soon as it satisfies `ok` (a move rebuilds it asynchronously), or as it stands after 15s. */
async function threadWhen(s: Stack, slug: string, ok: (t: ThreadRow | undefined) => unknown): Promise<ThreadRow | undefined> {
  let t = await thread(s, slug)
  for (let i = 0; i < 30 && !ok(t); i++) {
    await sleep(500)
    t = await thread(s, slug)
  }
  return t
}

/** Until the thread's turn has run and come back to rest after `since`. */
async function rested(s: Stack, slug: string, since: number, label: string): Promise<ThreadRow> {
  for (let i = 0; i < 360; i++) {
    const t = await thread(s, slug)
    const at = t?.lastAssistantAt ? Date.parse(t.lastAssistantAt) : 0
    if (t && at > since && (t.runtime === "turn-idle" || t.runtime === "exited")) return t
    if (t?.runtime === "perm-prompt") throw new Error(`${label}: the worker is waiting on a permission prompt`)
    await sleep(2_000)
  }
  throw new Error(`${label}: the thread never came to rest`)
}

const transcriptText = async (s: Stack, slug: string) => JSON.stringify(await rpc<unknown>(s, "threadTranscript", { slug }, "query"))
/** The "Moved to B" dividers on the page the drawer loads (the paginated reader, as the socket push uses). */
const moveDividers = async (s: Stack, slug: string) =>
  (await rpc<{ messages: { boundary?: string; text: string }[] }>(s, "threadTranscript", { slug }, "query")).messages.filter((m) => m.boundary === "moved").map((m) => m.text)

/** A headless shot of the thread's drawer (scripts/shot.mjs), and what its moved lines and notice say.
 *  Never a sync child: a blocked event loop outlives the servers' keep-alive, and the next POST then
 *  goes out on a socket they already closed ("fetch failed"). */
async function shoot(s: Stack, slug: string, name: string): Promise<string> {
  if (!shots) return ""
  mkdirSync(shots, { recursive: true })
  const probe = "({ dividers: [...document.querySelectorAll('[data-wake-divider]')].map((e) => e.textContent).filter((t) => /Moved/.test(t)), notice: document.querySelector('[data-moved-notice]')?.textContent ?? null })"
  const out: string[] = []
  for (const [suffix, w, h] of [["", 1440, 900], ["-narrow", 420, 880]] as const) {
    out.push((await promisify(execFile)(process.execPath, ["scripts/shot.mjs", `http://127.0.0.1:${s.port}/project/${s.slug}/thread/${slug}`, join(shots, `${name}${suffix}.png`), probe, `--w=${w}`, `--h=${h}`, "--wait=3000", "--mouse"], { cwd: repo, encoding: "utf8" })).stdout.trim())
  }
  return out.join("\n")
}

async function main() {
  step(`setting up one bare remote and two clones under ${root}`)
  const remote = join(root, "remote.git")
  git(root, "init", "--bare", "-b", "main", remote)
  const seed = join(root, "seed")
  git(root, "clone", remote, seed)
  writeFileSync(join(seed, "README.md"), "# demo\n")
  mkdirSync(join(seed, "src"))
  writeFileSync(join(seed, "src", "app.txt"), "app\n")
  for (const [k, v] of [["user.name", "e2e"], ["user.email", "e2e@localhost"]]) git(seed, "config", k!, v!)
  git(seed, "add", "-A")
  git(seed, "commit", "-m", "seed")
  git(seed, "push", "origin", "main")
  // Different depths under different homes: the checkout path and the home both change on the move.
  const projectA = join(root, "mac", "code", "demo")
  const projectB = join(root, "desktop", "demo")
  for (const [dir, home] of [[projectA, join(root, "mac")], [projectB, join(root, "desktop")]] as const) {
    mkdirSync(home, { recursive: true })
    git(root, "clone", remote, dir)
    for (const [k, v] of [["user.name", "e2e"], ["user.email", "e2e@localhost"]]) git(dir, "config", k!, v!)
  }

  step("booting two isolated ntwine servers")
  const [a, b] = await Promise.all([boot("mac", await freePort(), projectA), boot("desktop", await freePort(), projectB)])
  ok(`mac on :${a.port} (${a.slug}), desktop on :${b.port} (${b.slug})`)

  step("pairing them through the real routes")
  const code = await rpc<{ code: string }>(a, "peerPairCode", {})
  const macSeenFromDesktop = await rpc<{ id: string; name: string }>(b, "peerPairJoin", { url: `http://127.0.0.1:${a.port}`, code: code.code })
  const desktopId = (await rpc<{ self: { id: string } }>(b, "peersState", undefined, "query")).self.id
  check((await rpc<{ peers: { id: string }[] }>(a, "peersState", undefined, "query")).peers.some((p) => p.id === desktopId), "the mac lists the desktop, and the desktop lists the mac")
  await rpc(a, "peerSetAddress", { id: desktopId, url: `http://127.0.0.1:${b.port}` })
  check((await rpc<{ name: string }>(a, "peerPing", { id: desktopId })).name.length > 0, "the mac reaches the desktop over the encrypted channel")
  const macId = macSeenFromDesktop.id

  step(`dispatching a real Claude worker (${model}) on the mac`)
  const t0 = Date.now()
  const dispatched = await rpc<{ slug: string; sessionId: string }>(a, "dispatch", {
    title: "Move me",
    model,
    effort: "low",
    prompt: [
      "Remember this code word for later: PELICAN-42.",
      "Then, in this repository, run exactly: git worktree add .ntwine/worktrees/feature -b feature",
      "In that new worktree only: append the line `edited on the first machine` to README.md, and create notes/todo.txt containing `step 1 done`.",
      "Do NOT commit anything. When both files are written, reply with the single word READY and stop.",
    ].join("\n"),
  })
  const slug = dispatched.slug
  dumpBoards = async () => {
    for (const [name, s] of [["mac", a], ["desktop", b]] as const) {
      const board = await rpc<{ threads: (ThreadRow & Record<string, unknown>)[] }>(s, "board", undefined, "query").catch((error: Error) => ({ threads: [], error: error.message }))
      const t = board.threads.find((row) => row.id === slug)
      console.error(`${name} board (${board.threads.length} threads): ${t ? JSON.stringify({ runtime: t.runtime, state: t.state, archived: t.archived, movedTo: t.movedTo, movedFrom: t.movedFrom }) : "no such thread"}`)
    }
  }
  const first = await rested(a, slug, t0, "first turn")
  check(/READY/.test(first.lastAssistant ?? ""), `the worker came to rest saying READY (${JSON.stringify(first.lastAssistant)})`)
  const wtA = join(projectA, ".ntwine", "worktrees", "feature")
  check(readFileSync(join(wtA, "README.md"), "utf8").includes("edited on the first machine"), "its uncommitted edit is in the mac's worktree")

  step("previewing the move")
  const preview = await rpc<{ refusal?: string; checkout?: { rel: string; branch: string | null }; wipPaths: string[]; destination?: { dir: string } }>(a, "threadMovePreview", { slug, peerId: desktopId })
  check(!preview.refusal, `no refusal (${preview.refusal ?? "none"})`)
  check(preview.checkout?.rel === ".ntwine/worktrees/feature" && preview.checkout.branch === "feature", "it found the worktree and its branch")
  check(JSON.stringify(preview.wipPaths) === JSON.stringify(["README.md", "notes/todo.txt"]), `the uncommitted files that move: ${preview.wipPaths.join(", ")}`)
  check(preview.destination?.dir === projectB, "the desktop answered with its own checkout of the project")

  step("moving it to the desktop")
  const moved = await rpc<{ slug: string; notes: string[] }>(a, "threadMove", { slug, peerId: desktopId })
  check(moved.slug === slug, `moved as @${moved.slug}${moved.notes.length ? ` (notes: ${moved.notes.join("; ")})` : ""}`)
  const stubDone = (t?: ThreadRow) => t?.movedTo && !t.movedTo.pending && t.state === "archived"
  check(stubDone(await threadWhen(a, slug, stubDone)), "the mac keeps a finished stub naming the desktop")
  check(git(wtA, "status", "--porcelain") === "", "the mac's worktree no longer holds the moved work, so nothing commits it twice")
  await rpc(a, "followUp", { slug, sessionId: dispatched.sessionId, message: "are you there?" }).then(
    () => check(false, "a follow-up to the stub is refused"),
    (error: Error) => check(/moved to/.test(error.message), `a follow-up to the stub is refused: ${error.message.slice(0, 120)}`),
  )
  const wtB = join(projectB, ".ntwine", "worktrees", "feature")
  check(git(wtB, "rev-parse", "--abbrev-ref", "HEAD") === "feature", "the desktop has the worktree on branch feature")
  check(readFileSync(join(wtB, "README.md"), "utf8").includes("edited on the first machine") && readFileSync(join(wtB, "notes", "todo.txt"), "utf8").includes("step 1 done"), "with the uncommitted work in it")
  const bucketB = join(realHome, ".claude", "projects", cwdSlug(projectB))
  const movedLines = readFileSync(join(bucketB, `${dispatched.sessionId}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { cwd?: string })
  check(movedLines.some((l) => l.cwd?.startsWith(projectB)) && !movedLines.some((l) => l.cwd?.startsWith(projectA)), "the transcript sits in the desktop's Claude bucket with its cwd fields mapped")
  const arrived = await threadWhen(b, slug, (t) => t?.movedFrom)
  check(arrived?.movedFrom?.peerName && arrived.state !== "archived", `the desktop's board shows it open, from ${arrived?.movedFrom?.peerName}`)
  check(!(await foreignCopy(b, dispatched.sessionId)), "and not a second time as a session ntwine did not start")

  step("continuing it on the desktop")
  const t1 = Date.now()
  await rpc(b, "followUp", { slug, sessionId: dispatched.sessionId, message: "What was the code word? Then append the line `continued on the second machine` to README.md in the worktree you were working in, and reply with the code word and the absolute path of the file you edited." })
  const second = await rested(b, slug, t1, "turn on the desktop")
  check((second.lastAssistant ?? "").includes("PELICAN-42"), `it remembers the code word: ${JSON.stringify(second.lastAssistant?.slice(0, 200))}`)
  check(readFileSync(join(wtB, "README.md"), "utf8").includes("continued on the second machine"), "it edited the desktop's worktree")
  check(readFileSync(join(wtB, "README.md"), "utf8").includes("edited on the first machine"), "on top of the work that moved")
  check((await transcriptText(b, slug)).includes("This thread moved from"), "its first message on the desktop carried the move note")
  check((await moveDividers(b, slug)).length === 1, `the desktop's conversation marks where it arrived: ${(await moveDividers(b, slug)).join(" | ")}`)
  check((await moveDividers(a, slug)).length === 1, `and so does the mac's stub, where it left: ${(await moveDividers(a, slug)).join(" | ")}`)
  const stubShot = await shoot(a, slug, "stub")
  if (shots) check(/Resume here/.test(stubShot) && /Moved (to|here)/.test(stubShot), `the mac's drawer shows the divider and Resume here: ${stubShot.split("\n")[0]?.slice(0, 300)}`)

  step("resuming it on the mac, from its stub")
  // The desktop can no longer reach the mac: a recall needs only the asker to reach the holder, which is
  // the real case where one machine cannot resolve the other's name.
  await rpc(b, "peerSetAddress", { id: macId, url: "http://127.0.0.1:9" })
  const back = await rpc<{ slug: string; notes: string[] }>(a, "threadMoveRecall", { slug })
  check(back.slug === slug, `resumed here${back.notes.length ? ` (notes: ${back.notes.join("; ")})` : ""}`)
  await rpc(a, "threadMoveRecall", { slug }).then(
    () => check(false, "a second Resume here is refused"),
    (error: Error) => check(/already on this machine/.test(error.message), `a second Resume here is refused: ${error.message}`),
  )
  const live = (t?: ThreadRow) => t && !t.movedTo && t.movedFrom && t.state !== "archived"
  check(live(await threadWhen(a, slug, live)), "the mac's stub is a live thread again")
  check(!(await foreignCopy(a, dispatched.sessionId)), "and not a second time as a session ntwine did not start")
  check(readFileSync(join(wtA, "README.md"), "utf8").includes("continued on the second machine"), "the mac's worktree has the desktop's work")
  check(stubDone(await threadWhen(b, slug, stubDone)), "the desktop now keeps the stub")
  const t2 = Date.now()
  await rpc(a, "followUp", { slug, sessionId: dispatched.sessionId, message: "Back home. Reply with the code word only." })
  const third = await rested(a, slug, t2, "turn back on the mac")
  check((third.lastAssistant ?? "").includes("PELICAN-42"), `it still remembers: ${JSON.stringify(third.lastAssistant?.slice(0, 120))}`)
  check((await moveDividers(a, slug)).length === 2, `the mac's conversation marks both moves: ${(await moveDividers(a, slug)).join(" | ")}`)
  const homeShot = await shoot(a, slug, "resumed")
  if (shots) check(!/Resume here/.test(homeShot), `the resumed drawer has no notice: ${homeShot.split("\n")[0]?.slice(0, 300)}`)

  step("the audit trail")
  // Wherever the sandbox's data root put it (ntwinePaths picks by platform); `.claude` is a link, so find skips it.
  const audit = (dir: string) => {
    const path = execFileSync("find", [dir, "-name", "audit.jsonl", "-path", "*/logs/*"], { encoding: "utf8" }).trim().split("\n").find(Boolean)
    return path ? readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { action: string; outcome: string }) : []
  }
  const actions = (dir: string) => audit(dir).filter((r) => r.action.startsWith("peer") || r.action.startsWith("threadMove")).map((r) => `${r.action}:${r.outcome}`)
  check(JSON.stringify(actions(a.home)) === JSON.stringify(["peerPair:ok", "threadMoveOut:ok", "threadMoveIn:ok"]), `mac: ${actions(a.home).join(", ")}`)
  check(JSON.stringify(actions(b.home)) === JSON.stringify(["peerPair:ok", "threadMoveIn:ok", "threadMoveOut:ok"]), `desktop: ${actions(b.home).join(", ")}`)
}

async function cleanup(removeFiles: boolean) {
  for (const child of stacks) child.kill("SIGTERM")
  await Promise.all(stacks.map((child) => (child.exitCode !== null ? undefined : new Promise((done) => child.once("exit", done)))))
  // Broker daemons are detached on purpose (they outlive a server), so end the ones these stacks
  // forked: every one carries this run's unique root in its environment.
  try {
    // With each process's environment: BSD ps spells it -E, procps a bare `e`.
    const ps = execFileSync("ps", process.platform === "darwin" ? ["-axEww", "-o", "pid=,command="] : ["axeww", "-o", "pid=,command="], { encoding: "utf8" })
    const signalled: number[] = []
    for (const line of ps.split("\n")) {
      if (!line.includes(root)) continue
      const pid = Number(line.trim().split(/\s+/)[0])
      if (pid && pid !== process.pid) try { process.kill(pid, "SIGTERM"); signalled.push(pid) } catch {}
    }
    // A worker writes on its way out (an MCP log under its HOME), so the files go only once it has.
    const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
    for (let waited = 0; waited < 10_000 && signalled.some(alive); waited += 200) await sleep(200)
  } catch {}
  if (!removeFiles) return console.log(`\nkept ${root} and its Claude buckets under ~/.claude/projects (cwd slugs of its two clones)`)
  for (const project of [join(root, "mac", "code", "demo"), join(root, "desktop", "demo")]) {
    const bucket = join(realHome, ".claude", "projects", cwdSlug(project))
    if (bucket.includes("ntwine-move-e2e-")) rmSync(bucket, { recursive: true, force: true })
  }
  rmSync(root, { recursive: true, force: true })
}

try {
  await main()
  console.log("\nALL CHECKS PASSED")
} catch (error) {
  failed = true
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  await dumpBoards?.().catch(() => {})
} finally {
  // Stacks and their detached workers always stop; the files stay for inspection after a failure.
  await cleanup(!failed && !keep)
  process.exit(failed ? 1 : 0)
}
