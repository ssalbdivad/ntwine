import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { quoteWindowsArg, serverCommand, type ServerLaunch } from "./launch.ts"

test("the launch runs the launcher in the repo on the recorded PATH, appending to a log it creates", () => {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-desktop-launch-"))
  try {
    // A stand-in nub that reports what it was run with. Paths with spaces and quotes, since a PATH or
    // a home directory can carry either and the command passes them through `sh -c`.
    const bin = join(dir, "bin 'x'")
    const nub = join(bin, "nub")
    spawnSync("mkdir", ["-p", bin])
    writeFileSync(nub, '#!/bin/sh\necho "pwd=$(pwd) path=$PATH source=$NTWINE_SOURCE_COMMAND args=$*"\necho oops >&2\n')
    chmodSync(nub, 0o755)
    const launch: ServerLaunch = { repo: dir, nub, path: `${bin}:/usr/bin:/bin`, log: join(dir, "state dir", "desktop-server.log") }
    const [command, args] = serverCommand(launch)
    for (let run = 0; run < 2; run++) assert.equal(spawnSync(command, args, { cwd: dir, env: {} }).status, 0)
    const line = `pwd=${dir} path=${bin}:/usr/bin:/bin source=ntwine-dev args=--no-env-file src/index.ts --no-app\noops\n`
    assert.equal(readFileSync(launch.log, "utf8"), line + line)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("from Windows, the same command runs inside the distro, in the repo, in a session of its own", () => {
  const launch: ServerLaunch = { repo: "/home/me/ntwine", nub: "/n/nub", path: "/n", log: "/l", distro: "Ubuntu", roots: { data: "\\\\wsl.localhost\\Ubuntu\\d", state: "\\\\wsl.localhost\\Ubuntu\\s" } }
  const [command, args] = serverCommand(launch)
  const [linuxCommand, linuxArgs] = serverCommand({ ...launch, distro: undefined })
  assert.equal(command, "wsl.exe")
  assert.deepEqual(args, ["-d", "Ubuntu", "--cd", "/home/me/ntwine", "--exec", linuxCommand, ...linuxArgs.slice(0, 5), "setsid", "-w", ...linuxArgs.slice(5)])
})

test("a Windows argument is quoted so CommandLineToArgvW reads it back unchanged", () => {
  assert.equal(quoteWindowsArg("--no-app"), "--no-app")
  assert.equal(quoteWindowsArg(""), '""')
  assert.equal(quoteWindowsArg("/mnt/c/Program Files/x"), '"/mnt/c/Program Files/x"')
  // A quote is escaped, and the backslashes before it doubled; a trailing run is doubled before the closing quote.
  assert.equal(quoteWindowsArg('export PATH="$1"'), '"export PATH=\\"$1\\""')
  assert.equal(quoteWindowsArg('a\\"b'), '"a\\\\\\"b"')
  assert.equal(quoteWindowsArg("C:\\my dir\\"), '"C:\\my dir\\\\"')
})
