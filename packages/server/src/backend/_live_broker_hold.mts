// LIVE end-to-end proof of "Send to queue" and of answers riding a follow-up, through the REAL server
// wiring against real claude. Run:  nub packages/server/src/backend/_live_broker_hold.mts
//
// The unit tests (router.test.ts, delivery-ledger.held.test.ts) pin the logic with a stubbed bridge and
// a hand-published turn-done event. What they cannot prove is the seam this feature lives on: that the
// REAL tailer reports a real turn as in-flight when the hold is requested, that its real in-flight →
// idle edge reaches the router over the real bus, and that the message Frizz was holding then starts a
// real next turn — carrying the answers and the note as ONE user turn the model reads.
//
// Proves, with a real daemon and a real tailer:
//   1. a follow-up sent with `hold` while the worker is mid-turn writes a `held` ledger entry and hands
//      the daemon NOTHING: the transcript carries no record of it while the turn runs;
//   2. the registered question it answers settles at once, marked delivered (no second answer wake);
//   3. when the turn ends, the held message is released by itself and opens the next turn;
//   4. that turn's user record is the answers in their wire form with the note under them, and the model
//      acts on BOTH halves (it writes the file the note asks for, containing the option that was picked);
//   5. a held message that is taken back is never delivered.
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createContext } from "../context.ts"
import { createRouter } from "../router.ts"
import { resolveProject } from "../project.ts"
import { parseDeliveryLedger } from "../delivery-ledger.ts"
import { claudeBrokerRecordPath, readBrokerRecord } from "./claude-broker-host.ts"

process.env.FRIZZ_CLAUDE_BROKER_BRIDGE = "1"
// The harness may be run from inside a Claude Code session; the worker must not think it is nested.
delete process.env.CLAUDECODE
delete process.env.CLAUDE_CODE_ENTRYPOINT
const claudeBin = execFileSync("which", ["claude"], { encoding: "utf8" }).trim()
const repo = mkdtempSync(join(tmpdir(), "brk-hold-repo-"))
execFileSync("git", ["init", "-q", repo])
execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "init"])
// A throwaway home for Frizz's own state. resolveProject REGISTERS the directory it resolves, and
// under the real home that is the operator's project list: every run left a dead card on their rail.
const frizzHome = mkdtempSync(join(tmpdir(), "brk-hold-home-"))
const project = resolveProject(repo, frizzHome)

let failures = 0
const ok = (label: string, cond: boolean, detail = "") => { if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`) }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const waitFor = async (cond: () => boolean, ms = 180_000, label = "condition") => {
  const d = Date.now() + ms
  while (!cond()) { if (Date.now() > d) throw new Error(`timeout waiting for ${label}`); await sleep(500) }
}
const fileA = join(repo, "a.txt"), fileB = join(repo, "b.txt"), fileC = join(repo, "c.txt")

let daemonPid: number | undefined
let ctx: Awaited<ReturnType<typeof createContext>> | undefined
try {
  ctx = await createContext({ project, claudeBin })
  const router = createRouter(ctx)
  await ctx.board.start()
  await ctx.tailer.start()

  // A turn long enough to queue behind: a real 20s tool call, then a file. (Not `sleep 20`: Claude
  // Code refuses a long foreground sleep, and the model then improvises.) Nothing below depends on the
  // model obeying to the letter — the claim is about ORDER, and it is read off the transcript.
  const { slug, sessionId } = await ctx.dispatcher.dispatch(
    { prompt: `Run this Bash command exactly once: python3 -c "import time; time.sleep(20)". When it finishes, use the Write tool to create the file ${fileA} containing the text first. Then stop and say nothing else.`, model: "haiku" },
    { backend: "claude" },
  )
  daemonPid = readBrokerRecord(claudeBrokerRecordPath(project.stateDir, sessionId))?.daemonPid
  ok("dispatched a real broker worker", !!slug && !!daemonPid, `${slug} pid ${daemonPid}`)

  const turn = () => ctx!.tailer.get(slug)?.turn
  const ledger = () => parseDeliveryLedger(ctx!.storage.getSession(slug)?.delivery_ledger)
  const transcript = (): string => {
    const dir = join(process.env.HOME ?? "", ".claude", "projects", project.cwdSlug)
    if (!existsSync(dir)) return ""
    return readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => readFileSync(join(dir, f), "utf8")).join("\n")
  }

  // A timeline of the things whose ORDER is the whole claim.
  const t0 = Date.now()
  const events: string[] = []
  const mark = (what: string) => { events.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${what}`) }
  ctx.bus.subscribe((event) => { if (event.type === "notify" && event.slug === slug) mark(`bus ${event.kind}`) })
  let lastState = "", sawA = false, sawB = false, lastTurn = ""
  const watch = setInterval(() => {
    const state = ledger().find((i) => i.id === "d-live-hold")?.state ?? "(none)"
    if (state !== lastState) { lastState = state; mark(`ledger d-live-hold ${state}`) }
    const now = turn() ?? "(unknown)"
    if (now !== lastTurn) { lastTurn = now; mark(`tailer turn ${now}`) }
    if (!sawA && existsSync(fileA)) { sawA = true; mark("file A written") }
    if (!sawB && existsSync(fileB)) { sawB = true; mark("file B written") }
  }, 100)
  watch.unref?.()

  await waitFor(() => turn() === "in-flight", 90_000, "the tailer to see the turn in flight")
  ok("the real tailer reports the turn in flight", turn() === "in-flight")

  // ---- 1+2: hold a message with an answer, mid-turn ----------------------------------------------
  const question = "Which word should the second file contain?"
  ctx.storage.askThreadQuestion({ id: "qst_livehold001", slug, spec: JSON.stringify({ question, kind: "question", options: [{ label: "kumquat" }, { label: "persimmon" }] }), askedAtMs: Date.now() })
  const note = `Use the Write tool to create the file ${fileB} containing only the word picked in the answer above. Then stop.`
  await router.followUp.handler({
    input: { slug, sessionId, message: note, deliveryId: "d-live-hold", hold: true, answers: [{ questionId: "qst_livehold001", question, chosen: ["persimmon"] }] },
  })
  const composed = `Answers to earlier questions:\n1. “${question}” → persimmon\n\nSent with these answers:\n${note}`
  ok("the message is held in the ledger, composed as one turn", ledger().some((i) => i.id === "d-live-hold" && i.state === "held" && i.text === composed), JSON.stringify(ledger().map((i) => [i.id, i.state])))
  ok("the question settled at once", ctx.storage.getThreadQuestion("qst_livehold001")?.state === "answered")
  ok("…and is not left for the scheduler's answer wake", ctx.storage.undeliveredSettlements().length === 0)
  ok("the turn is still running", turn() === "in-flight")
  await sleep(3_000)
  ok("nothing was handed to the daemon while the turn runs", !transcript().includes("persimmon"))

  // A second held message, taken back before the rest: it must never be delivered.
  await router.followUp.handler({ input: { slug, sessionId, message: `Also create the file ${fileC} containing nope.`, deliveryId: "d-live-takeback", hold: true } })
  const back = await router.unqueueFollowUp.handler({ input: { slug, sessionId, deliveryId: "d-live-takeback" } })
  ok("a held message is taken back", back.unqueued === true && !ledger().some((i) => i.id === "d-live-takeback"))

  // ---- 3: the turn ends → Frizz releases it by itself ---------------------------------------------
  await waitFor(() => existsSync(fileB), 300_000, "the released message to run (file B)")
  ok("the held message was released at rest and ran as the next turn", existsSync(fileB))
  // ORDER, read off the transcript itself: the first turn ENDS, and only then does the held message
  // appear — as the user record that opens the next turn. (An idle submit is recorded enqueue →
  // dequeue → user, so the queue operations around it are the SDK's own, not a mid-turn steer.)
  const records = transcript().split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
  const shape = records.map((r) => {
    if (r.type === "assistant") return `assistant:${r.message?.stop_reason ?? "…"}:${(r.message?.content ?? []).map((c: { type: string; name?: string }) => c.name ?? c.type).join("+")}`
    if (r.type === "user") return typeof r.message?.content === "string" ? `user:${r.message.content.slice(0, 28).replace(/\n/g, " ")}` : "user:tool_result"
    if (r.type === "queue-operation") return `queue:${r.operation}`
    return r.type
  })
  console.log("transcript:", shape.join(" | "))
  console.log("timeline:", events.join(" | "))
  const heldAt = shape.findIndex((x) => x.startsWith("user:Answers to earlier"))
  const turnOneEnd = shape.findIndex((x) => x.startsWith("assistant:end_turn"))
  ok("the held message landed AFTER the first turn ended, as the next turn's opening record", turnOneEnd >= 0 && heldAt > turnOneEnd, `end_turn@${turnOneEnd} held@${heldAt}`)
  // …and off Frizz's own side: the release followed the tailer's turn-done edge, never preceded it.
  const edge = events.findIndex((e) => e.endsWith("bus turn-done"))
  const left = events.findIndex((e) => /ledger d-live-hold (sending|delivered|enqueued)/.test(e))
  ok("Frizz released it on the tailer's turn-done edge", edge >= 0 && left > edge, `turn-done@${edge} released@${left}`)

  // ---- 4: one turn, both halves ------------------------------------------------------------------
  const wrote = readFileSync(fileB, "utf8").trim()
  ok("the model acted on the note AND the answer", wrote === "persimmon", JSON.stringify(wrote))
  const delivered = transcript().split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return null } })
    .filter((r) => r?.type === "user" && typeof r.message?.content === "string" && r.message.content.includes("Sent with these answers:"))
  ok("delivered as ONE user turn: the answers, then the note", delivered.length === 1 && delivered[0].message.content.startsWith(composed), `${delivered.length} record(s)`)
  await waitFor(() => !ledger().some((i) => i.id === "d-live-hold"), 60_000, "the ledger to retire the delivered send")
  ok("the ledger retired the send once the transcript had it", !ledger().some((i) => i.id === "d-live-hold"))

  // ---- 5 -----------------------------------------------------------------------------------------
  await waitFor(() => turn() === "idle", 120_000, "the second turn to rest")
  ok("the message that was taken back was never delivered", !existsSync(fileC) && !transcript().includes("containing nope"))

  await router.completeThread.handler({ input: { slug, sessionId, terminateLive: true } })
} catch (err) {
  failures++
  console.log(`\nERROR: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
} finally {
  try { if (daemonPid) process.kill(daemonPid, "SIGKILL") } catch {}
  try {
    if (ctx) {
      ctx.tailer.stop()
      ctx.stopSubscriptions()
      await ctx.scheduler.stop()
      await ctx.board.stop()
      ctx.claudeBroker?.close()
      ctx.storage.close()
    }
  } catch {}
  rmSync(repo, { recursive: true, force: true })
  try { rmSync(frizzHome, { recursive: true, force: true }) } catch {}
  try { rmSync(join(process.env.HOME ?? "", ".claude", "projects", project.cwdSlug), { recursive: true, force: true }) } catch {}
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}
