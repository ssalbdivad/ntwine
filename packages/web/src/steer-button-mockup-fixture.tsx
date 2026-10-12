import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Check, ChevronDown, Mic, Paperclip } from "lucide-react"
import { questionAnswerMessage, type BoardSnapshot, type QuestionAnswer, type RegisteredQuestionView, type ThreadView } from "@frizz/shared"
import type { ChatMessage } from "./hooks.ts"
import { Message, WorkingIndicator, withMessageSpacers } from "./components/ChatView.tsx"
import { VSpace } from "./components/rhythm.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import {
  RegisteredAnsweringContext, RegisteredQuestionCard, SettledQuestionCard, useRegisteredAnswering, type SettledQuestion,
} from "./components/RegisteredQuestionCards.tsx"
import { GoalMark } from "./components/RecurringPromptControl.tsx"
import { draftKey, draftStore } from "./lib/drafts.ts"
import { OPAQUE_SURFACE_BASE } from "./lib/overlaySurface.ts"
import { encodeQuestionPick } from "./lib/registeredPicks.ts"
import { ROOT_PATH, registeredAnswer } from "./lib/registeredQuestion.ts"
import { store } from "./store.ts"
import "./styles.css"

// MOCKUP SHEET — ONE SEND FOR ANSWERS AND A STEER.
//
// Not shipped UI and not a test. The maintainer, 2026-10-10: "We need to drop the send answers button
// and instead have it such that you send in your answers using the up arrow button in the bottom right
// of the prompt box. It's very annoying to me that I can't send my answers and submit an additional
// steer at the same time, so we need to unify them. […] just have it be a big white button […] say
// 'Steer' on it. There should be a dropdown on the right that lets you change it to [Queue]. [Queue]
// just means that Frizz maintains that in memory until the agent comes to rest, and then it pushes it.
// There's force steer, I guess, so there are three options there. Maybe it's just actually queue and
// steer initially. We should also have the placeholder text change if there are already some answers
// that have been filled out." Then: "The button should turn white as soon as any answers are filled
// out. Basically, mock this all up."
//
// ROUND TWO, the same day, on the first sheet (a button that read Steer or Queue): "I kind of think the
// button should always say 'Send', no matter what, and the user can hit the dropdown to change it
// between the values. Send as steer / Send to queue / Send as force steer. But the button should always
// say 'Send', which also is broad enough to encapsulate the fact that it may also be sending question
// answers." So the word never changes, the caret is always there, and the three ways to send are the
// menu's three rows. What says which row is ticked, with the menu shut, is the placeholder.
//
// WHAT IS TRUE TODAY (read from the code on 2026-10-10, so the sheet can say what is new):
//   · A typed message to a working agent is already a steer: `rpc.followUp` hands it to the provider at
//     once (the Claude SDK reads it at its next step, Codex takes a `turn/steer`). An ACP agent cannot
//     be steered; its bridge queues the message behind the running turn.
//   · ⌘/Ctrl-Enter is already the forced send (`interrupt: true`), on Claude threads only.
//   · NOTHING holds a typed message until the agent rests. The nearest thing is the scheduler's wake
//     outbox, which is what carries registered answers: `answerQuestions` stores them and delivers at
//     rest (or after 10m of a running turn). So today answers queue and typed text steers, and
//     "Send answers" reads only the cards — the prompt box's draft is not part of it.
//
// Every frame is the REAL Message renderer, the REAL RegisteredQuestionCard / SettledQuestionCard on one
// useRegisteredAnswering per frame, and the real WorkingIndicator, so picks, typed answers and the
// answers card behave and read as they do in the app. The prompt box is a copy of Composer's desktop
// layout with the new button in the send slot; the menu and the queued-message line are drawn here.
// Nothing is sent anywhere: a send moves the frame's own state.
//
//   nubx vite --port 5478 --strictPort   (from packages/web), then
//   http://localhost:5478/steer-button-mockup-fixture.html
//   ?theme=light · ?spacing=A…H (which of the button's spacing candidates the cards wear)
const params = new URLSearchParams(location.search)
document.documentElement.dataset.font = "sans"
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark"

const PROJECT = "/fixture/acme"
store.board = { projectDir: PROJECT, threads: [] } as unknown as BoardSnapshot

// The cards' own hook sends through `answerQuestions`; the sheet replaces that send, but a stray RPC
// (the settled-questions read) must not reach a server that is not there.
const originalFetch = window.fetch
window.fetch = async (input, init) => {
  // location.href, not origin: the page also ships as one file:// document, whose origin is "null".
  const url = new URL(typeof input === "string" ? input : (input as Request).url ?? input.toString(), location.href)
  if (url.pathname.includes("/_frizz/")) return new Response(JSON.stringify({ result: null }), { headers: { "content-type": "application/json" } })
  return originalFetch(input, init)
}

// ── the thread ────────────────────────────────────────────────────────────────────────────────────

const MIN = 60_000
const at = (min: number) => new Date(Date.now() - min * MIN).toISOString()

const Q_CACHES: RegisteredQuestionView = {
  id: "qst_7a1c0e2f",
  askedAt: at(4),
  spec: {
    question: "Fix the import-map cache and the tsconfig lookup in this change too, or leave them for a separate one?",
    kind: "question",
    options: [
      { label: "Fix them here", description: "same root cause and the same test shape — one review instead of two", recommended: true },
      { label: "A separate change", description: "keeps this diff to the bug that was reported" },
    ],
  },
} as RegisteredQuestionView

const Q_FORMAT: RegisteredQuestionView = {
  id: "qst_9b3d51aa",
  askedAt: at(4),
  spec: {
    question: "Ship the new cache format as it is, or add a migration that rewrites the old entries?",
    kind: "question",
    options: [
      { label: "Ship it as it is", description: "one cold start per machine, and no migration code to keep", recommended: true },
      { label: "Add a migration", description: "no cold start; about 80 lines that run once and then sit there" },
    ],
  },
} as RegisteredQuestionView

const text = (sourceId: string, role: "user" | "assistant", body: string, min: number, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  sourceId, role, text: body, tools: [], parts: role === "user" ? [] : [{ kind: "text", text: body }], at: at(min), ...extra,
} as ChatMessage)
const work = (sourceId: string, lead: string, tools: { name: string; detail: string; desc?: string }[], min: number): ChatMessage => ({
  sourceId, role: "assistant", text: "", tools: [], parts: [{ kind: "text", text: lead }, { kind: "tools", tools }], at: at(min),
} as ChatMessage)

const ASK = text("u1", "user", "Renamed files keep resolving to their old module until I restart the dev server. Find out why and fix it.", 30)
const READING = work("a1", "Reading the resolver and its cache first.", [
  { name: "Read", detail: "src/resolver/cache.ts" },
  { name: "Grep", detail: "cacheKey" },
  { name: "Edit", detail: "src/resolver/cache.ts" },
  { name: "Write", detail: "src/resolver/rename.test.ts" },
  { name: "Bash", detail: "nub run test resolver", desc: "Running the resolver tests" },
], 22)

const RESTED: ChatMessage[] = [
  ASK,
  READING,
  text("a2", "assistant", [
    "**Needs you** — renamed files resolved stale because the resolver cached on the raw path. The fix is on the `cache-key` branch, and two calls stand between it and `main`.",
    "",
    "The cache now keys on the normalized id, so a rename misses the old entry and re-resolves. The new regression test fails without the change and passes with it.",
  ].join("\n"), 4),
]

const WORKING: ChatMessage[] = [ASK, READING]

const WORKING_ASKED: ChatMessage[] = [
  ASK,
  READING,
  text("a2", "assistant", "The fix is in and the rename test passes. It changes the on-disk cache format, so one call is yours while the rest of the suite runs:", 3),
]

// ── a frame's state ─────────────────────────────────────────────────────────────────────────────────

/** How the button sends — the row ticked in its menu. The button's word is "Send" under all three. */
type Mode = "steer" | "queue" | "force"

interface Staged { q: RegisteredQuestionView; answer: QuestionAnswer }

interface FrameState {
  running: boolean
  open: RegisteredQuestionView[]
  settled: SettledQuestion[]
  /** The human's turns the agent has (or is being handed). */
  tail: ChatMessage[]
  /** The human's turns Frizz is holding until the agent rests. */
  held: ChatMessage[]
  text: string
  mode: Mode
  said?: string
}

let turnSeq = 0
const human = (body: string, queued: boolean): ChatMessage => ({
  sourceId: `h${++turnSeq}`, role: "user", text: body, tools: [], parts: [], at: new Date().toISOString(), ...(queued ? { queued: true } : {}),
} as ChatMessage)

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** THE ONE SEND. Whatever is staged on the question cards and whatever is typed in the box leave
 *  together, as one turn: the answers card first, the note under it. */
function send(s: FrameState, staged: Staged[], kind: Mode): FrameState {
  const note = s.text.trim()
  if (staged.length === 0 && !note) return s
  const hold = s.running && kind === "queue"
  const turns: ChatMessage[] = []
  if (staged.length > 0) turns.push(human(questionAnswerMessage(staged.map((p) => p.answer)), hold))
  if (note) turns.push(human(note, hold))
  const ids = new Set(staged.map((p) => p.q.id))
  const settledAt = new Date().toISOString()
  const what = [staged.length > 0 ? plural(staged.length, "answer") : "", note ? (staged.length > 0 ? "a note" : "a message") : ""].filter(Boolean).join(" and ")
  return {
    ...s,
    text: "",
    open: s.open.filter((q) => !ids.has(q.id)),
    settled: [...s.settled, ...staged.map(({ q, answer }): SettledQuestion => ({ id: q.id, spec: q.spec, askedAt: q.askedAt, settledAt, answer } as SettledQuestion))],
    tail: hold ? s.tail : [...s.tail, ...turns],
    held: hold ? [...s.held, ...turns] : s.held,
    running: true,
    said: hold
      ? `Queued ${what}. Frizz holds it until the agent rests.`
      : !s.running
        ? `Sent ${what} as one turn. The agent is working again.`
        : kind === "force"
          ? `Interrupted the turn and sent ${what}. The agent reads it now.`
          : `Sent ${what} as one turn. The agent reads it at its next step.`,
  }
}

const delivered = (held: ChatMessage[]): ChatMessage[] => held.map((m) => ({ ...m, queued: undefined } as ChatMessage))

/** The agent comes to rest. Anything Frizz was holding goes out as its next turn, so it works on. */
function rest(s: FrameState): FrameState {
  if (s.held.length > 0) {
    return { ...s, tail: [...s.tail, ...delivered(s.held)], held: [], mode: "steer", said: `The agent came to rest. Frizz sent the ${plural(s.held.length, "queued message")} as its next turn.` }
  }
  return { ...s, running: false, mode: "steer", said: "The agent came to rest." }
}

interface Scene {
  id: string
  title: string
  note: string
  meta: string
  messages: ChatMessage[]
  running: boolean
  questions: RegisteredQuestionView[]
  /** Option index picked on each question before the human touches the frame. */
  picks?: Record<string, number>
  text?: string
  mode?: Mode
  /** A message already sent in Queue mode. */
  held?: string
  /** The frame opens AFTER its first send. */
  sent?: boolean
  menuOpen?: boolean
  width?: number
  height: number
}

const answerOf = (q: RegisteredQuestionView, option: number): QuestionAnswer =>
  registeredAnswer(q, new Map([[ROOT_PATH, { chosen: option, chosenSet: [], text: "" }]]))!

function initial(scene: Scene): FrameState {
  let s: FrameState = { running: scene.running, open: scene.questions, settled: [], tail: [], held: [], text: "", mode: "steer" }
  if (scene.held) s = send({ ...s, text: scene.held }, [], "queue")
  s = { ...s, text: scene.text ?? "", mode: scene.mode ?? "steer", said: undefined }
  if (scene.sent) {
    const staged = scene.questions.flatMap((q) => (scene.picks?.[q.id] === undefined ? [] : [{ q, answer: answerOf(q, scene.picks[q.id]) }]))
    s = { ...send(s, staged, "steer"), said: undefined }
  }
  return s
}

const pickKey = (slug: string, q: RegisteredQuestionView) => draftKey.questionPick(PROJECT, slug, q.id, ROOT_PATH)
const textKey = (slug: string, q: RegisteredQuestionView) => draftKey.question(PROJECT, slug, q.id, ROOT_PATH)

/** Put the scene's picks on its cards — through the same draft store the real cards read. */
function stagePicks(scene: Scene) {
  for (const q of scene.questions) {
    const option = scene.sent ? undefined : scene.picks?.[q.id]
    draftStore.set(pickKey(scene.id, q), option === undefined ? "" : encodeQuestionPick(q.spec, { chosen: option, chosenSet: [] }))
    draftStore.clear(textKey(scene.id, q))
  }
}

const thread = (slug: string, questions: RegisteredQuestionView[], running: boolean) => ({
  id: slug, title: "Fix stale resolution after a rename", status: "active", mechanism: null, humanBlocked: false, needsYou: !running,
  awaitingBackground: false, ready: false, dependsOn: [], externalDeps: [], agents: [], errors: [], warnings: [], runtime: running ? "running" : "turn-idle",
  unread: false, archived: false, hasPlan: false, pendingQuestion: false, questions, kind: "session", foreign: false, backend: "claude",
  permissionMode: "default", subAgents: [], bgShells: [], watches: [], lastActivityAt: at(3),
}) as unknown as ThreadView

// ── the placeholder ──────────────────────────────────────────────────────────────────────────────────

/** With the menu shut, this is what says how the button will send. A staged answer outranks it: the box
 *  is then a note on the answers, whichever way they go. */
function placeholderFor(staged: number, open: number, running: boolean, mode: Mode): string {
  if (staged > 0) return staged === 1 ? "Add a note to send with your answer…" : `Add a note to send with your ${staged} answers…`
  if (open > 0) return "Or skip the questions and reply…"
  if (running && mode === "queue") return "Queue a message for when the agent rests…"
  if (running && mode === "force") return "Interrupt the agent with a message…"
  return "Reply to the agent…"
}

// ── the button ────────────────────────────────────────────────────────────────────────────────────

const ROWS: { mode: Mode; name: string; says: string }[] = [
  { mode: "steer", name: "Send as steer", says: "The agent reads it at its next step." },
  { mode: "queue", name: "Send to queue", says: "Frizz holds it until the agent comes to rest." },
  { mode: "force", name: "Send as force steer", says: "Interrupts the agent, which reads it now." },
]
const ROW_NAME = Object.fromEntries(ROWS.map((r) => [r.mode, r.name])) as Record<Mode, string>

/** ONE WAY TO SPACE THE BUTTON. The four gaps the eye reads are ink distances — left edge to the S,
 *  the d to the divider, the divider to the chevron, the chevron to the right edge — and none of them
 *  is a padding: the word wears ~0.7px of side bearing and the 13px chevron paints ~7.8px of its box.
 *  So each candidate is stated as box values and CAPTIONED with what it paints (`ink`: read from
 *  pixels with the button right-anchored and drawn as a 2x screen draws it — CSS zoom 2, then 6
 *  device px per zoomed px — in sans; re-measure if the font, the size or the glyph changes).
 *  The maintainer on the first two passes: "it looks like there's more space to the left of 'send'
 *  than to the right of it", then, of the correction, "overcompensated. GIVE ME OPTIONS". */
interface Spacing {
  id: string
  name: string
  says: string
  /** Box padding left and right of the word. */
  pl: number
  pr: number
  /** The caret's segment: its width, and the padding left of the chevron's 13px box. */
  caretW: number
  caretPl: number
  seam: "short" | "full" | "none"
  /** What it paints: left edge → word, word → divider (or → chevron), divider → chevron, chevron → right edge. */
  ink: [number, number, number | null, number]
}

// Every box value sits on the half-pixel grid, so on a 2x screen the divider and the chevron land on
// device pixels and the gaps beside them are exact. The button is right-anchored on the rail and the
// word's width is fractional, so its LEFT edge is the one that snaps: the first number can move by a
// quarter pixel from one layout to the next.
const SPACINGS: Spacing[] = [
  { id: "A", name: "First pass", says: "3.6px more on the left of the word than on its right. The divider sits midway between the word and the chevron.", pl: 10, pr: 6, caretW: 23, caretPl: 4, seam: "short", ink: [10.6, 7.0, 6.6, 8.6] },
  { id: "B", name: "2.6px more on the left", says: "Half a pixel moved from the left of the word to its right.", pl: 9.5, pr: 6.5, caretW: 23, caretPl: 4.5, seam: "short", ink: [10.1, 7.5, 7.1, 8.1] },
  { id: "C", name: "1.6px more on the left", says: "Halfway between the first pass and the second.", pl: 9, pr: 7, caretW: 23, caretPl: 4.5, seam: "short", ink: [9.6, 8.0, 7.1, 8.1] },
  { id: "D", name: "0.6px more on the left", says: "As near even as the half-pixel grid allows while still leaning left. The chevron is centred in its half.", pl: 8.5, pr: 7.5, caretW: 23, caretPl: 5, seam: "short", ink: [9.1, 8.5, 7.6, 7.6] },
  { id: "E", name: "Second pass", says: "0.4px more on the right. This is the one that read as overcompensated.", pl: 8, pr: 8, caretW: 23, caretPl: 5, seam: "short", ink: [8.6, 9.0, 7.6, 7.6] },
  { id: "F", name: "Roomier", says: "D's balance with a pixel more on each side of the word and half a pixel more around the chevron. The button is 3px wider.", pl: 9.5, pr: 8.5, caretW: 24, caretPl: 5.5, seam: "short", ink: [10.1, 9.5, 8.1, 8.1] },
  { id: "G", name: "No divider", says: "The word and the chevron read as one label, centred as a pair. The chevron is still its own click target. The button is 8.5px narrower.", pl: 9.5, pr: 0, caretW: 22, caretPl: 2.5, seam: "none", ink: [10.1, 6.1, null, 9.1] },
  { id: "H", name: "Full-height divider", says: "D's balance, with the divider running edge to edge so the button reads as two halves.", pl: 8.5, pr: 7.5, caretW: 23, caretPl: 5, seam: "full", ink: [9.1, 8.5, 7.6, 7.6] },
]
const DEFAULT_SPACING = "C"
const SpacingContext = createContext<Spacing>(SPACINGS.find((x) => x.id === DEFAULT_SPACING)!)

interface SendButtonProps {
  /** White: there is something to send — typed text, or an answer staged on any card. */
  armed: boolean
  /** The hover title: the one place the shut button names its way of sending. */
  title?: string
  /** A fixed candidate, for the spacing sheet. Absent, the button wears the page's chosen one. */
  spacing?: Spacing
  menu?: ReactNode
  menuOpen?: boolean
  onToggleMenu?: () => void
  onSend?: () => void
}

function SendButton({ armed, title, spacing, menu, menuOpen, onToggleMenu, onSend }: SendButtonProps) {
  const chosen = useContext(SpacingContext)
  const sp = spacing ?? chosen
  const tone = armed ? "bg-fg text-bg" : "bg-panel-2 text-muted"
  return (
    <span data-send-split className="relative flex h-7 shrink-0">
      <button
        type="button"
        data-send
        disabled={!armed}
        title={title}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onSend}
        style={{ paddingLeft: sp.pl, paddingRight: sp.pr }}
        className={`flex items-center rounded-l-lg text-[12px] font-medium leading-none outline-none transition-[color,background-color,opacity,scale] ${tone} ${armed ? "hover:opacity-90 active:scale-95" : ""}`}
      >
        {/* The word never changes, so nothing beside the button moves when the way of sending does. */}
        <span data-send-label>Send</span>
      </button>
      {sp.seam !== "none" && (
        <span aria-hidden className={`flex w-px items-center ${armed ? "bg-fg" : "bg-panel-2"}`}>
          <span className={`w-px ${sp.seam === "full" ? "h-full" : "h-3.5"} ${armed ? "bg-bg/25" : "bg-fg/15"}`} />
        </span>
      )}
      <button
        type="button"
        data-send-menu
        aria-label="Choose how this is sent"
        aria-expanded={menuOpen}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onToggleMenu}
        style={{ width: sp.caretW, paddingLeft: sp.caretPl }}
        className={`flex items-center rounded-r-lg outline-none transition-[color,background-color,opacity] ${tone} ${armed ? "hover:opacity-90" : "hover:text-fg"}`}
      >
        <ChevronDown data-send-caret size={13} strokeWidth={2.5} />
      </button>
      {menuOpen && menu}
    </span>
  )
}

function ModeMenu({ mode, running, onMode }: { mode: Mode; running: boolean; onMode: (m: Mode) => void }) {
  return (
    <div data-send-modes role="menu" className={`absolute bottom-full right-0 z-40 mb-1.5 w-[304px] rounded-lg p-1 ${OPAQUE_SURFACE_BASE}`}>
      {ROWS.map((row) => {
        const on = row.mode === mode
        // Enter sends the ticked row. ⌘⏎ is today's forced send and stays one, whichever row is ticked.
        const key = on ? "⏎" : row.mode === "force" ? "⌘⏎" : undefined
        return (
          <button
            key={row.mode}
            type="button"
            role="menuitemradio"
            aria-checked={on}
            data-send-mode={row.mode}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onMode(row.mode)}
            className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left outline-none transition-colors hover:bg-panel-2"
          >
            <span className="flex h-[18px] w-3.5 shrink-0 items-center justify-center text-fg">{on && <Check size={13} strokeWidth={2.5} />}</span>
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline justify-between gap-4 leading-[18px]">
                <span className="text-[12px] font-medium text-fg">{row.name}</span>
                {key && <span className="text-[11px] text-muted-70">{key}</span>}
              </span>
              <span className="block text-[11.5px] leading-[16px] text-muted">{row.says}</span>
            </span>
          </button>
        )
      })}
      {!running && <div className="px-2 pb-1 pt-1.5 text-[11px] leading-[15px] text-muted-70">The agent is at rest, so all three send now.</div>}
    </div>
  )
}

// ── the prompt box ─────────────────────────────────────────────────────────────────────────────────

function ProfileChips() {
  const chip = "inline-flex items-center gap-[3px] rounded-md border border-border/50 px-2 py-1 text-muted"
  return (
    <>
      <span className={chip}><span className="petite-caps text-[11px] tracking-wide">Opus 5.5 › high</span><ChevronDown size={12} className="text-fg/65" /></span>
      <span className={`${chip} opacity-70`}><span className="petite-caps text-[11px] tracking-wide">Auto</span><ChevronDown size={12} className="text-fg/65" /></span>
    </>
  )
}

function PromptBox({ value, onChange, placeholder, onEnter, onForce, button }: { value: string; onChange: (v: string) => void; placeholder: string; onEnter: () => void; onForce: () => void; button: ReactNode }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`
  }, [value])
  const icon = "flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-panel-2/70 hover:text-fg"
  return (
    <div data-composer-box className="group relative rounded-xl border border-border bg-bg transition-colors focus-within:border-accent">
      <textarea
        ref={ref}
        value={value}
        rows={1}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || e.shiftKey || e.altKey) return
          e.preventDefault()
          if (e.metaKey || e.ctrlKey) onForce()
          else onEnter()
        }}
        style={{ minHeight: 44 }}
        className="block w-full resize-none bg-transparent px-3.5 py-2.5 pb-3 text-[13px] leading-relaxed text-fg outline-none placeholder:text-muted scrollbar-none"
      />
      <div className="flex min-w-0 items-center gap-1.5 pb-2 pl-1.5 pr-2">
        <ProfileChips />
        {/* The rail's own box gaps (lib/iconRhythm RAIL_BOX_GAP): goal→paperclip −1, paperclip→mic −2,
            mic→send 6. The send slot is the only mark that changed. */}
        <span className="ml-auto flex shrink-0 items-center">
          <span className={`${icon} -mr-px`}><GoalMark size={15} /></span>
          <span className={`${icon} -mr-0.5`}><Paperclip size={15} strokeWidth={2} /></span>
          <span className={`${icon} mr-1.5`}><Mic size={15} strokeWidth={2} /></span>
          {button}
        </span>
      </div>
    </div>
  )
}

// ── a frame: one queue card ───────────────────────────────────────────────────────────────────────────

function Frame({ scene }: { scene: Scene }) {
  const [s, setS] = useState(() => initial(scene))
  const [menuOpen, setMenuOpen] = useState(Boolean(scene.menuOpen))
  // A frame that opens with its menu drawn keeps it drawn until the human uses it.
  const [pinned, setPinned] = useState(Boolean(scene.menuOpen))
  const t = useMemo(() => thread(scene.id, s.open, s.running), [scene.id, s.open, s.running])
  const answering = useRegisteredAnswering(t)
  const staged: Staged[] = s.open.flatMap((q) => {
    const answer = registeredAnswer(q, answering.answersOf(q))
    return answer ? [{ q, answer }] : []
  })
  const stagedRef = useRef(staged)
  stagedRef.current = staged
  const scroller = useRef<HTMLDivElement>(null)
  const split = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [s.tail.length, s.held.length, s.running, s.open.length])

  useEffect(() => {
    if (!menuOpen || pinned) return
    const close = (e: MouseEvent) => {
      if (!split.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener("mousedown", close)
    return () => document.removeEventListener("mousedown", close)
  }, [menuOpen, pinned])

  const go = (kind: Mode) => {
    const now = stagedRef.current
    setS((prev) => send(prev, now, kind))
    for (const { q } of now) {
      draftStore.clear(pickKey(scene.id, q))
      draftStore.clear(textKey(scene.id, q))
    }
    setMenuOpen(false)
    setPinned(false)
  }
  const reset = () => {
    stagePicks(scene)
    setS(initial(scene))
    setMenuOpen(Boolean(scene.menuOpen))
    setPinned(Boolean(scene.menuOpen))
  }

  const armed = s.text.trim() !== "" || staged.length > 0
  const menu = (
    <ModeMenu
      mode={s.mode}
      running={s.running}
      onMode={(mode) => {
        setS((prev) => ({ ...prev, mode }))
        setMenuOpen(false)
        setPinned(false)
      }}
    />
  )
  // Enter inside a question card's own text box is the same send as the button.
  const shared = useMemo(() => ({ ...answering, submit: () => go(s.mode) }), [answering, s.mode])
  const cards = scene.questions.filter((q) => s.open.includes(q) || s.settled.some((x) => x.id === q.id))

  return (
    <RegisteredAnsweringContext.Provider value={shared}>
      <div data-frame={scene.id} className="max-w-full" style={{ width: scene.width ?? 680 }}>
        <div className="flex flex-col overflow-hidden rounded-xl border border-border-strong bg-panel" style={{ height: scene.height }}>
          <div className="flex shrink-0 items-baseline gap-2 border-b border-border/60 px-5 py-3">
            <span className="truncate text-[13px] font-medium">Fix stale resolution after a rename</span>
            <span className="ml-auto shrink-0 text-[11.5px] text-muted">{s.running ? "Working" : scene.meta}</span>
          </div>
          <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
            <div className="flex flex-col px-5 pb-5 pt-5">
              {withMessageSpacers(scene.messages, (m) => <Message key={m.sourceId} m={m} />)}
              {cards.length > 0 && (
                <>
                  <VSpace h={20} />
                  {/* No "Send answers" under the cards: the prompt box's button sends them. */}
                  <div className="flex flex-col gap-3">
                    {cards.map((q) => {
                      const done = s.settled.find((x) => x.id === q.id)
                      return done ? <SettledQuestionCard key={q.id} s={done} /> : <RegisteredQuestionCard key={q.id} q={q} />
                    })}
                  </div>
                </>
              )}
              {s.tail.length > 0 && <><VSpace h={20} />{withMessageSpacers(s.tail, (m) => <Message key={m.sourceId} m={m} />)}</>}
              {s.running && <><VSpace h={16} /><WorkingIndicator since={at(2)} /></>}
              {s.held.length > 0 && (
                <>
                  <VSpace h={16} />
                  {withMessageSpacers(s.held, (m) => <Message key={m.sourceId} m={m} />)}
                  <div data-held-line className="mt-1.5 flex items-baseline justify-end gap-2 text-[11.5px] leading-[16px] text-muted">
                    <span>Queued until the agent rests</span>
                    <span className="text-muted-60">·</span>
                    <button type="button" className="underline decoration-border underline-offset-2 hover:text-fg" onClick={() => setS((prev) => ({ ...prev, tail: [...prev.tail, ...delivered(prev.held)], held: [], said: "Sent the queued messages now. The agent reads them at its next step." }))}>Send now</button>
                    <span className="text-muted-60">·</span>
                    <button type="button" className="underline decoration-border underline-offset-2 hover:text-fg" onClick={() => setS((prev) => ({ ...prev, held: [], text: [...prev.held.filter((m) => !m.text.startsWith("Answers")).map((m) => m.text), prev.text].filter(Boolean).join("\n\n"), said: "Took the queued messages back into the prompt box." }))}>Take back</button>
                  </div>
                </>
              )}
            </div>
          </div>
          <div className="shrink-0 border-t border-border/60 px-5 pb-3 pt-3">
            <PromptBox
              value={s.text}
              onChange={(v) => setS((prev) => ({ ...prev, text: v }))}
              placeholder={placeholderFor(staged.length, s.open.length, s.running, s.mode)}
              onEnter={() => go(s.mode)}
              onForce={() => go(s.running ? "force" : s.mode)}
              button={(
                <span ref={split} className="flex">
                  <SendButton armed={armed} title={`${ROW_NAME[s.mode]} (⏎)`} menu={menu} menuOpen={menuOpen} onToggleMenu={() => { setMenuOpen((v) => !v); setPinned(false) }} onSend={() => go(s.mode)} />
                </span>
              )}
            />
          </div>
        </div>
        <div className="mt-2 flex min-h-[18px] items-baseline gap-3 text-[11.5px] leading-[16px] text-muted-80">
          <span className="min-w-0 flex-1">{s.said ?? ""}</span>
          {s.running && <button type="button" className="shrink-0 underline decoration-border underline-offset-2 hover:text-fg" onClick={() => setS(rest)}>Let the agent come to rest</button>}
          <button type="button" className="shrink-0 underline decoration-border underline-offset-2 hover:text-fg" onClick={reset}>Reset</button>
        </div>
      </div>
    </RegisteredAnsweringContext.Provider>
  )
}

// ── the scenes ──────────────────────────────────────────────────────────────────────────────────────

const SCENES: Scene[] = [
  {
    id: "sb-rest-empty",
    title: "At rest with two questions, nothing answered",
    note: "The Send answers button under the cards is gone. Nothing is staged and nothing is typed, so the button is dim. The placeholder is today's.",
    meta: "Rested 4m ago",
    messages: RESTED,
    running: false,
    questions: [Q_CACHES, Q_FORMAT],
    height: 700,
  },
  {
    id: "sb-rest-picked",
    title: "One answer picked",
    note: "The button turns white as soon as one question has an answer, with the box still empty. The placeholder now says what typing would add. Enter in the box, or a click, sends the answer.",
    meta: "Rested 4m ago",
    messages: RESTED,
    running: false,
    questions: [Q_CACHES, Q_FORMAT],
    picks: { [Q_CACHES.id]: 0 },
    height: 700,
  },
  {
    id: "sb-rest-both",
    title: "Two answers and a typed note",
    note: "One click sends all of it as one turn. Press it to see what lands.",
    meta: "Rested 4m ago",
    messages: RESTED,
    running: false,
    questions: [Q_CACHES, Q_FORMAT],
    picks: { [Q_CACHES.id]: 0, [Q_FORMAT.id]: 1 },
    text: "Keep the migration behind a flag for one release, and add a test for the tsconfig lookup.",
    height: 700,
  },
  {
    id: "sb-sent",
    title: "After that send",
    note: "The cards grey in place, as they do today. The answers card and the note land together as the human's one turn, and the agent goes back to work.",
    meta: "Rested 4m ago",
    messages: RESTED,
    running: false,
    questions: [Q_CACHES, Q_FORMAT],
    picks: { [Q_CACHES.id]: 0, [Q_FORMAT.id]: 1 },
    text: "Keep the migration behind a flag for one release, and add a test for the tsconfig lookup.",
    sent: true,
    height: 860,
  },
  {
    id: "sb-run-menu",
    title: "Agent working — the menu",
    note: "The caret opens the three ways to send. The ticked row is what Enter and the button do. Picking a row sends nothing, and the button goes on saying Send.",
    meta: "Working",
    messages: WORKING,
    running: true,
    questions: [],
    text: "Check the import-map cache too.",
    menuOpen: true,
    height: 520,
  },
  {
    id: "sb-run-queue",
    title: "Agent working — Send to queue chosen",
    note: "The button still says Send; the placeholder says the message will be queued. A queued message sits dimmed under the Working line, where a waiting message sits today, with a line that says who holds it. Let the agent come to rest to see Frizz send it.",
    meta: "Working",
    messages: WORKING,
    running: true,
    questions: [],
    mode: "queue",
    held: "When that's green, open the PR as a draft.",
    height: 520,
  },
  {
    id: "sb-run-force",
    title: "Agent working — Send as force steer chosen",
    note: "The placeholder says the message will interrupt. Enter or the button stops the turn, and the agent reads the message at once.",
    meta: "Working",
    messages: WORKING,
    running: true,
    questions: [],
    mode: "force",
    text: "Stop. That test file is generated; edit the template instead.",
    height: 520,
  },
  {
    id: "sb-run-question",
    title: "Agent working, with a question open",
    note: "A worker can ask and keep going. The picked answer makes the button white. As a steer the answer is handed over now; to the queue, Frizz holds it, with any note, until the agent rests.",
    meta: "Working",
    messages: WORKING_ASKED,
    running: true,
    questions: [Q_FORMAT],
    picks: { [Q_FORMAT.id]: 0 },
    height: 620,
  },
  {
    id: "sb-narrow",
    title: "A 420px drawer",
    note: "The narrowest box the desktop draws. The model and permission pills, the three rail icons and the button still share one row.",
    meta: "Rested 4m ago",
    messages: RESTED,
    running: false,
    questions: [Q_CACHES],
    picks: { [Q_CACHES.id]: 1 },
    width: 420,
    height: 620,
  },
]

for (const scene of SCENES) stagePicks(scene)

// ── the page ──────────────────────────────────────────────────────────────────────────────────────

function Seg<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="flex items-center gap-2 text-[12px] text-muted">
      <span>{label}</span>
      <div className="flex rounded-md border border-border p-0.5">
        {options.map((o) => (
          <button key={o.value} type="button" onClick={() => onChange(o.value)} className={`rounded px-2 py-0.5 transition-colors ${o.value === value ? "bg-panel-2 text-fg" : "text-muted hover:text-fg"}`}>{o.label}</button>
        ))}
      </div>
    </div>
  )
}

const px = (n: number) => `${n.toFixed(1)}px`

function SpacingCard({ sp, chosen, onChoose }: { sp: Spacing; chosen: boolean; onChoose: () => void }) {
  const icon = "flex h-7 w-7 items-center justify-center rounded-lg text-muted"
  const [left, right, toCaret, edge] = sp.ink
  return (
    // A div, not a button: the card holds the candidate's own buttons.
    <div
      role="button"
      tabIndex={0}
      data-spacing-card={sp.id}
      aria-pressed={chosen}
      onClick={onChoose}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return
        e.preventDefault()
        onChoose()
      }}
      className={`flex cursor-pointer flex-col items-stretch rounded-xl border p-4 text-left outline-none transition-colors focus-visible:border-accent ${chosen ? "border-accent bg-panel" : "border-border hover:border-border-strong"}`}
    >
      <span className="flex h-[22px] items-baseline gap-2">
        <span className="font-mono text-[12px] text-muted-80">{sp.id}</span>
        <span className="text-[13px] font-medium text-fg/90">{sp.name}</span>
        {chosen && <span className="ml-auto rounded border border-accent/40 bg-accent/10 px-1.5 py-px text-[10.5px] font-medium text-accent">On the cards below</span>}
      </span>
      <span data-big className="mt-3 flex h-[108px] items-center justify-center rounded-lg border border-border bg-bg">
        <span style={{ zoom: 3 }}><SendButton armed spacing={sp} /></span>
      </span>
      {/* At its real size: dim on the left, and white on the right behind the rail's own icons —
          right-anchored, as it is in the prompt box. */}
      <span data-real className="mt-2 flex items-center justify-between rounded-lg border border-border bg-bg px-3 py-2">
        <SendButton armed={false} spacing={sp} />
        <span className="flex items-center">
          <span className={`${icon} -mr-0.5`}><Paperclip size={15} strokeWidth={2} /></span>
          <span className={`${icon} mr-1.5`}><Mic size={15} strokeWidth={2} /></span>
          <SendButton armed spacing={sp} />
        </span>
      </span>
      <span className="mt-3 text-[12px] leading-[17px] text-muted">{sp.says}</span>
      <span className="mt-2 font-mono text-[11px] leading-[16px] text-muted-80">
        {toCaret === null
          ? <>edge {px(left)} Send {px(right)} ⌄ {px(edge)} edge</>
          : <>edge {px(left)} Send {px(right)} | {px(toCaret)} ⌄ {px(edge)} edge</>}
      </span>
    </div>
  )
}

const MODES: { name: string; working: string; rest: string; key: string; today: string }[] = [
  {
    name: "Send as steer",
    working: "Goes to the agent at once. It reads the message at its next step and keeps going.",
    rest: "Sends now and wakes the agent.",
    key: "⏎ while its row is ticked",
    today: "What Enter does today for typed text. New for answers, which today wait for the agent to rest.",
  },
  {
    name: "Send to queue",
    working: "Frizz holds it. When the agent comes to rest, Frizz sends everything queued as its next turn. Until then a queued message can be sent now or taken back.",
    rest: "The same as a steer.",
    key: "⏎ while its row is ticked",
    today: "New for typed text: nothing holds a human message until rest today. It is how answers already travel.",
  },
  {
    name: "Send as force steer",
    working: "Interrupts the turn, and the agent reads the message now. Claude threads only.",
    rest: "The same as a steer.",
    key: "⏎ while its row is ticked; ⌘⏎ always",
    today: "Exists today as ⌘⏎, and as the ↑ beside a waiting message. It has no button in the prompt box.",
  },
]

const OPEN_POINTS: string[] = [
  "The button always reads Send. With the menu shut, the ticked row shows in the placeholder (while no answer is staged) and in the button's hover title, and nowhere else.",
  "The ticked row is per thread and goes back to Send as steer when the agent comes to rest. A thread left on the queue then cannot hold back a message days later, and one left on force steer cannot interrupt a later turn by surprise.",
  "⌘⏎ stays the forced send whichever row is ticked. The queue has no key of its own: ⌥⏎ and ⇧⏎ are both a new line today.",
  "The fenced and native question cards lose their Send answers button under the same rule; only registered questions are drawn here.",
  "The phone is not drawn. It answers in a sheet with its own Send, and its bar has no room for a word and a caret.",
  "A Codex thread steers natively, so the steer and queue rows both work there. An ACP agent cannot be steered: it only queues, so its menu would have one row. Force steer exists on Claude threads only.",
]

function Page() {
  const [theme, setTheme] = useState(document.documentElement.dataset.theme ?? "dark")
  const [spacingId, setSpacingId] = useState(() => SPACINGS.find((x) => x.id === params.get("spacing")?.toUpperCase())?.id ?? DEFAULT_SPACING)
  useEffect(() => { document.documentElement.dataset.theme = theme }, [theme])
  const spacing = SPACINGS.find((x) => x.id === spacingId)!
  return (
    <SpacingContext.Provider value={spacing}>
    <main className="min-h-screen bg-bg pb-24 text-fg">
      <header className="mx-auto max-w-[1480px] px-8 pb-6 pt-9">
        <h1 className="text-[22px] font-semibold tracking-tight">One send for answers and a steer</h1>
        <div className="mt-2 max-w-[860px] space-y-2 text-[13px] leading-[20px] text-muted">
          <p>Today the question cards have their own Send answers button, and it reads only the cards. A note typed in the prompt box is a second send. This sheet drops that button: the prompt box's send button sends the staged answers and whatever is typed, together, as one turn.</p>
          <p>The send button becomes a white button that always says Send, with a caret. The caret opens the three ways to send: as a steer, to the queue, or as a force steer. The button turns white when there is text in the box or an answer on any card.</p>
          <p>Every card below is live. Pick answers, type, press the button, open the caret. Nothing is sent anywhere.</p>
        </div>
      </header>
      <nav className="sticky top-0 z-50 border-y border-border bg-bg/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1480px] flex-wrap items-center gap-x-6 gap-y-2 px-8 py-2.5">
          <Seg label="Theme" value={theme} onChange={setTheme} options={[{ value: "dark", label: "Dark" }, { value: "light", label: "Light" }]} />
        </div>
      </nav>
      <div className="mx-auto max-w-[1480px] px-8 pt-10">
        <section data-spacings>
          <h2 className="text-[16px] font-semibold tracking-tight">The button's spacing, eight ways</h2>
          <p className="mb-4 mt-1 max-w-[860px] text-[12.5px] leading-[18px] text-muted">Each is drawn at three times its size, then at its real size on the rail, white and dim. The last line is what it paints, measured from pixels: the gap from the button's left edge to the word, from the word to the divider, from the divider to the chevron, and from the chevron to the right edge. Click one to put it on every card below.</p>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4">
            {SPACINGS.map((sp) => <SpacingCard key={sp.id} sp={sp} chosen={sp.id === spacingId} onChoose={() => setSpacingId(sp.id)} />)}
          </div>
        </section>

        <section className="mt-14">
          <h2 className="mb-5 text-[16px] font-semibold tracking-tight">In the queue card</h2>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(680px,1fr))] gap-x-10 gap-y-12">
            {SCENES.map((scene, i) => (
              <div key={scene.id} className="min-w-0">
                <div className="mb-1 flex items-baseline gap-2">
                  <span className="font-mono text-[12px] text-muted-80">{i + 1}</span>
                  <h3 className="text-[13.5px] font-medium text-fg/90">{scene.title}</h3>
                </div>
                <p className="mb-3 max-w-[680px] text-[12px] leading-[18px] text-muted-80">{scene.note}</p>
                <Frame scene={scene} />
              </div>
            ))}
          </div>
        </section>

        <section className="mt-16 max-w-[1180px]">
          <h2 className="mb-3 text-[16px] font-semibold tracking-tight">What each row does</h2>
          <table className="w-full border-collapse text-[12.5px] leading-[18px]">
            <thead>
              <tr className="border-b border-border text-left text-muted">
                <th className="w-[150px] py-2 pr-4 font-medium" />
                <th className="py-2 pr-6 font-medium">While the agent works</th>
                <th className="w-[170px] py-2 pr-6 font-medium">While it rests</th>
                <th className="w-[190px] py-2 pr-6 font-medium">Key</th>
                <th className="py-2 font-medium">Against today</th>
              </tr>
            </thead>
            <tbody>
              {MODES.map((m) => (
                <tr key={m.name} className="border-b border-border/60 align-top">
                  <td className="py-2 pr-4 font-medium">{m.name}</td>
                  <td className="py-2 pr-6">{m.working}</td>
                  <td className="py-2 pr-6 text-muted">{m.rest}</td>
                  <td className="py-2 pr-6 text-muted">{m.key}</td>
                  <td className="py-2 text-muted">{m.today}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="mt-12 max-w-[860px]">
          <h2 className="mb-3 text-[16px] font-semibold tracking-tight">Calls made in this draft, and what it leaves out</h2>
          <ul className="list-disc space-y-1.5 pl-4 text-[12.5px] leading-[18px] text-muted">
            {OPEN_POINTS.map((p) => <li key={p}>{p}</li>)}
          </ul>
        </section>
      </div>
    </main>
    </SpacingContext.Provider>
  )
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    <TooltipProvider>
      <Page />
    </TooltipProvider>
  </QueryClientProvider>,
)
