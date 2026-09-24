import { test } from "node:test"
import assert from "node:assert/strict"
import { errorPage, escapeHtml, loadingPage } from "./pages.ts"

const html = (dataUrl: string) => decodeURIComponent(dataUrl.slice(dataUrl.indexOf(",") + 1))

test("launcher output is shown as text, never as markup", () => {
  assert.equal(escapeHtml(`<img src=x onerror="a">&'`), "&#60;img src=x onerror=&#34;a&#34;&#62;&#38;&#39;")
  const page = html(errorPage({ message: "<script>boom()</script>", logPath: "/tmp/<log>", needsProject: false }))
  assert.equal(page.includes("<script>boom"), false)
  assert.ok(page.includes("&#60;script&#62;boom()"))
  assert.ok(html(loadingPage("<b>")).includes("&#60;b&#62;"))
})

test("the folder picker is offered only when the launcher asked for a project", () => {
  assert.ok(html(errorPage({ message: "x", needsProject: true })).includes("chooseProject()"))
  assert.equal(html(errorPage({ message: "x", needsProject: false })).includes("chooseProject()"), false)
  assert.ok(html(errorPage({ message: "x", needsProject: false })).includes("retry()"))
})
