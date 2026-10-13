import assert from "node:assert/strict"
import test from "node:test"

const baseUrl = process.env.FRIZZ_MARKDOWN_STRIKETHROUGH_E2E_URL

// The unit tests in markdown.test.ts drive the tokenizer; this drives the whole shipped path —
// mdToHtml/mdInlineToHtml through marked AND the DOM sanitizer — in a real browser. A <del> may only
// come from `~~two tildes~~`; the approximation and home-path tildes agents write must stay prose.
test("only ~~two tildes~~ render strikethrough in the real render path", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const pageErrors: string[] = []
  try {
    const page = await browser.newPage()
    page.on("pageerror", (error) => pageErrors.push(String(error)))
    await page.goto(`${baseUrl}/markdown-strikethrough-fixture.html`, { waitUntil: "domcontentloaded" })
    await page.waitForSelector("[data-case=approx] [data-block]")
    const rendered = await page.$$eval("section[data-case]", (sections) =>
      Object.fromEntries(sections.map((section) => [
        section.getAttribute("data-case"),
        ["block", "inline"].map((mode) => {
          const host = section.querySelector(`[data-${mode}]`)!
          return {
            struck: Array.from(host.querySelectorAll("del")).map((del) => del.textContent),
            text: host.textContent,
          }
        }),
      ])))

    for (const id of ["approx", "paths", "budget", "single"]) {
      for (const [mode, out] of rendered[id].entries()) {
        assert.deepEqual(out.struck, [], `${id}/${mode}: single tildes must not strike`)
        assert.match(out.text, /~/, `${id}/${mode}: the literal tilde must survive`)
      }
    }
    for (const [mode, out] of rendered.double.entries()) {
      assert.deepEqual(out.struck, ["genuinely struck", "a bold strike"], `double/${mode}`)
    }
    for (const [mode, out] of rendered.mixed.entries()) {
      assert.deepEqual(out.struck, ["first", "second"], `mixed/${mode}`)
      assert.match(out.text, /~single~/, `mixed/${mode}: the single-tilde run stays literal`)
    }
    assert.deepEqual(pageErrors, [])
  } finally {
    await browser.close()
  }
})
