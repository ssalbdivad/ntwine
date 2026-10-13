// cc-worker/hooks/agent-address.mjs — the post-dispatch hook that hands the worker its new sub-agent's
// `@thread.subAgent` address, so the handoff names the child by the link the board draws. Driven as the
// harness drives it: the real script as a child process, the PostToolUse event on stdin, the worker's
// env, and a real HTTP server behind a real `server.lock` answering the real query path.
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "../../../cc-worker/hooks/agent-address.mjs")
const PROJECT = "11111111-2222-3333-4444-555555555555"

function runHook(event: Record<string, unknown>, env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [HOOK], { env: { PATH: dirname(process.execPath), ...env }, encoding: "utf8" }, (error, stdout) => (error ? reject(error) : resolve(stdout)))
    child.stdin!.end(JSON.stringify(event))
  })
}

async function ntwineRoot(answer: (url: URL) => unknown) {
  const root = mkdtempSync(join(tmpdir(), "ntwine-agent-address-"))
  const permDir = join(root, "projects", PROJECT, "perm-requests")
  mkdirSync(permDir, { recursive: true })
  const seen: IncomingMessage[] = []
  const server = createServer((req, res) => {
    seen.push(req)
    const body = answer(new URL(req.url!, "http://x"))
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ result: body }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  writeFileSync(join(root, "server.lock"), JSON.stringify({ port: (server.address() as AddressInfo).port, pid: process.pid }))
  return {
    permDir, seen,
    close: async () => { await new Promise((resolve) => server.close(resolve)); rmSync(root, { recursive: true, force: true }) },
  }
}

const dispatch = (over: Record<string, unknown> = {}) => ({ hook_event_name: "PostToolUse", tool_name: "Agent", tool_input: { description: "Spelling", prompt: "Check README.md." }, ...over })

test("a thread's own dispatch is told the address its sub-agent answers to", async () => {
  const root = await ntwineRoot((url) => {
    const input = JSON.parse(url.searchParams.get("input")!)
    return input.slug === "parser-port" && input.label === "Spelling" ? { address: "parser-port.spelling" } : {}
  })
  try {
    const out = JSON.parse(await runHook(dispatch(), { NTWINE_THREAD: "parser-port", NTWINE_PERM_DIR: root.permDir }))
    assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUse")
    assert.match(out.hookSpecificOutput.additionalContext, /^This sub-agent is @parser-port\.spelling\./)
    assert.equal(root.seen[0]!.url!.split("?")[0], `/_ntwine/${PROJECT}/rpc/subAgentAddressFor`, "addressed to this worker's own project")
    assert.equal(root.seen[0]!.headers["sec-fetch-site"], "same-origin")
  } finally { await root.close() }
})

test("silent when it cannot name the child: inside a sub-agent, no handle, not a worker, or no server", async () => {
  const root = await ntwineRoot(() => ({}))
  try {
    const env = { NTWINE_THREAD: "parser-port", NTWINE_PERM_DIR: root.permDir }
    assert.equal(await runHook(dispatch({ agent_id: "aChild" }), env), "", "a grandchild's address is not this thread's to state")
    assert.equal(await runHook(dispatch(), env), "", "a description with no handle gets no line")
    assert.equal(await runHook(dispatch(), { NTWINE_PERM_DIR: root.permDir }), "", "inert outside a ntwine worker")
    assert.equal(root.seen.length, 1, "only the one real lookup reached the server")
  } finally { await root.close() }
  const gone = mkdtempSync(join(tmpdir(), "ntwine-agent-address-gone-"))
  try {
    const permDir = join(gone, "projects", PROJECT, "perm-requests")
    mkdirSync(permDir, { recursive: true })
    writeFileSync(join(gone, "server.lock"), JSON.stringify({ port: 1, pid: process.pid }))
    assert.equal(await runHook(dispatch(), { NTWINE_THREAD: "parser-port", NTWINE_PERM_DIR: permDir }), "", "a server that is not there fails open")
  } finally { rmSync(gone, { recursive: true, force: true }) }
})
