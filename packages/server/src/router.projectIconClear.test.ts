import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import type { AppContext } from "./context.ts"
import { readRegistry, registerProject, resolveProjectIcon } from "./project-registry.ts"
import { createRouter } from "./router.ts"

const A = "029a30af-f126-40e3-b04c-d80e74e3e090"
const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#e4572e"/></svg>`

/**
 * A sandbox home the ROUTER will actually read: `projectIconClear` reaches the registry through
 * helpers that default their `home` to `homedir()`, so the sandbox has to be `$HOME` itself or the
 * run rewrites the maintainer's own registry. node's runner gives each test FILE its own process.
 */
function homeSandbox(t: { after: (fn: () => void) => void }): { home: string; dir: string } {
  const home = mkdtempSync(join(tmpdir(), "frizz-icon-clear-"))
  mkdirSync(join(home, ".frizz"), { recursive: true })
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  process.env.HOME = home
  process.env.USERPROFILE = home
  t.after(() => {
    process.env.HOME = previous.HOME
    process.env.USERPROFILE = previous.USERPROFILE
    rmSync(home, { recursive: true, force: true })
  })
  const dir = join(home, "code", "keyward")
  mkdirSync(join(dir, ".frizz"), { recursive: true })
  writeFileSync(join(dir, ".frizz", ".id"), `${A}\n`)
  registerProject({ dir, id: A }, home)
  return { home, dir }
}

function router(home: string) {
  // Handlers are lazy, so the stub carries only what `createRouter` resolves up front.
  return createRouter({ project: { dir: home, stateDir: home, id: "own" }, storage: {}, board: {}, tailer: {} } as unknown as AppContext)
}

test("'Look for an icon again' scans on the spot and returns what it found", async (t) => {
  const { home, dir } = homeSandbox(t)
  // A miss is on record from before the logo existed — the state keyward was in on the real machine.
  resolveProjectIcon(A, () => undefined, { home })
  writeFileSync(join(dir, "logo.svg"), LOGO)

  const card = await router(home).projectIconClear.handler({ input: { id: A } })

  // The card answers the click itself. It used to come back `unknown`, leaving the looking to the
  // square's image request — which a square whose last request had failed never made.
  assert.equal(card.iconStatus, "icon")
  assert.ok(card.iconVersion, "a fresh version, so the square's URL is one no earlier failure answered for")
  assert.equal(readRegistry(home).projects[0]?.icon?.endsWith("logo.svg"), true)
})

test("looking again and finding nothing says so, rather than leaving the project unscanned", async (t) => {
  const { home } = homeSandbox(t)
  const card = await router(home).projectIconClear.handler({ input: { id: A } })
  assert.equal(card.iconStatus, "none")
  assert.ok(card.iconVersion)
})

test("looking again for a project that is not registered is refused", async (t) => {
  const { home } = homeSandbox(t)
  await assert.rejects(router(home).projectIconClear.handler({ input: { id: "not-a-project" } }), /No such project/)
})
