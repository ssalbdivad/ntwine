import { test } from "node:test"
import assert from "node:assert/strict"
import { renderDiff, type DiffLine } from "./index.ts"
import { diffLines } from "./diff.ts"
import { highlightLines } from "./highlight.ts"
import { detectLang } from "./lang.ts"

const flat = (d: ReturnType<typeof renderDiff>): DiffLine[] => d.hunks.flatMap((h) => h.lines)
const kinds = (line: string, lang: string) => highlightLines(line, lang)[0].map((t) => `${t.kind}:${t.text}`)

// ---- diffLines (the core aligner) ----

test("identical inputs → all eq ops", () => {
  const ops = diffLines(["a", "b", "c"], ["a", "b", "c"])
  assert.deepEqual(ops.map((o) => o.type), ["eq", "eq", "eq"])
})

test("a single changed middle line → del then add", () => {
  const ops = diffLines(["a", "b", "c"], ["a", "B", "c"])
  assert.deepEqual(ops.map((o) => o.type), ["eq", "del", "add", "eq"])
})

test("pure insertion keeps common prefix/suffix as eq", () => {
  const ops = diffLines(["a", "c"], ["a", "b", "c"])
  assert.deepEqual(ops.map((o) => o.type), ["eq", "add", "eq"])
})

// ---- renderDiff status + counts ----

test("Write (old empty) → added, every line an add, one hunk", () => {
  const d = renderDiff("", "line1\nline2", "new.ts")
  assert.equal(d.status, "added")
  assert.equal(d.additions, 2)
  assert.equal(d.deletions, 0)
  assert.equal(d.hunks.length, 1)
  assert.ok(flat(d).every((l) => l.type === "add"))
})

test("emptied file → deleted", () => {
  const d = renderDiff("gone\naway", "", "x.ts")
  assert.equal(d.status, "deleted")
  assert.equal(d.deletions, 2)
  assert.ok(flat(d).every((l) => l.type === "del"))
})

test("modified file → correct add/del counts and 1-based line numbers", () => {
  const old = "const a = 1\nconst b = 2\nconst c = 3"
  const next = "const a = 1\nconst b = 22\nconst c = 3"
  const d = renderDiff(old, next, "src/x.ts")
  assert.equal(d.status, "modified")
  assert.equal(d.additions, 1)
  assert.equal(d.deletions, 1)
  const del = flat(d).find((l) => l.type === "del")!
  const add = flat(d).find((l) => l.type === "add")!
  assert.equal(del.oldLine, 2)
  assert.equal(del.newLine, null)
  assert.equal(add.newLine, 2)
  assert.equal(add.oldLine, null)
})

test("far-apart changes split into multiple hunks with collapsed context", () => {
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`)
  const old = lines.join("\n")
  const changed = [...lines]
  changed[2] = "line 2 CHANGED"
  changed[35] = "line 35 CHANGED"
  const d = renderDiff(old, changed.join("\n"), "big.ts")
  assert.equal(d.hunks.length, 2)
  // The gap between hunk 1 and hunk 2 is collapsed, so total rendered lines << 40.
  assert.ok(flat(d).length < 20)
  assert.ok(d.hunks[1].collapsedBefore > 0)
})

// ---- highlighter ----

test("detectLang maps by extension and known filenames", () => {
  assert.equal(detectLang("src/foo.ts"), "typescript")
  assert.equal(detectLang("a/b/style.css"), "css")
  assert.equal(detectLang("Dockerfile"), "shell")
  assert.equal(detectLang("data.bin"), "text")
  assert.equal(detectLang(".github/workflows/ci.yml"), "yaml")
  assert.equal(detectLang("page.html"), "html")
})

// The map used to name grammars the tokenizer had no entry for (.yaml, .toml, .md, .html), which
// rendered those files with no colour and no way to tell that from "nothing to colour". detectLang
// now answers only with ids highlightLines can actually serve, so the pair cannot drift apart again.
test("detectLang never names a language the tokenizer cannot highlight", () => {
  for (const path of ["a.ts", "a.yml", "a.toml", "a.html", "a.md", "a.go", "a.unknown", "Makefile"]) {
    const lang = detectLang(path)
    if (lang === "text") continue
    const lines = highlightLines("x", lang)
    assert.ok(lines[0]?.length, `detectLang("${path}") → "${lang}", which highlightLines does not know`)
  }
})

test("markdown stays deliberately plain rather than half-highlighted", () => {
  assert.equal(detectLang("README.md"), "text")
})

test("yaml colours its keys, comments and scalars", () => {
  const k = kinds("  retries: 3 # how many", "yaml")
  assert.ok(k.includes("key:retries"), `expected a key in ${k.join(",")}`)
  assert.ok(k.includes("num:3"), `expected a number in ${k.join(",")}`)
  assert.ok(k.some((t) => t.startsWith("com:# how many")), `expected a comment in ${k.join(",")}`)
})

// A colon inside a VALUE is not a second key — the key rule only fires at a line start, and this is
// the case that proves it (a bare `url: https://x` would otherwise paint `https` as a key too).
test("yaml does not mistake a colon inside a value for a key", () => {
  const k = kinds("url: https://example.com", "yaml")
  assert.equal(k.filter((t) => t.startsWith("key:")).length, 1)
  assert.ok(k.includes("key:url"))
})

test("yaml reads a key under a sequence marker", () => {
  assert.ok(kinds("  - name: build", "yaml").includes("key:name"))
})

test("toml colours table headers and keys", () => {
  assert.ok(kinds("[tool.ntwine]", "toml").includes("fn:[tool.ntwine]"))
  assert.ok(kinds('port = 8080', "toml").includes("key:port"))
})

test("html colours element names, attributes and comments", () => {
  const k = kinds('<a href="/x">hi</a>', "html")
  assert.ok(k.includes("kw:a"), `expected a tag name in ${k.join(",")}`)
  assert.ok(k.includes("key:href"), `expected an attribute in ${k.join(",")}`)
  assert.ok(k.some((t) => t === 'str:"/x"'), `expected an attribute value in ${k.join(",")}`)
  assert.ok(kinds("<!-- note -->", "html")[0].startsWith("com:"))
})

// Every new grammar has to keep the aligner's contract: one token array per source line, and the
// tokens of a line concatenating back to that exact line.
test("the added grammars stay 1:1 with their source lines and lose no text", () => {
  const samples: Array<[string, string]> = [
    ["yaml", "on:\n  push:\n    branches: [main]\n\n# trailing"],
    ["toml", '[pkg]\nname = "ntwine"\nver = 1'],
    ["html", '<div class="a">\n  <!-- c\n  ontinued -->\n</div>'],
  ]
  for (const [lang, src] of samples) {
    const raw = src.split("\n")
    const lines = highlightLines(src, lang)
    assert.equal(lines.length, raw.length, `${lang} line count`)
    lines.forEach((tokens, i) => assert.equal(tokens.map((t) => t.text).join(""), raw[i], `${lang} line ${i}`))
  }
})

test("highlightLines is 1:1 with source lines and classifies TS tokens", () => {
  const src = 'const x = "hi" // note'
  const lines = highlightLines(src, "typescript")
  assert.equal(lines.length, 1)
  const k = kinds(src, "typescript")
  assert.ok(k.includes("kw:const"), `expected const kw in ${k.join(",")}`)
  assert.ok(k.some((t) => t === 'str:"hi"'), `expected string in ${k.join(",")}`)
  assert.ok(k.some((t) => t.startsWith("com:// note")), `expected comment in ${k.join(",")}`)
})

test("multi-line block comment stays one kind across lines and preserves line count", () => {
  const src = "a\n/* c1\nc2 */\nb"
  const lines = highlightLines(src, "typescript")
  assert.equal(lines.length, 4)
  assert.equal(lines[1][0].kind, "com")
  assert.equal(lines[2][0].kind, "com")
})

test("unknown language → plain, still line-aligned", () => {
  const lines = highlightLines("foo\nbar", "text")
  assert.equal(lines.length, 2)
  assert.deepEqual(lines[0], [{ text: "foo", kind: "plain" }])
})

test("empty text → no lines (aligns with linesOf convention)", () => {
  assert.deepEqual(highlightLines("", "typescript"), [])
})

test("rendered diff tokens reconstruct the original line text", () => {
  const next = "  const total = a + b // sum"
  const d = renderDiff("", next, "m.ts")
  const line = d.hunks[0].lines[0]
  assert.equal(line.tokens.map((t) => t.text).join(""), next)
})
