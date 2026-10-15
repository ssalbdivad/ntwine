import { lazy, Suspense, useState, type ReactNode } from "react"
import { Bot, Folder, FolderGit2, Loader2, SquareTerminal, X } from "lucide-react"
import type { BgShellView, ThreadView, WorkCheckout } from "@ntwine/shared"
import { useThreadApi, useThreadApiBase, useThreadProjectDir } from "../api/threadApi.tsx"
import type { Api } from "../api/rpc.ts"
import { useBackgroundShellLines, useBoard } from "../hooks.ts"
import { AGENT_GLYPH_STROKE, CHILD_ARROW, CHILD_ARROW_CLASS, CHILD_DISMISS_TITLE, CHILD_KIND_TAG_CLASS, CHILD_MARK_SLOT_CLASS, shellLinesLabel, type TranscriptShellRecord } from "../lib/childOps.ts"
import { childOpDismisser, dismissChildOp } from "../lib/dismissChildOp.ts"
import { PRIMER } from "../lib/primer.ts"
import { cardProcesses, collapseFinished, endedShellStateLabel, humanProcess, onCard, processIsLive, threadProcesses, type ProcessState, type ThreadProcess } from "../lib/threadProcesses.ts"
// The card's rows live in the lib so the queue card's counts line can read them with no component import.
export { cardProcesses }
import { liveAgeSince } from "../lib/durationLabels.ts"
import { useNowMs } from "../lib/liveClock.ts"
import { abbreviateHome } from "../lib/paths.ts"
import { terminalStateLabel } from "../lib/threadTerminals.ts"
import { projectSlug } from "../lib/base-path.ts"
import { pushBackgroundShellDrawer, pushTerminalDrawer, showToast, store } from "../store.ts"

// A THREAD'S TERMINALS, drawn inside the thread (server thread-terminals.ts; lib/threadTerminals.ts). A
// terminal is opened ON a thread — the drawer's ⋯ menu, `t`, or a `$ cmd` line in its prompt box — and
// runs in the folder that thread's agent is working in. It never gets a row or a card of its own (the
// sidebar is a column of thread NAMES, and upstream's rule is density): it shows as a line in its
// thread's strip, and as one small mark on its thread's row.
//
// LAZY for the same reason every xterm consumer is: @xterm/xterm is browser-only, and node (tests)
// imports these components transitively.
const TerminalPane = lazy(() => import("./TerminalPane.tsx").then((m) => ({ default: m.TerminalPane })))

// ── one strip for every process on the thread ─────────────────────────────────────────────────────

// THE ROW'S BOX IS THE OPS STRIP'S ROW BOX (ChildOpRow's sheet density): the same arrow, the same 9px mark
// slot, the same fixed kind-tag track, 11.5px throughout — so a terminal line sits in the drawer's strip
// under the ⤷ AGENT lines and the eye runs down ONE label column. Written out here rather than added as a
// fifth ChildOpRow kind because that row's states are liveness states only ("there is deliberately NO
// finished glyph"), and a terminal's finished run is worth a line: its exit code is the reason the human
// opened it.
const ROW = "flex min-w-0 items-center gap-1.5 text-[11.5px]"
// No width cap: the label is the row's identity and gives way LAST (see WHO GIVES WAY). A `max-w-[70%]`
// here truncated a long command at 70% of the row while a folder hint beside it still had room.
const IDENTITY = "group flex min-w-0 items-center gap-1.5 overflow-hidden text-left outline-none rounded-sm focus-visible:inset-ring-1 focus-visible:inset-ring-focus-ink-60"

// THE OWNER MARK sits IN THE MARK SLOT — the 9px column the liveness dot used to fill — and its hue is the
// row's liveness. Not a glyph slot of its own beside the tag: `.ntwine-kind-tag` is a fixed track so every
// label on the strip starts at one x, and a second slot would push these labels 14px right of the AGENT
// and WATCH rows around them (the drift the maintainer caught on 2026-09-11, "The label is further to the
// right. Why?"). The slot is 9px and the glyph 1em (11.5px), so it overflows 1.25px a side into the row's
// gaps, exactly as the saved-reference icons always have.
//
// `Bot` for the agent's, `SquareTerminal` for yours. A human head was tried for "yours" and dropped
// (BandLabel.tsx: at 11px a round head reads as an emoji), and the terminal glyph is the one your own
// terminals already wore.
//
// GEOMETRY: CENTRED, like the dot it replaces. Every mark on this row — arrow, glyph, tag, ×, readings —
// is centred on the one flex line, which is where a sans 11.5px label's cap band sits. Both glyphs ink
// their 24-unit viewBox symmetrically (lucide's bot y 3–21 with its stroke, antenna to chin; the terminal
// square y 2–22), so a centred box is a centred ink. That only holds because the LABEL is put on that line
// too — see LABEL.
//
// MEASURED, label cap-band centre minus each mark's ink centre (negative = the mark sits lower), on the
// live stack in sans at dsf 6, 2026-09-29 (canvas cap band at 10× size — the 1× metrics round the cap
// ascent to a whole pixel on this box and read every mark ~0.35px lower than it is):
//     centred:  arrow −0.05 · owner glyph −0.41 · TERM tag −0.17 · × −0.40   (sans description label)
//               arrow +0.10 · owner glyph −0.25 · TERM tag −0.02 · × −0.25   (mono command label)
// A centred 1em box sits a hair under the sans cap band, so the glyph and the × are LIFTED by one
// measured constant, MARK_LIFT: −0.03em = 0.35px at 11.5px, which leaves both label fonts within 0.1px
// (sans −0.06, mono +0.10) — one lift, because the owner mark must not change height between an agent
// row and yours. The arrow, the tag and the readings are text on the same line and need none. The AGENT
// row (ChildOpRow) keeps its own dot and ×, measured the same −0.40 and untouched here: that row is every
// other surface's too, and its own reviewer. Re-measure if the row's size or line-height moves.
const MARK_LIFT = "-translate-y-[0.03em]"
const OWNER_GLYPH = { agent: Bot, human: SquareTerminal } as const
const OWNER_SLOT = `${CHILD_MARK_SLOT_CLASS} items-center`
// Both glyphs at the square's 1em box; the bot's weight is its pen, not its size — AGENT_GLYPH_STROKE.
const OWNER_ICON = `h-[1em] w-[1em] shrink-0 ${MARK_LIFT}`
const OWNER_STROKE = { agent: AGENT_GLYPH_STROKE, human: 2 } as const

// THE LABEL, ON THE STRIP'S ONE LINE. The agent's is the tool call's own DESCRIPTION — prose, "Test watch in
// the probe worktree" — so it is set as every ops-strip label is, in the row's sans (it was mono for one
// commit, and prose in mono read as a command line and cost a third of the label at 390px). Yours is the
// COMMAND you typed, so it keeps the mono it has always had.
//
// A mono label set on its own in this sans row rode HIGH: two fonts' boxes centred on one flex line put
// their baselines where each font's ascent/descent balance says, and the mono cap band measured 2.34px
// above the × and 1.84px above the arrow beside it (live stack, sans UI, dsf geometry, 2026-09-29) — the
// same fault the old TERM line always had. The fix is the label's, not one more constant per mark: the
// command sits INSIDE a sans line (`LABEL`, 11.5px, the row's own font), as a `leading-none` inline run.
// A line box is sized by its strut — the sans line — and the mono run's 1em box fits inside it, so the
// run is placed on the SANS baseline, exactly where an AGENT row's text sits. Nothing is measured, so
// nothing is re-measured when a font or the type scale moves; the marks all stay plain `items-center`.
const LABEL = "min-w-0 truncate text-muted-70"
const COMMAND_RUN = "font-mono-keep text-[11px] leading-none"

// Liveness in the rail mark's vocabulary: the shell's azure while it runs (pulsing on the dot's own
// 1.25s cadence), breathing when quiet, the attention yellow and STILL at a prompt, muted once finished,
// red when it failed on its own. The two motions live in styles.css beside the dots they mirror. The red
// is the ops strip's own (PRIMER.fgDanger — ChildOpRow's "failed" and "over budget"), so "this went wrong"
// is one colour down the strip's readings column, whichever row says it.
const DANGER = "text-[color:var(--gh-fg-danger)]"
const PROCESS_HUE: Record<ProcessState, string> = {
  running: "text-shell ntwine-live-glyph",
  quiet: "text-shell ntwine-live-glyph-quiet",
  prompt: "text-attention",
  finished: "text-muted-45",
  failed: DANGER,
}
// The indicator attributes the live-row selectors (e2e checks, verify scripts) already key on.
const RUNNING_INDICATOR: Partial<Record<ProcessState, string>> = { running: "operation", quiet: "operation-quiet", prompt: "prompt" }

const DISMISS = "shrink-0 rounded-sm p-0.5 text-muted-45 outline-none transition-colors hover:text-fg focus-visible:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60 disabled:opacity-50"

function folderName(dir: string): string {
  return dir.split(/[\\/]/).filter(Boolean).pop() ?? dir
}

/** What a row's identity button says on hover — who owns it, what it runs, where, and (when it has gone
 *  quiet) what the breathing mark means. The old SHELL row's quiet dot carried that in its own title, as
 *  "running — no recent output"; the reading behind it is the OS's (tailer.ts shellIsGone: no process
 *  holds the shell's log any more), so the line says that, rather than that it is still running.
 *
 *  "Runs in", not "Started in": while an agent shell runs, its folder is the OS's answer for where its
 *  process is NOW (server shell-cwd-probe.ts), which a `cd` inside the command moves; "Ran in" once it
 *  has gone quiet, the last place it was seen. */
export function processTitle(p: ThreadProcess, homeDir: string | undefined, watched = false): string {
  const where = p.cwd ? abbreviateHome(p.cwd, homeDir) : undefined
  if (p.owner === "human") return where ? `Your terminal — ${p.label}\n${where}` : `Your terminal — ${p.label}`
  const head = `${p.monitor ? "Agent monitor" : "Agent terminal"} — ${p.label}`
  const lines = [
    head,
    ...(p.state === "quiet" ? [QUIET_TITLE] : []),
    ...(where ? [`${p.state === "running" ? "Runs" : "Ran"} in ${where}`] : []),
    ...(watched ? ["Watched — this thread wakes when it finishes"] : []),
  ]
  return lines.join("\n")
}

export const QUIET_TITLE = "Quiet — no process is writing its output, so it has probably ended"

/** The word for the project's own checkout, on a row that runs there while the header says the agent is
 *  somewhere else. `root` — the dialog's "the project root", and true in the Home workspace too, whose root
 *  is a plain folder and no checkout at all. It was `main` for one round: that collided with the branch
 *  name, which the root checkout need not be on, and said "the project's main checkout" of the home folder.
 *  `root` was dropped once before because, bare beside `tail -f /dev/null`, it read as "running as root";
 *  it is no longer bare — the hint leads with a folder mark. Not a path: a path is the width the hint exists
 *  to save, and it is in the hint's tooltip. */
export const ROOT_CHECKOUT_WORD = "root"

export interface ProcessFolderHint {
  text: string
  kind: WorkCheckout["kind"] | "root"
  /** The checkout's folder. Absent for `root`, whose folder is the project's (the tooltip reads it). */
  dir?: string
}

/**
 * THE ROW'S FOLDER HINT: named ONLY when a row runs somewhere OTHER than where the header says the agent is
 * working (`here`, the thread's checkout — ThreadCheckoutToken, absent at the project root). So a strip whose
 * rows all run in the thread's current checkout shows no hint at all, wherever that checkout is: the header
 * token already said it once. When the agent is in `probe`, a row still in the project's own checkout says
 * `root`; when it is back at the root, a row left in `probe` says `probe`.
 *
 * Measured against the ROW ALONE for one round (a hint iff the row is off the project root), `probe` then
 * repeated down the strip whenever the agent was in a worktree — 5 of 11 rows in one verifier's drawer,
 * since a new terminal opens where the agent works — and, being never allowed to give way, it cost the
 * label its width at 390px ("Test wat…" beside `probe · 415 lines`). The rule is now one line, both owners:
 * a hint says "not where the header says". It reads against the header directly above it, the one place
 * `here` is spelled out.
 *
 * `checkout` is the server's lift (thread-cwd.ts liftWorkingDir), absent at the root, so a terminal in
 * `packages/web` is in the root checkout. A row the server did not PLACE — it had no reading: a folder since
 * removed, a Codex exec whose item named none, a transcript-only shell — claims nothing either way.
 */
export function processFolderHint(p: Pick<ThreadProcess, "placed" | "checkout">, here: WorkCheckout | null | undefined): ProcessFolderHint | undefined {
  if (!p.placed) return undefined
  if ((p.checkout?.dir ?? null) === (here?.dir ?? null)) return undefined
  return p.checkout ? { text: folderName(p.checkout.dir), kind: p.checkout.kind, dir: p.checkout.dir } : { text: ROOT_CHECKOUT_WORD, kind: "root" }
}

/** The hint's tooltip: where it runs, in words and in full. */
export function folderHintTitle(hint: ProcessFolderHint, projectDir: string | undefined, homeDir: string | undefined): string {
  if (hint.kind === "root") return projectDir ? `Runs in the project root\n${abbreviateHome(projectDir, homeDir)}` : "Runs in the project root"
  const head = hint.kind === "worktree" ? `Runs in the ${hint.text} worktree` : "Runs in another folder"
  return `${head}\n${abbreviateHome(hint.dir!, homeDir)}`
}

// THE HINT'S MARK, the header token's own glyph for the same kind of place (ThreadCheckoutToken): a git
// folder for a worktree, a plain one for the root or any other folder. It is what tells a hint from the
// readings beside it — the bare word, in the readings' own tone, read as one more reading (`main · 52 lines
// · 40m`). It never stands without its word (WHO GIVES WAY): alone, a plain folder named nothing, and read
// as "another folder" — the header token's vocabulary — on a row that was in fact at the root.
const HINT_GLYPH = { worktree: FolderGit2, folder: Folder, root: Folder } as const
// One step louder than the readings (muted-40) and one quieter than the label (muted-70) — the header
// token's own muted-60 — so a place reads as a fact about the row, not as a count or a clock.
const HINT_TONE = "text-muted-60"
// Centred on the row's line like every other mark on it — but not by the row's shared MARK_LIFT, because the
// two folders ink their 24-unit viewBox differently: lucide's plain folder spans y 2–21 with its stroke (a
// hair above centre), the git folder y 2–23 (its branch stem hangs to the bottom edge). MEASURED, label
// cap-band centre minus the glyph's ink centre, sans description label, dsf 6, live stack, 2026-09-29: with
// MARK_LIFT on both, the plain folder read +0.18px (high) and the git folder −0.30px (low). So each takes
// its own lift, in em at the row's 11.5px: MARK_LIFT's −0.345px plus the residual, i.e. −0.165px and
// −0.645px. On a mono command row the whole line sits ~0.15px higher (see MARK_LIFT), as every mark does.
const HINT_ICON: Record<ProcessFolderHint["kind"], string> = {
  worktree: "h-[1em] w-[1em] shrink-0 -translate-y-[0.056em]",
  folder: "h-[1em] w-[1em] shrink-0 -translate-y-[0.0143em]",
  root: "h-[1em] w-[1em] shrink-0 -translate-y-[0.0143em]",
}

// The header token's `1cap` centring, per glyph for the reason HINT_ICON gives: MEASURED on the rail, status
// cap-band centre minus glyph ink centre, sans, 12px, dsf 6, live stack, 2026-09-30 — the plain folder +0.13px
// (high: sub-pixel, left alone) and the git folder −0.37px (low), which a further 0.031em lifts to ~0.
const RAIL_HINT_LIFT: Record<ProcessFolderHint["kind"], string> = {
  worktree: "translate-y-[calc(0.5em_-_0.5cap_-_0.031em)]",
  folder: "translate-y-[calc(0.5em_-_0.5cap)]",
  root: "translate-y-[calc(0.5em_-_0.5cap)]",
}

/** A folder hint on a BASELINE line — the resting card's rows (WaitRow), where
 *  it sits between the name and the status, leading the status as it leads the strip's readings. It gives
 *  way as the strip's does (WHO GIVES WAY, below): a box sized from zero that grows into what the NAME
 *  leaves, so the word wraps away (the box is one line tall and clips) before the name loses a pixel — and
 *  the GLYPH, the box's first item, never does: `min-w-[1em]` is its width, so a row whose word cannot fit
 *  still says, and its tooltip names, that it runs somewhere other than the header says. The `·` before the
 *  status sits after the box, so it stays with the glyph.
 *
 *  The glyph takes the header token's geometry (ThreadCheckoutToken): its box stands on the baseline and
 *  `1cap` lifts its centre onto the cap band, in any font — and, as the box's first baseline item, it is what
 *  gives the box its baseline. `ml-3` is the name→status floor the plain row keeps. */
export function FolderHintToken({ hint, title }: { hint: ProcessFolderHint; title: string }) {
  const Glyph = HINT_GLYPH[hint.kind]
  return (
    <>
      <span data-process-give data-process-checkout={hint.kind} title={title} className={`ml-3 flex h-[1lh] w-0 min-w-[1em] flex-1 basis-0 flex-wrap content-start items-baseline justify-end overflow-hidden ${HINT_TONE}`}>
        {/* INLINE in its own box, not a bare flex item: an inline run carries the line's strut, so this first
            line is a full line tall even when it holds the glyph alone — a bare 1em SVG made it 12px, and the
            word that had wrapped to the "hidden" second line showed its top 8px under the row. */}
        <span className="shrink-0 whitespace-nowrap">
          <Glyph aria-hidden className={`inline h-[1em] w-[1em] align-baseline ${RAIL_HINT_LIFT[hint.kind]}`} />
        </span>
        <span data-process-checkout-word className="ml-[0.25em] shrink-0 whitespace-nowrap">{hint.text}</span>
      </span>
      <span aria-hidden className="mx-1 shrink-0 text-muted-25">·</span>
    </>
  )
}

/** An agent terminal's folder hint for a WaitRow (the resting card's rows), on the strip's rule. A hook for
 *  the board's folders; call it unconditionally, with the shell when it resolved. */
export function useShellFolderHint(shell: Pick<BgShellView, "checkout" | "atRoot"> | undefined, here: WorkCheckout | null | undefined): ReactNode {
  const board = useBoard()
  const projectDir = useThreadProjectDir()
  const hint = shell ? processFolderHint({ placed: Boolean(shell.checkout || shell.atRoot), ...(shell.checkout ? { checkout: shell.checkout } : {}) }, here) : undefined
  return hint ? <FolderHintToken hint={hint} title={folderHintTitle(hint, projectDir ?? board?.projectDir, board?.homeDir)} /> : undefined
}

// WHO GIVES WAY at a narrow width, first to last (the maintainer's rule: the label keeps priority over the
// hint, and the hint truncates or drops first):
//   1. the line counter — the least identifying reading, and one a card never shows at all;
//   2. the folder hint's WORD;
//   3. the label, by truncating.
// Never: the arrow, the owner mark, the tag, the ×, the budget / state / age — or the hint's GLYPH.
//
// THE GLYPH NEVER GOES, because a row with no hint CLAIMS the header's checkout: the hint exists only where a
// row runs somewhere else, so a `root` row whose hint had wrapped away read as running in the agent's
// worktree — false, and silently so (1400px rail, 390px strip, 2026-09-30). So where the word cannot sit beside
// the whole label, the glyph stays alone, its tooltip naming the folder: 1em of the label's width buys a row
// that never lies about where it runs. (One round before this kept the glyph too, but ahead of a label that
// still fitted — `Running root tick l…` beside a bare folder AND its word's `·`, 20px that fitted the label
// whole. The glyph now stays only once its word is gone, and costs the label its own 1em and no more.)
//
// HOW, in plain flexbox and with nothing measured: the hint and the counter sit in one box, GIVE, sized from
// ZERO (`flex: 1 1 0`, `w-0`), so it grows only into what the row has left AFTER the label has its full width.
// Its first item is kept on a flex line whatever its width, and every item after it wraps onto a hidden second
// line (the box is one line tall and clips) the moment it no longer fits, the LAST one first. Without a hint
// that first item is a zero-width strut, and every item carries its own trailing `·`. With one it is the
// hint's GLYPH, and GIVE's `min-w-[1em]` is that glyph's width, the one thing it takes from the label; the
// word, then any item after it, each LEAD with their `·`, and so do the fixed readings, so nothing is left
// dangling whichever of them goes. The readings after GIVE are `shrink-0`, so it is the label that truncates.
//
// SPACING, in the readings' own rhythm (4px · 4px): GIVE's `-mr-0.5` takes the row's 6px gap to FIXED down
// to the 4px the readings keep between themselves, and `gap-x-1` is the same 4px between GIVE's own items.
const GIVE = "flex h-[1lh] w-0 min-w-0 flex-1 basis-0 flex-wrap content-start items-center justify-end gap-x-1 overflow-hidden -mr-0.5"
// A hinted row's: the glyph's own width reserved, and each item spaced by its own margin (the glyph→word
// distance is the header token's, not the 4px between readings).
const GIVE_HINTED = "flex h-[1lh] w-0 min-w-[1em] flex-1 basis-0 flex-wrap content-start items-center justify-end overflow-hidden -mr-0.5"
const GIVE_ITEM = "flex h-[1lh] shrink-0 items-center gap-1 whitespace-nowrap"
const FIXED = "flex shrink-0 items-center gap-1 whitespace-nowrap text-muted-40"
const SEP = <span aria-hidden className="text-muted-25">·</span>

/**
 * ONE ROW for one process, whoever started it. The ops strip's row box (ChildOpRow's sheet density):
 *
 *   ⤷ [owner glyph, hue = state] TERM  label  × ……  [📁 root ·] [N lines ·] [times out in 45m | state] · 12m
 *
 * The tag is `TERM` for every row: the owner is the glyph's job, and the tag's word is the kind of thing
 * this is — a terminal, whether its output streams from a pty (yours) or from the file the harness writes
 * (the agent's). Every row opens the same drawer.
 */
export function ProcessRow({ process: p, slug, here, lines, watched, caption, onOpen }: {
  process: ThreadProcess
  slug: string
  /** Where the header says the thread's agent is working (thread.checkout) — the folder hint's reference. */
  here?: WorkCheckout | null
  /** The agent row's live line count, when the surface polls for one (the drawer does, a card does not). */
  lines?: number
  watched?: boolean
  /** The row is a CAPTION — the prompting terminal's own row over its live screen on a queue card
   *  (TerminalPromptPane). Its `waiting for input` gives way with the hint, before the label: the attention-
   *  bordered screen directly under it already says so, and the row is there to say WHICH terminal asks. */
  caption?: boolean
  /** Absent ⇒ a non-interactive row (a transcript-only shell with nothing to open). */
  onOpen?: () => void
}) {
  const api = useThreadApi()
  const board = useBoard()
  const projectDir = useThreadProjectDir()
  const now = useNowMs()
  const [busy, setBusy] = useState(false)
  const Glyph = OWNER_GLYPH[p.owner]
  const terminal = p.terminal
  const human = p.owner === "human"
  // A live row shows its age whoever owns it — a terminal of yours waiting at a prompt included: it is
  // running, and its own drawer reads `waiting for input · 6m`.
  const age = processIsLive(p) ? liveAgeSince(p.startedAt, now) : undefined
  // Not live ⇒ how it ended, in one vocabulary for both owners: `finished`, `stopped`, `exit N` / `failed`.
  const stateText = human && p.state !== "running" && terminal ? terminalStateLabel(terminal) : p.ended ? endedShellStateLabel(p.ended) : undefined
  const counter = !human && p.shell?.id && !p.outputUnavailable ? shellLinesLabel(lines) : undefined
  const hint = processFolderHint(p, here)
  // A COMMAND is set in mono, whoever ran it: yours always is one, and so is an agent row whose label IS
  // its command (a Codex exec with no description — its board row carries the command as its label). The
  // same text changing typeface from one row to the next read as two kinds of thing.
  const commandLabel = human || (p.shell?.command !== undefined && p.shell.command === p.label)
  const title = processTitle(p, board?.homeDir, watched)
  const noun = human ? "your terminal" : p.monitor ? "agent monitor" : "agent terminal"

  // The × is Stop while yours runs and Remove once it has ended; on the agent's it is the ops strip's own
  // × (childOpDismisser): offered only when the server says the shell can really be stopped. Its tooltip
  // names the thing by the row's own noun — "operation" was the sub-agent row's word.
  const agentDismiss = !human && p.shell ? childOpDismisser(slug, p.shell, p.monitor ? "MONITOR" : "SHELL", api) : undefined
  // A FINISHED agent terminal's × is Clear, as a finished terminal of yours has Remove: the server forgets
  // the row (FoldState.dismissedOps) and its drawer still resolves from the retired ring.
  const endedId = p.ended?.id
  const endedDismiss = endedId ? () => {
    if (busy) return
    setBusy(true)
    void dismissChildOp(slug, endedId, p.monitor ? "MONITOR" : "SHELL", api).finally(() => setBusy(false))
  } : undefined
  const humanDismiss = human && terminal ? () => {
    if (busy) return
    setBusy(true)
    const running = terminal.state === "running"
    const call = running ? api.terminalStop({ id: terminal.id }) : api.terminalRemove({ id: terminal.id })
    call
      .catch((error: unknown) => showToast(error instanceof Error ? error.message : `Could not ${running ? "stop" : "remove"} this terminal`))
      .finally(() => setBusy(false))
  } : undefined
  const dismiss = humanDismiss ?? endedDismiss ?? agentDismiss
  const dismissTitle = human
    ? terminal?.state === "running" ? "Stop — end this terminal" : "Remove — forget this finished terminal"
    : p.ended ? `Clear — forget this finished ${noun}`
    : p.state === "running" ? `Stop — end this ${noun}` : `Clear — stop tracking this ${noun}`
  const dismissVerb = human ? (terminal?.state === "running" ? "Stop" : "Remove") : p.state === "running" ? "Stop" : "Clear"

  const identity = (
    <>
      <span aria-hidden className={CHILD_ARROW_CLASS}>{CHILD_ARROW}</span>
      <span className={OWNER_SLOT}>
        <Glyph aria-hidden strokeWidth={OWNER_STROKE[p.owner]} className={`${OWNER_ICON} ${PROCESS_HUE[p.state]}`} data-process-mark={p.owner} data-running-indicator={RUNNING_INDICATOR[p.state]} />
      </span>
      <span className={CHILD_KIND_TAG_CLASS}>TERM</span>
      <span data-process-label className={onOpen ? `${LABEL} group-hover:text-fg/80 group-hover:underline` : LABEL}>
        {commandLabel ? <span className={COMMAND_RUN}>{p.label}</span> : p.label}
      </span>
    </>
  )
  const stateNode = stateText
    ? <span key="state" data-process-state-text className={p.state === "prompt" ? "text-attention" : p.state === "failed" ? DANGER : undefined}>{stateText}</span>
    : null
  // The readings that never give way, in the one order every surface reads them: the budget or the state,
  // then the age, rightmost — the column a stack of rows is read down (ChildOpRow's rule).
  const fixed = [
    p.budget ? <span key="budget" data-child-op-budget title={p.budget.title} style={p.budget.tone === "danger" ? { color: PRIMER.fgDanger } : undefined}>{p.budget.text}</span> : null,
    caption ? null : stateNode,
    age ? <span key="age" title={`Running for ${age}`}>{age}</span> : null,
  ].filter((node) => node !== null)
  const hintTitle = hint ? folderHintTitle(hint, projectDir ?? board?.projectDir, board?.homeDir) : undefined
  const HintGlyph = hint ? HINT_GLYPH[hint.kind] : undefined
  // GIVE's items, in reading order. Without a hint each carries the `·` to whatever follows it on the row, and
  // so goes with it; with one, each leads with its own (see WHO GIVES WAY).
  const givingState = caption ? stateNode : null
  const stateSep = Boolean(counter || fixed.length > 0)
  const counterSep = fixed.length > 0

  return (
    <div
      className={ROW}
      data-process-row={p.key}
      data-process-owner={p.owner}
      data-process-state={p.state}
      data-terminal-row={terminal?.id}
      data-terminal-state={terminal ? (terminal.awaitingInput ? "prompt" : terminal.state) : undefined}
      data-op-row={dismiss ? "" : undefined}
    >
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          // The strip sits inside a card or drawer whose own mousedown handler would otherwise act on it.
          onMouseDown={(event) => event.stopPropagation()}
          title={title}
          aria-label={`Open ${noun}: ${p.label}`}
          className={`${IDENTITY} cursor-pointer`}
        >
          {identity}
        </button>
      ) : (
        <div title={title} className={IDENTITY}>{identity}</div>
      )}
      {dismiss && (
        <button
          type="button"
          onClick={dismiss}
          onMouseDown={(event) => event.stopPropagation()}
          disabled={busy}
          title={dismissTitle}
          aria-label={`${dismissVerb} ${noun}: ${p.label}`}
          className={DISMISS}
        >
          {busy ? <Loader2 size={11} className={`animate-spin ${MARK_LIFT}`} /> : <X size={11} className={MARK_LIFT} />}
        </button>
      )}
      {hint && HintGlyph ? (
        <span data-process-give className={GIVE_HINTED}>
          {/* The glyph: GIVE's first item, which a flex line always keeps — the hint never leaves the row. */}
          <span data-process-checkout={hint.kind} title={hintTitle} className={`${GIVE_ITEM} ${HINT_TONE}`}>
            <HintGlyph aria-hidden className={HINT_ICON[hint.kind]} />
          </span>
          {/* `ml-[0.2em]`: 4.0px of ink from the folder to its name at 11.5px, the header token's own 3.9px at
              11px (ink-gaps, dsf 6); its 0.25em drew 4.55 here, the glyph's 1px of dead box on each side. */}
          <span data-process-checkout-word title={hintTitle} className={`${GIVE_ITEM} ml-[0.2em] ${HINT_TONE}`}>
            <span className="max-w-[12ch] truncate">{hint.text}</span>
          </span>
          {givingState && <span className={`${GIVE_ITEM} ml-1`}>{SEP}{givingState}</span>}
          {counter && (
            <span className={`${GIVE_ITEM} ml-1 text-muted-40`}>
              {SEP}
              <span data-child-op-counter title="Lines of output so far — open the row to read them">{counter}</span>
            </span>
          )}
        </span>
      ) : (
        <span data-process-give className={GIVE}>
          {/* The strut: GIVE's first item, which a flex line always keeps, so that everything after it can wrap. */}
          <span aria-hidden className="h-[1lh] w-0" />
          {givingState && (
            <span className={GIVE_ITEM}>
              {givingState}
              {stateSep ? SEP : null}
            </span>
          )}
          {counter && (
            <span className={`${GIVE_ITEM} text-muted-40`}>
              <span data-child-op-counter title="Lines of output so far — open the row to read them">{counter}</span>
              {counterSep ? SEP : null}
            </span>
          )}
        </span>
      )}
      {fixed.length > 0 && (
        // The readings are the row's sans, on the same line as the label (see LABEL), so they need no lift. After
        // a hint they lead with their own `·`: the glyph before them stays whatever else gives way.
        <span className={FIXED}>
          {hint ? <span aria-hidden className="text-muted-25">·</span> : null}
          {fixed.flatMap((node, i) => (i === 0 ? [node] : [<span key={`sep${i}`} aria-hidden className="text-muted-25">·</span>, node]))}
        </span>
      )}
    </div>
  )
}

/** Open a process's drawer over its thread's: the pty for yours, the log for the agent's. */
export function openProcessDrawer(slug: string, p: ThreadProcess): void {
  if (p.terminal) pushTerminalDrawer(slug, p.terminal.id, { label: p.terminal.command })
  else {
    const id = p.shell?.id ?? p.ended?.id
    if (id) pushBackgroundShellDrawer(slug, id, { label: p.label, startedAt: p.startedAt })
  }
}

/** Whether a row has anything to open: every terminal of yours, and every agent shell the board tracks —
 *  running or finished. */
export function processOpenable(p: ThreadProcess): boolean {
  return Boolean(p.terminal || p.shell?.id || p.ended)
}

/**
 * EVERY PROCESS ON THE THREAD, in one strip (lib/threadProcesses.ts): your terminals and the agent's, one
 * row shape, one label column, one drawer. `surface="drawer"` polls the agent rows' line counters (the
 * page's own project, which a drawer always is); a card's rows carry their age and budget alone.
 *
 * A CARD LISTS ONLY WHAT IS LIVE (cardProcesses). Finished terminals — yours and the agent's — stay in the
 * drawer's strip until removed or cleared, where their exit is worth a line; on a card they only grew it —
 * ten rows and a 959px card at 420px in one verifier's session (2026-09-29), three of them runs long over.
 */
export function ThreadProcessStrip({
  thread,
  surface,
  transcriptShells = [],
  scopedToSubAgent = false,
  onOpen,
  className,
}: {
  thread: Pick<ThreadView, "id" | "terminals" | "bgShells" | "watches" | "checkout"> & Partial<Pick<ThreadView, "endedShells">>
  surface: "drawer" | "card"
  /** The transcript's copy of the agent's shells (Codex's live execs, a sub-agent's own shells). */
  transcriptShells?: readonly (BgShellView & TranscriptShellRecord)[]
  /** A sub-agent drawer's strip: only that child's transcript shells, and none of yours. */
  scopedToSubAgent?: boolean
  /** What opening a row does. Absent ⇒ the process's own drawer, over this thread's. */
  onOpen?: (process: ThreadProcess) => void
  className?: string
}) {
  const now = useNowMs()
  const all = threadProcesses(thread, transcriptShells, { scopedToSubAgent, now })
  const processes = surface === "card" ? all.filter(onCard(thread)) : all
  const polled = surface === "drawer" ? processes.flatMap((p) => (p.owner === "agent" && p.shell?.id && !p.outputUnavailable ? [p.shell.id] : [])) : []
  const lines = useBackgroundShellLines(thread.id, polled)
  // IS A WATCHER ARMED ON THIS SHELL? A `shell` watch is a property of the row already here, never a row
  // of its own (maintainer 2026-08-14), so it rides that row's tooltip. It matters because the runtime's
  // own completion notice does not survive the worker resting (1191 of 1601 such shells in the corpus
  // never got one); a watch is what makes "will this thread hear about it" a yes.
  const watchedTargets = new Set((thread.watches ?? []).filter((w) => w.kind === "shell" && w.state === "armed").map((w) => w.target))
  const isWatched = (p: ThreadProcess) =>
    p.owner === "agent" && (watchedTargets.has(p.shell?.taskId ?? "") || watchedTargets.has(p.shell?.id ?? "") || watchedTargets.has(p.label))
  const [expanded, setExpanded] = useState(false)
  if (processes.length === 0) return null
  const open = onOpen ?? ((p: ThreadProcess) => openProcessDrawer(thread.id, p))
  const { shown, hidden, foldable } = collapseFinished(processes, expanded)
  return (
    <div data-thread-processes={surface} className={`flex min-w-0 flex-col gap-0.5 ${className ?? ""}`}>
      {shown.map((p) => (
        <ProcessRow
          key={p.key}
          process={p}
          slug={thread.id}
          here={thread.checkout}
          lines={p.shell?.id ? lines.get(p.shell.id) : undefined}
          watched={isWatched(p)}
          onOpen={processOpenable(p) ? () => open(p) : undefined}
        />
      ))}
      {foldable && (
        <div className={ROW}>
          <button
            type="button"
            data-process-fold={expanded ? "expanded" : "collapsed"}
            onClick={() => setExpanded((v) => !v)}
            onMouseDown={(event) => event.stopPropagation()}
            aria-expanded={expanded}
            className={`${IDENTITY} cursor-pointer`}
          >
            {/* The arrow, mark slot and kind tag held invisibly, so the words sit on the rows' label column. */}
            <span aria-hidden className={`${CHILD_ARROW_CLASS} invisible`}>{CHILD_ARROW}</span>
            <span aria-hidden className={OWNER_SLOT} />
            <span aria-hidden className={`${CHILD_KIND_TAG_CLASS} invisible`}>TERM</span>
            <span className="min-w-0 truncate text-muted-45 group-hover:text-fg/80 group-hover:underline">
              {expanded ? "Show fewer" : `Show ${hidden} more`}
            </span>
          </button>
        </div>
      )}
    </div>
  )
}

// ── opening one ───────────────────────────────────────────────────────────────────────────────────────

/** Start a terminal on a thread and show it: by default the terminal's drawer, over the thread's. A caller
 *  whose thread may be another project's (a card on All projects) passes its own `show`, since the drawer
 *  stack is the focused project's and a terminal drawer pushed there finds no thread and reads as closed. */
export async function openThreadTerminal(api: Api, slug: string, input: { command?: string; cwd?: string }, show: (id: string) => void = (id) => pushTerminalDrawer(slug, id, { label: input.command })): Promise<void> {
  const { id } = await api.terminalStart({ slug, ...input })
  show(id)
}

/** Open a terminal from the thread composer's `$` line (lib/threadTerminals.ts composerTerminalLine). */
export function startComposerTerminal(api: Api, slug: string, command: string | undefined, onFailed: () => void, show?: (id: string) => void): void {
  openThreadTerminal(api, slug, { command }, show).catch((error: unknown) => {
    onFailed()
    showToast(`Could not open a terminal: ${(error instanceof Error ? error.message : String(error)).slice(0, 80)}`)
  })
}

/** Which rows a queue card's strip draws: the live ones (see ThreadProcessStrip), minus the terminal whose
 *  prompt the card already shows with its own row above its screen (TerminalPromptPane). */
/** Whether a card's thread is the page's focused project's, so its terminal can open over its drawer here. */
export function focusedProject(slug: string | undefined): boolean {
  const focus = projectSlug()
  return slug === focus && store.board?.projectSlug === focus
}
