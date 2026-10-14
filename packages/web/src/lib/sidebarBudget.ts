// THE SIDEBAR'S HEIGHT BUDGET — what All projects' tier list (components/TierList.tsx) gives up, and in which
// order, so the list never scrolls (plans/all-projects-first.md § Fit-to-height).
//
// The list measures itself and raises a COMPRESSION LEVEL until it fits; this file says what each level
// means. Lowest priority goes first:
//
//   1. the Done-today tail shortens, one row at a time, to its header (unless the human opened Done);
//   2. Working rolls up its projects' runs into one line each, the biggest run first (a run the human
//      expanded is never rolled up again, and a lone run, one project's page, never rolls);
//   3. Ready and Working shorten together, a line at a time from whichever lists more, each down to a
//      floor, and each says what it no longer lists: Ready how many more the queue holds (the queue
//      column beside it shows every one in full), Working how many more are working, and where. On a tie
//      Ready gives first, for that reason. Opening Working by hand takes it out of this step.
//
//   4. last of all, Pinned lists its first pins and counts the rest: it is the human's own shelf and they
//      keep it short, but a shelf of seven on a 720px screen is still more than the screen.

/** How many Done-today rows the tail shows before any compression. */
export const TAIL_MAX = 5
/** Ready never shortens below this many rows. */
export const READY_FLOOR = 3
/** Working never shortens below this many lines. */
export const WORKING_FLOOR = 2
/** Pinned never shortens below this many rows. */
export const PINNED_FLOOR = 2

export interface BudgetInput {
  /** Done-today rows there are to show. */
  tail: number
  /** The human opened Done: it lists every row and is not compressed. */
  tailOpen: boolean
  /** Working's runs, one per project, in the order drawn. */
  runs: readonly { id: string; size: number }[]
  /** Runs the human expanded. */
  expanded: ReadonlySet<string>
  /** Ready rows there are to show. */
  ready: number
  /** The human opened Working: it lists every line and is not shortened (rollups still apply). */
  workingOpen: boolean
  /** Pinned rows there are to show. */
  pinned: number
  /** The human opened Pinned: it lists every row. */
  pinnedOpen: boolean
}

export interface Budget {
  /** Done-today rows to draw. */
  tailShown: number
  /** Working runs drawn as one line, by id. */
  rolled: ReadonlySet<string>
  /** Ready rows to draw; the rest are a "N more in the queue" line. */
  readyShown: number
  /** Working LINES to draw — a rolled run is one — the rest a "N more working" line. */
  workingShown: number
  /** Pinned rows to draw; the rest a "N more pinned" line. */
  pinnedShown: number
}

function rollable(input: BudgetInput): string[] {
  // One run is the whole tier (a project's own page): rolled, it would be Working's header said twice, so it
  // shortens like Ready instead.
  if (input.runs.length < 2) return []
  // Biggest first; a tie keeps the order drawn, so the same input always rolls the same runs.
  return input.runs
    .map((run, index) => ({ ...run, index }))
    .filter((run) => run.size > 1 && !input.expanded.has(run.id))
    .sort((a, b) => b.size - a.size || a.index - b.index)
    .map((run) => run.id)
}

/** Working's lines once every rollable run is rolled. */
function rolledLines(input: BudgetInput, rolled: ReadonlySet<string>): number {
  return input.runs.reduce((sum, run) => sum + (rolled.has(run.id) ? 1 : run.size), 0)
}

/** Steps of shortening Ready and Working, alternated, from their full lengths down to their floors. */
function shorten(ready: number, working: number, workingOpen: boolean, steps: number): { ready: number; working: number } {
  const readyFloor = Math.min(READY_FLOOR, ready)
  const workingFloor = workingOpen ? working : Math.min(WORKING_FLOOR, working)
  for (let i = 0; i < steps; i++) {
    const r = ready > readyFloor
    const w = working > workingFloor
    if (r && (!w || ready >= working)) ready--
    else if (w) working--
    else break
  }
  return { ready, working }
}

/** The highest level that still compresses something: past it, the list scrolls. */
export function maxLevel(input: BudgetInput): number {
  const tail = input.tailOpen ? 0 : Math.min(TAIL_MAX, input.tail)
  const order = rollable(input)
  const lines = rolledLines(input, new Set(order))
  const ready = Math.max(0, input.ready - READY_FLOOR)
  const working = input.workingOpen ? 0 : Math.max(0, lines - WORKING_FLOOR)
  return tail + order.length + ready + working + pinnedSteps(input)
}

function pinnedSteps(input: BudgetInput): number {
  return input.pinnedOpen ? 0 : Math.max(0, input.pinned - PINNED_FLOOR)
}

/** What the list draws at a compression level (0 = everything). */
export function budgetAt(level: number, input: BudgetInput): Budget {
  const tailMax = input.tailOpen ? input.tail : Math.min(TAIL_MAX, input.tail)
  const tailSteps = input.tailOpen ? 0 : tailMax
  const tailShown = tailMax - Math.min(level, tailSteps)
  const order = rollable(input)
  const rollSteps = Math.min(order.length, Math.max(0, level - tailSteps))
  const rolled = new Set(order.slice(0, rollSteps))
  const lines = rolledLines(input, rolled)
  const shortenSteps = Math.max(0, level - tailSteps - order.length)
  const { ready, working } = shorten(input.ready, lines, input.workingOpen, shortenSteps)
  const taken = input.ready - ready + (lines - working)
  const pinnedShown = input.pinned - Math.min(pinnedSteps(input), Math.max(0, shortenSteps - taken))
  return { tailShown, rolled, readyShown: ready, workingShown: working, pinnedShown }
}
