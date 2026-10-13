import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { createElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { BoardSnapshot, SpinoffView, ThreadView } from "@ntwine/shared"
import { store } from "../store.ts"
import { ThreadHandleLink } from "./MentionLinks.tsx"
import { SpinoffCard, SpinoffOf, SpinoffOriginCard, spinoffCardState } from "./Spinoff.tsx"
import { ThreadSlugContext } from "./threadSlugContext.ts"

// The spinoff's two dedicated cards (David 2026-09-30: "a special UI affordance for referencing
// spinoff context", "dedicated UI and link to the spinoff … mention the spinoff by name with the new @
// feature"), rendered against a stubbed board. ChatView itself cannot load under node (it imports CSS),
// so its routing is pinned over its source at the bottom and driven for real in Spinoff.e2e.test.ts.

const thread = (over: Partial<ThreadView> & { id: string; title: string }): ThreadView => ({
  kind: "session", backend: "claude", titleAuto: false, titleLocked: true, status: "active", runtime: "turn-idle", subAgents: [],
  ...over,
}) as unknown as ThreadView

const edge = (over: Partial<SpinoffView> = {}): SpinoffView => ({
  id: "spn_0123456789abcdef", parentSlug: "live-sub-agents", childSlug: "evaluate-addresses", instructions: "Is it worth keeping?", createdAt: 0, ...over,
})

function board(threads: ThreadView[]): void {
  store.board = { threads, projectSlug: "ntwine" } as unknown as BoardSnapshot
}

function inThread(slug: string, node: ReactNode): string {
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(ThreadSlugContext.Provider, { value: slug }, node)))
}

test("a request is started once it has a child; an older one without reads didn't start, and one whose edge is gone reads detached", () => {
  const pending = edge({ childSlug: null })
  assert.equal(spinoffCardState(edge(), false), "started")
  assert.equal(spinoffCardState(edge(), true), "started")
  assert.equal(spinoffCardState(pending, true), "unstarted", "an older build's request its worker never answered")
  assert.equal(spinoffCardState(undefined, true), "detached", "the board lists the thread's edges, and this one is gone")
  assert.equal(spinoffCardState(undefined, false), "unstarted", "no board row to read the edge list from")

  board([thread({ id: "live-sub-agents", title: "Live sub agents", runtime: "running", spinoffs: [pending] })])
  const old = inThread("live-sub-agents", createElement(SpinoffCard, { id: pending.id, instructions: "x" }))
  assert.match(old, /data-spinoff-state="unstarted"/)
  assert.match(old, /didn(?:'|&#x27;)t start/)
  assert.doesNotMatch(old, /<a /)

  board([thread({ id: "live-sub-agents", title: "Live sub agents", runtime: "turn-idle", spinoffs: [] })])
  const detached = inThread("live-sub-agents", createElement(SpinoffCard, { id: pending.id, instructions: "Is it worth keeping?" }))
  assert.match(detached, /data-spinoff-state="detached"/)
  assert.match(detached, /Is it worth keeping\?/)
  assert.doesNotMatch(detached, /didn(?:'|&#x27;)t start/)
  assert.doesNotMatch(detached, /<a /)
})

test("the parent's card names the child by @handle, links it, and is outlined rather than the human's filled bubble", () => {
  board([
    thread({ id: "live-sub-agents", title: "Live sub agents", spinoffs: [edge()] }),
    thread({ id: "evaluate-addresses", title: "Evaluate addresses", statusLine: "Reading the router" }),
  ])
  const html = inThread("live-sub-agents", createElement(SpinoffCard, { id: edge().id, instructions: "Is it worth keeping?\nBe blunt.", sourceId: "u1" }))
  assert.match(html, /data-spinoff-card="request"/)
  assert.match(html, /data-spinoff="spn_0123456789abcdef"/)
  assert.match(html, /data-ntwine-msg="u1"/)
  assert.match(html, /data-spinoff-state="started"/)
  assert.match(html, />Spinoff</)
  assert.match(html, /<a href="\/thread\/evaluate-addresses" title="Evaluate addresses · Reading the router" data-thread-mention="evaluate-addresses"[^>]*>@evaluate-addresses<\/a>/)
  assert.match(html, /Is it worth keeping\?\nBe blunt\./, "the instructions verbatim, breaks intact")
  assert.match(html, /\bborder\b/)
  assert.doesNotMatch(html, /bg-user-bubble/, "an action, not a message: no bubble fill")
})

test("the child's card heads it as a spinoff of its parent, with its context folded beneath", () => {
  board([
    thread({ id: "live-sub-agents", title: "Live sub agents" }),
    thread({ id: "evaluate-addresses", title: "Evaluate addresses", spinoffs: [edge()] }),
  ])
  const html = inThread("evaluate-addresses", createElement(SpinoffOriginCard, {
    instructions: "Is it worth keeping?",
    context: createElement("p", null, "BRIEF-BODY"),
    sourceId: "u0",
  }))
  assert.match(html, /data-spinoff-card="origin"/)
  assert.match(html, /Spinoff of<\/span><a href="\/thread\/live-sub-agents"[^>]*>@live-sub-agents<\/a>/)
  assert.match(html, /Is it worth keeping\?/)
  assert.match(html, /aria-expanded="false"/)
  assert.match(html, /Context from @live-sub-agents/)
  assert.doesNotMatch(html, /BRIEF-BODY/, "collapsed by default: one quiet line, not the context")
  assert.doesNotMatch(html, /bg-user-bubble/)
})

test("a child card whose edge the board does not carry still heads itself, without naming a parent", () => {
  board([thread({ id: "evaluate-addresses", title: "Evaluate addresses" })])
  const html = inThread("evaluate-addresses", createElement(SpinoffOriginCard, { instructions: "x", context: createElement("p", null, "brief") }))
  assert.match(html, />Spinoff<\/span>/)
  assert.doesNotMatch(html, /Spinoff of/)
  assert.match(html, />Context</)
  // …and a forked child has no context to fold.
  const bare = inThread("evaluate-addresses", createElement(SpinoffOriginCard, { instructions: "x", context: null }))
  assert.doesNotMatch(bare, /data-spinoff-context-toggle/)
})

test("a thread link reads @handle, else the title the board shows, else the slug", () => {
  board([
    thread({ id: "named", title: "Shell budgets" }),
    thread({ id: "sentence", title: "Rework the session-limit banner so the countdown reads in the house grammar" }),
  ])
  assert.match(renderToStaticMarkup(createElement(ThreadHandleLink, { slug: "named" })), />@shell-budgets</)
  assert.match(renderToStaticMarkup(createElement(ThreadHandleLink, { slug: "sentence" })), />Rework the session-limit banner so the countdown reads in the house grammar</)
  const gone = renderToStaticMarkup(createElement(ThreadHandleLink, { slug: "not-on-board" }))
  assert.match(gone, />not-on-board</)
  assert.match(gone, /title="Open thread"/)
  // A surface of ANOTHER project says it has no row rather than letting the page's board answer for a
  // same-named slug.
  assert.match(renderToStaticMarkup(createElement(ThreadHandleLink, { slug: "named", thread: null })), />named</)
})

test("the child's header line is a spinoff of its parent by @handle, and a queue card can point it at its own project", () => {
  const child = thread({ id: "evaluate-addresses", title: "Evaluate addresses", spinoffs: [edge()] })
  board([thread({ id: "live-sub-agents", title: "Live sub agents" }), child])
  assert.match(renderToStaticMarkup(createElement(SpinoffOf, { thread: child })), /Spinoff of <a href="\/thread\/live-sub-agents"[^>]*>@live-sub-agents<\/a>/)
  const elsewhere = renderToStaticMarkup(createElement(SpinoffOf, {
    thread: child,
    resolve: (slug: string) => (slug === "live-sub-agents" ? thread({ id: slug, title: "Other project parent" }) : undefined),
    href: (slug: string) => `/all/nub/thread/${slug}`,
  }))
  assert.match(elsewhere, /href="\/all\/nub\/thread\/live-sub-agents"[^>]*>@other-project-parent</)
  // The PARENT has no header line of this kind — its spinoffs are cards in its chat.
  assert.equal(renderToStaticMarkup(createElement(SpinoffOf, { thread: thread({ id: "live-sub-agents", title: "Live sub agents", spinoffs: [edge()] }) })), "")
})

// ── ChatView's routing, pinned over its source (it cannot load under node) ─────────────────────────
const chatView = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8")

test("Message draws a spinoff request, by the server's tell, as the card", () => {
  assert.match(chatView, /if \(m\.spinoff\) return <SpinoffCard id=\{m\.spinoff\.id\} instructions=\{m\.spinoff\.instructions\} sourceId=\{m\.sourceId\} \/>/)
})

test("Message draws a child's first turn as the origin card, before the user-bubble fallback", () => {
  const origin = chatView.indexOf("if (m.spinoffOrigin) return <SpinoffOriginCard")
  const bubble = chatView.indexOf("return <UserBubble text={text}")
  assert.ok(origin > 0 && origin < bubble, "the origin branch precedes the bubble")
  assert.match(chatView, /<SpinoffOriginCard instructions=\{m\.spinoffOrigin\.instructions\} context=\{m\.spinoffOrigin\.brief\.trim\(\) \? <ProseHtml md=\{m\.spinoffOrigin\.brief\} wrap \/> : null\}/)
})

test("Message takes no thread", () => {
  assert.doesNotMatch(chatView, /export const Message = memo\(function Message\(\{[^}]*\bthread\b/)
})
