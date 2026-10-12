import { test } from "node:test"
import assert from "node:assert/strict"
import type { ThreadView } from "@frizz/shared"
import { queueOpsCounts } from "./queueOpsCounts.ts"

// The drawer hands the counts the shells it reads off the transcript, which the board reports none of for
// a Codex thread — and reports AGAIN for a Claude one. The line has to count the first and must not count
// the second twice, or the drawer and the queue card disagree about one thread.
const thread = (bgShells: ThreadView["bgShells"]) => ({ id: "t", subAgents: [], watches: [], links: [], bgShells }) as unknown as ThreadView
const BOARD_SHELL = { id: "toolu_a", label: "Run the dev server", startedAt: "2026-10-09T10:00:00.000Z", state: "running" as const }

test("the counts take the drawer's transcript shells, once each", () => {
  const codex = { label: "Tail the build log", startedAt: "2026-10-09T10:01:00.000Z", state: "running" as const }
  const claudeCopy = { ...BOARD_SHELL, id: undefined, launchId: "toolu_a", startedAt: "2026-10-09T10:00:04.000Z" }
  assert.deepEqual(queueOpsCounts(thread([BOARD_SHELL])).map(({ key, n }) => ({ key, n })), [{ key: "terminal", n: 1 }])
  assert.deepEqual(queueOpsCounts(thread([BOARD_SHELL]), { transcriptShells: [claudeCopy] }).map(({ key, n }) => ({ key, n })), [{ key: "terminal", n: 1 }], "the board's own shell is not counted twice")
  assert.deepEqual(queueOpsCounts(thread([BOARD_SHELL]), { transcriptShells: [codex] }).map(({ key, n }) => ({ key, n })), [{ key: "terminal", n: 2 }])
  assert.deepEqual(queueOpsCounts(thread([]), { transcriptShells: [codex] }).map(({ key, n }) => ({ key, n })), [{ key: "terminal", n: 1 }], "a Codex shell the board never reports still counts")
})
