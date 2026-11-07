import { configure } from "arktype/config"

// arktype's global config for every ntwine Type: an optional key accepts an explicit `undefined` (see
// `./ark.ts`). `ark.json` names this module as the precompiler's `config`, so the build applies it to every
// definition and fails where a module creates a Type before it runs.
configure({ exactOptionalPropertyTypes: false })
