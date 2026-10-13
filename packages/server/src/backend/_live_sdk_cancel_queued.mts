// LIVE PROBE: can ntwine take BACK a follow-up it already pushed into the Agent SDK, while the queue
// still holds it?  This is the empirical foundation for "click a queued bubble to unqueue it".
//   nub packages/server/src/backend/_live_sdk_cancel_queued.mts
//
// The SDK's own .d.ts advertises the control request but exposes NO wrapper on `Query`:
//   SDKControlCancelAsyncMessageRequest { subtype: 'cancel_async_message', message_uuid }
//   "Drops a pending async user message from the command queue by uuid. No-op if already dequeued."
// So the only channel is `Query.request(...)` — the same unmangled method `interrupt()` uses.
//
// Questions, in the order the design depends on them:
//  1. Does the request round-trip at all against the real CLI, and what does it answer?
//  2. Does a cancelled message actually NOT run — no assistant acknowledgement, no JSONL user record?
//  3. Does cancelling ONE of two co-queued messages leave the OTHER intact? (the d.ts warns that
//     cancelling a coalesced batch's representative uuid drops the WHOLE batch)
//  4. What comes back for a uuid that is NOT in the queue (already delivered / never sent)?
import { query } from "@ntwine/claude-agent-sdk-runtime"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"

const claude = execFileSync("which", ["claude"], { encoding: "utf8" }).trim()
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-cancel-")))
execFileSync("git", ["init", "-q", cwd])
const env = Object.fromEntries(["PATH", "HOME", "USER", "LANG", "SHELL", "TMPDIR", "CLAUDE_CODE_OAUTH_TOKEN"].filter((k) => process.env[k]).map((k) => [k, process.env[k]!]))

const t0 = Date.now()
const at = (): string => `t+${String(Date.now() - t0).padStart(6)}ms`

const ID_BOOT = randomUUID()
const ID_ALPHA = randomUUID()
const ID_BRAVO = randomUUID()
const ID_GHOST = randomUUID()
const names = new Map<string, string>([[ID_BOOT, "BOOT"], [ID_ALPHA, "ALPHA"], [ID_BRAVO, "BRAVO"], [ID_GHOST, "GHOST"]])
const label = (id: string | undefined): string => (id && names.get(id)) ?? (id ? id.slice(0, 8) : "-")

// ── pushable streaming input ──────────────────────────────────────────────────────────────────────
const inbox: unknown[] = []
let wake: (() => void) | undefined
let done = false
function push(uuid: string, content: string): void {
  console.log(`SEND  ${at()} ${label(uuid)}`)
  inbox.push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, uuid, session_id: "" })
  wake?.()
}
async function* prompt(): AsyncGenerator<unknown> {
  while (!done) {
    while (inbox.length) yield inbox.shift()!
    if (done) return
    await new Promise<void>((resolve) => { wake = resolve; setTimeout(resolve, 100) })
  }
}

let sessionId = ""
let results = 0
const assistantText: string[] = []
const sawTool = { value: false }

const q = query({
  prompt: prompt() as never,
  options: { cwd, env, pathToClaudeCodeExecutable: claude, permissionMode: "bypassPermissions", settingSources: [], persistSession: true } as never,
}) as unknown as AsyncIterable<Record<string, unknown>> & { request(inner: Record<string, unknown>): Promise<unknown> }

const pump = (async () => {
  for await (const raw of q) {
    const m = raw as Record<string, any>
    if (m.type === "system" && m.subtype === "init") { sessionId = m.session_id; console.log(`EVENT ${at()} init session=${sessionId}`) }
    if (m.type === "assistant") {
      const blocks = m.message?.content ?? []
      const text = blocks.filter((c: any) => c.type === "text").map((c: any) => c.text).join(" ")
      const tools = blocks.filter((c: any) => c.type === "tool_use").map((c: any) => c.name)
      if (tools.length) sawTool.value = true
      if (text.trim()) assistantText.push(text)
      console.log(`EVENT ${at()} assistant tools=[${tools.join(",")}] text=${JSON.stringify(text.slice(0, 80))}`)
    }
    if (m.type === "user") console.log(`EVENT ${at()} user uuid=${label(m.uuid)} content=${JSON.stringify(JSON.stringify(m.message?.content).slice(0, 100))}`)
    if (m.type === "result") { results++; console.log(`EVENT ${at()} result #${results} subtype=${m.subtype}`) }
  }
})()

const waitFor = async (pred: () => boolean, ms: number, what: string): Promise<boolean> => {
  const deadline = Date.now() + ms
  while (!pred()) {
    if (Date.now() > deadline) { console.log(`WAIT  ${at()} TIMEOUT ${what}`); return false }
    await new Promise((r) => setTimeout(r, 50))
  }
  return true
}

let cancelAlpha: unknown = "<not attempted>"
let cancelGhost: unknown = "<not attempted>"
let cancelAlphaError = ""
let cancelGhostError = ""

try {
  push(ID_BOOT, "Use the Bash tool to run `sleep 25`, then reply with exactly BOOT-DONE and stop.")
  await waitFor(() => sawTool.value, 120_000, "the first turn's tool_use")
  await new Promise((r) => setTimeout(r, 1_500))

  // Two follow-ups queued behind the running turn, exactly as two fast steers would be.
  push(ID_ALPHA, "FOLLOWUP-ALPHA: reply with exactly ALPHA-SEEN.")
  push(ID_BRAVO, "FOLLOWUP-BRAVO: reply with exactly BRAVO-SEEN.")
  await new Promise((r) => setTimeout(r, 2_000))

  console.log(`\nCANCEL ${at()} ALPHA (${ID_ALPHA})`)
  try { cancelAlpha = await q.request({ subtype: "cancel_async_message", message_uuid: ID_ALPHA }) } catch (e) { cancelAlphaError = e instanceof Error ? e.message : String(e) }
  console.log(`  -> ${cancelAlphaError ? `THREW ${cancelAlphaError}` : JSON.stringify(cancelAlpha)}`)

  console.log(`CANCEL ${at()} GHOST — a uuid that was never queued (${ID_GHOST})`)
  try { cancelGhost = await q.request({ subtype: "cancel_async_message", message_uuid: ID_GHOST }) } catch (e) { cancelGhostError = e instanceof Error ? e.message : String(e) }
  console.log(`  -> ${cancelGhostError ? `THREW ${cancelGhostError}` : JSON.stringify(cancelGhost)}\n`)

  // BOOT's result + whatever survives of the follow-ups.
  await waitFor(() => results >= 2, 240_000, "the follow-up turn(s) to settle")
  await new Promise((r) => setTimeout(r, 4_000))
} catch (err) {
  console.log(`ERROR ${err instanceof Error ? err.stack : String(err)}`)
} finally {
  done = true
  wake?.()
}

// ── the answers ───────────────────────────────────────────────────────────────────────────────────
const jsonlPath = join(homedir(), ".claude", "projects", cwd.replace(/\//g, "-"), `${sessionId}.jsonl`)
let jsonl = ""
try { jsonl = readFileSync(jsonlPath, "utf8") } catch { jsonl = "" }
const all = assistantText.join("\n")

const ok = (n: number, label: string, cond: boolean, detail = ""): boolean => {
  console.log(`${cond ? "PASS" : "FAIL"}  Q${n} ${label}${detail ? ` — ${detail}` : ""}`)
  return cond
}
console.log("\n──────── VERDICT ────────")
console.log(`cancel(ALPHA) response: ${cancelAlphaError ? `THREW ${cancelAlphaError}` : JSON.stringify(cancelAlpha)}`)
console.log(`cancel(GHOST) response: ${cancelGhostError ? `THREW ${cancelGhostError}` : JSON.stringify(cancelGhost)}`)
const a1 = ok(1, "the control request round-tripped without throwing", !cancelAlphaError)
const a2 = ok(2, "the cancelled message NEVER ran (no ALPHA-SEEN, no ALPHA text in the JSONL)",
  !/ALPHA-SEEN/.test(all) && !jsonl.includes("FOLLOWUP-ALPHA"),
  `assistantSaidAlpha=${/ALPHA-SEEN/.test(all)} jsonlHasAlpha=${jsonl.includes("FOLLOWUP-ALPHA")}`)
const a3 = ok(3, "the co-queued survivor still ran (BRAVO-SEEN)", /BRAVO-SEEN/.test(all),
  `assistantSaidBravo=${/BRAVO-SEEN/.test(all)} jsonlHasBravo=${jsonl.includes("FOLLOWUP-BRAVO")}`)
const a4 = ok(4, "cancelling an unknown uuid is a harmless no-op (no throw)", !cancelGhostError)
console.log(`\njsonl: ${jsonlPath} (${jsonl.length} bytes)`)
console.log(a1 && a2 && a3 && a4 ? "\nUNQUEUE IS REAL" : "\nUNQUEUE IS NOT USABLE AS DESIGNED")

rmSync(cwd, { recursive: true, force: true })
process.exit(a1 && a2 && a3 && a4 ? 0 : 1)
