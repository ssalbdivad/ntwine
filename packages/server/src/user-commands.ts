// USER SLASH COMMANDS on disk — see UserCommand in @ntwine/shared for the format and the three places
// they are read from. Read on every listing rather than watched: a folder of small markdown files is
// cheap to scan, the composer asks once per page, and a command written by hand (or by another agent
// tool) then shows up without a restart.

import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { UserCommandName, type SaveUserCommandInput, type UserCommand, type UserCommandSource } from "@ntwine/shared"
import { ntwineRoots } from "./ntwine-paths.ts"

/** Where Ntwine's own commands live: beside its other data, wherever this machine resolved that to. */
export function ntwineCommandsDir(): string {
  return join(ntwineRoots().data, "commands")
}

/** The three folders, in precedence order: one written in Ntwine wins over a project's, which wins over
 *  the machine-wide one, so the operator's own edit is always what runs. */
export function userCommandDirs(projectDir: string | undefined, home = homedir()): Array<{ source: UserCommandSource; dir: string }> {
  return [
    { source: "ntwine", dir: ntwineCommandsDir() },
    ...(projectDir ? [{ source: "project" as const, dir: join(projectDir, ".agents", "commands") }] : []),
    { source: "global", dir: join(home, ".agents", "commands") },
  ]
}

/** One command file's text, read the way Claude Code and Cursor read it: an optional `---` frontmatter
 *  block (only `description` and `argument-hint` mean anything here), then the prompt. */
export function parseCommandFile(text: string): { description: string; argumentHint?: string; body: string } {
  const normalized = text.replace(/\r\n?/g, "\n")
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(normalized)
  const body = (fm ? normalized.slice(fm[0].length) : normalized).trim()
  let description = ""
  let argumentHint: string | undefined
  for (const line of fm?.[1]?.split("\n") ?? []) {
    const kv = /^([A-Za-z-]+):\s*(.*)$/.exec(line)
    if (!kv) continue
    const value = kv[2]!.trim().replace(/^(["'])(.*)\1$/, "$2")
    if (kv[1] === "description") description = value
    else if (kv[1] === "argument-hint" && value) argumentHint = value
  }
  // No description written: the prompt's first line says what it does better than nothing does.
  if (!description) description = body.split("\n").find((l) => l.trim())?.trim() ?? ""
  return { description: description.slice(0, 1024), ...(argumentHint ? { argumentHint: argumentHint.slice(0, 256) } : {}), body }
}

/** A command as a file: frontmatter only when there is something to put in it. */
export function formatCommandFile(input: Pick<SaveUserCommandInput, "description" | "argumentHint" | "body">): string {
  const lines: string[] = []
  const quote = (value: string) => (/[:#"'\n]|^\s|\s$/.test(value) ? JSON.stringify(value) : value)
  if (input.description.trim()) lines.push(`description: ${quote(input.description.trim().replace(/\n+/g, " "))}`)
  if (input.argumentHint?.trim()) lines.push(`argument-hint: ${quote(input.argumentHint.trim())}`)
  const body = `${input.body.replace(/\r\n?/g, "\n").trim()}\n`
  return lines.length > 0 ? `---\n${lines.join("\n")}\n---\n\n${body}` : body
}

export async function listUserCommands(projectDir: string | undefined, home = homedir()): Promise<UserCommand[]> {
  const seen = new Set<string>()
  const out: UserCommand[] = []
  for (const { source, dir } of userCommandDirs(projectDir, home)) {
    let names: string[]
    try {
      names = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort()
    } catch {
      continue // a folder that does not exist yet holds no commands
    }
    for (const file of names) {
      const name = file.slice(0, -3)
      if (seen.has(name) || !UserCommandName.safeParse(name).success) continue
      const path = join(dir, file)
      let text: string
      try {
        text = await readFile(path, "utf8") // follows symlinks, which is how ~/app shares its commands
      } catch {
        continue
      }
      const parsed = parseCommandFile(text)
      if (!parsed.body || parsed.body.length > 64 * 1024) continue
      seen.add(name)
      out.push({ name, ...parsed, source, path })
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** Write a Ntwine command, atomically, and drop the file it was renamed from. Only Ntwine's own folder is
 *  ever written: a project's or the machine-wide commands are read, never edited from here. */
export async function saveUserCommand(input: SaveUserCommandInput): Promise<void> {
  const dir = ntwineCommandsDir()
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${input.name}.md`)
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, formatCommandFile(input), "utf8")
  await rename(tmp, path)
  if (input.previousName && input.previousName !== input.name) await rm(join(dir, `${input.previousName}.md`), { force: true })
}

export async function deleteUserCommand(name: string): Promise<void> {
  await rm(join(ntwineCommandsDir(), `${name}.md`), { force: true })
}
