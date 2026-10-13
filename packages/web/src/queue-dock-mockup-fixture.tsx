import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import { Fragment, useEffect, useId, useLayoutEffect, useReducer, useRef, useState, type ComponentType, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from "react"
import {
  AlarmClock, AlarmClockOff, ArrowUp, Check, ChevronDown, ChevronUp, ChevronsDownUp, ExternalLink, FileText, GitPullRequest,
  Maximize2, MessageSquare, MessageSquarePlus, Paperclip, Pencil, RefreshCw, RotateCcw, Trash2,
} from "lucide-react"
import type { ChatMessage } from "./hooks.ts"
import { Message, withMessageSpacers } from "./components/ChatView.tsx"
import { VSpace } from "./components/rhythm.tsx"
import { STATUS_BOX } from "./components/BoxSpinner.tsx"
import { Tooltip, TooltipProvider } from "./components/Tooltip.tsx"
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "./components/ui/Menu.tsx"
import { GoalMark } from "./components/RecurringPromptControl.tsx"
import { HEADER_ICON_CLASS } from "./lib/headerIcon.ts"
import { OPAQUE_PORTAL_SURFACE_CLASS } from "./lib/overlaySurface.ts"
import { formatSnoozeWake, SNOOZE_PRESETS, snoozePresetInstant } from "./lib/snooze.ts"
import { CHILD_ARROW, CHILD_ARROW_CLASS, CHILD_KIND_TAG_CLASS, CHILD_MARK_SLOT_CLASS } from "./lib/childOps.ts"
import {
  boxesOf, fullText, HIGHLIGHT_CSS, inUi, MESSAGES, offsetsToRange, paints, rangeToOffsets, repaint, S2, S3, trimmed,
  wireText, type Box, type PaintKind, type Seed,
} from "./inline-comments-mockup-kit.ts"
import "./styles.css"

// MOCKUP SHEET — THE QUEUE CARD: MANAGE THE THREAD AT THE TOP, STEER THE RUN AT THE BOTTOM.
//
// Not shipped UI and not a test. Round three of the queue-card study (maintainer 2026-10-01):
//   · round two docked the prompt box to the bottom of the screen and moved Snooze and Mark as done into
//     the sticky header — kept;
//   · simplify those two to icons: Snooze becomes an ALARM CLOCK whose click opens a menu of durations
//     (no remembered "last picked" preset — the sticky one is disliked), Mark as done becomes a CHECK;
//   · the goal moves to the prompt box's bottom right;
//   · the context meter moves up into the header: "Last active 2m ago · 64% context";
//   · the rule, loosely: whole-thread management on top, this run and how to steer it at the bottom.
//
// The transcript is the REAL Message renderer; the menus, tooltips and goal mark are the real
// components (ui/Menu, Tooltip, GoalMark) and lib/snooze.ts's presets. The header, prompt box and op
// rows are copies of TodosView's QueueCard / Composer / ChildOpRow. Comment highlights use the shared
// kit's Highlight API engine.
//
//   http://localhost:5478/queue-dock-mockup-fixture.html   (?theme=light for the light palette)
const params = new URLSearchParams(location.search)
document.documentElement.dataset.font = "sans"
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark"

const SHEET_CSS = `
:root { --ic-ink: var(--color-accent); --dock-shade: rgb(0 0 0 / 0.75); }
:root[data-theme="light"] { --ic-ink: #9a6a00; --dock-shade: rgb(0 0 0 / 0.14); }
`

// ── the cards ─────────────────────────────────────────────────────────────────────────────────────

type ActivityKind = "agent" | "shell" | "pr" | "file" | "link"
interface Activity { kind: ActivityKind; label: string; age?: string; live?: boolean; target?: string }

interface CardData {
  id: string
  title: string
  sub: string
  messages: ChatMessage[]
  activity: Activity[]
  context: number
  goal?: string
  retry?: boolean
  restart?: boolean
  snoozedUntil?: string
  done?: boolean
}

const text = (sourceId: string, role: "user" | "assistant", body: string): ChatMessage => ({ sourceId, role, tools: [], text: body, parts: role === "user" ? [] : [{ kind: "text", text: body }] })

const CACHE: CardData = {
  id: "cache",
  title: "Fix the cache collision in the resolver",
  sub: "Last active 2m ago",
  messages: MESSAGES,
  context: 64,
  activity: [
    { kind: "agent", label: "Audit the other caches for the same collision", age: "4m", live: true },
    { kind: "shell", label: "Watch the resolver tests", age: "12m", live: true },
    { kind: "shell", label: "Run the dev server", age: "25m", live: true },
    { kind: "pr", label: "acme/app#391 — checks running", age: "6m", live: true },
    { kind: "file", label: "Resolver audit report" },
    { kind: "link", label: "Cache key migration plan", target: "docs.acme.dev/cache-keys" },
  ],
}

const PRICING: CardData = {
  id: "pricing",
  title: "Refactor the pricing parser",
  sub: "Last active 23m ago",
  retry: true,
  context: 31,
  goal: "Keep going until the tier-boundary audit is folded in",
  messages: [
    text("p1", "user", "Refactor the pricing parser and verify it end-to-end."),
    {
      sourceId: "p2",
      role: "assistant",
      text: "",
      tools: [],
      parts: [
        { kind: "tools", tools: [{ name: "Read", detail: "src/pricing/parser.ts" }, { name: "Bash", detail: "nub run dev", desc: "Start the dev server" }] },
        { kind: "text", text: "Audit dispatched and the dev server is up. I'll fold the findings in when the sub-agent reports back." },
      ],
    },
  ],
  activity: [{ kind: "agent", label: "Audit the pricing parser for tier-boundary rounding", age: "24m", live: true }],
}

const RELEASE: CardData = {
  id: "release",
  title: "Watch the release build",
  sub: "Last active 23m ago",
  context: 12,
  messages: [
    text("r1", "user", "Kick off the release build and keep an eye on it."),
    {
      sourceId: "r2",
      role: "assistant",
      text: "",
      tools: [],
      parts: [
        { kind: "tools", tools: [{ name: "Bash", detail: "nub run release", desc: "Run the release build" }] },
        { kind: "text", text: "Build is running in the background. Nothing to decide yet." },
      ],
    },
  ],
  activity: [{ kind: "shell", label: "Watch the release build", age: "23m", live: true }],
}

const CARDS = [CACHE, PRICING, RELEASE]

// ── small marks ───────────────────────────────────────────────────────────────────────────────────

// ContextMeter's ring: same 16-unit grid, same 1.25 stroke, a filled arc for the share used.
function ContextRing({ percent, size = 15 }: { percent: number; size?: number }) {
  const r = 7.5 - 1.25 / 2
  const c = 2 * Math.PI * r
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden className="shrink-0">
      <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeOpacity="0.3" strokeWidth="1.25" />
      <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeWidth="1.25" strokeDasharray={`${(c * percent) / 100} ${c}`} transform="rotate(-90 8 8)" />
    </svg>
  )
}

function ActivityMark({ kind, live }: { kind: ActivityKind; live?: boolean }) {
  if (kind === "file") return <FileText size={11} className="text-muted-55" />
  if (kind === "link") return <ExternalLink size={11} className="text-muted-55" />
  if (kind === "pr") return <GitPullRequest size={11} className="text-watch" />
  return <span className={`block h-1.5 w-1.5 rounded-full ${kind === "agent" ? "bg-accent" : "bg-shell"} ${live ? "animate-pulse" : ""}`} />
}

const TAG: Record<ActivityKind, string> = { agent: "Agent", shell: "Shell", pr: "PR", file: "File", link: "Link" }

// One ⤷ row, in the ChildOpRow grammar (the real lib/childOps.ts tokens).
function OpRow({ a }: { a: Activity }) {
  return (
    <div className="flex min-w-0 items-baseline gap-1.5 text-[11.5px] leading-[17.25px]">
      <span aria-hidden className={CHILD_ARROW_CLASS}>{CHILD_ARROW}</span>
      <span className={`${CHILD_MARK_SLOT_CLASS} self-center`}><ActivityMark kind={a.kind} live={a.live} /></span>
      <span className={CHILD_KIND_TAG_CLASS}>{TAG[a.kind]}</span>
      <span className="min-w-0 flex-1 truncate text-muted-70">{a.label}</span>
      {a.target && <span className="max-w-[40%] truncate font-mono-keep text-[10px] text-muted-45">{a.target}</span>}
      {a.age && <span className="shrink-0 tabular-nums text-[10.5px] text-muted-45">{a.age}</span>}
    </div>
  )
}

function summarize(items: readonly Activity[]) {
  const order: ActivityKind[] = ["agent", "shell", "pr", "file", "link"]
  const words: Record<ActivityKind, [string, string]> = { agent: ["agent", "agents"], shell: ["shell", "shells"], pr: ["PR", "PRs"], file: ["file", "files"], link: ["link", "links"] }
  return order
    .map((kind) => ({ kind, n: items.filter((a) => a.kind === kind).length, live: items.some((a) => a.kind === kind && a.live) }))
    .filter((g) => g.n > 0)
    .map((g) => ({ ...g, word: words[g.kind][g.n === 1 ? 0 : 1] }))
}

// A hover surface that stays up while the pointer travels from its trigger into it.
function useHover(delay = 160) {
  const [open, setOpen] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  return {
    open,
    handlers: {
      onMouseEnter: () => { clearTimeout(timer.current); setOpen(true) },
      onMouseLeave: () => { timer.current = setTimeout(() => setOpen(false), delay) },
    },
  }
}

// THE CONDENSED ACTIVITY: one line of counts at the prompt box's upper right; the ⤷ rows on hover.
function ActivitySummary({ items, forceOpen }: { items: readonly Activity[]; forceOpen?: boolean }) {
  const hover = useHover()
  if (!items.length) return null
  const show = forceOpen || hover.open
  return (
    <div data-ic-ui className="relative" {...hover.handlers}>
      <button type="button" className={`flex items-center gap-3 rounded-md px-1.5 py-0.5 text-[11.5px] transition-colors ${show ? "bg-panel-2 text-fg/85" : "text-muted-70 hover:bg-panel-2 hover:text-fg/85"}`}>
        {summarize(items).map((g) => (
          <span key={g.kind} className="flex items-center gap-1.5 whitespace-nowrap">
            <span className="flex w-[11px] justify-center"><ActivityMark kind={g.kind} live={g.live} /></span>
            <span><span className="tabular-nums text-fg/85">{g.n}</span> {g.word}</span>
          </span>
        ))}
      </button>
      {show && (
        <div className="absolute bottom-full right-0 z-40 mb-1.5 w-[420px] rounded-lg border border-border bg-elevated px-3 py-2 shadow-xl shadow-black/40">
          <div className="flex flex-col gap-0.5">
            {(["agent", "shell", "pr", "file", "link"] as const).flatMap((k) => items.filter((a) => a.kind === k)).map((a, i) => <OpRow key={i} a={a} />)}
          </div>
          <div className="mt-1.5 border-t border-border/70 pt-1.5 text-[10.5px] text-muted-55">Click a row to open it · × on hover stops or clears it</div>
        </div>
      )}
    </div>
  )
}

function PendingChip({ n, onNav }: { n: number; onNav: (dir: 1 | -1) => void }) {
  if (n === 0) return null
  return (
    <span data-ic-ui className="flex items-center text-[11.5px] text-[var(--ic-ink)]">
      <button type="button" title="Show the next pending comment" onClick={() => onNav(1)} className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 hover:bg-panel-2">
        <MessageSquare size={11.5} className="translate-y-px" />
        <span><span className="font-medium tabular-nums">{n}</span> pending comment{n === 1 ? "" : "s"}</span>
      </button>
      <button type="button" title="Previous comment" onClick={() => onNav(-1)} className="flex h-5 w-5 items-center justify-center rounded text-muted-60 hover:bg-panel-2 hover:text-fg"><ChevronUp size={12} /></button>
      <button type="button" title="Next comment" onClick={() => onNav(1)} className="flex h-5 w-5 items-center justify-center rounded text-muted-60 hover:bg-panel-2 hover:text-fg"><ChevronDown size={12} /></button>
    </span>
  )
}

// ── the top bar: the thread as a whole ────────────────────────────────────────────────────────────

const WINDOW = 200_000

// The forced states the static frames pin open; the live queue reaches every one of them by pointer.
interface Force { tip?: "alarm" | "check" | "restart"; menu?: boolean; context?: boolean; goal?: boolean; activity?: boolean }

// The real Tooltip's surface and arrow, pinned open for a static frame.
function TipBubble({ label, align = "center" }: { label: string; align?: "center" | "end" }) {
  return (
    <span className={`pointer-events-none absolute bottom-full z-40 mb-[5px] whitespace-nowrap rounded-md border border-border bg-elevated px-3 py-2 text-[11px] leading-relaxed text-fg shadow-md shadow-shadow-ink/40 ${align === "end" ? "-right-1" : "left-1/2 -translate-x-1/2"}`}>
      {label}
      <svg width="10" height="5" viewBox="0 0 10 5" aria-hidden className={`absolute top-full fill-elevated ${align === "end" ? "right-[13px]" : "left-1/2 -translate-x-1/2"}`}><polygon points="0,0 10,0 5,5" /></svg>
    </span>
  )
}

// lib/headerIcon.ts's square, with its resting ink swapped when the mark carries a state.
function iconClass(tone?: string, pressed?: boolean) {
  const base = tone ? HEADER_ICON_CLASS.replace(/(^| )text-muted( |$)/, `$1${tone}$2`) : HEADER_ICON_CLASS
  return `${base} ${pressed ? "bg-panel-2" : ""}`
}

function HeaderIcon({ label, icon: Icon, size = 14, forceTip, tipAlign, onClick }: { label: string; icon: ComponentType<{ size?: number; strokeWidth?: number }>; size?: number; forceTip?: boolean; tipAlign?: "center" | "end"; onClick?: () => void }) {
  const button = (
    <button type="button" aria-label={label} onMouseDown={(e) => e.preventDefault()} onClick={onClick} className={iconClass()}>
      <Icon size={size} strokeWidth={2} />
    </button>
  )
  if (forceTip) return <span className="relative flex">{button}<TipBubble label={label} align={tipAlign} /></span>
  return <Tooltip label={label}>{button}</Tooltip>
}

// THE SNOOZE MENU: every preset, every time, each with the moment it would wake. No remembered choice —
// today's split button relabels itself to whatever was picked last ("Snooze 1d", "Snooze until
// tomorrow"), so the one-click half silently changes meaning between visits.
function snoozeRows() {
  return SNOOZE_PRESETS.map((p) => {
    const wake = formatSnoozeWake(snoozePresetInstant(p.value))
    return p.value === "tomorrow" ? { value: p.value, label: "Tomorrow", wake: wake.replace(/^Tomorrow at /, "") } : { value: p.value, label: p.label, wake }
  })
}
const MENU_ITEM = "flex cursor-pointer select-none items-center gap-2 rounded-md px-2.5 py-1.5 text-[12px] outline-none transition-colors"

function SnoozeMenuBody({ snoozedUntil, onPick, onWake, Item, Separator, hot }: {
  snoozedUntil?: string
  onPick: (until: string) => void
  onWake: () => void
  Item: (p: { children: ReactNode; onSelect: () => void; icon?: ReactNode; hot?: boolean }) => ReactNode
  Separator: () => ReactNode
  hot?: string
}) {
  return (
    <>
      <div className="px-2.5 pb-1 pt-1.5 text-[11px] text-muted-60">{snoozedUntil ? `Snoozed until ${formatSnoozeWake(snoozedUntil)}` : "Snooze until"}</div>
      {snoozedUntil && (
        <>
          <Item onSelect={onWake} icon={<AlarmClockOff size={12} />} hot={hot === "wake"}>Wake now</Item>
          <Separator />
        </>
      )}
      {snoozeRows().map((r) => (
        <Item key={r.value} onSelect={() => onPick(snoozePresetInstant(r.value))} icon={<AlarmClock size={12} />} hot={hot === r.value}>
          <span className="flex min-w-0 flex-1 items-center justify-between gap-6">
            <span>{r.label}</span>
            <span className="text-[10.5px] text-muted-55">{r.wake}</span>
          </span>
        </Item>
      ))}
      <Separator />
      <Item onSelect={() => {}}>Custom time &amp; prompt…</Item>
    </>
  )
}

function StaticItem({ children, icon, hot }: { children: ReactNode; onSelect: () => void; icon?: ReactNode; hot?: boolean }) {
  return (
    <div className={`${MENU_ITEM} ${hot ? "bg-panel-2 text-fg" : "text-muted"}`}>
      {icon && <span className="flex w-3.5 shrink-0 items-center justify-center">{icon}</span>}
      {children}
    </div>
  )
}
const LiveItem = ({ children, onSelect, icon }: { children: ReactNode; onSelect: () => void; icon?: ReactNode }) => <MenuItem onSelect={onSelect} icon={icon}>{children}</MenuItem>
const StaticSeparator = () => <div className="my-1 h-px bg-border" />

function SnoozeControl({ snoozedUntil, force, onSnooze }: { snoozedUntil?: string; force?: Force; onSnooze: (until: string | undefined) => void }) {
  const [open, setOpen] = useState(false)
  const label = snoozedUntil ? `Snoozed until ${formatSnoozeWake(snoozedUntil)}` : "Snooze"
  // Amber while a snooze is armed — the goal mark's "something is set" tone — so the clock doubles as the
  // presence marker the footer's grey alarm glyph used to be.
  const tone = snoozedUntil ? "text-attention-90" : undefined
  if (force?.menu || force?.tip === "alarm") {
    return (
      <span className="relative flex">
        <span className={iconClass(tone, force.menu)}><AlarmClock size={14} strokeWidth={2} /></span>
        {force.tip === "alarm" && <TipBubble label={label} />}
        {force.menu && (
          <div className={`${OPAQUE_PORTAL_SURFACE_CLASS} absolute right-0 top-full mt-1.5 w-max min-w-[184px] overflow-hidden rounded-lg p-1`}>
            <SnoozeMenuBody snoozedUntil={snoozedUntil} onPick={() => {}} onWake={() => {}} Item={StaticItem} Separator={StaticSeparator} hot={snoozedUntil ? "wake" : "tomorrow"} />
          </div>
        )}
      </span>
    )
  }
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <Tooltip label={label} disabled={open}>
        <MenuTrigger asChild>
          <button type="button" aria-label={label} onMouseDown={(e) => e.preventDefault()} className={iconClass(tone, open)}>
            <AlarmClock size={14} strokeWidth={2} />
          </button>
        </MenuTrigger>
      </Tooltip>
      <MenuContent align="end">
        <SnoozeMenuBody snoozedUntil={snoozedUntil} onPick={(until) => onSnooze(until)} onWake={() => onSnooze(undefined)} Item={LiveItem} Separator={MenuSeparator} />
      </MenuContent>
    </Menu>
  )
}

// What a finished thread says where its two verbs were — ThreadLifecycleFooter's DoneReadout, moved up.
function DoneReadout({ onReopen }: { onReopen?: () => void }) {
  return (
    <Tooltip label="Marked done — send a message to reopen it">
      <button type="button" onClick={onReopen} className="flex h-7 items-center gap-1 rounded-md px-2 text-[12px] font-medium text-muted">
        <Check size={12} />Done
      </button>
    </Tooltip>
  )
}

type ContextLook = "ring" | "words" | "bare"

// THE CONTEXT READING, now a fact in the header's second line. Same popover as ContextMeter: the
// exact numbers, and Compact now.
function ContextReading({ percent, look = "ring", forceOpen }: { percent: number; look?: ContextLook; forceOpen?: boolean }) {
  const hover = useHover()
  const show = forceOpen || hover.open
  const tokens = Math.round((WINDOW * percent) / 100)
  return (
    <span className="relative flex shrink-0 items-center" {...hover.handlers}>
      <button type="button" aria-label={`Context ${percent}% full`} className={`flex items-center gap-1 rounded transition-colors ${show ? "text-fg/85" : "hover:text-fg/85"}`}>
        {look !== "words" && <ContextRing percent={percent} size={11} />}
        {look === "ring" && <span>{percent}% context</span>}
        {look === "words" && <span>Context {percent}%</span>}
      </button>
      {show && (
        <div className="absolute left-[-12px] top-full z-40 mt-2 flex w-max flex-col gap-2 rounded-lg border border-border bg-elevated px-3 py-2 text-[11px] leading-relaxed text-fg shadow-xl shadow-black/40">
          <div className="flex flex-col">
            <span>Context {percent}% full</span>
            <span className="text-muted">{tokens.toLocaleString()} of {WINDOW.toLocaleString()} tokens</span>
          </div>
          <span className="flex items-center justify-center rounded-md border border-border-strong bg-panel-2/60 px-2.5 py-1 text-[12px] font-medium text-fg/80">Compact now</span>
        </div>
      )}
    </span>
  )
}

// ── the bottom: this run, and how to steer it ─────────────────────────────────────────────────────

function ProfileChips() {
  const chip = "inline-flex items-center gap-[3px] rounded-md border border-border/50 px-2 py-1 text-muted"
  return (
    <>
      <span className={chip}><span className="petite-caps text-[11px] tracking-wide">Opus 5 › high</span><ChevronDown size={12} className="text-fg/65" /></span>
      <span className={`${chip} opacity-70`}><span className="petite-caps text-[11px] tracking-wide">Auto</span><ChevronDown size={12} className="text-fg/65" /></span>
    </>
  )
}

// THE GOAL, beside attach and send: a standing message is something you send. Grey while unset, amber
// while armed (RecurringPromptControl's two tones); the hover preview is that control's GoalPreview.
function GoalButton({ goal, forceOpen }: { goal?: string; forceOpen?: boolean }) {
  const hover = useHover()
  const show = forceOpen || hover.open
  return (
    <span className="relative flex" {...hover.handlers}>
      <button type="button" aria-label={goal ? "Goal (on)" : "Goal"} className={`flex h-7 w-7 items-center justify-center rounded-lg transition-colors hover:bg-panel-2 ${goal ? "text-attention-90" : "text-muted hover:text-fg"}`}>
        <GoalMark size={15} />
      </button>
      {show && (
        <div className="absolute bottom-full right-0 z-40 mb-1.5 w-[300px] rounded-lg border border-border bg-elevated p-2.5 text-[11px] leading-snug text-fg shadow-xl shadow-black/40">
          <div className="mb-1 flex items-baseline gap-2">
            <span className="font-medium">Goal</span>
            <span className="text-muted-70">{goal ? "sent at every rest" : "not set"}</span>
          </div>
          <p className={`line-clamp-4 whitespace-pre-wrap ${goal ? "text-fg/90" : "text-muted"}`}>{goal || "Click to write what this thread is trying to achieve."}</p>
        </div>
      )}
    </span>
  )
}

interface PromptBoxProps {
  value: string
  onChange: (v: string) => void
  onSend: () => void
  placeholder: string
  goal?: string | false
  goalOpen?: boolean
  sendCount?: number
}
function PromptBox({ value, onChange, onSend, placeholder, goal, goalOpen, sendCount = 0 }: PromptBoxProps) {
  const enabled = Boolean(value.trim()) || sendCount > 0
  return (
    <div className="group relative rounded-xl border border-border bg-bg transition-colors focus-within:border-accent">
      <textarea
        value={value}
        rows={2}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
            e.preventDefault()
            onSend()
          }
        }}
        className="block w-full resize-none bg-transparent px-3.5 pb-1 pt-2.5 text-[13px] leading-relaxed text-fg outline-none placeholder:text-muted"
      />
      <div className="flex min-w-0 items-center gap-1 pb-1.5 pl-1.5 pr-2">
        <ProfileChips />
        {/* Paperclip → send is today's gap-2, which draws 14.75px of ink against the filled button. The
            target's box overlaps the paperclip's by 1px (-mr-[9px]) so target → paperclip draws the
            same 14.75px: their glyphs carry 7 and 8.25px of dead box between them. Only one hover square
            fills at a time, and the overlap is empty padding on both sides. */}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {goal !== false && <span className="-mr-[9px] flex"><GoalButton goal={goal} forceOpen={goalOpen} /></span>}
          <span data-attach className="flex h-7 w-7 items-center justify-center rounded-lg text-muted"><Paperclip size={15} strokeWidth={2} /></span>
          <button
            type="button"
            title={sendCount ? `Send with ${sendCount} comment${sendCount === 1 ? "" : "s"}` : "Send"}
            onClick={onSend}
            className={`flex h-7 w-7 items-center justify-center rounded-lg transition-all ${enabled ? "bg-fg text-bg hover:opacity-90 active:scale-95" : "bg-panel-2 text-muted"}`}
          >
            <ArrowUp size={14} strokeWidth={2.5} />
          </button>
        </span>
      </div>
    </div>
  )
}

// ── comments: a light yellow highlight, the words in a hover popover ────────────────────────────────

interface LayerComment { id: string; start: number; end: number; quote: string; text: string; status: "draft" | "pending" | "sent"; prevText?: string; fresh?: boolean }
interface SentNote { id: string; note: string; items: { id: string; quote: string; text: string }[] }
let seq = 0
const nextId = () => `q${++seq}`

interface LayerOptions { seeds?: Seed[]; openSeed?: number; selectQuote?: string; draft?: Seed }

function useCommentLayer(rootRef: RefObject<HTMLDivElement | null>, scrollerRef: RefObject<HTMLDivElement | null>, opts: LayerOptions) {
  const key = useId()
  const [comments, setComments] = useState<LayerComment[]>([])
  const [sent, setSent] = useState<SentNote[]>([])
  const [geo, setGeo] = useState<{ boxes: Record<string, Box[]>; sel: Box[]; w: number }>({ boxes: {}, sel: [], w: 0 })
  const [openId, setOpenId] = useState<string | null>(null)
  const [pinned, setPinned] = useState(false)
  const [toolbar, setToolbar] = useState<{ start: number; end: number; fake?: boolean } | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const seeded = useRef(false)
  const [, bump] = useReducer((x: number) => x + 1, 0)

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root || seeded.current) return
    seeded.current = true
    const all = fullText(root)
    const made: LayerComment[] = []
    for (const s of [...(opts.seeds ?? []), ...(opts.draft ? [opts.draft] : [])]) {
      const at = all.indexOf(s.quote)
      if (at < 0) continue
      const draft = s === opts.draft
      made.push({ id: nextId(), start: at, end: at + s.quote.length, quote: s.quote, text: draft ? "" : s.text, prevText: undefined, status: draft ? "draft" : "pending" })
    }
    setComments(made)
    const draft = made.find((c) => c.status === "draft")
    if (draft) { setOpenId(draft.id); setPinned(true) }
    else if (opts.openSeed !== undefined && made[opts.openSeed]) { setOpenId(made[opts.openSeed].id); setPinned(true) }
    if (opts.selectQuote) {
      const at = all.indexOf(opts.selectQuote)
      if (at >= 0) setToolbar({ start: at, end: at + opts.selectQuote.length, fake: true })
    }
  }, [])

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const ro = new ResizeObserver(() => bump())
    ro.observe(root)
    void document.fonts.ready.then(() => bump())
    return () => {
      ro.disconnect()
      paints.delete(key)
      repaint()
    }
  }, [key])

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const boxes: Record<string, Box[]> = {}
    const paint: Partial<Record<PaintKind, Range[]>> = {}
    for (const c of comments) {
      const r = offsetsToRange(root, c.start, c.end)
      if (!r) continue
      boxes[c.id] = boxesOf(root, r)
      const kind: PaintKind = c.status === "sent" ? (c.id === openId ? "soft" : "sent") : c.status === "draft" || c.id === openId ? "soft-active" : "soft"
      ;(paint[kind] ??= []).push(r)
    }
    let sel: Box[] = []
    if (toolbar) {
      const r = offsetsToRange(root, toolbar.start, toolbar.end)
      if (r) {
        sel = boxesOf(root, r)
        if (toolbar.fake) (paint.fakesel ??= []).push(r)
      }
    }
    paints.set(key, paint)
    repaint()
    const next = { boxes, sel, w: root.clientWidth }
    setGeo((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
  })

  useEffect(() => {
    const onSelection = () => {
      const root = rootRef.current
      const s = window.getSelection()
      if (!root) return
      if (!s || s.isCollapsed || !s.rangeCount) return setToolbar((t) => (t && !t.fake ? null : t))
      const r = s.getRangeAt(0)
      if (!root.contains(r.commonAncestorContainer) || inUi(r.startContainer) || inUi(r.endContainer)) return setToolbar((t) => (t && !t.fake ? null : t))
      const offs = rangeToOffsets(root, r)
      if (!offs) return
      const [start, end] = trimmed(root, offs)
      if (end > start) setToolbar({ start, end })
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && pinned) { setPinned(false); setOpenId(null); return }
      if (e.key.toLowerCase() !== "i" || !(e.metaKey || e.ctrlKey)) return
      const root = rootRef.current
      const s = window.getSelection()
      if (!root || !s || s.isCollapsed || !s.rangeCount || !root.contains(s.getRangeAt(0).commonAncestorContainer)) return
      e.preventDefault()
      const offs = rangeToOffsets(root, s.getRangeAt(0))
      if (offs) createDraft(...trimmed(root, offs))
    }
    document.addEventListener("selectionchange", onSelection)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("selectionchange", onSelection)
      document.removeEventListener("keydown", onKey)
    }
  })

  function createDraft(start: number, end: number) {
    const root = rootRef.current
    if (!root) return
    const quote = fullText(root).slice(start, end).replace(/\s+/g, " ")
    const id = nextId()
    setComments((cs) => [...cs.filter((c) => c.status !== "draft" || c.prevText !== undefined), { id, start, end, quote, text: "", status: "draft", fresh: true }])
    setOpenId(id)
    setPinned(true)
    setToolbar(null)
    window.getSelection()?.removeAllRanges()
  }

  const pending = comments.filter((c) => c.status === "pending").sort((a, b) => a.start - b.start)

  function hit(e: ReactMouseEvent): string | null {
    const root = rootRef.current
    if (!root) return null
    const o = root.getBoundingClientRect()
    const x = e.clientX - o.left
    const y = e.clientY - o.top
    for (const c of comments) {
      if (c.status === "draft") continue
      if (geo.boxes[c.id]?.some((b) => x >= b.left - 1 && x <= b.left + b.width + 1 && y >= b.top - 1 && y <= b.top + b.height + 1)) return c.id
    }
    return null
  }
  const cancelClose = () => clearTimeout(closeTimer.current)
  const scheduleClose = () => {
    clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => setOpenId((id) => (pinned ? id : null)), 180)
  }

  function reveal(id: string) {
    const root = rootRef.current
    const sc = scrollerRef.current
    const b = geo.boxes[id]?.[0]
    if (!root || !sc || !b) return
    const top = root.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop + b.top - sc.clientHeight * 0.35
    sc.scrollTo({ top, behavior: "smooth" })
  }

  function nav(dir: 1 | -1) {
    if (!pending.length) return
    const at = pending.findIndex((c) => c.id === openId)
    const next = pending[at < 0 ? (dir > 0 ? 0 : pending.length - 1) : (at + dir + pending.length) % pending.length]
    setOpenId(next.id)
    setPinned(true)
    reveal(next.id)
  }

  function send(note: string) {
    if (!note.trim() && !pending.length) return false
    const id = nextId()
    const ids = new Set(pending.map((c) => c.id))
    setSent((s) => [...s, { id, note: note.trim(), items: pending.map((c) => ({ id: c.id, quote: c.quote, text: c.text })) }])
    setComments((cs) => cs.map((c) => (ids.has(c.id) ? { ...c, status: "sent" } : c)))
    setOpenId(null)
    setPinned(false)
    return true
  }

  const save = (id: string, t: string) => {
    setComments((cs) => cs.map((c) => (c.id === id ? { ...c, text: t, status: "pending", prevText: undefined, fresh: false } : c)))
    setPinned(false)
    setOpenId(null)
  }
  const cancel = (id: string) => {
    setComments((cs) => cs.flatMap((c) => (c.id !== id ? [c] : c.prevText !== undefined ? [{ ...c, status: "pending" as const, prevText: undefined }] : [])))
    setPinned(false)
    setOpenId(null)
  }

  const open = comments.find((c) => c.id === openId)
  const ob = open && geo.boxes[open.id]
  let popoverAbove = false
  if (ob?.length && rootRef.current && scrollerRef.current) {
    const r = rootRef.current.getBoundingClientRect()
    const last = ob[ob.length - 1]
    popoverAbove = r.top + last.top + last.height + 6 + 130 > scrollerRef.current.getBoundingClientRect().bottom - 190
  }
  const selBox = geo.sel.length
    ? { left: Math.min(...geo.sel.map((b) => b.left)), right: Math.max(...geo.sel.map((b) => b.left + b.width)), top: Math.min(...geo.sel.map((b) => b.top)) }
    : null

  const overlay = (
    <>
      {open && ob && ob.length > 0 && (
        <div
          data-ic-ui
          onMouseEnter={cancelClose}
          onMouseLeave={() => { if (!pinned) scheduleClose() }}
          className="absolute z-40 w-[320px] rounded-lg border border-border-strong bg-elevated px-3 py-2.5 shadow-xl shadow-black/40"
          style={{
            left: Math.max(0, Math.min(ob[0].left - 8, geo.w - 320)),
            // Under the passage, unless that would run into the docked prompt box: then above it.
            ...(popoverAbove ? { top: ob[0].top - 6, transform: "translateY(-100%)" } : { top: ob[ob.length - 1].top + ob[ob.length - 1].height + 6 }),
          }}
        >
          {open.status === "draft" ? (
            <Editor initial={open.prevText ?? open.text} editing={open.prevText !== undefined} focus={open.fresh} onSave={(t) => save(open.id, t)} onCancel={() => cancel(open.id)} />
          ) : (
            <>
              <div className="mb-1 flex h-5 items-center gap-1.5 text-[11px] text-muted-65">
                <MessageSquare size={11} className="translate-y-px text-[var(--ic-ink)]" />
                <span className="petite-caps tracking-wide">{open.status === "sent" ? "Sent" : "Pending · goes with your next send"}</span>
                {open.status === "pending" && (
                  <span className="ml-auto flex items-center">
                    <button type="button" title="Edit" onClick={() => { setComments((cs) => cs.map((c) => (c.id === open.id ? { ...c, status: "draft", prevText: c.text, fresh: true } : c))); setPinned(true) }} className="flex h-5 w-5 items-center justify-center rounded text-muted-60 hover:bg-panel-2 hover:text-fg"><Pencil size={11} /></button>
                    <button type="button" title="Delete" onClick={() => { setComments((cs) => cs.filter((c) => c.id !== open.id)); setOpenId(null); setPinned(false) }} className="flex h-5 w-5 items-center justify-center rounded text-muted-60 hover:bg-panel-2 hover:text-fg"><Trash2 size={11} /></button>
                  </span>
                )}
              </div>
              <div className="whitespace-pre-wrap text-[13px] leading-[19px] text-fg/90">{open.text}</div>
            </>
          )}
        </div>
      )}
      {toolbar && selBox && (
        <div data-ic-ui onMouseDown={(e) => e.preventDefault()} className="absolute z-30 flex items-center rounded-lg border border-border-strong bg-elevated p-0.5 shadow-lg shadow-black/40" style={{ left: Math.max(0, Math.min((selBox.left + selBox.right) / 2 - 62, geo.w - 128)), top: selBox.top - 38 }}>
          <button type="button" onClick={() => createDraft(toolbar.start, toolbar.end)} className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium text-fg/90 hover:bg-panel-2">
            <MessageSquarePlus size={13} />Comment<kbd className="ml-1 font-sans text-[10.5px] font-normal text-muted-60">⌘I</kbd>
          </button>
        </div>
      )}
    </>
  )

  return {
    pending,
    sent,
    overlay,
    nav,
    send,
    hovering: Boolean(openId && !pinned),
    rootHandlers: {
      onMouseMove: (e: ReactMouseEvent) => {
        const id = hit(e)
        if (id) {
          cancelClose()
          if (!pinned && id !== openId) setOpenId(id)
        } else if (openId && !pinned) scheduleClose()
      },
      onMouseLeave: () => { if (!pinned) scheduleClose() },
      onClick: (e: ReactMouseEvent) => {
        const s = window.getSelection()
        if ((s && !s.isCollapsed) || inUi(e.target as Node)) return
        const id = hit(e)
        if (id) { setOpenId(id); setPinned(true) }
        else if (pinned) { setPinned(false); setOpenId(null) }
      },
    },
  }
}

function Editor({ initial, editing, focus, onSave, onCancel }: { initial: string; editing?: boolean; focus?: boolean; onSave: (t: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { if (focus) ref.current?.focus({ preventScroll: true }) }, [focus])
  return (
    <div data-ic-ui>
      <textarea
        ref={ref}
        rows={2}
        value={value}
        placeholder="Comment on this passage…"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (value.trim()) onSave(value.trim()) }
          else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onCancel() }
        }}
        className="block w-full resize-none bg-transparent text-[13px] leading-[19px] text-fg outline-none placeholder:text-muted"
      />
      <div className="mt-2 flex items-center gap-1">
        <span className="mr-auto text-[10.5px] text-muted-55">⌘⏎ adds · Esc cancels</span>
        <button type="button" onClick={onCancel} className="rounded-md px-2 py-1 text-[12px] text-muted hover:bg-panel-2 hover:text-fg">Cancel</button>
        <button type="button" disabled={!value.trim()} onClick={() => onSave(value.trim())} className="rounded-md bg-fg px-2.5 py-1 text-[12px] font-medium text-bg hover:opacity-90 disabled:opacity-30">{editing ? "Save" : "Add comment"}</button>
      </div>
    </div>
  )
}

function SentBubble({ s }: { s: SentNote }) {
  return (
    <div className="flex max-w-[85%] flex-col items-end self-end">
      <div className="rounded-xl rounded-br-sm bg-user-bubble px-3.5 py-3 text-[14px] leading-[20px] text-user-bubble-fg">
        {s.note && <p className="whitespace-pre-wrap">{s.note}</p>}
        {s.note && s.items.length > 0 && <div className="my-2.5 h-px bg-bg/15" />}
        <div className="flex flex-col gap-2.5">
          {s.items.map((it) => (
            <div key={it.id}>
              <span className="line-clamp-2 block border-l-2 border-bg/25 pl-2 text-[12px] leading-[17px] text-user-bubble-fg/60">{it.quote}</span>
              <p className="mt-1 whitespace-pre-wrap">{it.text}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── the card ──────────────────────────────────────────────────────────────────────────────────────

type Layout = "today" | "new"

interface CardApi { pending: number; send: (note: string) => boolean; nav: (dir: 1 | -1) => void }

interface CardProps {
  data: CardData
  layout: Layout
  scrollerRef: RefObject<HTMLDivElement | null>
  layer?: LayerOptions
  force?: Force
  contextLook?: ContextLook
  // A header study: no dock, and a body tall enough for the snooze menu to open over it.
  bare?: boolean
  register?: (id: string, api: CardApi) => void
  onPending?: (id: string, n: number) => void
}

function QueueCard({ data, layout, scrollerRef, layer: layerOpts = {}, force, contextLook, bare, register, onPending }: CardProps) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const layer = useCommentLayer(bodyRef, scrollerRef, layerOpts)
  const [draft, setDraft] = useState("")
  const [snoozedUntil, setSnoozedUntil] = useState(data.snoozedUntil)
  const [done, setDone] = useState(Boolean(data.done))
  const n = layer.pending.length
  register?.(data.id, { pending: n, send: layer.send, nav: layer.nav })
  useEffect(() => { onPending?.(data.id, n) }, [n])
  // Sending un-parks and reopens, as a follow-up does today (router.followUp, resume.ts).
  const send = () => { if (layer.send(draft)) { setDraft(""); setDone(false); setSnoozedUntil(undefined) } }
  return (
    <div data-card={data.id} className={`relative flex min-w-0 flex-col rounded-xl border border-border-strong bg-panel shadow-lg shadow-shadow-ink/25 transition-opacity ${done && !bare ? "opacity-60" : ""}`}>
      <CardHeader
        data={data}
        layout={layout}
        force={force}
        contextLook={contextLook}
        snoozedUntil={snoozedUntil}
        done={done}
        onSnooze={setSnoozedUntil}
        onDone={() => setDone((d) => !d)}
      />
      <div ref={bodyRef} data-ic-root className="relative flex flex-col px-5 pb-5 pt-5" style={bare ? { minHeight: force?.menu ? 290 : 150 } : undefined} {...layer.rootHandlers}>
        {withMessageSpacers(data.messages, (m) => <Message key={m.sourceId} m={m} />)}
        {layer.sent.map((s) => (
          <Fragment key={s.id}>
            <VSpace h={18} />
            <SentBubble s={s} />
          </Fragment>
        ))}
        {layer.overlay}
      </div>
      {layout === "today" && <TodayBottom data={data} draft={draft} setDraft={setDraft} send={send} />}
      {layout === "new" && !bare && (
        <div className="sticky bottom-0 z-30 rounded-b-[11px] border-t border-border/60 bg-panel px-5 pb-3 pt-1 shadow-[0_-12px_18px_-14px_var(--dock-shade)]">
          <div className="flex h-7 min-w-0 items-center gap-3 px-0.5">
            <PendingChip n={n} onNav={layer.nav} />
            <span className="ml-auto"><ActivitySummary items={data.activity} forceOpen={force?.activity} /></span>
          </div>
          <PromptBox
            value={draft}
            onChange={setDraft}
            onSend={send}
            sendCount={n}
            placeholder={n ? `Add a note to go with ${n === 1 ? "the comment" : `the ${n} comments`} (optional)…` : "Reply to the agent…"}
            goal={data.goal}
            goalOpen={force?.goal}
          />
        </div>
      )}
    </div>
  )
}

function CardHeader({ data, layout, force, contextLook = "ring", snoozedUntil, done, onSnooze, onDone }: {
  data: CardData
  layout: Layout
  force?: Force
  contextLook?: ContextLook
  snoozedUntil?: string
  done: boolean
  onSnooze: (until: string | undefined) => void
  onDone: () => void
}) {
  const isNew = layout === "new"
  return (
    <div className="sticky top-0 z-20 flex items-center gap-2 rounded-t-[11px] border-b border-border/60 bg-panel px-5 py-3.5">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px] font-semibold leading-snug text-fg/95">{data.title}</div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] leading-tight text-muted-75">
          <span className="truncate">{data.sub}</span>
          {isNew && (
            <>
              <span className="text-muted-45">·</span>
              <ContextReading percent={data.context} look={contextLook} forceOpen={force?.context} />
            </>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <HeaderIcon label="Collapse" icon={ChevronsDownUp} size={13} />
        {data.restart && <HeaderIcon label="Restart worker" icon={RefreshCw} forceTip={force?.tip === "restart"} />}
        <HeaderIcon label="Open fullscreen" icon={Maximize2} size={13} />
        {data.retry && (
          <Tooltip label="Retry — resume this session where it left off">
            <button type="button" className="ml-1 flex items-center gap-1.5 rounded-md border border-accent/45 bg-accent/10 px-2.5 py-1 text-[12px] font-medium text-accent hover:border-accent/70 hover:bg-accent/15"><RotateCcw size={12} />Retry</button>
          </Tooltip>
        )}
        {isNew && (
          <>
            {/* mx-2.5 puts ~20px of ink either side of the rule, the strip's own icon-to-icon rhythm (18–21px
                measured), so the rule separates the groups without crowding either one. */}
            <span aria-hidden data-header-rule className="mx-2.5 h-4 w-px bg-border" />
            {done ? (
              <DoneReadout onReopen={onDone} />
            ) : (
              <>
                <SnoozeControl snoozedUntil={snoozedUntil} force={force} onSnooze={onSnooze} />
                <HeaderIcon label="Mark as done" icon={Check} size={15} forceTip={force?.tip === "check"} tipAlign="end" onClick={onDone} />
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// TODAY: the prompt box, every live op as its own ⤷ row, then the lifecycle strip — all at the card's end.
function TodayBottom({ data, draft, setDraft, send }: { data: CardData; draft: string; setDraft: (v: string) => void; send: () => void }) {
  return (
    <>
      <div className="px-5 pb-3">
        <PromptBox value={draft} onChange={setDraft} onSend={send} placeholder="Reply to the agent…" goal={false} />
        <div className="flex flex-col gap-0.5 px-1 pt-1.5">
          {data.activity.filter((a) => a.kind !== "file" && a.kind !== "link").map((a, i) => <OpRow key={i} a={a} />)}
        </div>
        {data.activity.some((a) => a.kind === "file" || a.kind === "link") && (
          <div className="mt-2 flex flex-col gap-0.5 border-t border-border px-1 pt-1.5">
            {data.activity.filter((a) => a.kind === "file" || a.kind === "link").map((a, i) => <OpRow key={i} a={a} />)}
          </div>
        )}
      </div>
      <footer className="flex min-h-10 items-center justify-end gap-3 rounded-b-[11px] border-t border-border/70 bg-panel/95 px-3 py-2 text-[12px]">
        <span className="mr-auto flex items-center gap-3 text-muted-60">
          <ContextRing percent={data.context} />
          <span className={data.goal ? "text-attention-90" : ""}><GoalMark size={12} /></span>
        </span>
        <span className="inline-flex items-stretch rounded-md border border-border-strong bg-panel-2/60 text-[12px]">
          <span className="flex items-center rounded-l-md px-2.5 py-1 font-medium text-fg/75">Snooze 1d</span>
          <span aria-hidden className="my-1 w-px bg-border" />
          <span className="flex items-center px-2 text-fg/75"><ChevronDown size={12} /></span>
        </span>
        <span className="flex items-center gap-1 rounded-md border border-border-strong bg-panel-2/60 px-2.5 py-1 text-[12px] font-medium text-fg/80"><Check size={12} />Mark as done</span>
      </footer>
    </>
  )
}

// ── the queue page, scrollable ────────────────────────────────────────────────────────────────────

function StatusBox({ children }: { children?: ReactNode }) {
  return <span className="inline-flex items-center justify-center rounded-[4px] border border-muted/45" style={{ width: STATUS_BOX, height: STATUS_BOX }}>{children}</span>
}

function SidebarGhost({ pendingByCard }: { pendingByCard: Record<string, number> }) {
  const atRest = <StatusBox><span className="h-[3px] w-[3px] rounded-full bg-muted-70 shadow-[4px_0_0_var(--color-muted-70),-4px_0_0_var(--color-muted-70)]" /></StatusBox>
  return (
    <aside className="w-[280px] pt-5">
      <div className="mb-5 h-[92px] rounded-lg border border-border bg-panel px-3 py-2.5 text-[13px] text-muted-40">Describe the task…</div>
      <div className="flex items-center gap-1.5 px-1.5 py-1 text-[11px] uppercase tracking-wide text-muted-70">Queue<span className="tabular-nums text-muted-60">3</span></div>
      {CARDS.map((c) => (
        <div key={c.id} className="flex min-w-0 items-start gap-2 rounded-md py-1 pl-3 pr-1.5 hover:bg-white/[0.04]">
          <span className="flex h-[19px] w-4 shrink-0 items-center justify-center">{c.retry ? <StatusBox><span className="text-[9px] font-bold leading-none text-accent">!</span></StatusBox> : atRest}</span>
          <span className="min-w-0 flex-1 truncate text-[13px] leading-[19px] text-fg/90">{c.title}</span>
          {pendingByCard[c.id] ? (
            <span title="Unsent comments" className="flex h-[19px] shrink-0 items-center gap-[3px] text-[10.5px] font-medium tabular-nums text-[var(--ic-ink)]"><MessageSquare size={10} strokeWidth={2.4} />{pendingByCard[c.id]}</span>
          ) : null}
          <span className="h-[19px] shrink-0 text-[10.5px] leading-[19px] tabular-nums text-muted-55">{c.sub.replace("Last active ", "").replace(" ago", "")}</span>
        </div>
      ))}
    </aside>
  )
}

function QueueViewport({ layout, height = 780, seeds = [S2, S3] }: { layout: Layout; height?: number; seeds?: Seed[] }) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [pendingByCard, setPendingByCard] = useState<Record<string, number>>({})
  // Each card reports its pending count up, for the rail.
  const onPending = (id: string, n: number) => setPendingByCard((prev) => (prev[id] === n ? prev : { ...prev, [id]: n }))
  return (
    <div className="relative overflow-hidden rounded-xl border border-border bg-bg" style={{ width: 1100, height }}>
      <div ref={scrollerRef} className="absolute inset-0 overflow-y-auto">
        <div className="flex items-start gap-9 pl-7 pr-7">
          <div className="sticky top-0"><SidebarGhost pendingByCard={pendingByCard} /></div>
          <div className="flex w-[720px] min-w-0 flex-col gap-10 py-5" style={{ paddingBottom: 60 }}>
            {CARDS.map((c, i) => (
              <QueueCard key={c.id} data={c} layout={layout} scrollerRef={scrollerRef} layer={i === 0 ? { seeds } : {}} onPending={onPending} />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// A single card, scrolled to its end, inside a fixed window — for side-by-side comparison. The dashed
// edge is the screen, the solid one the card.
function CardEnd({ data, height = 560, layer, force, contextLook, bare }: { data: CardData; height?: number | "fit"; layer?: LayerOptions; force?: Force; contextLook?: ContextLook; bare?: boolean }) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const sc = scrollerRef.current
    if (!sc || height === "fit") return
    const settle = () => { sc.scrollTop = sc.scrollHeight }
    settle()
    const t = setTimeout(settle, 400)
    return () => clearTimeout(t)
  }, [height])
  const card = <QueueCard data={data} layout="new" scrollerRef={scrollerRef} layer={layer} force={force} contextLook={contextLook} bare={bare} />
  // A short card gets a frame that fits it, so nothing scrolls and no half-message peeks out under the
  // sticky header. A header study leaves room above for the tooltips, which open upward.
  if (height === "fit") {
    return (
      <div ref={scrollerRef} className={`relative overflow-hidden rounded-xl border border-dashed border-muted-45 bg-bg px-4 pb-4 ${force?.tip ? "pt-12" : "pt-4"}`} style={{ width: 754 }}>
        {card}
      </div>
    )
  }
  return (
    <div className="relative overflow-hidden rounded-xl border border-dashed border-muted-45 bg-bg" style={{ width: 754, height }}>
      {/* The padding is on an inner box, never the scroller: Chrome insets the sticky rectangle by the
          scroller's own padding, so a padded scroller pins the header 16px down with text showing above it. */}
      <div ref={scrollerRef} className="absolute inset-0 overflow-y-auto [scrollbar-width:none]">
        <div className="p-4">{card}</div>
      </div>
    </div>
  )
}

// ── the sheet ─────────────────────────────────────────────────────────────────────────────────────

function Section({ id, title, note, children }: { id: string; title: string; note: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="mb-16 scroll-mt-20">
      <h2 className="mb-1 text-[16px] font-semibold tracking-tight text-fg/95">{title}</h2>
      <div className="mb-6 max-w-[900px] text-[12.5px] leading-[19px] text-muted">{note}</div>
      <div className="flex flex-wrap items-start gap-x-10 gap-y-12">{children}</div>
    </section>
  )
}
function Candidate({ letter, title, note, pick, children }: { letter: string; title: string; note: ReactNode; pick?: boolean; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-baseline gap-2">
        {letter && <span className="font-mono text-[12px] text-muted-80">{letter}</span>}
        <h3 className="text-[13px] font-medium text-fg/90">{title}</h3>
        {pick && <span className="rounded border border-accent/40 bg-accent/10 px-1.5 py-px text-[10.5px] font-medium text-accent">Recommended</span>}
      </div>
      <p className="mb-3 max-w-[754px] text-[12px] leading-[18px] text-muted-80">{note}</p>
      <div>{children}</div>
    </div>
  )
}
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

const LAYOUT_NOTES: Record<Layout, string> = {
  new: "The top bar manages the thread: what it is, how full its context is, the views onto it, and the two verbs that park or finish it — an alarm clock and a check. The bottom steers this run: what is outstanding, then the prompt box with the goal beside attach and send. Both edges stick while you read.",
  today: "The prompt box, one row per live op, then the lifecycle strip with the context pie, the goal and the Snooze and Mark as done buttons — all at the card's end. On a long card none of it is on screen while you read.",
}

function Playground() {
  const [layout, setLayout] = useState<Layout>("new")
  const [reset, bump] = useReducer((x: number) => x + 1, 0)
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-x-6 gap-y-2">
        <Seg label="Card" value={layout} onChange={setLayout} options={[{ value: "new", label: "New" }, { value: "today", label: "Today" }]} />
        <button type="button" onClick={bump} className="rounded-md border border-border px-2 py-0.5 text-[12px] text-muted hover:text-fg">Reset</button>
      </div>
      <p className="mb-4 max-w-[900px] text-[12px] leading-[18px] text-muted-80">{LAYOUT_NOTES[layout]}</p>
      <div className="flex flex-wrap items-start gap-8">
        <QueueViewport key={`${layout}-${reset}`} layout={layout} />
        <div className="w-[300px]">
          <h3 className="mb-2 text-[12px] font-medium text-fg/85">How to drive it</h3>
          <ol className="list-decimal space-y-1 pl-4 text-[12px] leading-[18px] text-muted">
            <li>Scroll the queue. The top bar sticks to the top and the prompt box to the bottom; both let go where the card ends.</li>
            <li>Point at the clock and the check for their names. Click the clock for the snooze menu; pick a time and the clock turns amber, pick Wake now to clear it. Click the check to mark the thread done.</li>
            <li>Point at “64% context” in the top bar for the token count and Compact now.</li>
            <li>Point at the target at the prompt box's bottom right for the goal; the second card has one armed.</li>
            <li>Point at the counts above the prompt box for the live sub-agents, shells and files.</li>
            <li>Point at a yellow passage for its comment. Select text and press ⌘I to add one; Enter sends the note and every comment as one message.</li>
          </ol>
        </div>
      </div>
    </div>
  )
}

function RuleTable() {
  const rows: [string, string, string][] = [
    ["Top bar", "The thread as a whole — what it is, and managing it", "Title · last active · context fullness (Compact now on hover) · collapse, fullscreen · Retry, restart worker · snooze (alarm clock) · mark as done (check)"],
    ["Line above the prompt box", "What this run has outstanding — yours on the left, the worker's on the right", "Pending comments ↑ ↓ · live agents, shells, PR watches, files and links as counts, rows on hover"],
    ["Prompt box", "What you say next, and how it runs", "The message · model and effort · permission mode · the goal (a standing message) · attach · send"],
  ]
  return (
    <div className="max-w-[1100px]">
      <table className="w-full border-collapse text-left text-[12.5px]">
        <thead>
          <tr className="border-b border-border text-[11px] uppercase tracking-wide text-muted-60">
            <th className="py-2 pr-6 font-normal">Edge</th><th className="py-2 pr-6 font-normal">Holds</th><th className="py-2 font-normal">So it carries</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([edge, rule, items]) => (
            <tr key={edge} className="border-b border-border/60 align-top">
              <td className="py-2.5 pr-6 font-medium text-fg/90">{edge}</td>
              <td className="py-2.5 pr-6 text-fg/80">{rule}</td>
              <td className="py-2.5 text-muted">{items}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 max-w-[900px] text-[12px] leading-[18px] text-muted-80">
        Two calls the rule made. The pending-comment count left the top bar: comments steer the next message, and with the prompt box docked the line above it is always on screen — the rail still counts them for cards you cannot see. The context reading went up, not down: it is a fact about the whole session, even though what it measures is the room left for the next message.
      </p>
    </div>
  )
}

const DONE_ONLY = MESSAGES.filter((m) => m.sourceId === "a4")
const HEADER_REST: CardData = { ...CACHE, id: "h-rest", messages: DONE_ONLY, activity: [] }
const HEADER_SNOOZED: CardData = { ...HEADER_REST, id: "h-snoozed", snoozedUntil: snoozePresetInstant("3d") }
const HEADER_DONE: CardData = { ...HEADER_REST, id: "h-done", done: true }
const HEADER_BUSY: CardData = {
  ...HEADER_REST,
  id: "h-busy",
  title: "Migrate the billing webhooks to the new event bus and backfill the missed deliveries",
  sub: "Last active 3h 12m ago",
  context: 88,
  retry: true,
  restart: true,
}

function Page() {
  const [theme, setTheme] = useState(document.documentElement.dataset.theme ?? "dark")
  useEffect(() => { document.documentElement.dataset.theme = theme }, [theme])
  return (
    <main className="min-h-screen bg-bg pb-24 text-fg">
      <style>{HIGHLIGHT_CSS + SHEET_CSS}</style>
      <header className="mx-auto max-w-[1640px] px-8 pb-6 pt-9">
        <h1 className="text-[22px] font-semibold tracking-tight">The queue card: manage at the top, steer at the bottom</h1>
        <p className="mt-1.5 max-w-[900px] text-[13px] leading-[20px] text-muted">
          Round three. Snooze becomes an alarm clock that opens a menu of times, with no remembered default; Mark as done becomes a check. Both join the sticky top bar, where the context reading now sits after “Last active”. The goal moves to the prompt box's bottom right, beside attach and send. The prompt box stays docked to the bottom of the screen.
        </p>
      </header>
      <nav className="sticky top-0 z-50 border-y border-border bg-bg/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1640px] flex-wrap items-center gap-x-6 gap-y-2 px-8 py-2.5 text-[12px]">
          <Seg label="Theme" value={theme} onChange={setTheme} options={[{ value: "dark", label: "Dark" }, { value: "light", label: "Light" }]} />
          <span className="ml-auto flex gap-5 text-muted">
            <a href="#scroll" className="hover:text-fg">Scroll it</a>
            <a href="#top" className="hover:text-fg">The top bar</a>
            <a href="#bottom" className="hover:text-fg">The bottom</a>
            <a href="#context" className="hover:text-fg">The context reading</a>
            <a href="#comments" className="hover:text-fg">Comments</a>
            <a href="#rule" className="hover:text-fg">The rule</a>
          </span>
        </div>
      </nav>
      <div className="mx-auto max-w-[1640px] px-8 pt-10">
        <Section id="scroll" title="Scroll it" note="The queue page as it would behave, three cards deep. Every control in it is live; switch to Today to compare.">
          <Playground />
        </Section>

        <Section id="top" title="1 · The top bar: the thread as a whole" note="Everything that manages the thread rather than this run. The two lifecycle verbs are bare icons in the header's own 28px squares, after a rule that holds them apart from the view controls; the check is last because it is the verb a resting card most often ends on.">
          <Candidate letter="i" title="At rest" note="Context reads as a fact after “Last active”. The clock and the check carry no label; their names show the instant the pointer reaches them.">
            <CardEnd data={HEADER_REST} height="fit" bare />
          </Candidate>
          <Candidate letter="ii" title="Pointing at the clock" note="The same immediate tooltip every header icon has.">
            <CardEnd data={HEADER_REST} height="fit" bare force={{ tip: "alarm" }} />
          </Candidate>
          <Candidate letter="iii" title="Clicking the clock" note="Every time, the whole list — each row says when the thread would come back. Nothing is remembered from the last pick, so there is no one-click snooze whose length changes between visits. Custom time & prompt… opens today's dialog.">
            <CardEnd data={HEADER_REST} height="fit" bare force={{ menu: true }} />
          </Candidate>
          <Candidate letter="iv" title="A snoozed thread" note="The clock turns amber while a snooze is armed, which retires the footer's grey alarm glyph. The menu leads with when it wakes, and Wake now.">
            <CardEnd data={HEADER_SNOOZED} height="fit" bare force={{ menu: true }} />
          </Candidate>
          <Candidate letter="v" title="Pointing at the check" note="Mark as done. A live turn still gets today's “End this session?” confirmation.">
            <CardEnd data={HEADER_REST} height="fit" bare force={{ tip: "check" }} />
          </Candidate>
          <Candidate letter="vi" title="Marked done" note="The two verbs give way to today's “✓ Done” readout; a message reopens the thread, as now.">
            <CardEnd data={HEADER_DONE} height="fit" bare />
          </Candidate>
          <Candidate letter="vii" title="The busiest header" note="Restart worker, Retry and 88% context on a long title. The title truncates; nothing wraps.">
            <CardEnd data={HEADER_BUSY} height="fit" bare force={{ tip: "restart" }} />
          </Candidate>
          <Candidate letter="viii" title="Pointing at the context reading" note="ContextMeter's popover, unchanged: the exact count and Compact now.">
            <CardEnd data={HEADER_REST} height="fit" bare force={{ context: true }} />
          </Candidate>
        </Section>

        <Section id="bottom" title="2 · The bottom: this run, and how to steer it" note="The dock is one line of what is outstanding, then the prompt box. The goal sits at the box's bottom right with attach and send — a standing message is something you send — grey while unset and amber while armed.">
          <Candidate letter="i" title="At rest, no goal" note="Two pending comments on the left of the line, six live ops counted on the right; the target is grey.">
            <CardEnd data={CACHE} height={540} layer={{ seeds: [S2, S3] }} />
          </Candidate>
          <Candidate letter="ii" title="A goal armed, pointing at it" note="Amber target; the hover shows the goal and when it is sent, as the footer's preview does today. A click opens today's goal panel.">
            <CardEnd data={PRICING} height="fit" force={{ goal: true }} />
          </Candidate>
          <Candidate letter="iii" title="Pointing at the counts" note={`The live ops, one ${CHILD_ARROW} row each, opening upward so nothing under the prompt box moves.`}>
            <CardEnd data={CACHE} height={540} force={{ activity: true }} />
          </Candidate>
        </Section>

        <Section id="context" title="3 · How the context reading reads" note="Three spellings of the same fact in the top bar's second line. All three open the popover on hover.">
          <Candidate letter="i" pick title="Ring and words" note="“Last active 2m ago · ◔ 64% context”. The ring is the glyph people already know from the footer; the words make it readable without a hover.">
            <CardEnd data={HEADER_REST} height="fit" bare contextLook="ring" />
          </Candidate>
          <Candidate letter="ii" title="Words only" note="“Context 64%”. Quieter, but the line loses the one mark that says this is a gauge.">
            <CardEnd data={HEADER_REST} height="fit" bare contextLook="words" />
          </Candidate>
          <Candidate letter="iii" title="Ring only" note="The footer's bare ring, moved up; the number only on hover. Smallest, and the least readable at a glance.">
            <CardEnd data={HEADER_REST} height="fit" bare contextLook="bare" force={{ context: true }} />
          </Candidate>
        </Section>

        <Section id="comments" title="4 · Comments, as highlights" note="Unchanged from round two: a comment leaves its passage lightly highlighted in yellow, the words show in a popover on hover and stay up on click, and the count rides the line above the prompt box.">
          <Candidate letter="i" title="Pointing at a highlight" note="Pending · goes with your next send. Edit and delete in the corner.">
            <CardEnd data={CACHE} height={600} layer={{ seeds: [S2, S3], openSeed: 0 }} />
          </Candidate>
          <Candidate letter="ii" title="Writing one" note="Select, then Comment or ⌘I: the same popover opens as an editor under the passage.">
            <CardEnd data={CACHE} height={600} layer={{ seeds: [S3], draft: { quote: "412 passed, 1 skipped", text: "" } }} />
          </Candidate>
          <div className="min-w-[360px] max-w-[560px] flex-1">
            <h3 className="mb-1 text-[13px] font-medium text-fg/90">What the worker reads</h3>
            <p className="mb-3 text-[12px] leading-[18px] text-muted-80">The prompt box text as a note, then one blockquote per comment, in transcript order.</p>
            <pre className="overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-inset p-4 font-mono text-[12px] leading-[18px] text-fg/85">{wireText("", [S2, S3])}</pre>
          </div>
        </Section>

        <Section id="rule" title="The rule" note="Manage at the top, steer at the bottom — loose, and the two places it bent are said out loud below the table.">
          <RuleTable />
        </Section>
      </div>
    </main>
  )
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <TooltipProvider>
      <Page />
    </TooltipProvider>
  </QueryClientProvider>,
)
