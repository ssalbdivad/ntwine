// LIVE PROBE: for a codex background exec that ntwine ACTUALLY RENDERS as a shell row, can ntwine name the
// thing `thread/backgroundTerminals/terminate` wants?
//   nub packages/server/src/backend/_live_codex_bgterm_match.mts
//
// `_live_codex_bgterm.mts` proved the mechanism: terminate({threadId, processId}) really kills the OS
// process, codex tells its agent nothing, and `thread/inject_items` reaches the model. It did NOT prove
// ntwine can ADDRESS one — and running ntwine's own `readCodexTranscriptFile` over that probe's rollout
// showed why the question is live: the two `Exec` calls it projected were both `completed`, with no
// `backgroundState` at all. That exec never went through `yield_control()`, so ntwine would not have
// drawn a shell row for it in the first place, and "we can kill it" was about a row that does not exist.
//
// So this probe insists on the shape ntwine actually renders — `codexExplicitBackground()`, an exec whose
// script calls `yield_control()` — and then asks the only question left:
//
//   Q1. Does ntwine project it as a LIVE BACKGROUND shell row (status pending + backgroundState
//       "background")? If not, there is nothing to hang an × on and the rest is moot.
//   Q2. Does that projected call carry an id that EQUALS the `processId` the app-server wants —
//       `sessionId` (the PTY generation) or `cellId` (the script generation)?
//   Q3. Whatever the answer, does the `item/started` commandExecution notification carry the
//       processId? That is the fallback supply route, and ntwine already receives those and discards
//       everything but FileChangeItem.
import { spawn, execSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readCodexTranscriptFile } from "../transcript.ts"

const UNIQ = 733
const dir = mkdtempSync(join(tmpdir(), "codex-bgmatch-"))
writeFileSync(join(dir, "README.md"), "scratch\n")

let failures = 0
const ok = (label: string, cond: boolean, detail = "") => { if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`) }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const child = spawn("codex", ["app-server", "--stdio"], { cwd: dir, stdio: ["pipe", "pipe", "pipe"] })
const APPSERVER_PID = child.pid!
let buf = ""
let nextId = 1
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
const notes: any[] = []
child.stdout.on("data", (d: Buffer) => {
  buf += d.toString()
  let i: number
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
    if (!line) continue
    let m: any
    try { m = JSON.parse(line) } catch { continue }
    if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
      const p = pending.get(m.id); pending.delete(m.id)
      if (p) m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result)
    } else if (m.method && m.id !== undefined) {
      child.stdin.write(JSON.stringify({ id: m.id, result: { decision: "approved" } }) + "\n")
    } else if (m.method) {
      notes.push(m)
    }
  }
})
child.stderr.on("data", () => {})
const req = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
  const id = nextId++
  pending.set(id, { resolve, reject })
  child.stdin.write(JSON.stringify({ id, method, params }) + "\n")
  setTimeout(() => { if (pending.delete(id)) reject(new Error(`timeout ${method}`)) }, 240_000)
})
const findSleep = (): number[] => {
  try {
    return execSync("ps -axww -o pid=,command=").toString().split("\n")
      .filter((l) => l.includes(`sleep ${UNIQ}`) && !l.includes("grep"))
      .map((l) => Number(l.trim().split(/\s+/)[0]))
  } catch { return [] }
}
const awaitTurn = async (from: number) => {
  const deadline = Date.now() + 240_000
  while (Date.now() < deadline) {
    if (notes.slice(from).some((n) => /turn\/(completed|failed)/.test(n.method))) return
    await sleep(500)
  }
}

try {
  await req("initialize", { clientInfo: { name: "ntwine", title: "Ntwine probe", version: "0.0.1" }, capabilities: { experimentalApi: true } })
  const started = await req("thread/start", { cwd: dir, sandbox: "danger-full-access", approvalPolicy: "never", ephemeral: false })
  const threadId = started.thread?.id ?? started.threadId
  console.log(`[probe] threadId ${threadId}`)

  const mark = notes.length
  // The wording matters. Asking for "your background execution mode" got a bare detached process last
  // time, which ntwine does not classify as background. `yield_control()` is the call ntwine keys on, so
  // the prompt names it and asks for the handle back — the shape a real worker produces when it starts
  // a watcher it intends to poll later.
  await req("turn/start", { threadId, input: [{ type: "text", text: [
    `Start the long-running command \`sleep ${UNIQ}\` and hand it off to the background.`,
    "Use the exec tool's code mode: start the command, then call `yield_control()` so control returns to me immediately while it keeps running.",
    "Do NOT wait for it and do NOT poll it. Reply with only the handle it gave you.",
  ].join(" ") }] })
  await awaitTurn(mark)

  const list = await req("thread/backgroundTerminals/list", { threadId })
  const terminal = list?.data?.[0]
  console.log(`[probe] backgroundTerminals/list => ${JSON.stringify(list)}`)
  console.log(`[probe] OS pids matching "sleep ${UNIQ}": ${JSON.stringify(findSleep())}`)
  ok("the exec is live and listed by the app-server", Boolean(terminal) && findSleep().length > 0)

  // ---- What NTWINE sees, through its own reader ---------------------------------------------------
  const rolloutPath = execSync(`grep -rl ${JSON.stringify(threadId)} "$HOME/.codex/sessions" --include='*.jsonl' 2>/dev/null | head -1`, { shell: "/bin/zsh" }).toString().trim()
  console.log(`[probe] rollout: ${rolloutPath || "(not found)"}`)
  const messages = rolloutPath ? readCodexTranscriptFile(rolloutPath) : []
  const projected = messages.flatMap((m) => (m.tools ?? []).map((t: any) => t))
  const liveBackground = projected.filter((t) => t.status === "pending" && t.backgroundState === "background")
  console.log("[probe] every exec-ish call ntwine projected:")
  for (const t of projected) {
    if (!/exec|run|shell|wait|poll|process/i.test(t.name ?? "")) continue
    console.log(`    name=${t.name} status=${t.status} bg=${t.backgroundState ?? "-"} sessionId=${JSON.stringify(t.sessionId)} cellId=${JSON.stringify(t.cellId)} shellId=${JSON.stringify(t.shellId)} desc=${JSON.stringify(t.desc ?? "").slice(0, 60)}`)
  }
  ok("Q1 ntwine projects it as a LIVE BACKGROUND shell row", liveBackground.length > 0,
    liveBackground.length > 0 ? "" : "no row ⇒ nothing to hang an × on, whatever the protocol can do")

  // ---- Q2: is the projected handle the one terminate wants? --------------------------------------
  const handles = liveBackground.flatMap((t) => [t.sessionId, t.cellId].filter((v) => v !== undefined).map(String))
  console.log(`[probe] handles ntwine projected: ${JSON.stringify(handles)}   processId the app-server wants: ${JSON.stringify(terminal?.processId)}`)
  ok("Q2 a projected handle EQUALS the app-server's processId", handles.includes(String(terminal?.processId)),
    handles.includes(String(terminal?.processId)) ? "the row can address its own kill" : "ntwine must get the id from the stream instead")

  // ---- Q3: the fallback supply route -------------------------------------------------------------
  const streamed = notes.filter((n) => n.params?.item?.type === "commandExecution" && n.params.item.processId != null)
    .map((n) => ({ processId: n.params.item.processId, command: String(n.params.item.command ?? "").slice(0, 60), status: n.params.item.status }))
  console.log(`[probe] commandExecution notifications carrying a processId: ${JSON.stringify(streamed)}`)
  ok("Q3 processId is on the item/* stream ntwine already receives", streamed.length > 0)

  if (terminal) {
    console.log(`[probe] terminate => ${JSON.stringify(await req("thread/backgroundTerminals/terminate", { threadId, processId: terminal.processId }))}`)
    let after = findSleep()
    for (let i = 0; i < 12 && after.length > 0; i++) { await sleep(500); after = findSleep() }
    ok("terminate kills it (re-confirmed on this shape)", after.length === 0, after.join(","))
  }
} catch (error) {
  failures++
  console.log(`FATAL: ${(error as Error).message}`)
} finally {
  for (const pid of findSleep()) { try { process.kill(pid, "SIGKILL") } catch { /* gone */ } }
  try { child.kill("SIGTERM") } catch { /* dead */ }
  await sleep(600)
  try { process.kill(APPSERVER_PID, 0); process.kill(APPSERVER_PID, "SIGKILL") } catch { /* dead */ }
  console.log(`[probe] cleaned up app-server ${APPSERVER_PID}`)
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
