import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installInvocation } from "../scripts/install.ts"

const vsix = "/home/Jane Doe/src/ntwine/packages/vscode/dist/ntwine-vscode-0.1.0.vsix"

test("the install command quotes the .vsix path where it goes through a shell, and only there", () => {
  assert.deepEqual(installInvocation("win32", "code", "C:\\Users\\Jane Doe\\ntwine\\x.vsix"), { file: "code", args: ["--install-extension", "\"C:\\Users\\Jane Doe\\ntwine\\x.vsix\"", "--force"], shell: true })
  assert.deepEqual(installInvocation("linux", "code", vsix), { file: "code", args: ["--install-extension", vsix, "--force"], shell: false })
  assert.deepEqual(installInvocation("darwin", "code", vsix).shell, false)
})

test("through a shell, the quoted path reaches the CLI as ONE argument (and the unquoted one as two)", { skip: process.platform === "win32" && "the stand-in CLI is a shebang script" }, () => {
  // Node joins a shell command's arguments unescaped (DEP0190) on every platform; this box's shell is
  // sh, not cmd.exe, but both read a double-quoted run of spaces as one word, which is the whole fix.
  const dir = mkdtempSync(join(tmpdir(), "ntwine-install-"))
  const cli = join(dir, "code")
  writeFileSync(cli, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)))\n`)
  chmodSync(cli, 0o755)
  const argv = (args: string[]) => JSON.parse(execFileSync(cli, args, { shell: true, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })) as string[]
  try {
    const invocation = installInvocation("win32", cli, vsix)
    assert.deepEqual(argv(invocation.args), ["--install-extension", vsix, "--force"])
    // Negative control: what the script did before — the path split at its space.
    assert.deepEqual(argv(["--install-extension", vsix, "--force"]), ["--install-extension", "/home/Jane", "Doe/src/ntwine/packages/vscode/dist/ntwine-vscode-0.1.0.vsix", "--force"])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
