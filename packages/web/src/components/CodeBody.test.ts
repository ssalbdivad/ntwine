import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { CodeBody } from "./CodeBody.tsx"

// CodeBody is a drop-in for a raw `<pre>{text}</pre>`, and its whole promise to the surfaces that use
// it is that nothing about that `<pre>` changes except the colour of what is inside. These pin the
// three parts of that promise a caller would otherwise have to re-verify: the element, the className
// it was handed, and any attribute (a `data-*` test hook) riding along.

test("the surface's own className and attributes survive, with hljs added", () => {
  const html = renderToStaticMarkup(
    createElement(CodeBody, { text: "echo hi", language: "bash", className: "ntwine-bash-body ntwine-bash-clamp", "data-probe": "x" } as never),
  )
  assert.match(html, /^<pre/)
  assert.match(html, /class="hljs ntwine-bash-body ntwine-bash-clamp"/)
  assert.match(html, /data-probe="x"/)
})

test("the rendered text is the source text, so wrapping, selection and copy are unchanged", () => {
  const source = 'for f in *.ts; do echo "$f"; done'
  const html = renderToStaticMarkup(createElement(CodeBody, { text: source, language: "bash" }))
  const inner = html.replace(/^<pre[^>]*>/, "").replace(/<\/pre>$/, "")
  const text = inner.replace(/<[^>]*>/g, "").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
  assert.equal(text, source)
  assert.match(inner, /hljs-keyword/)
})

// The background-shell drawer renders this for a real command and a PLAIN `<pre>` for its "command
// unavailable" fallback, off one shared className. This is the case that would regress silently: a
// sentence painted in shell grammar reads as though the words were a script.
test("plaintext adds no token markup at all", () => {
  const html = renderToStaticMarkup(
    createElement(CodeBody, { text: "Command unavailable for this background operation.", language: "plaintext" }),
  )
  assert.ok(!html.includes("<span"))
  assert.match(html, />Command unavailable for this background operation\.<\/pre>$/)
})
