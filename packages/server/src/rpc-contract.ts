// ── The RPC drift gate ───────────────────────────────────────────────────────────────────────────
//
// `packages/web/src/api/contract.ts` declares the typed surface every browser call site is checked
// against. It used to be a HAND-WRITTEN mirror of this package's router, carrying a TODO that said so,
// and it drifted: commit c288c91 added `sessionId: z.string().min(1)` to completeThread's `.strict()`
// input and nothing on the client changed, so "Mark as done" answered every click with
// `Couldn't finish: sessionId: Required`. A schema edit reached the operator as a runtime toast
// because nothing compared the two declarations.
//
// This module IS that comparison, at the type level. It imports the real router type and the real
// client contract and proves, procedure by procedure:
//   • the procedure NAME SETS are equal              (a new server RPC is unreachable from the client;
//                                                     a removed one 404s every call site)
//   • each `Parameters<Api[k]>[0]` equals `z.input<>` of that procedure's zod input
//   • each awaited return type equals `z.infer<>` of its zod output (or void)
//   • each entry of the client's GET/POST table equals the procedure's `_tag`
// Every assertion is a `type … = Expect<…>` whose failure message NAMES the drifting procedure.
//
// WHY A TYPE ASSERTION HERE, RATHER THAN DERIVING `type Api` FROM `AppRouter` IN THE WEB PACKAGE
// (the shape the old TODO proposed): the web package deliberately compiles with `"types": []` and no
// node typings, and it does not depend on `@ntwine/server`. Importing the router type into the web
// program would drag every server source it transitively references (node:fs, node:child_process,
// ws) into a browser typecheck, which only works by handing browser code the node globals those
// guardrails exist to withhold. Running the comparison from the SERVER program instead costs nothing:
// this package already typechecks the router and already has node types, `contract.ts` is pure types
// plus one const so it compiles cleanly with no DOM lib, and `npm run typecheck` already builds this
// package BEFORE the web one. The binding invariant is identical — a server schema change the client
// does not satisfy fails `npm run typecheck` — and it fails one step earlier, naming the procedure.
//
// This file is type-only and is imported by nothing at runtime, so it never enters the server bundle.
// `rpc-contract.test.ts` covers the same ground at runtime for the parts a type cannot see (the real
// zod objects actually reaching Hono, and the strictness of each input schema).
import type { z } from "zod"
import type { Api, PROCEDURES } from "../../web/src/api/contract.ts"
import type { AppRouter } from "./router.ts"

// ---- assertion primitives ----

// Mutual assignability. Wrapped in tuples so a naked union/never can't distribute the conditional.
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

// A failing assertion reads `Type '"completeThread"' does not satisfy the constraint 'never'` — the
// drifting procedure name IS the error message.
type Expect<Drift extends never> = Drift

// ---- what the router says ----

type ZodOrNever<S> = [S] extends [undefined] ? never : Extract<S, z.ZodType>

type RouterInput<K extends keyof AppRouter> =
  ZodOrNever<AppRouter[K] extends { input?: infer S } ? S : undefined> extends infer Schema
    ? [Schema] extends [never]
      ? undefined // no input schema ⇒ the client passes nothing
      : Schema extends z.ZodType ? z.input<Schema> : never
    : never

type RouterOutput<K extends keyof AppRouter> =
  ZodOrNever<AppRouter[K] extends { output?: infer S } ? S : undefined> extends infer Schema
    ? [Schema] extends [never]
      ? void // a mutation with no output schema resolves to null / void
      : Schema extends z.ZodType ? z.infer<Schema> : never
    : never

type RouterKind<K extends keyof AppRouter> = AppRouter[K]["_tag"]

// ---- what the client says ----

// Positional, so the client-only trailing `opts?: RpcCallOpts` argument stays invisible to the gate.
type ClientInput<K extends keyof Api> = Parameters<Api[K]>[0]
type ClientOutput<K extends keyof Api> = Awaited<ReturnType<Api[K]>>

// ---- the assertions ----

type Shared = keyof AppRouter & keyof Api

/** A procedure the router serves that the client cannot call at all (rpc.<name> is `undefined`). */
type UnreachableProcedures = Exclude<keyof AppRouter, keyof Api>
type _NoUnreachableProcedures = Expect<UnreachableProcedures>

/** A procedure the client declares that no longer exists server-side (every call 404s). */
type PhantomProcedures = Exclude<keyof Api, keyof AppRouter>
type _NoPhantomProcedures = Expect<PhantomProcedures>

/** Missing field, extra field a `.strict()` schema rejects, wrong scalar type, wrong enum member. */
type InputDrift = {
  [K in Shared]: Exact<ClientInput<K>, RouterInput<K>> extends true ? never : K
}[Shared]
type _NoInputDrift = Expect<InputDrift>

/** The client reads a field the server stopped returning (or mistypes one it does). */
type OutputDrift = {
  [K in Shared]: Exact<ClientOutput<K>, RouterOutput<K>> extends true ? never : K
}[Shared]
type _NoOutputDrift = Expect<OutputDrift>

/** A query flipped to a mutation (or back): the client would keep using GET and take a 404/405. */
type KindDrift = {
  [K in Shared & keyof typeof PROCEDURES]:
    Exact<(typeof PROCEDURES)[K], RouterKind<K>> extends true ? never : K
}[Shared & keyof typeof PROCEDURES]
type _NoKindDrift = Expect<KindDrift>
