import assert from "node:assert/strict"
import test from "node:test"

// An option's DETAIL and a question's trailing NOTE are sized by rules in styles.css
// (`[data-question-option] .md-body`, `[data-question-note] .md-body`) because the Tailwind utilities
// they wore never applied: `.md-body` and `.card-md .md-body` are unlayered CSS and outrank every
// utility, so the detail rendered at the card's 13px under its 12px label (2026-10-05). Pinned as the
// RELATIONS the card is built on, in a real browser — the cascade is the thing under test, and nothing
// DOM-free computes it. Skipped unless a Vite URL serving the fixtures is provided:
//   cd packages/web && nubx vite --port 5233 --strictPort --host 127.0.0.1 &
//   FRIZZ_QUESTION_DETAIL_SCALE_E2E_URL=http://127.0.0.1:5233 nub --test src/components/questionDetailScale.e2e.test.ts
const baseUrl = process.env.FRIZZ_QUESTION_DETAIL_SCALE_E2E_URL

test("an option's detail steps down from its label, and a trailing note from the question", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 900, height: 1400 })
    const px = (size: string) => Number.parseFloat(size)

    // A registered question whose first option carries a multi-line description: its body.
    await page.goto(`${baseUrl}/registered-question-fixture.html?font=sans`, { waitUntil: "networkidle0" })
    await page.waitForSelector("[data-question-option] .md-body")
    const option = await page.$eval("[data-question-option]:has(.md-body)", (el) => ({
      label: getComputedStyle(el.querySelector(".md-inline") as Element).fontSize,
      detail: getComputedStyle(el.querySelector(".md-body") as Element).fontSize,
    }))
    assert.ok(px(option.detail) < px(option.label), `the detail (${option.detail}) is smaller than its label (${option.label})`)

    // A ```question block that ends in a "Note: …" line after its options.
    await page.goto(`${baseUrl}/question-links-fixture.html`, { waitUntil: "networkidle0" })
    await page.waitForSelector("[data-question-note] .md-body")
    const note = await page.$eval("[data-question-note]", (el) => {
      const question = el.closest(".card-md")?.querySelector(".md-body") as Element
      const body = el.querySelector(".md-body") as Element
      return {
        text: body.textContent?.trim(),
        size: getComputedStyle(body).fontSize,
        colour: getComputedStyle(body).color,
        questionSize: getComputedStyle(question).fontSize,
        questionColour: getComputedStyle(question).color,
      }
    })
    assert.match(note.text ?? "", /^Note: the log is in/)
    assert.ok(px(note.size) < px(note.questionSize), `the note (${note.size}) is smaller than the question (${note.questionSize})`)
    assert.notEqual(note.colour, note.questionColour, "the note is muted against the question")
  } finally {
    await browser.close()
  }
})
