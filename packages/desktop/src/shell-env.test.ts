import { test } from "node:test"
import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loginShellEnvironment, parseEnvBlock } from "./shell-env.ts"

test("the env block is read between the markers, whatever an rc file prints around it", () => {
  const marker = "__M__"
  const output = `Welcome back!\n${marker}\nPATH=/a:/b\nFUNC=() {\n  echo hi\n}\nEMPTY=\n${marker}\nbye\n`
  assert.deepEqual(parseEnvBlock(output, marker), { PATH: "/a:/b", FUNC: "() {\n  echo hi\n}", EMPTY: "" })
  assert.equal(parseEnvBlock("PATH=/a\n", marker), undefined)
})

const posix = process.platform !== "win32"

test("a real login shell's environment is merged over the inherited one", { skip: !posix }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-desktop-shell-"))
  try {
    // A shell whose rc prints a banner and extends PATH — the nvm-in-.zshrc case.
    const shell = join(dir, "fake-shell")
    writeFileSync(shell, `#!/bin/sh\necho "rc banner"\nPATH="/opt/from-rc:$PATH"; export PATH\nexec /bin/sh "$@"\n`)
    chmodSync(shell, 0o755)
    const env = await loginShellEnvironment({ SHELL: shell, PATH: "/usr/bin:/bin", KEEP_ME: "1" }, "linux")
    assert.equal(env.PATH?.startsWith("/opt/from-rc:"), true, env.PATH)
    assert.equal(env.KEEP_ME, "1")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a shell that hangs or fails leaves the inherited environment in charge", { skip: !posix }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-desktop-shell-"))
  try {
    const hung = join(dir, "hung-shell")
    writeFileSync(hung, "#!/bin/sh\nexec sleep 30\n")
    chmodSync(hung, 0o755)
    const base = { SHELL: hung, PATH: "/usr/bin:/bin" }
    const started = Date.now()
    assert.deepEqual(await loginShellEnvironment(base, "linux", 300), base)
    assert.ok(Date.now() - started < 5_000)
    assert.deepEqual(await loginShellEnvironment({ SHELL: join(dir, "missing"), PATH: "/bin" }, "linux"), { SHELL: join(dir, "missing"), PATH: "/bin" })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("Windows GUI apps already have the user's PATH", async () => {
  const base = { Path: "C:\\nodejs" }
  assert.equal(await loginShellEnvironment(base, "win32"), base)
})
