// LIVE PROBE: can ntwine kill ONE codex background exec, and can it tell the codex worker it did?
//   nub packages/server/src/backend/_live_codex_bgterm.mts
//
// The Claude half of this shipped first (`_live_shell_stop.mts`): a background Bash is a task in the
// registry `Query.stopTask` addresses, so the × on a shell row is a real kill. Codex's answer had to be
// found in its own protocol, and `codex app-server generate-json-schema --experimental` (codex-cli
// 0.146.0) has it — three methods gated behind `capabilities.experimentalApi`, which ntwine ALREADY
// sends (codex-app-server.ts CLIENT_CAPABILITIES):
//
//   thread/backgroundTerminals/list      → { itemId, processId, command, cwd, osPid, … }
//   thread/backgroundTerminals/terminate → { threadId, processId } → { terminated }
//   thread/backgroundTerminals/clean
//
// The near-misses are worth naming so nobody reaches for them: `turn/interrupt` ends the whole TURN,
// and `command/exec/terminate` / `process/kill` address a client-supplied handle from the client's own
// `command/exec` — an IDE's terminals, never the model's execs.
//
// Reading a schema proves a method exists, not that it does what ntwine needs. This settles the four
// things that decide whether the × can ship on a codex row, and what it may claim:
//
//   Q1. Does `terminate` kill the REAL OS process? Measured with a control (before / positive /
//       negative), against a unique `sleep` DURATION — a real argv element. A comment marker does not
//       work: zsh strips it before exec, so both readings come back empty and prove nothing.
//   Q2. Is `processId` an id ntwine can already read off the ROLLOUT? Ntwine's transcript reader parses two
//       codex handles out of an exec result — a PTY `session_id` and a script `cell_id` (transcript.ts
//       parseCodexResult). If `processId` is one of them, the × needs no new plumbing to know what to
//       address. If it is neither, ntwine must capture it from the app-server stream instead.
//   Q3. Is the codex agent notified when its exec is killed? (The Claude answer was no for shells.)
//   Q4. If not — does `thread/inject_items` ("Raw Responses API items to append to the thread's
//       model-visible history") actually reach the model? That is the only candidate channel, and
//       nothing in ntwine uses it today.
import { spawn, execSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// The identity for the process-table readings. A unique duration survives exec as real argv.
const UNIQ = 811
const dir = mkdtempSync(join(tmpdir(), "codex-bgterm-"))
writeFileSync(join(dir, "README.md"), "scratch\n")

let failures = 0
const ok = (label: string, cond: boolean, detail = "") => { if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`) }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const child = spawn("codex", ["app-server", "--stdio"], { cwd: dir, stdio: ["pipe", "pipe", "pipe"] })
const APPSERVER_PID = child.pid!
console.log(`[probe] app-server pid ${APPSERVER_PID}, cwd ${dir}`)

let buf = ""
let nextId = 1
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
const notes: any[] = []
const agentText: string[] = []
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
      // Approve every server request outright — this is a throwaway thread in a temp dir.
      child.stdin.write(JSON.stringify({ id: m.id, result: { decision: "approved" } }) + "\n")
    } else if (m.method) {
      notes.push(m)
      const item = m.params?.item
      if (item?.type === "commandExecution") {
        console.log(`[note] ${m.method} status=${item.status} processId=${JSON.stringify(item.processId)} exit=${JSON.stringify(item.exitCode)} cmd=${JSON.stringify(String(item.command ?? "").slice(0, 70))}`)
      }
      if (item?.type === "agentMessage" && typeof item.text === "string") agentText.push(item.text)
    }
  }
})
child.stderr.on("data", () => {})

const req = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
  const id = nextId++
  pending.set(id, { resolve, reject })
  child.stdin.write(JSON.stringify({ id, method, params }) + "\n")
  setTimeout(() => { if (pending.delete(id)) reject(new Error(`timeout ${method}`)) }, 180_000)
})

const findSleep = (): number[] => {
  try {
    return execSync("ps -axww -o pid=,command=").toString().split("\n")
      .filter((l) => l.includes(`sleep ${UNIQ}`) && !l.includes("grep"))
      .map((l) => Number(l.trim().split(/\s+/)[0]))
  } catch { return [] }
}
const descendantPids = (root: number): number[] => {
  const out: number[] = []
  const queue = [root]
  const seen = new Set([root])
  while (queue.length) {
    const cur = queue.shift()!
    let kids: number[] = []
    try { kids = execSync(`pgrep -P ${cur}`).toString().trim().split("\n").filter(Boolean).map(Number) } catch { /* leaf */ }
    for (const k of kids) { if (!seen.has(k)) { seen.add(k); out.push(k); queue.push(k) } }
  }
  return out
}
const awaitTurn = async (from: number) => {
  const deadline = Date.now() + 180_000
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

  // CONTROL. Every later reading is meaningless without this one being empty.
  console.log(`[probe] CONTROL — processes matching "sleep ${UNIQ}": ${JSON.stringify(findSleep())}`)
  ok("control: nothing is running before the turn", findSleep().length === 0)

  let mark = notes.length
  await req("turn/start", { threadId, input: [{ type: "text", text: `Run the shell command \`sleep ${UNIQ}\` as a BACKGROUND process using your background/yield_control execution mode, so it keeps running after your turn ends. Return control immediately and reply with only OK.` }] })
  await awaitTurn(mark)

  const list = await req("thread/backgroundTerminals/list", { threadId })
  console.log(`[probe] backgroundTerminals/list => ${JSON.stringify(list)}`)
  const terminal = list?.data?.[0]
  ok("the live background exec is listed", Boolean(terminal), JSON.stringify(list?.data ?? []))
  if (!terminal) throw new Error("nothing to terminate — the model did not background anything")

  // ---- Q1 (positive reading) --------------------------------------------------------------------
  const alive = findSleep()
  const descendants = new Set(descendantPids(APPSERVER_PID))
  console.log(`[probe] POSITIVE — pids ${JSON.stringify(alive)}; descendants of the app-server include them: ${alive.map((p) => `${p}:${descendants.has(p)}`).join(",")}`)
  ok("Q1 the exec's OS process is really running", alive.length > 0)
  ok("Q1 it is a DESCENDANT of the app-server ntwine spawned", alive.some((p) => descendants.has(p)))
  ok("Q1 processId is NOT an OS pid (it is codex's logical PTY handle)", !alive.includes(Number(terminal.processId)),
    `processId=${terminal.processId} osPid=${JSON.stringify(terminal.osPid)} real=${JSON.stringify(alive)}`)

  // ---- Q2: can ntwine name this exec from what it already reads? ----------------------------------
  // Ntwine reads the ROLLOUT, not this stream. `parseCodexResult` pulls two handles out of an exec's
  // result text: "Process running with session ID <n>" → sessionId, and "Script running with cell ID
  // <n>" → cellId. If `processId` equals one of those, the row can address the kill with what ntwine
  // already has; if it equals neither, the id has to come off the app-server stream instead.
  let rolloutPath: string | undefined
  try {
    rolloutPath = execSync(`grep -rl ${JSON.stringify(threadId)} "$HOME/.codex/sessions" --include='*.jsonl' 2>/dev/null | head -1`, { shell: "/bin/zsh" }).toString().trim() || undefined
  } catch { /* not found */ }
  const rollout = rolloutPath ? readFileSync(rolloutPath, "utf8") : ""
  console.log(`[probe] rollout: ${rolloutPath ?? "(not found)"} (${rollout.length} bytes)`)
  const sessionIds = [...rollout.matchAll(/Process running with session ID\s*(\d+)/g)].map((m) => m[1]!)
  const cellIds = [...rollout.matchAll(/Script running with cell ID\s*(\d+)/g)].map((m) => m[1]!)
  const jsonSessionIds = [...rollout.matchAll(/\\"session_id\\":\s*(\d+)/g)].map((m) => m[1]!)
  console.log(`[probe] rollout handles — session IDs ${JSON.stringify(sessionIds)}, cell IDs ${JSON.stringify(cellIds)}, JSON session_id ${JSON.stringify(jsonSessionIds)}`)
  console.log(`[probe] processId from the app-server: ${JSON.stringify(terminal.processId)}`)
  const inRollout = [...sessionIds, ...cellIds, ...jsonSessionIds].includes(String(terminal.processId))
  ok("Q2 processId is recoverable from the ROLLOUT ntwine already reads", inRollout,
    inRollout ? "no new stream plumbing needed" : "it is NOT in the rollout — ntwine must capture it from the item/started stream")
  // The stream half, either way: ntwine receives these notifications today and parses only FileChangeItem.
  const streamed = notes.filter((n) => n.params?.item?.type === "commandExecution" && n.params.item.processId != null)
  ok("Q2 processId IS on the item/* stream ntwine already receives", streamed.length > 0,
    `${streamed.length} commandExecution notifications carried one`)

  // ---- Q1 (the kill) ----------------------------------------------------------------------------
  console.log(`[probe] terminate => ${JSON.stringify(await req("thread/backgroundTerminals/terminate", { threadId, processId: terminal.processId }))}`)
  let after = findSleep()
  for (let i = 0; i < 12 && after.length > 0; i++) { await sleep(500); after = findSleep() }
  console.log(`[probe] NEGATIVE — pids matching "sleep ${UNIQ}": ${after.length ? JSON.stringify(after) : "(none)"}`)
  ok("Q1 terminate really kills the OS process", after.length === 0, after.join(","))

  // ---- Q3: is the AGENT told? -------------------------------------------------------------------
  mark = notes.length
  agentText.length = 0
  await req("turn/start", { threadId, input: [{ type: "text", text: "In one sentence: what is the state of the background command you started, and how do you know? Do not run any tools — answer only from what you have been told." }] })
  await awaitTurn(mark)
  const beforeInject = agentText.join(" ")
  console.log(`[probe] the model, with no help from ntwine: ${JSON.stringify(beforeInject.slice(0, 400))}`)
  ok("Q3 codex does NOT tell its agent the exec was killed", !/stopped|killed|terminated|no longer running/i.test(beforeInject),
    /stopped|killed|terminated|no longer running/i.test(beforeInject) ? "it DOES — no ntwine notice needed" : "confirmed silent, exactly like Claude's shells")

  // ---- Q4: does inject_items reach the model? ---------------------------------------------------
  const NOTICE = `[ntwine] The operator stopped your background command \`sleep ${UNIQ}\` from the Ntwine dashboard. It is no longer running and will never report a result — do not wait on it.`
  let injected = true
  try {
    await req("thread/inject_items", { threadId, items: [{ type: "message", role: "user", content: [{ type: "input_text", text: NOTICE }] }] })
  } catch (error) {
    injected = false
    console.log(`[probe] inject_items rejected: ${(error as Error).message}`)
  }
  ok("Q4 thread/inject_items is accepted", injected)
  if (injected) {
    mark = notes.length
    agentText.length = 0
    await req("turn/start", { threadId, input: [{ type: "text", text: "Same question again, one sentence: what is the state of that background command, and how do you know? Do not run any tools." }] })
    await awaitTurn(mark)
    const afterInject = agentText.join(" ")
    console.log(`[probe] the model, after ntwine's injected notice: ${JSON.stringify(afterInject.slice(0, 400))}`)
    ok("Q4 the injected notice reaches the model and changes what it believes",
      /stopped|killed|no longer|not running|won't wait|will not wait|terminated/i.test(afterInject), afterInject.slice(0, 200))
  }
} catch (error) {
  failures++
  console.log(`FATAL: ${(error as Error).message}`)
} finally {
  // Only ever this run's own processes: the app-server we spawned, and anything still matching THIS
  // probe's unique duration. Never a broad pattern — other agents share this machine.
  for (const pid of findSleep()) { try { process.kill(pid, "SIGKILL") } catch { /* gone */ } }
  try { child.kill("SIGTERM") } catch { /* already dead */ }
  await sleep(600)
  try { process.kill(APPSERVER_PID, 0); process.kill(APPSERVER_PID, "SIGKILL") } catch { /* already dead */ }
  console.log(`[probe] cleaned up app-server ${APPSERVER_PID}`)
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
