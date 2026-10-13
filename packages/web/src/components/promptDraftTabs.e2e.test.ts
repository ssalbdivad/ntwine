import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { join } from "node:path"
import test from "node:test"
import { createRpcClient } from "../../../../scripts/lib/rpc-client.mjs"

// A thread's prompt box is ONE box: the queue card's and its /full page's, in the same tab or in two.
// The fullscreen door is a real link, so ⌘-click and middle-click open /full in a NEW tab — which, while
// drafts were per-tab sessionStorage, opened on an empty box (maintainer 2026-10-11: "The stuff that I
// type into the prompt box when it's in the queue does not transfer over if I open that same queue card
// in full-screen view").
//
// A real adhoc-stack, no provider required: the session row is the simulated worker, and nothing is
// ever sent. Start the stack in a separate terminal:
//   nub scripts/adhoc-stack.mjs --port=45911
// Its first JSON line contains the sandbox "home" field. With the stack still running:
//   NTWINE_PROMPT_DRAFT_TABS_E2E_URL=http://127.0.0.1:45911 \
//   NTWINE_PROMPT_DRAFT_TABS_E2E_HOME=<the "home" field> nub --test \
//     packages/web/src/components/promptDraftTabs.e2e.test.ts
// Stop the disposable stack with Ctrl-C when finished.
const baseUrl = process.env.NTWINE_PROMPT_DRAFT_TABS_E2E_URL
const home = process.env.NTWINE_PROMPT_DRAFT_TABS_E2E_HOME

test("a draft typed on the queue card is in the thread's /full prompt box, in another tab and in this one", {
  skip: !baseUrl || !home, timeout: 120_000,
}, async () => {
  const api = createRpcClient(baseUrl!)
  const [project] = await api.query("projectsList") as Array<{ id: string; slug: string }>
  assert.ok(project)
  const slug = "prompt-draft-tabs"
  execFileSync("sqlite3", [join(home!, ".ntwine", "ui.db"), `INSERT OR REPLACE INTO session
    (project_id, slug, session_id, thread_name, spawned_at, title, backend, claude_runtime, model, effort, permission_mode, rested_at)
    VALUES ('${project.id}', '${slug}', 'aabbccdd-0000-4000-9000-0000000000d1', 'ntwine-${slug}',
    '2026-10-11T00:00:00Z', 'Prompt draft tabs', 'claude', 'broker', 'opus', 'high', 'default', '2026-10-11T00:01:00Z')`])
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless({ protocolTimeout: 30_000 })
  const errors: string[] = []
  try {
    const open = async () => {
      const page = await browser.newPage()
      await page.setViewport({ width: 1400, height: 1000 })
      await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }])
      page.on("pageerror", (e) => errors.push(String(e)))
      page.on("console", (m) => {
        // adhoc-stack has no launcher control server; throwaway projects have no icon. These 404s
        // are the app's normal fallback, unrelated to drafts.
        const url = m.location().url ?? ""
        if (m.type() === "error" && !/\/_ntwine\/(control\/status|project-icon)/.test(url)) errors.push(`${m.text()} ${url}`)
      })
      return page
    }
    // The fork's queue card: its slot is keyed `<project id>/<slug>` (lib/allQueues.ts threadKey).
    const card = `[data-xq-card='${project.id}/${slug}'] [data-xq-card-root]`
    const queueBox = `${card} [data-thread-composer-box='queueComposer'] textarea`
    const fullBox = "main[data-standalone-thread] [data-thread-composer-box='chatComposer'] textarea"
    type Tab = Awaited<ReturnType<typeof open>>
    // Polled on a timer, not on animation frames (puppeteer's default): one of the two tabs is always
    // in the background here, and a hidden tab is not promised a frame.
    const holds = (page: Tab, box: string, text: string) =>
      page.waitForFunction((box, text) => (document.querySelector(box) as HTMLTextAreaElement | null)?.value === text, { polling: 100 }, box, text)

    const board = await open()
    await board.goto(`${baseUrl}/project/${project.slug}`, { waitUntil: "networkidle2" })
    await board.waitForSelector(queueBox)
    await board.click(queueBox)
    await board.keyboard.type("typed in the queue card")

    // 1. ANOTHER TAB — what ⌘-click on the card's fullscreen door opens: the same href, a tab of its own.
    const href = await board.$eval(`${card} [data-expand-thread='${slug}']`, (el) => el.getAttribute("href"))
    const full = await open()
    await full.goto(`${baseUrl}${href}`, { waitUntil: "networkidle2" })
    await full.waitForSelector(fullBox)
    assert.equal(await full.$eval(fullBox, (el) => (el as HTMLTextAreaElement).value), "typed in the queue card")

    // 2. The two stay ONE box while both are open: words added on /full reach the card...
    await full.bringToFront()
    await full.click(fullBox)
    await full.keyboard.type(", finished on /full")
    await holds(board, queueBox, "typed in the queue card, finished on /full")
    // ...and emptying it on the card (what a send does) empties /full, so nothing is left to send twice.
    await board.bringToFront()
    await board.click(queueBox)
    await board.$eval(queueBox, (el) => (el as HTMLTextAreaElement).select())
    await board.keyboard.press("Backspace")
    await holds(board, queueBox, "")
    await holds(full, fullBox, "")

    // 3. THIS TAB — the door's plain click, which always carried the draft and must go on doing so.
    await board.keyboard.type("carried through the door")
    await board.$eval(`${card} [data-expand-thread='${slug}']`, (el) => (el as HTMLAnchorElement).click())
    await board.waitForSelector(fullBox)
    assert.equal(await board.$eval(fullBox, (el) => (el as HTMLTextAreaElement).value), "carried through the door")
    await holds(full, fullBox, "carried through the door")

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
