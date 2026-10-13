import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { watchLocalFile, watchedLocalFileCount } from "./local-file-watch.ts"

// A REAL directory and a real OS watch, because the property under test is the one a fake cannot
// carry: an editor's atomic save (write beside, rename over) reaches a watch on the DIRECTORY and
// misses a watch on the file's inode. The sibling case is the negative control — a watch that fired
// on everything in the directory would pass the positive cases and re-read on every unrelated save.

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await delay(20)
  }
}

function scratch(): { dir: string; file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-file-watch-"))
  const file = join(dir, "doc.md")
  writeFileSync(file, "one\n")
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test("an in-place write reaches the listener once per settled burst", async () => {
  const { file, cleanup } = scratch()
  let fired = 0
  const release = watchLocalFile(file, () => fired++)
  try {
    // A moment for the OS watch to arm — macOS FSEvents in particular reports nothing that predates it.
    await delay(150)
    writeFileSync(file, "two\n")
    await waitFor(() => fired >= 1, "the first change")
    // Several writes inside the settle window are one save from the reader's point of view.
    const before = fired
    writeFileSync(file, "three\n")
    writeFileSync(file, "four\n")
    writeFileSync(file, "five\n")
    await waitFor(() => fired > before, "the coalesced burst")
    await delay(200)
    assert.equal(fired, before + 1, "three writes in one burst re-read once")
  } finally {
    release()
    cleanup()
  }
})

test("an atomic replace — write beside, rename over — reaches the listener", async () => {
  const { dir, file, cleanup } = scratch()
  let fired = 0
  const release = watchLocalFile(file, () => fired++)
  try {
    await delay(150)
    const temp = join(dir, ".doc.md.tmp")
    writeFileSync(temp, "replaced\n")
    renameSync(temp, file)
    await waitFor(() => fired >= 1, "the rename to land")
    // And the file is still watched afterwards: the watch never followed the old inode.
    const before = fired
    await delay(120)
    writeFileSync(file, "after the replace\n")
    await waitFor(() => fired > before, "a write after the replace")
  } finally {
    release()
    cleanup()
  }
})

test("a sibling's save is not this file's change", async () => {
  const { dir, file, cleanup } = scratch()
  let fired = 0
  const release = watchLocalFile(file, () => fired++)
  try {
    await delay(150)
    writeFileSync(join(dir, "other.md"), "not ours\n")
    await delay(300)
    assert.equal(fired, 0, "a sibling write must not fire")
    // The control's control: the same watch still sees its own file.
    writeFileSync(file, "ours\n")
    await waitFor(() => fired >= 1, "our own write")
  } finally {
    release()
    cleanup()
  }
})

test("a deleted file comes back onto the same watch", async () => {
  const { file, cleanup } = scratch()
  let fired = 0
  const release = watchLocalFile(file, () => fired++)
  try {
    await delay(150)
    unlinkSync(file)
    await waitFor(() => fired >= 1, "the delete")
    const before = fired
    await delay(120)
    writeFileSync(file, "recreated\n")
    await waitFor(() => fired > before, "the recreate")
  } finally {
    release()
    cleanup()
  }
})

test("readers share one watch per path, and the last release closes it", async () => {
  const { file, cleanup } = scratch()
  const base = watchedLocalFileCount()
  let a = 0
  let b = 0
  const releaseA = watchLocalFile(file, () => a++)
  const releaseB = watchLocalFile(file, () => b++)
  try {
    assert.equal(watchedLocalFileCount(), base + 1, "two readers, one OS watch")
    await delay(150)
    writeFileSync(file, "both\n")
    await waitFor(() => a >= 1 && b >= 1, "both listeners")
    releaseA()
    assert.equal(watchedLocalFileCount(), base + 1, "the first release leaves the watch for the other reader")
    const bBefore = b
    const aBefore = a
    await delay(120)
    writeFileSync(file, "only b\n")
    await waitFor(() => b > bBefore, "the remaining listener")
    await delay(150)
    assert.equal(a, aBefore, "a released listener hears nothing")
  } finally {
    releaseB()
    cleanup()
  }
  assert.equal(watchedLocalFileCount(), base, "the last release closes the watch")
})

test("a directory that does not exist cannot be watched, and leaves nothing behind", () => {
  const base = watchedLocalFileCount()
  assert.throws(() => watchLocalFile(join(tmpdir(), "ntwine-no-such-dir-" + process.pid, "x.md"), () => {}))
  assert.equal(watchedLocalFileCount(), base)
})
