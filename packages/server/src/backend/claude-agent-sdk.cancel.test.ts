// THE CANARY for taking a queued message back.
//
// `cancelAsyncMessage` is real at runtime in @anthropic-ai/claude-agent-sdk but absent from its
// `.d.ts` `Query` interface — so the compiler cannot see it, and an SDK bump that renamed or dropped
// it would typecheck clean, pass every other test, and only surface as a failed click in front of the
// operator. That is exactly the drift a canary is for.
//
// It costs nothing to run: `query()` constructs its Query and returns it BEFORE spawning the CLI, so
// this needs no `claude` binary, no credentials, no child process and no network. The bogus executable
// path is the proof — anything that actually launched would fail on it.
import { test } from "node:test"
import assert from "node:assert/strict"
import { query } from "@ntwine/claude-agent-sdk-runtime"
import { CLAUDE_SDK_CANCEL_METHOD } from "./claude-agent-sdk.ts"

function unspawnedQuery(): Record<string, unknown> {
  return query({
    // An input stream that never yields: nothing here should ever get as far as consuming it.
    prompt: (async function* () {})() as never,
    options: {
      cwd: process.cwd(),
      pathToClaudeCodeExecutable: "/nonexistent/claude-must-never-be-spawned-by-this-test",
      settingSources: [],
      persistSession: false,
    } as never,
  }) as unknown as Record<string, unknown>
}

test("the SDK still exposes the queued-input cancel method ntwine reaches for", () => {
  const q = unspawnedQuery()
  assert.equal(
    typeof q[CLAUDE_SDK_CANCEL_METHOD],
    "function",
    `@anthropic-ai/claude-agent-sdk no longer exposes Query.${CLAUDE_SDK_CANCEL_METHOD}. It is undeclared in the ` +
    `SDK's .d.ts, so nothing else in this repo would have caught that — unqueueing a follow-up is broken ` +
    `until claude-agent-sdk.ts is pointed at whatever replaced it.`,
  )
})

test("the canary would actually fail if the method vanished", () => {
  // A canary nobody has watched fail is a canary that might be asserting nothing. Prove the negative:
  // the same check against an object WITHOUT the method must throw.
  assert.throws(() => {
    const bare: Record<string, unknown> = {}
    assert.equal(typeof bare[CLAUDE_SDK_CANCEL_METHOD], "function")
  })
})

test("interrupt is still there too — the same undeclared-surface risk, one level up", () => {
  // Not strictly this feature's, but it rides the identical private control channel and has the same
  // invisible-to-the-compiler failure mode, so it is watched from the same place.
  assert.equal(typeof unspawnedQuery().interrupt, "function")
})
