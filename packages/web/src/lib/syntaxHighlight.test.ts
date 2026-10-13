import assert from "node:assert/strict"
import test from "node:test"
import {
  renderHighlightedCode,
  resolveFenceLanguage,
  resolveFileLanguage,
  SUPPORTED_FENCE_LANGUAGES,
} from "./syntaxHighlight.ts"

test("first-cut fenced language set stays explicit and bundle-bounded", () => {
  assert.deepEqual(Object.keys(SUPPORTED_FENCE_LANGUAGES), [
    "bash", "css", "diff", "javascript", "json", "markdown",
    "python", "rust", "sql", "typescript", "xml", "yaml",
  ])
})

test("fence aliases resolve without guessing unknown languages", () => {
  assert.equal(resolveFenceLanguage("ts title=worker.ts"), "typescript")
  assert.equal(resolveFenceLanguage("JSX"), "javascript")
  assert.equal(resolveFenceLanguage("shell"), "bash")
  assert.equal(resolveFenceLanguage("rs"), "rust")
  assert.equal(resolveFenceLanguage("py"), "python")
  assert.equal(resolveFenceLanguage("yml"), "yaml")
  assert.equal(resolveFenceLanguage("totally-made-up"), "plaintext")
  assert.equal(resolveFenceLanguage(), "plaintext")
})

// A Read card highlights by the PATH in its header rather than a declared fence, so the two resolvers
// have to agree about what a `.ts` file is. They share one alias table for exactly that reason.
test("file paths resolve to the same grammars fences do", () => {
  assert.equal(resolveFileLanguage("/repo/packages/web/src/App.tsx"), "typescript")
  assert.equal(resolveFileLanguage("scripts/shot.mjs"), "javascript")
  assert.equal(resolveFileLanguage(".github/workflows/ci.yml"), "yaml")
  assert.equal(resolveFileLanguage("a/b/index.HTML"), "xml")
  assert.equal(resolveFileLanguage("styles.scss"), "css")
  assert.equal(resolveFileLanguage("README.md"), "markdown")
  assert.equal(resolveFileLanguage("C:\\repo\\main.py"), "python")
})

test("extensionless and unrecognized files stay plaintext rather than guess", () => {
  assert.equal(resolveFileLanguage("Dockerfile"), "bash")
  assert.equal(resolveFileLanguage("/home/me/.zshrc"), "bash")
  assert.equal(resolveFileLanguage("LICENSE"), "plaintext")
  assert.equal(resolveFileLanguage("build/output.bin"), "plaintext")
  assert.equal(resolveFileLanguage("src/main.go"), "plaintext")
  assert.equal(resolveFileLanguage(), "plaintext")
  assert.equal(resolveFileLanguage(""), "plaintext")
  assert.equal(resolveFileLanguage("/some/dir/"), "plaintext")
})

test("declared languages highlight multiline source and preserve whitespace", () => {
  const html = renderHighlightedCode("const answer: number = 42\n\tconsole.log(answer)\n", "ts")
  assert.match(html, /^<span class="md-code"><pre><code class="hljs language-typescript">/)
  assert.match(html, /hljs-keyword/)
  assert.match(html, /\n\t<span class="hljs-variable language_">console<\/span>/)
  assert.match(html, /\n<\/code><\/pre>/)
})

// `<pre>` preserves whitespace, so the copy button may not be separated from the code by so much as a
// newline — one would print as a blank first line in every fenced block in the app.
test("every fenced block carries a copy button, and no stray whitespace inside the pre", () => {
  const html = renderHighlightedCode("echo hi\n", "bash")
  assert.match(html, /<\/code><\/pre><button type="button" class="md-code-copy" title="Copy code"><\/button><\/span>\n$/)
  assert.equal(html.match(/<pre>([\s\S]*)<\/pre>/)?.[1].startsWith("<code"), true)
})

test("unknown and missing languages are escaped plaintext, never executable markup", () => {
  const malicious = `</code><img src=x onerror="globalThis.pwned = true">&'`
  for (const language of [undefined, "text", "brainfuck-but-not-enabled"]) {
    const html = renderHighlightedCode(malicious, language)
    assert.match(html, /class="hljs language-plaintext"/)
    assert.ok(!html.includes("<img"))
    assert.ok(html.includes("&lt;/code&gt;&lt;img src=x onerror=&quot;"))
    assert.ok(html.includes("&amp;&#39;"))
  }
})

test("a lightbox fence keeps its name on the block, escaped as plain text", () => {
  const html = renderHighlightedCode("/tmp/a <b>.png  Before\n", " Lightbox ")
  assert.match(html, /<code class="hljs language-lightbox">\/tmp\/a &lt;b&gt;\.png  Before\n<\/code>/)
  // Only the bare name: an info string with more words is an ordinary unknown language.
  assert.match(renderHighlightedCode("x\n", "lightbox extra"), /class="hljs language-plaintext"/)
})

test("a mermaid fence keeps its name on the block too, whatever its case, and only as the whole info string", () => {
  const html = renderHighlightedCode("flowchart LR\n  A --> B\n", " Mermaid ")
  assert.match(html, /<code class="hljs language-mermaid">flowchart LR\n  A --&gt; B\n<\/code>/)
  assert.match(renderHighlightedCode("x\n", "mermaid title=flow"), /class="hljs language-plaintext"/)
  assert.match(renderHighlightedCode("x\n", "mermaidjs"), /class="hljs language-plaintext"/)
})

test("long lines remain intact for the surface CSS to scroll or wrap", () => {
  const longToken = "x".repeat(1_024)
  const html = renderHighlightedCode(longToken, "plaintext")
  assert.equal(html.match(/<code[^>]*>([\s\S]*)<\/code>/)?.[1], `${longToken}\n`)
})
