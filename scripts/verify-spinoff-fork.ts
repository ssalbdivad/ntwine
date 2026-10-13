#!/usr/bin/env nub
// verify-spinoff-fork.ts — the CLAUDE SPINOFF ROUTE, end to end: a Spinoff on a Claude thread FORKS the
// parent's session into the new thread (router.ts forkSpinoff), on a REAL Ntwine with REAL haiku workers.
//
// What it proves:
//   (a) THE PARENT IS UNTOUCHED. Its transcript is byte-identical before and after the spinoff (no request
//       is ever delivered to it), and its board state — done fence, rest time, unread, queue place — is
//       exactly what it was. Its chat gains the spinoff card, linked to the child, and nothing else.
//   (b) THE CHILD IS NOT POLLUTED by the conversation it inherited: none of the parent's fence, background
//       shell or title is the child's, and its chat opens on the spinoff header (the human's instructions,
//       no brief) with nothing of the parent's conversation above it.
//   (c) THE CHILD HAS THE PARENT'S CONTEXT: it answers with a codeword that exists only in the parent's
//       conversation. NEGATIVE CONTROL: a plain dispatch asked the same question does NOT know it — so
//       the harness can tell a fork from a cold start.
//   (d) MID-TURN: a spinoff requested while the parent is running a foreground command starts the child
//       while the parent keeps running, and the parent's turn finishes as it would have — its transcript
//       never sees the request.
//   (e) is NOT here: every other parent (Codex, ACP, cross-project, no transcript yet) takes the summary
//       route, pinned by router.spinoff-fork.test.ts (real router + real dispatcher, stubbed bridges).
//
// Needs a stack booted from THIS checkout with real credentials:
//
//   P=/tmp/spinoff-fork-proj; rm -rf $P; mkdir -p $P && git -C $P init -q && printf '# Demo\n\nA tiny demo repo.\n' > $P/README.md && git -C $P add -A && git -C $P commit -qm init
//   nub scripts/adhoc-stack.mjs --port=45961 --project=/tmp/spinoff-fork-proj --creds > /tmp/spinoff-fork-stack.log 2>&1 &
//   nub scripts/verify-spinoff-fork.ts --url=http://127.0.0.1:45961/ --home=<the stack's "home"> --project=/tmp/spinoff-fork-proj
//
// Exits 1 on any failed assertion; stops every thread it started (killAgent) on the way out. Clean up
// afterwards: the stack by its PID, the throwaway repo, and ~/.claude/projects/-tmp-spinoff-fork-proj.
import { createHash } from "node:crypto"
import { readFileSync, realpathSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { createRpcClient } from "./lib/rpc-client.mjs"
import { resolveSandboxDb } from "./lib/sandbox-db.mjs"

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3)
const url = arg("url")
const home = arg("home")
const projectDir = arg("project")
if (!url || !home || !projectDir) {
  console.error("usage: verify-spinoff-fork.ts --url=<stack url> --home=<stack home> --project=<its project dir>")
  process.exit(2)
}

const api = createRpcClient(url)
const { db: dbPath } = resolveSandboxDb(home)
type Row = { slug: string; session_id: string; rested_at: string | null; unread: number; state: string; title: string | null; fork_anchor: string | null }
const sessionRow = (slug: string): Row => {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    return db.prepare("SELECT slug, session_id, rested_at, unread, state, title, fork_anchor FROM session WHERE slug = ?").get(slug) as Row
  } finally {
    db.close()
  }
}
const logDir = join(realpathSync(join(home, ".claude")), "projects", projectDir.replace(/[^A-Za-z0-9]/g, "-"))
const transcriptFile = (slug: string) => join(logDir, `${sessionRow(slug).session_id}.jsonl`)
const digest = (slug: string) => createHash("sha256").update(readFileSync(transcriptFile(slug))).digest("hex")

let failures = 0
const check = (ok: unknown, what: string, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const started: string[] = []

// deno-lint-ignore no-explicit-any
type Thread = any
async function boardThread(slug: string): Promise<Thread | undefined> {
  const board = await api.query("board")
  return board.threads.find((t: Thread) => t.id === slug)
}

/** Wait for `pred(thread)`; give up early when the thread has errored out. */
async function waitFor(what: string, slug: string, pred: (t: Thread) => boolean, timeoutMs: number): Promise<Thread> {
  const start = Date.now()
  for (;;) {
    const t = await boardThread(slug)
    if (t && pred(t)) return t
    if (t?.authFault || t?.providerError) throw new Error(`${slug} errored while waiting for ${what}: ${JSON.stringify(t.authFault ?? t.providerError)}`)
    if (Date.now() - start > timeoutMs) throw new Error(`timed out after ${timeoutMs / 1000}s waiting for ${what} on ${slug} (runtime: ${t?.runtime}, fence: ${JSON.stringify(t?.lastFence)})`)
    await sleep(1500)
  }
}

const atRest = (t: Thread) => Boolean(t) && (t.runtime === "turn-idle" || t.runtime === "exited") && !(t.subAgents ?? []).some((s: Thread) => s.state === "running")
const transcript = async (slug: string): Promise<Thread[]> => (await api.query("threadTranscript", { slug })).messages
const edgeOf = (t: Thread, id: string) => t?.spinoffs?.find((o: Thread) => o.id === id)
const profile = { model: "haiku", effort: "low" }
const CODEWORD = "MARMALADE-4471"
const QUESTION = "What is the deploy codeword? Answer in your sign-off with the codeword alone, or with the word UNKNOWN if you do not know it. Do not search files or run commands for it."

async function spinoffAndWaitForChild(parentSlug: string, instructions: string): Promise<{ id: string; childSlug: string; ms: number }> {
  const t0 = Date.now()
  const { id } = await api.mutate("spinoff", { slug: parentSlug, sessionId: sessionRow(parentSlug).session_id, instructions })
  const ms = Date.now() - t0
  const withChild = await waitFor("the spinoff's child", parentSlug, (t) => Boolean(edgeOf(t, id)?.childSlug), 30_000)
  const childSlug = edgeOf(withChild, id).childSlug as string
  started.push(childSlug)
  console.log(`spinoff ${id} became ${childSlug} (the RPC returned in ${ms}ms)`)
  return { id, childSlug, ms }
}

try {
  await api.waitForHealth()

  // ---- the parent: a codeword only its conversation holds, a live background shell, a done card --------
  const parent = await api.mutate("dispatch", {
    prompt: `The deploy codeword is ${CODEWORD}; it is written nowhere else, so remember it. Start \`sleep 1800\` as a BACKGROUND shell (Bash with run_in_background: true) and leave it running. Then reply with one sentence saying the shell is up, and sign off: this is the whole task.`,
    ...profile,
  })
  started.push(parent.slug)
  console.log(`parent ${parent.slug}`)
  await waitFor("the parent's done card with its shell up", parent.slug, (t) => atRest(t) && t.lastFence?.kind === "done" && (t.bgShells ?? []).length > 0, 300_000)
  await sleep(4000)
  const before = { thread: await boardThread(parent.slug), row: sessionRow(parent.slug), messages: await transcript(parent.slug), digest: digest(parent.slug) }
  console.log(`parent rested: fence ${JSON.stringify(before.thread.lastFence.body).slice(0, 100)}, ${before.thread.bgShells.length} shell(s)`)

  // ---- (a) + (b) + (c): a spinoff from the resting parent ------------------------------------------------
  const first = await spinoffAndWaitForChild(parent.slug, QUESTION)
  const child = await waitFor("the child's own sign-off", first.childSlug, (t) => atRest(t) && Boolean(t.lastFence), 240_000)
  await sleep(4000)
  const after = { thread: await boardThread(parent.slug), row: sessionRow(parent.slug), messages: await transcript(parent.slug), digest: digest(parent.slug) }

  // (a)
  check(after.digest === before.digest, "(a) the parent's transcript is byte-identical", `${before.digest.slice(0, 12)} → ${after.digest.slice(0, 12)}`)
  check(after.thread.lastFence?.kind === "done" && after.thread.lastFence?.body === before.thread.lastFence?.body, "(a) the parent's done card is the one it had")
  check(after.row.rested_at === before.row.rested_at, "(a) the parent's rest time did not move", `${before.row.rested_at} → ${after.row.rested_at}`)
  check(after.row.unread === before.row.unread, "(a) the parent was not marked unread", `${before.row.unread} → ${after.row.unread}`)
  check(after.thread.needsYou === before.thread.needsYou && after.thread.queuedAt === before.thread.queuedAt, "(a) the parent keeps its place in the queue",
    `needsYou ${before.thread.needsYou}→${after.thread.needsYou}, queuedAt ${before.thread.queuedAt}→${after.thread.queuedAt}`)
  const added = after.messages.filter((m) => !before.messages.some((b) => b.sourceId === m.sourceId))
  check(added.length === 1 && added[0]?.spinoff?.id === first.id, "(a) the parent's chat gained the spinoff card and nothing else",
    added.map((m) => `${m.role}${m.spinoff ? "(spinoff)" : ""}:${String(m.displayText ?? m.text).slice(0, 60)}`).join(" | "))
  check(edgeOf(after.thread, first.id)?.childSlug === first.childSlug, "(a) the card's edge links the child")

  // (b)
  const childRow = sessionRow(first.childSlug)
  check(Boolean(childRow.fork_anchor), "(b) the child's row carries its fork anchor", String(childRow.fork_anchor))
  check(child.lastFence?.body !== before.thread.lastFence?.body, "(b) the child's fence is its own, not the parent's", JSON.stringify(child.lastFence?.body ?? null).slice(0, 100))
  check((child.bgShells ?? []).length === 0, "(b) the parent's background shell is not the child's", `${(child.bgShells ?? []).length} shell(s)`)
  check((child.subAgents ?? []).length === 0, "(b) no sub-agents on the child")
  check(!before.thread.aiTitle || child.aiTitle !== before.thread.aiTitle, "(b) the child does not wear the parent's title", `${before.thread.aiTitle} / ${child.aiTitle}`)
  check(child.title !== before.thread.title, "(b) the child is named on its own", `${child.title}`)
  const childMessages = await transcript(first.childSlug)
  const origin = childMessages[0]
  check(origin?.role === "user" && origin?.spinoffOrigin?.instructions === QUESTION && origin?.spinoffOrigin?.brief === "",
    "(b) the child's chat opens on its spinoff header, with no brief", JSON.stringify(origin?.spinoffOrigin ?? origin?.text?.slice(0, 80)))
  check(!JSON.stringify(childMessages).includes("sleep 1800"), "(b) nothing of the parent's conversation is in the child's chat")
  check(readFileSync(transcriptFile(first.childSlug), "utf8").includes("sleep 1800"), "(b) …though the child's FILE does hold the copy (the fork really inherited it)")

  // (c)
  const said = `${child.lastFence?.body ?? ""} ${child.lastAssistant ?? ""}`
  check(said.includes(CODEWORD), "(c) the child knows the codeword only the parent's conversation holds", said.slice(0, 160))

  // (c) NEGATIVE CONTROL: a cold dispatch with the same question does not.
  const cold = await api.mutate("dispatch", { prompt: QUESTION, ...profile })
  started.push(cold.slug)
  const coldT = await waitFor("the cold control's sign-off", cold.slug, (t) => atRest(t) && Boolean(t.lastFence), 240_000)
  const coldSaid = `${coldT.lastFence?.body ?? ""} ${coldT.lastAssistant ?? ""}`
  check(!coldSaid.includes(CODEWORD), "(c) CONTROL: a cold dispatch asked the same question does not know it", coldSaid.slice(0, 160))

  // ---- (d) mid-turn --------------------------------------------------------------------------------------
  await api.mutate("followUp", {
    slug: parent.slug, sessionId: sessionRow(parent.slug).session_id,
    message: "Run `sleep 40 && echo slept-ok` as a FOREGROUND Bash command (not in the background). When it returns, reply with its output and sign off.",
  })
  // Inside its sleep: the turn is running and the Bash call is on disk with no result yet.
  await waitFor("the parent to be inside its sleep", parent.slug, (t) => t.runtime === "running" && readFileSync(transcriptFile(parent.slug), "utf8").includes("sleep 40 && echo slept-ok"), 120_000)
  await sleep(2000)
  const midBytes = readFileSync(transcriptFile(parent.slug)).length
  const mid = await spinoffAndWaitForChild(parent.slug, "Reply with the single word forked and sign off.")
  const parentWhileChild = await boardThread(parent.slug)
  check(parentWhileChild.runtime === "running", "(d) the child started while the parent was still mid-turn", `parent runtime ${parentWhileChild.runtime}, RPC ${mid.ms}ms`)
  const midChild = await waitFor("the mid-turn child's sign-off", mid.childSlug, (t) => atRest(t) && Boolean(t.lastFence), 240_000)
  check(Boolean(midChild.lastFence), "(d) the mid-turn fork ran to its own sign-off", JSON.stringify(midChild.lastFence?.body ?? null).slice(0, 80))
  const parentDone = await waitFor("the parent's sleep turn to finish", parent.slug, (t) => atRest(t) && (t.lastAssistantAt ?? "") > (before.thread.lastAssistantAt ?? ""), 240_000)
  check(`${parentDone.lastAssistant ?? ""} ${parentDone.lastFence?.body ?? ""}`.includes("slept-ok"), "(d) the parent's running turn finished as it would have", String(parentDone.lastAssistant).slice(0, 80))
  const tail = readFileSync(transcriptFile(parent.slug)).subarray(midBytes).toString("utf8")
  check(!tail.includes("Reply with the single word forked") && !tail.includes("spinoff-request"), "(d) the request never reached the parent's transcript")
  const parentChat = await transcript(parent.slug)
  check(parentChat.filter((m) => m.spinoff).length === 2, "(d) the parent's chat carries both spinoff cards", `${parentChat.filter((m) => m.spinoff).length}`)
} catch (error) {
  failures++
  console.log(`FAIL harness: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  for (const slug of started) await api.mutate("killAgent", { slug }).catch(() => {})
  console.log(JSON.stringify({ threads: started }))
}
console.log(failures ? `${failures} FAILED` : "ALL PASSED")
process.exit(failures ? 1 : 0)
