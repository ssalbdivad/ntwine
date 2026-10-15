import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { createServer as createNetServer } from "node:net"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveNtwineMcp } from "./dispatch.ts"
import { NTWINE_MCP } from "./backend/types.ts"

// Drives the REAL cc-worker/bin/ntwine-mcp.mjs over its real stdio JSON-RPC transport (no mocks, no
// re-implementation of the protocol) and — for the tool call — against a REAL http server standing in
// for ntwine's /rpc/dispatch. This is what proves the unified server actually answers as `ntwine` with a
// `spawn_thread` tool, i.e. that a worker sees `mcp__ntwine__spawn_thread`.

interface Rpc {
  send(msg: unknown): void
  next(id: number): Promise<any>
  /** The next notification (a message with no id) the server sends with this method. */
  notified(method: string): Promise<any>
  /** Every notification the server has sent so far, oldest first. */
  notifications: any[]
  kill(): void
}

// `cwd` matters: with no NTWINE_PROJECT_ID the shim derives its project by walking UP for `.ntwine/.id`,
// so a child left in this repo would address ntwine's own project. Default it to an empty temp dir —
// "a worker with no stamp and no project in its tree" — and let a test that wants the walk-up ask for it.
const UNSET_NTWINE_IDENTITY = { NTWINE_THREAD: "", NTWINE_THREAD_SLUG: "", NTWINE_STATE_DIR: "", NTWINE_PERM_DIR: "", NTWINE_SERVER_LOCK: "", NTWINE_PROJECT_ID: "" }

function startServer(env: Record<string, string>, cwd = mkdtempSync(join(tmpdir(), "ntwine-mcp-cwd-"))): Rpc {
  const descriptor = resolveNtwineMcp("/unused")
  assert.ok(descriptor, "the packaged ntwine MCP script must be resolvable")
  const child = spawn(process.execPath, [descriptor.scriptPath], {
    stdio: ["pipe", "pipe", "inherit"],
    cwd,
    // The ntwine identity of the shell running the suite is BLANKED before the test's own is laid on.
    // Run from a worker, that shell names the real server (NTWINE_SERVER_LOCK wins over the state dir
    // a test passes), the real project and the worker's own thread, so an unblanked spawn sends every
    // test's dispatch, steer and ask to the maintainer's board — two real opus threads per run.
    env: { ...process.env, ...UNSET_NTWINE_IDENTITY, ...env },
  })
  const pending = new Map<number, (value: any) => void>()
  const notifications: any[] = []
  const awaitingNotice: Array<{ method: string; resolve: (value: any) => void }> = []
  let buf = ""
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => {
    buf += chunk
    let nl: number
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      const msg = JSON.parse(line)
      if (msg.id === undefined && typeof msg.method === "string") {
        notifications.push(msg)
        const at = awaitingNotice.findIndex((w) => w.method === msg.method)
        if (at >= 0) awaitingNotice.splice(at, 1)[0].resolve(msg)
        continue
      }
      pending.get(msg.id)?.(msg)
      pending.delete(msg.id)
    }
  })
  return {
    send: (msg) => child.stdin.write(JSON.stringify(msg) + "\n"),
    next: (id) => new Promise((resolve) => pending.set(id, resolve)),
    notified: (method) => new Promise((resolve) => awaitingNotice.push({ method, resolve })),
    notifications,
    kill: () => child.kill(),
  }
}

test("the ntwine MCP server identifies as `ntwine` and exposes its worker tools", async () => {
  const rpc = startServer({ NTWINE_STATE_DIR: mkdtempSync(join(tmpdir(), "ntwine-mcp-")) })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })
    const init = await rpc.next(1)
    // The mounted server NAME (dispatch.ts) is what forms the tool id the worker sees; serverInfo must
    // agree with it, or the two halves of `mcp__ntwine__spawn_thread` drift apart.
    assert.equal(init.result.serverInfo.name, NTWINE_MCP.name)
    // The list follows the server's capabilities, so the client is told to expect it to change.
    assert.deepEqual(init.result.capabilities.tools, { listChanged: true })

    // No ntwine answers here, so the capabilities cannot be read and every tool is listed, as before the
    // list was gated — a server it cannot reach must never cost a worker a tool.
    rpc.send({ jsonrpc: "2.0", method: "notifications/initialized" })
    rpc.send({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    const list = await rpc.next(2)
    assert.deepEqual(list.result.tools.map((t: { name: string }) => t.name), ["spawn_thread", "goal", "timer", "watch_pr", "watch", "unwatch", "ask", "unask", "done", "title", "activity", "link", "unlink", "extend_shell", "read_thread", "message_thread", "editor", "schedule", "deadline", "secret", "watch_command"])
    assert.deepEqual(list.result.tools.find((t: { name: string }) => t.name === "link").inputSchema.required, ["label", "target"])
    assert.deepEqual(list.result.tools.find((t: { name: string }) => t.name === "unlink").inputSchema.required, ["id"])
    for (const required of ["prompt", "model", "effort"]) {
      assert.ok(list.result.tools[0].inputSchema.required.includes(required))
    }
    // `goal` requires only `action` — `prompt` and a valid `every_seconds` are required for
    // `start` alone, enforced in the handler so a lenient client cannot skip them either (asserted
    // below). It exposes NO THREAD parameter: the slug comes from the server's env, never from the
    // model, which is what stops one thread arming a loop on another.
    assert.deepEqual(list.result.tools[1].inputSchema.required, ["action"])
    assert.deepEqual(
      Object.keys(list.result.tools[1].inputSchema.properties).sort(),
      ["action", "for", "heartbeat_seconds", "max_runs", "post_compaction", "prompt", "stop_hook"],
    )
    // The READ action is part of the advertised surface, not just the handler — a worker only reaches for
    // what `tools/list` shows it, and writing blind is what having no read at all produced.
    assert.deepEqual(list.result.tools[1].inputSchema.properties.action.enum, ["start", "stop", "get"])
    // `timer` is the same shape of tool and takes the same care: `action` alone is required, everything
    // else depends on which action, and it too exposes NO THREAD parameter.
    assert.deepEqual(list.result.tools[2].inputSchema.required, ["action"])
    assert.deepEqual(
      Object.keys(list.result.tools[2].inputSchema.properties).sort(),
      ["action", "at", "id", "in_seconds", "prompt"],
    )
    // `watch_pr` — same shape as its siblings: `action` alone is required, and NO thread parameter a
    // model could aim elsewhere.
    assert.deepEqual(list.result.tools[3].inputSchema.required, ["action"])
    assert.deepEqual(list.result.tools[3].inputSchema.properties.action.enum, ["add", "list", "drop"])
    // `for` is REQUIRED for `add` (enforced in the handler, like its siblings): a PR watcher with no
    // expiry polls forever and holds whatever thread parked on it (2026-08-15).
    assert.deepEqual(
      Object.keys(list.result.tools[3].inputSchema.properties).sort(),
      ["action", "for", "id", "target"],
    )
    // `watch` / `unwatch` — TWO VERBS, not one action-switch, because a worker reaching for `unwatch`
    // should find `unwatch` (plans/rest-by-registration.md). This surface said "NO SHELL `watch` TOOL,
    // and there never will be" until 2026-08-26: a background shell was watched through a `shells:` line
    // in the ```awaiting fence, which is a DECLARATION with the lifetime of the message carrying it, so
    // the worker had to restate every wait at every rest. Registration replaces that.
    //
    // ALL THREE ARGUMENTS ARE REQUIRED, unlike every action-switch above, where `action` alone can be:
    // there is exactly one thing this call does, and none of the three has a defensible default — `for`
    // least of all, because a duration ntwine picked would be a wait nobody chose.
    assert.deepEqual(list.result.tools[4].inputSchema.required, ["kind", "target", "for"])
    assert.deepEqual(list.result.tools[4].inputSchema.properties.kind.enum, ["shell", "agent", "terminal"])
    assert.deepEqual(Object.keys(list.result.tools[4].inputSchema.properties).sort(), ["for", "kind", "target"])
    assert.deepEqual(list.result.tools[5].inputSchema.required, ["id"])
    assert.deepEqual(Object.keys(list.result.tools[5].inputSchema.properties), ["id"])
    // `ask` / `unask` — the same two-verb shape, for the question half of the same redesign. What is
    // worth pinning is the TREE: the question schema nests to exactly ASK_MAX_DEPTH and no further, so
    // the deepest option carries no `followUps` key at all. A `$ref` cycle would have been the natural
    // JSON Schema for a recursive shape, but client support for one is uneven and a schema a client
    // drops is a tool a worker cannot call — so the bound is INLINE, and visible to whoever reads it.
    const askQuestion = list.result.tools[6].inputSchema.properties.questions.items
    assert.deepEqual(list.result.tools[6].inputSchema.required, ["questions"])
    assert.deepEqual(askQuestion.required, ["question", "kind"])
    assert.deepEqual(askQuestion.properties.kind.enum, ["question", "multi"])
    const depth = (node: { properties: { options: { items: { properties: Record<string, unknown> } } } }): number => {
      const followUps = node.properties.options.items.properties.followUps as { items: typeof node } | undefined
      return followUps ? 1 + depth(followUps.items) : 1
    }
    assert.equal(depth(askQuestion), 3)
    // EVERY COUNT is unbounded — the questions per call, the options at every level, the follow-ups
    // under every option. They carried `maxItems` of 4 / 8 / 4 until 2026-09-03, when the maintainer had
    // the caps removed as arbitrary, so the schema must not advertise a bound the server no longer has.
    // The one bound left is the DEPTH, pinned above.
    assert.equal(list.result.tools[6].inputSchema.properties.questions.maxItems, undefined, "questions carry no maxItems")
    for (let node = askQuestion, level = 1; node; level++) {
      assert.equal(node.properties.options.maxItems, undefined, `options carry no maxItems at level ${level}`)
      const followUps = node.properties.options.items.properties.followUps
      if (followUps) assert.equal(followUps.maxItems, undefined, `followUps carry no maxItems at level ${level}`)
      node = followUps?.items
    }
    // The web still draws a placement marker's card where the marker sits (upstream's questionShadow.ts,
    // kept on purpose 2026-10-06), so `ask` must not claim a marker draws nothing — it says to write none.
    assert.doesNotMatch(list.result.tools[6].description, /There is no placement marker|fence draws nothing/)
    assert.match(list.result.tools[6].description, /Write no placement marker either: an empty ```question qst_… fence draws the card where it sits instead/)
    assert.deepEqual(list.result.tools[7].inputSchema.required, ["id"])
    assert.deepEqual(Object.keys(list.result.tools[7].inputSchema.properties), ["id"])
    // `done` takes the write-up and `quiet`, and NOTHING ELSE. There is no `force`, and no parameter for a
    // worker to reach for when the gate refuses it — a bypass riding the gated call gets learned, and the
    // gate degrades to a two-token tax (plans/rest-by-registration.md). `quiet` (2026-10-05) is not one:
    // the gate refuses a quiet done exactly as it refuses a loud one, and quiet only decides where an
    // ALLOWED done lands — Done instead of the queue — on a scheduled run alone (ARCHITECTURE.md § Scheduled threads).
    assert.deepEqual(list.result.tools[8].inputSchema.required, ["body"])
    assert.deepEqual(Object.keys(list.result.tools[8].inputSchema.properties), ["body", "quiet"])
    // `title` takes ONLY the name. It exposes no thread parameter for `goal`'s reason — the slug comes
    // from the server's env — so a worker can rename its own thread and no other.
    assert.deepEqual(list.result.tools[9].inputSchema.required, ["title"])
    assert.deepEqual(Object.keys(list.result.tools[9].inputSchema.properties), ["title"])
    // `activity` READS every kind of background work with the ids a fence names them by, plus the
    // `wch_…` id of any watch holding one. It takes NOTHING: there is no thread parameter and no filter,
    // because the only correct answer is "everything you have running", and a worker that has lost its
    // ids cannot be trusted to name them.
    assert.equal(list.result.tools.length, 21)
    // `deadline` — the thread's time limit. `action` alone is required and there is NO thread parameter:
    // the slug comes from the env, so a worker reads and sets only its own.
    const deadlineTool = list.result.tools[18]
    assert.equal(deadlineTool.name, "deadline")
    assert.deepEqual(deadlineTool.inputSchema.required, ["action"])
    assert.deepEqual(deadlineTool.inputSchema.properties.action.enum, ["read", "set", "extend", "clear"])
    assert.ok(!("slug" in deadlineTool.inputSchema.properties))
    assert.ok(deadlineTool.description.includes("only they can move"))
    // `schedule` — `action` alone is required, like its action-switch siblings, and NO thread parameter:
    // the caller (who proposed, who skipped) comes from the env. The echo instruction is the point of
    // the description: the human catches a mistranslated time only if the worker relays it.
    const scheduleTool = list.result.tools[17]
    assert.equal(scheduleTool.name, "schedule")
    assert.deepEqual(scheduleTool.inputSchema.required, ["action"])
    assert.deepEqual(scheduleTool.inputSchema.properties.action.enum, ["create", "dry_run", "update", "list", "pause", "skip_next", "move_next"])
    assert.ok(!("slug" in scheduleTool.inputSchema.properties) && !("thread" in scheduleTool.inputSchema.properties))
    for (const cue of ["RELAY IT TO THE USER VERBATIM", "DOES NOT RUN UNTIL THE USER CLICKS TURN ON", "ALWAYS include BYHOUR and BYMINUTE", "`--model` and `--effort` are REQUIRED"]) {
      assert.ok(scheduleTool.description.includes(cue), cue)
    }
    // `editor` READS the human's editor and takes nothing: no window to pick, no project to name — the
    // window is the one on the caller's project, chosen by the server. Marked read-only for the client.
    const editorTool = list.result.tools.find((t: { name: string }) => t.name === "editor")
    assert.deepEqual(editorTool.inputSchema.required, [])
    assert.deepEqual(Object.keys(editorTool.inputSchema.properties), [])
    assert.equal(editorTool.annotations.readOnlyHint, true)
    // The words a human uses for code they have not pasted are what make a worker reach for it.
    for (const cue of ["\"this\"", "\"the selected code\"", "\"the error\"", "\"what I'm looking at\""]) assert.ok(editorTool.description.includes(cue), cue)
    // `read_thread` / `message_thread` name the OTHER thread by handle; the CALLER still comes from the
    // env, so a message is always signed by the thread that really sent it.
    assert.deepEqual(list.result.tools[14].inputSchema.required, ["handle"])
    assert.deepEqual(list.result.tools[15].inputSchema.required, ["handle", "message"])
    // `secret` — one masked question. NO thread parameter, and nothing that could carry the value itself:
    // the user types it into the card, never the worker into the call.
    const secretTool = list.result.tools[19]
    assert.equal(secretTool.name, "secret")
    assert.deepEqual(secretTool.inputSchema.required, ["question"])
    assert.deepEqual(Object.keys(secretTool.inputSchema.properties), ["question", "header"])
    assert.deepEqual(list.result.tools[10].inputSchema.required, [])
    assert.deepEqual(Object.keys(list.result.tools[10].inputSchema.properties), [])
    // `extend_shell` — a background shell's runtime budget: the handle and a duration, both required,
    // and no thread parameter.
    assert.deepEqual(list.result.tools[13].inputSchema.required, ["shell", "for"])
    assert.deepEqual(Object.keys(list.result.tools[13].inputSchema.properties), ["shell", "for"])
    // `watch_command` — the server-run check (2026-10-11). `action` alone is required, and NO thread
    // parameter: the command runs for the calling thread only, under that thread's own permission gate.
    assert.deepEqual(list.result.tools[20].inputSchema.required, ["action"])
    assert.deepEqual(Object.keys(list.result.tools[20].inputSchema.properties), ["action", "command", "every", "for", "id"])

    // An unregistered name is a protocol error, not a crash — the registry routes by name now.
    rpc.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "spawn_ntwine_thread", arguments: {} } })
    const gone = await rpc.next(3)
    assert.match(gone.error.message, /unknown tool: spawn_ntwine_thread/)
  } finally {
    rpc.kill()
  }
})

// A TOOL IS LISTED ONLY WHILE ITS CAPABILITY EXISTS (plans/upstream-superset.md §5): `editor` while an
// editor window has this project open. Against a real HTTP server standing in for ntwine's
// `workerCapabilities`, flipped mid-session the way a human opens and closes VS Code: the first list
// leaves `editor` out, an editor that appears is announced with `notifications/tools/list_changed` and
// listed on the re-list, and one that goes is withdrawn only once it has read absent at two polls in a
// row (a window reloading drops its socket for a moment).
test("`editor` is listed only while an editor has the project open, and the list follows it live", async () => {
  let editor = false
  // Answers served before `editor` is consulted again, one per request: how a single poll is made to read
  // a value without racing the poll's timer.
  const once: boolean[] = []
  const asked: Array<{ url: string; body: unknown }> = []
  const http = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      asked.push({ url: req.url ?? "", body: JSON.parse(body) })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ result: { editor: once.length ? once.shift() : editor } }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "ntwine-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  const POLL_MS = 150
  const rpc = startServer({ NTWINE_STATE_DIR: stateDir, NTWINE_PROJECT_ID: "proj", NTWINE_THREAD: "", NTWINE_THREAD_SLUG: "caller", NTWINE_CAPABILITY_POLL_MS: String(POLL_MS) })
  const names = (list: any) => list.result.tools.map((t: { name: string }) => t.name)
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)
    rpc.send({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    const first = names(await rpc.next(2))
    assert.ok(!first.includes("editor"), "no editor has the project open, so the tool is not listed")
    assert.equal(first.length, 20)
    // Asked of OUR project, naming the calling thread (a window on its own checkout counts).
    assert.deepEqual(asked[0], { url: "/_ntwine/proj/rpc/workerCapabilities", body: { slug: "caller" } })

    // Polls that read the same answer announce nothing.
    await new Promise((r) => setTimeout(r, POLL_MS * 3))
    assert.deepEqual(rpc.notifications, [])

    editor = true
    await rpc.notified("notifications/tools/list_changed")
    rpc.send({ jsonrpc: "2.0", id: 3, method: "tools/list" })
    assert.ok(names(await rpc.next(3)).includes("editor"), "an editor that appears is listed")

    // Gone for ONE poll (a reload): nothing is withdrawn.
    once.push(false)
    while (once.length) await new Promise((r) => setTimeout(r, 20))
    await new Promise((r) => setTimeout(r, POLL_MS * 3))
    assert.equal(rpc.notifications.length, 1, "a capability absent at a single poll does not change the list")

    // Gone for good: withdrawn after the second absent poll, and the re-list leaves it out.
    editor = false
    await rpc.notified("notifications/tools/list_changed")
    rpc.send({ jsonrpc: "2.0", id: 4, method: "tools/list" })
    assert.ok(!names(await rpc.next(4)).includes("editor"), "an editor that goes is withdrawn")
    assert.equal(rpc.notifications.length, 2)
  } finally {
    rpc.kill()
    http.close()
  }
})

// An ntwine from before `workerCapabilities` answers 404: the capability is unknown, not absent, so every
// tool stays listed — gating must never take a tool away because the server is older than the worker.
test("a server that cannot report capabilities keeps every tool listed", async () => {
  const http = createServer((_req, res) => {
    res.writeHead(404)
    res.end("not found")
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "ntwine-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  const rpc = startServer({ NTWINE_STATE_DIR: stateDir, NTWINE_PROJECT_ID: "proj", NTWINE_THREAD_SLUG: "caller", NTWINE_CAPABILITY_POLL_MS: "100" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)
    rpc.send({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    const list = await rpc.next(2)
    assert.ok(list.result.tools.some((t: { name: string }) => t.name === "editor"))
    assert.equal(list.result.tools.length, 21)
    await new Promise((r) => setTimeout(r, 400))
    assert.deepEqual(rpc.notifications, [], "an unreadable report never changes the list")
  } finally {
    rpc.kill()
    http.close()
  }
})

// A thread names another by its `@handle` (David 2026-10-06), so the result hands the new thread's
// back; a thread the server could not name in time has none, and gets the drawer link instead.
//
// THE WAY BACK (upstream 06f82a3a): a spawned thread starts with nothing but its prompt, so the shim names
// the spawner at the end of it — without that the child could not `message_thread` its results back even
// when asked to. The task comes first, untouched; the footer is the only thing added.
test("`spawn_thread` POSTs the real dispatch RPC and names the new thread by its @handle, else links it", async () => {
  const seen: Array<{ url: string; body: unknown }> = []
  const handles = ["child", undefined, undefined]
  const http = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      seen.push({ url: req.url ?? "", body: JSON.parse(body) })
      const handle = handles.shift()
      res.writeHead(200, { "content-type": "application/json" })
      const asked = JSON.parse(body) as { project?: string }
      res.end(JSON.stringify({ result: { slug: "spawned-child", ...(handle ? { handle } : {}), ...(asked.project ? { project: asked.project } : {}) } }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "ntwine-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  const rpc = startServer({ NTWINE_STATE_DIR: stateDir, NTWINE_THREAD: "", NTWINE_THREAD_SLUG: "caller" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)
    rpc.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "spawn_thread", arguments: { prompt: "do the thing", model: "opus", effort: "high", title: "Child" } },
    })
    const call = await rpc.next(2)
    assert.equal(call.result.isError, undefined)
    assert.match(call.result.content[0].text, /It is @child: name it that way/)
    assert.doesNotMatch(call.result.content[0].text, /\/thread\//, "a named thread is not handed over as a link")
    assert.match(call.result.content[0].text, /It knows this thread: if its prompt asked for results back, they arrive as a message that wakes you/)
    const back = (prompt: string) => prompt.startsWith("do the thing\n\n---\n") && /Spawned by the ntwine thread `caller`/.test(prompt) && /`ntwinectl message-thread caller --message-file <file\|->`/.test(prompt)
    const sent = seen as Array<{ url: string; body: { prompt: string } }>
    assert.ok(back(sent[0].body.prompt), sent[0].body.prompt)
    assert.deepEqual(seen, [{ url: "/_ntwine/rpc/dispatch", body: { prompt: sent[0].body.prompt, model: "opus", effort: "high", title: "Child", awaitHandle: true, spawnedFrom: "caller" } }])

    rpc.send({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "spawn_thread", arguments: { prompt: "do the thing", model: "opus", effort: "high", title: "Child" } },
    })
    const unnamed = await rpc.next(4)
    assert.match(unnamed.result.content[0].text, /It has no handle yet[\s\S]*\[Child\]\(\/thread\/spawned-child\)/)

    // Another project: the choice rides to OUR project's RPC (which routes it), and an unnamed thread's
    // link carries the target's prefix, since a bare `/thread/…` resolves against the caller's project.
    rpc.send({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "spawn_thread", arguments: { prompt: "fix the docs", model: "sonnet", effort: "medium", title: "Docs", project: " arktype " } },
    })
    const there = await rpc.next(5)
    assert.equal(there.result.isError, undefined)
    assert.match(there.result.content[0].text, /on the `arktype` project's board/)
    assert.match(there.result.content[0].text, /\[Docs\]\(\/project\/arktype\/thread\/spawned-child\)/)
    assert.match(sent[2].body.prompt, /^fix the docs\n\n---\nSpawned by the ntwine thread `caller`/)
    assert.deepEqual(seen[2], { url: "/_ntwine/rpc/dispatch", body: { prompt: sent[2].body.prompt, model: "sonnet", effort: "medium", title: "Docs", project: "arktype", awaitHandle: true, spawnedFrom: "caller" } })

    // model/effort stay REQUIRED server-side, not only in the schema — a lenient client must not be
    // able to skip the deliberate choice.
    rpc.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "spawn_thread", arguments: { prompt: "x" } } })
    const bad = await rpc.next(3)
    assert.equal(bad.result.isError, true)
    assert.match(bad.result.content[0].text, /`spawn_thread` failed: `model` is required/)
  } finally {
    rpc.kill()
    http.close()
  }
})

// `editor` against a real HTTP stand-in for the `editorState` RPC: what the worker READS is the text, so
// the text is what is asserted — the file and selection first, the selected code verbatim in a fence,
// the tabs, the problems grouped by file — and every way of having nothing to show says why.
test("`editor` reads the window on this project as text, and says why when there is nothing to read", async () => {
  const seen: Array<{ url: string; body: unknown }> = []
  let answer: { status: number; body: unknown } = { status: 200, body: {} }
  const http = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      seen.push({ url: req.url ?? "", body: JSON.parse(body) })
      res.writeHead(answer.status, { "content-type": "application/json" })
      res.end(JSON.stringify(answer.body))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "ntwine-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  const projectId = "0b7c1f6e-5a2d-4c4e-9d61-6f1f7c2b9a10"
  // No thread stamped (the test may itself run inside an ntwine worker, whose NTWINE_THREAD would ride in).
  const rpc = startServer({ NTWINE_STATE_DIR: stateDir, NTWINE_PROJECT_ID: projectId, NTWINE_THREAD: "", NTWINE_THREAD_SLUG: "" })
  let id = 10
  const call = async (result: unknown, status = 200) => {
    answer = { status, body: status === 200 ? { result } : result }
    const n = ++id
    rpc.send({ jsonrpc: "2.0", id: n, method: "tools/call", params: { name: "editor", arguments: {} } })
    const reply = await rpc.next(n)
    return { text: reply.result.content[0].text as string, isError: reply.result.isError as boolean | undefined }
  }
  const front = {
    app: "Visual Studio Code",
    kind: "vscode",
    focused: true,
    folders: ["/home/me/repo"],
    editor: {
      shared: true,
      reportedAgoMs: 4_000,
      active: {
        path: "/home/me/repo/src/a.ts",
        languageId: "typescript",
        dirty: true,
        lineCount: 40,
        cursorLine: 14,
        // A whole-line drag: the text ends in the newline before the next line, which the fence leaves out.
        selection: { startLine: 12, endLine: 14, text: "  let total = 0\n  // ```not a fence```\n  total += x\n" },
        visible: { startLine: 1, endLine: 30 },
      },
      open: [{ path: "/home/me/repo/src/b.ts", dirty: true }, { path: "Untitled-1", untitled: true }],
      diagnostics: [
        { path: "/home/me/repo/src/a.ts", line: 13, severity: "error", message: "Cannot find name 'x'.", source: "ts", code: "2304" },
        { path: "/home/me/repo/src/c.ts", line: 2, severity: "error", message: "Type 'string' is not assignable to type 'number'." },
        { path: "/home/me/repo/src/a.ts", line: 3, severity: "warning", message: "'y' is declared but never used.", source: "ts", code: "6133" },
      ],
      problems: { errors: 2, warnings: 7 },
    },
  }
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)

    const full = await call({ windows: [front, { app: "Cursor", kind: "cursor", focused: false, focusedAgoMs: 7_200_000, folders: ["/home/me/repo/packages/x"], editor: { ...front.editor, active: { ...front.editor.active, path: "/home/me/repo/packages/x/i.ts", dirty: false, selection: undefined, cursorLine: 3 } } }], connected: 2 })
    assert.equal(full.isError, undefined)
    assert.deepEqual(seen.at(-1), { url: `/_ntwine/${projectId}/rpc/editorState`, body: {} }, "the CALLING project's procedure, by its id")
    assert.equal(full.text, [
      "Visual Studio Code (focused now, folder /home/me/repo), last changed 4s ago.",
      "",
      "In front: /home/me/repo/src/a.ts (typescript, unsaved changes), lines 12-14 selected.",
      "Selected text (3 lines):",
      // A fence one longer than any backtick run inside the selection, so the code cannot close it.
      "````typescript",
      "  let total = 0",
      "  // ```not a fence```",
      "  total += x",
      "````",
      "Caret on line 14; lines 1-30 on screen; 40 lines in all.",
      "",
      "Other open tabs, most recent first (2):",
      "- /home/me/repo/src/b.ts (unsaved changes)",
      "- Untitled-1 (untitled, not saved to disk)",
      "",
      "Problems: 2 errors, 7 warnings (the first 3: the file in front first, errors before warnings).",
      "/home/me/repo/src/a.ts",
      "  13: error: Cannot find name 'x'. [ts 2304]",
      "  3: warning: 'y' is declared but never used. [ts 6133]",
      "/home/me/repo/src/c.ts",
      "  2: error: Type 'string' is not assignable to type 'number'.",
      "",
      "Also open in 1 other window (not read in full; the one above was used last):",
      "- Cursor (last focused 2h ago, folder /home/me/repo/packages/x) — /home/me/repo/packages/x/i.ts (typescript), caret on line 3",
    ].join("\n"))

    // A selection too large to carry whole says so, and where to read the rest.
    const truncated = await call({ windows: [{ ...front, editor: { ...front.editor, active: { ...front.editor.active, selection: { startLine: 1, endLine: 900, text: "x", truncated: true } } } }], connected: 1 })
    assert.match(truncated.text, /Selected text \(900 lines; ONLY THE START — the selection was too large to carry whole, so read the file for the rest\):/)

    // A file that may hold secrets: its lines are named and its text is not there to quote.
    const withheld = await call({ windows: [{ ...front, editor: { ...front.editor, active: { ...front.editor.active, path: "/home/me/repo/.env", selection: { startLine: 2, endLine: 3, withheld: true } } } }], connected: 1 })
    assert.match(withheld.text, /In front: \/home\/me\/repo\/\.env \(typescript, unsaved changes\), lines 2-3 selected\.\nIts text is not shared: the file may hold secrets\. Read lines 2-3 of the file yourself only if the task needs it\./)
    assert.doesNotMatch(withheld.text, /````/)

    // Each way of having nothing to show, with its reason and the move that is always open.
    const off = await call({ windows: [{ ...front, editor: { shared: false, reportedAgoMs: 0, active: null, open: [], diagnostics: [], problems: { errors: 0, warnings: 0 } } }], connected: 1 })
    assert.match(off.text, /turned off sharing their editor with ntwine \(the eye over the sidebar's prompt box, the `ntwine.shareEditorState` setting\)/)
    const silent = await call({ windows: [{ ...front, editor: undefined }], connected: 1 })
    assert.match(silent.text, /has this project open, but it has not reported what it shows: its ntwine extension predates this/)
    const none = await call({ windows: [], connected: 0 })
    assert.match(none.text, /^No editor is connected to ntwine/)
    // Windows on other projects are counted, never described — and an OLDER server's listing of their
    // folders (it sent `elsewhere` until 2026-10-02) is not repeated to the worker either.
    const elsewhere = await call({ windows: [], connected: 2, elsewhere: [{ app: "Cursor", folders: ["/home/me/other"] }] })
    assert.match(elsewhere.text, /^2 editor windows are connected to ntwine, but none has this project open, so what the user has in front of them is in another project\./)
    assert.doesNotMatch(elsewhere.text, /\/home\/me\/other/)
    const empty = await call({ windows: [{ ...front, editor: { ...front.editor, active: null, open: [], diagnostics: [], problems: { errors: 0, warnings: 0 } } }], connected: 1 })
    assert.match(empty.text, /No file is in front/)
    assert.match(empty.text, /Problems: no errors or warnings\./)
    for (const reply of [off, silent, none, elsewhere]) {
      assert.match(reply.text, /Ask the user to paste the code, or to name the file and lines they mean\.$/)
      assert.equal(reply.isError, undefined, "having nothing to read is an answer, not a failure")
    }

    // An ntwine from before the procedure answers 404 naming it (packages/rpc's fall-through).
    const old = await call({ error: "unknown RPC procedure `editorState` — this server does not implement it." }, 404)
    assert.match(old.text, /predates this command\. Restart ntwine to enable this\./)
    assert.equal(old.isError, undefined)
    // Any other failure is the tool failing, with the server's own words.
    const broken = await call({ error: "the bridge exploded" }, 500)
    assert.equal(broken.isError, true)
    assert.match(broken.text, /`editor` failed: the bridge exploded/)
  } finally {
    rpc.kill()
    http.close()
  }
})

// A thread in a worktree: the human's editor shows the main checkout, so what they selected is THEIR copy.
// The tool names the calling thread (its own stamp, never an argument), and when the server says that
// thread works elsewhere, the report says whose copy each path is and names the worker's own copy.
test("`editor` tells a thread in a worktree that the human's editor shows the main checkout, and names its own copy", async () => {
  const seen: unknown[] = []
  let answer: unknown = {}
  const http = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      seen.push(JSON.parse(body))
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ result: answer }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "ntwine-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  const rpc = startServer({ NTWINE_STATE_DIR: stateDir, NTWINE_PROJECT_ID: "0b7c1f6e-5a2d-4c4e-9d61-6f1f7c2b9a10", NTWINE_THREAD_SLUG: "tidy-loop", NTWINE_THREAD: "" })
  let id = 10
  const call = async (result: unknown) => {
    answer = result
    const n = ++id
    rpc.send({ jsonrpc: "2.0", id: n, method: "tools/call", params: { name: "editor", arguments: {} } })
    return ((await rpc.next(n)).result.content[0].text as string)
  }
  const root = "/home/me/repo"
  const dir = "/home/me/repo/.ntwine/worktrees/tidy-loop"
  const window = (active: string, open: string[] = [], folders = [root]) => ({
    app: "Visual Studio Code",
    kind: "vscode",
    focused: true,
    folders,
    editor: {
      shared: true,
      reportedAgoMs: 0,
      active: { path: active, languageId: "typescript", dirty: false, lineCount: 9, cursorLine: 3, selection: { startLine: 2, endLine: 3, text: "a\nb" }, visible: { startLine: 1, endLine: 9 } },
      open: open.map((path) => ({ path })),
      diagnostics: [],
      problems: { errors: 0, warnings: 0 },
    },
  })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)

    const main = await call({ windows: [window(`${root}/src/a.ts`, [`${root}/src/b.ts`])], connected: 1, elsewhere: [], checkout: { dir, root, kind: "worktree" } })
    assert.deepEqual(seen.at(-1), { slug: "tidy-loop" }, "the CALLING thread, from its own stamp")
    assert.equal(main.split("\n").slice(0, 5).join("\n"), [
      "Visual Studio Code (focused now, folder /home/me/repo), last changed just now.",
      "",
      "You are working in your own worktree, /home/me/repo/.ntwine/worktrees/tidy-loop, but this window shows the project's main checkout, /home/me/repo. " +
        "A file below under /home/me/repo is the user's copy, and what they selected is its text; the same relative path under " +
        "/home/me/repo/.ntwine/worktrees/tidy-loop is your copy, which may differ. Read and edit yours.",
      "",
      "In front: /home/me/repo/src/a.ts (typescript), lines 2-3 selected. Your copy: /home/me/repo/.ntwine/worktrees/tidy-loop/src/a.ts.",
    ].join("\n"))

    // The human opened the worktree itself: everything shown is already the worker's own copy.
    const own = await call({ windows: [window(`${dir}/src/a.ts`, [], [dir])], connected: 1, elsewhere: [], checkout: { dir, root, kind: "worktree" } })
    assert.match(own, /\n\nThis window has your own worktree open, \/home\/me\/repo\/\.ntwine\/worktrees\/tidy-loop: the files below under it are your own copies\.\n\nIn front: \/home\/me\/repo\/\.ntwine\/worktrees\/tidy-loop\/src\/a\.ts \(typescript\), lines 2-3 selected\.\n/)
    assert.doesNotMatch(own, /Your copy:|main checkout/)

    // A file outside the project is nobody's copy; a thread at the root gets no clause at all.
    const outside = await call({ windows: [window("/etc/hosts")], connected: 1, elsewhere: [], checkout: { dir, root, kind: "worktree" } })
    assert.doesNotMatch(outside, /Your copy:|main checkout|own copies/)
    const atRoot = await call({ windows: [window(`${root}/src/a.ts`)], connected: 1, elsewhere: [] })
    assert.doesNotMatch(atRoot, /Your copy:|main checkout|own copies/)
    // A malformed checkout is ignored rather than trusted.
    const junk = await call({ windows: [window(`${root}/src/a.ts`)], connected: 1, elsewhere: [], checkout: { dir: 3 } })
    assert.doesNotMatch(junk, /Your copy:/)
  } finally {
    rpc.kill()
    http.close()
  }
})

// ONE ntwine serves every project on the machine, and it publishes exactly ONE `server.lock` — the
// LAUNCHING project's. A worker in any other open project therefore has to be told two things it
// cannot derive: where that lock is, and which project it is acting for. Get the first wrong and every
// ntwine tool dies on ENOENT (the observed break: nub, boron and pullfrog-app workers all reported
// "could not read the ntwine server lock … ENOENT", and zod, which still had a stale lock from its own
// pre-singleton server, reported "dispatch request failed" against a dead port). Get the SECOND wrong
// and it is worse than an error: an unprefixed `/_ntwine/rpc/dispatch` is the LAUNCHING project by
// definition, so the worker silently spawns its thread onto somebody else's board.
test("the tools address the CALLING project's RPC, at the lock the singleton actually publishes", async () => {
  const seen: string[] = []
  const http = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      seen.push(req.url ?? "")
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ result: { slug: "spawned-child" } }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  // The lock lives in the LAUNCHER's state dir; this worker's own project dir has none, exactly as on
  // a real machine — so a run that still resolved the lock from NTWINE_STATE_DIR fails here.
  const launcherStateDir = mkdtempSync(join(tmpdir(), "ntwine-mcp-launcher-"))
  const stateDir = mkdtempSync(join(tmpdir(), "ntwine-mcp-tenant-"))
  writeFileSync(join(launcherStateDir, "server.lock"), JSON.stringify({ port }))
  const projectId = "b47f4055-4262-432a-af18-ded4cbfb3071"
  const rpc = startServer({
    NTWINE_STATE_DIR: stateDir,
    NTWINE_SERVER_LOCK: join(launcherStateDir, "server.lock"),
    NTWINE_PROJECT_ID: projectId,
    NTWINE_THREAD_SLUG: "owning-thread",
  })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)
    rpc.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "spawn_thread", arguments: { prompt: "do the thing", model: "opus", effort: "high" } },
    })
    assert.equal((await rpc.next(2)).result.isError, undefined)
    // Every tool travels the same transport, so the prefix has to be on the shared path and not only
    // on spawn's: a timer armed on the launcher's board would fire into a thread that is not ours.
    rpc.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "timer", arguments: { action: "list" } } })
    assert.equal((await rpc.next(3)).result.isError, undefined)
    assert.deepEqual(seen, [`/_ntwine/${projectId}/rpc/dispatch`, `/_ntwine/${projectId}/rpc/listOwnThreadTimers`])
  } finally {
    rpc.kill()
    http.close()
  }
})

// AN UPDATE MUST REACH A WORKER THAT IS ALREADY RUNNING.
//
// This process lives in a DETACHED daemon that outlives ntwine, so anything frozen into its env at spawn
// is stale the moment "Update & Restart" moves the port — and a worker whose only address was stale lost
// every ntwine tool it had, with no way back short of restarting the worker. Both facts are therefore
// re-resolved from the filesystem on EVERY call: the address from the machine-wide lock, and the project
// from the tree the worker is standing in. Neither can be frozen, and neither can be named by the model.
test("a stale address heals itself: the machine lock wins when the stamped one is dead", async () => {
  const seen: string[] = []
  const http = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      seen.push(req.url ?? "")
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ result: { slug: "spawned-child" } }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port

  // The ntwine root, laid out as on a real machine: `<root>/server.lock` beside `<root>/projects/<id>/`.
  const root = mkdtempSync(join(tmpdir(), "ntwine-mcp-root-"))
  const stateDir = join(root, "projects", "11111111-1111-4111-8111-111111111111")
  mkdirSync(stateDir, { recursive: true })
  // What the server stamped at spawn, now pointing at a DEAD process on a port nothing serves — exactly
  // the shape zod's lock had (pid 76070, gone since Aug 1), which reported only "fetch failed".
  const stale = join(root, "projects", "22222222-2222-4222-8222-222222222222")
  mkdirSync(stale, { recursive: true })
  writeFileSync(join(stale, "server.lock"), JSON.stringify({ pid: 999_999, port: port + 1 }))
  // The machine address, republished by the restart that moved the port.
  writeFileSync(join(root, "server.lock"), JSON.stringify({ pid: process.pid, port }))

  const rpc = startServer({
    NTWINE_STATE_DIR: stateDir,
    NTWINE_SERVER_LOCK: join(stale, "server.lock"),
    NTWINE_PROJECT_ID: "11111111-1111-4111-8111-111111111111",
    NTWINE_THREAD_SLUG: "owning-thread",
  })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)
    rpc.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "timer", arguments: { action: "list" } } })
    assert.equal((await rpc.next(2)).result.isError, undefined, "a dead stamped lock must not be fatal")
    assert.deepEqual(seen, ["/_ntwine/11111111-1111-4111-8111-111111111111/rpc/listOwnThreadTimers"])
  } finally {
    rpc.kill()
    http.close()
  }
})

test("with no stamp at all, the project is the one the worker is STANDING IN", async () => {
  const seen: string[] = []
  const http = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      seen.push(req.url ?? "")
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ result: { slug: "spawned-child" } }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "ntwine-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ pid: process.pid, port }))
  // A checkout with ntwine's own identity file, and the worker two directories down inside it.
  const repo = mkdtempSync(join(tmpdir(), "ntwine-mcp-repo-"))
  mkdirSync(join(repo, ".ntwine"), { recursive: true })
  writeFileSync(join(repo, ".ntwine", ".id"), "33333333-3333-4333-8333-333333333333\n")
  const deep = join(repo, "packages", "server")
  mkdirSync(deep, { recursive: true })

  // No NTWINE_PROJECT_ID: this is a worker spawned by a server that predates the stamp.
  const rpc = startServer({ NTWINE_STATE_DIR: stateDir, NTWINE_THREAD_SLUG: "owning-thread" }, deep)
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)
    rpc.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "timer", arguments: { action: "list" } } })
    assert.equal((await rpc.next(2)).result.isError, undefined)
    assert.deepEqual(seen, ["/_ntwine/33333333-3333-4333-8333-333333333333/rpc/listOwnThreadTimers"],
      "the id walked up from cwd, not the launching project")
  } finally {
    rpc.kill()
    http.close()
  }
})

// The stop-hook tool's whole reason to exist is that it acts on the CALLING thread, which it can only
// learn from its env — so what this pins is the slug actually reaching the RPC body, over the real
// stdio transport against a real HTTP server. A tool that armed a hook on the wrong thread (or on none)
// would look identical to the worker, and would make some OTHER thread loop forever.
test("`goal` arms and disarms the CALLING thread, identified from its env", async () => {
  const seen: Array<{ url: string; body: any }> = []
  const http = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      seen.push({ url: req.url ?? "", body: JSON.parse(body || "{}") })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ result: null }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "ntwine-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  const rpc = startServer({ NTWINE_STATE_DIR: stateDir, NTWINE_THREAD_SLUG: "owning-thread" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)

    rpc.send({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "goal", arguments: { action: "start", prompt: "keep the migration moving" } },
    })
    const armed = await rpc.next(2)
    assert.equal(armed.result.isError, undefined)
    // NAMING NO TRIGGER defaults to the rest one. A `start` with neither is a model asking to be
    // re-prompted and leaving the mechanism to us; rest is the safe reading, because it cannot talk over
    // a running turn and cannot fire on a thread that has stopped needing it.
    assert.deepEqual(seen.at(-1), {
      url: "/_ntwine/rpc/setOwnThreadRecurringPrompt",
      // The limits go EXPLICITLY null: a `start` replaces the whole goal, so one naming no limit is an
      // unbounded goal, not "keep the cap that was there".
      body: { slug: "owning-thread", prompt: "keep the migration moving", stopHook: true, heartbeat: false, postCompaction: false, maxRuns: null, forSeconds: null },
    })
    // The reply must teach how it ENDS, or a worker only knows how to start one — and it must warn
    // about the sign-off rather than merely offering it, since that exit files the thread away.
    assert.match(armed.result.content[0].text, /Run `ntwinectl goal stop` once the work it drives is finished/)
    assert.match(armed.result.content[0].text, /```done/)
    assert.match(armed.result.content[0].text, /only when there is genuinely nothing left/)

    // BOTH triggers named on a schedule-only start, and the cadence carried through as seconds.
    rpc.send({
      jsonrpc: "2.0", id: 6, method: "tools/call",
      params: { name: "goal", arguments: { action: "start", prompt: "check the deploy", heartbeat_seconds: 600 } },
    })
    const scheduled = await rpc.next(6)
    assert.equal(scheduled.result.isError, undefined)
    assert.deepEqual(seen.at(-1), {
      url: "/_ntwine/rpc/setOwnThreadRecurringPrompt",
      body: { slug: "owning-thread", prompt: "check the deploy", stopHook: false, heartbeat: true, postCompaction: false, intervalSeconds: 600, maxRuns: null, forSeconds: null },
    }, "giving a cadence and nothing else means the schedule trigger alone")
    assert.match(scheduled.result.content[0].text, /every 10m/)

    rpc.send({
      jsonrpc: "2.0", id: 7, method: "tools/call",
      params: { name: "goal", arguments: { action: "start", prompt: "keep going", stop_hook: true, heartbeat_seconds: 900 } },
    })
    await rpc.next(7)
    assert.deepEqual(seen.at(-1), {
      url: "/_ntwine/rpc/setOwnThreadRecurringPrompt",
      body: { slug: "owning-thread", prompt: "keep going", stopHook: true, heartbeat: true, postCompaction: false, intervalSeconds: 900, maxRuns: null, forSeconds: null },
    }, "both triggers at once is the ordinary keep-this-moving case")

    // A BOUNDED LOOP: `max_runs` and `for`, the latter in the `for:` grammar, both carried through.
    rpc.send({
      jsonrpc: "2.0", id: 9, method: "tools/call",
      params: { name: "goal", arguments: { action: "start", prompt: "one more pass", max_runs: 20, for: "2h" } },
    })
    const bounded = await rpc.next(9)
    assert.equal(bounded.result.isError, undefined)
    assert.deepEqual(seen.at(-1), {
      url: "/_ntwine/rpc/setOwnThreadRecurringPrompt",
      body: { slug: "owning-thread", prompt: "one more pass", stopHook: true, heartbeat: false, postCompaction: false, maxRuns: 20, forSeconds: 7200 },
    })
    assert.match(bounded.result.content[0].text, /bounded loop: at most 20 times, and for 2h/)
    // A span outside the grammar, or outside the Goal's bounds, never reaches the server.
    const beforeBad = seen.length
    for (const [id, args, pattern] of [
      [10, { for: "2 hours" }, /`--for` must be a duration/],
      [11, { for: "30s" }, /between `1m` and `30d`/],
      [12, { max_runs: 0 }, /`--max-runs` must be a whole number/],
    ] as const) {
      rpc.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "goal", arguments: { action: "start", prompt: "x", ...args } } })
      const bad = await rpc.next(id)
      assert.equal(bad.result.isError, true)
      assert.match(bad.result.content[0].text, pattern)
    }
    assert.equal(seen.length, beforeBad)

    // NO QUESTION HOLD TO OPT OUT OF. A `pause_on_questions` argument held every trigger while the thread
    // was waiting on the human; it and the footer switch that inverted it were deleted 2026-08-16, so a
    // caller that still passes it is refused by the tool's own strict schema rather than silently ignored.
    rpc.send({
      jsonrpc: "2.0", id: 8, method: "tools/call",
      params: { name: "goal", arguments: { action: "start", prompt: "beat me anyway", heartbeat_seconds: 600 } },
    })
    await rpc.next(8)
    assert.equal("pauseOnQuestions" in (seen.at(-1) as { body: Record<string, unknown> }).body, false)

    rpc.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "goal", arguments: { action: "stop" } } })
    const stopped = await rpc.next(3)
    assert.equal(stopped.result.isError, undefined)
    assert.deepEqual(seen.at(-1), {
      url: "/_ntwine/rpc/setOwnThreadRecurringPrompt",
      body: { slug: "owning-thread", prompt: null, stopHook: false, heartbeat: false, postCompaction: false },
    })

    // A `start` with no prompt is refused in the HANDLER, not merely by the schema.
    const before = seen.length
    rpc.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "goal", arguments: { action: "start" } } })
    const bare = await rpc.next(4)
    assert.equal(bare.result.isError, true)
    assert.match(bare.result.content[0].text, /`prompt` is required/)
    assert.equal(seen.length, before, "and nothing was sent to the server")

    // A bogus action likewise never reaches the RPC.
    rpc.send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "goal", arguments: { action: "pause" } } })
    const bogus = await rpc.next(5)
    assert.equal(bogus.result.isError, true)
    assert.match(bogus.result.content[0].text, /`action` must be one of/)
    assert.equal(seen.length, before)
  } finally {
    rpc.kill()
    http.close()
  }
})

// `title` is the CONSIDERED naming pass — the one a worker makes after reading the task, replacing the
// name ntwine minted from the raw prompt at spawn. What this pins is the two things a worker gets wrong
// without them: that it can only ever name its OWN thread (the slug comes from the env, never from the
// model), and that a human's rename comes back as a REPORTED refusal rather than an error, because an
// error is the one answer a model retries against a call that can never succeed.
test("`title` names the CALLING thread, and a human's own name refuses it out loud", async () => {
  const seen: Array<{ url: string; body: any }> = []
  let reply: unknown = { accepted: true, title: "Audit the Zod 4.5 docs", lockedByHuman: false }
  const http = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      seen.push({ url: req.url ?? "", body: JSON.parse(body || "{}") })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ result: reply }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "ntwine-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  const rpc = startServer({ NTWINE_STATE_DIR: stateDir, NTWINE_THREAD_SLUG: "is-this-true-we-should-probably" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)

    rpc.send({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "title", arguments: { title: "  Audit the Zod 4.5 docs  " } },
    })
    const named = await rpc.next(2)
    assert.equal(named.result.isError, undefined)
    // THE SLUG IS THE ENV'S, not the model's — the tool exposes no thread parameter at all, which is what
    // stops one worker renaming another's thread. And the title is trimmed before it goes on the wire.
    assert.deepEqual(seen.at(-1), {
      url: "/_ntwine/rpc/setOwnThreadTitle",
      body: { slug: "is-this-true-we-should-probably", title: "Audit the Zod 4.5 docs" },
    })
    assert.match(named.result.content[0].text, /now named "Audit the Zod 4\.5 docs"/)

    // A HUMAN HAS NAMED IT: not an error, and the reply says plainly not to try again.
    reply = { accepted: false, title: "Named by hand", lockedByHuman: true }
    rpc.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "title", arguments: { title: "Something else" } } })
    const refused = await rpc.next(3)
    assert.equal(refused.result.isError, undefined, "a human owning the name is a correct answer, not a failure")
    assert.match(refused.result.content[0].text, /Not renamed/)
    assert.match(refused.result.content[0].text, /outranks yours/)
    assert.match(refused.result.content[0].text, /do not run this again/)

    // A DUPLICATE is the server's call, and its words — naming the holder — reach the worker verbatim,
    // so it can pick another subject rather than retry the same name.
    reply = { accepted: false, title: "chop", lockedByHuman: false, refusal: "another open thread is already named \"Focus mode\" (@focus-mode)." }
    rpc.send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "title", arguments: { title: "Focus mode" } } })
    const dupe = await rpc.next(5)
    assert.equal(dupe.result.isError, undefined)
    assert.match(dupe.result.content[0].text, /^Not renamed — another open thread is already named "Focus mode" \(@focus-mode\)/)

    // An empty name is refused in the HANDLER, so a whitespace-only title never reaches the server.
    const before = seen.length
    rpc.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "title", arguments: { title: "   " } } })
    const blank = await rpc.next(4)
    assert.equal(blank.result.isError, true)
    assert.match(blank.result.content[0].text, /`title` is required/)
    assert.equal(seen.length, before, "and nothing was sent to the server")
  } finally {
    rpc.kill()
    http.close()
  }
})

// The READ action. A worker that can only WRITE its goal overwrites the human's own edit
// without ever seeing it, and after a compaction cannot tell an armed thread from an unarmed one. What
// this pins is that `get` reads the row back VERBATIM (a summary of your own instruction is as blind as
// no read at all), that it mutates nothing, and that a `start` names the row it superseded.
test("`goal` reads back what is armed, and a `start` reports what it replaced", async () => {
  const armed = {
    prompt: "the human's own words, edited in the footer",
    stopHook: true,
    heartbeat: true,
    postCompaction: false,
    intervalSeconds: 600,
    armedAt: "2026-08-06T10:00:00.000Z",
    lastRestFiredAt: "2026-08-06T11:00:00.000Z",
  }
  const seen: Array<{ url: string; body: any }> = []
  const http = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      const url = req.url ?? ""
      seen.push({ url, body: JSON.parse(body || "{}") })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({
        result: url.endsWith("/getOwnThreadRecurringPrompt")
          ? { recurringPrompt: armed }
          : { replaced: armed },
      }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "ntwine-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  const rpc = startServer({ NTWINE_STATE_DIR: stateDir, NTWINE_THREAD_SLUG: "owning-thread" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)

    rpc.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "goal", arguments: { action: "get" } } })
    const got = await rpc.next(2)
    assert.equal(got.result.isError, undefined)
    assert.deepEqual(seen.at(-1), { url: "/_ntwine/rpc/getOwnThreadRecurringPrompt", body: { slug: "owning-thread" } })
    const text: string = got.result.content[0].text
    // VERBATIM, or the read is worthless — this is the text a worker would have to retype to restore.
    assert.ok(text.includes(armed.prompt), text)
    assert.match(text, /stop_hook/)
    // The SAME cadence form `start` prints — one formatter, so a worker cannot be told "every 10m"
    // when it arms and "every 600s" when it reads back the very same number.
    assert.match(text, /every 10m/)
    assert.match(text, /last fired 2026-08-06T11:00:00\.000Z/)
    // A trigger that is OFF must not be listed as if it were live.
    assert.doesNotMatch(text, /post_compaction/)

    // An unarmed thread reads back as an explicit "nothing", never as an empty report.
    const empty = createServer((req, res) => {
      req.resume()
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ result: { recurringPrompt: null } }))
      })
    })
    await new Promise<void>((resolve) => empty.listen(0, "127.0.0.1", resolve))
    writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port: (empty.address() as { port: number }).port }))
    rpc.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "goal", arguments: { action: "get" } } })
    const none = await rpc.next(3)
    assert.equal(none.result.isError, undefined)
    assert.match(none.result.content[0].text, /No goal is armed/)
    empty.close()

    // …and a `start` over an existing row hands the superseded words back, so an overwrite the worker
    // did not intend is visible in the same reply rather than silently gone.
    writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
    rpc.send({
      jsonrpc: "2.0", id: 4, method: "tools/call",
      params: { name: "goal", arguments: { action: "start", prompt: "my own new text" } },
    })
    const replaced = await rpc.next(4)
    assert.equal(replaced.result.isError, undefined)
    assert.match(replaced.result.content[0].text, /IT REPLACED an existing goal/)
    assert.ok(replaced.result.content[0].text.includes(armed.prompt), replaced.result.content[0].text)
  } finally {
    rpc.kill()
    http.close()
  }
})

// An ntwine server older than this tool 404s the read procedure. A bare HTTP status would read to a worker
// as "nothing is armed", which is the opposite of the truth — so the refusal has to say UNKNOWN.
test("`goal` get says the state is UNKNOWN against a server that predates the read", async () => {
  const http = createServer((req, res) => {
    req.resume()
    req.on("end", () => {
      res.writeHead(404, { "content-type": "text/plain" })
      res.end("no procedure getOwnThreadRecurringPrompt")
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const stateDir = mkdtempSync(join(tmpdir(), "ntwine-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port: (http.address() as { port: number }).port }))
  const rpc = startServer({ NTWINE_STATE_DIR: stateDir, NTWINE_THREAD_SLUG: "owning-thread" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)
    rpc.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "goal", arguments: { action: "get" } } })
    const stale = await rpc.next(2)
    assert.equal(stale.result.isError, true)
    assert.match(stale.result.content[0].text, /UNKNOWN/)
  } finally {
    rpc.kill()
    http.close()
  }
})

// The ONE-OFF TIMER, over the same real transport. What this pins is the CONVERSION the tool owns: a
// worker names a delay or an instant, and exactly one representation — the exact UTC instant — reaches
// the server, so the row, the delivered trailer and the tool's own reply can never name three times.
test("`timer` resolves in_seconds/at into one exact instant and POSTs the calling thread's slug", async () => {
  const seen: Array<{ url: string; body: any }> = []
  const http = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      seen.push({ url: req.url ?? "", body: JSON.parse(body || "{}") })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ result: { id: "tmr_abc", fireAt: "2026-08-04T15:00:00.000Z", timers: [] } }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "ntwine-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  const rpc = startServer({ NTWINE_STATE_DIR: stateDir, NTWINE_THREAD_SLUG: "owning-thread" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)

    const before = Date.now()
    rpc.send({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "timer", arguments: { action: "set", prompt: "re-check the deploy", in_seconds: 600 } },
    })
    const set = await rpc.next(2)
    assert.equal(set.result.isError, undefined)
    assert.equal(seen.at(-1)!.url, "/_ntwine/rpc/setOwnThreadTimer")
    assert.equal(seen.at(-1)!.body.slug, "owning-thread")
    assert.equal(seen.at(-1)!.body.prompt, "re-check the deploy")
    const fired = Date.parse(seen.at(-1)!.body.fireAt)
    // The window carries a tolerance because the MCP server is a SEPARATE PROCESS, and two processes'
    // `Date.now()` are not mutually ordered. Measured on Windows Server 2022 / node 26.7.0: the server
    // stamped its instant 5ms BEHIND a `before` this process had already captured, so a window with no
    // low-side slack failed every run there. The assertion's point is the magnitude — that `in_seconds`
    // is read as seconds from now, not milliseconds, minutes, or an epoch — and a second of slack on a
    // ten-minute delay still catches every one of those.
    const SKEW_MS = 1_000
    assert.ok(
      fired >= before + 600_000 - SKEW_MS && fired <= Date.now() + 600_000 + SKEW_MS,
      `fireAt ${seen.at(-1)!.body.fireAt} must be ~10 min out`,
    )
    // The reply has to carry the id (there is no other way to cancel) and say that it fires once.
    assert.match(set.result.content[0].text, /tmr_abc/)
    assert.match(set.result.content[0].text, /ONCE/)

    // An absolute instant is normalized to the same UTC form, so a worker cannot arm a row the trailer
    // and the scheduler would print differently.
    const at = new Date(Date.now() + 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z")
    rpc.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "timer", arguments: { action: "set", prompt: "x", at } } })
    await rpc.next(3)
    assert.equal(seen.at(-1)!.body.fireAt, new Date(Date.parse(at)).toISOString())

    rpc.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "timer", arguments: { action: "list" } } })
    await rpc.next(4)
    assert.deepEqual(seen.at(-1), { url: "/_ntwine/rpc/listOwnThreadTimers", body: { slug: "owning-thread" } })

    rpc.send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "timer", arguments: { action: "cancel", id: "tmr_abc" } } })
    await rpc.next(5)
    assert.deepEqual(seen.at(-1), { url: "/_ntwine/rpc/cancelOwnThreadTimer", body: { slug: "owning-thread", id: "tmr_abc" } })

    // …and an invented thread argument never reaches the server, exactly as for `goal`.
    rpc.send({
      jsonrpc: "2.0", id: 6, method: "tools/call",
      params: { name: "timer", arguments: { action: "list", slug: "someone-else", thread: "someone-else" } },
    })
    await rpc.next(6)
    assert.deepEqual(seen.at(-1)!.body, { slug: "owning-thread" })
  } finally {
    rpc.kill()
    http.close()
  }
})

// Every one of these is refused in the HANDLER, before any HTTP call — the same bar the cadence gets,
// and for the same reason: a lenient client must not be able to slip a nonsense alarm past the schema.
test("`timer` refuses a bad delay, a missing/doubled instant and a missing id without contacting the server", async () => {
  const seen: unknown[] = []
  const http = createServer((_req, res) => {
    seen.push(1)
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ result: null }))
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "ntwine-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  const rpc = startServer({ NTWINE_STATE_DIR: stateDir, NTWINE_THREAD_SLUG: "owning-thread" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)

    const refused = async (id: number, args: Record<string, unknown>, pattern: RegExp) => {
      rpc.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "timer", arguments: args } })
      const reply = await rpc.next(id)
      assert.equal(reply.result.isError, true, JSON.stringify(args))
      assert.match(reply.result.content[0].text, pattern)
    }

    await refused(2, { action: "set", prompt: "x", in_seconds: 3 }, /must be between 10 and 2592000/)
    await refused(3, { action: "set", prompt: "x", in_seconds: 99_999_999 }, /must be between 10 and 2592000/)
    await refused(4, { action: "set", prompt: "x" }, /give either `--in-seconds`/)
    await refused(5, { action: "set", prompt: "x", in_seconds: 60, at: "2026-08-04T15:00:00Z" }, /not both/)
    await refused(6, { action: "set", in_seconds: 60 }, /`prompt` is required/)
    await refused(7, { action: "set", prompt: "x", at: "2020-01-01T00:00:00Z" }, /at least 10s in the future/)
    await refused(8, { action: "set", prompt: "x", at: "next tuesday" }, /must be an ISO-8601 instant/)
    await refused(9, { action: "cancel" }, /`id` is required/)
    await refused(10, { action: "snooze" }, /`action` must be one of/)

    assert.equal(seen.length, 0, "none of them reached the server")
  } finally {
    rpc.kill()
    http.close()
  }
})

// A model can choose the TEXT of a goal but never the THREAD. The tool takes no thread parameter,
// so the only way it could act on someone else's is if a supplied argument leaked into the body.
test("`goal` ignores any thread the caller tries to name — the slug comes from the env alone", async () => {
  const seen: Array<{ url: string; body: any }> = []
  const http = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      seen.push({ url: req.url ?? "", body: JSON.parse(body || "{}") })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ result: null }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "ntwine-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  const rpc = startServer({ NTWINE_STATE_DIR: stateDir, NTWINE_THREAD_SLUG: "owning-thread" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)
    rpc.send({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "goal", arguments: { action: "start", prompt: "p", slug: "someone-else", thread: "someone-else" } },
    })
    await rpc.next(2)
    assert.equal(seen.at(-1)!.body.slug, "owning-thread", "an invented slug argument must not reach the server")
  } finally {
    rpc.kill()
    http.close()
  }
})

// Without a slug the tool must FAIL rather than guess — arming one on the wrong thread is worse than
// not arming one, and a silent no-op would read to the worker as success.
test("`goal` refuses to act when its thread identity was never stamped into its env", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ntwine-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port: 1 }))
  // NTWINE_THREAD is the documented fallback, so both vars have to be absent for this to hold.
  const rpc = startServer({ NTWINE_STATE_DIR: stateDir, NTWINE_THREAD_SLUG: "", NTWINE_THREAD: "" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)
    rpc.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "goal", arguments: { action: "stop" } } })
    const failed = await rpc.next(2)
    assert.equal(failed.result.isError, true)
    assert.match(failed.result.content[0].text, /could not tell which thread is calling/)
  } finally {
    rpc.kill()
  }
})

// The CADENCE's own validation contract. The arm/disarm test above covers the trigger combinations;
// this one covers the number, because a schedule out of range is the input a model is most likely to
// invent — and it must be refused in the HANDLER, never merely by the schema, so a lenient client
// cannot slip one past.
test("`goal` refuses a cadence out of range without contacting the server", async () => {
  const seen: Array<{ url: string; body: any }> = []
  const http = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      seen.push({ url: req.url ?? "", body: JSON.parse(body || "{}") })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ result: null }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "ntwine-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  const rpc = startServer({ NTWINE_STATE_DIR: stateDir, NTWINE_THREAD_SLUG: "owning-thread" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)

    rpc.send({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "goal", arguments: { action: "start", prompt: "x", heartbeat_seconds: 5 } },
    })
    const tooFast = await rpc.next(2)
    assert.equal(tooFast.result.isError, true)
    assert.match(tooFast.result.content[0].text, /must be between 60 and 86400/)

    rpc.send({
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "goal", arguments: { action: "start", prompt: "x", heartbeat_seconds: 99999 } },
    })
    const tooSlow = await rpc.next(3)
    assert.equal(tooSlow.result.isError, true)
    assert.match(tooSlow.result.content[0].text, /must be between 60 and 86400/)

    // Explicitly switching BOTH triggers off on a `start` is not an arming at all — it is a request to
    // be re-prompted by nothing. Refused, rather than silently writing a row that can never fire.
    rpc.send({
      jsonrpc: "2.0", id: 4, method: "tools/call",
      params: { name: "goal", arguments: { action: "start", prompt: "x", stop_hook: false } },
    })
    const noTrigger = await rpc.next(4)
    assert.equal(noTrigger.result.isError, true)
    assert.match(noTrigger.result.content[0].text, /at least one is required/)

    assert.equal(seen.length, 0, "none of the three reached the server")
  } finally {
    rpc.kill()
    http.close()
  }
})




// `watch` / `unwatch` OVER THE REAL STDIO TRANSPORT, same standard as `watch_pr` above and for the same
// reason: `tools/list` proves a worker can SEE `mcp__ntwine__watch`, and proves nothing about whether
// calling it reaches the right procedure with the right shape.
test("`watch` and `unwatch` register and withdraw against the CALLING thread", async () => {
  const seen: Array<{ url: string; body: any }> = []
  const armed = { id: "wch_abc123", kind: "shell", target: "bzvtnt3ig", label: "nub --test", createdAt: "2026-08-26T00:00:00.000Z", expiresAt: "2026-08-26T02:00:00.000Z" }
  const replies: any[] = [
    { id: "wch_abc123", kind: "shell", target: "bzvtnt3ig", alreadyArmed: false, watches: [armed] },
    { dropped: true, watches: [] },
  ]
  const http = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      seen.push({ url: req.url ?? "", body: JSON.parse(body) })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ result: replies.shift() ?? null }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "ntwine-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  const rpc = startServer({ NTWINE_STATE_DIR: stateDir, NTWINE_THREAD_SLUG: "watching-thread" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)

    rpc.send({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "watch", arguments: { kind: "shell", target: "bzvtnt3ig", for: "2h" } },
    })
    const added = await rpc.next(2)
    assert.equal(added.result.isError, undefined)
    assert.deepEqual(seen[0], { url: "/_ntwine/rpc/addOwnWatch", body: { slug: "watching-thread", kind: "shell", target: "bzvtnt3ig", for: "2h" } })
    assert.match(added.result.content[0].text, /Watching `bzvtnt3ig` as wch_abc123/)
    // The read-back names the WORK, not just the handle: the label is ntwine's live reading of what is
    // running behind that id, so a worker listing its waits sees what they are.
    assert.match(added.result.content[0].text, /wch_abc123 {2}shell: nub --test \(bzvtnt3ig\)/)
    // And it says what happens at the expiry, because the cancel-and-re-decide is the whole mechanism
    // that stops a registration outliving the reason it was made.
    assert.match(added.result.content[0].text, /WHEN `--for` RUNS OUT the row is CANCELLED/)

    rpc.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "unwatch", arguments: { id: "wch_abc123" } } })
    const dropped = await rpc.next(3)
    assert.deepEqual(seen[1], { url: "/_ntwine/rpc/dropOwnWatch", body: { slug: "watching-thread", id: "wch_abc123" } })
    assert.match(dropped.result.content[0].text, /Watch wch_abc123 dropped/)
    assert.match(dropped.result.content[0].text, /No watches are armed on this thread/)

    // THE REFUSALS, all in the HANDLER rather than only in the schema — a lenient client must not be
    // able to register a wait that names nothing, or one with no expiry, and must not look like it did.
    const before = seen.length
    for (const [id, args, pattern] of [
      [4, { kind: "shell", for: "2h" }, /`target` is required/],
      [5, { kind: "shell", target: "bzvtnt3ig" }, /`for` is required/],
      [6, { kind: "process", target: "bzvtnt3ig", for: "2h" }, /`kind` must be "shell", "agent" or "terminal"/],
    ] as const) {
      rpc.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "watch", arguments: args } })
      const refused = await rpc.next(id)
      assert.equal(refused.result.isError, true)
      assert.match(refused.result.content[0].text, pattern)
    }
    rpc.send({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "unwatch", arguments: {} } })
    const noId = await rpc.next(7)
    assert.equal(noId.result.isError, true)
    assert.match(noId.result.content[0].text, /`id` is required/)
    assert.equal(seen.length, before, "not one of the four reached the server")

    // A PR, issue or timer id handed to `unwatch` reaches the call that really withdraws it, instead of
    // dropOwnWatch reporting it "already settled" while the row stayed armed on the rail. (An `isw_` id is
    // an issue watcher a worker registered before `watch-issue` was removed on 2026-10-14.)
    replies.push({ dropped: true, watches: [] }, { dropped: true, watches: [] }, { cancelled: true, timers: [] })
    for (const [n, id, url] of [
      [8, "prw_aaa111", "/_ntwine/rpc/dropOwnPrWatch"],
      [9, "isw_bbb222", "/_ntwine/rpc/dropOwnPrWatch"],
      [10, "tmr_ccc333", "/_ntwine/rpc/cancelOwnThreadTimer"],
    ] as const) {
      rpc.send({ jsonrpc: "2.0", id: n, method: "tools/call", params: { name: "unwatch", arguments: { id } } })
      const out = await rpc.next(n)
      assert.equal(out.result.isError, undefined)
      assert.deepEqual(seen[seen.length - 1], { url, body: { slug: "watching-thread", id } })
      assert.match(out.result.content[0].text, id.startsWith("tmr_") ? /Timer tmr_ccc333 cancelled/ : new RegExp(`Watcher ${id} dropped`))
    }
  } finally {
    rpc.kill()
    http.close()
  }
})

// `extend_shell` OVER THE REAL STDIO TRANSPORT (2026-09-29): the procedure, the shape, the read-back,
// and the refusals the handler owns before anything reaches the server.
test("`extend_shell` extends the CALLING thread's shell and reports the new end, clamp included", async () => {
  const seen: Array<{ url: string; body: any }> = []
  const replies: any[] = [
    { shell: "bzvtnt3ig", label: "npx vite", budgetEndsAt: "2026-09-29T14:00:00.000Z", clampedFrom: "3d" },
  ]
  const http = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      seen.push({ url: req.url ?? "", body: JSON.parse(body) })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ result: replies.shift() ?? null }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "ntwine-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  const rpc = startServer({ NTWINE_STATE_DIR: stateDir, NTWINE_THREAD_SLUG: "shell-thread" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)
    rpc.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "extend_shell", arguments: { shell: "bzvtnt3ig", for: "3d" } } })
    const extended = await rpc.next(2)
    assert.equal(extended.result.isError, undefined)
    assert.deepEqual(seen[0], { url: "/_ntwine/rpc/extendOwnShell", body: { slug: "shell-thread", shell: "bzvtnt3ig", for: "3d" } })
    assert.match(extended.result.content[0].text, /^`bzvtnt3ig` \(npx vite\): its budget now ends at 2026-09-29T14:00:00.000Z/)
    assert.match(extended.result.content[0].text, /CAPPED at 24h/)

    const before = seen.length
    for (const [id, args, pattern] of [
      [3, { for: "2h" }, /`shell` is required/],
      [4, { shell: "bzvtnt3ig" }, /`for` is required/],
    ] as const) {
      rpc.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "extend_shell", arguments: args } })
      const refused = await rpc.next(id)
      assert.equal(refused.result.isError, true)
      assert.match(refused.result.content[0].text, pattern)
    }
    assert.equal(seen.length, before, "neither refusal reached the server")
  } finally {
    rpc.kill()
    http.close()
  }
})

// `ask` / `unask` OVER THE REAL STDIO TRANSPORT, same standard as `watch` above. What matters most here
// is that the TREE survives the trip: the nested `followUps` a worker writes must arrive at the RPC
// intact, because the whole point of the static tree is that ntwine decides which branch is live from
// the answer rather than the worker asking twice.
test("`ask` and `unask` register and withdraw the CALLING thread's questions, tree intact", async () => {
  const seen: Array<{ url: string; body: any }> = []
  const spec = {
    question: "Land the parser refactor on `main`?",
    kind: "question",
    options: [
      {
        label: "Land it",
        description: "every gate is green",
        recommended: true,
        followUps: [{ question: "Tag a release too?", kind: "question", options: [{ label: "Tag 0.9.0" }, { label: "Not yet" }] }],
      },
      { label: "Hold it" },
    ],
  }
  const replies: any[] = [
    { registered: [{ id: "qst_aaa111", spec, askedAt: "2026-08-27T00:00:00.000Z" }], open: [{ id: "qst_aaa111", spec, askedAt: "2026-08-27T00:00:00.000Z" }] },
    { withdrawn: true, open: [] },
  ]
  const http = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      seen.push({ url: req.url ?? "", body: JSON.parse(body) })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ result: replies.shift() ?? null }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "ntwine-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  const rpc = startServer({ NTWINE_STATE_DIR: stateDir, NTWINE_THREAD_SLUG: "asking-thread" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)

    rpc.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ask", arguments: { questions: [spec] } } })
    const asked = await rpc.next(2)
    assert.equal(asked.result.isError, undefined)
    assert.deepEqual(seen[0], { url: "/_ntwine/rpc/ask", body: { slug: "asking-thread", questions: [spec] } })
    assert.match(asked.result.content[0].text, /Registered 1 question/)
    assert.match(asked.result.content[0].text, /qst_aaa111 {2}Land the parser refactor on `main`\?/)
    // THE STANDING INSTRUCTION, at the moment of temptation: a question queues only once the worker
    // rests (deriveNeedsYou), so one asked and then worked past sits unseen in the Active band while the
    // thread spins (maintainer 2026-09-24: "decide and go with it, or mark as ready and ask").
    assert.match(asked.result.content[0].text, /THEN REST/)
    // …and the rest is never bought by a stub: the card holds only the choice, so the final message must
    // carry the findings (a PR review once ended "The decision on PR #1673 is in the card below.").
    assert.match(asked.result.content[0].text, /never shorten the write-up/)
    assert.doesNotMatch(asked.result.content[0].text, /on the (?:user|human)'s board now/)

    rpc.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "unask", arguments: { id: "qst_aaa111" } } })
    const withdrawn = await rpc.next(3)
    assert.deepEqual(seen[1], { url: "/_ntwine/rpc/unask", body: { slug: "asking-thread", id: "qst_aaa111" } })
    assert.match(withdrawn.result.content[0].text, /Question qst_aaa111 withdrawn/)
    assert.match(withdrawn.result.content[0].text, /Nothing else is open on this thread/)

    // The refusals live in the HANDLER, not only in the schema.
    const before = seen.length
    rpc.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "ask", arguments: { questions: [] } } })
    const empty = await rpc.next(4)
    assert.equal(empty.result.isError, true)
    assert.match(empty.result.content[0].text, /`questions` is required/)
    rpc.send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "unask", arguments: {} } })
    const noId = await rpc.next(5)
    assert.equal(noId.result.isError, true)
    assert.match(noId.result.content[0].text, /`id` is required/)
    assert.equal(seen.length, before, "neither reached the server")
  } finally {
    rpc.kill()
    http.close()
  }
})

test("`secret` registers ONE masked question on the CALLING thread and hands back the quoted pipe path", async () => {
  const seen: Array<{ url: string; body: any }> = []
  const path = "/Users/x/Library/Application Support/ntwine/projects/p/secrets/asking-thread/qst_sec111"
  const spec = { question: "The npm one-time code for the maintainer account.", kind: "question", secret: true, header: "npm OTP" }
  const view = { id: "qst_sec111", spec, askedAt: "2026-10-08T00:00:00.000Z", secretPath: path }
  const replies: any[] = [{ registered: [view], open: [view] }]
  const http = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      seen.push({ url: req.url ?? "", body: JSON.parse(body) })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ result: replies.shift() ?? null }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "ntwine-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  const rpc = startServer({ NTWINE_STATE_DIR: stateDir, NTWINE_THREAD_SLUG: "asking-thread" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)
    rpc.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "secret", arguments: { question: ` ${spec.question} `, header: "npm OTP" } } })
    const asked = await rpc.next(2)
    assert.equal(asked.result.isError, undefined)
    // It rides the `ask` RPC — the card, the wake and the `done` gate are a question's.
    assert.deepEqual(seen[0], { url: "/_ntwine/rpc/ask", body: { slug: "asking-thread", questions: [spec] } })
    const text = asked.result.content[0].text
    assert.match(text, /Registered secret request qst_sec111/)
    // QUOTED: the macOS state dir has a space in it, and an unquoted `$(cat …)` splits there.
    assert.ok(text.includes(`"$(cat '${path}')"`), text)
    assert.match(text, /read ONCE, within 15 minutes/)

    const before = seen.length
    rpc.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "secret", arguments: { question: "  " } } })
    const blank = await rpc.next(3)
    assert.equal(blank.result.isError, true)
    assert.match(blank.result.content[0].text, /`question` is required/)
    assert.equal(seen.length, before, "a blank request never reaches the server")
  } finally {
    rpc.kill()
    http.close()
  }
})

// `done` OVER THE REAL STDIO TRANSPORT. The refusal is the half worth pinning end to end: it is an
// ordinary RESULT rather than an error (a gate doing its job is not a fault), and it has to name every
// blocker by the id the worker resolves it with — otherwise the next move is a guess.
test("`done` marks the CALLING thread finished, and reports a refusal as an actionable result", async () => {
  const seen: Array<{ url: string; body: any }> = []
  const replies: any[] = [
    { done: false, blockingQuestions: [{ id: "qst_aaa111", question: "Ship it?" }], blockingWatches: [{ id: "wch_bbb222", what: "shell: nub --test (bzvtnt3ig)" }] },
    { done: true, blockingQuestions: [], blockingWatches: [] },
  ]
  const http = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      seen.push({ url: req.url ?? "", body: JSON.parse(body) })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ result: replies.shift() ?? null }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "ntwine-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  const rpc = startServer({ NTWINE_STATE_DIR: stateDir, NTWINE_THREAD_SLUG: "finishing-thread" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)

    rpc.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "done", arguments: { body: "- **Fixed** the parser" } } })
    const refused = await rpc.next(2)
    assert.deepEqual(seen[0], { url: "/_ntwine/rpc/markOwnDone", body: { slug: "finishing-thread", body: "- **Fixed** the parser" } })
    // NOT an isError: the call reached the server and the server answered. A thrown fault would read as
    // a broken tool and invite a retry, when what is needed is two other tool calls.
    assert.equal(refused.result.isError, undefined)
    assert.match(refused.result.content[0].text, /NOT marked done/)
    assert.match(refused.result.content[0].text, /qst_aaa111 {2}Ship it\?/)
    assert.match(refused.result.content[0].text, /wch_bbb222 {2}shell: nub --test \(bzvtnt3ig\)/)
    assert.match(refused.result.content[0].text, /There is no force flag/)

    rpc.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "done", arguments: { body: "- **Fixed** the parser" } } })
    const marked = await rpc.next(3)
    assert.match(marked.result.content[0].text, /Marked done/)
    // Marking done is not dismissal — the card sits in the queue until the human archives it.
    assert.match(marked.result.content[0].text, /NOTHING WAS CLOSED, HIDDEN OR ARCHIVED/)

    const before = seen.length
    rpc.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "done", arguments: {} } })
    const noBody = await rpc.next(4)
    assert.equal(noBody.result.isError, true)
    assert.match(noBody.result.content[0].text, /`body` is required/)
    assert.equal(seen.length, before, "it never reached the server")
  } finally {
    rpc.kill()
    http.close()
  }
})

test("`done` passes `quiet` through, and says the run went to Done", async () => {
  const seen: Array<{ url: string; body: any }> = []
  const http = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      seen.push({ url: req.url ?? "", body: JSON.parse(body) })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ result: { done: true, blockingQuestions: [], blockingWatches: [] } }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "ntwine-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  const rpc = startServer({ NTWINE_STATE_DIR: stateDir, NTWINE_THREAD_SLUG: "triage-issues" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)
    rpc.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "done", arguments: { body: "Nothing new — no issues since Oct 5", quiet: true } } })
    const quiet = await rpc.next(2)
    assert.deepEqual(seen[0], { url: "/_ntwine/rpc/markOwnDone", body: { slug: "triage-issues", body: "Nothing new — no issues since Oct 5", quiet: true } })
    assert.match(quiet.result.content[0].text, /Marked done QUIETLY/)
  } finally {
    rpc.kill()
    http.close()
  }
})

test("`schedule` shapes each action for ownSchedule, relays the server's reply verbatim, and refuses locally", async () => {
  const seen: Array<{ url: string; body: any }> = []
  const http = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      seen.push({ url: req.url ?? "", body: JSON.parse(body) })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ result: { text: `ECHO for ${JSON.parse(body).action}` } }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "ntwine-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  const rpc = startServer({ NTWINE_STATE_DIR: stateDir, NTWINE_THREAD_SLUG: "proposing-thread" })
  const call = async (id: number, args: Record<string, unknown>) => {
    rpc.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "schedule", arguments: args } })
    return (await rpc.next(id)).result
  }
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)
    const spec = { title: "Triage issues", prompt: "Triage the new issues.", when: "every Monday at 9am", rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0", dtstart: "2026-10-12T09:00", model: "sonnet", effort: "medium" }
    const created = await call(2, { action: "create", ...spec, slug: "someone-else" })
    assert.equal(created.content[0].text, "ECHO for create")
    assert.deepEqual(seen[0], { url: "/_ntwine/rpc/ownSchedule", body: { action: "create", slug: "proposing-thread", ...spec } }, "the caller comes from the env, never the arguments")
    await call(3, { action: "list" })
    assert.deepEqual(seen[1]!.body, { action: "list", slug: "proposing-thread" })
    await call(4, { action: "skip_next", id: "sch_0123456789ab", reason: "release freeze" })
    assert.deepEqual(seen[2]!.body, { action: "skip_next", slug: "proposing-thread", id: "sch_0123456789ab", reason: "release freeze" })
    await call(5, { action: "move_next", id: "sch_0123456789ab", to: "2026-10-15T10:00" })
    assert.deepEqual(seen[3]!.body, { action: "move_next", slug: "proposing-thread", id: "sch_0123456789ab", to: "2026-10-15T10:00" })
    const before = seen.length
    const noModel = await call(6, { action: "create", ...spec, model: undefined })
    assert.equal(noModel.isError, true)
    assert.match(noModel.content[0].text, /`model` is required/)
    const noId = await call(7, { action: "pause" })
    assert.match(noId.content[0].text, /`id` is required/)
    const noTo = await call(8, { action: "move_next", id: "sch_0123456789ab" })
    assert.match(noTo.content[0].text, /`to` is required/)
    assert.equal(seen.length, before, "local refusals never reach the server")
  } finally {
    rpc.kill()
    http.close()
  }
})

// `watch_pr` OVER THE REAL STDIO TRANSPORT, against a real http server standing in for ntwine's RPC.
//
// This is the test the tool-list assertion above is NOT: `tools/list` proves a worker can SEE
// `mcp__ntwine__watch_pr`, and proves nothing about whether calling it does anything. The handler is a
// separate body of code that has to reach the right procedure with the right shape, and this file has
// caught that exact class of break before — an MCP server that threw at import, so every `mcp__ntwine__*`
// tool was dead while every unit test stayed green (a temporal dead zone, 2026-08-12).
//
// What it pins: the CALLING THREAD's slug reaches the RPC body from the env and never from the model,
// each action hits its own procedure, and the two refusals happen in the HANDLER rather than only in the
// schema — a lenient client must not be able to register a watcher that can never fire.
test("`watch_pr` registers, lists and drops against the CALLING thread", async () => {
  const seen: Array<{ url: string; body: any }> = []
  const replies: any[] = [
    { id: "prw_abc123", target: "acme/app#391", alreadyArmed: false, watches: [{ id: "prw_abc123", target: "acme/app#391", state: "armed", createdAt: "2026-08-14T00:00:00.000Z" }] },
    {
      watches: [{
        id: "prw_abc123", target: "acme/app#391", state: "armed", createdAt: "2026-08-14T00:00:00.000Z",
        github: { checks: "failing", running: 0, passed: 9, failed: 2, failing: ["lint", "e2e"], merge: "blocked", state: "open", polledAt: "2026-08-14T00:05:00.000Z" },
      }],
    },
    { dropped: true, watches: [] },
  ]
  const http = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      seen.push({ url: req.url ?? "", body: JSON.parse(body) })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ result: replies.shift() ?? null }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "ntwine-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  const rpc = startServer({ NTWINE_STATE_DIR: stateDir, NTWINE_THREAD_SLUG: "watching-thread" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)

    rpc.send({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "watch_pr", arguments: { action: "add", target: "acme/app#391", for: "2h" } },
    })
    const added = await rpc.next(2)
    assert.equal(added.result.isError, undefined)
    assert.deepEqual(seen[0], { url: "/_ntwine/rpc/addOwnPrWatch", body: { slug: "watching-thread", target: "acme/app#391", for: "2h" } })
    assert.match(added.result.content[0].text, /Watching acme\/app#391 as prw_abc123/)
    // It must TELL THE WORKER THE OTHER HALF. Registering is the wait; the fence is how it comes to rest
    // and shows the human — a worker that only registers sits in the queue being asked for a handoff.
    // The spelling is the LIVE grammar's `prs:` list (YAML frontmatter, 2026-08-24), not a retired kind.
    assert.match(added.result.content[0].text, /prs: \[acme\/app#391\]/)

    // `list` carries each PR's CHECK STATE, which is the reason a worker lists at all — "where do my PRs
    // stand" answered in one call rather than one `gh` round-trip per PR.
    rpc.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "watch_pr", arguments: { action: "list" } } })
    const listed = await rpc.next(3)
    assert.equal(seen[1].url, "/_ntwine/rpc/listOwnPrWatches")
    assert.deepEqual(seen[1].body, { slug: "watching-thread" })
    assert.match(listed.result.content[0].text, /checks FAILING: lint, e2e/)

    rpc.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "watch_pr", arguments: { action: "drop", id: "prw_abc123" } } })
    const dropped = await rpc.next(4)
    assert.deepEqual(seen[2], { url: "/_ntwine/rpc/dropOwnPrWatch", body: { slug: "watching-thread", id: "prw_abc123" } })
    assert.match(dropped.result.content[0].text, /Watcher prw_abc123 dropped/)
    assert.match(dropped.result.content[0].text, /No pull requests are watched/)

    // THE REFUSALS, both in the handler. Neither reaches the server: a call that cannot name what it
    // wants must not create a row, and must not look like it did.
    const before = seen.length
    rpc.send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "watch_pr", arguments: { action: "add" } } })
    const noTarget = await rpc.next(5)
    assert.equal(noTarget.result.isError, true)
    assert.match(noTarget.result.content[0].text, /`target` is required/)

    rpc.send({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "watch_pr", arguments: { action: "drop" } } })
    const noId = await rpc.next(6)
    assert.equal(noId.result.isError, true)
    assert.match(noId.result.content[0].text, /`id` is required/)

    rpc.send({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "watch_pr", arguments: { action: "watch" } } })
    const badAction = await rpc.next(7)
    assert.equal(badAction.result.isError, true)
    assert.equal(seen.length, before, "not one of the three reached the server")
  } finally {
    rpc.kill()
    http.close()
  }
})

// THE CLAMP HAS TO REACH THE WORKER'S EYES, and the reply text is the only place it can. A `for` above
// the ceiling is capped rather than refused — a fat-fingered `9999d` should still watch the PR — so
// without this the worker reads "Watching …", rests, and believes it holds coverage it does not have.
test("`watch_pr` reads back the expiry it actually got, and says so when the ceiling capped it", async () => {
  const replies: any[] = [
    { id: "prw_long01", target: "acme/app#391", alreadyArmed: false, expiresAt: "2027-03-01T00:00:00.000Z", watches: [] },
    { id: "prw_cap001", target: "acme/app#392", alreadyArmed: false, expiresAt: "2027-09-02T00:00:00.000Z", clampedFrom: "9999d", watches: [] },
  ]
  const http = createServer((req, res) => {
    req.on("data", () => {})
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ result: replies.shift() ?? null }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "ntwine-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  const rpc = startServer({ NTWINE_STATE_DIR: stateDir, NTWINE_THREAD_SLUG: "watching-thread" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)

    rpc.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "watch_pr", arguments: { action: "add", target: "acme/app#391", for: "180d" } } })
    const long = (await rpc.next(2)).result.content[0].text
    assert.match(long, /until 2027-03-01T00:00:00\.000Z/)
    assert.doesNotMatch(long, /WAS CAPPED/, "180d is inside the ceiling — there is no news here")

    rpc.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "watch_pr", arguments: { action: "add", target: "acme/app#392", for: "9999d" } } })
    const capped = (await rpc.next(3)).result.content[0].text
    assert.match(capped, /YOUR `--for 9999d` WAS CAPPED/)
    assert.match(capped, /until 2027-09-02T00:00:00\.000Z/, "…and names what it actually holds instead")
  } finally {
    rpc.kill()
    http.close()
  }
})

// `activity` IS THE ANSWER TO "I HAVE LOST MY IDS", so what it must do is print every kind of running
// work with the exact string an ```awaiting fence names it by — and say so plainly when there is none,
// because a fence naming nothing is not a park and a worker needs to be told that rather than left to
// invent one.
test("`activity` reads all four kinds back with the ids a fence names them by", async () => {
  const seen: Array<{ url: string; body: any }> = []
  const http = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      seen.push({ url: req.url ?? "", body: JSON.parse(body || "{}") })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ result: { activity: [
        { kind: "shell", id: "bzvtnt3ig", label: "Running the suite", since: "2026-08-15T09:00:00.000Z" },
        { kind: "shell", id: "bpoll42", label: "Polling CI", since: "2026-08-15T09:00:00.000Z", budgetEndsAt: "2999-01-01T00:00:00.000Z" },
        { kind: "agent", id: "toolu_agent1", label: "Reviewing the diff", since: "2026-08-15T09:01:00.000Z" },
        { kind: "timer", id: "tmr_a1b2c3", label: "check the deploy", since: "2026-08-15T09:02:00.000Z", until: "2026-08-15T10:00:00.000Z" },
        { kind: "pr", id: "acme/app#391", label: "acme/app#391", since: "2026-08-15T09:03:00.000Z" },
      ] } }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "ntwine-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  const rpc = startServer({ NTWINE_STATE_DIR: stateDir, NTWINE_THREAD_SLUG: "busy-thread" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)
    rpc.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "activity", arguments: {} } })
    const got = await rpc.next(2)
    assert.equal(got.result.isError, undefined)
    const text = got.result.content[0].text
    // The SLUG comes from the server's env, never from the model — same rule as every sibling tool.
    assert.deepEqual(seen, [{ url: "/_ntwine/rpc/listOwnThreadActivity", body: { slug: "busy-thread" } }])
    // Every id, spelled exactly as its fence line must carry it.
    for (const id of ["bzvtnt3ig", "toolu_agent1", "tmr_a1b2c3", "acme/app#391"]) {
      assert.match(text, new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${id} must be readable back`)
    }
    assert.match(text, /5 things running/)
    // A shell with NO budget says so — it is the one that runs until somebody stops it (shell-budget.ts);
    // the budgeted one prints its end instead, and never the no-budget line.
    assert.match(text, /bzvtnt3ig[^\n]*\[no budget: runs until it ends or you stop it\]/)
    assert.match(text, /bpoll42[^\n]*\[budget: [^\]]* left, ends 2999-01-01T00:00:00.000Z\]/)
    assert.doesNotMatch(text, /bpoll42[^\n]*no budget/)
    assert.match(text, /for:/, "…and it says what else the fence needs")
  } finally {
    rpc.kill()
    http.close()
  }
})

// The empty case is the one that has to TEACH: a worker with nothing running cannot write an awaiting
// fence at all, and must be told which terminal state it is actually in rather than parking on nothing.
test("link and unlink use the calling thread; activity reads saved destinations separately from work", async () => {
  const seen: Array<{ url: string; body: any }> = []
  const link = { id: "lnk_abc123", kind: "file", label: "Working plan", target: "/tmp/plan.md" }
  const http = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => { body += c })
    req.on("end", () => {
      seen.push({ url: req.url ?? "", body: JSON.parse(body || "{}") })
      res.writeHead(200, { "content-type": "application/json" })
      const result = req.url?.endsWith("upsertOwnLink") ? { link }
        : req.url?.endsWith("dropOwnLink") ? { dropped: true }
          : { activity: [], links: [link] }
      res.end(JSON.stringify({ result }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const stateDir = mkdtempSync(join(tmpdir(), "ntwine-mcp-links-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port: (http.address() as { port: number }).port }))
  const rpc = startServer({ NTWINE_STATE_DIR: stateDir, NTWINE_THREAD_SLUG: "owning-thread" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "link", arguments: { label: " Working plan ", target: " /tmp/plan.md ", slug: "foreign" } } })
    const added = await rpc.next(1)
    assert.equal(added.result.isError, undefined)
    assert.match(added.result.content[0].text, /lnk_abc123/)
    rpc.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "activity", arguments: {} } })
    const activity = (await rpc.next(2)).result.content[0].text
    assert.match(activity, /Nothing is running/)
    assert.match(activity, /lnk_abc123.*file: Working plan/)
    assert.match(activity, /not running work/)
    rpc.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "unlink", arguments: { id: link.id, slug: "foreign" } } })
    assert.match((await rpc.next(3)).result.content[0].text, /No file was deleted/)
    assert.deepEqual(seen, [
      { url: "/_ntwine/rpc/upsertOwnLink", body: { slug: "owning-thread", label: "Working plan", target: "/tmp/plan.md" } },
      { url: "/_ntwine/rpc/listOwnThreadActivity", body: { slug: "owning-thread" } },
      { url: "/_ntwine/rpc/dropOwnLink", body: { slug: "owning-thread", id: link.id } },
    ])
    for (const [id, name, args] of [[4, "link", { label: "Only a label" }], [5, "unlink", {}]] as const) {
      rpc.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })
      assert.equal((await rpc.next(id)).result.isError, true)
    }
    assert.equal(seen.length, 3, "missing arguments must not contact the server")
  } finally { rpc.kill(); http.close() }
})

test("`activity` with nothing running says so, and names the terminal states that remain", async () => {
  const http = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ result: { activity: [] } }))
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "ntwine-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  const rpc = startServer({ NTWINE_STATE_DIR: stateDir, NTWINE_THREAD_SLUG: "idle-thread" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)
    rpc.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "activity", arguments: {} } })
    const got = await rpc.next(2)
    assert.equal(got.result.isError, undefined)
    assert.match(got.result.content[0].text, /Nothing is running on this thread/)
    assert.match(got.result.content[0].text, /```done/)
    // The free-form question fence was retired (607c4c12); the way to ask is `ask`, and the copy says so.
    assert.match(got.result.content[0].text, /register a question with `ntwinectl ask`/)
  } finally {
    rpc.kill()
    http.close()
  }
})

// A RESTART WINDOW MUST NOT SILENTLY EAT A WORKER'S INTENT.
//
// This process outlives every ntwine restart, so a call landing while no server is up is ordinary rather
// than exceptional. What is NOT ordinary is what used to happen next: the error said "Is ntwine running?"
// — a fact about the world — and the worker read it as diagnosis rather than as "your call did nothing",
// carried on, and rested. Measured 2026-08-17 on a real thread: a `recurring_prompt start` hit exactly
// this window, and the Goal that was keeping a long autonomous effort alive simply never existed.
test("with no server up, a tool call says NOTHING WAS SAVED and to retry — not just 'is ntwine running?'", async () => {
  // A state dir whose lock names a pid that cannot be alive: the shim's own liveness probe rejects it,
  // then falls through every project lock, then gives up — the exact path the real failure took.
  const stateDir = mkdtempSync(join(tmpdir(), "ntwine-mcp-nolock-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ pid: 2147483646, port: 1 }))
  const rpc = startServer({ NTWINE_STATE_DIR: stateDir, NTWINE_THREAD_SLUG: "orphaned-thread" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)
    rpc.send({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "goal", arguments: { action: "start", stop_hook: true, prompt: "KEEP GOING." } },
    })
    const failed = await rpc.next(2)
    assert.equal(failed.result.isError, true)
    const text = failed.result.content[0].text
    assert.match(text, /NOTHING WAS SAVED/, "the worker must learn its OWN call had no effect")
    assert.match(text, /RETRY this exact command/, "…and what to do about it")
    assert.match(text, /do not come to rest assuming it took/, "…and the failure mode to avoid")
  } finally {
    rpc.kill()
  }
})

// A SERVER THAT COMES UP DURING THE CALL IS CAUGHT, not failed into.
//
// This is the fix for the measured stall, and it is stronger than the message above it: the retry
// GUIDANCE only works if the model complies, while this works regardless. ntwine replaces its own server
// routinely and this process outlives every one of those, so a call landing in the gap is ordinary —
// failing it reports ntwine's own housekeeping as the worker's problem.
test("a call landing in a restart window waits for the server instead of failing", async () => {
  const seen: string[] = []
  const http = createServer((req, res) => {
    seen.push(req.url ?? "")
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ result: { timers: [] } }))
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port

  // The lock starts DEAD — a pid that cannot be alive — exactly as it reads mid-restart.
  const stateDir = mkdtempSync(join(tmpdir(), "ntwine-mcp-window-"))
  const lock = join(stateDir, "server.lock")
  writeFileSync(lock, JSON.stringify({ pid: 2147483646, port: 1 }))
  const rpc = startServer({ NTWINE_STATE_DIR: stateDir, NTWINE_THREAD_SLUG: "restarting-thread" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)
    // Fire the call while nothing is up…
    rpc.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "timer", arguments: { action: "list" } } })
    // …then bring the server up mid-flight, the way a restart finishes. 8s in: past the 6s window this
    // started with, which three `ask` calls in a row outlasted during a restart on a loaded machine
    // (arktype, 2026-09-29) — a real boot is not always seconds.
    const started = Date.now()
    await new Promise((r) => setTimeout(r, 8_000))
    writeFileSync(lock, JSON.stringify({ pid: process.pid, port }))
    const call = await rpc.next(2)
    assert.equal(call.result.isError, undefined, "the window must be invisible to the worker")
    assert.deepEqual(seen, ["/_ntwine/rpc/listOwnThreadTimers"], "and the call actually lands, once")
    assert.ok(Date.now() - started >= 8_000, "it really did wait past the old window")
  } finally {
    rpc.kill()
    http.close()
  }
})

// A LIVE LOCK WHOSE PORT REFUSES IS STILL A RESTART WINDOW. The lock names a pid that is alive while
// nothing listens — the old server closing, a dev child being replaced — and the call used to fail at
// once with a bare "fetch failed" (2026-10-02, session fe5967ef: a `done` lost that way, never repeated).
// A refused connection sent nothing, so it is retried inside the same window; `spawn_thread`, which had
// no restart wait at all, rides the same path.
test("a refused connection behind a live lock is waited out, for every tool including spawn_thread", async () => {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve))
  const port = (probe.address() as { port: number }).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  const seen: string[] = []
  const http = createServer((req, res) => {
    seen.push(req.url ?? "")
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ result: { timers: [], slug: "spawned-child" } }))
  })
  const stateDir = mkdtempSync(join(tmpdir(), "ntwine-mcp-refused-"))
  // OUR pid: alive, so the lock check passes and only the connection can fail.
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ pid: process.pid, port }))
  const rpc = startServer({ NTWINE_STATE_DIR: stateDir, NTWINE_THREAD_SLUG: "refused-thread" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)
    rpc.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "timer", arguments: { action: "list" } } })
    rpc.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "spawn_thread", arguments: { prompt: "p", model: "opus", effort: "low" } } })
    const timerCall = rpc.next(2)
    const spawnCall = rpc.next(3)
    await new Promise((r) => setTimeout(r, 3_000))
    await new Promise<void>((resolve) => http.listen(port, "127.0.0.1", resolve))
    assert.equal((await timerCall).result.isError, undefined, "the refused window must be invisible to the worker")
    assert.equal((await spawnCall).result.isError, undefined)
    assert.deepEqual(seen.sort(), ["/_ntwine/rpc/dispatch", "/_ntwine/rpc/listOwnThreadTimers"], "each call lands exactly once")
  } finally {
    rpc.kill()
    http.close()
  }
})

// A CONNECTION DROPPED AFTER THE REQUEST WENT OUT IS NOT RETRIED — the server may have acted on it, and a
// blind retry could register a question or spawn a thread twice — but it is no longer a bare "fetch
// failed": the worker learns the call may have landed and that it must check, not assume.
test("a connection dropped mid-call says the call MAY have landed and to check, and is not retried", async () => {
  let requests = 0
  const raw = createNetServer((socket) => {
    socket.once("data", () => {
      requests++
      socket.destroy()
    })
  })
  await new Promise<void>((resolve) => raw.listen(0, "127.0.0.1", resolve))
  const port = (raw.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "ntwine-mcp-dropped-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ pid: process.pid, port }))
  const rpc = startServer({ NTWINE_STATE_DIR: stateDir, NTWINE_THREAD_SLUG: "dropped-thread" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)
    rpc.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "done", arguments: { body: "Finished." } } })
    const failed = await rpc.next(2)
    assert.equal(failed.result.isError, true)
    const text = failed.result.content[0].text
    assert.match(text, /connection to ntwine dropped before it answered/)
    assert.match(text, /MAY OR MAY NOT have taken effect/)
    assert.match(text, /repeat it if it did not land/)
    assert.doesNotMatch(text, /^`done` failed: \w+ request failed: fetch failed$/, "not the bare transport error")
    assert.equal(requests, 1, "a request the server may have applied is never resent")
  } finally {
    rpc.kill()
    raw.close()
  }
})

// A REFUSAL READS AS THE SENTENCE NTWINE WROTE. Every handler that throws answers HTTP 500 {"error": …}, so
// `extend_shell` read "extendOwnShell returned HTTP 500: {\"error\":\"no background shell…\"}" — an internal
// procedure name, a status that reads as a server crash, and JSON around the one line that mattered.
test("a handler's refusal reaches the worker as its own sentence, not an HTTP 500 envelope", async () => {
  const refusal = "no background shell running on this thread answers to `bad5ozjm1` — call `activity` for the exact ids."
  const http = createServer((req, res) => {
    if ((req.url ?? "").endsWith("/extendOwnShell")) {
      res.writeHead(500, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: refusal }))
    } else {
      res.writeHead(404, { "content-type": "text/plain" })
      res.end("404 Not Found")
    }
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "ntwine-mcp-refusal-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  const rpc = startServer({ NTWINE_STATE_DIR: stateDir, NTWINE_THREAD_SLUG: "refused-thread" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)
    rpc.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "extend_shell", arguments: { shell: "bad5ozjm1", for: "3h" } } })
    const text = (await rpc.next(2)).result.content[0].text
    assert.equal(text, `\`extend_shell\` failed: ${refusal}`)
    // A status that is not a handler's refusal keeps its status line — `goal get` reads "HTTP 404" as "this
    // server predates the procedure", and that branch must still fire.
    rpc.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "goal", arguments: { action: "get" } } })
    assert.match((await rpc.next(3)).result.content[0].text, /predates the read action/)
  } finally {
    rpc.kill()
    http.close()
  }
})

// A REPLY WAIT is read out as the THREAD it waits on, and the ready fence names it under `threads:`.
test("`activity` puts an awaited thread in the ready fence under `threads:`", async () => {
  const http = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ result: {
      activity: [{ kind: "thread", id: "@shell-budgets", label: "a reply from @shell-budgets (wait tmr_aaa111)", since: "2026-10-07T09:00:00.000Z" }],
      questions: [],
    } }))
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "ntwine-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  const rpc = startServer({ NTWINE_STATE_DIR: stateDir, NTWINE_THREAD_SLUG: "asking-thread" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)
    rpc.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "activity", arguments: {} } })
    const text = (await rpc.next(2)).result.content[0].text
    assert.match(text, / {2}thread: @shell-budgets {2}\(since 2026-10-07T09:00:00.000Z\)/)
    const fence = text.slice(text.indexOf("```awaiting"), text.indexOf("```\n\nDrop the lines"))
    assert.match(fence, /threads: \[@shell-budgets\]/)
    assert.match(fence, /status: watching/, "another thread's reply is a wait outside this one")
  } finally {
    rpc.kill()
    http.close()
  }
})

// THE QUESTIONS ARE READ OUT TOO, in their own section (maintainer 2026-08-28: "Is there a way for the
// agent to read out the current set of watchers and questions?"). They must NOT reach the fence block:
// a question waits on a person, and there is no `questions:` key in the awaiting grammar to hold one.
test("`activity` reads the open questions back, with the ids `unask` takes and a fence names them by", async () => {
  const http = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ result: {
      activity: [{ kind: "shell", id: "bzvtnt3ig", label: "Running the suite", since: "2026-08-28T09:00:00.000Z" }],
      questions: [
        { id: "qst_ab12cd34ef56", spec: { question: "Should the settings store use SQLite or a JSON file?", kind: "question" }, askedAt: "2026-08-28T09:05:00.000Z" },
        { id: "qst_0011223344ff", spec: { question: "Which dist-tag should 4.5.0 publish under?", kind: "question" }, askedAt: "2026-08-28T09:05:00.000Z" },
        { id: "qst_99887766aabb", spec: { question: "Rename the package first?", kind: "question" }, askedAt: "2026-08-28T08:00:00.000Z", passedOver: true },
      ],
    } }))
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "ntwine-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  const rpc = startServer({ NTWINE_STATE_DIR: stateDir, NTWINE_THREAD_SLUG: "asking-thread" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)
    rpc.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "activity", arguments: {} } })
    const text = (await rpc.next(2)).result.content[0].text
    // The held questions are owed; the one the human typed past is listed apart, as holding nothing.
    assert.match(text, /2 questions still owed an answer:\n\n {2}question: qst_ab12cd34ef56\n.*\n {2}question: qst_0011223344ff\n/)
    assert.match(text, /1 question the user typed past:\n\n {2}question: qst_99887766aabb\n.*\n\nStill answerable where you asked, and an answer still reaches you, but they hold nothing/)
    assert.match(text, /Should the settings store use SQLite or a JSON file\?/)
    // The ready fence names the shell AND every held question under `questions:` (2026-10-05) — never one
    // typed past, which a fence may not name.
    const fence = text.slice(text.indexOf("```awaiting"), text.indexOf("```\n\nDrop the lines"))
    assert.match(fence, /shells: \[bzvtnt3ig\]/)
    assert.match(fence, /questions: \[qst_ab12cd34ef56, qst_0011223344ff\]/)
    assert.match(fence, /status: needs_input/, "a fence on questions always needs the human")
  } finally {
    rpc.kill()
    http.close()
  }
})

// Nothing RUNNING but a question open is not the terminal state the empty readout describes: telling a
// worker to end with ```done there points it straight at a call ntwine will refuse.
test("`activity` with only a question open does not send the worker to ```done", async () => {
  const http = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ result: { activity: [], questions: [
      { id: "qst_ab12cd34ef56", spec: { question: "Cut 4.5.0 now?", kind: "question" }, askedAt: "2026-08-28T09:05:00.000Z" },
    ] } }))
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "ntwine-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  const rpc = startServer({ NTWINE_STATE_DIR: stateDir, NTWINE_THREAD_SLUG: "asking-thread" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)
    rpc.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "activity", arguments: {} } })
    const text = (await rpc.next(2)).result.content[0].text
    assert.match(text, /Nothing is RUNNING on this thread/)
    assert.match(text, /1 question still owed an answer/)
    assert.match(text, /qst_ab12cd34ef56/)
    assert.doesNotMatch(text, /End with ```done/, "an open question blocks done — do not point at it")
  } finally {
    rpc.kill()
    http.close()
  }
})

