import { test } from "node:test"
import assert from "node:assert/strict"
import { parkItemLine } from "./parkItems.ts"

const names: Record<string, string> = { a8ba0911: "Survey the fence grammar", b5htn6rlx: "vite --port 5199" }
const nameOf = (_key: string, value: string) => names[value]

test("a named child reads as its kind, its name and its state", () => {
  assert.equal(parkItemLine("- `agents: [a8ba0911]` — still running", nameOf), "Sub-agent «Survey the fence grammar» — still running")
  assert.equal(parkItemLine("- `shells: [b5htn6rlx]` — FINISHED — its result is waiting for you", nameOf), "Agent terminal «vite --port 5199» — finished")
})

test("a child the board no longer has falls back to its id, and a thread to its handle", () => {
  assert.equal(parkItemLine("- `agents: [c3d4e5]` — SILENT — nothing from it since 10:02, longer than any call it has pending declared", nameOf), "Sub-agent c3d4e5 — silent")
  assert.equal(parkItemLine("- `threads: [deploy-fix]` — LAPSED — no reply came while the wait stood; read where it is", nameOf), "Thread @deploy-fix — lapsed")
  assert.equal(parkItemLine("- `timers: [tmr_1]` — already FIRED — its wake was delivered", nameOf), "Timer tmr_1 — already fired")
})

test("the counted lines drop their instruction, and steps say who they wait on", () => {
  assert.equal(parkItemLine("- `questions:` (2) — not answered yet; name the ones you still need in your next fence", nameOf), "2 questions — not answered yet")
  assert.equal(parkItemLine("- `steps:` (1) — the user has not replied; check whether they were done anyway", nameOf), "1 step — waiting on you")
})

test("a line in no shape it knows is shown as it came", () => {
  assert.equal(parkItemLine("Something else entirely", nameOf), "Something else entirely")
})
