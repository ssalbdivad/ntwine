import { createContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useSnapshot } from "valtio"
import { ArrowUp, FileText, Loader2, Paperclip, Plus, Repeat, X } from "lucide-react"
import { ATTACHMENT_ACCEPT, ATTACHMENT_MAX_BYTES, isAllowedAttachmentName, type EmbedPickedFile, type ThreadSkill } from "@ntwine/shared"
import { showToast } from "../store.ts"
import { joinComposerValue, splitComposerValue } from "../lib/imagePaths.ts"
import { splitProseByTokens } from "../lib/composerContext.ts"
import { clipFenceRuns, scanInputFences } from "../lib/inputCodeFences.ts"
import { renderInputFenceRun } from "./TextareaCodeFences.tsx"
import { shouldInterruptSubmitComposerEnter, shouldPushQueuedComposerEnter, shouldRestoreOptionEnterNewline, shouldSubmitComposerEnter } from "../lib/composerKeyboard.ts"
import { queueComposerHandlesOptionEnter } from "../lib/queueComposerKeyboard.ts"
import { focusQuestionFrom } from "../lib/questionKeys.ts"
import { composerRail, SEND_SPLIT_WIDTH } from "../lib/iconRhythm.ts"
import type { SendMode } from "../lib/sendMode.ts"
import { SendSplitButton } from "./SendSplitButton.tsx"
import { prefs } from "../lib/prefs.ts"
import { apiBase } from "../lib/base-path.ts"
import { detectPlatform, effortStepOf } from "../lib/keybindings.ts"
import { localImageUrl } from "../lib/markdownTargets.ts"
import { DROPPED_URI_TYPES, droppedUris, fileQueryAt, insertFileReference, insertReferencesAt, isVscodeDrag, type FileMentionSource } from "../lib/editorReach.ts"
import { basename, dirnameLike } from "../lib/paths.ts"
import { draftStart, insertSlashCommand, matchSlashItems, slashQueryAt, slashSegments } from "../lib/slashCommands"
import { insertMention, matchMentions, mentionQueryAt, mentionSegments, resolveMention, splitMentionQuery, subAgentMentionCandidates, type MentionCandidate } from "../lib/threadMentions.ts"
import { insertProjectMention, leadingProjectRoute, matchProjects, projectQueryAt, scanProjectMentions, useProjectMentions, type ProjectMentionCandidate } from "../lib/projectMentions.ts"
import { useSubAgentDirectory } from "../hooks/useSubAgentDirectory.ts"
import { useKeyboardInset } from "../lib/keyboardInset.ts"
import { inSkippedCard, whenCardRendered } from "../lib/cardVisibility.ts"
import type { BoxInputEvent } from "../lib/scheduleReadScheduler.ts"
import { useFileDropZone, type SurfaceFileDrop } from "../lib/fileDrop.ts"

// The shared prompt composer (the pattern the user called "perfect"): ONE rounded bordered box
// holding a borderless auto-growing textarea plus a small round accent send button hovering INSIDE
// at the bottom-right. Grows with content up to maxHeight, then scrolls. ⌘/Ctrl-Enter submits
// (2026-08-26); every other Enter — plain, Shift, Option — keeps the browser's native newline, with a
// no-op fallback for Chromium's macOS Option-Enter quirk. Queue retains its separately-owned
// Option-Enter handling. Escape BLURS
// (climbs out — the next Esc, at rest, unwinds a drawer via
// App's window handler). Keyboard handling is entirely LOCAL: the focus machine that used to
// arbitrate boundary keys was deleted with the mouse-only sidebar. `surface` remains only as a
// data- tag for per-card input targeting (lib/keyboardRuntime.ts REPLY_BOXES queries it for `r`).
// Upload a dropped/pasted/picked file and return its server-side absolute path. The path goes INTO the
// message text: workers open it with their Read/file tool; the chat renders images via /local-image and
// non-image files as an openable chip. The shared extension allowlist (images, docs/text/code, office,
// data and archive formats) is enforced server-side too — the /attach route is the trust gate.
async function uploadAttachment(file: File, name: string, base: string): Promise<string | null> {
  // The project this upload is FOR, resolved before the file is read rather than after. `apiBase()`
  // answers for whatever the address bar says at the instant it is called, and reading a large file is
  // long enough for the operator to switch projects: the attachment then landed in the state directory
  // of a project the message was never going to, while the message itself went to the thread they
  // started from. Anything read across an await has to be captured on THIS side of it — which is why
  // the caller resolves `base` and hands it in.
  const buf = await file.arrayBuffer()
  let bin = ""
  const bytes = new Uint8Array(buf)
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  const res = await fetch(`${base}/attach`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, data: btoa(bin) }),
  })
  if (!res.ok) return null
  const json = (await res.json()) as { path?: string }
  return json.path ?? null
}

// Where a `/` suggestion came FROM, in this repo's own vocabulary rather than either harness's. Claude
// says `projectSettings`/`userSettings`, codex says `repo`/`user`; the server normalizes both to the
// shared enum and this names them the way the docs and the maintainer do — a skill in the checkout is
// "project", one in the home directory is "global" (see CLAUDE.md § project-local skills). Rendered in
// petite caps: a metadata tag the eye can skip, not more description to read.
const SKILL_SOURCE_LABEL: Record<NonNullable<ThreadSkill["source"]>, string> = {
  project: "project",
  user: "global",
  builtin: "built-in",
  plugin: "plugin",
  ntwine: "ntwine",
}

// Both typeahead menus' row inset: the textarea's 14px on the left, and 6px on the right because the
// list's reserved 8px scrollbar gutter supplies the rest (see the skills menu's row).
const MENU_ROW_INSET = "pl-3.5 pr-1.5"

// The `@` menu with the editor's files in it (the `fileMentions` prop): one row per thread or file, in
// one keyboard order. While files are offered the threads give way to a few, and the files to the most
// the menu shows without scrolling far; a narrower query is a keystroke away.
// A `#` query fills the same menu with the machine's projects instead (lib/projectMentions.ts).
type MentionRow = { kind: "thread"; thread: MentionCandidate } | { kind: "file"; file: EmbedPickedFile } | { kind: "project"; project: ProjectMentionCandidate }
const THREADS_BESIDE_FILES = 4
const NO_PROJECTS: readonly ProjectMentionCandidate[] = []
const FILE_ROWS = 12
/** How long the menu waits after a keystroke before asking the editor for files. */
const FILE_QUERY_DEBOUNCE_MS = 60

// A staged context reference in the prose is the literal `@guide.md:3` token the ⌘I flow splices in
// at the caret (lib/composerContext.ts) — the chip's own label, so the text reads as the chip. The
// BACKDROP below paints the pill behind each staged token; the token itself is ordinary textarea
// text, which is what lets it sit at ANY position in the prose, wrap with it, and be edited like
// text (the previous chips-in-an-overlay system could only open the first line, which put every
// reference at the box's start regardless of the caret — maintainer 2026-09-02: "the context chip
// still shows up at the beginning of the prompt box instead of where the cursor currently exists";
// a numbered `[^1]` in between read as plumbing — 2026-09-03: "worse than just rendering the chip
// inline").

// THE PILL behind a staged token — its whole look, so it is changed in one place. Tinted from the
// text's own ink (`fg`) rather than a panel token: `bg-panel-2` was a step AWAY from the box's fill in
// one theme and toward it in the other, and read as nothing in either (in light it was lighter than
// the box it sat on, so a chip looked like a hole). An ink tint reads as the same pill on every
// surface the box sits on, in both themes, the way the transcript's own chip is tinted from the
// bubble's ink (ChatView SentContextBody) — with a softer edge than that chip's (7% fill, 14% edge, not
// 20%): with 1px of side room rather than that chip's 4px, the stronger edge drew a box AROUND the text
// rather than a pill under it. Zero-layout, as every backdrop decoration must be: its side pad is bought back
// by an equal negative margin, so the pill reaches 1px past the token's ink on each side — not the 2px
// it had. Two chips added one after another are one SPACE apart (4.13px in this headless sans; ~3.6 in
// Segoe UI, ~3.3 in SF), and 2px a side then merged their edges into one box in Segoe and SF; at 1px
// they stand 1.3-2.1px apart.
//
// The edge is `inset-ring`, NOT `ring-1 ring-inset ring-…`: the theme names a colour `inset`
// (theme.css --color-inset), so Tailwind also makes `ring-inset` a RING COLOUR utility, and it wins
// over the colour beside it — every pill's edge was drawn in --color-inset (#090b10 in dark, nearly
// the box's own fill) and never showed. Measured on the computed box-shadow, 2026-10-01.
const CONTEXT_PILL = "rounded-[5px] bg-fg/[0.07] py-0.5 -mx-px px-px inset-ring inset-ring-fg/[0.14]"

/**
 * A run of the PROSE marked behind its own words — the schedule the box read in them
 * (ARCHITECTURE.md § Scheduled threads). Painted in the highlight layer behind the textarea, so a mark is zero-layout
 * like every backdrop decoration; its whole look is `[data-composer-mark]` in styles.css, in one place:
 *
 *   pending   a faint dotted underline on a schedule word, fading in late, while the model reads the words
 *   accepted  the accent fill — the words Enter turns into WHEN
 *   wash      the fill washing bright and back as the schedule is created
 *
 * `key` is the run's identity across renders: a mark that keeps its key keeps its element, so it never replays
 * its entrance — a phrase that extends just grows, and a tone change plays the new tone's own entrance.
 */
export type ComposerMarkTone = "pending" | "accepted" | "wash"
export type ComposerMark = { start: number; end: number; tone: ComposerMarkTone; key?: string }

/**
 * The runs of the prose where a schedule word never makes the box read for a schedule
 * (`hasScheduleTrigger`): what the backdrop paints as something other than prose — fenced code, the staged ⌘I
 * context tokens — plus every `@mention` and `/command` token, resolved or not. A superset of what the backdrop
 * tints is the safe side: an excluded run only ever costs a read. (Quotes, inline code and a leading `/command`
 * the trigger skips on its own.)
 */
export function composerExcludeRuns(prose: string, contextTokens: readonly string[] = []): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = []
  for (const run of scanInputFences(prose) ?? []) if (run.kind !== "prose") out.push({ start: run.start, end: run.end })
  let at = 0
  for (const run of splitProseByTokens(prose, contextTokens)) {
    if (run.token) out.push({ start: at, end: at + run.text.length })
    at += run.text.length
  }
  for (const m of prose.matchAll(/(^|[\s(])([@/][^\s]+)/g)) {
    const start = m.index + m[1]!.length
    out.push({ start, end: start + m[2]!.length })
  }
  return out
}

/** The marks that fit the prose, in order, overlaps clipped — a mark over words that are gone draws nothing. */
export function fittedMarks(marks: readonly ComposerMark[] | undefined, length: number): ComposerMark[] {
  if (!marks?.length) return []
  const out: ComposerMark[] = []
  let at = 0
  for (const m of [...marks].sort((a, b) => a.start - b.start)) {
    const start = Math.max(m.start, at)
    const end = Math.min(m.end, length)
    if (end <= start) continue
    out.push({ ...m, start, end })
    at = end
  }
  return out
}

// THE PHONE LAYOUTS (below the 700px breakpoint; the caller decides, with useIsMobile). Same draft,
// same attachment intake, same keyboard rules, same send — only the shell around the textarea differs.
//
//   "bar"  — a thread's bottom bar (the approved phone design, 2026-09-30). At rest it is ONE row: a
//            round + (attach), a pill field, and one verb on the right. The verb follows the draft: with
//            text it is Send; with none it is whatever the caller passes as `idlePrimary` (the thread's
//            Done), or a disabled ↑. Focus or text opens the field into a box whose second row carries
//            the + , the caller's `tools` (the model chip) and the verb. `override` is the seam for a
//            bar that is not a prompt at all — see PhoneBarApi.
//   "page" — the new-thread page: the textarea fills the space it is given, and the tool row (+ and
//            `tools`) sits under it. The page's own header carries the send.
//
// Both ride the software keyboard: a spacer under the bar, sized by useKeyboardInset, lifts it onto
// the keyboard while the panel above shrinks.
export interface PhoneBarApi {
  /** Switch the bar back to the prompt and focus it (opens the keyboard: call it from a tap). */
  editReply: () => void
}

export type PhoneComposerLayout =
  | {
      layout: "bar"
      tools?: ReactNode
      // The verb when the draft is empty. `compact` is true inside the open box's toolbar (36px),
      // false in the resting row (42px).
      idlePrimary?: (compact: boolean) => ReactNode
      // THE ANSWER SEAM. When set, the resting bar renders this INSTEAD of its row — a thread with open
      // questions shows [keyboard] + "Answer N questions" there. The textarea stays mounted (hidden),
      // so `editReply` can focus it inside the same tap and iOS still raises the keyboard; once the
      // field has focus or text, the ordinary prompt row returns, and the override comes back when it
      // is empty and blurred again.
      override?: (api: PhoneBarApi) => ReactNode
      // Long-press (≈500ms) on Send. Only passed where interrupt-and-send is allowed
      // (canInterruptAndSend); without it a long press is an ordinary send.
      onLongPressSend?: () => void
    }
  | { layout: "page"; tools?: ReactNode }

const LONG_PRESS_MS = 500

// HOLDING THE BAR OPEN. The open box's toolbar is only there while the field has focus or text — but a
// control in it that opens a sheet (the model chip) closes the keyboard first, which blurs an empty
// field, which would unmount the toolbar and the sheet it just opened along with it. A toolbar control
// calls `hold(true)` for as long as its sheet is up, and the bar stays open until it lets go.
export const PhoneBarHoldContext = createContext<((held: boolean) => void) | null>(null)

// THE THREAD PROMPT BOX'S SEND — passed by ThreadComposerBox, absent on the dispatch composer (which
// keeps the ↑ square: it starts a thread, and has nothing to steer or queue behind). With it the rail's
// Send is the split button (SendSplitButton), and the box can send with NO text of its own: `staged`
// counts the answers waiting on the question cards around it, which this same send carries.
export interface ComposerSendControl {
  mode: SendMode
  onMode: (mode: SendMode) => void
  /** A turn is in flight — the only time the menu's two rows differ. */
  running: boolean
  staged: number
}

// Auto-grow: reset to auto, then snap to content height clamped at maxHeight.
//
// BATCHED across every composer on the page (2026-10-01). Each snap writes `height` and then reads
// `scrollHeight`, which forces a layout of the whole page — and the queue mounts one composer per card
// in a single commit, so N composers forced N full layouts of a page that grows with N. On a 247-card
// mirror of a busy machine that was 1.5s of a 20s profile of the page, plus 1.1s more in the cards' own
// clamp measurements, which read layout between the composers' writes and so paid a fresh layout each.
// Requests made in one turn are flushed together in a microtask — still before the browser paints —
// as all the writes, then all the reads (one layout), then all the writes.
//
// THE COLLAPSE MUST NOT SHRINK THE PAGE (2026-10-08). `height: auto` drops the box to one row for the
// read, and a composer at the bottom of a scrolled page takes the document's height down with it — the
// browser clamps the scroll offset to the shorter page during that forced layout, and restoring the
// height does not give it back. Native scroll anchoring would, but the queue suspends it
// (lib/viewportLock.ts), so every keystroke in a card's prompt moved the card by the box's height and
// the lock dragged it back: the card jittered while the human typed. Each textarea's wrapper holds its
// current height as a `min-height` across the measurement, so the page never gets shorter. That costs
// one more layout per FLUSH (the reads of the wrappers), not one per composer.
const pendingSnaps = new Map<HTMLTextAreaElement, number>()
function snapHeight(el: HTMLTextAreaElement, maxHeight: number): void {
  if (pendingSnaps.size === 0) queueMicrotask(flushSnaps)
  pendingSnaps.set(el, maxHeight)
}
function flushSnaps(): void {
  const batch = [...pendingSnaps]
  pendingSnaps.clear()
  const wrappers = batch.map(([el]) => el.parentElement)
  const held = wrappers.map((w) => w?.offsetHeight)
  wrappers.forEach((w, i) => { if (w) w.style.minHeight = `${held[i]}px` })
  for (const [el] of batch) el.style.height = "auto"
  const heights = batch.map(([el, maxHeight]) => Math.min(el.scrollHeight, maxHeight))
  batch.forEach(([el], i) => { el.style.height = `${heights[i]}px` })
  for (const w of wrappers) if (w) w.style.minHeight = ""
}

export function Composer({
  value,
  onChange,
  onSubmit,
  surface,
  placeholder,
  id,
  minHeight = 44,
  maxHeight = 220,
  autoFocus,
  busy,
  footer,
  header,
  aside,
  railLead,
  railPermission,
  contextTokens,
  contextSources,
  slashSuggest,
  slashSuggestVersion,
  mentionCandidates,
  ownMention,
  fileMentions,
  onInterruptSubmit,
  onPushQueued,
  onEffortStep,
  marks,
  onInputEvent,
  onEscape,
  sendGlyph = "send",
  sendTitle,
  sendPending = false,
  attachBase,
  send,
  phone,
  onUploadingChange,
  fileDrop,
  onLeadingProject,
}: {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  // Pure data- tag on the textarea (e.g. lib/keyboardRuntime.ts REPLY_BOXES targets
  // [data-surface="queueComposer"] when `r` focuses a card's input). No focus registry behind it anymore.
  surface: string
  placeholder?: string
  id?: string
  minHeight?: number
  maxHeight?: number
  autoFocus?: boolean
  // While busy the textarea is locked and the send button spins — used for the New-thread dispatch
  // round-trip so the composer commits instantly instead of sitting live during the spawn.
  busy?: boolean
  // Rendered INSIDE the box along its bottom edge (the dispatch form's inline mode/model/effort
  // readouts). The textarea auto-grows above it; the footer strip is always reserved.
  footer?: React.ReactNode
  // Rendered INSIDE the box along its TOP edge, above the text: the editor sidebar's context bar
  // (EditorContextBar), which names what the editor has in front and adds it as a chip. Whatever it
  // renders owns its own inset, so a header that renders nothing costs the box nothing.
  header?: React.ReactNode
  // Rendered at the RIGHT END of the footer strip, before the send rail: a browser tab's line naming what
  // the editor beside it has in front (EditorLine). It owns its own `ml-auto`; a box with no footer has
  // nowhere to put it and drops it.
  aside?: React.ReactNode
  // STAGED CONTEXT — the `@` tokens the ⌘I flow has staged on this thread. Drives the backdrop pill
  // behind each staged token in the prose (an unstaged `@thing` the user happened to type stays
  // plain text) and the atomic Backspace that deletes a whole token. The pill IS the chip: there is
  // no roster of chips anywhere else in the box — a legend row along the bottom edge was tried and
  // cut (maintainer 2026-09-03: "we DONT NEED THE CHIPS AT THE BOTTOM … just the inline chip"), so
  // removing a reference is deleting its text. Order-irrelevant; empty/omitted disables both.
  contextTokens?: string[]
  // Where each staged token came from (`src/a.ts, lines 12-20`), shown as the box's tooltip while the
  // pointer is over that token's pill (lib/stagedContext.ts useStagedContextSources).
  contextSources?: Readonly<Record<string, string>>
  // ⌥⇧↑ / ⌥⇧↓ in the box: one effort up or down the ladder of the model its footer picker shows
  // (lib/keybindings.ts EFFORT_STEP_CHORDS). Only boxes that carry a model picker pass it.
  onEffortStep?: (step: 1 | -1) => void
  // A control at the rail's LEFT end, beyond the paperclip — the thread composer's Goal
  // (ThreadComposerBox). It owns its own popover; this component only places it.
  railLead?: React.ReactNode
  /** The thread's permission mode as a glyph, beyond the Goal (useThreadComposerControls). */
  railPermission?: React.ReactNode
  // SKILLS TYPEAHEAD. When set, a draft that is exactly one `/`-led token opens a suggestion menu of
  // the thread's invocable skills and slash commands (`/context`, `/usage`, …) above the box (fetched lazily, once, on first trigger). The list is
  // whatever the thread's own harness reports — the caller owns sourcing entirely; this component only
  // renders and completes. Surfaces without a session to ask (the dispatch composer) omit it and the
  // whole affordance is inert.
  slashSuggest?: () => Promise<ThreadSkill[]>
  // Changes when the list behind `slashSuggest` has (a user command saved in Settings): the box forgets
  // the list it holds and asks again on the next `/`. A value, not the function's identity — a caller
  // that hands over a fresh arrow every render must not refetch on every render.
  slashSuggestVersion?: string | number
  // MENTION TYPEAHEAD. When set, an `@` at a word boundary with the caret inside its token opens a menu
  // of these threads' handles above the box; choosing one inserts `@handle ` as plain text. The caller
  // owns the list (lib/threadMentions.ts mentionCandidates — the project's threads minus the one being
  // written into); omitted, the affordance is inert.
  mentionCandidates?: readonly MentionCandidate[]
  // The thread this box writes INTO. It completes like any other candidate, offered LAST so it never
  // crowds out the threads a message usually means: `@itself.cache-keys` is how the human points the
  // worker at one of its OWN sub-agents ("what did @port-the-parser.cache-keys find?"), the commonest
  // sub-agent mention there is, and a bare `@itself` still has uses — naming its branch, quoting it to
  // another thread (David 2026-09-30: "@ mentioning the current thread should still autocomplete").
  // Absent on a box that writes into no thread (the dispatch box).
  ownMention?: MentionCandidate
  // THE EDITOR'S FILES, in a prompt box in VS Code's sidebar (lib/editorReach.ts embedFileMentions): the
  // `@` menu offers the workspace's files after the threads, ranked by the editor (its query runs over a
  // path's characters, `@src/web/App`), and choosing one writes a whole-file reference, `` `src/a.ts` ``.
  // Files dragged in from the editor's explorer land as the same references at the caret. Omitted (a
  // browser tab), `@` offers threads alone and a drop is an attachment, as ever.
  fileMentions?: FileMentionSource
  // INTERRUPT AND SEND — what the FORCED chord (⌘/Ctrl-Enter) does while the thread's worker is
  // mid-turn AND its runtime can be preempted; the caller owns that policy entirely. When it is not
  // set, the same chord is an ordinary send, so ⌘-Enter never goes dead (three Enter keys everywhere:
  // Enter sends, Shift/Option-Enter newlines, ⌘/Ctrl-Enter forces — maintainer 2026-08-26).
  //
  // KEYBOARD ONLY — there is deliberately no button here. It used to render a ⚡ in the rail, and the
  // bolt was the wrong picture of the thing (maintainer, 2026-08-03: "we need to drop the lightning
  // bolt icon to mean force push. That doesn't make any sense."). Preempting is now offered where the
  // waiting message actually IS: a ↑ on the queued bubble itself (UserBubble's push-now control), which
  // needs no message payload because the send is already in the provider's queue. The shortcut stays
  // because it is a real send path with muscle memory behind it — only the picture was wrong.
  onInterruptSubmit?: () => void
  // SEND THE WAITING MESSAGE NOW — what ⌘/Ctrl-Enter does in an EMPTY box. Returns whether it acted:
  // the caller owns the "is a follow-up actually queued behind a running turn" check, so with nothing
  // queued it returns false and the keypress keeps its default.
  onPushQueued?: () => boolean
  // Runs of the PROSE marked behind the text (ComposerMark): the schedule the box read in it, so the human sees
  // which words are WHEN and that the rest is the prompt, verbatim. Offsets into the prose the box shows; a mark
  // that no longer fits it draws nothing.
  marks?: readonly ComposerMark[]
  // What the textarea just did — an edit (with its caret, its input type and whether an IME is composing), the
  // end of a composition, a blur — for a caller that reads the words at the end of each one
  // (lib/scheduleReadScheduler.ts). Called before the edit's own onChange.
  onInputEvent?: (event: BoxInputEvent) => void
  // Escape, before the box's own blur. Return true to claim it: the new-thread box's schedule strip goes away
  // ("not a schedule") on the first Escape and keeps the caret, rather than the box being left with it on.
  onEscape?: () => boolean
  // WHAT ENTER DOES, ON THE BUTTON THAT DOES IT. `schedule` while the caller has read a schedule in the words:
  // Send wears the repeat glyph and says "Create schedule", because Enter and a click create it and start
  // nothing. The glyph and Enter's act never disagree.
  sendGlyph?: "send" | "schedule"
  // The send button's title, when the caller knows better than the default — a phone, which has no Enter to name,
  // or a send that is being held (`sendPending`), which says what it is waiting for.
  sendTitle?: string
  // The caller is holding the send — checking the words for a schedule, or creating one — while the text stays
  // live (unlike `busy`): the button spins.
  sendPending?: boolean
  // WHICH PROJECT AN ATTACHMENT IS UPLOADED TO, when it is not the page's. Omitted, `apiBase()` — the
  // page project, which in a drawer or on /full is the thread's own. The cross-project page's queue
  // card shows a thread of ANY project while the page is focused on one, so it passes the thread's
  // project explicitly (AllQueuesCard ReplyBox).
  attachBase?: string
  // See ComposerSendControl. Desktop layouts only; the phone bar keeps its own primary button.
  send?: ComposerSendControl
  // A phone layout (see PhoneComposerLayout). Absent everywhere above the phone breakpoint.
  phone?: PhoneComposerLayout
  // For a surface whose send lives OUTSIDE this box (the phone's new-thread page puts Start in its
  // header): an upload in flight must hold that send too, as it holds Enter and ↑ here.
  onUploadingChange?: (uploading: boolean) => void
  // THE SURFACE IS THE DROP ZONE. The queue card takes a file dropped anywhere on it (lib/fileDrop), so
  // this box binds no drop handlers of its own there: it draws its drop hint while `over` and registers
  // its intake on `intake`. Absent, the box itself is the zone.
  fileDrop?: SurfaceFileDrop
  // A NEW THREAD ADDRESSED BY ITS FIRST WORD (lib/projectMentions.ts leadingProjectRoute): a prompt that
  // opens with `#slug` and a space — typed, pasted, or a project chosen from the `#` menu at the start —
  // hands the caller the project and the box's value without the token. The caller re-aims the box there
  // and returns true, and the box leaves the edit to it; false, and the token stays ordinary text.
  onLeadingProject?: (slug: string, value: string) => boolean
}) {
  const taRef = useRef<HTMLTextAreaElement>(null)
  const contextRef = useRef<HTMLDivElement>(null)
  const highlightRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  // A drag from VS Code's own explorer, which carries resources rather than files: the box references
  // what it names instead of uploading anything. A FILE drag is the drop zone's (`ownDrop` below, or the
  // surface's `fileDrop`).
  const [referenceDrag, setReferenceDrag] = useState(false)
  const [uploading, setUploading] = useState(false)

  // Attachment paths live INSIDE the draft `value` (trailing lines) so submit, draft persistence, and
  // the worker/transcript pipeline stay untouched — but the box PRESENTS them as chips, not raw path
  // text. Split the value into the prose the textarea shows and the trailing attachment paths shown as
  // chips; recombine on every edit so the parent's `value` remains "prose + trailing paths" exactly.
  const { prose, attachments } = useMemo(() => splitComposerValue(value), [value])
  const attachmentPaths = attachments.map((a) => a.path)
  // Latest committed value, readable from an async callback that outlived its render. `takeFiles`
  // awaits the upload, so by the time it commits, `value`/`prose`/`attachmentPaths` in its closure may
  // be stale (the user typed, or another intake landed); it re-derives from this ref instead.
  const valueRef = useRef(value)
  valueRef.current = value
  // Synchronous in-box edits funnel through here: the textarea edits prose (paths unchanged); chip
  // removal edits the path list (prose unchanged). Either way the parent gets the rejoined value.
  const setProse = (nextProse: string) => onChange(joinComposerValue(nextProse, attachmentPaths))
  const setPaths = (nextPaths: string[]) => onChange(joinComposerValue(prose, nextPaths))

  // Attachment intake: drag-and-drop, paste, or the paperclip file picker. Each allowed file's absolute
  // path (returned by /attach) is appended to the message on its own line — images render as inline
  // blocks in the transcript, non-image docs as an openable chip, and the worker opens either with its
  // Read/file tool. An allowed file is any image by MIME (a pasted screenshot often has an empty/generic
  // name — the MIME check preserves the original image-paste behavior) OR any allowlisted file by name
  // (everything the picker's `accept` surfaces). The /attach route re-validates as the trust gate.
  async function takeFiles(files: FileList | File[] | null) {
    if (!files) return
    // Serialize intake: the paperclip button is disabled while uploading, but drop/paste are not, so a
    // second batch could race the first and clobber it (both commit against the same pre-upload base).
    // Reject the concurrent batch with feedback instead — uploads are quick; the user can re-drop.
    if (uploading) {
      showToast("An upload is already in progress — try again in a moment")
      return
    }
    // Effective upload name: the file's real name, else — for a nameless image paste — one derived
    // from its actual MIME subtype. The old blanket `"pasted.png"` fallback stored a TIFF/JPEG paste
    // as lying .png bytes (broken thumbnail, misled worker Read). The name then goes through the SAME
    // shared allowlist the server enforces, so nothing uploads only to 400, and every rejection gets
    // a toast instead of the old silent drop (dropping an unsupported file or image did nothing).
    const named = [...files].map((f) => {
      const sub = f.type.startsWith("image/") ? f.type.slice("image/".length).toLowerCase() : ""
      const ext = sub === "jpeg" ? "jpg" : sub === "svg+xml" ? "svg" : sub
      return { file: f, name: f.name || (ext ? `pasted.${ext}` : "") }
    })
    const typed = named.filter(({ name }) => {
      if (isAllowedAttachmentName(name)) return true
      showToast(`${name || "File"}: unsupported file type`)
      return false
    })
    if (!typed.length) return
    // Reject an oversized file up front with a clear message (the server would 400 anyway — surface it
    // instead of silently dropping). MB is base-10 to match how the OS reports file sizes; floor, so
    // the stated max is never larger than what the server actually accepts.
    const allowed = typed.filter(({ file, name }) => {
      if (file.size > ATTACHMENT_MAX_BYTES) {
        showToast(`${name} is too large (max ${Math.floor(ATTACHMENT_MAX_BYTES / 1e6)} MB)`)
        return false
      }
      return true
    })
    if (!allowed.length) return
    // Snapshot the draft at intake: if it is non-empty now but EMPTY when the upload lands, the
    // message was sent (or the draft deliberately cleared) mid-upload — committing the path then
    // would plant an orphan chip that silently rides along with the user's NEXT, unrelated message.
    // Discard with a toast instead. (Enter/Send inside this box are gated on `uploading`, but a
    // surface can still clear the draft externally — a question card's own Enter, which sends this box.)
    // Best-effort heuristic, not airtight: typing NEW text after such an external clear makes the
    // draft non-empty again before the upload lands, and the path then joins that newer draft.
    const baseValue = valueRef.current
    setUploading(true)
    const paths: string[] = []
    try {
      for (const { file, name } of allowed) {
        const path = await uploadAttachment(file, name, attachBase ?? apiBase())
        // A null means /attach rejected it (decode/write failure — the type allowlist already ran
        // client-side above). Don't leave the user guessing why nothing appeared.
        if (path) paths.push(path)
        else showToast(`Could not attach ${name}`)
      }
    } finally {
      setUploading(false)
    }
    if (paths.length && baseValue !== "" && valueRef.current === "") {
      showToast("Attachment discarded — the message was sent before the upload finished")
      requestAnimationFrame(() => taRef.current?.focus({ preventScroll: true }))
      return
    }
    // Commit against the LATEST value (valueRef), not this callback's render-time closure — the user
    // may have typed, or a prior intake committed, while the upload was in flight. Re-derive prose +
    // existing paths from the freshest value and append this batch, so nothing typed/attached mid-upload
    // is clobbered. The paperclip picker (and, on some browsers, drop/paste) pull focus off the textarea;
    // restore it after the async upload settles so the user can keep typing without re-clicking the box.
    if (paths.length) {
      const latest = splitComposerValue(valueRef.current)
      onChange(joinComposerValue(latest.prose, [...latest.attachments.map((a) => a.path), ...paths]))
    }
    requestAnimationFrame(() => taRef.current?.focus({ preventScroll: true }))
  }

  // Files and folders dragged in from VS Code's explorer: the editor resolves what the drag named to paths
  // on its side, and each lands as a whole-file reference at the caret (at the end when the box did not
  // have it) — what `@` writes, so a dragged file and a typed one read the same to the agent.
  async function takeDropped(uris: string[]) {
    if (!fileMentions || !uris.length) return
    const files = await fileMentions.resolve(uris)
    if (!files?.length) {
      showToast(files === null ? "Update the ntwine extension to drop files here." : "Only files and folders on disk can be added.")
      return
    }
    const latest = splitComposerValue(valueRef.current)
    const el = taRef.current
    const at = el && document.activeElement === el ? Math.min(el.selectionStart, latest.prose.length) : latest.prose.length
    const next = insertReferencesAt(latest.prose, at, files.map((file) => fileMentions.reference(file)))
    onChange(joinComposerValue(next.prose, latest.attachments.map((a) => a.path)))
    setCaret(next.caret)
    requestAnimationFrame(() => {
      taRef.current?.focus({ preventScroll: true })
      taRef.current?.setSelectionRange(next.caret, next.caret)
    })
  }

  // Drag-and-drop intake: the box's own zone, or the surface's (see `fileDrop`). The surface reaches
  // `takeFiles` through its handle, by a ref, because the function closes over this render's draft.
  const ownDrop = useFileDropZone((files) => void takeFiles(files))
  const dragging = referenceDrag ? "reference" : (fileDrop ? fileDrop.over : ownDrop.over) ? "attach" : false
  const takeFilesRef = useRef(takeFiles)
  takeFilesRef.current = takeFiles
  const intake = fileDrop?.intake
  useEffect(() => {
    if (!intake) return
    intake.set((files) => void takeFilesRef.current(files))
    return () => intake.set(null)
  }, [intake])

  // Auto-grow on every value change. A first layout pass
  // can precede font settlement or a narrow drawer's final width, leaving scrollHeight stale and the
  // last wrapped line hidden beneath the in-box controls. Recheck on the next frame and when fonts
  // settle so the textarea always owns enough height for its actual wrapped content.
  useLayoutEffect(() => {
    let active = true
    // A queue card the browser is skipping (lib/cardVisibility.ts) snaps once it is drawn instead: reading
    // `scrollHeight` there would lay that card out just to answer, one card at a time across the queue.
    let waiting: (() => void) | undefined
    const resize = () => {
      const el = taRef.current
      if (!el || !active) return
      if (inSkippedCard(el)) {
        waiting ??= whenCardRendered(el, () => {
          waiting = undefined
          resize()
        })
        return
      }
      snapHeight(el, maxHeight)
    }
    resize()
    const frame = requestAnimationFrame(resize)
    void document.fonts?.ready.then(resize)
    const el = taRef.current
    // Undefined in a skipped card, for the same reason: the observer's first report, once it is drawn,
    // sets it (and the snap above runs then anyway).
    let width = el && !inSkippedCard(el) ? el.clientWidth : undefined
    // A responsive drawer can rewrap a preserved draft without changing its value. Observe width
    // only (not height, which this effect itself owns) and recompute from the new scrollHeight.
    let resizeFrame: number | undefined
    const observer = el ? new ResizeObserver(([entry]) => {
      const nextWidth = Math.round(entry.contentRect.width)
      if (width === undefined) {
        width = nextWidth
        return
      }
      if (nextWidth === width) return
      width = nextWidth
      // Writing `height` while ResizeObserver is delivering causes Chromium's loop warning. Run the
      // measurement in the next frame: the composer still tracks a drawer rewrap, without a browser
      // console error for every narrow-width resize.
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame)
      resizeFrame = requestAnimationFrame(resize)
    }) : undefined
    if (el) observer?.observe(el)
    return () => {
      active = false
      waiting?.()
      cancelAnimationFrame(frame)
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame)
      observer?.disconnect()
    }
    // Footer PRESENCE (not node identity) is the layout signal: it flips the textarea's bottom
    // padding class. Some call sites rebuild the footer JSX every parent render (each board tick on
    // an open thread), and depending on the node itself tore down and rebuilt the ResizeObserver +
    // fonts.ready hook on every one of those renders for zero layout change.
  }, [value, maxHeight, Boolean(footer)])

  // THE TOKEN BACKDROP: a metrics-identical mirror of the prose, absolutely positioned behind the
  // (transparent-backgrounded) textarea. Because the mirror carries the same font, padding, line
  // height and wrapping as the textarea, anything painted on a run lands exactly under that run
  // wherever it sits — any line, any wrap — which is the whole trick: the decoration is paint, the
  // token is text, and the textarea keeps owning editing, caret and selection. Decorations are
  // strictly zero-layout (colour, background, box-shadow ring, and `-mx`/`px` pairs that cancel — never
  // a weight or a size) so the mirror's advance widths can never drift from the textarea's.
  //
  // Two kinds of run get painted. A staged ⌘I context token gets a pill behind it. A `@handle` that
  // NAMES a thread (the same resolver the transcript links with, lib/threadMentions.ts scanMentions)
  // is TINTED, so a finished mention reads as one once typed rather than as prose — a half-typed or
  // unknown `@` stays plain, which is the signal it resolved. A textarea cannot colour part of its
  // own text, so while a mention is on screen the MIRROR draws every glyph and the textarea's go
  // transparent (its caret keeps the fg colour); with only pills, the textarea draws the text as ever.
  const stagedTokens = useMemo(() => contextTokens ?? [], [contextTokens])
  // The thread's skills and commands, as its harness reports them: fetched once, the first time the draft
  // holds a `/` token anywhere (null = not asked yet; [] = asked, nothing to offer — including a fetch
  // that failed, which must read as "no suggestions", never as an error the operator has to dismiss).
  // Read by the menu AND the tint, so a draft restored with `/ntwine-stack` in it lights up too.
  const [skillItems, setSkillItems] = useState<ThreadSkill[] | null>(null)
  const [skillsVersion, setSkillsVersion] = useState(slashSuggestVersion)
  if (skillsVersion !== slashSuggestVersion) {
    setSkillsVersion(slashSuggestVersion)
    setSkillItems(null)
  }
  const slashItems = useMemo(() => skillItems ?? [], [skillItems])
  const opensAt = draftStart(prose)
  // The textarea's collapsed selection (null while blurred or while a range is selected), refreshed on
  // every edit and caret move. Both typeaheads follow it: a `/` or an `@` can sit anywhere in the prose.
  const [caret, setCaret] = useState<number | null>(null)
  const trackCaret = (el: HTMLTextAreaElement) => setCaret(el.selectionStart === el.selectionEnd ? el.selectionStart : null)
  const allMentions = useMemo(
    () => (ownMention ? [...(mentionCandidates ?? []), ownMention] : mentionCandidates ?? []),
    [mentionCandidates, ownMention],
  )
  // `#slug` PROJECT MENTIONS ride the same boxes as `@` ones — every prompt box that offers threads —
  // and resolve against the machine's projects, whichever project the box writes into.
  const allProjects = useProjectMentions()
  const projectMentions = mentionCandidates !== undefined ? allProjects : NO_PROJECTS
  const backdrop = useMemo(() => {
    let hasMention = false
    let hasToken = false
    const out: React.ReactNode[] = []
    // Fenced code is a third kind of painted run (lib/inputCodeFences.ts): its body highlighted, its
    // delimiters muted, and no mention tinting inside it. Fences are found on the WHOLE prose — a
    // block spans lines a token split knows nothing about — then clipped to each run below.
    const fences = scanInputFences(prose)
    let offset = 0
    for (const run of splitProseByTokens(prose, stagedTokens)) {
      const runStart = offset
      offset += run.text.length
      if (run.token) {
        hasToken = true
        // The vertical pad is free (vertical padding on an inline box never moves layout); the
        // horizontal pad is bought back by the negative margin so the advance width is untouched.
        out.push(
          <span key={out.length} data-context-token={run.token} className={CONTEXT_PILL}>
            {run.text}
          </span>,
        )
        continue
      }
      const pieces = fences
        ? clipFenceRuns(fences, runStart, offset)
        : [{ kind: "prose" as const, start: runStart, end: offset }]
      for (const piece of pieces) {
        if (piece.kind !== "prose") {
          out.push(renderInputFenceRun(prose, piece, out.length))
          continue
        }
        let segAt = piece.start
        for (const seg of mentionSegments(prose.slice(piece.start, piece.end), allMentions)) {
          const segStart = segAt
          segAt += seg.text.length
          if (seg.kind === "text") {
            // A `#slug` naming a project is tinted exactly as a thread mention is: both name a place
            // on the board, where a skill (below) is something the thread runs.
            let projectAt = 0
            const pushCommands = (text: string, at: number) => {
              // A `/name` the thread can run takes the same treatment as a mention in its OWN colour
              // (lib/slashCommands.ts), so a skill never reads as a thread.
              for (const run of slashSegments(text, slashItems, at, opensAt)) {
                if (run.kind === "text") {
                  out.push(run.text)
                  continue
                }
                hasMention = true
                out.push(
                  <span key={out.length} data-composer-command className="rounded-[3px] bg-command/12 py-px -mx-px px-px text-command">
                    {run.text}
                  </span>,
                )
              }
            }
            for (const hit of scanProjectMentions(seg.text, projectMentions)) {
              if (hit.start > projectAt) pushCommands(seg.text.slice(projectAt, hit.start), segStart + projectAt)
              hasMention = true
              out.push(
                <span key={out.length} data-composer-project-mention className="rounded-[3px] bg-accent/10 py-px -mx-px px-px text-accent">
                  {hit.text}
                </span>,
              )
              projectAt = hit.start + hit.text.length
            }
            if (projectAt < seg.text.length) pushCommands(seg.text.slice(projectAt), segStart + projectAt)
            continue
          }
          hasMention = true
          out.push(
            <span key={out.length} data-composer-mention className="rounded-[3px] bg-accent/10 py-px -mx-px px-px text-accent">
              {seg.text}
            </span>,
          )
        }
      }
    }
    const paintsText = hasMention || fences !== null
    return paintsText || hasToken ? { segments: out, paintsText } : null
  }, [prose, stagedTokens, allMentions, projectMentions, slashItems, opensAt])
  const backdropSegments = backdrop?.segments
  // The schedule phrase, marked behind its own words (the `marks` prop) — only the marks that still fit the
  // prose: a mark over the wrong words is worse than none.
  const markRuns = useMemo(() => fittedMarks(marks, prose.length), [marks, prose.length])
  const mirrored = backdropSegments !== undefined || markRuns.length > 0

  // The mirror rides the textarea's own scroll position (a textarea at maxHeight scrolls its
  // content; the backdrop must pan with it or the pills detach from their tokens).
  const syncContextScroll = () => {
    const el = taRef.current
    const backdrop = contextRef.current
    if (el && backdrop) backdrop.scrollTop = el.scrollTop
    const marks = highlightRef.current
    if (el && marks) marks.scrollTop = el.scrollTop
  }
  useLayoutEffect(syncContextScroll)

  // A PILL'S HOVER. The textarea is on top and owns every pointer event, so the pill under the pointer
  // is found by geometry: each pill's line boxes in the mirror (a token that wraps has two), against the
  // pointer. Its source becomes the box's own tooltip — the textarea's `title` — and goes when the
  // pointer leaves the pill, so the rest of the box says nothing.
  const [hoverSource, setHoverSource] = useState<string | undefined>(undefined)
  const sourceAt = (x: number, y: number): string | undefined => {
    if (!contextSources) return undefined
    for (const pill of contextRef.current?.querySelectorAll<HTMLElement>("[data-context-token]") ?? []) {
      for (const rect of pill.getClientRects()) {
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return contextSources[pill.dataset.contextToken!]
      }
    }
    return undefined
  }

  // The browser BLURS a focused element the instant it becomes `disabled`, so every `busy` window
  // evicts the caret and the user must re-click the box to keep typing. A focusout whose target is
  // ALREADY disabled is exactly that eviction and nothing else (a user-initiated blur always fires
  // while the element is still enabled), so it is the precise signal for taking focus back once the
  // box unlocks — and it is why a surface that deliberately blurs on send (the queue card dissolving
  // itself) is honored rather than fought: that blur lands while still enabled and never arms this.
  // The listener must be NATIVE: React does not dispatch synthetic events for disabled form controls,
  // so `onBlur` never sees this one (verified in a real browser — the synthetic handler stays silent
  // while the native focusout fires with disabled=true). Note `busy` is not only the send round-trip:
  // it also tracks board-derived control state, so this can fire on a lock the user never initiated.
  const evictedRef = useRef(false)
  useEffect(() => {
    const el = taRef.current
    if (!el) return
    const onFocusOut = () => { evictedRef.current = el.disabled }
    el.addEventListener("focusout", onFocusOut)
    return () => el.removeEventListener("focusout", onFocusOut)
  }, [])
  useEffect(() => {
    if (busy || !evictedRef.current) return
    evictedRef.current = false
    // Restore only INTO THE VACUUM the eviction left — never steal focus back from somewhere the user
    // deliberately moved while the box was locked. The vacuum is <body> when the composer sits on the
    // page, but inside a modal drawer Radix's focus scope catches the eviction on the dialog container
    // instead; both are ANCESTORS of the box, which is exactly what a deliberate destination is not.
    const el = taRef.current
    const active = document.activeElement
    // preventScroll: this restore can land seconds after the send (a dispatch waits out session
    // startup), by which time the user may have scrolled far away — taking focus back must not yank
    // the page with it.
    if (el && (!active || active.contains(el))) el.focus({ preventScroll: true })
  }, [busy])

  // SKILLS TYPEAHEAD state (`skillItems`, `caret` and the tint inputs live above the backdrop, which
  // reads them). `dismissedFor` records the exact draft an Escape closed the menu over, so it stays
  // closed until the draft CHANGES — without it the menu would reopen on the very next render.
  // The highlighted row, REMEMBERED WITH THE DRAFT IT WAS CHOSEN OVER: the filtered list under it
  // changes with every keystroke, so a highlight belongs to one draft and reads as row 0 for any
  // other. Derived, not reset by an effect — `useEffect(() => setSuggestSel(0), [prose])` looked free
  // (same value, no re-render) but it was not: once the fiber carries any pending lane React skips
  // the same-value bailout, so every keystroke's effect enqueued a DefaultLane update that a fast
  // burst of keystrokes starved; the root then ended every sync commit with that lane still pending,
  // React's nested-update counter climbed one per keystroke, and a 50-keystroke burst (a multi-line
  // draft on /full, 2026-08-28) threw "Maximum update depth exceeded" twice per run.
  const [suggestSelFor, setSuggestSelFor] = useState<{ prose: string; index: number }>({ prose: "", index: 0 })
  const suggestSel = suggestSelFor.prose === prose ? suggestSelFor.index : 0
  const setSuggestSel = (next: number | ((current: number) => number)) =>
    setSuggestSelFor({ prose, index: typeof next === "function" ? next(suggestSel) : next })
  const [dismissedFor, setDismissedFor] = useState<string | null>(null)
  // The `/` token the caret is in, at any word boundary — the mention menu's own rule (lib/slashCommands.ts).
  // A space (arguments have begun) or the caret leaving the token closes it.
  const slash = slashSuggest ? slashQueryAt(prose, caret) : undefined
  const slashActive = slash !== undefined
  const wantsSkills = Boolean(slashSuggest) && /(?:^|\s)\/[^\s/@]/.test(prose)
  useEffect(() => {
    if (!(slashActive || wantsSkills) || skillItems !== null) return
    let live = true
    // Errors resolve to "asked, nothing to offer": the caller decides whether to retry on a later
    // trigger by handing this component a fresh mount (drawer reopen) — a typeahead never toasts.
    void slashSuggest!().then(
      (items) => { if (live) setSkillItems(items) },
      () => { if (live) setSkillItems([]) },
    )
    return () => { live = false }
  }, [slashActive, wantsSkills, skillItems, slashSuggest])
  const suggestions = useMemo(() => {
    if (!slash || !skillItems || dismissedFor === prose) return []
    return matchSlashItems(skillItems, slash.query, slash.start === opensAt)
  }, [slash?.start, slash?.query, opensAt, skillItems, dismissedFor, prose])
  const suggestOpen = suggestions.length > 0
  // The DISTINCT source labels in the list on screen, which every row then reserves room for (see the
  // sizer in the menu below). Empty when no visible suggestion reports a source — a harness that says
  // nothing must not cost the descriptions a column of width.
  const suggestSourceLabels = useMemo(() => {
    const labels = new Set<string>()
    for (const s of suggestions) if (s.source) labels.add(SKILL_SOURCE_LABEL[s.source])
    return [...labels]
  }, [suggestions])
  // Keep the highlighted row in view when arrowing through a list taller than the menu.
  const suggestListRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    suggestListRef.current?.querySelector(`[data-suggest-index="${suggestSel}"]`)?.scrollIntoView({ block: "nearest" })
  }, [suggestSel])
  // MENTION TYPEAHEAD state. It follows the CARET like the skills menu, and is disjoint from it by
  // construction: a `/` token never contains an `@`, and an open skills menu wins.
  const mentionable = (mentionCandidates?.length ?? 0) > 0 || ownMention !== undefined
  // The phone layouts draw no mention menu, so one must never open there: it would claim Enter unseen.
  const mention = mentionable && !suggestOpen && !phone ? mentionQueryAt(prose, caret) : undefined
  // AFTER THE DOT the menu is the named thread's SUB-AGENTS (`@port-the-parser.ca`): the head resolves to
  // one of the candidates by the same fold a plain mention does, and its children arrive from the
  // server's directory through SubAgentMentionSource below — mounted only while such a query is open, so
  // a box nobody types a dot into never asks, and a surface with no query client never needs one.
  const dotted = mention ? splitMentionQuery(mention.query) : undefined
  const mentionThread = dotted ? resolveMention(allMentions, dotted.head) : undefined
  const [subMentions, setSubMentions] = useState<{ slug: string; candidates: MentionCandidate[] } | null>(null)
  const mentionMatches = useMemo(() => {
    if (!mention || dismissedFor === prose) return []
    if (!dotted) return matchMentions(allMentions, mention.query)
    return mentionThread && subMentions?.slug === mentionThread.slug ? matchMentions(subMentions.candidates, dotted.rest) : []
  }, [mention?.start, mention?.query, allMentions, dismissedFor, prose, mentionThread?.slug, subMentions])
  // FILES IN THE SAME MENU (`fileMentions`): the editor's answer for the query at the caret, asked a beat
  // after the last keystroke and kept against the `@` it was asked for, so a new `@` elsewhere never
  // shows the last one's files. Threads come first — `@` has always meant a thread here — but only a few
  // of them while files are offered too, so the files are not scrolled out of sight.
  const fileQuery = fileMentions && !suggestOpen ? fileQueryAt(prose, caret) : undefined
  const [filePicks, setFilePicks] = useState<{ start: number; query: string; files: EmbedPickedFile[] } | null>(null)
  useEffect(() => {
    if (!fileMentions || !fileQuery) return
    let live = true
    const { start, query } = fileQuery
    const timer = setTimeout(() => {
      void fileMentions.search(query).then((files) => {
        if (live) setFilePicks({ start, query, files: files ?? [] })
      })
    }, FILE_QUERY_DEBOUNCE_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [fileMentions, fileQuery?.start, fileQuery?.query])
  const fileMatches = fileQuery && filePicks?.start === fileQuery.start && dismissedFor !== prose ? filePicks.files.slice(0, FILE_ROWS) : []
  // `#` — THE PROJECTS MENU, in the same box. Disjoint from the `@` menu by construction: each opens on
  // its own trigger character at the caret.
  const projectQuery = projectMentions.length > 0 && !suggestOpen && !phone ? projectQueryAt(prose, caret) : undefined
  const projectMatches = useMemo(
    () => (projectQuery && dismissedFor !== prose ? matchProjects(projectMentions, projectQuery.query) : []),
    [projectQuery?.start, projectQuery?.query, projectMentions, dismissedFor, prose],
  )
  const mentionRows: MentionRow[] = projectMatches.length
    ? projectMatches.map((project) => ({ kind: "project" as const, project }))
    : [
        ...(fileMatches.length ? mentionMatches.slice(0, THREADS_BESIDE_FILES) : mentionMatches).map((thread) => ({ kind: "thread" as const, thread })),
        ...fileMatches.map((file) => ({ kind: "file" as const, file })),
      ]
  const mentionOpen = mentionRows.length > 0
  // WHICH WAY THE MENUS OPEN. Up by default — a prompt box usually sits at the bottom of its surface —
  // but All projects puts its box at the TOP of the page, where a menu floated above opened off-screen
  // and hid most of its rows. So a menu opens below whenever the room above the box is less than the
  // menu's full height (`max-h-56`, 224px, plus its 6px margin).
  const [menuBelow, setMenuBelow] = useState(false)
  const menuOpen = suggestOpen || mentionOpen
  useLayoutEffect(() => {
    const box = suggestListRef.current?.parentElement
    if (menuOpen && box) setMenuBelow(box.getBoundingClientRect().top < 230)
  }, [menuOpen])
  function acceptMention(item: MentionCandidate) {
    if (!mention || caret === null) return
    const next = insertMention(prose, mention.start, caret, item.handle)
    setProse(next.prose)
    setCaret(next.caret)
    requestAnimationFrame(() => taRef.current?.setSelectionRange(next.caret, next.caret))
  }
  function acceptProject(project: ProjectMentionCandidate) {
    if (!projectQuery || caret === null) return
    if (onLeadingProject && !prose.slice(0, projectQuery.start).trim()) {
      let end = caret
      while (end < prose.length && /[\p{L}\p{N}_-]/u.test(prose[end]!)) end++
      if (onLeadingProject(project.slug, joinComposerValue(prose.slice(end).replace(/^[ \t]+/u, ""), attachmentPaths))) return
    }
    const next = insertProjectMention(prose, projectQuery.start, caret, project.slug)
    setProse(next.prose)
    setCaret(next.caret)
    requestAnimationFrame(() => taRef.current?.setSelectionRange(next.caret, next.caret))
  }
  function acceptFile(file: EmbedPickedFile) {
    if (!fileQuery || !fileMentions || caret === null) return
    const next = insertFileReference(prose, fileQuery.start, caret, fileMentions.reference(file))
    setProse(next.prose)
    setCaret(next.caret)
    requestAnimationFrame(() => taRef.current?.setSelectionRange(next.caret, next.caret))
  }
  // The open menu's length and accept, whichever of the two menus it is — one keyboard contract for both.
  const menuLength = suggestOpen ? suggestions.length : mentionRows.length
  const acceptHighlighted = () => {
    if (suggestOpen) {
      acceptSuggestion(suggestions[suggestSel] ?? suggestions[0]!)
      return
    }
    const row = mentionRows[suggestSel] ?? mentionRows[0]!
    if (row.kind === "thread") acceptMention(row.thread)
    else if (row.kind === "project") acceptProject(row.project)
    else acceptFile(row.file)
  }
  function acceptSuggestion(item: { name: string }) {
    if (!slash || caret === null) return
    const next = insertSlashCommand(prose, slash.start, caret, item.name)
    setProse(next.prose)
    setCaret(next.caret)
    requestAnimationFrame(() => taRef.current?.setSelectionRange(next.caret, next.caret))
  }

  const submit = () => onSubmit()

  const hasContent = value.trim().length > 0
  const interruptChord = useMemo(() => (detectPlatform() === "mac" ? "⌘⏎" : "Ctrl+Enter"), [])
  // Something to send: words in the box, or — on a thread composer — an answer staged on a card.
  const armed = hasContent || (send?.staged ?? 0) > 0
  // Where each rail mark sits, and the padding every text row keeps clear of the absolutely-placed rail.
  // The Goal (`railLead`, the thread composer only) sits beyond the paperclip. Interrupt-and-send has no
  // button on the rail, only ⌘/Ctrl-Enter — see the `onInterruptSubmit` prop doc.
  const rail = composerRail({ perm: Boolean(railPermission), lead: Boolean(railLead), sendWidth: send && !phone ? SEND_SPLIT_WIDTH : undefined })

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    const el = e.currentTarget
    const keyboardEvent = {
      key: e.key,
      altKey: e.altKey,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      shiftKey: e.shiftKey,
      isComposing: e.nativeEvent.isComposing,
      keyCode: e.keyCode,
    }
    // An open menu (skills or mentions) claims its keys FIRST — above all Enter (accept, not send) and
    // Escape (close the menu, not blur; the blur branch below must not see this keypress). Modified
    // Enter deliberately falls through: ⌘-Enter mid-name is the operator overriding the menu, not using it.
    if ((suggestOpen || mentionOpen) && !e.nativeEvent.isComposing) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault()
        setSuggestSel((current) => {
          const delta = e.key === "ArrowDown" ? 1 : -1
          return (current + delta + menuLength) % menuLength
        })
        return
      }
      if ((e.key === "Enter" || e.key === "Tab") && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        e.preventDefault()
        e.stopPropagation()
        acceptHighlighted()
        return
      }
      if (e.key === "Escape") {
        e.preventDefault()
        e.stopPropagation()
        setDismissedFor(prose)
        return
      }
    }
    // A staged `@` token deletes as ONE token — the editor convention for a reference the user placed
    // as a unit. Only a bare Backspace with a collapsed caret sitting immediately after a STAGED
    // token (a hand-typed `@thing` is ordinary text); a selection, a modifier, or any other position
    // keeps native editing. The staged item itself is dropped by the caller's token-presence sweep
    // once the token is gone (ThreadComposerBox). The run split is the same one the backdrop uses,
    // so the token that deletes is exactly the one wearing a pill.
    if (e.key === "Backspace" && !e.altKey && !e.ctrlKey && !e.metaKey && stagedTokens.length > 0 && el.selectionStart === el.selectionEnd) {
      const caret = el.selectionStart
      const last = splitProseByTokens(el.value.slice(0, caret), stagedTokens).at(-1)
      if (last?.token) {
        e.preventDefault()
        const start = caret - last.text.length
        setProse(el.value.slice(0, start) + el.value.slice(caret))
        requestAnimationFrame(() => el.setSelectionRange(start, start))
        return
      }
    }
    const effortStep = onEffortStep ? effortStepOf(e.nativeEvent) : 0
    if (effortStep) {
      e.preventDefault()
      onEffortStep!(effortStep)
      return
    }
    if (queueComposerHandlesOptionEnter(surface, e.key, e.altKey)) {
      // Option-Enter inserts a newline EXPLICITLY (Claude Code muscle memory). Merely exempting it
      // from submit is not enough: on macOS Chrome, Option-Enter in a textarea inserts nothing
      // natively, so we splice the newline at the caret ourselves and restore the caret after the
      // controlled re-render.
      e.preventDefault()
      e.stopPropagation()
      const start = el.selectionStart ?? el.value.length
      const end = el.selectionEnd ?? start
      setProse(el.value.slice(0, start) + "\n" + el.value.slice(end))
      requestAnimationFrame(() => el.setSelectionRange(start + 1, start + 1))
      return
    }
    // `!uploading` closes a confirmed data-loss race: a send while /attach is in flight used to ship
    // the prose WITHOUT the pending attachment, whose path then landed in the cleared composer and
    // silently rode along with the next unrelated message. Typing stays enabled during upload (the
    // commit re-derives from valueRef); only SENDING waits for the attachment to land.
    const canSend = armed && !busy && !uploading
    if (shouldSubmitComposerEnter(keyboardEvent, canSend)) {
      // A plain Enter is the ordinary send. Shift/Option-Enter and IME confirmations retain the
      // native textarea behavior, so they cannot accidentally submit or lose their newline.
      e.preventDefault()
      e.stopPropagation()
      submit()
      return
    }
    // ⌘/Ctrl-Enter — the FORCED send. With a worker mid-turn it preempts what the worker is doing so
    // the message is read now instead of when the current command finishes; with nothing to
    // interrupt it is the same send as Enter, so the chord always means "send now". Disjoint by
    // construction from the plain-Enter send above and the Option-Enter newline repair below.
    if (shouldInterruptSubmitComposerEnter(keyboardEvent, canSend)) {
      e.preventDefault()
      e.stopPropagation()
      ;(onInterruptSubmit ?? onSubmit)()
      return
    }
    // ⌘/Ctrl-Enter on an EMPTY box: nothing to send, so push the already-queued follow-up through (the
    // queued bubble's ↑). Attachments count as content — a box holding only a chip is not empty.
    if (onPushQueued && !busy && shouldPushQueuedComposerEnter(keyboardEvent, value.trim().length === 0) && onPushQueued()) {
      e.preventDefault()
      e.stopPropagation()
      return
    }
    if (shouldRestoreOptionEnterNewline(keyboardEvent)) {
      // Do NOT prevent the modifier path: first allow the browser to insert its native newline.
      // Chromium/macOS sometimes leaves the DOM unchanged, so repair only that no-op on the next
      // frame; browsers that did insert keep their value and never take this branch.
      const before = el.value
      const start = el.selectionStart ?? before.length
      const end = el.selectionEnd ?? start
      requestAnimationFrame(() => {
        if (el.value !== before) return
        setProse(before.slice(0, start) + "\n" + before.slice(end))
        requestAnimationFrame(() => el.setSelectionRange(start + 1, start + 1))
      })
    }
    if (e.key === "Escape" && !e.nativeEvent.isComposing) {
      if (onEscape?.()) {
        e.preventDefault()
        e.stopPropagation()
        return
      }
      // Climb out: blur the textarea and STOP the event — the same physical keypress must not also
      // reach App's window handler and pop a drawer. The NEXT Esc, at rest, unwinds normally.
      // Mid-IME-composition Esc is the IME's own cancel — leave it to the editor, don't blur.
      e.preventDefault()
      e.stopPropagation()
      // With a question open on this composer's own surface (its drawer, its queue card), the climb out
      // lands ON the question, so the next key is a number that answers it (lib/questionKeys.ts).
      if (!focusQuestionFrom(el)) el.blur()
    }
    // Arrow keys just move the caret — no boundary semantics (the nav walk they used to drive is gone).
  }

  // The skills menu, floated ABOVE the box (the composer lives at the bottom of its surface, so up is
  // the direction with room). Rows are text-only — a name and its one-line description — which keeps
  // this out of icon-ink territory entirely. Mousedown is prevented on every row for the same reason as
  // the send button: choosing a suggestion must never blur the textarea. Shared by every layout.
  const suggestMenu = suggestOpen ? (
        <div
          ref={suggestListRef}
          data-slash-menu
          className={`absolute ${menuBelow ? "top-full mt-1.5" : "bottom-full mb-1.5"} left-0 right-0 z-20 max-h-56 overflow-y-auto rounded-lg border border-border bg-bg py-1 shadow-lg`}
        >
          {suggestions.map((s, i) => (
            <button
              key={s.name}
              type="button"
              data-suggest-index={i}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => acceptSuggestion(s)}
              onMouseEnter={() => setSuggestSel(i)}
              // pl-3.5 matches the textarea's own text inset, so the completed `/name` lands exactly
              // under the row that offered it. The RIGHT inset is 6px, not 14: the list keeps an 8px
              // scrollbar gutter reserved even when nothing scrolls (styles.css `scrollbar-gutter:
              // stable`), so pr-3.5 put the tag column 22px off the box's right edge against 15px of
              // ink on the left. With MENU_ROW_INSET the text boxes sit 15px from the left edge and
              // 14px from the right (mention menu, sans, 2026-09-29).
              className={`flex w-full items-baseline gap-2 ${MENU_ROW_INSET} py-1.5 text-left ${i === suggestSel ? "bg-panel-2" : ""}`}
            >
              <span className="shrink-0 text-[12px] font-medium text-fg">/{s.name}</span>
              {s.description && <span className="min-w-0 truncate text-[11px] text-muted">{s.description}</span>}
              {/* The source column. One WIDTH for every row, including the rows with no source to
                  show — otherwise an unlabelled row's description truncates 50px further right than
                  its neighbours' and the list reads ragged. The width is reserved by stacking every
                  label in the list invisibly under the real one, so the BROWSER measures it: a
                  hand-fitted px constant would be right in one of this app's two fonts and wrong in
                  the other (AGENTS.md). Measured ink gap from the truncated description ahead of it:
                  13.16px against 8.87px between a name and its own description — the tag reads as a
                  separate column, which is what it is. */}
              {suggestSourceLabels.length > 0 && (
                <span className="ml-auto grid shrink-0 text-[10px]">
                  {suggestSourceLabels.map((label) => (
                    <span key={label} aria-hidden className="petite-caps invisible col-start-1 row-start-1">{label}</span>
                  ))}
                  <span className="petite-caps col-start-1 row-start-1 text-right text-muted-70">
                    {s.source ? SKILL_SOURCE_LABEL[s.source] : ""}
                  </span>
                </span>
              )}
            </button>
          ))}
        </div>
  ) : null

  // ── The phone layouts ────────────────────────────────────────────────────────────────────────────
  // Hooks first and unconditionally, so a window that crosses the breakpoint keeps its hook order.
  const [focused, setFocused] = useState(false)
  const [held, setHeld] = useState(false)
  const phoneRootRef = useRef<HTMLDivElement>(null)
  const keyboardInset = useKeyboardInset(phoneRootRef, Boolean(phone))
  const pressTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const longPressedRef = useRef(false)
  useEffect(() => () => clearTimeout(pressTimerRef.current), [])
  const onUploadingChangeRef = useRef(onUploadingChange)
  onUploadingChangeRef.current = onUploadingChange
  useEffect(() => { onUploadingChangeRef.current?.(uploading) }, [uploading])

  if (phone) {
    const canSend = hasContent && !busy && !uploading
    // The textarea's type is 16px on a phone, not the mockup's 15.5: iOS Safari zooms the whole page
    // into any focused field set below 16px, and the desktop's 13px would do exactly that.
    const page = phone.layout === "page"
    // THE BAR opens (a box with a toolbar) while the field has focus or anything in it, and is a single
    // row otherwise. The textarea is the SAME element in both — every child before it keeps its slot (a
    // `false` holds one) — so opening the box never remounts it and never costs the caret.
    const expanded = !page && (focused || held || hasContent || attachments.length > 0)
    // Resting, the field is a 42px pill: 40px of textarea inside its 1px border, one 20px line.
    const typeClass = page
      ? "px-[18px] py-[14px] text-[17px] leading-[25px]"
      : expanded
        ? "px-3 pt-[10px] pb-1 text-[16px] leading-[22px]"
        : "px-[14px] py-[10px] text-[16px] leading-[20px]"
    const textareaBox = page ? { minHeight, maxHeight } : expanded ? { minHeight: 44, maxHeight: 176 } : { minHeight: 40, maxHeight: 40 }
    const fileInput = (
      <input
        ref={fileRef}
        type="file"
        multiple
        accept={ATTACHMENT_ACCEPT}
        className="hidden"
        onChange={(e) => {
          void takeFiles(e.target.files)
          e.target.value = "" // reset so re-picking the same file fires change again
        }}
      />
    )
    // The + is the paperclip's own path: the same hidden file input, the same intake.
    const attachButton = (size: 36 | 42) => (
      <button
        type="button"
        data-phone-attach
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => fileRef.current?.click()}
        disabled={busy || uploading}
        title="Attach files"
        aria-label="Attach files"
        className={`relative flex shrink-0 items-center justify-center rounded-full border border-border-strong bg-panel text-fg active:bg-hover disabled:opacity-45 ${
          size === 42 ? "size-[42px]" : "size-[36px] after:absolute after:-inset-[4px] after:content-['']"
        }`}
      >
        {uploading ? <Loader2 size={17} strokeWidth={2.2} className="animate-spin" /> : <Plus size={size === 42 ? 19 : 17} strokeWidth={2.2} />}
      </button>
    )
    const textarea = (
      <div className={page ? "relative flex flex-1 flex-col" : "relative"}>
        {backdropSegments && (
          <div
            ref={contextRef}
            aria-hidden
            data-composer-context-backdrop
            className={`pointer-events-none absolute inset-0 select-none overflow-hidden whitespace-pre-wrap [overflow-wrap:break-word] ${typeClass} text-transparent`}
          >
            {backdropSegments}
          </div>
        )}
        <textarea
          id={id}
          ref={taRef}
          data-1p-ignore
          onScroll={backdropSegments ? syncContextScroll : undefined}
          data-surface={surface}
          data-claims-escape
          value={prose}
          autoFocus={autoFocus}
          disabled={busy}
          onChange={(e) => {
            setProse(e.target.value)
            trackCaret(e.target)
          }}
          onSelect={slashSuggest ? (e) => trackCaret(e.currentTarget) : undefined}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false)
            setCaret(null)
          }}
          onPaste={(e) => {
            const files = [...e.clipboardData.items].filter((i) => i.kind === "file").map((i) => i.getAsFile()!).filter(Boolean)
            if (files.length) {
              e.preventDefault()
              void takeFiles(files)
            }
          }}
          placeholder={placeholder}
          rows={1}
          spellCheck={false}
          style={textareaBox}
          // `flex-1` on the page: the textarea's snapped height is its basis, and it grows to fill the
          // page, so a tap anywhere on the blank page below the prompt lands in it.
          className={`relative block w-full resize-none bg-transparent ${typeClass} text-fg outline-none placeholder:text-faint scrollbar-none disabled:opacity-60 ${page ? "flex-1" : ""}`}
        />
      </div>
    )
    const attachmentRow = attachments.length > 0 && (
      <div className={`flex flex-wrap gap-1.5 ${page ? "px-[18px] pb-3" : "px-3 pb-1"}`}>
        {attachments.map((a, i) => (
          <AttachmentChip
            key={`${a.path}-${i}`}
            attachment={a}
            disabled={busy}
            onRemove={() => setPaths(attachmentPaths.filter((_, j) => j !== i))}
          />
        ))}
      </div>
    )
    // Under the bar: the strip the keyboard covers (0 without one), else the device's home-indicator
    // inset. Inside this root, so the panel above shrinks rather than the bar floating over it.
    const keyboardSpacer = keyboardInset > 0 ? <div aria-hidden data-keyboard-spacer style={{ height: keyboardInset }} /> : null

    if (page) {
      return (
        <div ref={phoneRootRef} data-phone-composer="page" className={`flex min-h-0 flex-1 flex-col ${keyboardInset > 0 ? "" : "pb-[env(safe-area-inset-bottom)]"}`}>
          <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto scrollbar-none">
            {suggestMenu}
            {textarea}
            {attachmentRow}
          </div>
          <div data-phone-tool-row className="flex min-w-0 shrink-0 items-center gap-2 px-2.5 py-2">
            {attachButton(36)}
            {phone.tools}
          </div>
          {fileInput}
          {keyboardSpacer}
        </div>
      )
    }

    const override = !expanded && phone.override ? phone.override({ editReply: () => taRef.current?.focus() }) : null
    const sendButton = (compact: boolean) => (
      <button
        type="button"
        data-phone-send
        // Keep the caret: pressing Send must not blur the field (the desktop send's own rule).
        onMouseDown={(e) => e.preventDefault()}
        onContextMenu={(e) => e.preventDefault()}
        onPointerDown={() => {
          longPressedRef.current = false
          clearTimeout(pressTimerRef.current)
          if (!canSend || !phone.onLongPressSend) return
          const fire = phone.onLongPressSend
          pressTimerRef.current = setTimeout(() => {
            longPressedRef.current = true
            navigator.vibrate?.(12)
            fire()
          }, LONG_PRESS_MS)
        }}
        onPointerUp={() => clearTimeout(pressTimerRef.current)}
        onPointerLeave={() => clearTimeout(pressTimerRef.current)}
        onPointerCancel={() => clearTimeout(pressTimerRef.current)}
        onClick={() => {
          // The long press already sent; the click that ends it must not send again.
          if (longPressedRef.current) {
            longPressedRef.current = false
            return
          }
          onSubmit()
        }}
        disabled={!canSend}
        title={phone.onLongPressSend ? "Send · hold to interrupt and send now" : "Send"}
        aria-label="Send"
        // The ↑ is solid whenever it is the verb; with nothing to send it is the same disc, dimmed.
        // `[-webkit-touch-callout:none]` + `select-none`: a long press must not raise iOS's callout.
        className={`relative flex shrink-0 select-none items-center justify-center rounded-full bg-fg text-bg [-webkit-touch-callout:none] disabled:opacity-35 ${
          compact ? "size-[36px] after:absolute after:-inset-[4px] after:content-['']" : "size-[42px]"
        }`}
      >
        {busy ? <Loader2 size={compact ? 17 : 19} strokeWidth={2.4} className="animate-spin" /> : <ArrowUp size={compact ? 17 : 19} strokeWidth={2.4} />}
      </button>
    )
    const primary = (compact: boolean) => (hasContent ? sendButton(compact) : (phone.idlePrimary?.(compact) ?? sendButton(compact)))

    return (
      <div ref={phoneRootRef} data-phone-composer="bar" data-phone-composer-open={expanded ? "" : undefined} className="relative bg-bg">
        <div className={`px-2.5 pt-2 ${keyboardInset > 0 ? "pb-2.5" : "pb-[max(10px,env(safe-area-inset-bottom))]"}`}>
          {override && <div data-phone-bar-override className="flex min-w-0 items-end gap-2">{override}</div>}
          <div
            // Hidden, not unmounted, under an override: `editReply` focuses this textarea inside the
            // tap that asked for it, which is what makes iOS raise the keyboard at all.
            className={override ? "pointer-events-none absolute h-0 w-0 overflow-hidden opacity-0" : "flex min-w-0 items-end gap-2"}
          >
            {!expanded && attachButton(42)}
            <div
              className={`relative min-w-0 flex-1 border border-border-strong bg-panel ${
                expanded ? "rounded-[20px] pb-2" : "rounded-[21px]"
              }`}
            >
              {suggestMenu}
              {textarea}
              {expanded && attachmentRow}
              {expanded && (
                <div data-phone-composer-toolbar className="flex min-w-0 items-center gap-2 px-2 pt-1">
                  {attachButton(36)}
                  <PhoneBarHoldContext.Provider value={setHeld}>{phone.tools}</PhoneBarHoldContext.Provider>
                  <span className="flex-1" />
                  {primary(true)}
                </div>
              )}
            </div>
            {!expanded && primary(false)}
          </div>
          {fileInput}
        </div>
        {keyboardSpacer}
      </div>
    )
  }

  return (
    // Focused = the accent border: the visual handoff from the nav chevron to the box.
    // While a file drags over, the border dashes and a hint overlay appears (screenshot intake).
    // `data-composer-box` is the bordered box itself: the Goal panel spans exactly its two edges.
    <div
      data-composer-box
      className={`group relative rounded-xl border bg-bg transition-colors focus-within:border-accent ${
        dragging ? "border-dashed border-accent" : "border-border"
      }`}
      onDragOver={(e) => {
        // A drag from VS Code's explorer first: it may carry a text fallback too, which the textarea
        // would otherwise take as typed text. Not the surface's either, so it stops here.
        if (fileMentions && isVscodeDrag([...e.dataTransfer.types])) {
          e.preventDefault()
          e.stopPropagation()
          e.dataTransfer.dropEffect = "copy"
          setReferenceDrag(true)
          return
        }
        if (!fileDrop) ownDrop.handlers.onDragOver(e)
      }}
      onDragLeave={(e) => {
        if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) setReferenceDrag(false)
        if (!fileDrop) ownDrop.handlers.onDragLeave(e)
      }}
      onDrop={(e) => {
        if (fileMentions && isVscodeDrag([...e.dataTransfer.types])) {
          e.preventDefault()
          e.stopPropagation()
          setReferenceDrag(false)
          void takeDropped(droppedUris(DROPPED_URI_TYPES.map((type) => e.dataTransfer.getData(type))))
          return
        }
        if (!fileDrop) ownDrop.handlers.onDrop(e)
      }}
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-bg/80 text-[12px] text-muted">
          {dragging === "reference" ? "Drop to add to the prompt" : "Drop file to attach"}
        </div>
      )}
      {suggestMenu}
      {/* The mention menu: the skills menu's box and rows, so the two read as one control. A row is the
          handle — exactly the text that will land in the box — then the thread's live status, dimmed and
          truncated, and a `done` tag in the tag column for a thread already filed. A sub-agent's row is
          its whole address, how it stands (`running 12m`, `returned 3h ago`), and the same `done` tag
          once it has returned. */}
      {/* Another project's thread has no children to offer here: the directory is asked of the box's own
          project, where its slug names nothing (or something else). */}
      {mentionThread && !mentionThread.project && <SubAgentMentionSource slug={mentionThread.slug} onCandidates={setSubMentions} />}
      {mentionOpen && (
        <div
          ref={suggestListRef}
          data-mention-menu
          role="listbox"
          aria-label={projectMatches.length ? "Projects" : fileMatches.length ? (mentionRows.length > fileMatches.length ? "Threads and files" : "Files") : dotted ? "Sub-agents" : "Threads"}
          className={`absolute ${menuBelow ? "top-full mt-1.5" : "bottom-full mb-1.5"} left-0 right-0 z-20 max-h-56 overflow-y-auto rounded-lg border border-border bg-bg py-1 shadow-lg`}
        >
          {mentionRows.map((row, i) => {
            // A file's row: its name where a thread's handle stands — no `@`, since what lands is a path,
            // not a mention — and its folder, dimmed, where a thread's status stands.
            if (row.kind === "file") return (
            <button
              key={`file:${row.file.path}`}
              type="button"
              role="option"
              aria-selected={i === suggestSel}
              data-suggest-index={i}
              data-mention-file={row.file.label}
              title={row.file.label}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => acceptFile(row.file)}
              onMouseEnter={() => setSuggestSel(i)}
              className={`flex w-full items-baseline gap-2 ${MENU_ROW_INSET} py-1.5 text-left ${i === suggestSel ? "bg-panel-2" : ""}`}
            >
              <span className="shrink-0 text-[12px] font-medium text-fg">{basename(row.file.label)}{row.file.folder ? "/" : ""}</span>
              {dirnameLike(row.file.label) && <span className="min-w-0 truncate text-[11px] text-muted">{dirnameLike(row.file.label)}</span>}
            </button>
            )
            // A project's row: `#slug` where a thread's handle stands — exactly what will land — and its
            // display name, dimmed, where a thread's status stands, when it says something the slug does not.
            if (row.kind === "project") return (
            <button
              key={`project:${row.project.slug}`}
              type="button"
              role="option"
              aria-selected={i === suggestSel}
              data-suggest-index={i}
              data-mention-project={row.project.slug}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => acceptProject(row.project)}
              onMouseEnter={() => setSuggestSel(i)}
              className={`flex w-full items-baseline gap-2 ${MENU_ROW_INSET} py-1.5 text-left ${i === suggestSel ? "bg-panel-2" : ""}`}
            >
              <span className="shrink-0 text-[12px] font-medium text-fg">#{row.project.slug}</span>
              {row.project.name.toLowerCase() !== row.project.slug && <span className="min-w-0 truncate text-[11px] text-muted">{row.project.name}</span>}
            </button>
            )
            const m = row.thread
            return (
            <button
              key={m.subAgentId ?? m.slug}
              type="button"
              role="option"
              aria-selected={i === suggestSel}
              data-suggest-index={i}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => acceptMention(m)}
              onMouseEnter={() => setSuggestSel(i)}
              className={`flex w-full items-baseline gap-2 ${MENU_ROW_INSET} py-1.5 text-left ${i === suggestSel ? "bg-panel-2" : ""}`}
            >
              <span className="shrink-0 text-[12px] font-medium text-fg">@{m.handle}</span>
              {m.status && <span className="min-w-0 truncate text-[11px] text-muted">{m.status}</span>}
              {m.done && <span className="petite-caps ml-auto shrink-0 text-[10px] text-muted-70">done</span>}
              {m.project && <span className={`${m.done ? "" : "ml-auto "}shrink-0 text-[11px] text-muted-70`}>{m.project.name}</span>}
            </button>
            )
          })}
        </div>
      )}
      {/* The textarea and its marker backdrop share one box: the wrapper is a plain block (no layout
          change from the bare textarea), the mirror fills it behind the transparent-backgrounded
          textarea, and the padding/typography class string is IDENTICAL on both by construction —
          any drift between them detaches every pill from its token. */}
      {header}
      <div className="relative">
        {markRuns.length > 0 && (
          <div
            ref={highlightRef}
            aria-hidden
            data-composer-highlight-backdrop
            className={`pointer-events-none absolute inset-0 select-none overflow-hidden whitespace-pre-wrap [overflow-wrap:break-word] px-3.5 ${footer ? "py-2.5 pb-3" : "py-2.5"} text-[13px] leading-relaxed text-transparent`}
            style={footer ? undefined : { paddingRight: rail.reserve }}
          >
            {markRuns.map((m, i) => (
              // Zero-layout like the context pill: every tone's side pad is bought back by its negative
              // margin, and its vertical pad never moves an inline box (styles.css `[data-composer-mark]`).
              <MarkRun key={m.key ?? `${m.tone}:${m.start}`} prose={prose} mark={m} from={i === 0 ? 0 : markRuns[i - 1]!.end} />
            ))}
            {prose.slice(markRuns[markRuns.length - 1]!.end)}
            {prose.endsWith("\n") && " "}
          </div>
        )}
        {backdropSegments && (
          <div
            ref={contextRef}
            aria-hidden
            data-composer-context-backdrop
            className={`pointer-events-none absolute inset-0 select-none overflow-hidden whitespace-pre-wrap [overflow-wrap:break-word] px-3.5 ${footer ? "py-2.5 pb-3" : "py-2.5"} text-[13px] leading-relaxed ${backdrop?.paintsText ? `text-fg ${busy ? "opacity-60" : ""}` : "text-transparent"}`}
            style={footer ? undefined : { paddingRight: rail.reserve }}
          >
            {backdropSegments}
            {/* A textarea gives a trailing newline its own empty line and a div does not; without
                this the mirror is a line short and stops panning before the textarea does. */}
            {prose.endsWith("\n") && " "}
          </div>
        )}
        <textarea
          id={id}
          ref={taRef}
          // 1Password's extension offers to create an SSH key on any bare textarea it focuses; this is
          // its documented opt-out. Every prose textarea in the app carries it.
          data-1p-ignore
          onScroll={mirrored ? syncContextScroll : undefined}
          title={hoverSource}
          onMouseMove={backdropSegments && contextSources ? (e) => setHoverSource(sourceAt(e.clientX, e.clientY)) : undefined}
          onMouseLeave={hoverSource === undefined ? undefined : () => setHoverSource(undefined)}
          data-surface={surface}
          // Escape here BLURS (onKeyDown below); the enclosing
          // ThreadSheet reads this to leave the key to us instead of dismissing itself on the same press.
          data-claims-escape
          value={prose}
          autoFocus={autoFocus}
          disabled={busy}
          onChange={(e) => {
            if (onInputEvent) {
              const native = e.nativeEvent as InputEvent
              onInputEvent({ type: "edit", prose: e.target.value, caret: e.target.selectionStart, inputType: native.inputType, composing: native.isComposing === true })
            }
            const route = onLeadingProject && !(e.nativeEvent as InputEvent).isComposing && !leadingProjectRoute(prose, projectMentions) ? leadingProjectRoute(e.target.value, projectMentions) : undefined
            if (route && onLeadingProject!(route.slug, joinComposerValue(route.rest, attachmentPaths))) return
            setProse(e.target.value)
            trackCaret(e.target)
          }}
          onCompositionEnd={onInputEvent ? (e) => onInputEvent({ type: "compositionend", prose: e.currentTarget.value, caret: e.currentTarget.selectionStart }) : undefined}
          onSelect={mentionCandidates || slashSuggest || fileMentions ? (e) => trackCaret(e.currentTarget) : undefined}
          onBlur={mentionCandidates || slashSuggest || fileMentions || onInputEvent ? () => {
            setCaret(null)
            onInputEvent?.({ type: "blur" })
          } : undefined}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            // Any file item claims the whole paste (preventDefault) — deliberately. An image paste
            // usually carries a junk text/html or filename text/plain fallback that must NOT be
            // inserted as text. Known trade-off: a genuinely mixed text+file clipboard loses its text
            // half; revisit only with a heuristic that can tell the fallback from real prose.
            const files = [...e.clipboardData.items].filter((i) => i.kind === "file").map((i) => i.getAsFile()!).filter(Boolean)
            if (files.length) {
              e.preventDefault()
              void takeFiles(files)
            }
          }}
          placeholder={placeholder}
          rows={1}
          spellCheck={false}
          style={{ minHeight, maxHeight, paddingRight: footer ? undefined : rail.reserve }}
          // With a footer strip the box is an INSET-FOOTER layout: the strip below already reserves the
          // vertical band the floating buttons occupy, so the text runs FULL width (no right rail carved
          // out of every line). Without a footer the box is a single compact row and the right padding is
          // what keeps text from sliding under the floating paperclip/send buttons. `relative` keeps the
          // caret and text painting above the marker backdrop behind it.
          className={`relative block w-full resize-none bg-transparent px-3.5 ${footer ? "py-2.5 pb-3" : "py-2.5"} text-[13px] leading-relaxed ${backdrop?.paintsText ? "text-transparent caret-fg" : "text-fg"} outline-none placeholder:text-muted scrollbar-none disabled:opacity-60`}
        />
      </div>
      {/* Attachment chips along the bottom row — one square tile per attached file (image thumbnail or
          file-type icon), each removable. The paths still live in `value`; these tiles just render them
          instead of the raw absolute-path text. Reserve the right rail so tiles never slip under the
          paperclip/send buttons on the last row. */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-3 pb-2" style={{ paddingRight: rail.reserve }}>
          {attachments.map((a, i) => (
            <AttachmentChip
              key={`${a.path}-${i}`}
              attachment={a}
              disabled={busy}
              onRemove={() => setPaths(attachmentPaths.filter((_, j) => j !== i))}
            />
          ))}
        </div>
      )}
      {/* Inline footer strip along the bottom edge — always reserved below the auto-growing text.
          Inset = 6px (px-1.5 pb-1.5) so the leftmost readout chip's rounded-md (6px) bottom-left
          corner reads CONCENTRIC with the box's rounded-xl (12px): inner radius (6) = outer (12) −
          inset (6), i.e. both arcs share a center. At the old px-2 (8px) the chip's corner sat 2px
          inside the box arc and read misaligned. */}
      {/* Reserve the right-side action rail. Without this, three shrinkable readouts can extend under
          the absolutely positioned GitHub/send buttons on narrow composers. */}
      {footer && (
        <div className="flex min-w-0 flex-wrap items-center gap-1 pl-1.5 pb-1.5" style={{ paddingRight: rail.reserve }}>
          {footer}
          {aside}
          {/* The forced chord's one visible trace: only while a draft exists AND the turn it would cut
              short is running (`onInterruptSubmit` is set exactly then), so an idle box stays quiet.
              Right-justified against the rail; the readouts before it are `flex-1`. */}
          {onInterruptSubmit && hasContent && !busy && (
            // After an editor line (`aside`, which takes the free space itself) it sits beside it: two auto
            // margins would split the free space and float the line in the middle of the strip.
            <span data-composer-interrupt-hint className="ml-auto max-w-full shrink-0 truncate text-[11px] text-muted-70 [[data-editor-line]~&]:ml-1">
              {interruptChord} to interrupt
            </span>
          )}

        </div>
      )}
      {/* Outlined controls keep 8px between edges; prose reserves the same clearance. */}
      {railLead && <div className="absolute bottom-2 flex items-center" style={{ right: rail.right.lead }}>{railLead}</div>}
      {railPermission && <div className="absolute bottom-2 flex items-center" style={{ right: rail.right.perm }}>{railPermission}</div>}
      {/* Attach: a hidden file input driven by the paperclip. Sits in the right rail LEFT of the send
          button, so it never overlaps the mode/model footer or the send
          affordance. Accept is the shared extension allowlist; the /attach route re-validates. */}
      <input
        ref={fileRef}
        type="file"
        multiple
        accept={ATTACHMENT_ACCEPT}
        className="hidden"
        onChange={(e) => {
          void takeFiles(e.target.files)
          e.target.value = "" // reset so re-picking the same file fires change again
        }}
      />
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={busy || uploading}
        title="Attach files"
        aria-label="Attach files"
        // Measured against Send's ink, not its box (lib/iconRhythm.ts).
        style={{ right: rail.right.paperclip }}
        className={`icon-hover-outline absolute bottom-2 flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-[color,background-color] enabled:hover:bg-panel-2/70 enabled:hover:text-fg disabled:opacity-50`}
      >
        {uploading ? <Loader2 size={15} strokeWidth={2} className="animate-spin" /> : <Paperclip size={15} strokeWidth={2} />}
      </button>
      {send ? (
        <SendSplitButton
          // `uploading` mirrors the Enter gate above: sending mid-upload dropped the pending attachment.
          armed={armed && !busy && !uploading}
          busy={busy}
          mode={send.mode}
          running={send.running}
          right={rail.right.send}
          onMode={send.onMode}
          onSend={submit}
          onMenuClosed={() => taRef.current?.focus({ preventScroll: true })}
        />
      ) : (
      <button
        type="button"
        // Prevent the mousedown default so clicking Send never blurs the textarea (the repo's idiom for
        // every submit affordance that sits beside a live input). Focus then never leaves the box on the
        // click path, so there is nothing to restore — and a surface that blurs on send stays in charge.
        onMouseDown={(e) => e.preventDefault()}
        onClick={submit}
        // `uploading` mirrors the Enter gate above: sending mid-upload dropped the pending attachment.
        disabled={!hasContent || busy || uploading}
        title={sendTitle ?? (sendGlyph === "schedule" ? "Create schedule (Enter)" : `Send (Enter · ${interruptChord} sends now)`)}
        aria-label={sendGlyph === "schedule" ? "Create schedule" : "Send"}
        aria-busy={sendPending || undefined}
        data-composer-send={sendGlyph}
        data-composer-send-pending={sendPending || undefined}
        // Never `transition-all`: it animates box-shadow, which holds the hover edge back (styles.css).
        style={{ right: rail.right.send }}
        className={`icon-hover-outline absolute bottom-2 flex h-7 w-7 items-center justify-center rounded-lg transition-[color,background-color,opacity,scale] ${
          // Primary actions use neutral contrast; the accent marks focus.
          hasContent && !busy && !uploading
            ? "bg-fg text-bg hover:opacity-90 active:scale-95"
            : "bg-panel-2 text-muted"
        }`}
      >
        {busy || sendPending ? <Loader2 size={14} strokeWidth={2.5} className="animate-spin" /> : (
          // BOTH glyphs, stacked, so the swap is a 120ms cross-fade on the same pixels rather than one icon
          // popping for another; same size and stroke, so neither moves the rail's measured rhythm. Measured
          // 2026-10-06 (composer-icons-fixture ?send=schedule, geometry): one 1.46px pen, ↑ ink 9.62², ↻ ink
          // 11.96×13.12, each centred to 0.00px in the 28px square — ↻ is the bigger mark by its drawing, not
          // its placement.
          <span aria-hidden className="grid place-items-center">
            <ArrowUp size={14} strokeWidth={2.5} className={`col-start-1 row-start-1 transition-opacity duration-[120ms] motion-reduce:transition-none ${sendGlyph === "schedule" ? "opacity-0" : "opacity-100"}`} />
            <Repeat size={14} strokeWidth={2.5} className={`col-start-1 row-start-1 transition-opacity duration-[120ms] motion-reduce:transition-none ${sendGlyph === "schedule" ? "opacity-100" : "opacity-0"}`} />
          </span>
        )}
      </button>
      )}
    </div>
  )
}

/** One marked run and the plain text before it. A component so each mark keeps its element by key. */
function MarkRun({ prose, mark, from }: { prose: string; mark: ComposerMark; from: number }) {
  return (
    <>
      {prose.slice(from, mark.start)}
      <mark data-composer-highlight data-composer-mark={mark.tone}>{prose.slice(mark.start, mark.end)}</mark>
    </>
  )
}

// The `@thread.` menu's data: the named thread's sub-agent directory, handed up as candidates. A
// component rather than a hook in Composer because it is MOUNTED ONLY while a dotted query names a
// thread — Composer also renders on fixture pages with no query client, and a hook would need one there.
// The candidates are built when the directory lands (their ages are read then; the stale time bounds how
// old that is) and tagged with the slug they belong to, so a head retyped to another thread never shows
// the previous thread's children for a frame.
function SubAgentMentionSource({ slug, onCandidates }: { slug: string; onCandidates: (next: { slug: string; candidates: MentionCandidate[] }) => void }) {
  const { data } = useSubAgentDirectory(slug)
  useEffect(() => {
    if (data) onCandidates({ slug, candidates: subAgentMentionCandidates(slug, data) })
  }, [data, slug])
  return null
}

// One attached file as a compact square tile. An image renders a /local-image thumbnail (object-cover,
// the same gated route the transcript uses); a document renders a bordered tile with a file glyph and
// its extension. A broken image (route 4xx / missing file) falls back to the document tile so a stale
// path is never a blank square. The × removes just this path from the draft. Its name is the file's as
// it was dropped: the server stores each upload as `<ms>-<8 hex>-<name>` (app.ts /attach) so two of the
// same name never collide, and that stamp named the tile until the sweep (2026-10-01) — the draft still
// carries the full path.
function attachmentDisplayName(path: string): string {
  return basename(path).replace(/^\d{10,}-[0-9a-f]{8}-/u, "")
}

function AttachmentChip({
  attachment,
  disabled,
  onRemove,
}: {
  attachment: { path: string; kind: "image" | "file" }
  disabled?: boolean
  onRemove: () => void
}) {
  const [broken, setBroken] = useState(false)
  const base = attachmentDisplayName(attachment.path)
  const ext = (base.includes(".") ? base.split(".").pop()! : "").toUpperCase()
  const asImage = attachment.kind === "image" && !broken
  return (
    <div className="group/att relative h-11 w-11" title={base}>
      {asImage ? (
        <img
          src={localImageUrl(attachment.path)}
          alt={base}
          onError={() => setBroken(true)}
          className="h-11 w-11 rounded-md border border-border object-cover"
        />
      ) : (
        <div className="flex h-11 w-11 flex-col items-center justify-center gap-0.5 rounded-md border border-border bg-panel-2 px-1">
          <FileText size={15} strokeWidth={2} className="shrink-0 text-muted" />
          {/* `-mx-1` cancels the tile's px-1 for the LABEL only: the inset is there to give the icon
              air, and spending it on the badge too left 34px of the tile's 44 for text. At 8px caps
              that is ~5.5px a character, so a seven-letter extension clipped to "PARQ…" — measured
              39px needed against 34px available, once .parquet/.sqlite3 became attachable. The icon
              keeps its inset; the label now gets the full 42px and every extension up to seven
              characters fits. */}
          {ext && <span className="-mx-1 max-w-[calc(100%+0.5rem)] truncate text-[8px] font-medium leading-none text-muted-80">{ext}</span>}
        </div>
      )}
      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        title={`Remove ${base}`}
        aria-label={`Remove ${base}`}
        className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full border border-border bg-bg text-muted opacity-0 transition-opacity hover:text-fg focus-visible:opacity-100 group-hover/att:opacity-100 disabled:hidden"
      >
        <X size={10} strokeWidth={2.5} />
      </button>
    </div>
  )
}
