// LIVE PROBE: the COALESCING hazard — can cancelling one queued message destroy a DIFFERENT one the
// operator never retracted, and lie about it?
//   nub packages/server/src/backend/_live_sdk_cancel_coalesced.mts
//
// The SDK's own .d.ts (SDKControlInterruptResponse.still_queued) says:
//
//   "uuids still in the queue are individually cancellable via cancel_async_message; once a batch is
//    dequeued and coalesced into one turn, cancelling a NON-representative member uuid is a no-op
//    (its content still runs), while cancelling the batch-representative uuid drops the WHOLE
//    coalesced batch — in both cases the cancel response reports cancelled:false"
//
// If that is reachable, ntwine's unqueue has a SILENT DESTRUCTION path, because `cancelled:false` is
// exactly what ntwine renders as "the agent already picked that message up — it's on its way":
//   · ntwine writes no tombstone, so every bubble stays on screen looking delivered;
//   · but B — which the operator never touched — never runs, and nothing anywhere says so.
//
// _live_sdk_cancel_queued.mts already covered the EASY case (both still in the queue: cancelling A
// left B untouched and B ran). This one deliberately aims at the window AFTER the drain begins.
//
// The experiment: queue A and B behind a short first turn, then fire the cancel at A the instant that
// turn's result lands — the moment the drain loop coalesces the queue into the next turn. Repeat a few
// times, since the window is a race and one miss proves nothing.
//
// RESULT, 2026-07-28, claude 2.1.220 / SDK 0.3.207, 9 rounds across two probe designs: the hazard was
// never reached. Every round answered `false` honestly and BOTH messages ran. The coalescing control
// below (one `queued_command` attachment carrying both prompts) never fired, so this is INCONCLUSIVE
// rather than a clean bill of health — read the verdict line, not the absence of failures.
//
// So ntwine does not depend on the answer. `cancelled:false` is surfaced as "that message has already
// left the queue", never as "the agent has it", and a refusal writes no tombstone — so anything ntwine
// could not retract keeps rendering as an undelivered gray bubble under either reading. This probe
// stays here to be re-run against future CLI builds, and to be extended if someone finds the shape
// that does coalesce (`turns` is reported per round because a single result covering both messages is
// the other candidate signal, and the two did not agree here).
import { query } from "@ntwine/claude-agent-sdk-runtime"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"

const claude = execFileSync("which", ["claude"], { encoding: "utf8" }).trim()
const env = Object.fromEntries(["PATH", "HOME", "USER", "LANG", "SHELL", "TMPDIR", "CLAUDE_CODE_OAUTH_TOKEN"].filter((k) => process.env[k]).map((k) => [k, process.env[k]!]))
const ROUNDS = Number(process.env.ROUNDS ?? 4)

type Round = { round: number; cancelledAnswer: boolean | string; aRan: boolean; bRan: boolean; coalesced: boolean | null; turns: number; note: string }
const rounds: Round[] = []

for (let round = 1; round <= ROUNDS; round++) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-coalesce-")))
  execFileSync("git", ["init", "-q", cwd])
  const A = randomUUID()
  const B = randomUUID()
  const inbox: unknown[] = []
  let wake: (() => void) | undefined
  let done = false
  const push = (uuid: string, content: string) => {
    inbox.push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, uuid, session_id: "" })
    wake?.()
  }
  async function* prompt(): AsyncGenerator<unknown> {
    while (!done) {
      while (inbox.length) yield inbox.shift()!
      if (done) return
      await new Promise<void>((r) => { wake = r; setTimeout(r, 50) })
    }
  }

  const said: string[] = []
  let results = 0
  let sessionId = ""
  const q = query({
    prompt: prompt() as never,
    options: { cwd, env, pathToClaudeCodeExecutable: claude, permissionMode: "bypassPermissions", settingSources: [], persistSession: true } as never,
  }) as unknown as AsyncIterable<Record<string, unknown>> & { cancelAsyncMessage(uuid: string): Promise<unknown> }

  let cancelledAnswer: boolean | string = "<never fired>"
  const pump = (async () => {
    for await (const raw of q) {
      const m = raw as Record<string, any>
      if (m.type === "system" && m.subtype === "init") sessionId = m.session_id
      if (m.type === "assistant") {
        const text = (m.message?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join(" ")
        if (text.trim()) said.push(text)
      }
      if (m.type === "result") {
        results++
        // THE WINDOW. The drain loop starts the next queued turn immediately after this result, so
        // firing here is the closest a client can get to "the batch has just been coalesced".
        if (results === 1) {
          try { cancelledAnswer = (await q.cancelAsyncMessage(A)) as boolean } catch (e) { cancelledAnswer = `THREW ${e instanceof Error ? e.message : String(e)}` }
        }
      }
    }
  })()

  try {
    // A first turn that ends QUICKLY and predictably — the point is to control when the drain begins,
    // not to be mid-tool.
    push(randomUUID(), "Reply with exactly BOOT-DONE and stop. Do not use any tools.")
    // Queue both while that turn is still running.
    await new Promise((r) => setTimeout(r, 700))
    push(A, "MSG-ALPHA: reply with exactly ALPHA-RAN.")
    push(B, "MSG-BRAVO: reply with exactly BRAVO-RAN.")
    // Let everything settle: BOOT's result, the cancel, and whatever turn(s) the queue produces.
    const deadline = Date.now() + 180_000
    while (Date.now() < deadline && !(said.some((t) => /ALPHA-RAN/.test(t)) && said.some((t) => /BRAVO-RAN/.test(t)))) {
      if (results >= 3) break
      await new Promise((r) => setTimeout(r, 500))
    }
    await new Promise((r) => setTimeout(r, 6_000))
  } finally {
    done = true; wake?.()
    await Promise.race([pump.catch(() => {}), new Promise((r) => setTimeout(r, 4_000))])
  }

  const all = said.join("\n")
  const aRan = /ALPHA-RAN/.test(all)
  const bRan = /BRAVO-RAN/.test(all)
  // THE CONTROL. Did this round actually REACH the coalesced state the hazard needs? When the CLI
  // coalesces a batch it writes ONE `queued_command` attachment whose prompt is the CONCATENATION of
  // the sends (delivery-ledger.ts documents the same shape from the other side). Two separate
  // attachments means the queue drained one at a time and the hazard was never in play — in which
  // case a clean result proves nothing at all.
  let coalesced: boolean | null = null
  try {
    const jsonl = readFileSync(join(homedir(), ".claude", "projects", cwd.replace(/\//g, "-"), `${sessionId}.jsonl`), "utf8")
    const prompts: string[] = []
    for (const line of jsonl.split("\n")) {
      if (!line.trim()) continue
      let rec: Record<string, any>
      try { rec = JSON.parse(line) } catch { continue }
      const att = rec.type === "attachment" ? rec.attachment : undefined
      if (att?.type === "queued_command" && att.commandMode === "prompt" && typeof att.prompt === "string") prompts.push(att.prompt)
    }
    coalesced = prompts.some((p) => p.includes("MSG-ALPHA") && p.includes("MSG-BRAVO"))
  } catch { coalesced = null }
  // `typeof` rather than `=== true`: TS narrows `cancelledAnswer` to its initializer's type, because
  // the real assignments happen inside the pump closure where flow analysis cannot follow them.
  const note = typeof cancelledAnswer !== "boolean"
    ? String(cancelledAnswer)
    : cancelledAnswer
      ? (bRan ? "clean cancel, sibling survived" : "cancel reported TRUE but the sibling ALSO vanished")
      : (bRan ? (aRan ? "too late: both ran (honest refusal)" : "A dropped anyway, B survived") : "*** SILENT LOSS: refused, yet B never ran ***")
  rounds.push({ round, cancelledAnswer, aRan, bRan, coalesced, turns: results, note })
  console.log(`round ${round}: cancel(A)=${String(cancelledAnswer)}  A ran=${aRan}  B ran=${bRan}  turns=${results}  coalesced=${String(coalesced)}  — ${note}`)
  rmSync(cwd, { recursive: true, force: true })
}

console.log("\n──────── VERDICT ────────")
// The failure that matters: ntwine rendered "already delivered" (false) while a message the operator
// never touched was destroyed.
const silentLoss = rounds.filter((r) => r.cancelledAnswer === false && !r.bRan)
const trueButLost = rounds.filter((r) => r.cancelledAnswer === true && !r.bRan)
const reached = rounds.filter((r) => r.coalesced === true)
console.log(`rounds: ${rounds.length}  |  rounds that actually REACHED the coalesced state: ${reached.length}`)
console.log(`SILENT LOSS (refused as 'already delivered', but the untouched sibling never ran): ${silentLoss.length}`)
console.log(`cancel said TRUE but the untouched sibling also vanished:                          ${trueButLost.length}`)
const clean = silentLoss.length === 0 && trueButLost.length === 0
if (!clean) console.log("\nCOLLATERAL LOSS IS REAL — a message the operator never retracted was destroyed.")
else if (reached.length === 0) console.log("\nINCONCLUSIVE — no round reached a coalesced batch, so the hazard was never actually exercised.")
else console.log(`\nNo collateral loss in ${reached.length} round(s) that DID coalesce — cancelling one member never destroyed the other.`)
process.exit(clean && reached.length > 0 ? 0 : 1)
