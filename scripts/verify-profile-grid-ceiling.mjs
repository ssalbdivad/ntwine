// Drive the profile-grid ceiling fixture in a real browser and MEASURE the matrix, with no frizz server.
//
// The bug: codex's top rung is "ultra" and Claude Code's is "ultracode", so the union of effort names
// gave each its own column and every Claude row ghosted a hole where "ultra" sits — ULTRACODE rendered a
// full empty column clear of MAX. This script asserts the two things a screenshot alone cannot settle:
// the gap between MAX and the ceiling cell is the SAME as every other inter-cell gap, and each column's
// cells share one left edge across every row of both providers.
//
//   node scripts/verify-profile-grid-ceiling.mjs [--port=5203] [--font=sans|mono] [--shots=DIR]
import { spawn } from "node:child_process"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { launchHeadless } from "./lib/headless-browser.mjs"

const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")))
const port = Number(flags.port ?? 5203)
const font = flags.font === "mono" ? "mono" : "sans"
const shotDir = flags.shots ?? join(tmpdir(), "frizz-profile-grid-ceiling")
mkdirSync(shotDir, { recursive: true })

let failures = 0
const check = (label, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}

const vite = spawn("npx", ["vite", "--port", String(port), "--strictPort", "--host", "127.0.0.1"], {
  cwd: new URL("../packages/web/", import.meta.url).pathname,
  stdio: ["ignore", "pipe", "pipe"],
})
const viteLog = []
vite.stdout.on("data", (d) => viteLog.push(String(d)))
vite.stderr.on("data", (d) => viteLog.push(String(d)))
const stopVite = () => { try { vite.kill("SIGTERM") } catch {} }
process.on("exit", stopVite)

const base = `http://127.0.0.1:${port}/profile-grid-ceiling-fixture.html?font=${font}`
for (let i = 0; ; i++) {
  try { if ((await fetch(base)).ok) break } catch {}
  if (i > 120) { console.error("vite never came up:\n" + viteLog.join("")); stopVite(); process.exit(1) }
  await new Promise((r) => setTimeout(r, 250))
}

const browser = await launchHeadless()
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 900, height: 640, deviceScaleFactor: 3 })
  const pageErrors = []
  page.on("pageerror", (error) => pageErrors.push(String(error)))
  page.on("console", (message) => { if (message.type() === "error") pageErrors.push(message.text()) })
  await page.goto(base, { waitUntil: "networkidle0" })
  await page.click("[aria-label='Thread model and effort']")
  await page.waitForSelector("[data-profile-grid-row]")
  await new Promise((r) => setTimeout(r, 250))

  const matrix = await page.evaluate(() => {
    // Cell boxes, not ink: these are bordered/padded controls on a uniform grid, so the box edges ARE
    // what the eye reads as the column rhythm. Ink offsets differ per label and are not the question.
    const rows = [...document.querySelectorAll("[data-profile-grid-row]")].map((row) => {
      // DIRECT children only: a cell whose column holds a wider name stacks that name invisibly inside
      // itself as a width holder, and a descendant query would count that holder as a seventh column.
      const cells = [...row.querySelectorAll(":scope > [role='menuitemradio'], :scope > span[aria-hidden='true']")].map((cell) => ({
        label: (cell.querySelector("span > span:not([aria-hidden='true'])") ?? cell).textContent.trim(),
        ghost: cell.getAttribute("aria-hidden") === "true",
        left: cell.getBoundingClientRect().left,
        right: cell.getBoundingClientRect().right,
      }))
      return { model: row.dataset.profileGridRow, cells }
    })
    // What the EYE reads is the label, not the padded box: a cell clamped to its 2.75rem minimum is
    // wider than its word, so measure the rendered text run itself.
    const labels = [...document.querySelectorAll("[data-profile-grid-row]")].map((row) => {
      const runs = [...row.querySelectorAll(":scope > [role='menuitemradio']")].map((cell) => {
        const text = cell.querySelector("span > span:not([aria-hidden='true'])") ?? cell
        const range = document.createRange()
        range.selectNodeContents(text)
        const box = range.getBoundingClientRect()
        return { label: text.textContent.trim(), left: box.left, right: box.right }
      })
      return { model: row.dataset.profileGridRow, runs }
    })
    return { rows, labels }
  })

  const round = (n) => Math.round(n * 100) / 100
  const columnCount = new Set(matrix.rows.map((row) => row.cells.length))
  check("every row renders the same number of columns", columnCount.size === 1, `counts: ${[...columnCount].join(", ")}`)
  check("the matrix is six rungs wide, not seven", [...columnCount][0] === 6, `columns: ${[...columnCount][0]}`)

  for (const row of matrix.rows) {
    const gaps = row.cells.slice(1).map((cell, i) => round(cell.left - row.cells[i].right))
    const spread = round(Math.max(...gaps) - Math.min(...gaps))
    check(`${row.model}: uniform gaps across the row`, spread < 0.5, `gaps ${gaps.join(", ")}`)
  }

  const columns = matrix.rows[0].cells.map((_, i) => matrix.rows.map((row) => round(row.cells[i].left)))
  columns.forEach((lefts, i) => {
    const spread = round(Math.max(...lefts) - Math.min(...lefts))
    check(`column ${i} shares one left edge across all rows`, spread < 0.5, `lefts ${lefts.join(", ")}`)
  })

  const ceiling = matrix.rows.map((row) => ({ model: row.model, ...row.cells.at(-1) }))
  check(
    "the ceiling column carries each provider's own name",
    ceiling.some((cell) => !cell.ghost && cell.label === "Ultracode") && ceiling.some((cell) => !cell.ghost && cell.label === "Ultra"),
    ceiling.map((cell) => `${cell.model}=${cell.ghost ? "(ghost)" : cell.label}`).join(" "),
  )

  // Every label starts on its column's own left edge — that is what left alignment buys, and the
  // reason the ceiling's short "Ultra" no longer floats. The TRAILING space after a short label
  // varies by design (a cell holds its column, a word does not), so it is reported, not asserted.
  const labelColumns = matrix.labels[0].runs.map((_, i) => matrix.labels.filter((row) => row.runs[i]).map((row) => round(row.runs[i].left)))
  labelColumns.forEach((lefts, i) => {
    const spread = round(Math.max(...lefts) - Math.min(...lefts))
    check(`column ${i}: every label starts on one left edge`, spread < 0.5, `lefts ${lefts.join(", ")}`)
  })
  for (const row of matrix.labels) {
    const gaps = row.runs.slice(1).map((run, i) => round(run.left - row.runs[i].right))
    console.log(`      ${row.model}: label gaps ${gaps.join(", ")}`)
  }

  const menu = await page.$(".profile-grid-menu")
  await menu.screenshot({ path: join(shotDir, `menu-${font}.png`) })
  await page.screenshot({ path: join(shotDir, `page-${font}.png`) })
  console.log(`\nshots: ${join(shotDir, `menu-${font}.png`)}`)
  check("no page errors", pageErrors.length === 0, pageErrors.join(" | "))
} finally {
  await browser.close()
  stopVite()
}

process.exit(failures === 0 ? 0 : 1)
