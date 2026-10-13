import type { Project } from "./project.ts"
import { log as ntwineLog } from "./logging.ts"

// ── OPENING EVERY REGISTERED PROJECT, IN THE BACKGROUND, AFTER BOOT ────────────────────────────────
//
// Tenants activate LAZILY: `routeToTenant` opens a project the first time a request addresses it, so
// a project nobody has visited since boot has no board. That is cheap and it was the right default —
// but a project's queue is a BOARD FACT (All projects, `projectsQueues`, and the rail's badges,
// `projectsRailCounts`, read it off each open project's snapshot), so the consequence the operator
// actually experienced was having to click into every project before it would say how many threads
// were waiting (2026-08-26: "I currently need to click into every project before the badge shows up
// with the number of rested threads!"). A cue you have to visit each project to see is not a cue.
//
// So the server opens the rest of them itself, once, shortly after it starts serving. Three facts make
// that affordable rather than reckless, and they are the whole argument for doing it this way:
//
//   * THERE IS NO EVICTION. `deactivate` is called from shutdown and nowhere else, so a project stays
//     open for the life of the server once anything opens it. The operator visiting all their projects
//     — which is exactly what they are doing today — already reaches this steady state. Priming only
//     reaches it sooner, and without the clicking.
//   * THE COLD PRIME IS ALREADY BOUNDED. `tailer.start()` folds at most MAX_PRIME_ROWS_PER_TICK rows
//     inside PRIME_BUDGET_MS (tailer.ts) and hands the rest to later ticks, so activating a large board
//     costs a few hundred ms here instead of the 1.5-7.5s it cost before that bound existed. The bound
//     covers the whole per-row cost, not only the fold, since 2026-09-04 — see below.
//   * SCHEDULERS FOR EVERY REGISTERED PROJECT IS THE DESIGN, not a side effect. plans/singleton-ntwine.md
//     §4 settles it: timers, `awaiting` wakes, snooze expiry, PR watches and limit auto-resume must not
//     go quiet for a project you are not looking at. Lazy activation left them dead until you opened it.
//
// The pass is SERIAL, and the pacing is MEASURED rather than guessed. It shipped with a flat 3s head
// start and a flat 1.5s between projects, which put the last project of 11 on screen 18 seconds
// after boot — and the maintainer rightly asked what the holdup was. Measured on an 11-project stack
// (seven empty, two ~30-thread boards, one 800-thread board with 9.4MB of transcripts), cold tail
// cache:
//
//     empty 11-17ms · 29 threads 37ms · 35 threads 41ms · 800 threads 220ms · TEN PROJECTS: 390ms
//
// The whole pass was 390ms of work behind 16,500ms of waiting. So the delays below are what it costs to
// stay POLITE, and nothing else: one activation is the atomic block (11-220ms, the top end being
// tailer.start's PRIME_BUDGET_MS ceiling), and the pause after it hands the loop back so a request that
// arrived mid-pass is served now rather than after the remaining projects.
//
// The gap TRACKS THE LAST ACTIVATION, the way the tailer's own scheduleTick tracks its last tick: an
// empty project costs a 25ms pause, a big one earns a breather its own size, and nothing pathological
// can hold the pass open for more than PRIME_MAX_GAP_MS. That 50% duty ceiling is also what phases the
// freshly started tailers apart, which the flat gap was really for.
//
// THE 11-220ms FIGURES ABOVE ARE THE 2026-08 MEASUREMENT AND NO LONGER DESCRIBE THIS MACHINE. Twelve
// projects on the maintainer's 2026-09-02 boot took 111-1000ms each, and the pass ran for 18.5s of wall
// clock against 5.7s of summed activation — the difference being the tailer and everything else
// contending for the same loop. See PRIME_MAX_GAP_MS for what that broke and what was done about it.
// The deeper cost was upstream, AND IT IS FIXED (2026-09-04). `tailer.start()`'s first tick used to do
// per-row work BEFORE its budget check — a retiredOps query, a tail-cache hydrate and a stat per
// transcript, plus a read-side discovery pass for anything unbound — so a big board's activation was not
// bounded by PRIME_BUDGET_MS the way the COLD PRIME bullet above assumes it is. The bound is now asked
// before that setup runs rather than only before the fold, and a 558-thread board's first tick fell from
// 2251ms to 342ms with a cold tail cache (1140ms to 359ms warm). The pacing below is still worth having —
// a dozen tailers and everything else share this loop — but it is no longer covering for an activation
// that was an order of magnitude over the figure it paces against.

/**
 * A head start for the launching project, whose board is the page the operator is actually waiting for.
 * Long enough to matter on first paint, far too short to be a wait anyone sees.
 */
const PRIME_START_DELAY_MS = 250
/** Floor on the pause between projects: even a 13ms activation yields the loop for a beat. */
const PRIME_MIN_GAP_MS = 25
/**
 * …and the ceiling, so one slow activation cannot pace the whole pass.
 *
 * IT WAS 250ms, AND THAT SILENTLY STOPPED MEANING A 50% DUTY CYCLE. The figure was chosen against the
 * 11-220ms activations measured above, where clamping at 250 never bound anything. Activations are no
 * longer that cheap: the maintainer's own boot log of 2026-09-02 opened twelve projects at 111, 156,
 * 187, 237, 315, 349, 459, 545, 677, 706, 985 and 1000ms. At the old ceiling a 1000ms activation earned
 * a 250ms breather — an 80% duty cycle, not 50% — and the loop stayed saturated for the whole pass. The
 * board RPC measured a 1.19s mean and a 5.60s max while priming ran, against 10ms and 427ms with it off.
 * That is the "long time to load initially": the page the operator is staring at waits behind the
 * projects they are not looking at.
 *
 * 1500ms clears the slowest activation on that log with headroom, so the ratio below is honoured for
 * every project actually observed, while still bounding a pathological one. The pass takes longer in
 * wall-clock and that is the correct trade — the LAUNCHING project is already open and served before
 * this starts, so what the extra seconds buy is a responsive UI while the other badges fill in.
 */
const PRIME_MAX_GAP_MS = 1_500

/**
 * How long one activation may hold the pass before the pass moves on without it.
 *
 * THE PASS IS SERIAL, SO ONE SLOW PROJECT USED TO HOLD EVERY PROJECT BEHIND IT CLOSED. On the
 * maintainer's dev server (2026-10-05, which restarts whenever server code lands) `arktype` opened in
 * 13s, 88s and 314s on three boots, and `app`, `beanemachine`, `local` and Home — the projects queued
 * after it — sat "Not open" for that whole span: no badge, no prompt box, and ⌥↑/⌥↓ stepped straight
 * past them (lib/crossProject.ts stepPick only lands on an open project). "Can't access home".
 *
 * So an activation still running after this long is left to finish on its own and the pass carries on.
 * It is not abandoned: `done` still waits for it, which is what keeps shutdown's drain complete (see
 * TenantPrimeRun.stop). Every activation seen on that log except the pathological ones finished well
 * inside it, so an ordinary boot stays exactly as serial as it was.
 */
const PRIME_STALL_MS = 5_000

/** The pause after an activation that took `tookMs` — a 50% duty cycle, clamped at both ends. */
function gapAfter(tookMs: number): number {
  return Math.min(PRIME_MAX_GAP_MS, Math.max(PRIME_MIN_GAP_MS, tookMs))
}

/** The registry shape this needs — `listProjects()` entries, in registry order. */
export interface PrimeCandidate {
  id: string
  path: string
  /** The directory is gone; `listProjects` derives it. Nothing to open. */
  stale: boolean
}

export interface TenantPrimeDeps {
  /** Every registered project, in the registry's order. */
  list: () => readonly PrimeCandidate[]
  /** Already open here — the launching project, and anything a request has opened since. */
  isOpen: (projectId: string) => boolean
  /** Registry entry → Project WITHOUT re-resolving identity (projectFromRegistryEntry). */
  toProject: (entry: PrimeCandidate) => Project
  /**
   * The tenant map's `activate`. It reports its own failures and resolves `undefined` for them, so
   * this pass reads the result rather than catching — see tenants.ts, where the seam lives.
   */
  activate: (project: Project) => Promise<unknown>
  /**
   * The pid of another live Ntwine already serving this project, if there is one (project-launch.ts).
   * Checked HERE as well as inside activation so the ordinary migration state — a per-project server
   * still running beside the singleton — logs one line per project instead of an error and a stack.
   */
  servedElsewhere?: (project: Project) => number | undefined
  /** Injected by tests, so a timing assertion is not a race against a loaded runner. */
  monotonicNow?: () => number
  /** Injected by tests; the default is the interruptible timer `stop()` cuts short. */
  delay?: (ms: number) => Promise<void>
  startDelayMs?: number
  /** Pins the pause between projects; the default TRACKS the last activation (see gapAfter). */
  gapMs?: number
  /** Overrides PRIME_STALL_MS. A real timer, not `delay`: tests inject a `delay` that never waits. */
  stallMs?: number
  log?: (message: string) => void
}

export interface TenantPrimeResult {
  /** Project ids this pass opened. */
  opened: string[]
  /** Already open, stale, or served by another live Ntwine. */
  skipped: string[]
  /** Tried and would not open — reported by the tenant seam, one dead card each. */
  failed: string[]
  /**
   * How long each of `opened` took, in ms, same order. Logged, and what the pacing is tuned against.
   * Both are in the order activations FINISHED, which a stalled one (PRIME_STALL_MS) can put out of
   * rail order.
   */
  tookMs: number[]
}

export interface TenantPrimeRun {
  /** Resolves when the pass finishes or is stopped. Never rejects. */
  done: Promise<TenantPrimeResult>
  /**
   * Stop before the next project. Shutdown calls this and then awaits `done`, so anything the pass
   * opened is in the tenant map BEFORE the map is drained — a project activated after that drain would
   * be a leaked SQLite handle and a tailer nothing ever stops.
   *
   * It cuts the wait between projects short, but it cannot interrupt an activation already in flight —
   * including one the pass moved on from because it stalled; `done` waits for every one of them, and
   * each lands in the map, which is what makes the drain complete.
   */
  stop: () => void
}

export function startTenantPrime(deps: TenantPrimeDeps): TenantPrimeRun {
  const log = deps.log ?? ((message: string) => ntwineLog.info("tenants", message))
  let stopped = false
  let interrupt: (() => void) | undefined

  const defaultDelay = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      if (stopped) return resolve()
      const finish = () => {
        clearTimeout(timer)
        interrupt = undefined
        resolve()
      }
      // Unref'd: a server with nothing else to do must still be able to exit while this is pending.
      const timer = setTimeout(finish, ms)
      timer.unref?.()
      interrupt = finish
    })

  const delay = deps.delay ?? defaultDelay

  // Resolves `undefined` after `ms`, or at once on stop(): a shutdown must not sit out a stall timer
  // before it gets to wait for the activation itself.
  let interruptStall: (() => void) | undefined
  const stall = (ms: number): Promise<undefined> =>
    new Promise<undefined>((resolve) => {
      if (stopped) return resolve(undefined)
      const finish = () => {
        clearTimeout(timer)
        interruptStall = undefined
        resolve(undefined)
      }
      const timer = setTimeout(finish, ms)
      timer.unref?.()
      interruptStall = finish
    })

  const run = async (): Promise<TenantPrimeResult> => {
    const result: TenantPrimeResult = { opened: [], skipped: [], failed: [], tookMs: [] }
    await delay(deps.startDelayMs ?? PRIME_START_DELAY_MS)
    // How long the PREVIOUS activation took, which is the pause the next one waits. Undefined until the
    // first project is open — so a run of skips (already-open, stale, served elsewhere) costs nothing.
    let lastTookMs: number | undefined
    // Activations the pass moved on from (PRIME_STALL_MS), collected before `done` resolves.
    const stalled: Promise<number>[] = []
    for (const entry of deps.list()) {
      if (stopped) break
      if (entry.stale || deps.isOpen(entry.id)) {
        result.skipped.push(entry.id)
        continue
      }
      // RESOLUTION IS BLOCKING WORK AND IT COUNTS. `toProject` is `projectFromRegistryEntry`, which
      // calls `originRemoteUrl` — a SYNCHRONOUS `git remote get-url`, measured at a 110ms median under
      // load (2026-09-04). Timing only the activation left that spawn out of `tookMs` entirely, so
      // `gapAfter` paced against a number smaller than the loop had actually been blocked for, and the
      // log under-reported every project by the same amount.
      //
      // Measured as its own span rather than by moving the start of the activation's, because the gap
      // below sits between the two: one span across both would fold the POLITENESS WAIT into the cost
      // that decides the next politeness wait, and each project would pace off the last one's idling.
      const resolveStartedAt = deps.monotonicNow?.() ?? performance.now()
      let project: Project
      try {
        project = deps.toProject(entry)
      } catch (error) {
        result.failed.push(entry.id)
        log(`could not resolve ${entry.path} to prime it: ${detail(error)}`)
        continue
      }
      const other = deps.servedElsewhere?.(project)
      if (other !== undefined) {
        result.skipped.push(entry.id)
        log(`${project.name} is served by another Ntwine (pid ${other}) — leaving it closed here`)
        continue
      }
      const resolveMs = (deps.monotonicNow?.() ?? performance.now()) - resolveStartedAt
      if (lastTookMs !== undefined) await delay(deps.gapMs ?? gapAfter(lastTookMs))
      if (stopped) break
      const startedAt = deps.monotonicNow?.() ?? performance.now()
      const name = project.name
      const id = entry.id
      // Never rejects, and records its own outcome — so it reads the same whether the pass waited for it
      // or moved on and collects it at the end.
      const attempt = (async (): Promise<number> => {
        try {
          const opened = await deps.activate(project)
          const tookMs = Math.round(resolveMs + ((deps.monotonicNow?.() ?? performance.now()) - startedAt))
          if (opened === undefined) result.failed.push(id)
          else {
            result.opened.push(id)
            result.tookMs.push(tookMs)
            log(`opened ${name} in ${tookMs}ms`)
          }
          return tookMs
        } catch (error) {
          // activate() is documented not to throw. Belt and braces: this pass is a floating promise, and
          // an unhandled rejection out of it would take down a server that is otherwise perfectly healthy.
          result.failed.push(id)
          log(`priming ${name} threw: ${detail(error)}`)
          return Math.round(resolveMs + ((deps.monotonicNow?.() ?? performance.now()) - startedAt))
        }
      })()
      const stallMs = deps.stallMs ?? PRIME_STALL_MS
      const tookMs = await Promise.race([attempt, stall(stallMs)])
      // Settled in time: retire its stall timer, which would otherwise fire later and unhook the next one's.
      interruptStall?.()
      if (tookMs === undefined) {
        stalled.push(attempt)
        log(`${name} is still opening after ${stallMs}ms — opening the rest meanwhile`)
        lastTookMs = stallMs
      } else lastTookMs = tookMs
    }
    await Promise.all(stalled)
    if (result.opened.length > 0) log(`opened ${result.opened.length} more project(s) so their queue badges are live`)
    return result
  }

  return {
    done: run().catch((error) => {
      log(`priming pass failed: ${detail(error)}`)
      return { opened: [], skipped: [], failed: [], tookMs: [] }
    }),
    stop: () => {
      stopped = true
      interrupt?.()
      interruptStall?.()
    },
  }
}

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
