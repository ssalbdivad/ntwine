// The secret pipe against the REAL kernel: a real `mkfifo`, real `cat` readers, real timers. What these
// pin is the promise the worker is given — the value is read ONCE, from memory, and nothing of it is left.
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { clearSecrets, releaseThreadSecrets, secretFilePath, serveSecret } from "./secret-files.ts"

const cat = (path: string, timeout = 5_000) => new Promise<string>((resolve, reject) =>
  execFile("cat", [path], { timeout }, (error, stdout) => (error ? reject(error) : resolve(stdout))))

const until = async (cond: () => boolean, ms = 3_000) => {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out")
    await new Promise((r) => setTimeout(r, 25))
  }
}

function stateDir(): string {
  return mkdtempSync(join(tmpdir(), "ntwine-secret-"))
}

test("a failed consumer can read again: each reader gets the value whole, until the cap removes the path", async () => {
  const dir = stateDir()
  try {
    const path = serveSecret(dir, "t", "qst_cap", "s3cr3t value", { maxReads: 3 })
    assert.equal(path, secretFilePath(dir, "t", "qst_cap"))
    assert.ok(lstatSync(path).isFIFO())
    for (let read = 1; read <= 3; read++) assert.equal(await cat(path), "s3cr3t value", `read ${read}`)
    await until(() => !existsSync(path))
    // Past the cap there is nothing to open, rather than another copy.
    await assert.rejects(() => cat(path), /No such file/)
    assert.equal(existsSync(join(dir, "secrets", "t")), false, "the thread's directory goes with its last pipe")
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("a slow reader gets the value ONCE, not again on the next poll, and the next reader still gets it", async () => {
  const dir = stateDir()
  try {
    const path = serveSecret(dir, "t", "qst_slow", "v")
    // Open the pipe and sit on it for several poll ticks before reading: on one shared inode the server
    // would write into it again while this reader still held it, and it would read "vv".
    const slow = await new Promise<string>((resolve, reject) =>
      execFile("sh", ["-c", `exec 3< '${path}'; sleep 0.5; cat <&3`], { timeout: 5_000 }, (e, out) => (e ? reject(e) : resolve(out))))
    assert.equal(slow, "v")
    assert.equal(await cat(path), "v")
    assert.deepEqual(readdirSync(join(dir, "secrets", "t")), ["qst_slow"], "no swap pipe left beside it")
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("a thread's sign-off releases only its own values", async () => {
  const dir = stateDir()
  try {
    const mine = serveSecret(dir, "t", "qst_mine", "a")
    const read = serveSecret(dir, "t", "qst_read", "b")
    const other = serveSecret(dir, "t-other", "qst_theirs", "c")
    assert.equal(await cat(read), "b")
    assert.equal(releaseThreadSecrets(dir, "t"), 2, "a value already read once is still held, so it is released too")
    assert.equal(existsSync(mine), false)
    assert.equal(existsSync(read), false)
    assert.equal(await cat(other), "c")
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("LOOKING at the path does not spend the value — only opening it does", async () => {
  const dir = stateDir()
  try {
    const path = serveSecret(dir, "t", "qst_look", "kept")
    // What a careful worker might run before using it: these stat the path and never open it.
    await new Promise<void>((resolve, reject) =>
      execFile("sh", ["-c", `ls -l '${path}' && test -p '${path}'`], (e) => (e ? reject(e) : resolve())))
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(await cat(path), "kept")
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("a value expires at the TTL whether or not it was read, and removing the path discards it", async () => {
  const dir = stateDir()
  try {
    const expiring = serveSecret(dir, "t", "qst_ttl", "late", { ttlMs: 400 })
    // A read does not restart the clock: the TTL counts from the answer.
    assert.equal(await cat(expiring), "late")
    await until(() => !existsSync(expiring))
    const discarded = serveSecret(dir, "t", "qst_rm", "unwanted")
    rmSync(discarded)
    // Re-creating the name as a plain file must not make the server start writing into it.
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(existsSync(discarded), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("a server start clears what a previous process left — pipes with no writer, and old plaintext files", async () => {
  const dir = stateDir()
  try {
    const thread = join(dir, "secrets", "old-thread")
    mkdirSync(thread, { recursive: true })
    writeFileSync(join(thread, "qst_plain"), "left by the plaintext version")
    await new Promise<void>((resolve, reject) => execFile("mkfifo", [join(thread, "qst_orphan")], (e) => (e ? reject(e) : resolve())))
    // …while a pipe THIS process serves is left alone.
    const live = serveSecret(dir, "live-thread", "qst_live", "still served")
    assert.equal(clearSecrets(dir), 2)
    assert.equal(existsSync(thread), false)
    assert.deepEqual(readdirSync(join(dir, "secrets")), ["live-thread"])
    assert.equal(await cat(live), "still served")
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("on Windows, where there are no FIFOs, the value is a 0600 file removed at the TTL", async () => {
  const dir = stateDir()
  try {
    const path = serveSecret(dir, "t", "qst_win", "fallback", { platform: "win32", ttlMs: 200 })
    assert.ok(lstatSync(path).isFile())
    assert.equal(lstatSync(path).mode & 0o777, 0o600)
    await until(() => !existsSync(path), 4_000)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
