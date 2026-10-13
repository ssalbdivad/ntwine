import { test } from "node:test"
import assert from "node:assert/strict"
import { Marked } from "marked"
import { MARKDOWN_OPTIONS } from "./markdown.ts"
import { calloutKind } from "./callouts.ts"

// The app's real marked configuration under BOTH line-break rules, as markdown.test.ts drives it: chat
// prose renders with `breaks: true`, a document with `breaks: false`, and where a callout's marker line
// ends is the one thing the two tokenize differently. The sanitizer needs a DOM and is read back in the
// browser (mdBlocks.e2e.test.ts); detection and markup are pure.
const chat = new Marked(MARKDOWN_OPTIONS)
const doc = new Marked({ ...MARKDOWN_OPTIONS, breaks: false })
const render = (md: string, marked = chat) => (marked.parse(md, { async: false }) as string).trim()
const both = (md: string) => [render(md, chat), render(md, doc)] as const
const count = (html: string, needle: string) => html.split(needle).length - 1

test("each of the five types becomes a callout with its own class and default title", () => {
  const titles = { NOTE: "Note", TIP: "Tip", IMPORTANT: "Important", WARNING: "Warning", CAUTION: "Caution" }
  for (const [type, title] of Object.entries(titles)) {
    for (const html of both(`> [!${type}]\n> Body text.`)) {
      assert.equal(html,
        `<blockquote class="md-callout md-callout-${type.toLowerCase()}"><p class="md-callout-title">${title}</p>\n`
        + `<p>Body text.</p>\n</blockquote>`, type)
    }
  }
})

test("the type is case-insensitive, and an alias is its type in every respect", () => {
  assert.equal(calloutKind("Warning"), "warning")
  assert.equal(calloutKind("wArNiNg"), "warning")
  const aliases = { info: "note", hint: "tip", attention: "warning", danger: "caution", error: "caution" }
  for (const [alias, kind] of Object.entries(aliases)) {
    assert.equal(calloutKind(alias), kind)
    assert.equal(render(`> [!${alias}]\n> x`), render(`> [!${kind}]\n> x`), alias)
  }
  assert.match(render("> [!note]\n> x"), /^<blockquote class="md-callout md-callout-note"><p class="md-callout-title">Note<\/p>/)
  // An inherited property name is not a type.
  for (const word of ["constructor", "toString", "hasOwnProperty"]) assert.equal(calloutKind(word), null, word)
})

test("text after the marker on its line is the title, with its inline Markdown", () => {
  for (const html of both("> [!WARNING] Before you merge\n> This rewrites history on `main`.")) {
    assert.equal(html,
      `<blockquote class="md-callout md-callout-warning"><p class="md-callout-title">Before you merge</p>\n`
      + `<p>This rewrites history on <code>main</code>.</p>\n</blockquote>`)
  }
  for (const html of both("> [!TIP] Use `nub`, *not* node\n> body")) {
    assert.match(html, /<p class="md-callout-title">Use <code>nub<\/code>, <em>not<\/em> node<\/p>\n<p>body<\/p>/)
  }
  // A title and nothing else: the whole quote is one line.
  for (const html of both("> [!NOTE] Just a heading")) {
    assert.equal(html, `<blockquote class="md-callout md-callout-note"><p class="md-callout-title">Just a heading</p>\n</blockquote>`)
  }
})

test("raw HTML in a title is shown as typed, never minted", () => {
  for (const html of both("> [!NOTE] <img src=x onerror=alert(1)> and <b>bold</b>\n> body")) {
    assert.match(html, /<p class="md-callout-title">&lt;img src=x onerror=alert\(1\)&gt; and &lt;b&gt;bold&lt;\/b&gt;<\/p>/)
    assert.equal(count(html, "<img"), 0)
    assert.equal(count(html, "<b>"), 0)
  }
  // Nested in emphasis too: the escape reaches every level of the title's tokens.
  for (const html of both("> [!NOTE] *see <script>x</script>*\n> body")) {
    assert.equal(count(html, "<script"), 0)
    assert.match(html, /<em>see &lt;script&gt;x&lt;\/script&gt;<\/em>/)
  }
  // The BODY is ordinary Markdown: its HTML passes through to the sanitizer like any paragraph's.
  assert.match(render("> [!NOTE]\n> x<sup>2</sup>"), /<p>x<sup>2<\/sup><\/p>/)
})

test("a callout may have no body, and a body may be any blocks", () => {
  for (const html of both("> [!IMPORTANT]")) {
    assert.equal(html, `<blockquote class="md-callout md-callout-important"><p class="md-callout-title">Important</p>\n</blockquote>`)
  }
  const md = ["> [!CAUTION]", "> First paragraph.", ">", "> - one", "> - two", ">", "> ```sh", "> rm -rf build", "> ```", ">", "> Last."].join("\n")
  for (const html of both(md)) {
    assert.match(html, /^<blockquote class="md-callout md-callout-caution"><p class="md-callout-title">Caution<\/p>\n<p>First paragraph\.<\/p>\n<ul>\n<li>one<\/li>\n<li>two<\/li>\n<\/ul>/)
    assert.equal(count(html, `class="md-code"`), 1)
    assert.match(html, /<p>Last\.<\/p>\n<\/blockquote>$/)
  }
  // The body can open with a block that is not a paragraph at all.
  for (const html of both("> [!TIP]\n>\n> - only a list")) {
    assert.match(html, /<p class="md-callout-title">Tip<\/p>\n<ul>\n<li>only a list<\/li>\n<\/ul>\n<\/blockquote>$/)
  }
})

test("the first body line keeps everything the author wrote after the marker line", () => {
  // Under `breaks: true` the body's own line breaks stay hard; in a document they stay soft.
  const md = "> [!NOTE]\n> line one\n> line two"
  assert.match(render(md, chat), /<p class="md-callout-title">Note<\/p>\n<p>line one<br>line two<\/p>/)
  assert.match(render(md, doc), /<p class="md-callout-title">Note<\/p>\n<p>line one\nline two<\/p>/)
  // A hard break after the marker (two trailing spaces) ends the title line under either rule.
  for (const html of both("> [!NOTE]  \n> body")) assert.match(html, /<p class="md-callout-title">Note<\/p>\n<p>body<\/p>/)
  // An inline span that runs past the title line is not cut in two: it goes to the body whole.
  for (const html of both("> [!NOTE] Mind *the\n> gap* here")) {
    assert.match(html, /<p class="md-callout-title">Mind<\/p>\n<p><em>the(?:<br>|\n)gap<\/em> here<\/p>/)
  }
})

test("an unknown type leaves the blockquote exactly as it was", () => {
  for (const marked of [chat, doc]) {
    const plain = new Marked({ ...MARKDOWN_OPTIONS, breaks: marked === chat, hooks: undefined })
    for (const md of ["> [!sic]\n> quoted", "> [!QUESTION] Why?\n> body", "> [!]\n> x", "> [!NOTE WELL]\n> x", "> [!note-2]\n> x"]) {
      const html = render(md, marked)
      assert.equal(count(html, "md-callout"), 0, md)
      assert.equal(html, render(md, plain), md)
    }
  }
})

test("the marker counts only at the very start of the quote's first paragraph", () => {
  const untouched = [
    "> See [!NOTE] below\n> x", // mid-line
    "> Intro line\n> [!NOTE]\n> x", // second line of the first paragraph
    "> First paragraph.\n>\n> [!NOTE]\n> x", // second paragraph
    "> [!NOTE]suffix\n> x", // no gap after the bracket
    "> \\[!NOTE]\n> x", // escaped
    "> # [!NOTE]\n> x", // a heading, not a paragraph
    "> - [!NOTE]\n>   x", // inside a list in the quote
    "[!NOTE]\nnot a quote at all",
    "Mid-paragraph [!WARNING] stays literal.",
  ]
  for (const md of untouched) for (const html of both(md)) assert.equal(count(html, "md-callout"), 0, md)
  // A marker defined as a link reference is a link, which is the author's call.
  for (const html of both("> [!NOTE]\n> x\n\n[!NOTE]: https://example.com")) assert.equal(count(html, "md-callout"), 0)
})

test("a marker inside code stays literal", () => {
  for (const html of both("```md\n> [!NOTE]\n> How to write one.\n```")) {
    assert.equal(count(html, "md-callout"), 0)
    assert.match(html, /\[!NOTE\]/)
  }
  for (const html of both("> `[!NOTE]`\n> x")) {
    assert.equal(count(html, "md-callout"), 0)
    assert.match(html, /<code>\[!NOTE\]<\/code>/)
  }
  // …including a fenced example INSIDE a real callout's body.
  for (const html of both("> [!TIP]\n> Write it like this:\n>\n> ```md\n> > [!WARNING]\n> ```")) {
    assert.equal(count(html, "md-callout-tip"), 1)
    assert.equal(count(html, "md-callout-warning"), 0)
  }
})

test("a callout is found inside a list item, a blockquote and another callout", () => {
  for (const html of both("1. Rebase onto `main`.\n\n   > [!WARNING]\n   > Force-push only your own branch.\n2. Push.")) {
    assert.match(html, /<li><p>Rebase onto <code>main<\/code>\.<\/p>\n<blockquote class="md-callout md-callout-warning"><p class="md-callout-title">Warning<\/p>\n<p>Force-push only your own branch\.<\/p>\n<\/blockquote>\n<\/li>/)
  }
  for (const html of both("> Quoted reply:\n>\n> > [!NOTE]\n> > Inner.")) {
    assert.match(html, /^<blockquote>\n<p>Quoted reply:<\/p>\n<blockquote class="md-callout md-callout-note">/)
  }
  for (const html of both("> [!IMPORTANT]\n> Outer.\n>\n> > [!TIP]\n> > Inner.")) {
    assert.equal(count(html, "md-callout-important"), 1)
    assert.equal(count(html, "md-callout-tip"), 1)
    assert.match(html, /<p>Outer\.<\/p>\n<blockquote class="md-callout md-callout-tip">/)
  }
})

test("the rest of the pipeline still reaches a callout's body", () => {
  // A task list (walkTokens), a labelled-fence tab group (the hook's grouping) and a headerless table.
  const md = ["> [!NOTE]", "> - [x] done", "> - [/] doing", ">", "> ```bash npm", "> npm i", "> ```", ">", "> ```bash pnpm", "> pnpm add", "> ```"].join("\n")
  for (const html of both(md)) {
    assert.equal(count(html, `class="md-task md-task-checked"`), 1)
    assert.equal(count(html, `class="md-task md-task-in-progress"`), 1)
    assert.equal(count(html, `role="tab"`), 2)
  }
})

test("a plain blockquote is untouched", () => {
  for (const html of both("> Just a quote.\n> Second line.")) {
    assert.match(html, /^<blockquote>\n<p>Just a quote\./)
    assert.equal(count(html, "md-callout"), 0)
  }
})
