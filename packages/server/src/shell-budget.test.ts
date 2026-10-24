// The budget warning is composed here and drawn by the chat from its head alone (shared
// parseShellBudgetWake), so the two are pinned together: a reworded head fails here.
import { test } from "node:test"
import assert from "node:assert/strict"
import { parseShellBudgetWake } from "@ntwine/shared"
import { shellBudgetWarningMessage } from "./shell-budget.ts"

test("a budget warning reads back the shell, how long it ran and what it was allowed", () => {
  const text = shellBudgetWarningMessage({ handle: "b5htn6rlx", label: "vite (dev server) --port 5199", ranMs: 31 * 60_000, budgetMs: 30 * 60_000, stoppable: true, backend: "claude" })
  assert.deepEqual(parseShellBudgetWake(text), { handle: "b5htn6rlx", label: "vite (dev server) --port 5199", ran: "31m", budget: "30m" })
})
