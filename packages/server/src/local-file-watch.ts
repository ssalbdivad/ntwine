import { statSync, watch, type FSWatcher } from "node:fs"
import { basename, dirname } from "node:path"

// ONE LIVE WATCH PER OPEN FILE, for the readers that render a file on disk — the Markdown drawer and
// the file reader. Each read ONCE and rendered what it got, so a file a worker was
// editing sat stale on screen until the reader closed and reopened it (maintainer 2026-09-03: "seems
// like we load the file once … and don't monitor it for changes … it needs to be live"). A watch here
// tells the socket layer "read it again"; the bytes still travel through the reader's own gated RPC.
//
// THE WATCH IS ON THE DIRECTORY, filtered to the file's own name — never on the file itself. Every
// editor worth the name saves ATOMICALLY (write a temp file, rename it over the original), so a watch
// on the file follows the OLD inode into the void and reports nothing ever again; the directory sees
// the rename land under the same name. It also sees the file deleted and recreated, which from where
// the reader stands is the same instruction.
//
// Non-recursive, so watching a file at the checkout's root costs a watch on the root's direct entries
// and nothing under node_modules. The several events one save produces (a rename, a change or two)
// coalesce behind a short timer, so the reader re-reads once per save rather than once per event.
//
// Shared by canonical path: two readers on one file (a panel plus a stacked drawer, or two tabs) hold
// one OS watch between them, and the last one to leave closes it.
//
// AND THE NAME FILTER IS NOT ENOUGH ON MACOS, which is why every settled burst is checked against the
// file's own stat before anyone is told about it. A directory watch is supposed to name the entry that
// moved, and on Linux it does; on macOS the creation of a SIBLING emits a `rename` carrying OUR file's
// name as well as the sibling's. Measured 2026-09-04 — one `writeFileSync` of `other.md` beside a
// watched `doc.md` produced, in order, `["change","<the directory>"]`, `["rename","doc.md"]` and
// `["rename","other.md"]`. Nothing in the first two is distinguishable from a real save, so the
// listener fired on a file that had not changed a byte: an open reader at a checkout's root re-read
// itself on every unrelated save in that directory, and local-file-watch.test.ts's negative control
// ("a sibling's save is not this file's change") failed 3 runs out of 3.
//
// The stamp is inode, size and NANOSECOND mtime, so it separates two saves inside one millisecond —
// which the coarser mtimeMs would not, and a missed save is the one failure this module must not have.
// A file that cannot be stat'ed stamps as "gone", which is a change like any other: the delete fires,
// and so does the recreate that follows it onto the same watch.

const SETTLE_MS = 50

/** The file's identity as the last fire saw it. Unreadable — deleted, or mid-rename — is its own value. */
function stampOf(path: string): string {
  try {
    const s = statSync(path, { bigint: true })
    return `${s.ino}:${s.size}:${s.mtimeNs}`
  } catch {
    return "gone"
  }
}

type Entry = { watcher: FSWatcher; listeners: Set<() => void>; timer: NodeJS.Timeout | null; stamp: string }
const entries = new Map<string, Entry>()

function close(path: string): void {
  const entry = entries.get(path)
  if (!entry) return
  entries.delete(path)
  if (entry.timer) clearTimeout(entry.timer)
  try {
    entry.watcher.close()
  } catch {
    // Already closed — the error path lands here after the OS dropped the watch.
  }
}

/**
 * Watch `path` (already canonical and gated by the caller) and call `onChange` after each settled
 * burst of changes to it. Returns the release; the last release on a path closes the OS watch.
 * Throws when the directory cannot be watched (gone, or unreadable) — the caller treats that as
 * "nothing to watch", exactly as the reader's own read reports the same file.
 */
export function watchLocalFile(path: string, onChange: () => void): () => void {
  let entry = entries.get(path)
  if (!entry) {
    const name = basename(path)
    const watcher = watch(dirname(path), { persistent: false }, (_event, changed) => {
      // A platform that names the file says which entry moved; one that does not (`null`) could mean
      // ours, so it counts. Anything named that is not ours is a sibling's business.
      if (changed !== null && changed !== undefined && changed.toString() !== name) return
      const current = entries.get(path)
      if (!current) return
      if (current.timer) clearTimeout(current.timer)
      current.timer = setTimeout(() => {
        current.timer = null
        // The burst has settled, so the file is at rest and its stat is the truth about it. Unchanged
        // means the events were somebody else's business (see the macOS note above) and nobody hears.
        const stamp = stampOf(path)
        if (stamp === current.stamp) return
        current.stamp = stamp
        for (const listener of current.listeners) listener()
      }, SETTLE_MS)
      current.timer.unref?.()
    })
    entry = { watcher, listeners: new Set(), timer: null, stamp: stampOf(path) }
    // The OS dropped the watch (the directory went away). Nothing re-arms it: the reader's next read
    // reports the missing file in its own words, and reopening the file subscribes afresh.
    watcher.on("error", () => close(path))
    entries.set(path, entry)
  }
  entry.listeners.add(onChange)
  return () => {
    const current = entries.get(path)
    if (!current) return
    current.listeners.delete(onChange)
    if (current.listeners.size === 0) close(path)
  }
}

/** Live OS watches — for tests to prove a clean release leaves none behind. */
export function watchedLocalFileCount(): number {
  return entries.size
}
