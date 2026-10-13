import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

// Everything Ntwine serves lives under `/_ntwine/` (c34a7e2), and a page addresses its OWN project via
// apiBase() — so a client URL built as a bare `/local-image?…` reaches the SPA shell instead of the
// route, gets HTML back, and the <img> fires onError. That is invisible in review and invisible in
// the type system: it presents as an attachment thumbnail that silently degrades to a file tile and a
// chat screenshot that degrades to grey path text, which is exactly how it shipped and how it was
// found. The prefix sweep already missed markdownTargets once; it then missed BlockImage, the composer
// chip, the Codex template preview and the visualization iframe. This is the pin that ends that class.
//
// It scans SOURCE, not behavior, because there is nowhere else the whole set is visible at once.

const SRC = fileURLToPath(new URL("..", import.meta.url))

// Every top-level route name the server mounts under the prefix (app.ts, app-socket.ts, index.ts).
const ROUTE_NAMES = ["health", "control", "local-image", "project-icon", "local-visualization", "attach", "events", "rpc", "ws", "term"]
const BARE_ROUTE = new RegExp(String.raw`["'\`]/(?:${ROUTE_NAMES.join("|")})(?:[/?"'\`]|$)`)

// Comments talk about these routes by name constantly ("the gated `/local-image` route"), and a
// backtick in prose is indistinguishable from a template literal to a regex. Strip both comment forms
// before scanning so the guard fires on code only.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/([^:"'`\\])\/\/[^"'`\n]*$/gm, "$1")
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(entry.name) ? [path] : []
  })
}

test("no client URL addresses an Ntwine route without the /_ntwine prefix", () => {
  const offenders: string[] = []
  for (const file of sourceFiles(SRC)) {
    const lines = stripComments(readFileSync(file, "utf8")).split("\n")
    lines.forEach((line, i) => {
      if (BARE_ROUTE.test(line)) offenders.push(`${file.slice(SRC.length)}:${i + 1}: ${line.trim()}`)
    })
  }
  assert.deepEqual(offenders, [], `build these through apiBase()/localImageUrl(), not a bare path:\n${offenders.join("\n")}`)
})
