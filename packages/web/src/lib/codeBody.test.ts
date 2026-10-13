import assert from "node:assert/strict"
import test from "node:test"
import { renderCodeBody, splitHighlightedLines } from "./codeBody.ts"

// The one invariant every surface depends on: a highlighted body must carry the SAME TEXT as the
// plain string it replaced. These blocks wrap, clamp at a line count, and are selected and copied out
// of, so a renderer that dropped or added a character would corrupt all three.
const textOf = (html: string) =>
  html
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")

test("a highlighted body reproduces its source text exactly", () => {
  const source = 'const x = "a & b" // <not a tag>\nif (x) return\n'
  assert.equal(textOf(renderCodeBody(source, "typescript")), source)
})

test("plaintext escapes rather than highlights, and never emits markup", () => {
  const html = renderCodeBody(`</pre><img src=x onerror="boom">`, "plaintext")
  assert.ok(!html.includes("<img"))
  assert.ok(!html.includes("</pre>"))
  assert.equal(textOf(html), `</pre><img src=x onerror="boom">`)
})

// A block comment or a template literal is ONE hljs span containing newlines. Splitting the fragment
// naively leaves that span open, so the browser's parser adopts the rest of the file into it and the
// whole excerpt below the comment paints as a comment.
test("a token spanning newlines is closed and re-opened at every line break", () => {
  const lines = splitHighlightedLines('<span class="hljs-comment">/* one\ntwo\nthree */</span>;')
  assert.equal(lines.length, 3)
  for (const line of lines) {
    assert.equal(line.match(/<span/g)?.length, line.match(/<\/span>/g)?.length)
  }
  assert.match(lines[1], /^<span class="hljs-comment">two<\/span>$/)
  assert.match(lines[2], /^<span class="hljs-comment">three \*\/<\/span>;$/)
})

test("splitting preserves text through nested spans and empty lines", () => {
  const html = '<span class="a">x<span class="b">y</span></span>\n\n<span class="c">z</span>'
  const lines = splitHighlightedLines(html)
  assert.deepEqual(lines.map(textOf), ["xy", "", "z"])
})

// Claude's Read tool returns `cat -n` output. The gutter has to come off before the grammar sees it,
// or every line opens with a stray integer.
test("a cat -n excerpt highlights its source and keeps its line numbers as gutter spans", () => {
  const excerpt = "     1\tconst x = 1\n     2\t\n     3\tif (x) return\n"
  const html = renderCodeBody(excerpt, "typescript")
  assert.equal(textOf(html), excerpt)
  assert.equal(html.match(/ntwine-code-gutter/g)?.length, 3)
  // The number is inside the gutter span; the source beside it is highlighted, so `const` is a token
  // rather than part of the same run.
  assert.match(html, /<span class="ntwine-code-gutter">     1\t<\/span><span class="hljs-keyword">const<\/span>/)
})

test("a cat -n excerpt keeps multi-line constructs correct across its numbered lines", () => {
  const html = renderCodeBody("     1\t/* open\n     2\tstill comment */\n     3\tdone\n", "typescript")
  // Line 2's source is inside the comment, so it must carry the comment class — which only holds if
  // the excerpt was highlighted as ONE text rather than line by line.
  const line2 = html.split("\n")[1]
  assert.match(line2, /hljs-comment/)
  assert.match(line2, /^<span class="ntwine-code-gutter">     2\t<\/span>/)
})

// Caught on the real wire, not in theory: a seeded excerpt ending on a blank source line arrived as
// "    14" with its tab trimmed. Demanding a tab on every line turned highlighting off for that whole
// card, and the unit tests above — which build their own perfectly-formed input — could not see it.
test("a numbered line whose trailing tab was trimmed does not disable the whole excerpt", () => {
  const excerpt = "     1\tconst x = 1\n     2\tif (x) return\n    3"
  const html = renderCodeBody(excerpt, "typescript")
  assert.equal(textOf(html), excerpt)
  assert.equal(html.match(/ntwine-code-gutter/g)?.length, 3)
  assert.match(html, /hljs-keyword/)
})

// The other half of that tolerance: a file whose every line IS a bare number must not be read as
// nothing but line numbers. At least one real tabbed prefix has to be present.
test("a file of bare numbers is not mistaken for a numbered excerpt", () => {
  const html = renderCodeBody("101\n202\n303\n", "plaintext")
  assert.ok(!html.includes("ntwine-code-gutter"))
})

// A tool result that merely mentions a numbered line must not have its prose eaten as gutters.
test("prose that only looks numbered in places is not treated as an excerpt", () => {
  const prose = "1\tfirst\nthis line has no number\n3\tthird"
  const html = renderCodeBody(prose, "plaintext")
  assert.ok(!html.includes("ntwine-code-gutter"))
  assert.equal(textOf(html), prose)
})

test("an unnumbered body highlights normally", () => {
  const html = renderCodeBody("echo hi\n", "bash")
  assert.ok(!html.includes("ntwine-code-gutter"))
  assert.match(html, /hljs-built_in|hljs-keyword|echo/)
})
