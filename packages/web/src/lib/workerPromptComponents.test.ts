import { test } from "node:test"
import assert from "node:assert/strict"
import { Marked } from "marked"
import { buildWorkerPrompt } from "../../../server/src/workerPrompt.ts"
import { LONG_BLOCK_OVER, LONG_BLOCK_SHOWN } from "./codeBlock.ts"
import { MARKDOWN_OPTIONS } from "./markdown.ts"

// The worker contract TEACHES the components this package draws (server/src/workerPrompt.ts § Markdown
// that Frizz draws as more than text), and the two live in different packages. A grammar change here
// would leave the prompt teaching a spelling that now renders as plain text, with nothing failing — the
// worker cannot see its own message drawn, so nobody would learn of it. So the section's OWN examples
// and spellings go through the app's real marked configuration, and each must come out as the component
// the prompt says it is.
//
// Pre-sanitizer HTML, as codeBlock.test.ts reads it: what the sanitizer keeps of each component —
// `<details>`, `<kbd>`, `<sub>`, `<sup>` and `<mark>` included — is read back in a browser
// (codeBlocks.e2e.test.ts, mdBlocks.e2e.test.ts).
const marked = new Marked(MARKDOWN_OPTIONS)
const render = (md: string) => (marked.parse(md, { async: false }) as string).trim()

function section(kind: "claude" | "codex"): string {
  const prompt = buildWorkerPrompt(kind)
  const start = prompt.indexOf("## Markdown that Frizz draws as more than text")
  assert.notEqual(start, -1, `the ${kind} contract carries the section`)
  const end = prompt.indexOf("\n## ", start + 3)
  return prompt.slice(start, end === -1 ? undefined : end)
}

test("the worker contract's own Markdown examples render as the components it names", () => {
  for (const kind of ["claude", "codex"] as const) {
    const html = render(section(kind))
    assert.match(html, /md-code-tabs"><span class="md-code-tablist" role="tablist">[^]*?>npm<\/button>[^]*?>pnpm<\/button>/,
      "the two labelled fences are one block with a tab each")
    assert.match(html, /<pre class="md-diff">[^]*?md-diff-del[^]*?hljs-keyword">await<[^]*?md-diff-add/,
      "the ts-diff fence is a diff whose code is highlighted as TypeScript")
    assert.match(html, /<blockquote class="md-callout md-callout-warning"><p class="md-callout-title">Before you merge<\/p>/,
      "the blockquote is a warning callout carrying its own title")
  }
})

test("every spelling the contract names is one the renderer reads", () => {
  const text = section("claude")
  const spelled = (code: string) => assert.ok(text.includes(`\`${code}\``), `the contract names \`${code}\``)

  spelled('title="src/server.ts"')
  spelled("{2,5-7}")
  const marked = render('```ts title="src/server.ts" {2,5-7}\na\nb\nc\nd\ne\nf\ng\nh\n```')
  assert.match(marked, /md-code-title">src\/server\.ts</)
  assert.equal(marked.split('class="md-line is-marked"').length - 1, 4, "lines 2, 5, 6 and 7")

  spelled("diff")
  const numbered = render("```diff\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -3,2 +3,2 @@\n one\n-two\n+three\n```")
  assert.match(numbered, /md-code-title">src\/a\.ts</, "a unified diff is titled with its file")
  assert.match(numbered, /md-diff-num" data-line="4"/, "and its lines are numbered from the hunk header")

  const types = [...text.matchAll(/`\[!([A-Z]+)\]`/g)].map((m) => m[1])
  assert.deepEqual(types, ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"])
  for (const type of types) assert.match(render(`> [!${type}]\n> Body.`), new RegExp(`md-callout-${type.toLowerCase()}"`), type)

  // "Leave a blank line after the summary and before `</details>`, or the Markdown … is printed raw."
  spelled("<details>")
  assert.match(render("<details>\n<summary>Log</summary>\n\n**bold**\n\n</details>"), /<strong>bold<\/strong>/)
  assert.doesNotMatch(render("<details>\n<summary>Log</summary>\n**bold**\n</details>"), /<strong>/)

  // A fence the islands pass swaps for a diagram is found by this class (lib/fenceIslands.ts).
  spelled("mermaid")
  assert.match(render("```mermaid\nflowchart LR\n  a --> b\n```"), /<code class="[^"]*language-mermaid/)
})

test("the fold the contract describes is the one the renderer applies", () => {
  const stated = /A block over (\d+) lines is folded to its first (\d+)/.exec(section("claude"))
  assert.deepEqual(stated?.slice(1).map(Number), [LONG_BLOCK_OVER, LONG_BLOCK_SHOWN])
  const block = (lines: number) => render("```ts\n" + Array.from({ length: lines }, (_, i) => `const v${i} = ${i}`).join("\n") + "\n```")
  assert.doesNotMatch(block(LONG_BLOCK_OVER), /is-clamped/)
  assert.match(block(LONG_BLOCK_OVER + 1), new RegExp(`is-clamped[^]*Show all ${LONG_BLOCK_OVER + 1} lines`))
})
