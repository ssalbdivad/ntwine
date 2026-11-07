import "./ark-config.ts"

// The ONE `type` every ntwine schema is written with — import it from here (`@ntwine/shared/ark`), never
// straight from "arktype". Importing it from here is what guarantees `./ark-config.ts` has run first.
//
// It differs from arktype's default in a single setting, `exactOptionalPropertyTypes: false` (set in
// `./ark-config.ts`): an optional key accepts an explicit `undefined` as well as a missing one. That is what
// the TypeScript side already says (this repo does not enable `exactOptionalPropertyTypes`, so
// `{ effort?: string }` takes `{ effort: undefined }`), and what the zod schemas did at runtime before the
// arktype migration.
//
// The other zod default arktype does not share is STRIPPING undeclared keys. Every object that zod stripped
// says so itself instead: `"+": "delete"`. A `.strict()` object is `"+": "reject"`, and a `.passthrough()`
// one declares nothing.
export { ArkErrors, type, type Traversal, type Type } from "arktype"
