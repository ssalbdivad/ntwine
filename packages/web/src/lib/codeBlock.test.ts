import { test } from "node:test"
import assert from "node:assert/strict"
import { Marked } from "marked"
import { MARKDOWN_OPTIONS } from "./markdown.ts"
import { forgetLongBlocks, LONG_BLOCK_OVER, rememberLongBlock, withLongBlocksOpen } from "./codeBlock.ts"
import { parseDiffFence } from "./codeDiff.ts"
import { parseLineMarks } from "./codeLines.ts"
import { renderHighlightedCode } from "./syntaxHighlight.ts"

// The app's real marked configuration, as codeTabs.test.ts drives it. The sanitizer needs a DOM and is
// read back in the browser (codeBlocks.e2e.test.ts); what a fence's info string and text turn into is
// pure.
const marked = new Marked(MARKDOWN_OPTIONS)
const render = (md: string) => (marked.parse(md, { async: false }) as string).trim()
const fence = (info: string, body: string) => `\`\`\`${info}\n${body}\n\`\`\``
const count = (html: string, needle: string) => html.split(needle).length - 1
// What `code.textContent` would be: the copy button takes exactly this.
const textOf = (html: string) => {
  const code = /<code[^>]*>([\s\S]*)<\/code>/.exec(html)?.[1] ?? ""
  return code.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
}
const lines = (n: number) => Array.from({ length: n }, (_, i) => `const line${i + 1} = ${i + 1}`).join("\n")

test("a fence with nothing to add renders exactly as it always has", () => {
  for (const [info, body] of [["ts", "const a = 1"], ["", "plain"], ["bash", "npm test"], ["ansi", "\x1b[31mred\x1b[0m"]]) {
    assert.equal(render(fence(info, body)), renderHighlightedCode(body, info).trim(), info)
  }
})

test("line marks are read in the spellings the docs frameworks use", () => {
  assert.deepEqual(parseLineMarks("ts {2,4-5}"), [[2, 2], [4, 5]])
  assert.deepEqual(parseLineMarks("ts highlight={1}"), [[1, 1]]) // Mintlify
  assert.deepEqual(parseLineMarks(`ts title="a.ts" {3} showLineNumbers`), [[3, 3]])
  assert.deepEqual(parseLineMarks("ts { 1, 3-4 }"), [[1, 1], [3, 4]])
  for (const info of ["", "ts", "ts {}", "ts {a}", `ts {title: "x"}`, "ts {5-2}", "ts {0}"]) {
    assert.equal(parseLineMarks(info), null, info)
  }
})

test("marked lines are block lines, and the code's text is still the source", () => {
  const source = "const a = 1\nconst b = 2\nconst c = 3"
  const html = render(fence("ts {2}", source))
  assert.match(html, /^<span class="md-code"><pre class="md-code-lined"><code class="hljs language-typescript"><span class="md-line">/)
  assert.equal(count(html, `class="md-line"`), 2)
  assert.equal(count(html, `class="md-line is-marked"`), 1)
  assert.match(html, /<span class="md-line is-marked">.*b.*\n<\/span>/)
  assert.equal(textOf(html), `${source}\n`)
  assert.equal(count(html, "md-code-frame"), 0, "marks alone do not frame a block")
})

test("a token that spans lines is closed and re-opened at each marked line", () => {
  const source = "/* one\n   two\n   three */\nconst a = 1"
  const html = render(fence("ts {2}", source))
  assert.equal(count(html, "<span"), count(html, "</span>"))
  assert.match(html, /<span class="md-line is-marked"><span class="hljs-comment"> {3}two<\/span>\n<\/span>/)
  assert.equal(textOf(html), `${source}\n`)
})

test("a diff fence is named `diff`, `<lang>-diff`, `diff-<lang>` or `diff lang=`", () => {
  assert.deepEqual(parseDiffFence("diff"), { declared: null })
  assert.deepEqual(parseDiffFence("patch"), { declared: null })
  assert.deepEqual(parseDiffFence("ts-diff"), { declared: "ts" })
  assert.deepEqual(parseDiffFence("TS-Diff src/a.ts"), { declared: "ts" })
  assert.deepEqual(parseDiffFence("diff-python"), { declared: "python" })
  assert.deepEqual(parseDiffFence(`diff lang="rust"`), { declared: "rust" })
  for (const info of ["", "ts", "difference", "diffs", "-diff", "diff-"]) assert.equal(parseDiffFence(info), null, info)
})

test("a diff is drawn as rows, and its text is still the diff as written", () => {
  const source = " const keep = 1\n-const retries = 3\n+const retries = 5\n+const extra = true"
  const html = render(fence("diff", source))
  assert.match(html, /^<span class="md-code"><pre class="md-diff"><code class="hljs language-diff">/)
  assert.equal(count(html, `class="md-diff-row md-diff-ctx"`), 1)
  assert.equal(count(html, `class="md-diff-row md-diff-del"`), 1)
  assert.equal(count(html, `class="md-diff-row md-diff-add"`), 2)
  assert.match(html, /<span class="md-diff-row md-diff-del"><span class="md-diff-sign">-<\/span><span class="md-diff-text">const retries = 3\n<\/span><\/span>/)
  assert.match(html, /<span class="md-diff-row md-diff-ctx"><span class="md-diff-sign"> <\/span><span class="md-diff-text">const keep = 1\n/)
  assert.equal(count(html, "md-diff-num"), 0, "no hunk header, so nothing to number from")
  assert.equal(count(html, "hljs-"), 0, "no language named anywhere: rows, uncoloured")
  assert.equal(textOf(html), `${source}\n`)
})

test("the code on a diff's rows is highlighted in the language the fence names", () => {
  const source = "-const retries: number = 3\n+const retries: number = 5"
  for (const info of ["ts-diff", "diff-ts", `diff lang="ts"`, "typescript-diff"]) {
    const html = render(fence(info, source))
    assert.match(html, /<span class="md-diff-text"><span class="hljs-keyword">const<\/span> /, info)
    assert.match(html, /<span class="hljs-number">5<\/span>\n<\/span><\/span>/, info)
    assert.equal(count(html, `class="md-diff-row md-diff-add"`), 1, info)
    assert.equal(textOf(html), `${source}\n`, info)
  }
  assert.equal(count(render(fence("nonsense-diff", source)), "hljs-"), 0, "an unknown language is rows of plain code")
})

test("without a named language a diff takes its file's: the label's, then its own header's", () => {
  const change = "-const a = 1\n+const a = 2"
  assert.match(render(fence(`diff title="src/a.ts"`, change)), /hljs-keyword/)
  assert.match(render(fence("diff", `--- a/app.py\n+++ b/app.py\n-def a(): pass\n+def b(): pass`)), /hljs-keyword">def/)
  // A label that is not a file name does not stop the diff's own header from answering.
  assert.match(render([fence(`diff title="Before"`, `--- a/x.ts\n+++ b/x.ts\n${change}`), fence(`diff title="After"`, change)].join("\n")), /hljs-keyword/)
})

test("each side of a change is highlighted as one text, so a token may span rows", () => {
  const html = render(fence("ts-diff", " const a = `one\n-two`\n+three`"))
  // The deleted row closes the template literal the context row opened…
  assert.match(html, /md-diff-del"><span class="md-diff-sign">-<\/span><span class="md-diff-text"><span class="hljs-string">two`<\/span>\n/)
  // …and so, separately, does the added one.
  assert.match(html, /md-diff-add"><span class="md-diff-sign">\+<\/span><span class="md-diff-text"><span class="hljs-string">three`<\/span>\n/)
})

test("hunk headers number the rows: a deletion by the old file, the rest by the new", () => {
  const source = "@@ -98,3 +98,4 @@ function retry()\n keep\n-old\n+new\n+newer\n last"
  const html = render(fence("diff", source))
  assert.match(html, /<pre class="md-diff md-diff-n3">/)
  assert.match(html, /<span class="md-diff-row md-diff-hunk">@@ -98,3 \+98,4 @@ function retry\(\)\n<\/span>/)
  const numbers = [...html.matchAll(/md-diff-(ctx|del|add)"><span class="md-diff-num" data-line="(\d+)">/g)].map((m) => `${m[1]} ${m[2]}`)
  assert.deepEqual(numbers, ["ctx 98", "del 99", "add 99", "add 100", "ctx 101"])
  assert.equal(textOf(html), `${source}\n`)
})

test("a hand-written diff's flush-left context keeps its first character", () => {
  const source = "function retry() {\n-  return 3\n+  return 5\n}"
  const html = render(fence("js-diff", source))
  assert.match(html, /md-diff-ctx"><span class="md-diff-sign"><\/span><span class="md-diff-text"><span class="hljs-keyword">function<\/span>/)
  assert.match(html, /md-diff-ctx"><span class="md-diff-sign"><\/span><span class="md-diff-text">}\n/)
  assert.equal(textOf(html), `${source}\n`)
})

test("a diff of one file is titled from its own header, with its counts", () => {
  const source = "diff --git a/src/retry.ts b/src/retry.ts\nindex 1a2b3c4..5d6e7f8 100644\n--- a/src/retry.ts\n+++ b/src/retry.ts\n@@ -1,2 +1,3 @@\n-const retries = 3\n+const retries = 5\n+const backoff = true\n export {}"
  const html = render(fence("diff", source))
  assert.match(html, /^<span class="md-code md-code-frame md-code-tabs"><span class="md-code-tablist"><span class="md-code-title">src\/retry\.ts<\/span><span class="md-diff-stat"><span class="md-diff-adds">\+2<\/span><span class="md-diff-dels">−1<\/span><\/span><\/span><pre class="md-code-panel is-active md-diff md-diff-n1 md-diff-titled">/)
  assert.equal(count(html, `class="md-diff-row md-diff-file"`), 4, "the header lines stay in the text Copy takes")
  assert.match(html, /hljs-keyword/, "and the header names the language")
  assert.doesNotMatch(html, /role=/)
  assert.equal(textOf(html), `${source}\n`)
})

test("a diff of several files keeps their headers in view and takes no title", () => {
  const source = "--- a/one.ts\n+++ b/one.ts\n-a\n+b\n--- a/two.ts\n+++ b/two.ts\n-c\n+d"
  const html = render(fence("diff", source))
  assert.match(html, /^<span class="md-code"><pre class="md-diff">/)
  assert.equal(count(html, `class="md-diff-row md-diff-file"`), 4)
})

test("inside a hunk a line starting `--- ` is a deleted line, not a file header", () => {
  const html = render(fence("sql-diff", "@@ -1,2 +1,2 @@\n--- drop the old index\n+++ keep it\n select 1"))
  assert.equal(count(html, "md-diff-file"), 0)
  assert.match(html, /md-diff-del"><span class="md-diff-num" data-line="1"><\/span><span class="md-diff-sign">-<\/span>/)
})

test("a diff's text is escaped, never markup", () => {
  const html = render(fence("diff", `+</code><script>1</script>\n-<img src=x onerror=1>\n@@ <b> @@`))
  assert.ok(!html.includes("<script") && !html.includes("<img") && !html.includes("<b>"))
})

test("a labelled diff is a titled block, and diffs tab like any other fence", () => {
  const titled = render(fence(`ts-diff title="src/a.ts"`, "-a\n+b"))
  assert.match(titled, /<span class="md-code-title">src\/a\.ts<\/span><span class="md-diff-stat">/)
  const tabs = render([fence("diff Before", "-a"), fence("diff After", "+b")].join("\n"))
  assert.equal(count(tabs, `role="tab"`), 2)
  assert.equal(count(tabs, "md-diff-stat"), 0, "a tab strip carries no counts")
  assert.equal(count(tabs, `class="md-code-panel is-active md-diff" role="tabpanel"`), 1)
})

test("a closed fence over the limit is clamped, with a button for the rest", () => {
  forgetLongBlocks()
  const html = render(fence("ts", lines(LONG_BLOCK_OVER + 1)))
  assert.match(html, /^<span class="md-code md-code-frame"><pre class="md-code-long is-clamped"><code class="hljs language-typescript">/)
  assert.match(html, /<\/code><\/pre><button type="button" class="md-code-expand" aria-expanded="false">Show all 41 lines<\/button><button type="button" class="md-code-copy"/)
  assert.equal(count(html, "md-code-tabs"), 0, "no header row, so no tab chrome")
  assert.equal(textOf(html), `${lines(LONG_BLOCK_OVER + 1)}\n`)
  // At the limit it is an ordinary block.
  assert.equal(render(fence("ts", lines(LONG_BLOCK_OVER))), renderHighlightedCode(lines(LONG_BLOCK_OVER), "ts").trim())
})

test("a fence still being written is never clamped", () => {
  const streaming = `\`\`\`ts\n${lines(120)}`
  assert.equal(count(render(streaming), "md-code-long"), 0)
  // A partial closing fence is not a closing fence.
  assert.equal(count(render(`${streaming}\n\`\``), "md-code-long"), 0)
  assert.equal(count(render(`${streaming}\n\`\`\``), "md-code-long"), 1)
  // A longer opening fence is closed only by one as long.
  assert.equal(count(render(`\`\`\`\`ts\n${lines(120)}\n\`\`\``), "md-code-long"), 0)
  assert.equal(count(render(`\`\`\`\`ts\n${lines(120)}\n\`\`\`\``), "md-code-long"), 1)
})

test("a block the reader opened stays open across renders", () => {
  forgetLongBlocks()
  const source = lines(60)
  rememberLongBlock(source, true)
  const open = render(fence("ts", source))
  assert.match(open, /<pre class="md-code-long"><code/)
  assert.match(open, /aria-expanded="true">Show less<\/button>/)
  // Keyed by the text: another long block is still clamped.
  assert.match(render(fence("ts", lines(61))), /md-code-long is-clamped/)
  rememberLongBlock(`${source}\n`, false)
  assert.match(render(fence("ts", source)), /md-code-long is-clamped/)
})

test("a line marked below the fold keeps a long block open; one above it does not", () => {
  forgetLongBlocks()
  assert.equal(count(render(fence("ts {50}", lines(60))), "md-code-long"), 0)
  const html = render(fence("ts {3}", lines(60)))
  assert.match(html, /<pre class="md-code-lined md-code-long is-clamped">/)
})

test("a document's long blocks are left open", () => {
  forgetLongBlocks()
  const md = fence("ts", lines(60))
  assert.equal(count(withLongBlocksOpen(() => render(md)), "md-code-long"), 0)
  assert.equal(count(render(md), "md-code-long"), 1, "and the flag does not outlive the parse")
})

test("long diffs and long tabs clamp too, each tab with its own button", () => {
  forgetLongBlocks()
  const diff = render(fence("diff", Array.from({ length: 50 }, (_, i) => `+line ${i}`).join("\n")))
  assert.match(diff, /<pre class="md-diff md-code-long is-clamped">/)
  const tabs = render([fence("ts a.ts", lines(50)), fence("ts b.ts", "short"), fence("ts c.ts", lines(45))].join("\n"))
  assert.equal(count(tabs, `class="md-code-expand"`), 2)
  assert.match(tabs, /<pre class="md-code-panel is-active md-code-long is-clamped" role="tabpanel">[\s\S]*?<\/pre><button type="button" class="md-code-expand" aria-expanded="false">Show all 50 lines<\/button><pre class="md-code-panel" role="tabpanel">/)
  assert.equal(count(tabs, `class="md-code-copy"`), 1)
})

test("the fences Frizz draws as something else keep their one markup, however long", () => {
  const graph = Array.from({ length: 60 }, (_, i) => `  a${i} --> a${i + 1}`).join("\n")
  for (const name of ["mermaid", "lightbox"]) {
    assert.equal(render(fence(name, graph)), renderHighlightedCode(graph, name).trim(), name)
    assert.match(render(fence(name, graph)), new RegExp(`class="hljs language-${name}"`), name)
  }
})

test("a diagram or gallery fence still being written is a plain code block, with no name to draw from", () => {
  for (const name of ["mermaid", "lightbox"]) {
    const streaming = render(`\`\`\`${name}\ngraph TD\n  A --> B`)
    assert.match(streaming, /class="hljs language-plaintext"/, name)
    assert.ok(streaming.includes("A --&gt; B"), "its text is still shown")
    assert.match(render(`\`\`\`${name}\ngraph TD\n  A --> B\n\`\`\``), new RegExp(`language-${name}"`), name)
  }
})
