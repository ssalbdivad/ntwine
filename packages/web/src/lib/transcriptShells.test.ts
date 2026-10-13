import assert from "node:assert/strict"
import test from "node:test"
import type { ChatMessage } from "../hooks.ts"
import { transcriptBackgroundShells } from "./childOps.ts"

// A CODEX SHELL'S FOLDER, AS THE TRANSCRIPT NAMES IT. The tool call's `workdir` rides onto the strip's row for
// its tooltip ("Runs in …") — but Codex reads a relative `workdir` against its session's folder, which the
// browser does not know, so a relative one named no place: `Runs in packages/web`.
const live = (cwd: string | undefined, id: string) => ({
  name: "Bash", detail: "cargo watch", command: "cargo watch -x test", status: "pending", backgroundState: "background", shellId: id, ...(cwd ? { cwd } : {}),
})
const message = (tools: unknown[]) => ({ role: "assistant", at: "2026-09-30T10:00:00.000Z", tools, parts: [] }) as unknown as ChatMessage

test("a live Codex shell carries its tool call's folder only when that folder is absolute", () => {
  const shells = transcriptBackgroundShells([message([live("/home/u/repo/.ntwine/worktrees/probe", "c1"), live("packages/web", "c2"), live(undefined, "c3"), live("C:\\repo\\web", "c4")])])
  assert.deepEqual(shells.map((s) => [s.launchId, s.cwd]), [
    ["c1", "/home/u/repo/.ntwine/worktrees/probe"],
    ["c2", undefined],
    ["c3", undefined],
    ["c4", "C:\\repo\\web"],
  ])
})
