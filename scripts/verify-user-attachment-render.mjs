// The human's OWN attachments must render as the picture, not as a wall of absolute path text.
//
// The composer parks attached files in the draft as TRAILING standalone absolute-path lines
// (joinComposerValue) and presents them as chips, so a SENT message carries those paths as message
// text. splitProseAttachments only ever ran on the ASSISTANT branch, so an agent's screenshot path
// became an inline <img> while the human's own attachment stayed mono path text in the bubble.
//
// This drives the REAL pipeline for that fix — JSONL → tailer → transcript → ChatView → /local-image —
// with a simulated worker, and asserts the five shapes that matter, including the two CONTROLS that
// must not change. A fixture can't cover this: the ntwine server mounts Vite with appType "custom", so
// every *.html falls back to index.html and only the real thread route renders a real transcript.
//
// Usage: nub scripts/verify-user-attachment-render.mjs --port=4931 --home=/abs/temp-home
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync, copyFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import { createRpcClient } from "./lib/rpc-client.mjs"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"
import { recordPageErrors } from "./lib/page-errors.mjs"

const args = process.argv.slice(2)
const opt = (k, d) => { const hit = args.find((a) => a.startsWith(`--${k}=`)); return hit ? hit.slice(k.length + 3) : d }
const port = Number(opt("port", "4931"))
const home = opt("home")
const cwd = opt("project", process.cwd())
if (!home) throw new Error("--home=<stack temp HOME> is required (the adhoc stack prints it as `home`)")

const SLUG = "attachment-render-check"
// A FRESH session id per run: the server's transcript projection is cached per session, so reusing a
// fixed id makes a re-run silently assert against the previous run's parse (it did, first time out).
const SESSION_ID = randomUUID()
const now = new Date().toISOString()

// A real PNG the unconfined /local-image resolver can serve, plus two safe-tier docs for the chips.
const assets = join(tmpdir(), "ntwine-user-attachment-verify")
mkdirSync(assets, { recursive: true })
const SHOT = join(assets, "shot.png")
const PDF = join(assets, "spec.pdf")
const SVG = join(assets, "logo.svg")
// Copied EVERY run when the real icon is there: guarding the copy on `!existsSync(SHOT)` let a 1x1
// fallback written by one run from a directory without the icon stand in for every later run's
// "screenshot", so the frame shrink-wrapped a single pixel.
{
  const icon = join(cwd, "packages", "web", "public", "icon-512.png")
  if (existsSync(icon)) copyFileSync(icon, SHOT)
  else if (!existsSync(SHOT)) writeFileSync(SHOT, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"))
}
writeFileSync(PDF, "%PDF-1.4 stub")
writeFileSync(SVG, '<svg xmlns="http://www.w3.org/2000/svg"/>')

// ---- seed a simulated worker (the session row is the fixture; the records drive the real tailer) ----
const logDir = join(home, ".claude", "projects", cwd.replace(/[/.]/g, "-"))
mkdirSync(logDir, { recursive: true })
const base = { isSidechain: false, userType: "external", cwd, sessionId: SESSION_ID, version: "2.1.220", gitBranch: "main" }
const records = []
let n = 0
const push = (rec) => records.push({ ...base, ...rec, parentUuid: records.length ? records.at(-1).uuid : null, uuid: `0000000${++n}-0000-0000-0000-000000000000`.slice(-36), timestamp: now })
const user = (text) => push({ type: "user", message: { role: "user", content: text } })
const assistant = (text) => push({ type: "assistant", message: { role: "assistant", model: "claude-opus-5", stop_reason: "end_turn", content: [{ type: "text", text }] } })

user(`The horizontal spacing on this footer is absolutely horrendous. \n${SHOT}`)   // the reported case
assistant("Looking at the footer now.")
user(["Review these before we start.", SHOT, PDF, SVG].join("\n"))                  // image + doc chips
assistant("Got all three.")
user(SHOT)                                                                          // no prose at all
assistant("Seen.")
user(`Check ${SHOT} and then read\n${join(assets, "notes.txt")}\nbefore replying.`)  // CONTROL: mid-message
assistant("Understood.")
user("No attachments here — just the ordinary bubble, unchanged.")                   // CONTROL: plain prose

writeFileSync(join(logDir, `${SESSION_ID}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")

const threadName = `ntwine-${SLUG}`

const sandbox = resolveSandboxDb(home)
const { db } = sandbox
// The unified schema keys every row by project and the column is NOT NULL; the legacy one has no
// such column. `sessionProjectColumns` yields the right prefix pair for whichever this sandbox is.
const { cols: sessionCols, vals: sessionVals } = sessionProjectColumns(sandbox)
execFileSync("sqlite3", [db, `DELETE FROM session WHERE slug = '${SLUG}';`])
execFileSync("sqlite3", [db, `INSERT OR REPLACE INTO session
  (${sessionCols}slug, session_id, thread_name, spawned_at, title, backend, model, effort, permission_mode, unread, exited, archived, title_auto, runtime_generation, profile_revision)
  VALUES (${sessionVals}'${SLUG}', '${SESSION_ID}', '${threadName}', '${now}', 'Attachment render check', 'claude', 'opus', 'high', 'default', 0, 0, 0, 0, 0, 0);`])

const api = createRpcClient(`http://127.0.0.1:${port}/`)
await api.waitForHealth()

// ---- drive the real thread route ----
const { launchHeadless } = await import("./lib/headless-browser.mjs")
const browser = await launchHeadless()
const failures = []
const pageErrors = []
const check = (ok, label, detail) => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ""}`) }
try {
  const page = await browser.newPage()
  recordPageErrors(page, pageErrors)
  await page.setViewport({ width: 1400, height: 1000, deviceScaleFactor: 1 })
  // The thread's drawer on the one page (rpc-client threadUrl); the bare `/thread/<slug>` it opened until
  // 2026-09-28 now lands on `/`.
  await page.goto(await api.threadUrl(SLUG), { waitUntil: "networkidle0" })
  // Everything below is measured INSIDE the drawer. The one page keeps its queue cards rendered behind
  // an open drawer, and this thread's own Ready card draws the human's last message as an "asked" bubble
  // (AllQueuesCard.tsx) — page-wide, it counted as extra transcript bubbles and, sitting first in the
  // DOM, its right edge became the "bubble edge" every attachment was measured against.
  const DRAWER = "[data-drawer-layer]"
  await page.waitForSelector(`${DRAWER} img[data-local-image]`, { timeout: 20_000 })

  const seen = await page.evaluate((DRAWER) => {
    const rect = (el) => el.getBoundingClientRect()
    const all = (sel) => [...document.querySelectorAll(`${DRAWER} ${sel}`)]
    return {
      bubbles: all(".bg-user-bubble").map((b) => b.textContent),
      images: all("img[data-local-image]").map((i) => ({ path: i.dataset.localPath, w: i.naturalWidth })),
      chips: all(".local-file-action").map((b) => ({ path: b.dataset.localPath, top: Math.round(rect(b).top), right: Math.round(rect(b).right) })),
      bubbleRights: all(".bg-user-bubble").map((b) => Math.round(rect(b).right)),
      // The FRAME's edge, not the <img>'s. Every rendered image sits in ImageFrame (2026-08-02, 8c3eeb03):
      // a 1px `ntwine-bash` border around a p-1.5 mat, the picture centered inside it. The frame is the
      // visible object that lines up with the bubble; the <img> sits 7px inside it by design.
      imageRights: all("img[data-local-image]").map((i) => Math.round(rect(i.closest("figure") ?? i).right)),
    }
  }, DRAWER)

  // Three of the five user messages carry the screenshot, and each one served REAL bytes.
  check(seen.images.length === 3, "three attached images render inline", `saw ${seen.images.length}`)
  check(seen.images.every((i) => i.path === SHOT && i.w > 0), "every image loaded through /local-image", JSON.stringify(seen.images))
  // The reported case: prose kept, path gone from the bubble.
  const reported = seen.bubbles.find((t) => t.includes("absolutely horrendous"))
  check(Boolean(reported), "the reported message still shows its prose")
  check(!seen.bubbles.some((t) => t.includes(SHOT) && t.includes("horrendous")), "the peeled path is NOT printed in that bubble", reported)
  // Attachment-only send: four bubbles for five user messages — the empty one is skipped.
  check(seen.bubbles.length === 4, "an attachment-only send renders no empty bubble", `saw ${seen.bubbles.length} bubbles`)
  // Docs: openable chips, sharing ONE wrapping row, flush with the bubble's right edge.
  check(seen.chips.length === 2 && seen.chips.some((c) => c.path === PDF) && seen.chips.some((c) => c.path === SVG), "both docs render as openable chips", JSON.stringify(seen.chips))
  check(new Set(seen.chips.map((c) => c.top)).size === 1, "the doc chips share one wrapping row", JSON.stringify(seen.chips.map((c) => c.top)))
  const edge = seen.bubbleRights[0]
  check([...seen.chips.map((c) => c.right), ...seen.imageRights].every((r) => Math.abs(r - edge) <= 1 || r < edge), "attachments stay within the bubble's right edge", `edge=${edge}`)
  check(seen.imageRights.every((r) => r === edge), "images sit flush with the bubble's right edge", `edge=${edge} vs ${seen.imageRights}`)
  // CONTROL: a path typed mid-message is still the human's own words.
  check(seen.bubbles.some((t) => t.includes(SHOT) && t.includes("before replying")), "a path typed MID-message stays in the bubble text")
  // CONTROL: plain prose untouched.
  check(seen.bubbles.some((t) => t.includes("just the ordinary bubble")), "ordinary prose renders unchanged")
  check(pageErrors.length === 0, "no console or page errors", pageErrors.join(" | "))
} finally {
  await browser.close()
}

console.log(failures.length ? `\n${failures.length} FAILED:\n- ${failures.join("\n- ")}` : "\nall checks passed")
process.exit(failures.length ? 1 : 0)
