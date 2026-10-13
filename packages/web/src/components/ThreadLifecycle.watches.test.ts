import assert from "node:assert/strict"
import test from "node:test"
import { createElement, type FunctionComponent } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ThreadView } from "@ntwine/shared"
import { ThreadLifecycleActions } from "./ThreadLifecycle.tsx"
import { ThreadHeaderFacts } from "./ThreadHeaderFacts.tsx"
import { queueOpsCounts } from "../lib/queueOpsCounts.ts"
import { TooltipProvider } from "./Tooltip.tsx"

// ONE THING IS DESCRIBED IN ONE PLACE. The lifecycle footer used to carry an eye whose tooltip listed
// every armed watcher — and every one of those objects was already a row in the strip above it, with its
// own liveness dot. The duplicate was the confusing copy: it named a background shell by the runtime
// handle (`bzvtnt3ig`) that appears nowhere else in the UI, so one shell read as two unrelated things
// (maintainer 2026-08-14: "shells are not watchers… I don't see either of them as background shells
// underneath the prompt box", then "we do not need to redundantly list out background shells inside of
// the watcher icon menu").
//
// The footer is gone (2026-10-05): its verbs close the header's action strip and its context reading
// sits in the header's line of facts, while the rows fold into the counts above the queue card's docked
// prompt box. These are ABSENCE tests, which rot silently — so they assert on the RENDERED MARKUP of each
// surface the footer's parts moved to, given watchers of every kind. A reintroduced watcher readout has
// to render something on one of them, and this catches it whatever it is called.

const base = {
  kind: "session",
  backend: "claude",
  title: "A worker",
  status: "active",
  runtime: "turn-idle",
  subAgents: [],
  foreign: false,
  state: "open",
  archived: false,
} as unknown as ThreadView

function render(component: FunctionComponent<{ thread: ThreadView }>, extra: Partial<ThreadView>): string {
  const thread = { ...base, id: "t", ...extra } as ThreadView
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      createElement(TooltipProvider, null, createElement(component, { thread })),
    ),
  )
}

const SHELL_WATCH = { id: "wch_1", kind: "shell" as const, target: "bzvtnt3ig", state: "armed" as const, createdAt: new Date(Date.now() - 34 * 60_000).toISOString() }
const PR_WATCH = { id: "github:t:acme/app#391", kind: "github" as const, target: "acme/app#391", state: "armed" as const, createdAt: new Date(Date.now() - 120 * 60_000).toISOString() }

const SURFACES = [
  ["the header's lifecycle verbs", ThreadLifecycleActions],
  ["the header's line of facts", ThreadHeaderFacts],
] as [string, FunctionComponent<{ thread: ThreadView }>][]

test("no surface the footer's parts moved to names a watcher — the rows own that", () => {
  for (const [name, watches] of [
    ["a shell watcher", [SHELL_WATCH]],
    ["a PR watcher", [PR_WATCH]],
    ["both", [SHELL_WATCH, PR_WATCH]],
  ] as [string, ThreadView["watches"]][]) {
    for (const [surface, component] of SURFACES) {
      const html = render(component, { watches, lastActivityAt: new Date(Date.now() - 120_000).toISOString() })
      assert.doesNotMatch(html, /data-armed-watches/, `${surface}, ${name}: no watcher readout`)
      assert.doesNotMatch(html, /Watching/, `${surface}, ${name}: nothing claims to be watching`)
      // The two targets, in every spelling the old readout used. A shell's runtime handle must never
      // reach the operator at all — it names nothing they can see anywhere else.
      assert.doesNotMatch(html, /bzvtnt3ig/, `${surface}, ${name}: no runtime handle`)
      assert.doesNotMatch(html, /acme\/app#391/, `${surface}, ${name}: no PR ref`)
    }
  }
})

// The rows themselves fold into the counts above the queue card's docked prompt box. A shell watch is not
// a second object there either: the shell it waits on is already counted as a shell, from the board's own
// shell list, and counting the watch too is the same double-naming the eye did, as a number. (The counts
// are pinned through their pure derivation: QueueOpsSummary imports the strip from ChatView, whose CSS
// imports no unit test can load.)
test("the counts take a PR watch as a PR and never count a shell watch at all", () => {
  const thread = (watches: ThreadView["watches"]) => ({ ...base, id: "t", watches }) as ThreadView
  assert.deepEqual(queueOpsCounts(thread([SHELL_WATCH])), [], "a shell watch alone draws no counts")
  assert.deepEqual(
    queueOpsCounts(thread([SHELL_WATCH, PR_WATCH])).map(({ key, n }) => ({ key, n })),
    [{ key: "pr", n: 1 }],
  )
})
