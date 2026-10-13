import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

// WHAT THE .vsix CARRIES. `.vscodeignore` drops everything and re-admits a list, so a file the manifest
// names but the list forgets packages without a word from vsce — and the editor shows its absence, not
// an error: the activity bar painted a solid grey square where the Ntwine icon belonged (2026-10-01), on
// an install whose vsix had no media/ntwine.svg. These pin the list to the manifest instead.

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..")
const manifest = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")) as {
  main: string
  icon: string
  contributes: {
    viewsContainers: Record<string, { icon: string }[]>
    commands: { icon?: string | { light: string; dark: string } }[]
  }
}
const admitted = new Set(
  readFileSync(join(pkg, ".vscodeignore"), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("!"))
    .map((line) => line.slice(1)),
)
const normalize = (path: string) => path.replace(/^\.\//u, "")

test("every file the manifest names is one .vscodeignore lets into the package", () => {
  const named = [manifest.main, manifest.icon]
  for (const containers of Object.values(manifest.contributes.viewsContainers)) for (const container of containers) named.push(container.icon)
  for (const command of manifest.contributes.commands) {
    // `$(codicon)` is the editor's own glyph; anything else is a file in the package.
    if (typeof command.icon === "string" && !command.icon.startsWith("$(")) named.push(command.icon)
    else if (command.icon && typeof command.icon === "object") named.push(command.icon.light, command.icon.dark)
  }
  for (const path of named.map(normalize)) assert.ok(admitted.has(path), `${path} is named in package.json but .vscodeignore leaves it out of the .vsix`)
  // The ones that are sources rather than build output are there to be packaged.
  for (const path of named.map(normalize).filter((path) => !path.startsWith("dist/"))) assert.ok(existsSync(join(pkg, path)), `${path} is missing`)
})

test("the activity-bar mark's pen is 0.7/16 of its box: 70% of a codicon's, and at least a device pixel at 24px", () => {
  // Measured, not taste (media/ntwine.svg's own comment has the readings): the bar draws the mark at 16px
  // when it sits at the top and 24px at the side. A codicon's pen (1/16) drew 1.7x the ink of the codicons
  // beside it, the fff being three loops and a crossbar; 0.7 brings it to ~1.2x their mean, under
  // Explorer's. Below one device pixel Chromium draws the stroke as a grey hairline, so at 24px on a 1x
  // screen the pen must stay at or over 1px — 0.65 (0.975px) went grey. Re-measure before changing it.
  const svg = readFileSync(join(pkg, "media", "ntwine.svg"), "utf8")
  const [, , width, height] = /viewBox="([^"]+)"/u.exec(svg)![1]!.split(/\s+/u).map(Number)
  const stroke = Number(/stroke-width="([^"]+)"/u.exec(svg)![1])
  assert.equal(width, height, "a square box, as the bar's mask is")
  assert.ok(Math.abs((stroke * 16) / width! - 0.7) < 0.01, `stroke ${stroke} on a ${width}-unit box`)
  assert.ok((stroke * 24) / width! >= 1, "at 24px on a 1x screen the pen is at least one device pixel")
  assert.match(svg, /stroke="currentColor"/u, "one colour: the bar paints the mark as a mask")
})
