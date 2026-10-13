import assert from "node:assert/strict"
import test from "node:test"

const baseUrl = process.env.FRIZZ_MARKDOWN_SANITIZER_E2E_URL

// lib/markdown.ts sanitizes in a real DOM, so this is the only place its behaviour can be pinned.
// Half the value is the XSS battery: `walk` UNWRAPS a disallowed tag rather than deleting its subtree
// (deleting silently ate the rest of any block containing `Promise<void>` or a `<sessionId>`
// placeholder), and every escape route out of that widened rule is re-checked here.
test("the markdown sanitizer keeps authored meaning and blocks every scripted escape", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const pageErrors: string[] = []
  try {
    const page = await browser.newPage()
    page.on("pageerror", (error) => pageErrors.push(String(error)))
    await page.goto(`${baseUrl}/markdown-sanitizer-fixture.html`, { waitUntil: "domcontentloaded" })
    await page.waitForSelector("[data-case=tasklist]")
    // NOTE: no named function expressions in here. Nub's transpiler rewrites `const f = () => …` with a
    // `__name` keep-names shim that does not exist inside the page, and evaluate dies on it.
    const seen = await page.evaluate(() => {
      const handlers: string[] = []
      for (const el of document.querySelectorAll("*"))
        for (const attr of el.attributes) if (/^on/i.test(attr.name)) handlers.push(`${el.tagName}@${attr.name}`)
      return {
        pwned: (window as Window & { __pwned?: string }).__pwned ?? null,
        handlers,
        // shape
        taskBoxes: Array.from(document.querySelectorAll("[data-case=tasklist] .md-task")).map((n) => n.className),
        // The item's own inline run, wrapped so the row's dimmed/struck styling cannot reach a nested
        // sub-list. Its class has to survive the allowlist like every other one here.
        taskTexts: Array.from(document.querySelectorAll("[data-case=tasklist] .md-task-text")).map((n) => n.textContent),
        nestedStaysOutside: !document.querySelector("[data-case=tasklist-nested] .md-task-text ul"),
        nestedChildText: document.querySelector("[data-case=tasklist-nested] ul ul .md-task-text")?.textContent ?? null,
        emptyBoxes: Array.from(document.querySelectorAll("[data-case=tasklist-empty] .md-task")).map((n) => n.className),
        emptyText: document.querySelector("[data-case=tasklist-empty]")?.textContent?.trim(),
        customTaskBoxes: Array.from(document.querySelectorAll("[data-case=tasklist-custom] .md-task")).map((n) => ({
          className: n.className,
          title: n.getAttribute("title"),
        })),
        looseBoxes: Array.from(document.querySelectorAll("[data-case=tasklist-loose] li > p > .md-task")).map((n) => n.className),
        olStart: document.querySelector("[data-case=olstart] ol")?.getAttribute("start") ?? null,
        headAlign: Array.from(document.querySelectorAll("[data-case=align] th")).map((n) => getComputedStyle(n).textAlign),
        genericText: document.querySelector("[data-case=generic]")?.textContent?.trim(),
        placeholderText: document.querySelector("[data-case=placeholder]")?.textContent?.trim(),
        detailsText: document.querySelector("[data-case=details]")?.textContent?.replace(/\s+/g, " ").trim(),
        // xss — every one of these must keep the trailing prose and drop the payload
        xss: Object.fromEntries(Array.from(document.querySelectorAll("[data-case^=x-]")).map((n) => [
          n.getAttribute("data-case")!,
          { text: n.textContent?.replace(/\s+/g, " ").trim(), html: n.innerHTML },
        ])),
      }
    })

    // --- nothing executed, nothing scriptable survived ---
    assert.equal(seen.pwned, null, "no probe payload may run")
    assert.deepEqual(seen.handlers, [], "no event-handler attribute may survive sanitizing")
    for (const [id, out] of Object.entries(seen.xss)) {
      assert.doesNotMatch(out.html, /<(script|style|iframe|object|embed|svg|noscript|template|form|input)\b/i, `${id}: dangerous element`)
      assert.doesNotMatch(out.html, /\son[a-z]+=/i, `${id}: event handler`)
      assert.doesNotMatch(out.html, /javascript:/i, `${id}: javascript: url`)
    }
    // a dangerous element takes its content with it; anything else keeps its text
    assert.equal(seen.xss["x-script"].text, "after")
    assert.equal(seen.xss["x-style"].text, "after")
    assert.equal(seen.xss["x-div-script"].text, "kept", "the div unwraps, only the script's content dies")
    assert.equal(seen.xss["x-unknown-handler"].text, "visible text", "an unknown tag unwraps, keeping its text")
    assert.equal(seen.xss["x-deep"].text, "deep text", "unwrapping recurses into salvaged children")
    assert.equal(seen.xss["x-jsurl"].text, "click")
    assert.equal(seen.xss["x-olstart"].html.includes("start="), false, "a non-numeric start is dropped")
    assert.equal(seen.xss["x-tdalign"].html.includes("align="), false, "a bogus align is dropped")
    assert.equal(seen.xss["x-span-style"].html.includes("style="), false, "only an ansi fence's bare hex colour is a style")
    assert.equal(seen.xss["x-span-style"].text, "styled fixed para")

    // --- authored meaning survives ---
    assert.deepEqual(seen.taskBoxes, ["md-task md-task-checked", "md-task"], "checked state must be visible")
    assert.deepEqual(seen.customTaskBoxes, [
      { className: "md-task md-task-in-progress", title: "In progress" },
      { className: "md-task md-task-cancelled", title: "Cancelled" },
      { className: "md-task md-task-blocked", title: "Blocked" },
    ], "custom task state and its label must survive sanitizing")
    assert.deepEqual(seen.looseBoxes, ["md-task md-task-checked", "md-task"], "loose task items too")
    assert.deepEqual(seen.taskTexts, ["Reproduce the failing fixture", "Bisect to the offending commit"],
      "each item's own text is wrapped, and the wrapper survives sanitizing")
    assert.ok(seen.nestedStaysOutside, "a nested sub-list must be a SIBLING of the text wrapper, never inside it")
    assert.equal(seen.nestedChildText, "still live", "the live sub-task keeps its own text")
    assert.deepEqual(seen.emptyBoxes, ["md-task", "md-task md-task-checked"],
      "a bare `- [ ]` — an unfilled task-list item — is a checkbox, not literal text")
    assert.equal(seen.emptyText, "", "and it leaves no marker text behind")
    assert.equal(seen.olStart, "17", "a list that starts at 17 keeps its numbering")
    assert.deepEqual(seen.headAlign, ["left", "center", "right"], "GFM column alignment is honored")
    assert.equal(seen.genericText, "The handler returns Promise and then logs the slug.",
      "a tag-shaped token must not delete the rest of the sentence")
    // The two `<…>` tokens are consumed by the HTML parser (as on GitHub); what must NOT happen is the
    // old behaviour, where everything after the first one was deleted and only "Write to " survived.
    assert.equal(seen.placeholderText, "Write to /.jsonl and restart the tailer.",
      "consecutive placeholders must not delete the rest of the sentence")
    assert.match(seen.detailsText ?? "", /The stack was 40 frames deep/, "a non-allowlisted wrapper keeps its content")

    assert.deepEqual(pageErrors, [])
  } finally {
    await browser.close()
  }
})
