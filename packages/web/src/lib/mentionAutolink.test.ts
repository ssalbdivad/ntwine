import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { Marked } from "marked"
import type { ProjectQueue, ThreadView } from "@ntwine/shared"
import { MARKDOWN_OPTIONS } from "./markdown.ts"
import { setGithubRepo } from "./githubAutolink.ts"
import { mentionHref, mentionIndexVersion, setCrossProjectMentions, setMentionIndex, subscribeMentionIndex, withMentionProject } from "./mentionAutolink.ts"
import { threadLinkTarget } from "./thread-links.ts"

// `@thread` / `@thread.child` in AGENT markdown → in-app links (mentionAutolink.ts), driven through the
// exact marked configuration the app renders with. The sanitizer needs a DOM and is not in this path;
// what it does to these anchors (prefix the page's project, keep the fragment) is prefixedAppRoute's,
// pinned in base-path.test.ts.

const marked = new Marked(MARKDOWN_OPTIONS)
const render = (md: string) => marked.parseInline(md, { async: false }) as string
const renderBlock = (md: string) => (marked.parse(md, { async: false }) as string).trim()

const thread = (id: string, title: string, over: Partial<ThreadView> = {}) =>
  ({ id, title, titleAuto: false, titleLocked: true, kind: "session", state: "open", status: "active", runtime: "turn-idle", subAgents: [], bgShells: [], ...over }) as unknown as ThreadView

const BOARD = [
  thread("port-parser", "Port the parser"),
  thread("shell-budgets", "Shell budgets"),
  // Filed long ago: the typeahead's recent-twenty bound does not apply to what prose already names.
  thread("old-one", "Old one", { state: "archived", archived: true }),
  thread("external", "External", { foreign: true }),
]

before(() => setMentionIndex("ntwine", BOARD))
after(() => setMentionIndex(null, null))

test("a mention whose thread resolves becomes an in-app link to it; one that names nothing stays text", () => {
  assert.equal(
    render("ask @shell-budgets about it"),
    'ask <a href="/thread/shell-budgets" title="Open thread">@shell-budgets</a> about it',
  )
  assert.equal(render("then @ShellBudget and @shellBudgets"), 'then <a href="/thread/shell-budgets" title="Open thread">@ShellBudget</a> and <a href="/thread/shell-budgets" title="Open thread">@shellBudgets</a>', "the resolveMention fold, and a camelCase handle from before the kebab switch")
  assert.equal(render("see @shell-budgets—ok"), 'see <a href="/thread/shell-budgets" title="Open thread">@shell-budgets</a>—ok', "a dash after a mention is punctuation")
  assert.equal(render("filed as @old-one"), 'filed as <a href="/thread/old-one" title="Open thread">@old-one</a>', "a done thread of any age")
  assert.equal(render("ask @nobody or @external"), "ask @nobody or @external", "no such handle; an external row has none")
})

test("a dotted mention links to its thread with the child's address in the fragment", () => {
  assert.equal(
    render("see @port-the-parser.cache-keys."),
    'see <a href="/thread/port-parser#port-the-parser.cache-keys" title="Open sub-agent">@port-the-parser.cache-keys</a>.',
    "a sentence's full stop is never part of the mention",
  )
  assert.equal(
    render("@port-the-parser.wave-2.impl-w3 failed"),
    '<a href="/thread/port-parser#port-the-parser.wave-2.impl-w3" title="Open sub-agent">@port-the-parser.wave-2.impl-w3</a> failed',
  )
  assert.equal(render("@nobody.cache-keys"), "@nobody.cache-keys", "the HEAD must resolve")
})

test("code, existing links, emails, packages and decorators are left alone", () => {
  assert.equal(render("`@shell-budgets`"), "<code>@shell-budgets</code>")
  const block = renderBlock("```\n@shell-budgets\n```")
  assert.match(block, /<code[^>]*>@shell-budgets\n<\/code>/)
  assert.doesNotMatch(block, /href=/, "a fenced block is literal")
  assert.equal(render("[@shell-budgets](https://example.com)"), '<a href="https://example.com">@shell-budgets</a>')
  assert.equal(render('<a href="https://example.com">@shell-budgets</a>'), '<a href="https://example.com">@shell-budgets</a>', "a hand-written anchor")
  assert.match(render("mail shell@shell-budgets.dev"), /^mail <a href="mailto:shell@shell-budgets\.dev">/, "an email is marked's own link")
  assert.equal(render("install @shell-budgets/core"), "install @shell-budgets/core", "a scoped package, never its first letters")
  assert.equal(render("x@shell-budgets"), "x@shell-budgets", "not at a word boundary")
})

test("mentions link inside lists, emphasis and tables, beside GitHub refs", () => {
  setGithubRepo("colinhacks/frizz")
  try {
    assert.equal(
      renderBlock("- **@shell-budgets** fixed #12"),
      '<ul>\n<li><strong><a href="/thread/shell-budgets" title="Open thread">@shell-budgets</a></strong> fixed <a href="https://github.com/colinhacks/frizz/issues/12" title="colinhacks/frizz#12">#12</a></li>\n</ul>',
    )
    assert.match(renderBlock("| who |\n| --- |\n| @port-the-parser.cache-keys |"), /<td><a href="\/thread\/port-parser#port-the-parser\.cache-keys" title="Open sub-agent">@port-the-parser\.cache-keys<\/a><\/td>/)
  } finally {
    setGithubRepo(null)
  }
})

test("another project's prose resolves nothing against this page's board", () => {
  assert.equal(withMentionProject("other", () => render("ask @shell-budgets")), "ask @shell-budgets")
  assert.match(withMentionProject("ntwine", () => render("ask @shell-budgets")), /href="\/thread\/shell-budgets"/, "its own project's prose still links")
  assert.match(render("ask @shell-budgets"), /href=/, "…and the index is back after the override")
})

const queue = (projectSlug: string, threads: ThreadView[]) =>
  ({ projectId: projectSlug, projectSlug, projectName: projectSlug, projectDir: `/${projectSlug}`, threads, doneCount: 0 }) as ProjectQueue

test("showing All projects, another project's thread links to it there, and this project's still wins", () => {
  setCrossProjectMentions([
    queue("ntwine", BOARD.filter((t) => t.state === "open")),
    queue("nub", [thread("focus-mode", "Focus mode"), thread("sb-nub", "Shell budgets")]),
  ])
  try {
    assert.equal(render("ask @focus-mode"), 'ask <a href="/all/nub/thread/focus-mode" title="Open thread">@focus-mode</a>')
    assert.match(render("ask @shell-budgets"), /href="\/thread\/shell-budgets"/, "the page's own thread, not nub's")
    // A card of ANOTHER project: its own threads first, and every link names its project.
    assert.match(withMentionProject("nub", () => render("ask @shell-budgets")), /href="\/all\/nub\/thread\/sb-nub"/)
    assert.match(withMentionProject("nub", () => render("ask @port-the-parser")), /href="\/all\/ntwine\/thread\/port-parser"/)
    assert.equal(withMentionProject("gone", () => render("ask @focus-mode")), "ask @focus-mode", "a project the poll does not carry")
  } finally {
    setCrossProjectMentions(null)
  }
  assert.equal(render("ask @focus-mode"), "ask @focus-mode", "a project's own page resolves its own threads alone")
})

test("the index notifies only when a handle changes, not on every board push", () => {
  let notified = 0
  const unsubscribe = subscribeMentionIndex(() => notified++)
  try {
    const before = mentionIndexVersion()
    setMentionIndex("ntwine", BOARD.map((t) => ({ ...t, statusLine: "busy" })))
    assert.equal(notified, 0, "a status line is not a handle")
    setMentionIndex("ntwine", [...BOARD, thread("fresh", "Fresh idea")])
    assert.equal(notified, 1)
    assert.ok(mentionIndexVersion() > before)
    assert.match(render("@fresh-idea"), /href="\/thread\/fresh"/)
  } finally {
    setMentionIndex("ntwine", BOARD)
    unsubscribe()
  }
})

test("threadLinkTarget: the thread an in-app href opens, and a sub-agent address in its fragment", () => {
  assert.deepEqual(threadLinkTarget("/thread/port-parser"), { slug: "port-parser" })
  assert.deepEqual(threadLinkTarget("/thread/port-parser/"), { slug: "port-parser" })
  assert.deepEqual(threadLinkTarget(mentionHref("port-parser", "port-the-parser.wave-2.impl-w3")), { slug: "port-parser", address: "port-the-parser.wave-2.impl-w3" })
  assert.equal(threadLinkTarget("/thread/port-parser/full"), null)
  assert.equal(threadLinkTarget("/thread/port-parser#<script>"), null)
})
