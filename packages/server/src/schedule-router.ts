import { z } from "zod"
import { mutation, query } from "@ntwine/rpc/server"
import {
  CreateScheduleInput,
  GetScheduleResult,
  InterpretScheduleInput,
  InterpretScheduleResult,
  ListSchedulesInput,
  OwnScheduleInput,
  OwnScheduleResult,
  ReportClientZoneInput,
  RunScheduleNowResult,
  ScheduleIdInput,
  ScheduleView,
  SetScheduleStateInput,
  UpdateScheduleInput,
} from "@ntwine/shared"
import type { AppContext } from "./context.ts"

// THE SCHEDULE RPCs (ARCHITECTURE.md § Scheduled threads). Spread into the router (router.ts createRouter), so
// they are ordinary procedures of the tenant they are addressed to — `/_ntwine/<project>/rpc/<name>` — and
// every one is mirrored in packages/web/src/api/contract.ts, which rpc-contract.ts holds to these schemas.
//
// Two audiences. The HUMAN's (the prompt box, which reads its own words for a schedule as they are typed; the
// schedule drawer; the palette) can do everything. The WORKER's is the one `ownSchedule` procedure behind the `schedule` MCP tool, keyed by the
// caller's own slug like every worker procedure, and narrower by design (schedules.ts `own`): a worker
// PROPOSES, and only a human turns a schedule on.

export function scheduleProcedures(ctx: AppContext) {
  const service = () => {
    if (!ctx.schedules) throw new Error("Schedules are not available on this server")
    return ctx.schedules
  }
  return {
    // This project's schedules — or, for the command palette, every open project's.
    listSchedules: query({
      input: ListSchedulesInput,
      output: z.array(ScheduleView),
      handler: async ({ input }) => {
        if (!input.allProjects) return service().list()
        const out: ScheduleView[] = []
        for (const tenant of ctx.activeTenants?.() ?? [{ project: ctx.project, board: ctx.board, ctx }]) {
          const schedules = (tenant.ctx ?? (tenant.project.id === ctx.project.id ? ctx : undefined))?.schedules
          try {
            if (schedules) out.push(...schedules.list())
          } catch {
            // A project closing mid-walk is missing from this round, not a failed request.
          }
        }
        return out
      },
    }),

    // One schedule with its history, newest first — the drawer.
    getSchedule: query({
      input: ScheduleIdInput,
      output: GetScheduleResult,
      handler: async ({ input }) => service().get(input.id),
    }),

    // Read the schedule out of plain words (schedule-interpreter.ts): whether they ask for the work to repeat,
    // and if so, when. A mutation, not a query: it is a model call with a cost, never something to prefetch
    // (the browser keeps its own short cache of answers, lib/scheduleModelRead.ts). With `scheduleId` it is
    // "Change when": the words are only the new WHEN, read against the stored words, rule and condition, in
    // the schedule's own zone.
    interpretSchedule: mutation({
      input: InterpretScheduleInput,
      output: InterpretScheduleResult,
      handler: async ({ input }) => {
        const existing = input.scheduleId ? ctx.storage.getSchedule(input.scheduleId) : undefined
        if (input.scheduleId && !existing) throw new Error("That schedule no longer exists.")
        if (!ctx.scheduleInterpreter) return { ok: false as const, error: "Schedules are not available on this server" }
        const viewerTz = input.tz ?? service().defaultZone()
        const tz = existing?.tz ?? viewerTz
        return ctx.scheduleInterpreter.interpret({ text: input.text, tz, viewerTz, ...(existing ? { existing } : {}) })
      },
    }),

    // Save a schedule the human confirmed. It starts active, with its next run in Snoozed.
    createSchedule: mutation({
      input: CreateScheduleInput,
      output: ScheduleView,
      handler: async ({ input }) => service().create(input),
    }),

    updateSchedule: mutation({
      input: UpdateScheduleInput,
      output: ScheduleView,
      handler: async ({ input }) => service().update(input),
    }),

    // Pause, Resume, and Turn on (a proposal → active).
    setScheduleState: mutation({
      input: SetScheduleStateInput,
      output: ScheduleView,
      handler: async ({ input }) => service().setState(input.id, input.state),
    }),

    // Start the next run now. Calls the start directly, never the scheduler's kick, so it works on a server
    // whose wakers are off (NTWINE_WAKERS_OFF), where a kick does nothing.
    runScheduleNow: mutation({
      input: ScheduleIdInput,
      output: RunScheduleNowResult,
      handler: async ({ input }) => service().runNow(input.id),
    }),

    // Delete (and a proposal's Discard). Its past runs' threads stay; its history goes with it.
    deleteSchedule: mutation({
      input: ScheduleIdInput,
      handler: async ({ input }) => {
        service().remove(input.id)
      },
    }),

    // The browser's zone, reported on load. Machine-wide and latest-wins: the default for new schedules.
    reportClientZone: mutation({
      input: ReportClientZoneInput,
      handler: async ({ input }) => {
        service().reportClientZone(input.tz)
      },
    }),

    // The worker's `schedule` tool (cc-worker/bin/ntwine-mcp.mjs). `text` is relayed verbatim.
    ownSchedule: mutation({
      input: OwnScheduleInput,
      output: OwnScheduleResult,
      handler: async ({ input }) => service().own(input),
    }),
  }
}
