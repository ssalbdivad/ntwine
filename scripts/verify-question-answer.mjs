// Browser gate for the ```question card's ANSWERING contract, driven against the REAL app on a REAL
// disposable stack. The gallery fixture holds local state, so it can prove the chips and the textarea
// behave — but not the SEAM that actually matters: card → answering controller → composeAnswerWire →
// rpc.followUp. So this asserts on the bytes leaving the page.
//
// The two behaviors it pins (both settled 2026-07-26):
//   1. NOTHING in a question card sends on a single click. The retired ```question approval gate had a
//      lone Approve button that fired immediately; every kind now STAGES (pick a chip / type, then
//      Send answers). A legacy `approval` block must therefore render the same two chips as any other
//      two-option question, and clicking one must put nothing on the wire.
//   2. The free-text box takes NEWLINES on a bare Enter, and only ⌘/Ctrl-Enter sends — so a multi-line
//      answer can be typed without firing a reply mid-sentence, and the newlines survive to the wire.
//
// Two send paths, one per --mode (each CONSUMES its seed, so use a fresh slug per run):
//   --mode=text (default) — type a multi-line freetext answer, send it with ⌘-Enter
//   --mode=chip           — pick a chip only, send it with the prompt box's Send button
// Two surfaces, one per --surface: the QUEUE card (its own card-level Send) and the thread DRAWER
// (the drawer's prompt box). They run the same block through different controllers.
//
// Seed a stack + question threads first (scripts/seed-question-cards.mjs, see .agents/skills/frizz-stack):
//   node scripts/verify-question-answer.mjs --url=http://127.0.0.1:4930 --slug=q-legacy-approval
//   node scripts/verify-question-answer.mjs --url=… --slug=q-legacy-danger --mode=chip
import puppeteer from "puppeteer"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => { const [k, ...v] = a.replace(/^--/, "").split("="); return [k, v.join("=") || true] }),
)
const { url, slug, shots = "/tmp", mode = "text", surface = "queue" } = flags
// How many option chips this seed's block should render — 0 for a freetext-only ask, which has no
// chips to click and can only be answered by typing (so --mode=chip is meaningless there).
const wantChips = Number(flags.chips ?? 2)
if (!url || !slug || !["text", "chip"].includes(mode) || !["queue", "drawer"].includes(surface)
  || !Number.isInteger(wantChips) || (wantChips === 0 && mode === "chip")) {
  console.error("usage: node verify-question-answer.mjs --url= --slug= [--mode=text|chip] [--surface=queue|drawer] [--chips=N] [--shots=/tmp]")
  process.exit(1)
}
let failures = 0
const check = (label, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}
const settle = (ms) => new Promise((r) => setTimeout(r, ms))
const CARD = `[data-queue-card-root="${slug}"]`
// The drawer portals OUTSIDE the queue card, so its copy of the same block is scoped by the open
// sheet rather than by the card. Both carry the identical questionAnswer box + chips.
const SEL = surface === "drawer" ? "[role=dialog]" : CARD
const ANSWER_BOX = `${SEL} textarea[data-surface="questionAnswer"]`
// An option chip by its label: the "A." / "1)" id, optionally behind the Recommended badge's text.
const CHIP_SRC = "^(Recommended)?[A-Z0-9][.)]\\s"
const CHIP_SRC_RE = new RegExp(CHIP_SRC)

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"] })
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 2 })
  const errors = []
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`))
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`) })

  const sends = []
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().includes("/rpc/followUp")) {
      try { sends.push(JSON.parse(req.postData() ?? "{}")) } catch { sends.push({ unparsed: req.postData() }) }
    }
  })

  await page.goto(url, { waitUntil: "networkidle2" })
  await page.waitForSelector(CARD, { timeout: 15000 })
  await page.evaluate((card) => document.querySelector(card).scrollIntoView({ block: "center" }), CARD)
  if (surface === "drawer") {
    // Open the thread sheet from the card's own expand affordance, then answer the DRAWER's copy.
    await page.evaluate((card) => {
      const el = document.querySelector(card)
      const open = [...el.querySelectorAll("button,a")].find((b) => /open|expand|thread/i.test(b.getAttribute("aria-label") ?? b.title ?? ""))
      if (open) open.click()
      else el.querySelector("h2,h3,[data-thread-title]")?.click()
    }, CARD)
    await page.waitForSelector(SEL, { timeout: 15000 })
    await settle(1200)
  }
  await page.waitForSelector(ANSWER_BOX, { timeout: 15000 })
  await settle(1200)

  // The surface under test, not the whole viewport — a queue screenshot mostly shows the cards above
  // the one being driven. After a send the queue card dissolves (the optimistic dismissal), so fall
  // back to the viewport rather than crashing on the element that is correctly no longer there.
  const shootCard = async (name) => {
    const path = `${shots}/frizz-question-${slug}-${surface}-${name}.png`
    const el = await page.$(SEL)
    if (el) await el.screenshot({ path })
    else await page.screenshot({ path })
  }

  // Every button inside the card, so the assertions can talk about what the card offers without
  // knowing its chrome. Chips are the option buttons; the lifecycle controls are named separately.
  const buttons = () => page.evaluate((sel) =>
    [...document.querySelector(sel).querySelectorAll("button")].map((b) => b.textContent.trim()), SEL)

  // The surface's commit control. Since 2026-10-11 that is the prompt box's Send, which carries the
  // staged answers; a surface with no prompt box mounted still draws its own "Send answers".
  const sendAnswers = () => page.evaluate((sel) => {
    const scope = document.querySelector(sel)
    const b = scope.querySelector("[data-send-split] [data-send]")
      ?? document.querySelector("[data-send-split] [data-send]")
      ?? scope.querySelector("[data-send-answers]")
    if (!b) return "missing"
    if (b.disabled) return "disabled"
    b.click()
    return "clicked"
  }, SEL)

  const labels = await buttons()
  check(
    "the block offers NO one-click approve action",
    !labels.some((t) => /^(approve|approve as-is|do it\b|click again to confirm)/i.test(t)),
    JSON.stringify(labels),
  )
  // A chip's textContent can lead with its "Recommended" badge, so the id may not be at position 0.
  const chips = labels.filter((t) => CHIP_SRC_RE.test(t))
  check(`the block renders its ${wantChips} option(s) as answerable chips`, chips.length === wantChips, JSON.stringify(chips))
  await shootCard("rest")

  // 1. A chip click STAGES — it must not send. (Both modes: this is the retired gate's whole point.)
  // A freetext-only ask has no chip to click, so it goes straight to the typing step.
  let expected = ""
  if (wantChips > 0) {
    expected = await page.evaluate((sel, src) => {
      const b = [...document.querySelector(sel).querySelectorAll("button")].find((b) => new RegExp(src).test(b.textContent.trim()))
      b.click()
      // The wire answer is the option's own text — never the Recommended badge the chip renders with it.
      return b.textContent.trim().replace(/^Recommended/, "")
    }, SEL, CHIP_SRC)
    await settle(900)
    check("clicking a chip sends NOTHING (the answer is staged)", sends.length === 0, `sends=${sends.length} after clicking ${JSON.stringify(expected)}`)
    await shootCard("staged")
  }
  if (mode === "text") {
    // 2. Enter inside the free-text box writes a NEWLINE and sends nothing.
    await page.focus(ANSWER_BOX)
    await page.keyboard.type("Hold for now.")
    await page.keyboard.press("Enter")
    await page.keyboard.press("Enter")
    await page.keyboard.type("Rerun CI first, then ask me again.")
    await settle(600)
    expected = await page.$eval(ANSWER_BOX, (el) => el.value)
    check("Enter inserts a NEWLINE in the free-text box", expected.split("\n").length === 3, JSON.stringify(expected))
    check("typing Enter never sends", sends.length === 0, `sends=${sends.length}`)
    // The box grows with its content instead of clipping the extra lines behind a hidden overflow.
    const box = await page.$eval(ANSWER_BOX, (el) => ({ h: el.clientHeight, scroll: el.scrollHeight }))
    check("the box grew to fit the multi-line answer", box.h >= box.scroll - 1, JSON.stringify(box))
    await shootCard("multiline")

    // 3. ⌘-Enter sends the staged answer, newlines intact.
    await page.keyboard.down("Meta")
    await page.keyboard.press("Enter")
    await page.keyboard.up("Meta")
  } else {
    // 2'. The chip alone is the answer: the prompt box's Send commits it, with nothing typed.
    const sent = await sendAnswers()
    check("a staged chip arms the prompt box's Send", sent === "clicked", sent)
  }
  await settle(1500)
  check("exactly ONE follow-up was sent", sends.length === 1, `sends=${sends.length} ${JSON.stringify(sends)}`)
  check("the send targets this thread", sends[0]?.slug === slug, JSON.stringify(sends[0]?.slug))
  check(
    mode === "text" ? "the wire payload keeps the typed newlines" : "the wire payload is the chosen option verbatim",
    sends[0]?.message === expected,
    `got ${JSON.stringify(sends[0]?.message)} want ${JSON.stringify(expected)}`,
  )
  await shootCard("sent")
  check("no console/page errors", errors.length === 0, errors.join(" | ") || "clean")
} finally {
  await browser.close()
}
process.exit(failures ? 1 : 0)
