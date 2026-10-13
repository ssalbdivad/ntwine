// LIVE PROBE: what does the Agent SDK tell ntwine about an input it DELIVERED, and when?
//   nub packages/server/src/backend/_live_broker_dequeue.mts
//
// The question this exists to answer, empirically, before any design:
//  1. Does the SDK emit a `user` event for a delivered input, and does that event carry the `uuid`
//     ntwine supplied on `sendInput` (ClaudeAgentSdkSession.send writes it as the input message's uuid)?
//  2. Does the on-disk JSONL user record carry that same uuid?
//  3. Are there `queue-operation` records on the broker path at all, and do they carry the id?
//  4. TWO follow-ups sent at once mid-turn: what does the stream/disk look like when both are
//     delivered "simultaneously"?
//  5. Timing: event vs. the disk record, per message.
import { execFileSync } from "node:child_process"
import { mkdtempSync, openSync, readSync, realpathSync, rmSync, statSync, closeSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { forkBroker, killBroker } from "./claude-broker-host.ts"
import { connectClaudeBroker } from "./claude-broker-client.ts"
import type { ClaudeQueryEvent } from "./claude-agent-sdk-protocol.ts"

const claudeBin = execFileSync("which", ["claude"], { encoding: "utf8" }).trim()
const stateDir = mkdtempSync(join(tmpdir(), "bdeq-state-"))
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "bdeq-repo-")))
execFileSync("git", ["init", "-q", cwd])
const sessionId = randomUUID()
const jsonlPath = join(homedir(), ".claude", "projects", cwd.replace(/\//g, "-"), `${sessionId}.jsonl`)

const t0 = Date.now()
const at = (): string => `t+${String(Date.now() - t0).padStart(6)}ms`
const short = (id: string | undefined): string => (id ? id.slice(0, 8) : "-")

const ID_BOOT = randomUUID()
const ID_A = randomUUID()
const ID_B = randomUUID()
const known = new Map<string, string>([[ID_BOOT, "BOOT"], [ID_A, "ALPHA"], [ID_B, "BRAVO"]])
const label = (id: string | undefined): string => (id && known.get(id)) ?? short(id)

console.log(`session   ${sessionId}`)
console.log(`jsonl     ${jsonlPath}`)
console.log(`inputIds  BOOT=${ID_BOOT}  ALPHA=${ID_A}  BRAVO=${ID_B}\n`)

// ── disk tail ─────────────────────────────────────────────────────────────────────────────────────
let offset = 0
let pending = ""
const diskLines: Array<{ ms: number; rec: Record<string, unknown> }> = []
function drainDisk(): void {
  let size = 0
  try { size = statSync(jsonlPath).size } catch { return }
  if (size <= offset) return
  const fd = openSync(jsonlPath, "r")
  const buf = Buffer.alloc(size - offset)
  readSync(fd, buf, 0, buf.length, offset)
  closeSync(fd)
  offset = size
  pending += buf.toString("utf8")
  const lines = pending.split("\n")
  pending = lines.pop() ?? ""
  for (const line of lines) {
    if (!line.trim()) continue
    let rec: Record<string, unknown>
    try { rec = JSON.parse(line) } catch { continue }
    const ms = Date.now() - t0
    diskLines.push({ ms, rec })
    const type = String(rec.type ?? "?")
    const op = rec.operation ? ` op=${rec.operation}` : ""
    const uuid = typeof rec.uuid === "string" ? rec.uuid : undefined
    const parent = typeof rec.parentUuid === "string" ? rec.parentUuid : undefined
    let text = ""
    if (typeof rec.content === "string") text = rec.content
    else {
      const msg = rec.message as { content?: unknown } | undefined
      if (typeof msg?.content === "string") text = msg.content
      else if (Array.isArray(msg?.content)) {
        text = msg.content.map((b: Record<string, unknown>) => (b?.type === "text" ? String(b.text) : `<${b?.type}>`)).join(" ")
      } else if (rec.type === "attachment") {
        const att = rec.attachment as { type?: unknown; prompt?: unknown } | undefined
        text = `attachment:${String(att?.type)} ${typeof att?.prompt === "string" ? att.prompt : JSON.stringify(att?.prompt ?? "").slice(0, 120)}`
      }
    }
    console.log(`DISK  ${at()} type=${type}${op} uuid=${label(uuid)} parent=${short(parent)} text=${JSON.stringify(text.slice(0, 90))}`)
  }
}
const diskTimer = setInterval(drainDisk, 25)

// ── the live broker ───────────────────────────────────────────────────────────────────────────────
const env = Object.fromEntries(
  ["PATH", "HOME", "USER", "LANG", "SHELL", "TMPDIR", "CLAUDE_CODE_OAUTH_TOKEN"]
    .filter((k) => process.env[k]).map((k) => [k, process.env[k]!]),
)
const record = await forkBroker({ stateDir, cwd, sessionId, executablePath: claudeBin, env, permissionMode: "bypassPermissions" })

const events: Array<{ ms: number; event: ClaudeQueryEvent }> = []
let results = 0
const client = connectClaudeBroker(record.socketPath, {
  onEvent: (event) => {
    events.push({ ms: Date.now() - t0, event })
    if (event.kind === "result") results++
    const anyEvent = event as unknown as Record<string, unknown>
    const text = Array.isArray(anyEvent.text) ? (anyEvent.text as string[]).join(" ") : ""
    const extra = event.kind === "assistant" && event.toolUses.length ? ` tools=${event.toolUses.map((t) => t.name).join(",")}` : ""
    console.log(`EVENT ${at()} kind=${event.kind} messageId=${label(anyEvent.messageId as string | undefined)}${extra} text=${JSON.stringify(text.slice(0, 90))}`)
    // Dump the FULL frame for user events — this is the one we are interrogating.
    if (event.kind === "user") console.log(`        raw: ${JSON.stringify(event)}`)
  },
  onPermissionRequest: (requestId) => client.answerPermission(requestId, { behavior: "allow" }),
  onDiagnostic: (d) => console.log(`DIAG  ${at()} ${JSON.stringify(d).slice(0, 200)}`),
})

const waitFor = async (pred: () => boolean, ms: number, what: string): Promise<boolean> => {
  const deadline = Date.now() + ms
  while (!pred()) {
    if (Date.now() > deadline) { console.log(`WAIT  ${at()} TIMEOUT waiting for ${what}`); return false }
    await new Promise((r) => setTimeout(r, 25))
  }
  return true
}

try {
  // A first turn that runs LONG enough to still be in flight when the two follow-ups arrive.
  console.log(`SEND  ${at()} BOOT`)
  client.sendInput({ id: ID_BOOT, text: "Use the Bash tool to run `sleep 30`, then reply with exactly BOOT-DONE and stop." })

  // Wait until the model is provably mid-tool (the Bash tool_use is on the stream).
  await waitFor(() => events.some((e) => e.event.kind === "assistant" && e.event.toolUses.length > 0), 120_000, "the first turn's tool_use")
  await new Promise((r) => setTimeout(r, 1_500))

  // THE SCENARIO: two follow-ups pushed in the same instant while the turn is running.
  const tSend = Date.now()
  console.log(`SEND  ${at()} ALPHA + BRAVO (same tick)`)
  client.sendInput({ id: ID_A, text: "FOLLOWUP-ALPHA: when you get to this, reply with exactly ALPHA-SEEN." })
  client.sendInput({ id: ID_B, text: "FOLLOWUP-BRAVO: when you get to this, reply with exactly BRAVO-SEEN." })

  // Run until the follow-ups have been answered (or 4 minutes).
  await waitFor(() => results >= 2, 240_000, "the follow-up turns to settle")
  await new Promise((r) => setTimeout(r, 3_000))
  drainDisk()

  // ── the answers ─────────────────────────────────────────────────────────────────────────────────
  console.log("\n──────── ANALYSIS ────────")
  const idsInEvents = events.filter((e) => {
    const mid = (e.event as unknown as Record<string, unknown>).messageId
    return typeof mid === "string" && known.has(mid)
  })
  console.log(`Q1 events carrying a ntwine input id: ${idsInEvents.length}` +
    (idsInEvents.length ? ` → ${idsInEvents.map((e) => `${e.event.kind}:${label((e.event as unknown as Record<string, unknown>).messageId as string)}@${e.ms}ms`).join(", ")}` : ""))

  const diskWithId = diskLines.filter((d) => typeof d.rec.uuid === "string" && known.has(d.rec.uuid as string))
  console.log(`Q2 disk records carrying a ntwine input id: ${diskWithId.length}` +
    (diskWithId.length ? ` → ${diskWithId.map((d) => `${String(d.rec.type)}:${label(d.rec.uuid as string)}@${d.ms}ms`).join(", ")}` : ""))

  const queueOps = diskLines.filter((d) => d.rec.type === "queue-operation")
  console.log(`Q3 queue-operation records on the broker path: ${queueOps.length}` +
    (queueOps.length ? ` → ${queueOps.map((d) => `${String(d.rec.operation)}@${d.ms}ms content=${JSON.stringify(String(d.rec.content ?? "").slice(0, 40))}`).join(", ")}` : ""))

  for (const [id, name] of known) {
    if (name === "BOOT") continue
    const marker = name === "ALPHA" ? "FOLLOWUP-ALPHA" : "FOLLOWUP-BRAVO"
    const ev = events.find((e) => {
      const anyEvent = e.event as unknown as Record<string, unknown>
      return Array.isArray(anyEvent.text) && (anyEvent.text as string[]).join(" ").includes(marker)
    })
    const disk = diskLines.find((d) => JSON.stringify(d.rec).includes(marker))
    const diskUser = diskLines.find((d) => d.rec.type === "user" && JSON.stringify(d.rec).includes(marker))
    console.log(`Q5 ${name} (${short(id)}): firstEvent=${ev ? `${ev.event.kind}@${ev.ms}ms` : "NONE"} firstDisk=${disk ? `${String(disk.rec.type)}@${disk.ms}ms` : "NONE"} diskUserRecord=${diskUser ? `@${diskUser.ms}ms uuid=${label(diskUser.rec.uuid as string)}` : "NONE"} (sent @${tSend - t0}ms)`)
  }

  console.log("\n──────── EVENT KINDS ────────")
  const kinds = new Map<string, number>()
  for (const e of events) kinds.set(e.event.kind, (kinds.get(e.event.kind) ?? 0) + 1)
  console.log([...kinds].map(([k, n]) => `${k}=${n}`).join(" "))
  console.log("\n──────── DISK TYPES ────────")
  const types = new Map<string, number>()
  for (const d of diskLines) {
    const k = `${String(d.rec.type)}${d.rec.operation ? `/${String(d.rec.operation)}` : ""}`
    types.set(k, (types.get(k) ?? 0) + 1)
  }
  console.log([...types].map(([k, n]) => `${k}=${n}`).join(" "))
  console.log(`\nkept jsonl: ${jsonlPath}`)
} catch (err) {
  console.log(`ERROR ${err instanceof Error ? err.stack : String(err)}`)
} finally {
  clearInterval(diskTimer)
  try { client.close() } catch {}
  try { killBroker(stateDir, sessionId) } catch {}
  rmSync(stateDir, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
}
