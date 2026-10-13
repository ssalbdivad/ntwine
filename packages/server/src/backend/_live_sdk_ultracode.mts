// LIVE integration test: prove that selecting the "ultracode" effort rung in ntwine actually brings a
// REAL Claude session up with ultracode ON, through ntwine's own SDK backend — the seam no unit test
// reaches. The unit tests pin the argv/options SHAPE; this pins the OUTCOME.
//
// The differential is the point. Ultracode is a session setting that Claude silently ignores when the
// launch effort is anything but xhigh, so a harness with no negative control would "pass" against a
// build that never sent the flag at all. Three sessions, one variable each:
//   effort "ultracode" → ON      (the change under test)
//   effort "xhigh"     → OFF     (proves ON came from the flag, not from xhigh reasoning alone)
//   effort "high"      → OFF     (an ordinary dispatch must not silently gain orchestration)
//
//   nub packages/server/src/backend/_live_sdk_ultracode.mts
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { createClaudeQueryFactory } from "./claude-agent-sdk.ts"
import type { ClaudeQueryEvent } from "./claude-agent-sdk-protocol.ts"

const claudeBin = execFileSync("which", ["claude"], { encoding: "utf8" }).trim()
let failures = 0
const ok = (label: string, cond: boolean, detail = "") => { if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`) }

const ALLOWLIST = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]
const env = Object.fromEntries(ALLOWLIST.filter((k) => process.env[k] != null).map((k) => [k, process.env[k]!])) as Record<string, string>

const PROMPT = "Answer with exactly one word and nothing else. Do your system reminders say that ultracode is ON for this session? Answer YES or NO."

// One session at the given ntwine effort rung; returns the model's verdict text.
async function askUltracode(effort: string): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), "ntwine-sdk-ultracode-"))
  execFileSync("git", ["init", "-q", cwd])
  const sessionId = randomUUID()
  const handle = createClaudeQueryFactory({ enabled: true, executablePath: claudeBin }).start({
    cwd,
    session: { kind: "new", sessionId },
    permissionMode: "default",
    env,
    model: "opus",
    effort,
    // Hermetic: no project CLAUDE.md in a temp dir anyway, but be explicit so a stray config cannot
    // colour the answer.
    settingSources: [],
    canUseTool: async () => ({ behavior: "allow" }),
  })

  const collected: ClaudeQueryEvent[] = []
  let resolveTurn: () => void = () => {}
  const done = new Promise<void>((r) => { resolveTurn = r })
  const pump = (async () => {
    try {
      for await (const ev of handle) {
        collected.push(ev)
        if (ev.kind === "result") resolveTurn()
      }
    } catch { /* the close below ends the stream */ }
  })()

  try {
    await handle.send({ id: randomUUID(), text: PROMPT })
    let timer: NodeJS.Timeout
    await Promise.race([
      done,
      new Promise<void>((_, rej) => { timer = setTimeout(() => rej(new Error(`turn timeout at effort=${effort}`)), 180_000) }),
    ]).finally(() => clearTimeout(timer!))
    return collected.filter((e) => e.kind === "assistant").flatMap((e) => (e as { text: string[] }).text).join(" ").trim()
  } finally {
    await handle.close().catch(() => {})
    await pump.catch(() => {})
    rmSync(cwd, { recursive: true, force: true })
  }
}

const says = (answer: string, want: "YES" | "NO") => new RegExp(`\\b${want}\\b`, "i").test(answer)

try {
  const ultracode = await askUltracode("ultracode")
  console.log(`  effort=ultracode → ${JSON.stringify(ultracode)}`)
  ok("effort 'ultracode' brings the real session up with ultracode ON", says(ultracode, "YES"), ultracode)

  // Negative control #1: xhigh is the effort ultracode RUNS at. If this also said YES, the harness
  // would be measuring the reasoning level rather than the setting ntwine now sends.
  const xhigh = await askUltracode("xhigh")
  console.log(`  effort=xhigh → ${JSON.stringify(xhigh)}`)
  ok("effort 'xhigh' alone does NOT enable ultracode", says(xhigh, "NO"), xhigh)

  // Negative control #2: an ordinary dispatch must be untouched by this change.
  const high = await askUltracode("high")
  console.log(`  effort=high → ${JSON.stringify(high)}`)
  ok("effort 'high' does NOT enable ultracode", says(high, "NO"), high)
} catch (err) {
  failures++
  console.log(`\nHARNESS ERROR: ${err instanceof Error ? err.message : String(err)}`)
} finally {
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}
