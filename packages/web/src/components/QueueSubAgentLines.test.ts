import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueueSubAgentLines } from "./QueueSubAgentLines.tsx"

test("queue cards show BOTH running and stale child work, and no model+effort tag", () => {
  const html = renderToStaticMarkup(createElement(QueueSubAgentLines, {
    slug: "parent-thread",
    subAgents: [
      {
        id: "running-child",
        label: "Complete GVS fix differential repro",
        startedAt: "2026-07-22T16:00:00.000Z",
        state: "running",
        subagentType: "ntwine:opus-xhigh",
      },
      {
        id: "stale-child",
        label: "Old differential repro",
        startedAt: "2026-07-22T15:00:00.000Z",
        state: "stale",
      },
    ],
  }))

  assert.match(html, /data-queue-subagents/)
  // Each child by its handle — what `@thread.` completes to (groups.ts subAgentName).
  assert.match(html, />complete-gvs-fix-differential-repro</)
  assert.match(html, /data-running-indicator="queue-subagent"/)
  // Tagged like the drawer's strip and like the shell/File rows that continue this column on the card.
  assert.equal(html.match(/ntwine-kind-tag[^"]*">AGENT</g)?.length, 2, "every child line carries its AGENT tag")
  // The model+effort tag was DELETED from these lines on 2026-07-27 (maintainer): the profile belongs
  // to the prompt box's own control one line above, not repeated on every child line beneath it.
  assert.doesNotMatch(html, /data-agent-profile/)
  assert.doesNotMatch(html, /opus › xhigh/)
  assert.doesNotMatch(html, /ntwine:opus-xhigh/)
  // A STALE child now renders on the card too (maintainer ruling 2026-07-24): a stale child is
  // unresolved work, not gone, and hiding it made the card claim "done underneath" while the rail
  // still showed it. It gets the flat stale dot, not the pulsing running indicator.
  assert.match(html, />old-differential-repro</)
  assert.match(html, /stale — no recent output/)
})

test("a queued parent's batch draws its RETURNED children after the live ones, each with how it ended", () => {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
  const html = renderToStaticMarkup(createElement(QueueSubAgentLines, {
    slug: "parent-thread",
    subAgents: [{ id: "c", label: "Audit the resolver", startedAt: ago(600_000), state: "running" }],
    returned: [
      { id: "a", label: "Trace the cache collision", status: "completed", startedAt: ago(600_000), finishedAt: ago(270_000) },
      { id: "b", label: "Sweep normalizeId call sites", status: "failed", startedAt: ago(600_000), finishedAt: ago(150_000) },
    ],
  }))
  // Live first: it is what the card is still waiting on.
  assert.ok(html.indexOf(">audit-the-resolver<") < html.indexOf(">trace-the-cache-collision<"))
  assert.match(html, /data-returned-mark="completed"/)
  assert.match(html, /data-returned-mark="failed"/)
  // The reading says how long AGO it came back, in the house grammar — never how long it worked. (Half a
  // minute past each mark: the row reads a shared ticking clock, which may sit a few seconds behind.)
  assert.match(html, />returned 4m ago</)
  assert.match(html, />failed 2m ago</)
  // A returned child has nothing to stop: no × on it.
  assert.equal((html.match(/data-op-row/g) ?? []).length, 0)
  // NEGATIVE CONTROL: without the returned half the card draws the live row alone, and no mark.
  const live = renderToStaticMarkup(createElement(QueueSubAgentLines, {
    slug: "parent-thread",
    subAgents: [{ id: "c", label: "Audit the resolver", startedAt: ago(600_000), state: "running" }],
  }))
  assert.doesNotMatch(live, /data-returned-mark/)
})

test("a return inside the last minute reads 'just now' — the page clock ticks every 30s, so seconds would freeze", () => {
  const html = renderToStaticMarkup(createElement(QueueSubAgentLines, {
    slug: "parent-thread",
    subAgents: [{ id: "c", label: "Audit", startedAt: new Date(Date.now() - 60_000).toISOString(), state: "running" }],
    // Ahead of the shared clock by a few seconds, exactly as a fresh return is: still "just now", never blank.
    returned: [{ id: "a", label: "Trace", status: "completed", finishedAt: new Date(Date.now() + 5_000).toISOString() }],
  }))
  assert.match(html, />returned just now</)
})
