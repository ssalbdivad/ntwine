import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { mapPrefix, relocateJsonl, relocateRecord, type RelocationRules } from "./transcript-relocate.ts"

const rules: RelocationRules = {
  cwd: [
    { from: "/Users/ssalb", to: "/home/ssalb" },
    { from: "/Users/ssalb/code/ntwine", to: "/home/ssalb/ntwine" },
  ],
  refs: [{ from: "/Users/ssalb/.claude/projects/-Users-ssalb-code-ntwine/sid-1", to: "/home/ssalb/.claude/projects/-home-ssalb-ntwine/sid-1" }],
}

describe("relocating a moved transcript", () => {
  it("maps a cwd by its longest matching prefix, and never a sibling that only shares the prefix", () => {
    assert.equal(mapPrefix("/Users/ssalb/code/ntwine/.ntwine/worktrees/feat", rules.cwd), "/home/ssalb/ntwine/.ntwine/worktrees/feat")
    assert.equal(mapPrefix("/Users/ssalb/other", rules.cwd), "/home/ssalb/other")
    assert.equal(mapPrefix("/Users/ssalbx/code", rules.cwd), "/Users/ssalbx/code")
    assert.equal(mapPrefix("/tmp/scratch", rules.cwd), "/tmp/scratch")
  })

  it("rewrites the record's cwd and references to moved files, and leaves the conversation's words alone", () => {
    const record = {
      type: "user",
      cwd: "/Users/ssalb/code/ntwine",
      message: {
        role: "user",
        content: [
          { type: "text", text: "his Mac at /Users/ssalb and his desktop at /home/ssalb" },
          { type: "tool_result", content: "Output saved to: /Users/ssalb/.claude/projects/-Users-ssalb-code-ntwine/sid-1/tool-results/x.txt" },
        ],
      },
    }
    const out = JSON.parse(relocateRecord(JSON.stringify(record), rules))
    assert.equal(out.cwd, "/home/ssalb/ntwine")
    assert.equal(out.message.content[0].text, "his Mac at /Users/ssalb and his desktop at /home/ssalb")
    assert.equal(out.message.content[1].content, "Output saved to: /home/ssalb/.claude/projects/-home-ssalb-ntwine/sid-1/tool-results/x.txt")
  })

  it("never touches a signed thinking block, even where a reference rule matches inside it", () => {
    const thinking = { type: "thinking", thinking: "read /Users/ssalb/.claude/projects/-Users-ssalb-code-ntwine/sid-1/tool-results/x.txt", signature: "sig" }
    const line = JSON.stringify({ type: "assistant", cwd: "/Users/ssalb/code/ntwine", message: { content: [thinking, { type: "redacted_thinking", data: "/Users/ssalb/.claude/projects/-Users-ssalb-code-ntwine/sid-1" }] } })
    const out = JSON.parse(relocateRecord(line, rules))
    assert.deepEqual(out.message.content[0], thinking)
    assert.equal(out.message.content[1].data, "/Users/ssalb/.claude/projects/-Users-ssalb-code-ntwine/sid-1")
    assert.equal(out.cwd, "/home/ssalb/ntwine")
  })

  it("returns a line no rule touches, or that is not JSON, byte for byte", () => {
    const untouched = '{"type":"summary",  "summary":"x"}'
    assert.equal(relocateRecord(untouched, rules), untouched)
    const text = `${untouched}\nnot json\n\n`
    assert.equal(relocateJsonl(text, rules), text)
  })
})
