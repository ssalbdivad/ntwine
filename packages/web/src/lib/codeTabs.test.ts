import { test } from "node:test"
import assert from "node:assert/strict"
import { Marked } from "marked"
import { MARKDOWN_OPTIONS } from "./markdown.ts"
import { forgetCodeTabs, parseFenceLabel, rememberCodeTab } from "./codeTabs.ts"
import { renderCodeBlock } from "./codeBlock.ts"

// The app's real marked configuration, as markdown.test.ts drives it: the sanitizer needs a DOM and is
// read back in the browser (codeTabs.e2e.test.ts); the grouping and the markup are pure.
const marked = new Marked(MARKDOWN_OPTIONS)
const render = (md: string) => (marked.parse(md, { async: false }) as string).trim()
const fence = (info: string, body: string) => `\`\`\`${info}\n${body}\n\`\`\``
const count = (html: string, needle: string) => html.split(needle).length - 1

test("a label is read in every spelling the docs frameworks use", () => {
  const label = (info: string) => parseFenceLabel(info)?.label ?? null
  assert.equal(label("bash npm"), "npm") // Mintlify
  assert.equal(label("python Python 3"), "Python 3")
  assert.equal(label(`ts title="src/a b.ts"`), "src/a b.ts") // Docusaurus, Starlight
  assert.equal(label("ts title='server.ts'"), "server.ts")
  assert.equal(label(`js filename="example.js"`), "example.js") // Nextra
  assert.equal(label(`ts tab="Tab 1"`), "Tab 1") // Fumadocs
  assert.equal(label("js [config.js]"), "config.js") // VitePress
  assert.equal(label(`bash "npm"`), "npm")
  assert.equal(label(`title="server.ts"`), "server.ts", "a fence may open straight into its label")
})

test("fence options are never mistaken for a label", () => {
  for (const info of ["", "ts", "ts {1,3-5}", "js showLineNumbers", "ts {2} wrap copy", `js icon="square-js" lines`]) {
    assert.equal(parseFenceLabel(info), null, info)
  }
  assert.equal(parseFenceLabel(`ts src/server.ts {4-6} showLineNumbers`)?.label, "src/server.ts")
  assert.equal(parseFenceLabel(`ts ${"word ".repeat(30)}`), null, "a sentence is not a name")
})

test("the fences Frizz draws as something else are never tabs", () => {
  for (const name of ["lightbox", "mermaid", "question", "done", "awaiting"]) {
    assert.equal(parseFenceLabel(`${name} qst_ab12cd34`), null, name)
  }
})

test("consecutive labelled fences become one block with a tab each", () => {
  forgetCodeTabs()
  const html = render([fence("bash npm", "npm install frizz"), "", fence("bash pnpm", "pnpm add frizz"), "", fence("bash yarn", "yarn add frizz")].join("\n"))
  assert.equal(count(html, `class="md-code md-code-frame md-code-tabs"`), 1)
  assert.equal(count(html, `class="md-code-copy"`), 1, "one copy button for the group")
  assert.match(html, /<span class="md-code-tablist" role="tablist"><button type="button" class="md-code-tab is-active" role="tab" aria-selected="true">npm<\/button><button type="button" class="md-code-tab" role="tab" aria-selected="false">pnpm<\/button>/)
  assert.equal(count(html, `role="tabpanel"`), 3)
  assert.equal(count(html, `class="md-code-panel is-active"`), 1)
  assert.match(html, /<pre class="md-code-panel is-active" role="tabpanel"><code class="hljs language-bash">/)
  // `<pre>` preserves whitespace: nothing may stand between the header, the panels and the button.
  assert.match(html, /<\/span><pre class="md-code-panel is-active"/)
  assert.match(html, /<\/code><\/pre><pre class="md-code-panel"/)
  assert.match(html, /<\/code><\/pre><button type="button" class="md-code-copy"/)
})

test("fences with no blank line between them group too", () => {
  const html = render(`${fence("ts a.ts", "1")}\n${fence("ts b.ts", "2")}`)
  assert.equal(count(html, `role="tab"`), 2)
})

test("unlabelled neighbours stay separate blocks", () => {
  const html = render([fence("bash", "npm test"), "", fence("json", `{"ok": true}`)].join("\n"))
  assert.equal(count(html, "md-code-tabs"), 0)
  assert.equal(count(html, `<span class="md-code">`), 2)
})

test("prose between two labelled fences keeps them apart", () => {
  const html = render([fence("bash npm", "npm i"), "", "or, with pnpm:", "", fence("bash pnpm", "pnpm i")].join("\n"))
  assert.equal(count(html, "md-code-tabs"), 0)
  assert.equal(count(html, `<span class="md-code">`), 2)
})

test("an unlabelled fence ends a run and stays plain", () => {
  const html = render([fence("ts a.ts", "1"), fence("ts b.ts", "2"), fence("ts", "3"), fence("ts c.ts", "4")].join("\n\n"))
  assert.equal(count(html, `role="tab"`), 2, "a.ts and b.ts are the only tabs")
  assert.equal(count(html, `<span class="md-code">`), 1, "the unlabelled block")
  assert.equal(count(html, `class="md-code-title"`), 1, "c.ts stands alone, as a titled block")
})

test("a lone fence is titled only by an explicit label or a file name", () => {
  assert.match(render(fence(`ts title="Server entry"`, "x")), /<span class="md-code-tablist"><span class="md-code-title">Server entry<\/span><\/span><pre class="md-code-panel is-active"><code/)
  assert.match(render(fence("ts src/server.ts", "x")), /<span class="md-code-title">src\/server\.ts<\/span>/)
  // No tab roles on a title: there is no choice to announce.
  assert.doesNotMatch(render(fence("ts src/server.ts", "x")), /role=/)
  // Loose words after a language are not a title on their own…
  assert.match(render(fence("bash npm", "npm i")), /^<span class="md-code"><pre>/)
  // …and the block renders exactly as it did before labels existed.
  assert.equal(render(fence("bash npm", "npm i")), render(fence("bash", "npm i")))
})

test("a label names the language when the fence declares none", () => {
  assert.match(render(fence(`title="server.ts"`, "const a: number = 1")), /language-typescript/)
  assert.match(render(fence(`text title="out.json"`, "{}")), /language-plaintext/, "a declared language wins")
})

test("tabs group inside a list item and a blockquote", () => {
  const item = ["1. Install it:", "", "   ```bash npm", "   npm i", "   ```", "", "   ```bash pnpm", "   pnpm i", "   ```", "2. Run it."].join("\n")
  const inList = render(item)
  assert.equal(count(inList, `role="tab"`), 2)
  assert.match(inList, /<li><p>Install it:<\/p>\s*<span class="md-code md-code-frame md-code-tabs">[\s\S]*<\/span>\s*<\/li>\s*<li><p>Run it\.<\/p>/)
  const quoted = render(["> ```bash npm", "> npm i", "> ```", ">", "> ```bash pnpm", "> pnpm i", "> ```"].join("\n"))
  assert.match(quoted, /<blockquote>\s*<span class="md-code md-code-frame md-code-tabs">/)
  assert.equal(count(quoted, `role="tab"`), 2)
})

test("a still-streaming last fence is already a tab", () => {
  const html = render(`${fence("bash npm", "npm i")}\n\n\`\`\`bash pnpm\npnpm a`)
  assert.equal(count(html, `role="tab"`), 2)
})

test("labels and code are escaped, never markup", () => {
  const html = render([fence(`ts title="<img src=x onerror=1>"`, "</code><script>1</script>"), fence(`ts title="b"`, "2")].join("\n"))
  assert.ok(!html.includes("<img"))
  assert.ok(!html.includes("<script"))
  assert.ok(html.includes("&lt;img src=x onerror=1&gt;</button>"))
})

test("a long label carries its full text as a tooltip, a short one does not", () => {
  const long = "packages/web/src/components/QuestionBlockCard.tsx"
  const html = renderCodeBlock([
    { label: long, info: `tsx title="${long}"`, text: "x", closed: true },
    { label: "b.ts", info: "ts b.ts", text: "y", closed: true },
  ])
  assert.ok(html.includes(`title="${long}">${long}</button>`))
  assert.ok(html.includes(`aria-selected="false">b.ts</button>`))
})

test("the tab last chosen for a set of labels is the one a new render opens on", () => {
  forgetCodeTabs()
  const md = [fence("bash npm", "npm i"), fence("bash pnpm", "pnpm i")].join("\n\n")
  rememberCodeTab(["npm", "pnpm"], "pnpm")
  const html = render(md)
  assert.match(html, /class="md-code-tab is-active" role="tab" aria-selected="true">pnpm</)
  assert.match(html, /<pre class="md-code-panel" role="tabpanel">[\s\S]*npm i[\s\S]*<pre class="md-code-panel is-active" role="tabpanel">[\s\S]*pnpm i/)
  // A different set of labels is a different group: it opens on its first tab.
  assert.match(render([fence("bash npm", "1"), fence("bash yarn", "2")].join("\n\n")), /is-active" role="tab" aria-selected="true">npm</)
  // A remembered label that is no longer in the set falls back to the first tab.
  rememberCodeTab(["npm", "pnpm"], "bun")
  assert.match(render(md), /is-active" role="tab" aria-selected="true">npm</)
  forgetCodeTabs()
})
