import assert from "node:assert/strict"
import test, { after, before } from "node:test"

// THE PAGE'S QUEUE CARD (components/AllQueuesCard.tsx) in the states its tests covered on the board's card
// until 098de26d deleted them with their fixture (2026-09-28). The behaviour never went: it lives in the
// shared StateButton (ThreadLifecycle.tsx), which the card wires with onArchived/onDismissCancel, and
// in the page's own exit hook (AllQueues.tsx useLeavingCards) — both run here for real, on
// queue-card-states-fixture.html, with only the network stubbed.
//
//   1-3  the OPTIMISTIC Mark as done: the card fades BEFORE completeThread returns; a needsConfirmation
//        reply puts it back and opens the End-session dialog naming the live work; a failed RPC rolls it
//        back. Port of queueOptimisticDone.e2e.test.ts (7a20f425).
//   4    a reply that steers the card away dissolves it, and its neighbour survives the thread then dropping
//        out of the queue — what queueSteerDissolve.e2e.test.ts pinned on the board's queue until 098de26d.
//   4b   a reply still on the wire past REAPPEAR_MS keeps its card gone: the card came back without the
//        reply, then left again once the worker picked it up (David 2026-09-30).
//   4c   a poll that started before Mark as done cannot bring the card back however late it lands, and a
//        fresh one that still lists the thread does (David 2026-09-30).
//   5-6  a done the worker REGISTERED (`mcp__frizz__done`) draws its Done card on the queue card, and one
//        both fenced and registered draws exactly one (B1, restored 2026-09-29).
//   10   a park queued only for its unread reply reads "Replied", and Mark as read records it seen and
//        takes the card out (David 2026-10-01 on @expand-defaults).
//   11   a rest handing the human `steps:` draws the drawer's steps card ON THE QUEUE CARD — numbered steps
//        under the worker's title, one Done — and Done replies "Done" into the CARD's project and takes
//        the card out at once (upstream fe668a8d; the card drew the fence as bare prose until 2026-10-06).
//   12   a rest on a declared agent terminal draws the resting card, whose event-snooze parks the thread
//        through the card's project and takes the card out.
//   13   each question at the rest that asked it (upstream e157817a, 22084580): one asked two rests ago
//        sits under the reply that asked it, over the newest rest, which is bare and so draws "Reply to
//        continue" beside the older question; one the newest rest asked sits under it with no such card.
//        The transcript that places them is read through the CARD's project.
//   14   "Show earlier messages" is the drawer's door, as since b3872adc (David 2026-10-06: back to the
//        drawer) — the click opens the thread's drawer, whose transcript is read through the CARD's project,
//        and the card does not grow — and the header's collapse folds the card to its header and back.
//   7-9  the terminal net: a frozen native ask and a bare permission prompt — two states the server queues a
//        thread on without journaling an interaction — draw their card, the copy asks the CARD's project
//        for the command, and the net stands down when an answerable interaction is journaled (B2).
//
// Skipped unless a Vite URL serving the fixtures is provided: `nub run test:e2e` sets it, or start
// `vite` in packages/web and set FRIZZ_QUEUE_CARD_STATES_E2E_URL to its origin.
const baseUrl = process.env.FRIZZ_QUEUE_CARD_STATES_E2E_URL

const FIRST = '[data-xq-card="fixture-card/rotate-key"]'
const NEIGHBOUR = '[data-xq-card="fixture-card/flaky-ci"]'

type PuppeteerModule = typeof import("puppeteer")
type Browser = Awaited<ReturnType<PuppeteerModule["launch"]>>
type Page = Awaited<ReturnType<Browser["newPage"]>>
interface RpcLog { calls: { path: string; at: number }[]; completeCalledAt: number | null; completeResolvedAt: number | null }

let browser: Browser | undefined
let page: Page | undefined
let errors: string[] = []

before(async () => {
  if (!baseUrl) return
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  browser = await launchHeadless()
  page = await browser.newPage()
  page.setDefaultTimeout(30_000)
  await page.setViewport({ width: 900, height: 1000, deviceScaleFactor: 1 })
  // A 500 from the stubbed completeThread is the failure case's own input, not a page error.
  page.on("console", (m) => { if (m.type() === "error" && !/404|favicon|status of 500/i.test(m.text())) errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  // WARM A COLD VITE before any timed step. A fresh server optimizes this fixture's dependencies on the
  // first load and reloads the page when it is done; that ran 45s once and failed the first test's
  // 30s wait, with nothing wrong with the card.
  await page.goto(`${baseUrl}/queue-card-states-fixture.html`, { waitUntil: "networkidle0", timeout: 120_000 })
  await page.waitForSelector(FIRST, { timeout: 120_000 })
})

after(async () => { await browser?.close() })

async function open(query: string) {
  errors = []
  await page!.goto(`${baseUrl}/queue-card-states-fixture.html?${query}`, { waitUntil: "networkidle0" })
  await page!.waitForSelector(FIRST)
  // The card holds its fence and gate cards until the handoff is read; wait for the prose.
  await page!.waitForFunction((sel) => !!document.querySelector(sel)?.querySelector(".md-body"), {}, FIRST)
}

const rpcLog = (): Promise<RpcLog> => page!.evaluate(() => (window as unknown as { __rpc: RpcLog }).__rpc)
const leavingOf = (sel: string): Promise<string> =>
  page!.evaluate((s) => document.querySelector(s)?.getAttribute("data-queue-leaving") ?? "unmounted", sel)
const clickDone = () => page!.$eval(`${FIRST} [data-thread-lifecycle] button[aria-label="Mark as done"]`, (button) => (button as HTMLButtonElement).click())
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Records, IN THE PAGE, the first moment the card turns leaving and whether completeThread had resolved by
// then. A sleep-then-look from here raced the 200ms fade on a loaded machine: by the time the evaluate
// ran, the card had already faded and unmounted.
const watchLeaving = (sel: string) => page!.evaluate((s) => {
  const w = window as unknown as { __left?: { rpcResolved: boolean }; __rpc: RpcLog }
  delete w.__left
  const observer = new MutationObserver(() => {
    if (document.querySelector(s)?.getAttribute("data-queue-leaving") !== "true") return
    w.__left = { rpcResolved: w.__rpc.completeResolvedAt !== null }
    observer.disconnect()
  })
  observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["data-queue-leaving"] })
}, sel)
const leftAt = () => page!.evaluate(() => (window as unknown as { __left?: { rpcResolved: boolean } }).__left ?? null)

test("Mark as done fades the card before completeThread returns, and it stays gone once the queue drops it", { skip: !baseUrl, timeout: 60_000 }, async () => {
  await open("case=exit&delay=1500")
  await watchLeaving(FIRST)
  await clickDone()
  await page!.waitForFunction(() => !!(window as unknown as { __left?: unknown }).__left, { timeout: 1_000 })
  assert.deepEqual(await leftAt(), { rpcResolved: false }, "the card turned leaving while completeThread was still in flight")

  // EXIT_MS (200) later the card is hidden — still before the RPC resolves.
  await page!.waitForFunction((sel) => !document.querySelector(sel), { timeout: 1_000 }, FIRST)
  assert.equal((await rpcLog()).completeResolvedAt, null, "the faded card was gone before the RPC resolved")
  assert.equal(await leavingOf(NEIGHBOUR), "false", "its neighbour is untouched")

  // The RPC resolves, the queue drops the thread, and the card never flickers back — not even past
  // REAPPEAR_MS (8s), when the exit hook would restore a card whose thread was still queued.
  await sleep(1300)
  assert.notEqual((await rpcLog()).completeResolvedAt, null, "the delayed RPC did resolve")
  assert.equal(await leavingOf(FIRST), "unmounted")
  await sleep(8200)
  assert.equal(await leavingOf(FIRST), "unmounted", "no flicker back once the queue no longer holds it")
  assert.deepEqual(errors, [])
})

test("a needsConfirmation reply reinstates the card and opens the End-session dialog naming the live work", { skip: !baseUrl, timeout: 60_000 }, async () => {
  await open("case=exit&needsConfirmation=1")
  await clickDone()
  // The decline is fast (the server checks liveness before any teardown), so it lands inside the fade.
  await page!.waitForFunction(() => !!document.querySelector('[role="dialog"], [role="alertdialog"]'))
  const state = await page!.evaluate((sel) => {
    const dialog = document.querySelector('[role="dialog"], [role="alertdialog"]')
    return {
      leaving: document.querySelector(sel)?.getAttribute("data-queue-leaving") ?? "unmounted",
      dialog: dialog?.textContent ?? "",
      hold: document.querySelector("[data-completion-hold]")?.textContent ?? "",
      cards: document.querySelectorAll("[data-xq-card]").length,
    }
  }, FIRST)
  const log = await rpcLog()
  assert.ok(log.calls.some((c) => c.path === "/_frizz/fixture-card/rpc/completeThread"), "completeThread went to the CARD's project")
  assert.equal(state.leaving, "false", "the card came back")
  assert.equal(state.cards, 2, "both cards are in the queue")
  assert.match(state.dialog, /End this session\?/)
  assert.match(state.hold, /1 sub-agent(?!s)/, "the live child is counted, singular")
  assert.match(state.hold, /Audit the refresh-token rotation/)
  assert.match(state.hold, /2 terminals/, "the agent's terminals, counted with any of yours in one group")
  assert.match(state.hold, /Watch origin\/main CI/)
  assert.match(state.hold, /no recent output/, "the quiet shell is marked, not overclaimed as running")
  // And it is still there after the exit window: nothing unmounted it behind the dialog.
  await sleep(500)
  assert.equal(await leavingOf(FIRST), "false")
  assert.deepEqual(errors, [])
})

test("a failed completeThread rolls the faded card back and says why", { skip: !baseUrl, timeout: 60_000 }, async () => {
  await open("case=exit&fail=1&delay=600")
  await watchLeaving(FIRST)
  await clickDone()
  await page!.waitForFunction((sel) => !document.querySelector(sel), { timeout: 1_000 }, FIRST)
  assert.deepEqual(await leftAt(), { rpcResolved: false }, "the card faded optimistically")
  // Back within moments of the failure — well inside REAPPEAR_MS (8s), after which the exit hook would
  // restore any card whose thread is still queued, rollback or not (measured: with the rollback deleted
  // this wait still passed at ~10s untimed).
  await page!.waitForFunction((sel) => document.querySelector(sel)?.getAttribute("data-queue-leaving") === "false", { timeout: 2_000 }, FIRST)
  const state = await page!.evaluate((sel) => ({
    disabled: (document.querySelector(`${sel} [data-thread-lifecycle] button[aria-label="Mark as done"]`) as HTMLButtonElement | null)?.disabled,
    toast: (window as unknown as { __store: { toast?: { text: string } } }).__store.toast?.text ?? "",
  }), FIRST)
  assert.equal(state.disabled, false, "Mark as done can be pressed again")
  assert.match(state.toast, /Couldn’t finish: the worker would not stop/)
  assert.deepEqual(errors, [])
})

test("a steered card dissolves without taking its neighbour down", { skip: !baseUrl, timeout: 60_000 }, async () => {
  await open("case=exit")
  await watchLeaving(FIRST)
  const box = `${FIRST} textarea[data-surface="queueComposer"]`
  await page!.click(box)
  await page!.type(box, "Ship it.")
  // The app-wide send chord (lib/composerKeyboard.ts): a bare Enter is a newline.
  await page!.keyboard.down("Meta")
  await page!.keyboard.press("Enter")
  await page!.keyboard.up("Meta")
  await page!.waitForFunction((sel) => document.querySelector(sel)?.getAttribute("data-queue-leaving") === "true" || !document.querySelector(sel), { timeout: 1_000 }, FIRST)
  assert.notEqual(await leftAt(), null, "the steered card faded")
  assert.equal(await leavingOf(NEIGHBOUR), "false", "only the steered card fades")
  // The card is hidden, then the poll drops its thread. A hook-order fault (useThreadComposerControls'
  // early return) tore down every card in the frame a steered card's row went; the neighbour must still
  // be here, and nothing may have thrown.
  await sleep(700)
  assert.equal(await leavingOf(FIRST), "unmounted")
  assert.equal(await leavingOf(NEIGHBOUR), "false", "the neighbour survives the dissolve")
  assert.ok((await rpcLog()).calls.some((c) => c.path === "/_frizz/fixture-card/rpc/followUp"), "the reply went to the card's project")
  assert.deepEqual(errors, [])
})

test("a reply still being delivered past the reappear deadline keeps its card gone", { skip: !baseUrl, timeout: 60_000 }, async () => {
  // 9s: past REAPPEAR_MS (8s) measured from the click, which is where the card used to come back.
  await open("case=exit&replyDelay=9000")
  const box = `${FIRST} textarea[data-surface="queueComposer"]`
  await page!.click(box)
  await page!.type(box, "Ship it.")
  await page!.keyboard.down("Meta")
  await page!.keyboard.press("Enter")
  await page!.keyboard.up("Meta")
  await page!.waitForFunction((sel) => !document.querySelector(sel), { timeout: 2_000 }, FIRST)
  // Sampled IN THE PAGE across the whole wait, so a reappearance between two looks from here still counts.
  const reappeared = await page!.evaluate((sel) => new Promise<boolean>((resolve) => {
    let seen = false
    const timer = setInterval(() => { if (document.querySelector(sel)) seen = true }, 50)
    setTimeout(() => { clearInterval(timer); resolve(seen) }, 9_800)
  }), FIRST)
  assert.equal(reappeared, false, "the card stayed gone while its reply was on the wire and the poll then dropped it")
  assert.equal(await leavingOf(NEIGHBOUR), "false")
  assert.deepEqual(errors, [])
})

// The card is sampled IN THE PAGE for `ms`, so a reappearance between two looks from here still counts.
const reappearsWithin = (sel: string, ms: number) => page!.evaluate((s, wait) => new Promise<boolean>((resolve) => {
  let seen = false
  const timer = setInterval(() => { if (document.querySelector(s)) seen = true }, 50)
  setTimeout(() => { clearInterval(timer); resolve(seen) }, wait)
}), sel, ms)

test("a poll that started before Mark as done cannot bring the card back, however late it lands", { skip: !baseUrl, timeout: 60_000 }, async () => {
  // The read landing at 9s started before the click and still lists the thread; it used to restore the
  // card at REAPPEAR_MS and leave it up until the next read (David 2026-09-30: "reopened for a long time").
  await open("case=exit&delay=300&stalePoll=1")
  await clickDone()
  await page!.waitForFunction((sel) => !document.querySelector(sel), { timeout: 2_000 }, FIRST)
  assert.equal(await reappearsWithin(FIRST, 12_500), false, "the card stayed gone until a fresh read dropped the thread")
  assert.equal(await leavingOf(NEIGHBOUR), "false")
  assert.deepEqual(errors, [])
})

test("a read that started after Mark as done and still lists the thread brings the card back", { skip: !baseUrl, timeout: 60_000 }, async () => {
  // The negative control: the guard waits for evidence, it does not swallow it.
  await open("case=exit&delay=300&stillQueued=1")
  await clickDone()
  await page!.waitForFunction((sel) => !document.querySelector(sel), { timeout: 2_000 }, FIRST)
  await page!.waitForFunction((sel) => document.querySelector(sel)?.getAttribute("data-queue-leaving") === "false", { timeout: 10_000 }, FIRST)
  assert.deepEqual(errors, [])
})

test("a registered done (mcp__frizz__done) draws its Done card on the queue card",{ skip: !baseUrl, timeout: 60_000 }, async () => {
  await open("case=registered-done")
  const text = await page!.$eval(FIRST, (card) => card.textContent ?? "")
  assert.match(text, /Done/)
  assert.match(text, /New key live on all three regions/, "the registered body is drawn")
  assert.deepEqual(errors, [])
})

test("fenced AND registered draws one Done card, not two", { skip: !baseUrl, timeout: 60_000 }, async () => {
  await open("case=fenced-and-registered")
  const count = await page!.$eval(FIRST, (card) => (card.textContent ?? "").split("New key live on all three regions").length - 1)
  assert.equal(count, 1)
  assert.deepEqual(errors, [])
})

test("a frozen native ask draws its card, with no action on it", { skip: !baseUrl, timeout: 60_000 }, async () => {
  await open("case=pending-ask")
  const text = await page!.$eval(FIRST, (card) => card.textContent ?? "")
  assert.match(text, /Waiting on your answer — in your external terminal/)
  assert.match(text, /Which rollout do you want\?/)
  assert.match(text, /Stage a second key/)
  // The Copy terminal command button went with its RPC (upstream 421e86d9): the operator is already
  // running a foreign session in their own terminal.
  assert.doesNotMatch(text, /Copy terminal command/)
  assert.deepEqual(errors, [])
})

test("a bare permission prompt draws the banner", { skip: !baseUrl, timeout: 60_000 }, async () => {
  await open("case=perm-prompt")
  assert.match(await page!.$eval(FIRST, (card) => card.textContent ?? ""), /Permission approval/)
  assert.deepEqual(errors, [])
})

test("the banner stands down when an answerable interaction is journaled", { skip: !baseUrl, timeout: 60_000 }, async () => {
  await open("case=perm-prompt-journaled")
  // Give the handoff-gated slot its moment, then check it drew nothing.
  await sleep(300)
  assert.doesNotMatch(await page!.$eval(FIRST, (card) => card.textContent ?? ""), /Permission approval/)
})

test("a park queued only for its reply reads Replied, and Mark as read records it seen and takes the card out", { skip: !baseUrl, timeout: 60_000 }, async () => {
  await open("case=replied")
  const text = await page!.$eval(FIRST, (card) => card.textContent ?? "")
  assert.match(text, /Replied/, "the header says why it is here")
  assert.doesNotMatch(text, /Queued|Ready/, "not the queue word (Queued; Ready until 2026-10-06)")
  await page!.$eval(`${FIRST} [data-thread-lifecycle] button[data-mark-read]`, (button) => (button as HTMLButtonElement).click())
  await page!.waitForFunction((sel) => !document.querySelector(sel), { timeout: 2_000 }, FIRST)
  const seen = (await rpcLog()).calls.filter((c) => /\/rpc\/threadSeen$/.test(c.path)).map((c) => c.path)
  assert.deepEqual(seen, ["/_frizz/fixture-card/rpc/threadSeen"], "seen is recorded in the card's own project")
  assert.deepEqual(errors, [])
})

test("a rest handing the human steps draws the steps card, and Done replies into the card's project and takes it out", { skip: !baseUrl, timeout: 60_000 }, async () => {
  await open("case=steps")
  await page!.waitForSelector(`${FIRST} [data-awaiting-steps] li`)
  const card = await page!.$eval(FIRST, (el) => ({
    chip: (el.querySelector("[data-awaiting-background] [data-card-chip]") as HTMLElement | null)?.innerText.trim(),
    title: (el.querySelector("[data-awaiting-background] [data-card-title]") as HTMLElement | null)?.innerText.trim(),
    steps: [...el.querySelectorAll("[data-awaiting-steps] li")].map((li) => (li as HTMLElement).innerText.trim()),
    numbered: el.querySelector("[data-awaiting-steps] ol") !== null,
    body: (el.querySelector("[data-awaiting-background] .card-md p") as HTMLElement | null)?.innerText.trim(),
    verbs: [...el.querySelectorAll("[data-awaiting-background] button")].map((b) => (b as HTMLElement).innerText.trim()),
    // The fence's frontmatter never reaches the reader as prose, and its card is drawn once.
    raw: /steps:|title:/.test(el.textContent ?? ""),
    cards: el.querySelectorAll("[data-awaiting-background]").length,
  }))
  assert.equal(card.chip, "Awaiting human")
  assert.equal(card.title, "Sign in to npm so the release can publish", "the worker's own heading")
  assert.equal(card.numbered, true, "the steps are a numbered list")
  assert.deepEqual(card.steps, [
    "Run npm login --auth-type=web in a terminal on this machine.",
    "Approve the browser prompt with the acme-bot account.",
  ])
  assert.equal(card.body, "The release is staged; it publishes the moment npm accepts the login.")
  assert.deepEqual(card.verbs, ["Done"], "the steps' one verb")
  assert.equal(card.raw, false, "no frontmatter printed at the human")
  assert.equal(card.cards, 1, "one card for one wait: the fence and the resting card are the same card")

  await watchLeaving(FIRST)
  await page!.$eval(`${FIRST} [data-steps-done]`, (button) => (button as HTMLButtonElement).click())
  // Upstream's optimistic exit: the card fades on the click, before the reply lands.
  await page!.waitForFunction(() => !!(window as unknown as { __left?: unknown }).__left, { timeout: 1_000 })
  await page!.waitForFunction(() => (window as unknown as { __rpc: RpcLog }).__rpc.calls.some((c) => /\/rpc\/followUp$/.test(c.path)), { timeout: 5_000 })
  const replies = (await rpcLog()).calls.filter((c) => /\/rpc\/followUp$/.test(c.path)).map((c) => c.path)
  assert.deepEqual(replies, ["/_frizz/fixture-card/rpc/followUp"], "one reply, to the CARD's project — never the page's")
  await page!.waitForFunction((sel) => !document.querySelector(sel), { timeout: 2_000 }, FIRST)
  assert.equal(await leavingOf(NEIGHBOUR), "false", "its neighbour is untouched")
  assert.deepEqual(errors, [])
})

test("a rest on a declared agent terminal draws the resting card, and its snooze parks through the card's project", { skip: !baseUrl, timeout: 60_000 }, async () => {
  await open("case=resting")
  await page!.waitForSelector(`${FIRST} [data-awaiting-background] [data-awaiting-snooze]`)
  const card = await page!.$eval(FIRST, (el) => ({
    rows: [...el.querySelectorAll("[data-awaiting-background] [data-wait-kind]")].map((row) => row.getAttribute("data-wait-kind")),
    text: el.querySelector("[data-awaiting-background]")?.textContent ?? "",
    cards: el.querySelectorAll("[data-awaiting-background]").length,
  }))
  assert.equal(card.cards, 1, "the resting card states the fence; the fence draws nothing of its own")
  assert.deepEqual(card.rows, ["shell"], "the declared terminal has its row")
  assert.match(card.text, /nub run test/)
  assert.match(card.text, /the failures so far are all in the auth spec/, "the worker's prose opens the card")
  await watchLeaving(FIRST)
  await page!.$eval(`${FIRST} [data-awaiting-snooze] button`, (button) => (button as HTMLButtonElement).click())
  await page!.waitForFunction(() => !!(window as unknown as { __left?: unknown }).__left, { timeout: 1_000 })
  await page!.waitForFunction(() => (window as unknown as { __rpc: RpcLog }).__rpc.calls.some((c) => /snoozeAwaitingBackground$/.test(c.path)), { timeout: 5_000 })
  const snoozes = (await rpcLog()).calls.filter((c) => /snoozeAwaitingBackground$/.test(c.path)).map((c) => c.path)
  assert.deepEqual(snoozes, ["/_frizz/fixture-card/rpc/snoozeAwaitingBackground"], "the park went to the card's project")
  await page!.waitForFunction((sel) => !document.querySelector(sel), { timeout: 2_000 }, FIRST)
  assert.equal(await leavingOf(NEIGHBOUR), "false")
  assert.deepEqual(errors, [])
})

test("each question sits at the rest that asked it, and a bare newest rest still says so beside an older one", { skip: !baseUrl, timeout: 60_000 }, async () => {
  await open("case=questions")
  await page!.waitForSelector(`${FIRST} [data-registered-questions]`)
  await page!.waitForSelector(`${NEIGHBOUR} [data-registered-questions]`)
  // Document order of the card's pieces, by what each says.
  const order = (sel: string, marks: string[]) => page!.$eval(sel, (card, marks) => {
    const all = [...card.querySelectorAll<HTMLElement>(".md-body, [data-registered-questions], [data-rested-card]")]
    return all.flatMap((el) => {
      const said = el.innerText
      const mark = el.matches("[data-registered-questions]") ? `questions:${said.match(/Which rollout|Keep the retry wrapper/)?.[0] ?? "?"}`
        : el.matches("[data-rested-card]") ? `rested:${el.getAttribute("data-rested-card")}`
        : marks.find((m) => said.includes(m))
      return mark ? [mark] : []
    })
  }, marks)
  assert.deepEqual(
    await order(FIRST, ["Both rollouts are ready", "CI is green on main"]),
    ["Both rollouts are ready", "questions:Which rollout", "CI is green on main", "rested:bare"],
    "asked two rests ago: under the reply that asked it, and the bare rest after it draws its own card",
  )
  assert.deepEqual(
    await order(NEIGHBOUR, ["Found the race"]),
    ["Found the race", "questions:Keep the retry wrapper"],
    "the newest rest's own question ends it, under everything it said, with no rested card",
  )
  const reads = (await rpcLog()).calls.filter((c) => /\/rpc\/threadTranscript$/.test(c.path)).map((c) => c.path)
  assert.ok(reads.length >= 2, "each card read its transcript")
  assert.deepEqual([...new Set(reads)], ["/_frizz/fixture-card/rpc/threadTranscript"], "through the card's project, never the page's")
  assert.deepEqual(errors, [])
})

test("Show earlier messages opens the drawer, not the card, and collapse folds the card to its header and back", { skip: !baseUrl, timeout: 60_000 }, async () => {
  await open("")
  const link = await page!.$eval(FIRST, (el) => {
    const a = [...el.querySelectorAll("a")].find((x) => x.textContent?.trim() === "Show earlier messages")
    return a ? { href: a.getAttribute("href"), height: el.getBoundingClientRect().height } : null
  })
  assert.ok(link, "the link is there")
  assert.equal(link.href, "/all/signing/thread/rotate-key", "the CARD's thread's drawer, on the card's project")
  await page!.evaluate(() => [...document.querySelectorAll('[data-xq-card="fixture-card/rotate-key"] a')].find((x) => x.textContent?.trim() === "Show earlier messages")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })))
  await sleep(400)
  assert.equal(await page!.$eval(FIRST, (el) => el.getBoundingClientRect().height), link.height, "the card does not grow")
  // The drawer's frame is what the click puts up (store.pendingOpen → PendingThreadSheet, which the page
  // draws and this fixture does not), with the transcript read for the DRAWER through the card's project.
  const pending = await page!.evaluate(() => {
    const open = (window as unknown as { __store: { pendingOpen?: { projectSlug: string; slug: string } } }).__store.pendingOpen
    return open ? { projectSlug: open.projectSlug, slug: open.slug } : null
  })
  assert.deepEqual(pending, { projectSlug: "signing", slug: "rotate-key" }, "the click opens the thread's drawer")
  const reads = (await rpcLog()).calls.filter((c) => /\/rpc\/threadTranscript/.test(c.path)).map((c) => c.path)
  assert.deepEqual(reads, ["/_frizz/fixture-card/rpc/threadTranscript"], "read once, for the drawer, through the card's project")

  await page!.$eval(`${FIRST} [data-xq-collapse]`, (button) => (button as HTMLButtonElement).click())
  const folded = await page!.$eval(FIRST, (el) => ({
    body: el.querySelector(".md-body") !== null,
    dock: el.querySelector("[data-queue-dock]") !== null,
    header: el.querySelector("header")?.hasAttribute("data-xq-collapsed"),
    label: el.querySelector("[data-xq-collapse]")?.getAttribute("aria-label"),
  }))
  assert.deepEqual(folded, { body: false, dock: false, header: true, label: "Expand" })
  await page!.$eval(`${FIRST} [data-xq-collapse]`, (button) => (button as HTMLButtonElement).click())
  await page!.waitForFunction((sel) => !!document.querySelector(sel)?.querySelector(".md-body"), {}, FIRST)
  assert.equal(await page!.$eval(FIRST, (el) => el.querySelector("[data-queue-dock]") !== null && el.querySelector("[data-xq-collapse]")?.getAttribute("aria-label") === "Collapse"), true)
  assert.equal(await leavingOf(NEIGHBOUR), "false")
  assert.deepEqual(errors, [])
})
