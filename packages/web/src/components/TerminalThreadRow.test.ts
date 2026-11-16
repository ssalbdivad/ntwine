import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { ThreadTerminal } from "@ntwine/shared"
import { TerminalRowTitle } from "./TerminalThreadRow.tsx"

const base: ThreadTerminal = { id: "term-1", command: "pnpm run dev", cwd: "/repo", state: "running", runId: 1, startedAt: "2026-11-16T00:00:00.000Z", handle: "pnpm-run-dev" }

const text = (terminal: ThreadTerminal) => renderToStaticMarkup(createElement(TerminalRowTitle, { terminal })).replace(/<[^>]+>/g, "")

test("an agent's terminal names the thread that started it, ahead of its folder", () => {
  const terminal: ThreadTerminal = { ...base, startedBy: "s-1", starterHandle: "query-serializer", checkout: { dir: "/repo/.ntwine/worktrees/eff-231", kind: "worktree" } }
  assert.equal(text(terminal), "$ pnpm-run-dev · from @query-serializer · eff-231")
})

test("a terminal the human started names no starter", () => {
  assert.equal(text({ ...base, startedBy: "human" }), "$ pnpm-run-dev")
})
