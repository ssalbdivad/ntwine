import { closeSync, fstatSync, openSync, readSync } from "node:fs"

// ---- WHERE A FORKED THREAD'S OWN TRANSCRIPT BEGINS (2026-09-30) ----------------------------------
//
// On a Claude thread, Spinoff FORKS the parent's session (router.ts forkSpinoff): the child is a new
// session that opens on a copy of the parent's whole conversation, so it starts with the parent's full
// context and reads the parent's prompt cache. Measured on CLI 2.1.284 / Agent SDK 0.3.282, the child's
// `<sessionId>.jsonl` is laid out as
//
//     mode · atis-latch · queue-operation enqueue/dequeue (the child's own prompt, queued)
//     … every record of the parent's conversation, rewritten under the CHILD's session id …
//     attachment hook_success (the child's own SessionStart)
//     user  ← the child's first prompt, `uuid` = the id ntwine sent it under   ◀── the fork point
//     … the child's own work, including the CLI re-appending the INHERITED `ai-title` …
//
// Nothing marks a copied record as inherited, and a reader that folds the file from byte 0 hands the
// child its parent's state: the parent's fence and done card as the child's rest, its background shells
// and sub-agents as the child's, its sign-offs and questions, its unread turns, its title. So every
// reader of a forked thread's transcript starts at the FORK POINT — the line of the record whose uuid is
// the child's `fork_anchor` (storage.ts) — and reads NOTHING until that record has landed. That makes a
// fork look, to every fold, exactly like a fresh dispatch whose transcript opens on its prompt.
//
// The anchor is a uuid ntwine minted for the child's opening prompt, which the CLI echoes onto the
// record (the same echo the delivery ledger correlates on), so no copied record can carry it — however
// the CLI treats the copied records' own uuids (2.1.284 keeps them; the run that motivated this change
// reported them re-minted). The records the child wrote BEFORE its prompt (the queue pair, its
// SessionStart hook) are skipped with the copy; none of them is state any fold keeps.
//
// The CLI also re-appends session metadata after the child's prompt from what it loaded, so the PARENT's
// `ai-title` (and a `custom-title`, when the parent was renamed) turns up again past the fork point.
// The scan records the last of each it passed in the copy, and `inheritedMetadata` names them, so a
// reader can drop exactly those — a title the child's own session generates is a different string.
//
// The scan is incremental and memoized per file: a transcript is append-only, so once found the point
// never moves, and while it is still pending each call reads only what was appended since the last one.

export interface ForkPoint {
  /** Byte offset of the fork point's line: the first byte of the thread's own transcript. */
  offset: number
  /** The last `ai-title` the copied history carried, if any. */
  inheritedAiTitle?: string
  /** The last `custom-title` the copied history carried, if any. */
  inheritedCustomTitle?: string
}

interface ScanMemo {
  anchor: string
  /** dev:ino — a replaced file is a different file, and nothing scanned from the old one applies. */
  fileId: string
  /** Bytes of the file consumed so far; `carry` holds the trailing partial line. */
  scanned: number
  carry: Buffer
  aiTitle?: string
  customTitle?: string
  found?: ForkPoint
}

const WINDOW_BYTES = 4 * 1024 * 1024
const MEMO_CAP = 512
const memo = new Map<string, ScanMemo>()
const AI_TITLE_NEEDLE = Buffer.from('"ai-title"')
const CUSTOM_TITLE_NEEDLE = Buffer.from('"custom-title"')

function titleOf(line: string, field: "aiTitle" | "customTitle"): string | undefined {
  try {
    const rec = JSON.parse(line) as Record<string, unknown>
    const value = rec[field]
    return typeof value === "string" && value.trim() ? value.trim() : undefined
  } catch {
    return undefined
  }
}

/** The fork point of the transcript at `path` for a thread whose `fork_anchor` is `anchor`, or undefined
 *  while that record has not been written (or the file cannot be read). Never throws. */
export function forkPointOf(path: string, anchor: string): ForkPoint | undefined {
  let fd: number | undefined
  try {
    fd = openSync(path, "r")
    const st = fstatSync(fd)
    const fileId = `${st.dev}:${st.ino}`
    let entry = memo.get(path)
    if (!entry || entry.anchor !== anchor || entry.fileId !== fileId || st.size < entry.scanned) {
      entry = { anchor, fileId, scanned: 0, carry: Buffer.alloc(0) }
    }
    memo.delete(path) // LRU touch
    memo.set(path, entry)
    while (memo.size > MEMO_CAP) {
      const oldest = memo.keys().next().value
      if (oldest === undefined) break
      memo.delete(oldest)
    }
    if (entry.found) return entry.found
    const needle = Buffer.from(anchor)
    const buf = Buffer.allocUnsafe(Math.min(WINDOW_BYTES, Math.max(1, st.size - entry.scanned)))
    while (entry.scanned < st.size) {
      const read = readSync(fd, buf, 0, Math.min(buf.length, st.size - entry.scanned), entry.scanned)
      if (read <= 0) break
      // `base` is the file offset of view[0]: the carried partial line sits in front of this window.
      const base = entry.scanned - entry.carry.length
      entry.scanned += read
      const view = entry.carry.length ? Buffer.concat([entry.carry, buf.subarray(0, read)]) : buf.subarray(0, read)
      let start = 0
      for (;;) {
        const nl = view.indexOf(0x0a, start)
        if (nl === -1) break
        const line = view.subarray(start, nl)
        if (line.includes(needle)) {
          // Confirmed on the parsed record, not the bytes: a later record may QUOTE the anchor (its
          // `parentUuid`), and only the record that IS it opens the thread.
          try {
            const rec = JSON.parse(line.toString("utf8")) as { uuid?: unknown }
            if (rec.uuid === anchor) {
              entry.found = {
                offset: base + start,
                ...(entry.aiTitle ? { inheritedAiTitle: entry.aiTitle } : {}),
                ...(entry.customTitle ? { inheritedCustomTitle: entry.customTitle } : {}),
              }
              entry.carry = Buffer.alloc(0)
              return entry.found
            }
          } catch {
            // not a whole record; keep scanning
          }
        } else if (line.includes(AI_TITLE_NEEDLE)) {
          entry.aiTitle = titleOf(line.toString("utf8"), "aiTitle") ?? entry.aiTitle
        } else if (line.includes(CUSTOM_TITLE_NEEDLE)) {
          entry.customTitle = titleOf(line.toString("utf8"), "customTitle") ?? entry.customTitle
        }
        start = nl + 1
      }
      entry.carry = start < view.length ? Buffer.from(view.subarray(start)) : Buffer.alloc(0)
    }
    return undefined
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // best-effort
      }
    }
  }
}

/** Is `line` a session-metadata record the CLI re-appended from the INHERITED session — the parent's
 *  `ai-title` or `custom-title`, written again below the fork point? Cheap on every other line: it only
 *  parses a line that names one of the two record types. */
export function isInheritedSessionMetadata(line: string, point: ForkPoint): boolean {
  if (point.inheritedAiTitle && line.includes('"ai-title"')) return titleOf(line, "aiTitle") === point.inheritedAiTitle
  if (point.inheritedCustomTitle && line.includes('"custom-title"')) return titleOf(line, "customTitle") === point.inheritedCustomTitle
  return false
}

/** Test-only: forget every memoized scan. */
export function __clearForkPointsForTests(): void {
  memo.clear()
}
