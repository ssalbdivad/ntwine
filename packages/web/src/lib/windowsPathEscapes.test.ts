import { test } from "node:test"
import assert from "node:assert/strict"
import { Marked } from "marked"
import type { Token } from "marked"
import { restoreWindowsPathEscapes } from "./windowsPathEscapes.ts"

// The pass alone, on a stock marked. markdown.test.ts drives the app's full configuration; this file
// pins the pass without it, so it can also run where the app config's `.tsx` import cannot load.
const marked = new Marked({
  breaks: true,
  hooks: {
    processAllTokens(tokens: Token[]) {
      restoreWindowsPathEscapes(tokens)
      return tokens
    },
  },
})
const inline = (md: string) => marked.parseInline(md, { async: false }) as string
const block = (md: string) => (marked.parse(md, { async: false }) as string).trim()

const PATH = String.raw`D:\Development\CloudIPMSjb\.ntwine\threads\8e51437e\build-gap-7.0.13980-sjb.md`
// marked encodes a backslash in a destination as `%5C`; the sanitizer decodes it back.
const ENCODED = "D:%5CDevelopment%5CCloudIPMSjb%5C.ntwine%5Cthreads%5C8e51437e%5Cbuild-gap-7.0.13980-sjb.md"

// The reported bug (2026-09-18): `CloudIPMSjb\.ntwine` rendered as `CloudIPMSjb.ntwine` — the folder
// and its `.ntwine` child fused — in the link a worker wrote AND in the same path written in prose.
test("a link destination keeps the separator before a dot-directory", () => {
  assert.equal(inline(`[build-gap](${PATH})`), `<a href="${ENCODED}">build-gap</a>`)
  assert.equal(inline(`[build-gap](<${PATH}>)`), `<a href="${ENCODED}">build-gap</a>`)
  assert.equal(inline(`[build-gap](${PATH} "the gap")`), `<a href="${ENCODED}" title="the gap">build-gap</a>`)
  assert.equal(inline(String.raw`![shot](C:\Users\me\.ntwine\shot.png)`),
    `<img src="C:%5CUsers%5Cme%5C.ntwine%5Cshot.png" alt="shot">`)
})

test("a Windows path in prose keeps every separator", () => {
  assert.equal(inline(`see ${PATH} now`), `see ${PATH} now`)
  // Several escapes in one path, and one at the very start of the text.
  assert.equal(inline(String.raw`C:\a\.b\.c\_d`), String.raw`C:\a\.b\.c\_d`)
  // The label of a link is prose too.
  assert.equal(inline(`[${PATH}](${PATH})`), `<a href="${ENCODED}">${PATH}</a>`)
  // In a list item, a table cell and a heading — every inline run the tree holds.
  assert.equal(block(`- at ${PATH}`), `<ul>\n<li>at ${PATH}</li>\n</ul>`)
  assert.equal(block(`# ${PATH}`).replace(/ id="[^"]*"/, ""), `<h1>${PATH}</h1>`)
  assert.match(block(`| a | b |\n|---|---|\n| ${PATH} | x |`), new RegExp(`<td>${PATH.replace(/[\\.]/g, "\\$&")}</td>`))
})

// A dot-directory straight under the drive root: the backslash after the colon is itself the escape,
// so the run holds no separator yet when the escape arrives, and the href has lost it after unescape.
test("a dot-directory at the drive root keeps its separator", () => {
  assert.equal(inline(String.raw`see C:\.ntwine\x.md now`), String.raw`see C:\.ntwine\x.md now`)
  assert.equal(inline(String.raw`[x](C:\.ntwine\x.md)`), `<a href="C:%5C.ntwine%5Cx.md">x</a>`)
})

// The pass keeps constant-size state per run. Carrying the whole run and re-scanning it per token made
// one long unbroken word quadratic: 80k characters took 13s, where marked alone takes a few ms.
test("a long unbroken word renders in linear time", () => {
  const word = "a".repeat(200_000)
  const started = performance.now()
  assert.equal(inline(`${word} tail \\. x ${word}\\.`), `${word} tail . x ${word}.`)
  assert.ok(performance.now() - started < 1000, `took ${Math.round(performance.now() - started)}ms`)
})

test("an escape outside a Windows path is still an escape", () => {
  assert.equal(inline(String.raw`a \. b`), "a . b")
  assert.equal(inline(String.raw`\*not em\*`), "*not em*")
  // A run broken by whitespace is no longer the path.
  assert.equal(inline(String.raw`C:\a \.b`), String.raw`C:\a .b`)
  // A forward-slash drive path carries no backslash to restore, and a URL scheme is not a drive.
  assert.equal(inline(String.raw`C:/a/.b \. x://h/\.p`), "C:/a/.b . x://h/.p")
  // A doubled backslash is an author writing Markdown on purpose; it renders as one, as before.
  assert.equal(inline(String.raw`C:\\Users\\me\\.ntwine`), String.raw`C:\Users\me\.ntwine`)
  // A POSIX destination is untouched, and so is a Windows one that needed nothing.
  assert.equal(inline("[x](/a/.b)"), `<a href="/a/.b">x</a>`)
  assert.equal(inline(String.raw`[x](C:\a\b.md)`), `<a href="C:%5Ca%5Cb.md">x</a>`)
})

test("code is literal, before and after", () => {
  assert.equal(inline("`" + PATH + "`"), `<code>${PATH}</code>`)
  assert.equal(block("```\n" + PATH + "\n```"), `<pre><code>${PATH}\n</code></pre>`)
})
