import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer, type Server } from "node:http"
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { fileURLToPath } from "node:url"
// @ts-expect-error — the worker plugin is plain .mjs shipped loose beside the server; it has no types.
import { CLI, TOOLS } from "../../../cc-worker/lib/ntwine-tools.mjs"
import { buildWorkerPrompt } from "./workerPrompt.ts"

// Drives the REAL cc-worker/bin/ntwinectl as a child process — its real argv, stdin, stdout and exit code
// — against a REAL http server standing in for ntwine's RPC surface. Nothing is imported from the command
// line itself: a worker reaches it through a shell, so that is the only honest way to test it.

// The module is run directly where a test only needs an answer; the tests that go through a real shell
// put the plugin's own bin/ on PATH and call `ntwinectl`, which is the launcher a worker actually runs.
const BIN = fileURLToPath(new URL("../../../cc-worker/bin", import.meta.url))
const NTWINECTL = join(BIN, "ntwinectl.mjs")

interface Seen { url: string; body: any }
interface Fake { port: number; seen: Seen[]; close(): void; stateDir: string }

/** What a procedure answers when a test has nothing particular to say about it: the smallest result
 *  its handler accepts as success. A handler that reads a field this leaves out fails the examples test. */
function plausible(procedure: string, body: any): unknown {
  switch (procedure) {
    case "dispatch": return { slug: "spawned-child" }
    case "messageThread": return { sent: true, handle: String(body.handle).replace(/^@/, ""), from: body.slug }
    case "readThread": return { found: true, handle: String(body.handle).replace(/^@/, ""), state: "resting" }
    case "extendOwnShell": return { shell: body.shell, label: "a build", budgetEndsAt: "2026-10-11T20:00:00.000Z" }
    case "editorState": return { windows: [], connected: 0 }
    case "ownSchedule": return { text: `Schedule ${body.action}: Triage issues · every Monday at 9am` }
    case "ownDeadline": return { deadline: body.action === "read" ? null : { at: "2026-10-11T20:00:00.000Z", setAt: "2026-10-11T18:00:00.000Z", setBy: "agent" } }
    case "upsertOwnLink": return { link: { id: "lnk_1", kind: "url", label: body.label, target: body.target } }
    case "dropOwnLink": return { dropped: true }
    case "setOwnThreadTitle": return { accepted: true, title: body.title }
    case "ask": return { registered: body.questions.map((q: any, i: number) => ({ id: `qst_${i}`, spec: q, ...(q.secret ? { secretPath: "/tmp/a dir/secret" } : {}) })) }
    case "unask": return { withdrawn: true }
    case "markOwnDone": return { done: true }
    case "addOwnWatch": return { id: "wch_1", kind: body.kind, target: body.target, expiresAt: "2026-10-11T20:00:00.000Z" }
    case "dropOwnWatch": return { dropped: true }
    case "addOwnPrWatch": return { id: "prw_1", target: body.target }
    case "dropOwnPrWatch": return { dropped: true }
    case "addOwnCommandWatch": return { id: "cmw_1", alreadyArmed: false, passed: false, every: "5m", expiresAt: "2026-10-11T20:00:00.000Z", firstRun: { at: "2026-10-11T14:00:00.000Z", outcome: "exit", exitCode: 1, output: "" }, watches: [] }
    case "dropOwnCommandWatch": return { dropped: true, watches: [] }
    case "listOwnCommandWatches": return { watches: [] }
    case "setOwnThreadTimer": return { id: "tmr_1", fireAt: "2026-10-11T20:00:00.000Z", prompt: body.prompt, timers: [] }
    case "cancelOwnThreadTimer": return { cancelled: true, timers: [] }
    case "setOwnThreadRecurringPrompt": return { recurringPrompt: body.action === "stop" ? null : { prompt: body.prompt, stopHook: !!body.stopHook, postCompaction: !!body.postCompaction } }
    default: return {}
  }
}

async function fakeNtwine(answer: (procedure: string, body: any) => { status?: number; result?: unknown } | undefined = () => undefined): Promise<Fake> {
  const seen: Seen[] = []
  const http: Server = createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : undefined
      const url = req.url ?? ""
      seen.push({ url, body })
      const procedure = url.split("/rpc/")[1] ?? ""
      const custom = answer(procedure, body)
      res.writeHead(custom?.status ?? 200, { "content-type": "application/json" })
      res.end(JSON.stringify({ result: custom?.result ?? plausible(procedure, body) }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  // A state dir shaped like the real one — `<root>/projects/<project id>` — because the command line
  // reads its project id off that path.
  const stateDir = join(mkdtempSync(join(tmpdir(), "ntwinectl-root-")), "projects", "proj-1")
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  return { port, seen, stateDir, close: () => http.close() }
}

interface Ran { code: number | null; stdout: string; stderr: string }

/** The test runner's environment with every ntwine identity removed. Left in, a leaked server lock or
 *  project id sends the test's calls to the live server instead of the fake one. */
function hostEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^NTWINE_/.test(key)))
}

/** One invocation. `env` REPLACES the ntwine identity a test runner inside a worker would leak in. */
function run(argv: string[], opts: { env?: Record<string, string>; stdin?: string; cwd?: string; holdStdinOpen?: boolean } = {}): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [NTWINECTL, ...argv], {
      cwd: opts.cwd ?? mkdtempSync(join(tmpdir(), "ntwinectl-cwd-")),
      env: { ...hostEnv(), ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (c) => (stdout += c))
    child.stderr.on("data", (c) => (stderr += c))
    child.on("error", reject)
    child.on("close", (code) => resolve({ code, stdout, stderr }))
    if (opts.stdin !== undefined) child.stdin.end(opts.stdin)
    else if (!opts.holdStdinOpen) child.stdin.end()
  })
}

const worker = (fake: Fake, slug = "the-caller") => ({ NTWINE_STATE_DIR: fake.stateDir, NTWINE_THREAD: slug })

test("every registry command has a command-line spelling, and the spelling names real arguments", () => {
  for (const tool of TOOLS as Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }>) {
    const spec = CLI[tool.name]
    assert.ok(spec, `${tool.name} has no CLI entry — \`ntwinectl --help\` would not list it`)
    assert.ok(spec.summary && !spec.summary.includes("\n"), `${tool.name} needs a one-line summary`)
    assert.ok(["Sign off", "Waiting", "This thread", "Other threads"].includes(spec.group), `${tool.name} is in no listed group`)
    const props = Object.keys(tool.inputSchema.properties ?? {})
    for (const key of [...(spec.positional ?? []), ...Object.values(spec.then ?? {}).flat(), ...(spec.wrap ? [spec.wrap] : [])] as string[]) {
      assert.ok(props.includes(key), `${tool.name} spells an argument \`${key}\` its schema does not have`)
    }
    assert.ok(spec.examples?.length, `${tool.name} has no example`)
  }
  assert.deepEqual(Object.keys(CLI).sort(), (TOOLS as Array<{ name: string }>).map((t) => t.name).sort())
})

test("`ntwinectl --help` is the short index; a command's own `--help` is the full reference", async () => {
  const top = await run(["--help"])
  assert.equal(top.code, 0)
  for (const tool of TOOLS as Array<{ name: string; description: string }>) {
    assert.match(top.stdout, new RegExp(`^  ${tool.name.replace(/_/g, "-")}\\s+${CLI[tool.name].summary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"))
    // The index must stay an index: no command's long description leaks into it.
    assert.ok(!top.stdout.includes(tool.description.slice(0, 60)), `${tool.name}'s description is in the top-level help`)
  }
  assert.ok(top.stdout.split("\n").length < 60, "the top-level help is meant to be read whole")
  assert.equal((await run([])).stdout, top.stdout, "no arguments at all prints the same index")

  const one = await run(["watch-pr", "--help"])
  assert.equal(one.code, 0)
  assert.match(one.stdout, /^ntwinectl watch-pr — /)
  assert.match(one.stdout, /REGISTER A PULL REQUEST/)
  assert.match(one.stdout, /--for {2}<string>/)
  assert.match(one.stdout, /ntwinectl watch-pr add acme\/app#391 --for 180d/)
  assert.equal((await run(["help", "watch_pr"])).stdout, one.stdout, "`help <command>` and the underscore spelling are the same page")

  // `ask` nests itself three deep; the reference describes a question once.
  const ask = await run(["ask", "--help"])
  assert.equal(ask.stdout.match(/THE QUESTION, on one line/g)?.length, 1)
  assert.match(ask.stdout, /same shape as --questions, above/)

  const schema = await run(["timer", "--schema"])
  assert.deepEqual(JSON.parse(schema.stdout), (TOOLS as Array<{ name: string; inputSchema: unknown }>).find((t) => t.name === "timer")!.inputSchema)
})

test("a misspelled command or flag fails with the fix in the message, and reaches no server", async () => {
  const fake = await fakeNtwine()
  try {
    const cmd = await run(["wach", "shell", "x"], { env: worker(fake) })
    assert.equal(cmd.code, 1)
    assert.match(cmd.stderr, /has no command "wach"\. Did you mean: watch/)

    const flag = await run(["timer", "set", "--in-secs", "5"], { env: worker(fake) })
    assert.equal(flag.code, 1)
    assert.match(flag.stderr, /`ntwinectl timer` has no --in-secs\. It takes: --action, --prompt, --in-seconds, --at, --id\./)
    assert.match(flag.stderr, /ntwinectl timer --help/)

    const extra = await run(["title", "Fix", "queue", "focus"], { env: worker(fake) })
    assert.equal(extra.code, 1)
    assert.match(extra.stderr, /got an extra "queue"\. Quote a value that has spaces\./)

    const typed = await run(["timer", "set", "--in-seconds", "soon"], { env: worker(fake) })
    assert.match(typed.stderr, /--in-seconds takes a whole number, not "soon"/)

    // A JSON key the command does not take is refused, not dropped: `heartbeat` for
    // `heartbeat_seconds` would otherwise arm a goal with no clock and say nothing.
    const key = await run(["goal", '{"action":"start","prompt":"p","heartbeat":600}'], { env: worker(fake) })
    assert.equal(key.code, 1)
    assert.match(key.stderr, /does not take: heartbeat\. It takes: action, prompt, stop_hook, heartbeat_seconds, post_compaction, max_runs, for\./)
    assert.deepEqual(fake.seen, [])
  } finally {
    fake.close()
  }
})

test("flags, bare arguments, inline JSON, `--input <file>` and `--input -` all say the same thing", async () => {
  const fake = await fakeNtwine()
  try {
    const cwd = mkdtempSync(join(tmpdir(), "ntwinectl-cwd-"))
    writeFileSync(join(cwd, "timer.json"), JSON.stringify({ action: "set", prompt: "re-check the deploy", in_seconds: 600 }))
    const ways: Array<{ argv: string[]; stdin?: string }> = [
      { argv: ["timer", "set", "--prompt", "re-check the deploy", "--in-seconds", "600"] },
      { argv: ["timer", "--action=set", "--prompt=re-check the deploy", "--in_seconds=600"] },
      { argv: ["timer", '{"action":"set","prompt":"re-check the deploy","in_seconds":600}'] },
      { argv: ["timer", "--input", "timer.json"] },
      { argv: ["timer", "--input", "-"], stdin: '{"action":"set","prompt":"re-check the deploy","in_seconds":600}' },
      // A flag wins over the JSON it rides beside.
      { argv: ["timer", "--input", "-", "--in-seconds", "600"], stdin: '{"action":"set","prompt":"re-check the deploy","in_seconds":5}' },
    ]
    for (const way of ways) {
      fake.seen.length = 0
      const ran = await run(way.argv, { env: worker(fake), cwd, stdin: way.stdin })
      assert.equal(ran.code, 0, `${way.argv.join(" ")}: ${ran.stderr}`)
      assert.equal(fake.seen.length, 1, way.argv.join(" "))
      assert.equal(fake.seen[0].url, "/_ntwine/proj-1/rpc/setOwnThreadTimer")
      assert.equal(fake.seen[0].body.slug, "the-caller")
      assert.equal(fake.seen[0].body.prompt, "re-check the deploy")
    }

    // A switch: alone, negated, and spelled out.
    for (const [argv, stopHook] of [
      [["goal", "start", "--prompt", "p", "--post-compaction", "--no-stop-hook"], false],
      [["goal", "start", "--prompt", "p", "--post-compaction", "--stop-hook=false"], false],
      [["goal", "start", "--prompt", "p", "--stop-hook"], true],
    ] as Array<[string[], boolean]>) {
      fake.seen.length = 0
      const ran = await run(argv, { env: worker(fake) })
      assert.equal(ran.code, 0, ran.stderr)
      assert.equal(fake.seen[0].body.stopHook, stopHook, argv.join(" "))
    }

    // An action given as a flag leaves the next bare argument for what that action takes.
    fake.seen.length = 0
    assert.equal((await run(["watch-pr", "--action", "drop", "prw_9"], { env: worker(fake) })).code, 0)
    assert.equal((await run(["watch-pr", "drop", "prw_9"], { env: worker(fake) })).code, 0)
    assert.deepEqual(fake.seen.map((s) => [s.url, s.body.id]), [["/_ntwine/proj-1/rpc/dropOwnPrWatch", "prw_9"], ["/_ntwine/proj-1/rpc/dropOwnPrWatch", "prw_9"]])
  } finally {
    fake.close()
  }
})

test("`ask` takes its questions as the object, as a bare list, or as one question", async () => {
  const fake = await fakeNtwine()
  try {
    const question = { question: "SQLite or a JSON file?", kind: "question", options: [{ label: "SQLite", recommended: true, followUps: [{ question: "WAL?", kind: "question" }] }, { label: "JSON file" }] }
    for (const payload of [{ questions: [question] }, [question], question]) {
      fake.seen.length = 0
      const ran = await run(["ask", "--input", "-"], { env: worker(fake), stdin: JSON.stringify(payload) })
      assert.equal(ran.code, 0, ran.stderr)
      assert.deepEqual(fake.seen, [{ url: "/_ntwine/proj-1/rpc/ask", body: { slug: "the-caller", questions: [question] } }])
      assert.match(ran.stdout, /Registered 1 question\./)
      assert.match(ran.stdout, /qst_0 {2}SQLite or a JSON file\?/)
    }
  } finally {
    fake.close()
  }
})

// THE REASON TEXT GOES THROUGH A FILE OR A QUOTED HEREDOC. A handoff is full of backticked commands and
// paths; this is the path the contract teaches for them, driven through a real shell.
test("a body through a quoted heredoc reaches ntwine byte for byte — backticks, `$( )` and quotes unrun", async () => {
  const fake = await fakeNtwine()
  try {
    const marker = join(mkdtempSync(join(tmpdir(), "ntwinectl-marker-")), "ran")
    const body = `- **Fixed the lookup** in \`src/resolver.ts\`; \`touch ${marker}\` and $(touch ${marker}) stayed text.\n- It's "done", $HOME and all.`
    const script = `ntwinectl done --body-file - <<'EOF'\n${body}\nEOF`
    const ran = await new Promise<Ran>((resolve) => {
      const child = spawn("sh", ["-c", script], {
        env: { ...hostEnv(), ...worker(fake), NTWINE_NODE: process.execPath, PATH: `${BIN}${delimiter}${process.env.PATH}` },
        stdio: ["ignore", "pipe", "pipe"],
      })
      let stdout = ""
      let stderr = ""
      child.stdout.on("data", (c) => (stdout += c))
      child.stderr.on("data", (c) => (stderr += c))
      child.on("close", (code) => resolve({ code, stdout, stderr }))
    })
    assert.equal(ran.code, 0, ran.stderr)
    assert.deepEqual(fake.seen, [{ url: "/_ntwine/proj-1/rpc/markOwnDone", body: { slug: "the-caller", body } }])
    assert.match(ran.stdout, /^Marked done\./)
    assert.equal(existsSync(marker), false, "the shell ran a command out of the body")
  } finally {
    fake.close()
  }
})

test("the caller is the environment's thread and nothing a command line can say", async () => {
  const fake = await fakeNtwine()
  try {
    // NTWINE_THREAD is what every worker shell has; the explicit stamp wins when a front-end set one.
    await run(["title", "Fix queue focus"], { env: { NTWINE_STATE_DIR: fake.stateDir, NTWINE_THREAD: "from-thread" } })
    await run(["title", "Fix queue focus"], { env: { NTWINE_STATE_DIR: fake.stateDir, NTWINE_THREAD: "from-thread", NTWINE_THREAD_SLUG: "from-stamp" } })
    assert.deepEqual(fake.seen.map((s) => s.body.slug), ["from-thread", "from-stamp"])

    // There is no argument for it, in either spelling.
    fake.seen.length = 0
    const flag = await run(["title", "x", "--slug", "someone-else"], { env: worker(fake) })
    assert.equal(flag.code, 1)
    assert.match(flag.stderr, /has no --slug/)
    const key = await run(["title", '{"title":"x","slug":"someone-else"}'], { env: worker(fake) })
    assert.equal(key.code, 1)
    assert.match(key.stderr, /does not take: slug/)

    // Outside a worker there is no thread, and the message says so rather than naming a command.
    const outside = await run(["activity"], { env: { NTWINE_STATE_DIR: fake.stateDir } })
    assert.equal(outside.code, 1)
    assert.match(outside.stderr, /could not tell which thread is calling/)
    assert.deepEqual(fake.seen, [])
  } finally {
    fake.close()
  }
})

// A worker forked by an ntwine that predates the command line was never handed NTWINE_STATE_DIR. Its shell
// has had NTWINE_PERM_DIR all along, and that is enough to find the server and name the project.
test("a shell that only has NTWINE_PERM_DIR still finds the server and its own project", async () => {
  const fake = await fakeNtwine()
  try {
    const ran = await run(["activity"], { env: { NTWINE_PERM_DIR: join(fake.stateDir, "perm-requests"), NTWINE_THREAD: "old-worker" } })
    assert.equal(ran.code, 0, ran.stderr)
    assert.deepEqual(fake.seen, [{ url: "/_ntwine/proj-1/rpc/listOwnThreadActivity", body: { slug: "old-worker" } }])

    const nowhere = await run(["activity"], { env: { NTWINE_THREAD: "lost" } })
    assert.equal(nowhere.code, 1)
    assert.match(nowhere.stderr, /cannot locate the ntwine server/)
    assert.match(nowhere.stderr, /NOTHING WAS SAVED/)
  } finally {
    fake.close()
  }
})

test("exit 0 is done, 1 is a failure, and 2 is a gate that held", async () => {
  const fake = await fakeNtwine((procedure) => {
    if (procedure === "markOwnDone") return { result: { done: false, blockingQuestions: [{ id: "qst_open", question: "SQLite or JSON?" }], blockingWatches: [] } }
    if (procedure === "setOwnThreadTitle") return { status: 500 }
    return undefined
  })
  try {
    const refused = await run(["done", "--body", "all finished"], { env: worker(fake) })
    assert.equal(refused.code, 2)
    assert.match(refused.stdout, /^NOT marked done\./)
    assert.match(refused.stdout, /qst_open {2}SQLite or JSON\?/)
    assert.equal(refused.stderr, "")

    const failed = await run(["title", "Fix queue focus"], { env: worker(fake) })
    assert.equal(failed.code, 1)
    assert.equal(failed.stdout, "")
    assert.match(failed.stderr, /^ntwinectl title failed: setOwnThreadTitle returned HTTP 500/)

    const ok = await run(["unask", "qst_open"], { env: worker(fake) })
    assert.equal(ok.code, 0)
    assert.match(ok.stdout, /^Question qst_open withdrawn\./)
  } finally {
    fake.close()
  }
})

// `terminal` (2026-10-15): a relative `--cwd` is resolved where the worker stands (the server only takes an
// absolute one), `send` carries stdin byte for byte, a refusal — a human's terminal — exits 2, and `watch
// terminal` / `unwatch trw_…` reach the terminal watch rather than the shell registry.
test("`terminal` resolves --cwd where the worker stands; a terminal is read, typed into and waited on with the thread verbs, a refusal exits 2", async () => {
  const fake = await fakeNtwine((procedure, body) => {
    if (procedure === "ownTerminal" && body.action === "release") return { result: { handle: "nub-run-dev", id: "term-1", command: "nub run dev", cwd: "/w/app", outcome: "running", controller: "human", driving: false } }
    if (procedure === "ownTerminal") return { result: { handle: "nub-run-dev", id: "term-1", command: "nub run dev", cwd: "/w/app", outcome: "running", controller: "the-caller", driving: true, startedBy: "the-caller", screen: "ready on :5173" } }
    if (procedure === "messageThread" && body.handle === "@shell") {
      return { result: { sent: false, handle: "shell", refusal: "@shell is driven by the user, so you cannot type into it." } }
    }
    if (procedure === "messageThread") return { result: { sent: true, handle: "nub-run-dev", from: "the-caller", delivery: "terminal" } }
    if (procedure === "readThread") {
      return { result: { found: true, handle: "nub-run-dev", slug: "term-1", state: "running", terminal: { command: "nub run dev", cwd: "/w/app", outcome: "running", startedBy: "human", controller: "human", screen: "ready on :5173" } } }
    }
    if (procedure === "addOwnTerminalWatch") return { result: { id: "trw_abc", handle: "nub-run-dev", alreadyArmed: false, expiresAt: "2026-10-15T20:00:00.000Z" } }
    if (procedure === "dropOwnTerminalWatch") return { result: { dropped: true } }
    return undefined
  })
  try {
    const cwd = mkdtempSync(join(tmpdir(), "ntwinectl-term-"))
    mkdirSync(join(cwd, "app"))
    const started = await run(["terminal", "start", "nub run dev", "--cwd", "app"], { env: worker(fake), cwd })
    assert.equal(started.code, 0, started.stderr)
    assert.deepEqual(fake.seen.at(-1)?.body, { slug: "the-caller", action: "start", command: "nub run dev", cwd: join(cwd, "app") })
    assert.match(started.stdout, /^Started @nub-run-dev — `nub run dev` in \/w\/app, running\./)
    await run(["terminal", "start", "nub run dev"], { env: worker(fake), cwd })
    assert.deepEqual(fake.seen.at(-1)?.body, { slug: "the-caller", action: "start", command: "nub run dev" }, "no --cwd: the server picks the thread's folder")
    assert.equal((await run(["terminal", "send", "@nub-run-dev", "--text", "y"], { env: worker(fake) })).code, 1, "typing is message-thread's")

    const typed = await run(["message-thread", "@nub-run-dev", "--message-file", "-"], { env: worker(fake), stdin: "y\n" })
    assert.equal(typed.code, 0, typed.stderr)
    assert.match(typed.stdout, /^Typed into the terminal @nub-run-dev and pressed Enter\./)
    // A real worker's first try (2026-10-15) passed the text bare; it lands as the message.
    assert.equal((await run(["message-thread", "@nub-run-dev", "y"], { env: worker(fake) })).code, 0)
    assert.equal(fake.seen.at(-1)?.body?.message, "y")
    const refused = await run(["message-thread", "@shell", "--message", "rm -rf ~"], { env: worker(fake) })
    assert.equal(refused.code, 2)
    assert.match(refused.stdout, /^Not sent — @shell is driven by the user/)

    const read = await run(["read-thread", "@nub-run-dev"], { env: worker(fake) })
    assert.match(read.stdout, /^@nub-run-dev — a terminal running `nub run dev` in \/w\/app, running; started by the user, the user drives it\.\n\n```\nready on :5173\n```/)

    const released = await run(["terminal", "release", "@nub-run-dev"], { env: worker(fake) })
    assert.deepEqual(fake.seen.at(-1)?.body, { slug: "the-caller", action: "release", handle: "@nub-run-dev" })
    assert.match(released.stdout, /^Released @nub-run-dev: the user drives it now/)

    const watched = await run(["watch", "terminal", "@nub-run-dev", "--for", "2h"], { env: worker(fake) })
    assert.equal(watched.code, 0, watched.stderr)
    assert.ok(fake.seen.at(-1)?.url.endsWith("/rpc/addOwnTerminalWatch"), fake.seen.at(-1)?.url)
    assert.deepEqual(fake.seen.at(-1)?.body, { slug: "the-caller", handle: "@nub-run-dev", for: "2h" })
    assert.match(watched.stdout, /`threads: \[@nub-run-dev\]`/)

    const dropped = await run(["unwatch", "trw_abc"], { env: worker(fake) })
    assert.ok(fake.seen.at(-1)?.url.endsWith("/rpc/dropOwnTerminalWatch"), fake.seen.at(-1)?.url)
    assert.match(dropped.stdout, /^Terminal watch trw_abc dropped\./)
  } finally {
    fake.close()
  }
})

// `watch-command` (2026-10-11): the server runs the check, so what the command line owes is the right
// body, the refusal as exit 2 (it is the permission gate holding, with the background-shell fallback in
// it), a first check that already passed read as "nothing armed", and `unwatch` reaching the right RPC.
test("`watch-command` registers for the calling thread, reads a refusal as exit 2, and `unwatch` drops a cmw_ id", async () => {
  let mode: "armed" | "refused" | "passed" = "armed"
  const fake = await fakeNtwine((procedure, body) => {
    if (procedure !== "addOwnCommandWatch") return undefined
    if (mode === "refused") {
      return { result: { refused: "ntwine will not run a command watch for this thread: this thread runs in `default` permission mode. Run the check in a background shell instead.", alreadyArmed: false, passed: false, watches: [] } }
    }
    if (mode === "passed") {
      return { result: { alreadyArmed: false, passed: true, firstRun: { at: "2026-10-11T14:00:00.000Z", outcome: "exit", exitCode: 0, output: "0.13.12\n" }, watches: [] } }
    }
    return { result: {
      id: "cmw_abc", alreadyArmed: false, passed: false, every: "5m", expiresAt: "2026-10-11T20:00:00.000Z",
      firstRun: { at: "2026-10-11T14:00:00.000Z", outcome: "exit", exitCode: 1, output: "npm error 404 No match found for version 0.13.12" },
      watches: [{ id: "cmw_abc", command: body.command, every: "5m", state: "armed", createdAt: "2026-10-11T14:00:00.000Z", expiresAt: "2026-10-11T20:00:00.000Z", runs: 1, lastRun: { at: "2026-10-11T14:00:00.000Z", outcome: "exit", exitCode: 1, output: "" } }],
    } }
  })
  try {
    const armed = await run(["watch-command", "add", "npm view ntwine@0.13.12 version", "--every", "5m", "--for", "6h"], { env: worker(fake) })
    assert.equal(armed.code, 0, armed.stderr)
    assert.deepEqual(fake.seen.at(-1)?.body, { slug: "the-caller", command: "npm view ntwine@0.13.12 version", every: "5m", for: "6h" })
    assert.match(armed.stdout, /^Watching as cmw_abc: ntwine runs it every 5m until it exits 0/)
    assert.match(armed.stdout, /Its first check exited 1\./)
    assert.match(armed.stdout, /NAME IT IN YOUR ```awaiting FENCE \(`commands: \[cmw_abc\]`\)/)
    assert.match(armed.stdout, /cmw_abc {2}every 5m, until 2026-10-11T20:00:00.000Z — 1 check, last check exited 1\n {4}\$ npm view ntwine@0\.13\.12 version/)

    mode = "refused"
    const refused = await run(["watch-command", "add", "true", "--every", "5m", "--for", "1h"], { env: worker(fake) })
    assert.equal(refused.code, 2)
    assert.match(refused.stdout, /^NOT registered\. ntwine will not run a command watch for this thread/)
    assert.match(refused.stdout, /background shell instead/)

    mode = "passed"
    const passed = await run(["watch-command", "add", "true", "--every", "5m", "--for", "1h"], { env: worker(fake) })
    assert.equal(passed.code, 0)
    assert.match(passed.stdout, /^NOTHING WAS ARMED: your command exited 0 on its first check/)
    assert.match(passed.stdout, /0\.13\.12/)

    const missing = await run(["watch-command", "add", "true", "--for", "1h"], { env: worker(fake) })
    assert.equal(missing.code, 1)
    assert.match(missing.stderr, /`every` is required/)

    fake.seen.length = 0
    const dropped = await run(["unwatch", "cmw_abc"], { env: worker(fake) })
    assert.equal(dropped.code, 0)
    assert.ok(fake.seen[0]?.url.endsWith("/rpc/dropOwnCommandWatch"), fake.seen[0]?.url)
    assert.match(dropped.stdout, /^Command watch cmw_abc dropped\./)
  } finally {
    fake.close()
  }
})

// Three ways a command line can mean something other than it says, each of which used to run anyway: a
// help flag that is really a flag's VALUE, a flag that is really the missing value of the flag before
// it, and a JSON value of the wrong type that the handler then reads as absent.
test("a value is never read as a flag, a flag never as a value, and a JSON value has the schema's type", async () => {
  const fake = await fakeNtwine()
  try {
    const messaged = await run(["message-thread", "other-thread", "--message", "-h"], { env: worker(fake) })
    assert.equal(messaged.code, 0, messaged.stderr)
    assert.deepEqual(fake.seen.map((s) => s.body), [{ slug: "the-caller", handle: "other-thread", message: "-h" }])
    // …while `-h` standing as a flag of its own is still help, and reads no stdin to get there.
    const help = await run(["message-thread", "--input", "-", "-h"], { env: worker(fake), holdStdinOpen: true })
    assert.equal(help.code, 0)
    assert.match(help.stdout, /^ntwinectl message-thread — /)

    fake.seen.length = 0
    const missing = await run(["goal", "start", "--prompt", "--post-compaction"], { env: worker(fake) })
    assert.equal(missing.code, 1)
    assert.match(missing.stderr, /--prompt needs a value, and the next argument is the flag --post-compaction/)
    // A value that really starts with `--` says so with `=`.
    const dashed = await run(["goal", "start", "--prompt=--resume the audit", "--post-compaction"], { env: worker(fake) })
    assert.equal(dashed.code, 0, dashed.stderr)

    const mistyped = await run(["goal", '{"action":"start","prompt":"x","stop_hook":"false"}'], { env: worker(fake) })
    assert.equal(mistyped.code, 1)
    assert.match(mistyped.stderr, /stop_hook must be a boolean, not "false"/)
    assert.deepEqual(fake.seen.map((s) => s.body?.prompt), ["--resume the audit"])
  } finally {
    fake.close()
  }
})

// A codex thread a human narrowed to `workspace-write` or `read-only` cannot open a socket, loopback
// included, and codex says so in the shell's environment. "fetch failed" there reads as ntwine being
// down, which a worker answers by retrying; the message has to say that no retry can work.
test("a shell sandboxed off the network is told so, and told not to retry", async () => {
  const fake = await fakeNtwine()
  fake.close()
  await new Promise((resolve) => setTimeout(resolve, 50))

  const sandboxed = await run(["title", "Fix queue focus"], { env: { ...worker(fake), CODEX_SANDBOX_NETWORK_DISABLED: "1" } })
  assert.equal(sandboxed.code, 1)
  assert.equal(sandboxed.stdout, "")
  assert.match(sandboxed.stderr, /sandboxed with network access off/)
  assert.match(sandboxed.stderr, /NOTHING WAS SAVED/)
  assert.match(sandboxed.stderr, /do not retry/)

  // The same dead port from an ordinary shell is an ordinary failure, which IS worth a retry — after
  // the command has ridden out a restart window of its own (shortened here).
  const down = await run(["title", "Fix queue focus"], { env: { ...worker(fake), CODEX_SANDBOX_NETWORK_DISABLED: "", NTWINE_LOCK_RETRY_MS: "800" } })
  assert.equal(down.code, 1)
  assert.match(down.stderr, /setOwnThreadTitle could not reach ntwine: its server refused the connection/)
  assert.match(down.stderr, /RETRY this exact command/)
  assert.doesNotMatch(down.stderr, /sandboxed/)
})

// An agent's shell hands a command an OPEN PIPE for stdin more often than a terminal. A command that
// reads it uninvited never returns, and that reads as the command being broken.
test("stdin is never read unless `-` asks for it", async () => {
  const fake = await fakeNtwine()
  try {
    const ran = await Promise.race([
      run(["activity"], { env: worker(fake), holdStdinOpen: true }),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 10_000)),
    ])
    assert.notEqual(ran, "hung", "`ntwinectl activity` waited on a stdin nobody asked it to read")
    assert.equal((ran as Ran).code, 0)
  } finally {
    fake.close()
  }
})

// The examples are what a worker copies. Every one of them is run, through a real shell, against the
// fake — so an example that names a flag the command lost, or a heredoc that no longer parses, fails here.
test("every example in every command's help runs as written", async () => {
  const fake = await fakeNtwine()
  try {
    const cwd = mkdtempSync(join(tmpdir(), "ntwinectl-examples-"))
    writeFileSync(join(cwd, "questions.json"), JSON.stringify({ questions: [{ question: "Ship it?", kind: "question", options: [{ label: "Yes" }, { label: "No" }] }] }))
    for (const file of ["handoff.md", "prompt.md", "resume-prompt.md"]) writeFileSync(join(cwd, file), "Some text with `backticks`.\n")
    for (const [name, spec] of Object.entries(CLI as Record<string, { examples: string[] }>)) {
      for (const example of spec.examples) {
        fake.seen.length = 0
        const ran = await new Promise<Ran>((resolve) => {
          const child = spawn("sh", ["-c", example], {
            cwd,
            env: { ...hostEnv(), ...worker(fake), NTWINE_NODE: process.execPath, PATH: `${BIN}${delimiter}${process.env.PATH}` },
            stdio: ["ignore", "pipe", "pipe"],
          })
          let stdout = ""
          let stderr = ""
          child.stdout.on("data", (c) => (stdout += c))
          child.stderr.on("data", (c) => (stderr += c))
          child.on("close", (code) => resolve({ code, stdout, stderr }))
        })
        assert.equal(ran.code, 0, `${name}: \`${example.split("\n")[0]}\` exited ${ran.code}: ${ran.stderr}`)
        assert.equal(fake.seen.length, 1, `${name}: \`${example.split("\n")[0]}\` made ${fake.seen.length} calls`)
      }
    }
  } finally {
    fake.close()
  }
})

// THE CONTRACT'S OWN SPELLINGS. The system prompt (workerPrompt.ts) is where a worker first meets the
// command line, and it lives in another file from the registry that defines it. So every `sh` fence the
// contract writes out is run here through a real shell, and every `ntwinectl <command>` it names in
// prose must be a command that exists, in the hyphenated spelling the help prints. A rename in the
// registry would otherwise leave every worker taught a command that exits 1.
test("every ntwinectl example the worker contract writes out runs as written, and every command it names exists", async () => {
  const fake = await fakeNtwine()
  try {
    const commands = new Set((TOOLS as Array<{ name: string }>).map((t) => t.name.replace(/_/g, "-")))
    for (const kind of ["claude", "codex", "acp"] as const) {
      const prompt = buildWorkerPrompt(kind)
      assert.doesNotMatch(prompt, /mcp__ntwine__/, `${kind}: the contract still names an MCP tool`)
      const named = [...prompt.matchAll(/`ntwinectl ([a-z][a-z_-]*)/g)].map((m) => m[1])
      assert.ok(named.length >= 20, `${kind}: the contract names the command line throughout (${named.length})`)
      for (const name of named) assert.ok(commands.has(name), `${kind}: the contract names \`ntwinectl ${name}\`, which is not a command`)
      // Every capability a worker is told about by name is one it was introduced to as `ntwinectl`.
      assert.match(prompt, /`ntwinectl --help` lists every command; `ntwinectl <command> --help` is that command's full\s+reference/)

      const examples = [...prompt.matchAll(/```sh\n(ntwinectl [^]*?)\n```/g)].map((m) => m[1])
      assert.equal(examples.length, 2, `${kind}: the done heredoc and the written-out question`)
      for (const example of examples) {
        fake.seen.length = 0
        const ran = await new Promise<Ran>((resolve) => {
          const child = spawn("sh", ["-c", example], {
            cwd: mkdtempSync(join(tmpdir(), "ntwinectl-contract-")),
            env: { ...hostEnv(), ...worker(fake), NTWINE_NODE: process.execPath, PATH: `${BIN}${delimiter}${process.env.PATH}` },
            stdio: ["ignore", "pipe", "pipe"],
          })
          let stdout = ""
          let stderr = ""
          child.stdout.on("data", (c) => (stdout += c))
          child.stderr.on("data", (c) => (stderr += c))
          child.on("close", (code) => resolve({ code, stdout, stderr }))
        })
        const first = example.split("\n")[0]
        assert.equal(ran.code, 0, `${kind}: \`${first}\` exited ${ran.code}: ${ran.stderr}`)
        assert.equal(fake.seen.length, 1, `${kind}: \`${first}\` made ${fake.seen.length} calls`)
        const { url, body } = fake.seen[0]
        if (url.endsWith("/rpc/ask")) {
          // The JSON the contract writes out is the question it describes: one pick-one question, two
          // options, the recommended one first.
          assert.equal(body.questions.length, 1)
          assert.equal(body.questions[0].kind, "question")
          assert.deepEqual(body.questions[0].options.map((o: { recommended?: boolean }) => !!o.recommended), [true, false])
        } else {
          assert.ok(url.endsWith("/rpc/markOwnDone"), url)
          assert.equal(body.body, "- **Fixed the lookup** in `src/resolver.ts`; `npm test` green.")
        }
      }
    }
  } finally {
    fake.close()
  }
})
