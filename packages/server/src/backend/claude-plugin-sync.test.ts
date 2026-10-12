import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { claudeClosureFingerprint, claudePluginSyncEnabled, createClaudePluginSync } from "./claude-plugin-sync.ts"

// ---- the closure's fingerprint: what a reload would re-read, and nothing it would not ----------------

/** A project and an operator config dir the test owns, and a way to write a file under either. */
function closureDirs() {
  const root = mkdtempSync(join(tmpdir(), "frizz-closure-"))
  const closure = { projectDir: join(root, "project"), configDir: join(root, "home", ".claude") }
  mkdirSync(closure.projectDir, { recursive: true })
  mkdirSync(closure.configDir, { recursive: true })
  const write = (path: string, content: string): void => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content) }
  return {
    closure, root,
    project: (rel: string, content: string) => write(join(closure.projectDir, ".claude", rel), content),
    operator: (rel: string, content: string) => write(join(closure.configDir, rel), content),
    print: () => claudeClosureFingerprint(closure),
  }
}

test("the closure moves when a skill, an agent or a command is added or edited, in the project or the operator's own directory", () => {
  const d = closureDirs()
  const seen = new Set([d.print()])
  const moved = (label: string): void => {
    const now = d.print()
    assert.ok(now, label)
    assert.ok(!seen.has(now), `${label} must move the fingerprint`)
    seen.add(now)
  }
  d.project("skills/review/SKILL.md", "---\nname: review\n---\n"); moved("a project skill")
  d.project("skills/review/SKILL.md", "---\nname: review\ndescription: now described\n---\n"); moved("an edited skill listing")
  d.project("agents/critic.md", "---\nname: critic\n---\nYou critique.\n"); moved("a project agent")
  d.project("commands/team/ship.md", "Ship it.\n"); moved("a namespaced project command")
  d.operator("skills/global/SKILL.md", "---\nname: global\n---\n"); moved("the operator's own skill")
  d.operator("agents/helper.md", "---\nname: helper\n---\n"); moved("the operator's own agent")
  d.operator("plugins/installed_plugins.json", JSON.stringify({ version: 2, plugins: {} })); moved("an installed plugin")
  assert.equal(d.print(), d.print(), "and asking twice with nothing changed answers the same")
})

// A skill's listing is its front matter. What sits beside it is read when the skill RUNS, so editing
// it needs no reload — and reloading every live worker on each save of a helper script would be noise.
test("a script beside a skill does not move the closure", () => {
  const d = closureDirs()
  d.project("skills/review/SKILL.md", "---\nname: review\n---\n")
  const before = d.print()
  d.project("skills/review/scripts/check.mjs", "console.log('v1')\n")
  d.project("skills/review/reference.md", "notes\n")
  assert.equal(d.print(), before)
})

// Claude Code rewrites settings.local.json on every permission grant. Read by stat, that would reload
// every live worker in the project each time one of them was allowed a command.
test("a settings file moves the closure only when its enabled plugins change", () => {
  const d = closureDirs()
  d.project("settings.local.json", JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] } }))
  const before = d.print()
  d.project("settings.local.json", JSON.stringify({ permissions: { allow: ["Bash(ls:*)", "Bash(git status:*)"] } }))
  assert.equal(d.print(), before, "a granted permission is not a plugin change")
  d.project("settings.local.json", JSON.stringify({ permissions: { allow: [] }, enabledPlugins: { "review@market": true } }))
  assert.notEqual(d.print(), before, "an enabled plugin is")
})

test("a closure that cannot be read right now has no fingerprint, so nothing reloads on it", () => {
  const d = closureDirs()
  assert.ok(d.print())
  d.project("settings.json", "{ \"enabledPlugins\": ") // caught mid-write
  assert.equal(d.print(), undefined)
  const missingPlugin = closureDirs()
  assert.equal(claudeClosureFingerprint({ ...missingPlugin.closure, pluginDir: join(missingPlugin.root, "gone") }), undefined)
})

// ---- the sync itself: when the daemon reloads, and what waits for it --------------------------------

/** A plugin whose fingerprint the test moves by hand, and a reload it settles by hand. */
function harness(options: { deadlineMs?: number } = {}) {
  const state = { fingerprint: "v1" as string | undefined, reloads: 0, log: [] as string[] }
  let settle: { resolve: (value: { errorCount?: number }) => void; reject: (error: Error) => void } | undefined
  const sync = createClaudePluginSync({
    fingerprint: () => state.fingerprint,
    reload: () => new Promise((resolve, reject) => { state.reloads++; settle = { resolve, reject } }),
    log: (message) => state.log.push(message),
    deadlineMs: options.deadlineMs,
  })
  return {
    sync, state,
    finishReload: (errorCount = 0) => settle!.resolve({ errorCount }),
    failReload: (message: string) => settle!.reject(new Error(message)),
  }
}

test("an unchanged plugin never costs a reload, at an input or at a turn end", () => {
  const h = harness()
  assert.equal(h.sync.beforeInput(true), null, "the input goes straight through")
  h.sync.turnEnded()
  assert.equal(h.sync.beforeRead(), null)
  assert.equal(h.state.reloads, 0)
})

test("a plugin that moved while the session was idle is reloaded before the next input, which waits for it", async () => {
  const h = harness()
  h.state.fingerprint = "v2"
  const held = h.sync.beforeInput(true)
  assert.ok(held, "the input is held behind the reload")
  assert.equal(h.state.reloads, 1)

  let released = false
  void held.then(() => { released = true })
  await Promise.resolve()
  assert.equal(released, false, "and stays held until the session has answered")
  h.finishReload()
  await held
  assert.equal(released, true)

  // The session is on v2 now; nothing reloads again until the plugin moves again.
  h.sync.turnEnded()
  assert.equal(h.sync.beforeInput(true), null)
  assert.equal(h.state.reloads, 1)
})

test("a plugin that moved DURING a turn waits for the turn to end", async () => {
  const h = harness()
  assert.equal(h.sync.beforeInput(true), null)
  h.state.fingerprint = "v2"
  // A steer into the running turn: mid-turn, so no reload starts and nothing is held.
  assert.equal(h.sync.beforeInput(true), null)
  assert.equal(h.sync.beforeRead(), null)
  assert.equal(h.state.reloads, 0, "never during a turn")

  h.sync.turnEnded()
  assert.equal(h.state.reloads, 1, "at the boundary")
  h.finishReload()
  await h.sync.beforeRead()
})

test("a turn the session opened by itself counts as a turn", () => {
  const h = harness()
  h.sync.turnActive() // output with no input from anyone: a background task's completion woke it
  h.state.fingerprint = "v2"
  assert.equal(h.sync.beforeInput(true), null)
  assert.equal(h.state.reloads, 0)
  h.sync.turnEnded()
  assert.equal(h.state.reloads, 1)
})

test("inputs that arrive behind one reload are released together, in arrival order", async () => {
  const h = harness()
  h.state.fingerprint = "v2"
  const order: string[] = []
  const first = h.sync.beforeInput(true)!
  const second = h.sync.beforeInput(true)!
  const addressed = h.sync.beforeInput(false)!
  void first.then(() => order.push("first"))
  void second.then(() => order.push("second"))
  void addressed.then(() => order.push("addressed"))
  assert.equal(h.state.reloads, 1, "one reload, however many inputs are waiting on it")
  h.finishReload()
  await addressed
  assert.deepEqual(order, ["first", "second", "addressed"])
})

test("a message addressed to a sub-agent never starts a reload and never opens a turn", () => {
  const h = harness()
  h.state.fingerprint = "v2"
  assert.equal(h.sync.beforeInput(false), null)
  assert.equal(h.state.reloads, 0)
  // The thread itself is still idle, so its next real input is what catches it up.
  assert.ok(h.sync.beforeInput(true))
  assert.equal(h.state.reloads, 1)
})

test("a plugin that cannot be read is never a reason to reload", () => {
  const h = harness()
  h.state.fingerprint = undefined // the link is mid-repoint, or the tree is being rewritten
  assert.equal(h.sync.beforeInput(true), null)
  h.sync.turnEnded()
  assert.equal(h.state.reloads, 0)
})

test("a failed reload releases the input, is retried once at the next boundary, then left alone", async () => {
  const h = harness()
  h.state.fingerprint = "v2"
  const held = h.sync.beforeInput(true)!
  h.failReload("plugins could not be reloaded")
  await held // released, not rejected: a reload that failed must not cost the operator their message
  assert.match(h.state.log.at(-1)!, /reload failed \(attempt 1\/2\): plugins could not be reloaded/)

  h.sync.turnEnded()
  assert.equal(h.state.reloads, 2, "one retry")
  h.failReload("still broken")
  await h.sync.beforeRead()

  h.sync.turnEnded()
  assert.equal(h.sync.beforeInput(true), null)
  assert.equal(h.state.reloads, 2, "the same broken plugin is not retried at every boundary for the rest of the session")

  // A DIFFERENT plugin state is a new question and gets its own tries.
  h.sync.turnEnded()
  h.state.fingerprint = "v3"
  assert.ok(h.sync.beforeInput(true))
  assert.equal(h.state.reloads, 3)
})

test("a reload that never answers is abandoned at the deadline, so a held input still goes", async () => {
  const h = harness({ deadlineMs: 20 })
  h.state.fingerprint = "v2"
  const held = h.sync.beforeInput(true)!
  await held
  assert.match(h.state.log.at(-1)!, /did not answer in time/)
})

test("a successful reload says so, and names load errors when there are any", async () => {
  const h = harness()
  h.state.fingerprint = "v2"
  const held = h.sync.beforeInput(true)!
  h.finishReload(2)
  await held
  assert.match(h.state.log.at(-1)!, /reloaded in place with 2 load error\(s\)/)
})

test("FRIZZ_PLUGIN_SYNC_OFF=1 is the opt-out, and nothing else is", () => {
  assert.equal(claudePluginSyncEnabled({}), true)
  assert.equal(claudePluginSyncEnabled({ FRIZZ_PLUGIN_SYNC_OFF: "0" }), true)
  assert.equal(claudePluginSyncEnabled({ FRIZZ_PLUGIN_SYNC_OFF: "1" }), false)
})
