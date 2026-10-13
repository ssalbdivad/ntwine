// THE PAGE HALF of the editor → Ntwine check: a real Ntwine page, focused on one project, sits open while
// a real VS Code (scripts/e2e.ts in REAL mode with NTWINE_E2E_PAGE_CLAIMS=1) runs "Add to Ntwine prompt".
// It passes when the page claimed the item and its new-thread box holds the chip token — the one place
// the insert can be seen landing, since the server only holds the item until a page takes it.
//
// `scripts/e2e.ts --stack` runs it beside the suite. Standalone, against a Ntwine you started:
//
//   nub packages/vscode/e2e/page-claim.ts --origin=http://127.0.0.1:<port> --project=<slug> \
//     --token=@sample.ts:2-3 [--shot=<png>] [--timeout-ms=240000]
//
// Headless, always: never a window on the human's screen. Headless Chrome reports no OS focus, and the
// page claims an insert only while it has focus (so the tab the human is looking at is the one that
// takes it), so `document.hasFocus()` is forced true. The browser gets a throwaway profile and is
// closed in `finally`; its pid is returned so a caller that was interrupted can kill exactly it.

import type { ChildProcess } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import puppeteer from "puppeteer"

export interface PageClaimOptions {
  origin: string
  /** The project's slug: the page opens on its board, `/project/<slug>`, whose new-thread box an insert lands in. */
  project: string
  /** The chip token the insert should write, such as `@sample.ts:2-3`. */
  token: string
  shot?: string
  timeoutMs?: number
  /** Stop early (the suite already failed, or the harness is tearing down). */
  signal?: AbortSignal
  /** Called once the browser is up, with its process: a handle, not a pid, so a caller can tell it exited. */
  onBrowser?: (browser: ChildProcess | undefined) => void
  log?: (line: string) => void
}

export interface PageClaimResult {
  ok: boolean
  /** The new-thread box's text when it was last read. */
  value: string
  errors: string[]
}

const NEW_THREAD_BOX = '[data-surface="newComposer"]'

export async function watchPageClaim(options: PageClaimOptions): Promise<PageClaimResult> {
  const log = options.log ?? ((line: string) => console.log(`page-claim: ${line}`))
  const deadline = Date.now() + (options.timeoutMs ?? 240_000)
  const profile = mkdtempSync(join(tmpdir(), "ntwine-page-claim-"))
  // protocolTimeout well past puppeteer's 180s: a screenshot on a machine where a dozen agents are
  // compiling at once can take minutes, and the failure reads like a bug in the page (scripts/shot.mjs).
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"], userDataDir: profile, protocolTimeout: 600_000 })
  options.onBrowser?.(browser.process() ?? undefined)
  const errors: string[] = []
  let value = ""
  let ok = false
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1280, height: 860, deviceScaleFactor: 2 })
    await page.evaluateOnNewDocument(() => {
      Document.prototype.hasFocus = () => true
    })
    page.on("pageerror", (error) => void errors.push(String(error)))
    await page.goto(`${options.origin}/project/${encodeURIComponent(options.project)}`, { waitUntil: "domcontentloaded" })
    // A cold dev server optimizes its dependencies on the first load, which can take a minute.
    await page.waitForSelector(NEW_THREAD_BOX, { timeout: Math.max(1, Math.min(120_000, deadline - Date.now())) })
    log(`page ready on ${options.project}; waiting for ${options.token} in the new-thread box`)
    while (Date.now() < deadline && !options.signal?.aborted) {
      value = await page.evaluate((selector) => (document.querySelector(selector) as HTMLTextAreaElement | null)?.value ?? "", NEW_THREAD_BOX)
      if (value.includes(options.token)) {
        ok = true
        log(`the chip landed: ${JSON.stringify(value)}`)
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    if (options.shot) await page.screenshot({ path: options.shot }).catch((error: unknown) => void errors.push(`screenshot: ${String(error)}`))
  } catch (error) {
    errors.push(String(error))
  } finally {
    await browser.close().catch(() => undefined)
    rmSync(profile, { recursive: true, force: true })
  }
  if (!ok) log(`no chip: the new-thread box reads ${JSON.stringify(value)}`)
  if (errors.length) log(`page errors: ${errors.join(" | ")}`)
  return { ok, value, errors }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flag = (name: string) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
  const origin = flag("origin")
  const project = flag("project")
  const token = flag("token")
  if (!origin || !project || !token) {
    console.error("usage: nub packages/vscode/e2e/page-claim.ts --origin=<url> --project=<slug> --token=<@file:lines> [--shot=<png>] [--timeout-ms=<ms>]")
    process.exit(2)
  }
  const result = await watchPageClaim({ origin, project, token, shot: flag("shot"), timeoutMs: Number(flag("timeout-ms")) || undefined })
  console.log(result.ok ? "PAGE CLAIM OK" : "PAGE CLAIM FAILED")
  process.exit(result.ok ? 0 : 1)
}
