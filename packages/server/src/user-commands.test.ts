import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, existsSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { resetNtwineRoots } from "./ntwine-paths.ts"
import { deleteUserCommand, formatCommandFile, ntwineCommandsDir, listUserCommands, parseCommandFile, saveUserCommand } from "./user-commands.ts"

// A throwaway data root (XDG_DATA_HOME is how every harness here isolates ntwine) and a throwaway home.
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "ntwine-user-commands-"))
  process.env.XDG_DATA_HOME = join(root, "data")
  resetNtwineRoots()
  const home = join(root, "home")
  const project = join(root, "project")
  mkdirSync(join(home, ".agents", "commands"), { recursive: true })
  mkdirSync(join(project, ".agents", "commands"), { recursive: true })
  return { home, project }
}

test("a command file reads the way Claude Code and Cursor read it", () => {
  assert.deepEqual(parseCommandFile("---\ndescription: \"Commit: tersely\"\nargument-hint: <msg>\n---\n\nlook at git status\n"), {
    description: "Commit: tersely",
    argumentHint: "<msg>",
    body: "look at git status",
  })
  // No frontmatter (every command in ~/app): the prompt's first line stands in for a description.
  assert.deepEqual(parseCommandFile("spin up dev server\r\ndo not sleep\r\n"), { description: "spin up dev server", body: "spin up dev server\ndo not sleep" })
})

test("a saved file parses back to what was saved, frontmatter only when needed", () => {
  const written = formatCommandFile({ description: "Ship it: now", body: "commit and push\n" })
  assert.equal(written, '---\ndescription: "Ship it: now"\n---\n\ncommit and push\n')
  assert.deepEqual(parseCommandFile(written), { description: "Ship it: now", body: "commit and push" })
  assert.equal(formatCommandFile({ description: "", body: "x" }), "x\n")
})

test("the three folders are read in precedence order — ntwine's own, the project's, then ~/.agents", async () => {
  const { home, project } = sandbox()
  writeFileSync(join(home, ".agents", "commands", "commit.md"), "global commit")
  writeFileSync(join(home, ".agents", "commands", "dev.md"), "global dev")
  writeFileSync(join(project, ".agents", "commands", "dev.md"), "project dev")
  writeFileSync(join(project, ".agents", "commands", "not a name.md"), "skipped")
  writeFileSync(join(project, ".agents", "commands", "notes.txt"), "skipped")
  await saveUserCommand({ name: "commit", description: "mine", body: "ntwine commit" })
  const listed = await listUserCommands(project, home)
  assert.deepEqual(listed.map((c) => [c.name, c.source, c.body]), [
    ["commit", "ntwine", "ntwine commit"],
    ["dev", "project", "project dev"],
  ])
  assert.equal(listed[0]!.path, join(ntwineCommandsDir(), "commit.md"))
})

test("a symlinked command is read through its link, the way ~/app shares its commands", async () => {
  const { home } = sandbox()
  const real = join(home, ".agents", "real.md")
  writeFileSync(real, "linked prompt")
  symlinkSync(real, join(home, ".agents", "commands", "linked.md"))
  assert.deepEqual((await listUserCommands(undefined, home)).map((c) => c.body), ["linked prompt"])
})

test("a rename removes the old file; delete removes ntwine's own file and nothing else", async () => {
  const { home } = sandbox()
  writeFileSync(join(home, ".agents", "commands", "keep.md"), "global")
  await saveUserCommand({ name: "old", description: "", body: "x" })
  await saveUserCommand({ name: "new", description: "", body: "x", previousName: "old" })
  assert.equal(existsSync(join(ntwineCommandsDir(), "old.md")), false)
  assert.equal(readFileSync(join(ntwineCommandsDir(), "new.md"), "utf8"), "x\n")
  await deleteUserCommand("keep")
  await deleteUserCommand("new")
  assert.deepEqual((await listUserCommands(undefined, home)).map((c) => `${c.source}:${c.name}`), ["global:keep"])
})
