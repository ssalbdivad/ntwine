import { useState } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useSnapshot } from "valtio"
import {
  InterpretScheduleInput,
  SCHEDULE_NOT_FOUND_COPY,
  cutPhrase,
  scheduleEcho,
  type BoardSnapshot,
  type CodexModel,
  type CreateScheduleInput,
  type DispatchPreferences,
  type InterpretScheduleResult,
  type ScheduleView,
} from "@ntwine/shared"
import { DispatchForm, NewThreadDialog, type DispatchDirs } from "./components/NewThreadModal.tsx"
import { carryDispatchDraft } from "./lib/scheduleDraftState.ts"
import { Toaster } from "./components/Toaster.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { store } from "./store.ts"
import "./styles.css"

// THE SCHEDULE IN THE WORDS, on the real prompt box (ARCHITECTURE.md § Scheduled threads). It mounts the real
// <DispatchForm> — Composer, useLiveSchedule, the strip, the draft store — over a stubbed RPC seam that COUNTS
// every call the box can make that matters (dispatch, createSchedule, deleteSchedule, interpretSchedule) and
// records their bodies, so composerScheduleLive.e2e.test.ts can say "Enter dispatched once and created
// nothing" as a fact about the wire.
//
// Nothing here reaches a server: there is none. THE MODEL is a stub the test arms per case: `__sched.rules`, in
// order, each matched by a substring of the text read — the first match answers (a schedule reading of its
// phrase, a refusal, a failed read, or a call that never answers); text no rule matches has no schedule in it.
// Every answer waits `delayMs` (300 by default), and while `__sched.gate` is closed every answer waits for
// `__sched.release()` too, so a test can look at the box with a read in flight. The clock is the fixed one the
// HTML installs (Mon Oct 5 2026 2:32pm New York).
//
// Fixture verbs, on `window.__sched`: `remount()` unmounts and remounts the box (a viewport override across the
// phone breakpoint does that in the real app), `openDialog()` opens the `c` dialog over the page box,
// `reaim(dir)` moves the box to another project as the All-projects picker and ⌥↑/⌥↓ do, `reset()` zeroes the
// counts. Counts live on the page, so a reload starts them at zero; the draft store (sessionStorage) is what
// survives it, which is the point. `failDispatch` makes that many dispatches answer 500 (each still counted);
// `/attach` answers an attachment path after `attachDelayMs`.
//
// `?sheet` is THE PHONE'S NEW THREAD SHEET (PhonePage.tsx PhoneNewThread): no box on the page, a New thread
// button that opens the box in a sheet through the same store flag the phone uses (`store.phoneNewThread`), and
// a dispatch or a created schedule closes it — so what happens AFTER the box is gone (Undo) can be driven.

type Counted = "dispatch" | "createSchedule" | "deleteSchedule" | "interpretSchedule"
/** What the stub model says about a text that contains `match`. */
type ModelRule = {
  match: string
  delayMs?: number
} & (
  /** A schedule reading of `phrase` (which must be in the text). */
  | { phrase: string; rrule: string; dtstart: string; condition?: string; title: string }
  /** A refusal, in the interpreter's own words (SCHEDULE_SPACING_COPY, …). */
  | { refuse: string }
  /** The interpreter's own failure ("Couldn't read that just now: …"), or `http` for a failed request. */
  | { fail: "model" | "http" }
  /** Never answers: the box's own give-up timers decide. */
  | { hang: true }
)

interface SchedFixture {
  counts: Record<Counted, number>
  bodies: Record<Counted, Record<string, unknown>[]>
  rules: ModelRule[]
  /** Closed: every model answer also waits for `release()`. */
  gate: boolean
  release: () => void
  /** The most interpretSchedule calls ever out at once — the box's single flight, measured on the wire. */
  maxInFlight: number
  /** How long createSchedule takes to answer (ms; 0 by default). */
  createDelayMs: number
  /** RPC names the fixture does not answer — so a test can see what the box asked for. */
  unknown: string[]
  /** How many of the next dispatches answer 500 (each still counted). */
  failDispatch: number
  /** How long `/attach` takes to answer (ms; 0 by default). */
  attachDelayMs: number
  remount: () => void
  openDialog: () => void
  reaim: (projectDir: string) => void
  reset: () => void
}

declare global {
  interface Window { __sched: SchedFixture }
}

const PROJECT_ID = "fixture-schedule-live"
const PROJECT_DIR = "/fixture/schedule-live"

const zero = (): Record<Counted, number> => ({ dispatch: 0, createSchedule: 0, deleteSchedule: 0, interpretSchedule: 0 })
const empty = (): Record<Counted, Record<string, unknown>[]> => ({ dispatch: [], createSchedule: [], deleteSchedule: [], interpretSchedule: [] })

let gateWaiters: Array<() => void> = []
let inFlight = 0
/** The armed rules survive a reload (sessionStorage), so a test that reloads mid-case keeps its model. */
const RULES_KEY = "__schedRules"
let rules: ModelRule[] = JSON.parse(sessionStorage.getItem(RULES_KEY) ?? "[]") as ModelRule[]
const sched: SchedFixture = {
  counts: zero(),
  bodies: empty(),
  get rules() { return rules },
  set rules(next: ModelRule[]) {
    rules = next
    sessionStorage.setItem(RULES_KEY, JSON.stringify(next))
  },
  gate: false,
  release: () => {
    sched.gate = false
    const waiters = gateWaiters
    gateWaiters = []
    for (const w of waiters) w()
  },
  maxInFlight: 0,
  createDelayMs: 0,
  unknown: [],
  failDispatch: 0,
  attachDelayMs: 0,
  remount: () => {},
  openDialog: () => {},
  reaim: () => {},
  reset: () => {
    sched.counts = zero()
    sched.bodies = empty()
    sched.maxInFlight = 0
  },
}
window.__sched = sched

const codexModels: CodexModel[] = [{ slug: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", defaultEffort: "medium", efforts: ["low", "medium", "high"] }]
const preferences: DispatchPreferences = {
  backend: "codex",
  claude: { permissionMode: "auto" },
  codex: { model: "gpt-5.6-sol", effort: "medium", permissionMode: "default" },
}

let nextId = 1

function viewOf(input: CreateScheduleInput): ScheduleView {
  const now = Date.now()
  const tz = input.tz ?? "America/New_York"
  const echo = scheduleEcho({ title: input.title, rrule: input.rrule, dtstart: input.dtstart, tz, condition: input.condition ?? null }, now, tz)
  if (!echo.ok) throw new Error(echo.error)
  const { compiled: _compiled, ...preview } = echo.value
  const at = new Date(now).toISOString()
  return {
    id: `sch_fixture_${nextId++}`,
    projectId: PROJECT_ID,
    projectSlug: "schedule-live",
    projectName: "schedule-live",
    title: input.title,
    whenText: input.whenText,
    prompt: input.prompt,
    ...(input.condition ? { condition: input.condition } : {}),
    rrule: input.rrule,
    dtstart: input.dtstart,
    tz,
    ...preview,
    backend: input.backend ?? "claude",
    ...(input.model ? { model: input.model } : {}),
    state: "active",
    attention: false,
    ...(preview.upcoming[0] ? { nextRun: { slug: "fixture-next-run", sessionId: "fixture-next-session", at: preview.upcoming[0], occurrenceAt: preview.upcoming[0], moved: false } } : {}),
    counts: { started: 0, skipped: 0, failed: 0, unreviewed: 0 },
    createdBy: "human",
    createdAt: at,
    updatedAt: at,
    revision: 1,
  } as ScheduleView
}

/** What the stub model answers for `text`, as the real interpreter shapes it: offsets into the TRIMMED text. */
function interpret(text: string, tz: string, rule: ModelRule | undefined): InterpretScheduleResult {
  if (!rule) return { ok: false, error: SCHEDULE_NOT_FOUND_COPY }
  if ("refuse" in rule) return { ok: false, error: rule.refuse }
  if ("fail" in rule) return { ok: false, error: "Couldn't read that just now: the stub model is down" }
  if (!("phrase" in rule)) return { ok: false, error: SCHEDULE_NOT_FOUND_COPY }
  const start = text.indexOf(rule.phrase)
  if (start < 0) return { ok: false, error: SCHEDULE_NOT_FOUND_COPY }
  const span = { start, end: start + rule.phrase.length }
  const echo = scheduleEcho({ title: rule.title, rrule: rule.rrule, dtstart: rule.dtstart, tz, condition: rule.condition ?? null }, Date.now(), tz)
  if (!echo.ok) return { ok: false, error: echo.error }
  const { compiled: _compiled, ...preview } = echo.value
  const prompt = cutPhrase(text, span)
  if (!prompt) return { ok: false, error: "What should each run do? Add the task after the schedule, like “every Monday at 9am triage new issues”." }
  return {
    ok: true,
    phrase: rule.phrase,
    phraseStart: span.start,
    phraseEnd: span.end,
    prompt,
    whenText: rule.phrase,
    rrule: rule.rrule,
    dtstart: rule.dtstart,
    tz,
    ...(rule.condition ? { condition: rule.condition } : {}),
    title: rule.title,
    preview,
  }
}

const nativeFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  const url = new URL(requestUrl, window.location.origin)
  if (/\/attach$/.test(url.pathname)) {
    if (sched.attachDelayMs) await new Promise((r) => setTimeout(r, sched.attachDelayMs))
    return new Response(JSON.stringify({ path: "/fixture/.ntwine/attachments/1-abcdef12-shot.png" }), { headers: { "content-type": "application/json" } })
  }
  // Both the page's client (`/_ntwine/rpc/x`) and a project-pinned one (`/_ntwine/<id>/rpc/x`, Undo's delete).
  const name = /\/rpc\/([A-Za-z]+)$/.exec(url.pathname)?.[1]
  if (!name) return nativeFetch(input, init)
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : JSON.parse(url.searchParams.get("input") ?? "{}") as Record<string, unknown>
  if (name in sched.counts) {
    const counted = name as Counted
    sched.counts[counted]++
    sched.bodies[counted].push(body)
  }
  switch (name) {
    case "dispatchPreferencesGet": return json(preferences)
    case "codexModels": return json(codexModels)
    case "acpAgents": return json([])
    case "settingsGet": return json({ permissionMode: "bypassPermissions", notifications: true })
    case "authStatus": return json({ claude: "authed", codex: "authed", emails: {} })
    case "userCommands": return json({ commands: [{ name: "review", description: "Review the diff", body: "Review the diff.", source: "project", path: "/fixture/.ntwine/commands/review.md" }], ntwineDir: "/fixture/.ntwine/commands" })
    case "listSchedules": return json([])
    case "dispatch":
      if (sched.failDispatch > 0) {
        sched.failDispatch--
        return new Response(JSON.stringify({ error: "fixture: the server could not start the thread" }), { status: 500, headers: { "content-type": "application/json" } })
      }
      // Acknowledged, never acted on: there is no server behind this page.
      return json({ slug: "fixture-started-thread", sessionId: "fixture-session" })
    case "interpretSchedule": {
      // Parsed as the server parses it: `text` is TRIMMED, and the answer's offsets index the trimmed text.
      const parsed = InterpretScheduleInput.parse(body)
      const rule = sched.rules.find((r) => parsed.text.includes(r.match))
      inFlight++
      sched.maxInFlight = Math.max(sched.maxInFlight, inFlight)
      try {
        if (rule && "hang" in rule) return await new Promise<Response>(() => {})
        await new Promise((r) => setTimeout(r, rule?.delayMs ?? 300))
        if (sched.gate) await new Promise<void>((r) => gateWaiters.push(r))
        if (rule && "fail" in rule && rule.fail === "http") return new Response(JSON.stringify({ error: "fixture: the server is down" }), { status: 502, headers: { "content-type": "application/json" } })
        return json(interpret(parsed.text, parsed.tz ?? "America/New_York", rule))
      } finally {
        inFlight--
      }
    }
    case "createSchedule": {
      if (sched.createDelayMs) await new Promise((r) => setTimeout(r, sched.createDelayMs))
      return json(viewOf(body as unknown as CreateScheduleInput))
    }
    case "deleteSchedule": return json({ ok: true })
  }
  sched.unknown.push(name)
  return new Response("404 Not Found", { status: 404 })
}

function json(result: unknown): Response {
  return new Response(JSON.stringify({ result }), { headers: { "content-type": "application/json", "x-ntwine-boot": "fixture" } })
}

store.board = { projectDir: PROJECT_DIR, projectId: PROJECT_ID } as unknown as BoardSnapshot

/** Stands in for a project's schedules count, which the page no longer draws: marked while `store.scheduleFlash` names it. */
function FlashProbe() {
  const flash = useSnapshot(store).scheduleFlash
  // Present for the test to find, and out of every screenshot: the real flash is on a project row this page lacks.
  return flash ? <span data-sched-flash={flash.projectId} className="sr-only">flash</span> : null
}

/** `?sheet`: the phone's New thread sheet, opened and closed through the store flag the phone page uses. */
function SheetFixture() {
  const composing = useSnapshot(store).phoneNewThread
  return (
    <main className="min-h-screen bg-bg p-3">
      <button type="button" data-fixture-new-thread className="rounded-md border border-border px-3 py-1.5 text-sm" onClick={() => { store.phoneNewThread = { focus: true } }}>
        New thread
      </button>
      {composing && (
        <section data-fixture-sheet className="mt-3 rounded-xl border border-border bg-panel p-5">
          <h1 className="mb-1 text-[14px] font-medium">New thread</h1>
          <DispatchForm autoFocus={composing.focus} onDispatched={() => { store.phoneNewThread = null }} />
        </section>
      )}
      <FlashProbe />
      <Toaster />
    </main>
  )
}

function Fixture() {
  const [mount, setMount] = useState(0)
  const [hidden, setHidden] = useState(false)
  const [dialog, setDialog] = useState(false)
  sched.remount = () => {
    setHidden(true)
    requestAnimationFrame(() => requestAnimationFrame(() => {
      setHidden(false)
      setMount((n) => n + 1)
    }))
  }
  sched.openDialog = () => setDialog(true)
  const [dirs, setDirs] = useState<DispatchDirs | undefined>(undefined)
  sched.reaim = (projectDir) => {
    carryDispatchDraft(dirs?.projectDir ?? PROJECT_DIR, projectDir)
    setDirs({ projectDir, homeDir: undefined })
  }
  return (
    <main className="min-h-screen bg-bg p-6 max-[699px]:p-3">
      <section className="mx-auto max-w-xl rounded-xl border border-border bg-panel p-5 max-[699px]:p-3">
        <h1 className="mb-3 text-sm font-medium">New thread</h1>
        {!hidden && <DispatchForm key={mount} dirs={dirs} />}
        <FlashProbe />
      </section>
      {dialog && <NewThreadDialog onClose={() => setDialog(false)} />}
      <Toaster />
    </main>
  )
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } })

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      {new URLSearchParams(location.search).has("sheet") ? <SheetFixture /> : <Fixture />}
    </TooltipProvider>
  </QueryClientProvider>,
)
