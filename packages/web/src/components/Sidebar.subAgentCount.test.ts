import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { SubAgentView, ThreadView } from "@ntwine/shared"
import { RailRow, SubAgentRows, type RowScope } from "./Sidebar.tsx"
import { TooltipProvider } from "./Tooltip.tsx"

// All projects shows a thread's live children as a count on the thread's own row — no line of their own.
// The count is every child the drawer would list, at every depth; the names ride its tooltip. A project's
// board lists them as rows under the thread instead (SubAgentRows), and its row then draws no count.

const ROW_SCOPE: RowScope = { open: () => {}, page: true }
const STARTED = new Date(Date.now() - 5 * 60_000).toISOString()

function rail(id: string, subAgents: Partial<SubAgentView>[], board = false): string {
  const thread = {
    id,
    kind: "session",
    title: "Refactor the resolver",
    titleLocked: true,
    backend: "claude",
    runtime: "turn-idle",
    status: "running",
    subAgents: subAgents.map((s) => ({ state: "running", startedAt: STARTED, ...s })),
  } as unknown as ThreadView
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      createElement(
        TooltipProvider,
        null,
        createElement(RailRow, { t: thread, active: false, scope: ROW_SCOPE, subAgentRows: board }),
        board ? createElement(SubAgentRows, { t: thread, scope: ROW_SCOPE }) : null,
      ),
    ),
  )
}

const CHILDREN: Partial<SubAgentView>[] = [
  { id: "a1", label: "fix:r1" },
  { id: "a2", label: "fix:r2", state: "stale" },
  { id: "wf", label: "impl-flow", workflow: true },
  { id: "wf-1", label: "impl:W3", depth: 2, parentId: "wf" },
]

test("a thread's live children are a count on its row, every depth included, and no rows of their own", () => {
  const html = rail("count", CHILDREN)
  assert.match(html, /data-rail-subagents="count" title="fix-r1, fix-r2, impl-flow, impl-w3" aria-label="4 sub-agents"/)
  assert.match(html, /aria-label="4 sub-agents"[^>]*><span aria-hidden="true"[^>]*><svg[\s\S]*?<\/svg><\/span><span class="tabular-nums"><span aria-hidden="true" class="text-\[13px\] leading-\[19px\]"><\/span>4</, "the robot, then the number, as the project row's counts read — the number on the title's line (TitleStrut)")
  for (const name of [">fix-r1<", ">impl-flow<", ">impl-w3<"]) assert.ok(!html.includes(name), `${name} is not drawn as a row`)
  assert.ok(!html.includes("data-op-row") && !html.includes("data-subagent-parent"), "no child row renders in the rail")
})

test("one child reads singular", () => {
  assert.match(rail("one", [{ id: "a1", label: "solo" }]), /aria-label="1 sub-agent"/)
})

test("a thread with no live child draws no count", () => {
  assert.ok(!rail("none", []).includes("data-rail-subagents"))
  assert.ok(!rail("gone", [{ id: "done", label: "fix:r9", state: "returned" }]).includes("data-rail-subagents"))
})

test("on a project's board the children are rows under the thread, nested by depth, and the row draws no count", () => {
  const html = rail("board", CHILDREN, true)
  assert.ok(!html.includes("data-rail-subagents"), "no count beside the rows that say it")
  assert.match(html, /data-xq-subagent-rows="board"/)
  // Every live child at every depth, in the drawer's order: the workflow's agent under the workflow.
  const order = ["fix:r1", "fix:r2", "impl-flow", "impl:W3"].map((label) => html.indexOf(label))
  assert.ok(order.every((at) => at > 0) && order.every((at, i) => i === 0 || at > order[i - 1]!), `rows in order: ${order}`)
  // The depth-2 child steps one indent further right than its parent (ChildOpRow's rail padding).
  const pads = [...html.matchAll(/style="padding-left:(\d+)px"/g)].map((m) => Number(m[1]))
  assert.equal(pads.length, 1, "only the nested child carries an indent")
})
