import type { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { type, type ArkErrors } from "arktype"

// ---- Procedure definition helpers ----

// A procedure's schemas are arktype Types, from any scope (shared's configured `type` included). The
// handler receives the validated OUTPUT of `input` — trimmed, defaulted, undeclared keys handled per the
// schema — and returns the output side of `output`/`event`.
type Schema = type.Any

export type QueryDef<TInput extends Schema | undefined, TOutput extends Schema> = {
  _tag: "query"
  input?: TInput
  output: TOutput
  handler: (
    args: TInput extends Schema ? { input: TInput["infer"] } : {}
  ) => Promise<TOutput["infer"]>
}

export type MutationDef<TInput extends Schema, TOutput extends Schema | undefined> = {
  _tag: "mutation"
  input: TInput
  output?: TOutput
  handler: (args: {
    input: TInput["infer"]
  }) => Promise<TOutput extends Schema ? TOutput["infer"] : void>
}

export type StreamDef<TInput extends Schema | undefined, TEvent extends Schema> = {
  _tag: "stream"
  input?: TInput
  event: TEvent
  handler: (
    args: TInput extends Schema ? { input: TInput["infer"] } : {}
  ) => AsyncGenerator<TEvent["infer"]>
}

export function query<
  TInput extends Schema | undefined,
  TOutput extends Schema,
>(
  def: Omit<QueryDef<TInput, TOutput>, "_tag">
): QueryDef<TInput, TOutput> {
  return { ...def, _tag: "query" }
}

export function mutation<
  TInput extends Schema,
  TOutput extends Schema | undefined = undefined,
>(
  def: Omit<MutationDef<TInput, TOutput>, "_tag">
): MutationDef<TInput, TOutput> {
  return { ...def, _tag: "mutation" }
}

export function stream<
  TInput extends Schema | undefined,
  TEvent extends Schema,
>(
  def: Omit<StreamDef<TInput, TEvent>, "_tag">
): StreamDef<TInput, TEvent> {
  return { ...def, _tag: "stream" }
}

// ---- Router type ----

export type AnyProcedure = QueryDef<any, any> | MutationDef<any, any> | StreamDef<any, any>
export type Router = Record<string, AnyProcedure>

// ---- Extract procedure map (shared with client) ----

export function extractProcedureMap(router: Router): Record<string, "query" | "mutation" | "stream"> {
  const map: Record<string, "query" | "mutation" | "stream"> = {}
  for (const [name, proc] of Object.entries(router)) {
    map[name] = proc._tag
  }
  return map
}

// A validation failure must travel as a READABLE STRING. Both clients surface `error` verbatim only
// when it is a string — the web one otherwise falls back to an opaque "RPC <name> failed", which hid
// a real timer-format bug behind a message naming nothing. Keep the field's type stable at `string`.
// One sentence per problem, as arktype words it with its location: `until must be an ISO-8601 UTC instant
// (was "…")`. `message` rather than `path: problem`, because a union's problem already names the paths
// inside it, and prefixing it again reads `kind: questions[0].kind must be …`.
function validationMessage(errors: ArkErrors): string {
  return errors.issues.length > 0 ? errors.issues.map((e) => e.message).join("; ") : "Invalid input"
}

// Validate `raw` against a procedure's input: the parsed value, or the 400 reply's readable message.
function parseInput(schema: Schema, raw: unknown): { input: unknown } | { error: string } {
  const out = schema(raw)
  return out instanceof type.errors ? { error: validationMessage(out) } : { input: out }
}

// A handler may additionally mark its failure as safely REPLAYABLE by raising an error carrying
// `retryableDelivery` (server/src/resume.ts RetryableDeliveryError): the operation was refused by a
// contention gate before it could take any effect, so the caller may send the identical request again
// instead of surfacing the failure. It rides the envelope as a separate boolean precisely because
// `error` itself must stay a plain readable string.
//
// `kept` is the other half of a failed follow-up: the server recorded the message in its delivery
// ledger (server/src/delivery-ledger.ts, the write-ahead entry) before the failure, and still holds it
// as a failed send the operator can retry or edit. The client then leaves the words where the server
// keeps them instead of also pushing them back into the prompt box.
function errorEnvelope(err: any): { error: string; retryable?: true; kept?: true } {
  const error = err?.message ?? "Internal server error"
  return {
    error,
    ...(err?.retryableDelivery === true ? { retryable: true as const } : {}),
    ...(err?.deliveryKept === true ? { kept: true as const } : {}),
  }
}

// ---- Mount router onto Hono ----

export function mountRouter(app: Hono, prefix: string, router: Router) {
  // Serve the procedure map so the client can self-configure
  const procMap = extractProcedureMap(router)
  app.get(`${prefix}/__procedures`, (c) => c.json(procMap))

  for (const [name, proc] of Object.entries(router)) {
    // Annotated so arktype's precompiler (@ark/aot) can tell the key is not a Type it would have to
    // stringify; it cannot infer that from `Object.entries` over a record holding Types.
    const routeName: string = name
    const path = `${prefix}/${routeName}`

    if (proc._tag === "query") {
      app.get(path, async (c) => {
        const rawInput = c.req.query("input")
        let input: unknown
        if (rawInput) {
          try {
            input = JSON.parse(decodeURIComponent(rawInput))
          } catch {
            return c.json({ error: "Invalid input JSON" }, 400)
          }
        }
        if (proc.input) {
          const parsed = parseInput(proc.input, input)
          if ("error" in parsed) return c.json({ error: parsed.error }, 400)
          input = parsed.input
        }
        try {
          const result = await proc.handler(input !== undefined ? { input } : {} as any)
          return c.json({ result })
        } catch (err: any) {
          return c.json(errorEnvelope(err), 500)
        }
      })
    } else if (proc._tag === "mutation") {
      app.post(path, async (c) => {
        let input: unknown
        const contentType = c.req.header("content-type")
        if (contentType?.includes("application/json")) {
          input = await c.req.json()
        }
        if (proc.input) {
          const parsed = parseInput(proc.input, input)
          if ("error" in parsed) return c.json({ error: parsed.error }, 400)
          input = parsed.input
        }
        try {
          const result = await proc.handler({ input } as any)
          return c.json({ result: result ?? null })
        } catch (err: any) {
          return c.json(errorEnvelope(err), 500)
        }
      })
    } else if (proc._tag === "stream") {
      app.get(path, async (c) => {
        const rawInput = c.req.query("input")
        let input: unknown
        if (rawInput) {
          try {
            input = JSON.parse(decodeURIComponent(rawInput))
          } catch {
            return c.json({ error: "Invalid input JSON" }, 400)
          }
        }
        if (proc.input) {
          const parsed = parseInput(proc.input, input)
          if ("error" in parsed) return c.json({ error: parsed.error }, 400)
          input = parsed.input
        }
        return streamSSE(c, async (sseStream) => {
          let id = 0
          const gen = proc.handler(input !== undefined ? { input } : {} as any)
          for await (const event of gen) {
            // Annotated for the same reason as `routeName`: the event is data, not a Type to serialize.
            const payload: {} | null = event
            await sseStream.writeSSE({
              data: JSON.stringify(payload),
              id: String(id++),
            })
          }
        })
      })
    }
  }

  // Registered LAST so every concrete procedure above wins the match: an unknown name under this prefix
  // is almost always version SKEW rather than a routing accident, because an ntwine worker's MCP server is
  // spawned once from the build its session was dispatched with and outlives every server restart — it
  // keeps POSTing whatever procedure names THAT build knew. Hono's fall-through answers those with a bare
  // `404 Not Found` naming nothing, which is exactly how a renamed procedure cost a live worker three
  // silent retries and a debugging session. Name the procedure and say what a 404 here MEANS, in the
  // readable-string `error` field both clients surface verbatim.
  app.all(`${prefix}/:procedure`, (c) =>
    c.json(
      {
        error:
          `unknown RPC procedure \`${c.req.param("procedure")}\` — this server does not implement it. ` +
          `A caller built against a different version of ntwine is the usual cause.`,
      },
      404,
    ))
}
