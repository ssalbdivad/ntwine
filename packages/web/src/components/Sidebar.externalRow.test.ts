import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ThreadView } from "@ntwine/shared"
import { ThreadRow, type RowScope } from "./Sidebar.tsx"
import { TooltipProvider } from "./Tooltip.tsx"

// Where a click would lead. Nothing here clicks; the prop is required because every real row has one.
const ROW_SCOPE: RowScope = { open: () => {}, page: true }

// An EXTERNAL row (the human's own `claude`/`codex` session) once wore a `terminal` pill. In ntwine
// "terminal" names a live pty the human opened on a thread (thread-terminals.ts), so the pill claimed
// something the row is not. The External band's header already says where the row came from, so the
// row carries no tag of its own.

function row(extra: Partial<ThreadView>) {
  const t = { kind: "session", backend: "claude", title: "A thread", status: "active", runtime: "turn-idle", subAgents: [], id: "thread", ...extra } as unknown as ThreadView
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      createElement(TooltipProvider, null, createElement(ThreadRow, { t, scope: ROW_SCOPE })),
    ),
  )
}

test("an external row is not labelled a terminal", () => {
  const html = row({ foreign: true })
  assert.match(html, /data-xq-thread-row/)
  assert.doesNotMatch(html, />\s*terminal\s*</i)
})
