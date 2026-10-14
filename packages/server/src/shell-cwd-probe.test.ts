import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, openSync, closeSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseLsofHolders, probeShellCwds } from "./shell-cwd-probe.ts"

// WHERE A RUNNING SHELL IS, asked of the OS. The parse and the failure directions are pinned with a fake
// lsof; the claim itself — a real process holding a real task log, in a real folder — is pinned against
// the machine's own lsof and /proc, with a negative control.

type Exec = NonNullable<Parameters<typeof probeShellCwds>[1]>["exec"]
const fakeExec = (answer: { stdout?: string; code?: number | string }): Exec =>
  (async () => {
    if (answer.code === undefined) return { stdout: answer.stdout ?? "", stderr: "" }
    throw Object.assign(new Error("lsof"), { code: answer.code, stdout: answer.stdout ?? "" })
  }) as unknown as Exec

function taskLog() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-shell-cwd-")))
  const tasks = join(root, "tasks")
  mkdirSync(tasks)
  const file = join(tasks, "b1.output")
  writeFileSync(file, "")
  return { root, file, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test("parseLsofHolders: each path's holders, in lsof's order, without repeats for stdout and stderr", () => {
  const report = "p200\nf1\nn/t/a.output\nf2\nn/t/a.output\np150\nf1\nn/t/a.output\np300\nf1\nn/t/b.output\n"
  assert.deepEqual([...parseLsofHolders(report)], [["/t/a.output", [200, 150]], ["/t/b.output", [300]]])
  assert.deepEqual([...parseLsofHolders("")], [])
})

test("the lowest holder is the shell, and its folder is the answer", async () => {
  const log = taskLog()
  try {
    const exec = fakeExec({ stdout: `p200\nn${log.file}\np150\nn${log.file}\n` })
    const read: number[] = []
    const cwds = await probeShellCwds([log.file], { platform: "linux", exec, readCwd: async (pid) => (read.push(pid), `/dir/of/${pid}`) })
    assert.equal(cwds.get(log.file), "/dir/of/150")
    assert.deepEqual(read, [150])
  } finally {
    log.cleanup()
  }
})

// ntwine's own server holds the same log for the length of a drawer read or a line count. Sampled then, it
// is the lowest holder, and its folder was taken for the shell's — for good (the tailer keeps the reading).
test("the server's own pid is never taken for the shell, even as the lowest holder", async () => {
  const log = taskLog()
  try {
    const exec = fakeExec({ stdout: `p200\nn${log.file}\np90\nn${log.file}\n` })
    const read: number[] = []
    const cwds = await probeShellCwds([log.file], { platform: "linux", exec, selfPid: 90, readCwd: async (pid) => (read.push(pid), `/dir/of/${pid}`) })
    assert.equal(cwds.get(log.file), "/dir/of/200")
    assert.deepEqual(read, [200])
    // Only the server holding it (the shell has exited mid-read) is no reading at all.
    const alone = await probeShellCwds([log.file], { platform: "linux", exec: fakeExec({ stdout: `p90\nn${log.file}\n` }), selfPid: 90, readCwd: async () => "/server" })
    assert.equal(alone.get(log.file), undefined)
  } finally {
    log.cleanup()
  }
})

test("every uncertain step is no reading, never a guess", async () => {
  const log = taskLog()
  try {
    const readCwd = async () => "/x"
    // lsof ran and said nobody holds it (exit 1, empty): the shell had already finished.
    assert.equal((await probeShellCwds([log.file], { platform: "linux", exec: fakeExec({ code: 1 }), readCwd })).get(log.file), undefined)
    // lsof could not run at all.
    assert.equal((await probeShellCwds([log.file], { platform: "linux", exec: fakeExec({ code: "ENOENT" }), readCwd })).get(log.file), undefined)
    // The process left between the two questions.
    const gone = async () => { throw new Error("ESRCH") }
    assert.equal((await probeShellCwds([log.file], { platform: "linux", exec: fakeExec({ stdout: `p9\nn${log.file}\n` }), readCwd: gone })).get(log.file), undefined)
    // Its folder was deleted under it.
    const deleted = async () => "/repo/.ntwine/worktrees/x (deleted)"
    assert.equal((await probeShellCwds([log.file], { platform: "linux", exec: fakeExec({ stdout: `p9\nn${log.file}\n` }), readCwd: deleted })).get(log.file), undefined)
    // No such file, and Windows, which names no holder.
    assert.equal((await probeShellCwds(["/nowhere/tasks/x.output"], { platform: "linux", exec: fakeExec({ stdout: "" }), readCwd })).get("/nowhere/tasks/x.output"), undefined)
    assert.equal((await probeShellCwds([log.file], { platform: "win32" })).get(log.file), undefined)
  } finally {
    log.cleanup()
  }
})

test("macOS reads the holder's folder through lsof's own cwd descriptor", async () => {
  const log = taskLog()
  try {
    const calls: string[][] = []
    const exec = (async (_bin: string, args: string[]) => {
      calls.push(args)
      if (args.includes("cwd")) return { stdout: "p150\nfcwd\nn/Users/u/repo\n", stderr: "" }
      return { stdout: `p150\nn${log.file}\n`, stderr: "" }
    }) as unknown as Exec
    const cwds = await probeShellCwds([log.file], { platform: "darwin", exec })
    assert.equal(cwds.get(log.file), "/Users/u/repo")
    assert.deepEqual(calls[1], ["-a", "-d", "cwd", "-F", "pn", "-p", "150"])
  } finally {
    log.cleanup()
  }
})

const hasLsof = (() => {
  try {
    execFileSync("lsof", ["-v"], { stdio: "ignore" })
    return true
  } catch (e) {
    return (e as { status?: number }).status !== undefined // lsof -v exits non-zero on some builds
  }
})()

test("REAL: a process holding its task log answers with the folder it runs in; an unheld log answers nothing", { skip: process.platform === "win32" || !hasLsof }, async () => {
  const log = taskLog()
  const folder = join(log.root, "repo")
  mkdirSync(folder)
  const fd = openSync(log.file, "a")
  // The harness's shape: the command's stdout AND stderr are its task log, and it runs in its folder.
  // `sleep` itself, not `sh -c sleep`: killing a shell would orphan its sleep, which would go on holding
  // the log and make the negative control below measure the orphan.
  const child = spawn("sleep", ["30"], { cwd: folder, stdio: ["ignore", fd, fd] })
  closeSync(fd)
  try {
    await new Promise((resolve) => setTimeout(resolve, 150))
    const cwds = await probeShellCwds([log.file])
    assert.equal(cwds.get(log.file), folder)
    // NEGATIVE CONTROL: the same log once nobody holds it is no reading at all.
    child.kill("SIGKILL")
    await new Promise((resolve) => child.once("exit", resolve))
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal((await probeShellCwds([log.file])).get(log.file), undefined)
  } finally {
    child.kill("SIGKILL")
    log.cleanup()
  }
})
