import { test } from "node:test"
import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loginShellEnvironment, parseEnvBlock, withoutElectronVariables } from "./shell-env.ts"

const marker = "__M__"

test("the env block is read between the markers, whatever an rc file prints around it", () => {
  const lines = `Welcome back!\n${marker}\nPATH=/a:/b\nFUNC=() {\n  echo hi\n}\nEMPTY=\n\n${marker}\nbye\n`
  assert.deepEqual(parseEnvBlock(lines, marker), { PATH: "/a:/b", FUNC: "() {\n  echo hi\n}", EMPTY: "" })
  assert.equal(parseEnvBlock("PATH=/a\n", marker), undefined)
  assert.equal(parseEnvBlock(`${marker}\nPATH=/a\n`, marker), undefined, "an unterminated block is not a block")
})

test("without env -0, an exported bash function does not run on into the variable before it", () => {
  const lines = `${marker}\nPATH=/a:/b\nBASH_FUNC_nvm%%=() {  local x=1;\n  echo "$x"\n}\nHOME=/h\n${marker}\n`
  assert.deepEqual(parseEnvBlock(lines, marker), { PATH: "/a:/b", HOME: "/h" })
})

test("with env -0, a bash function or a value with newlines stays its own variable", () => {
  const nul = `${marker}\nPATH=/a:/b\0BASH_FUNC_nvm%%=() {\n  x=1\n}\0MULTI=one\ntwo\0\n${marker}\n`
  assert.deepEqual(parseEnvBlock(nul, marker), { PATH: "/a:/b", "BASH_FUNC_nvm%%": "() {\n  x=1\n}", MULTI: "one\ntwo" })
})

test("what Electron sets for Chromium is not handed on to the server", () => {
  assert.deepEqual(
    withoutElectronVariables({ PATH: "/bin", CHROME_DESKTOP: "frizz-desktop.desktop", FC_FONTATIONS: "1", ELECTRON_RUN_AS_NODE: "1", HOME: "/h" }),
    { PATH: "/bin", HOME: "/h" },
  )
})

const posix = process.platform !== "win32"

function fakeShell(dir: string, name: string, body: string): string {
  const path = join(dir, name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

test("a real login shell's environment is merged over the inherited one", { skip: !posix }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-desktop-shell-"))
  try {
    // A shell whose rc prints a banner and extends PATH — the nvm-in-.zshrc case.
    const shell = fakeShell(dir, "fake-shell", `echo "rc banner"\nPATH="/opt/from-rc:$PATH"; export PATH\nexec /bin/sh "$@"`)
    const env = await loginShellEnvironment({ SHELL: shell, PATH: "/usr/bin:/bin", KEEP_ME: "1", CHROME_DESKTOP: "x.desktop" }, "linux")
    assert.equal(env.PATH?.startsWith("/opt/from-rc:"), true, env.PATH)
    assert.equal(env.PATH?.includes("\n"), false, "PATH picked up a stray newline")
    assert.equal(env.KEEP_ME, "1")
    assert.equal(env.CHROME_DESKTOP, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a background job the rc file leaves running does not hold the launch hostage", { skip: !posix }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-desktop-shell-"))
  try {
    // `sleep` inherits stdout and outlives the shell, so the pipe stays open for 30s.
    const shell = fakeShell(dir, "rc-with-job", `sleep 30 &\nexec /bin/sh "$@"`)
    const started = Date.now()
    const env = await loginShellEnvironment({ SHELL: shell, PATH: "/usr/bin:/bin" }, "linux", 20_000)
    assert.ok(Date.now() - started < 5_000, `took ${Date.now() - started}ms`)
    // The login shell's profile ran (Ubuntu's appends /snap/bin), so this is the shell's env, not ours.
    assert.equal(env.PATH?.startsWith("/usr/bin:/bin"), true, env.PATH)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a shell that hangs or fails leaves the inherited environment in charge", { skip: !posix }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-desktop-shell-"))
  try {
    const hung = fakeShell(dir, "hung-shell", "exec sleep 30")
    const base = { SHELL: hung, PATH: "/usr/bin:/bin" }
    const started = Date.now()
    assert.deepEqual(await loginShellEnvironment(base, "linux", 300), base)
    assert.ok(Date.now() - started < 5_000)
    const missing = { SHELL: join(dir, "missing"), PATH: "/bin" }
    assert.deepEqual(await loginShellEnvironment(missing, "linux"), missing)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("Windows GUI apps already have the user's PATH", async () => {
  const base = { Path: "C:\\nodejs", ELECTRON_RUN_AS_NODE: "1" }
  assert.deepEqual(await loginShellEnvironment(base, "win32"), { Path: "C:\\nodejs" })
})
