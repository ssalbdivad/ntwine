import { test } from "node:test"
import assert from "node:assert/strict"
import { errorPage, escapeHtml, loadingPage, projectPickerPage } from "./pages.ts"

const html = (dataUrl: string) => decodeURIComponent(dataUrl.slice(dataUrl.indexOf(",") + 1))

test("launcher output is shown as text, never as markup", () => {
  assert.equal(escapeHtml(`<img src=x onerror="a">&'`), "&#60;img src=x onerror=&#34;a&#34;&#62;&#38;&#39;")
  const page = html(errorPage({ message: "<script>boom()</script>", logPath: "/tmp/<log>" }))
  assert.equal(page.includes("<script>boom"), false)
  assert.ok(page.includes("&#60;script&#62;boom()"))
  assert.ok(html(loadingPage("<b>")).includes("&#60;b&#62;"))
})

test("a failure offers a retry; the first run offers a folder, not a failure", () => {
  assert.ok(html(errorPage({ message: "x" })).includes("frizzDesktop.retry()"))
  const picker = html(projectPickerPage())
  assert.ok(picker.includes("frizzDesktop.chooseProject()"))
  assert.equal(picker.includes("could not start"), false)
})
