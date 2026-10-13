import type { BackgroundShellOutputResult } from "@ntwine/shared"

// AN AGENT TERMINAL'S LOG, AS A STREAM — what the drawer's poll turns the server's offset reads into, for
// the read-only xterm to write (components/ShellLogPane.tsx). Pure, so the reset / resume / replay rules
// are pinned by a test rather than by a browser.
//
// Each reply of `backgroundShellOutput({ from, raw: true })` is either a fresh start (the first read, or a
// `reset` because the file shrank or was replaced) or more bytes since the last `end`. A fresh start opens
// with a HEAD — the command as a dim `$` line, and when the read began mid-file a dim note that earlier
// output is not shown — so the pane reads like a terminal that ran it. The stream keeps every event since
// the last fresh start, because the pane is a lazy component that can mount after the first replies land:
// attaching replays them, then follows live.

export type ShellLogEvent =
  | { kind: "reset"; command: string | null; truncated: boolean }
  | { kind: "data"; text: string }

/** The bytes kept for a late-attaching pane. Past this the oldest events drop; a live pane never sees it. */
const REPLAY_MAX_CHARS = 2 * 1024 * 1024

export class ShellLogStream {
  private events: ShellLogEvent[] = []
  private chars = 0
  private writers = new Set<(event: ShellLogEvent) => void>()
  private started = false
  /** Where the next read resumes; undefined until the first reply, or against a server with no offsets. */
  from: number | undefined
  /** How many characters of output have arrived since the last fresh start — the pane's empty state. */
  received = 0

  /** Fold one reply in. Returns whether it carried anything to write. */
  apply(reply: BackgroundShellOutputResult): boolean {
    // A `gone` reply is not a read: the server no longer knows the shell (its retired ring moved on, or a
    // session re-register briefly hid it), and it carries no bytes and no cursor. Taken as a fresh start —
    // it has no `end` — it wiped a log already on screen. Before anything has arrived there is nothing to
    // keep, and the drawer says the terminal is closed.
    if (reply.state === "gone" && this.started) return false
    // A reply with no `end` is a whole tail again (a server from before offset reads), so one that carries
    // bytes is a fresh start rather than a duplicate appended under the last. One that carries NOTHING is
    // not: a running shell whose log does not exist yet answers exactly that, every 1.5s, and taking each
    // as a fresh start reset the pane and rewrote its `$ command` head on every poll until the first byte.
    // The first bytes after such waiting ARE a fresh start (`from` is still unset): the head is written
    // again once, now knowing whether the read began mid-file.
    const fresh = !this.started || reply.reset === true || (!!reply.output && (reply.end === undefined || this.from === undefined))
    if (fresh) {
      this.started = true
      this.events = []
      this.chars = 0
      this.received = 0
      this.emit({ kind: "reset", command: reply.command, truncated: reply.truncated })
    }
    if (reply.end !== undefined) this.from = reply.end
    if (!reply.output) return fresh
    this.received += reply.output.length
    this.emit({ kind: "data", text: reply.output })
    return true
  }

  /** Follow the stream: everything since the last fresh start first, then each new event. */
  attach(writer: (event: ShellLogEvent) => void): () => void {
    for (const event of this.events) writer(event)
    this.writers.add(writer)
    return () => {
      this.writers.delete(writer)
    }
  }

  private emit(event: ShellLogEvent): void {
    this.events.push(event)
    if (event.kind === "data") this.chars += event.text.length
    // Keep the head (the first event is always the reset) and drop the oldest data past the cap.
    while (this.chars > REPLAY_MAX_CHARS && this.events.length > 2) {
      const [dropped] = this.events.splice(1, 1)
      if (dropped?.kind === "data") this.chars -= dropped.text.length
    }
    for (const writer of this.writers) writer(event)
  }
}

/** How many `gone` replies in a row, after a running one, are asked about again (nextShellLogDelay). */
export const GONE_RECHECKS = 12
const GONE_RECHECK_MS = 5_000

/** When to ask again after a reply: at once when more is already waiting — whether or not the shell is
 *  still running — on the poll while it runs, and never once it has ended with nothing left to read.
 *
 *  `more` comes first. A shell that writes past one delta read (256 KB) inside a poll window and then
 *  exits — a test runner dumping its failures — answers `{ state: "done", more: true }`, and stopping on
 *  "done" there left its newest output, usually the summary, unread in a pane that said nothing was
 *  missing. */
export function nextShellLogDelay(reply: Pick<BackgroundShellOutputResult, "more" | "state" | "outputUnavailable">, gonesAfterRunning = 0): number | undefined {
  if (reply.more) return 0
  // A `gone` can be TRANSIENT (see ShellLogStream.apply: a session re-register hides a shell for a tick),
  // and stopping on the first one froze a still-running shell's drawer as "unavailable" until it was
  // reopened. So a gone that follows a running reply is asked about again, slowly and a bounded number of
  // times — a real retirement ends in `done`, not `gone`, so this is about a minute of one cheap read at
  // most. A gone with no running before it is the shell's answer from the start: nothing to wait for.
  if (reply.state === "gone") return gonesAfterRunning > 0 && gonesAfterRunning <= GONE_RECHECKS ? GONE_RECHECK_MS : undefined
  if (reply.state !== "running") return undefined
  if (reply.outputUnavailable) return 5_000 // nothing to read — only the state can change
  return 1_500
}

/** The dim lines a fresh start opens with — the idiom a human terminal's follow-up run uses. */
export function shellLogHead(event: Extract<ShellLogEvent, { kind: "reset" }>): string {
  const lines: string[] = []
  if (event.command) lines.push(`\x1b[2m$ ${event.command.replace(/\r?\n/g, "\r\n  ")}\x1b[0m`)
  if (event.truncated) lines.push("\x1b[2mEarlier output not shown — showing the latest 512 KB\x1b[0m")
  return lines.length > 0 ? `${lines.join("\r\n")}\r\n` : ""
}
