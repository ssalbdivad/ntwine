import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { createElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { BoardSnapshot, ThreadView } from "@ntwine/shared"
import { store } from "../store.ts"
import { NtwineWake, ShellWakeText } from "./NtwineWake.tsx"
import { ThreadSlugContext } from "./threadSlugContext.ts"

// AN AGENT TERMINAL'S WAKE LINE OPENS THAT TERMINAL (2026-09-30). `Agent terminal «quick build» finished` was
// plain text, and once the shell had left the strip nothing on the page could open it — while a finished
// terminal of yours sat in the strip with Open. Now its «name» is the link, as a sub-agent completion's is.

const inThread = (slug: string | null, node: ReactNode) =>
  renderToStaticMarkup(createElement(ThreadSlugContext.Provider, { value: slug }, node))

// Cut as every quoted divider is (WakeDivider DividerQuotedTitle, upstream 873338a0): only the name
// truncates, and a narrow row gives up the lead noun.
test("the wake line's name is the link to its terminal, and only the name truncates", () => {
  const html = renderToStaticMarkup(createElement(ShellWakeText, { text: "Agent terminal «quick build» exited 2", onOpen: () => {} }))
  assert.match(html, /^<span class="shrink-0 @max-\[34rem\]\/wake:hidden">Agent terminal <\/span><span class="flex min-w-0 items-center"><span class="shrink-0">«<\/span><button type="button" data-shell-wake-open="true" title="Open agent terminal" aria-label="Open agent terminal: quick build" class="min-w-0 truncate [^"]*">quick build<\/button><span class="shrink-0">»<\/span><\/span><span class="shrink-0"> exited 2<\/span>$/)
  // Nothing to open: the same words and the same cut, with the name as text.
  const plain = renderToStaticMarkup(createElement(ShellWakeText, { text: "Agent terminal «quick build» finished" }))
  assert.doesNotMatch(plain, /<button/)
  assert.match(plain, /<span class="min-w-0 truncate">quick build<\/span>.*<span class="shrink-0"> finished<\/span>$/)
  // A line that quotes nothing is one truncating span.
  assert.equal(renderToStaticMarkup(createElement(ShellWakeText, { text: "Context compacted" })), '<span class="min-w-0 truncate">Context compacted</span>')
})

test("ntwine's own relay of a finished shell finds that terminal by its task id and opens it", () => {
  const thread = { id: "fix-auth", bgShells: [], endedShells: [{ id: "toolu_q", taskId: "b1", label: "quick build", status: "completed" }] } as unknown as ThreadView
  store.board = { threads: [thread], projectSlug: "ntwine" } as unknown as BoardSnapshot
  const wake = "⏰ Your background shell finished: `b1` — quick build."
  assert.match(inThread("fix-auth", createElement(NtwineWake, { text: wake })), /data-shell-wake-open="true"[^>]*>quick build<\/button>/)
  // Not on the thread's own transcript, or no shell with that task id: plain text.
  assert.doesNotMatch(inThread(null, createElement(NtwineWake, { text: wake })), /data-shell-wake-open/)
  assert.doesNotMatch(inThread("fix-auth", createElement(NtwineWake, { text: "⏰ Your background shell finished: `b9` — other." })), /data-shell-wake-open/)
  store.board = null
})

// ChatView cannot load under node (it imports CSS), so the runtime line's routing is pinned over its source.
test("the runtime's own wake line passes its shell id and opens that drawer on the thread's own transcript", () => {
  const source = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8")
  assert.match(source, /<EventLine text=\{m\.text\} boundary=\{m\.boundary\} wakeShellId=\{m\.wakeShellId\}/)
  const line = source.slice(source.indexOf("function EventLine("), source.indexOf("function EventLine(") + 6000)
  assert.match(line, /useContext\(ThreadSlugContext\)/)
  assert.match(line, /pushBackgroundShellDrawer\(threadSlug, wakeShellId/)
  assert.match(line, /<ShellWakeText text=\{text\} onOpen=\{openShell\} \/>/)
})
