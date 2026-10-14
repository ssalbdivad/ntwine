import { test } from "node:test"
import assert from "node:assert/strict"
import { askedQuestionFaults } from "@ntwine/shared"
import { MCP_GRANT_NONE, MCP_GRANT_PROJECT, MCP_GRANT_THREAD, mcpGrantOf, mcpRequestQuestion, threadMcpGrants } from "./mcp-requests.ts"

const server = { command: "uvx.exe", args: ["windows-mcp", "serve"] }
const row = (name: string | undefined, picked: string | undefined, state: "open" | "answered" | "dismissed" = "answered") => ({
  spec: JSON.stringify({ ...mcpRequestQuestion(name ?? "x", server, "why"), ...(name ? {} : { mcp: undefined }) }),
  answer: picked === undefined ? null : JSON.stringify({ questionId: "q", question: "…", chosen: [picked] }),
  state,
})

test("the server-written request is a valid question carrying its server and the worker's reason", () => {
  const q = mcpRequestQuestion("windows", server, "To screenshot the desktop window.")
  assert.deepEqual(askedQuestionFaults(q), [])
  assert.equal(q.mcp, "windows")
  assert.match(q.question, /`uvx\.exe windows-mcp serve`[\s\S]*To screenshot the desktop window\.$/)
  assert.deepEqual(q.options?.map((o) => o.label), [MCP_GRANT_THREAD, MCP_GRANT_PROJECT, MCP_GRANT_NONE])
})

test("only an answered request picking a grant grants it; a thread's grants are deduplicated", () => {
  assert.deepEqual(mcpGrantOf(row("windows", MCP_GRANT_THREAD)), { name: "windows", grant: "thread" })
  assert.deepEqual(mcpGrantOf(row("windows", MCP_GRANT_PROJECT)), { name: "windows", grant: "project" })
  assert.equal(mcpGrantOf(row("windows", MCP_GRANT_NONE)), undefined)
  assert.equal(mcpGrantOf(row("windows", undefined, "open")), undefined)
  assert.equal(mcpGrantOf(row("windows", MCP_GRANT_THREAD, "dismissed")), undefined)
  // An ordinary question whose answer happens to read like a grant is not one.
  assert.equal(mcpGrantOf(row(undefined, MCP_GRANT_THREAD)), undefined)
  const rows = [row("windows", MCP_GRANT_THREAD), row("windows", MCP_GRANT_PROJECT), row("b", MCP_GRANT_NONE)] as never
  assert.deepEqual(threadMcpGrants(rows), ["windows"])
})
