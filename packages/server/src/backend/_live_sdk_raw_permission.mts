// LIVE spike (positive proof): the Claude Agent SDK permission round-trip works against REAL claude
// with subscription auth. Drives @anthropic-ai/claude-agent-sdk's query() directly (streaming input +
// canUseTool), the same surface ntwine's backend wraps — isolating the SDK from ntwine's wrapper.
//   nub packages/server/src/backend/_live_sdk_raw_permission.mts
//
// Proves: (1) subscription/OAuth auth (apiKeySource "none", no API key); (2) real tools run;
// (3) a gated tool (Write) routes through canUseTool as a TYPED request we answer allow/deny, and the
// decision reaches the model (it reports BLOCKED on deny). This is parity with the Codex app-server
// approval flow — the capability Option A buys, replacing today's TUI-scrape + keystroke-inject.
//
// NOTE: ntwine's own backend (claude-agent-sdk.ts) does NOT yet drive real claude — see
// _live_sdk_permission.mts, which reproduces its two mock-hidden bugs. This harness proves the SDK
// itself is sound, so the remaining work is fixing ntwine's wrapper, not the direction.
import { query } from "@ntwine/claude-agent-sdk-runtime"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const claude = execFileSync("which", ["claude"], { encoding: "utf8" }).trim()
const cwd = mkdtempSync(join(tmpdir(), "ntwine-sdk-raw-"))
execFileSync("git", ["init", "-q", cwd])
const env = Object.fromEntries(["PATH", "HOME", "USER", "LANG", "SHELL", "TMPDIR"].filter((k) => process.env[k]).map((k) => [k, process.env[k]!]))

let fired = 0
let deniedInput = ""
const canUseTool = async (toolName: string, input: Record<string, unknown>) => {
  fired++
  deniedInput = JSON.stringify(input)
  console.log(`  >> canUseTool FIRED: tool=${toolName} input=${deniedInput.slice(0, 80)} -> DENY`)
  return { behavior: "deny" as const, message: "Denied by the spike (proving the permission round-trip)." }
}

// Streaming input (async iterable) — exactly how ntwine's backend feeds the SDK.
async function* prompt() {
  yield {
    type: "user" as const,
    message: { role: "user" as const, content: "Use the Write tool to create a file named secret.txt containing hi. If you are blocked, reply with the single word BLOCKED." },
    parent_tool_use_id: null,
    session_id: "",
  }
}

const timer = setTimeout(() => { console.log("\nFAIL — timed out"); process.exit(2) }, 90_000)
let sawInit = false
let apiKeySource = "?"
let model = "?"
let modelSaidBlocked = false
try {
  for await (const msg of query({ prompt: prompt(), options: { cwd, env, pathToClaudeCodeExecutable: claude, permissionMode: "default", settingSources: [], persistSession: false, canUseTool } as never })) {
    const m = msg as Record<string, any>
    if (m.type === "system" && m.subtype === "init") { sawInit = true; apiKeySource = m.apiKeySource; model = m.model }
    if (m.type === "assistant") {
      const text = (m.message?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join(" ")
      if (/\bBLOCKED\b/.test(text)) modelSaidBlocked = true
    }
    if (m.type === "result") break
  }
} finally {
  clearTimeout(timer)
  rmSync(cwd, { recursive: true, force: true })
}

const ok = (label: string, cond: boolean, detail = "") => console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
console.log("")
ok("SDK drove real claude (init received)", sawInit, `model=${model}`)
ok("subscription/OAuth auth (no API key)", apiKeySource === "none", `apiKeySource=${apiKeySource}`)
ok("gated tool routed through canUseTool as a typed request", fired > 0, `tool input=${deniedInput.slice(0, 60)}`)
ok("the DENY reached the model (it reported BLOCKED)", modelSaidBlocked)
const pass = sawInit && apiKeySource === "none" && fired > 0 && modelSaidBlocked
console.log(pass ? "\nPERMISSION ROUND-TRIP PROVEN" : "\nNOT PROVEN")
process.exit(pass ? 0 : 1)
