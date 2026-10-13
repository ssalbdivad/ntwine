import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { Api } from "../api/rpc.ts"
import { QueueChildOps } from "./QueueChildOps.tsx"

const thread = {
  id: "parent",
  subAgents: [
    { id: "toolu_a", taskId: "a93a2fe4400f31533", label: "Verify goal caps on a real stack", startedAt: "2026-09-29T18:10:00.000Z", state: "running" as const, stoppable: true },
    { id: "toolu_wf", label: "verify-wave", startedAt: "2026-09-29T18:12:00.000Z", state: "running" as const, workflow: true },
    { id: "aVerify1", label: "verify:S8:0.1", startedAt: "2026-09-29T18:13:00.000Z", state: "running" as const, depth: 2, parentId: "toolu_wf", phase: "Review" },
    { id: "toolu_q", label: "Quiet one", startedAt: "2026-09-29T17:00:00.000Z", state: "stale" as const },
  ],
  bgShells: [{ id: "toolu_sh", label: "nub run dev", startedAt: "2026-09-29T17:30:00.000Z", state: "running" as const }],
}
const render = (props: Partial<Parameters<typeof QueueChildOps>[0]> = {}) =>
  renderToStaticMarkup(createElement(QueueChildOps, { project: { slug: "ntwine" }, thread, api: {} as Api, onOpenThread: () => {}, ...props }))

test("the card's ops column lists every sub-agent and Workflow, in the drawer's row shape, and no shell", () => {
  const html = render()
  assert.match(html, /data-queue-ops="parent"/)
  // Dispatch order, a workflow's agents under it — the drawer strip's order. An agent row shows its handle
  // (a six-word sentence has none and stays as written).
  const order = [">Verify goal caps on a real stack<", ">verify-wave<", ">verify-s8-0-1<", ">quiet-one<"].map((label) => html.indexOf(label))
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1]!)), `order ${order}`)
  // The drawer's "sheet" density: kind tags, the live dots, and the stale child still listed.
  for (const tag of [">AGENT<", ">FLOW<"]) assert.ok(html.includes(tag), tag)
  assert.match(html, /stale — no recent output/)
  assert.match(html, /Review › verify:S8:0\.1/, "a workflow agent's phase rides its tooltip")
  // A shell is the card's TERM strip's (ThreadTerminals ThreadProcessStrip), never a row of this column.
  assert.doesNotMatch(html, />SHELL<|nub run dev/)
})

test("while the awaiting card lists the children, nothing of its own is left here; nothing live ⇒ nothing drawn", () => {
  assert.equal(render({ agents: false }), "")
  assert.equal(render({ thread: { id: "idle", subAgents: [] } }), "")
})

// On the queue card the terminals are the TERM strip's (ThreadTerminals ThreadProcessStrip), handed in as
// `after` so it hangs in this column under the AGENT / FLOW rows.
test("the card's strip hangs in this column under the agents, once", () => {
  const strip = createElement("div", { "data-strip": "" }, "TERM rows")
  const html = render({ after: strip })
  assert.ok(html.indexOf(">quiet-one<") > 0 && html.indexOf(">quiet-one<") < html.indexOf("data-strip"), "the strip hangs under the agent rows")
  assert.match(render({ agents: false, after: strip }), /^<div class="flex min-w-0 flex-col gap-0.5" data-queue-ops="parent">[\s\S]*data-strip/, "the strip alone still gets the column")
  assert.equal(render({ agents: false, after: null }), "", "nothing to draw ⇒ no empty inset")
})
