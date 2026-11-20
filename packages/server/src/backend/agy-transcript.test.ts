import { test } from "node:test"
import assert from "node:assert/strict"
import { projectAgyTranscript } from "./agy-transcript.ts"

// Steps verbatim in shape from a real swarm worker's transcript (agy 1.5.11, member armstrong-ga-pr).
const lines = [
  { step_index: 0, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE", created_at: "2026-11-20T20:39:35Z", content: "The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-20T20:39:35Z sender=87bf2304 priority=MESSAGE_PRIORITY_HIGH content=[swarm] new board message #162\n</SYSTEM_MESSAGE>" },
  { step_index: 1, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE", created_at: "2026-11-20T20:39:35Z", content: "<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-20T20:39:35Z sender=87bf2304 priority=MESSAGE_PRIORITY_HIGH content=You have just started. Your assignment:\n\nReview `origin/main..b519c2434`.\n</SYSTEM_MESSAGE>" },
  { step_index: 2, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-20T20:39:35Z", content: "Reading the skill first.", tool_calls: [
    { name: "read_file", args: { Path: "\"/Users/x/SKILL.md\"" } },
    { name: "run_command", args: { CommandLine: "\"git status -sb\"", WaitMsBeforeAsync: "5000", toolSummary: "\"Check git status\"" } },
  ] },
  { step_index: 3, source: "MODEL", type: "GENERIC", status: "DONE", created_at: "2026-11-20T20:39:39Z", content: "1: ---\n2: name: armstrong" },
  { step_index: 4, source: "MODEL", type: "GENERIC", status: "ERROR", created_at: "2026-11-20T20:39:40Z", error: "exit 128" },
  { step_index: 5, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-20T20:41:00Z", content: "**APPROVED**" },
].map((l) => JSON.stringify(l)).join("\n")

test("projectAgyTranscript: the assignment is the request, a board wake is punctuation, and calls carry their results", () => {
  const out = projectAgyTranscript(lines + "\n{\"step_index\":6,\"type\":\"PLANN", "agy:x")
  assert.deepEqual(out.map((m) => [m.role, m.kind ?? "", m.text.split("\n")[0]]), [
    ["assistant", "event", "[swarm] new board message #162"],
    ["user", "", "You have just started. Your assignment:"],
    ["assistant", "", "Reading the skill first."],
    ["assistant", "", "**APPROVED**"],
  ])
  assert.equal(out[1]!.text, "You have just started. Your assignment:\n\nReview `origin/main..b519c2434`.")
  const [read, cmd] = out[2]!.tools
  // agy JSON-encodes every argument value; what the drawer shows is the decoded one.
  assert.deepEqual(read, { name: "read_file", detail: "/Users/x/SKILL.md", input: JSON.stringify({ Path: "/Users/x/SKILL.md" }, null, 2), status: "completed", output: "1: ---\n2: name: armstrong" })
  assert.deepEqual(cmd, { name: "run_command", detail: "git status -sb", desc: "Check git status", command: "git status -sb", status: "failed", output: "exit 128" })
  assert.deepEqual(out[2]!.parts.map((p) => p.kind), ["text", "tools"])
  assert.equal(out[3]!.sourceId, "agy:x:5")
  assert.equal(out[3]!.at, "2026-11-20T20:41:00Z")
})
