// LIVE PROBE: when the broker daemon throws where nothing is catching, does it still say so?
//   nub packages/server/src/backend/_live_broker_crash_breadcrumb.mts
//
// Why this exists. Every deliberate exit path in claude-agent-broker.ts records a breadcrumb — the
// signal handlers, shutdown(), the event pump, the reachability self-collection. A throw that reached
// nobody recorded nothing, and node's default for that (print a stack, exit 1) writes the stack to a
// stdio the HOST sets to "ignore" (forkClaudeBroker in claude-broker-host.ts). So the diagnostics log
// simply ended, which is byte-identical to what an external SIGKILL leaves behind.
//
// That ambiguity was not academic. Measured across this machine's whole broker corpus on 2026-08-02:
// 276 daemon `started` records against 223 recorded exits — 53 deaths (~19%) with no attribution at
// all, reported to the operator as "the broker daemon is gone and left no exit record (killed
// outright, or it predates exit breadcrumbs)". With no breadcrumb there was no way to tell ntwine's own
// unhandled throw from something outside ntwine killing the process, and those want opposite fixes.
//
// The probe spawns the REAL daemon entry the REAL way — `stdio: "ignore"`, config in
// NTWINE_CLAUDE_BROKER — so the stack really does go nowhere, and asserts an attributed record lands
// anyway. Run it with the handlers removed and the log does not even exist (verified 2026-08-02).
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dir = mkdtempSync(join(tmpdir(), "broker-crash-breadcrumb-"))
const logPath = join(dir, "probe.diagnostics.log")
const entry = new URL("./claude-agent-broker.ts", import.meta.url).pathname

// `claudeBin` points at nothing, which is enough to drive the daemon into a startup throw on a path
// with no handler of its own — the shape under test. What matters is only that the throw is UNCAUGHT.
const config = {
  sessionId: "crash-breadcrumb-probe",
  socketPath: join(dir, "s.sock"),
  recordPath: join(dir, "r.json"),
  diagnosticLogPath: logPath,
  generation: "gen-probe",
  cwd: dir,
  claudeBin: "/nonexistent/claude",
}

const child = spawn(process.execPath, ["--experimental-strip-types", entry], {
  env: { ...process.env, NTWINE_CLAUDE_BROKER: JSON.stringify(config) },
  stdio: "ignore",
})
const timer = setTimeout(() => { try { process.kill(child.pid!, "SIGKILL") } catch { /* already gone */ } }, 20_000)
const code = await new Promise<number | null>((resolve) => child.on("exit", resolve))
clearTimeout(timer)

let failures = 0
const ok = (label: string, cond: boolean, detail = ""): void => {
  if (!cond) failures++
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
}

const lines = existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n").filter(Boolean) : []
const records = lines.map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
const exit = records.find((r) => r?.exit?.reason)

console.log(`daemon exit code: ${code}`)
for (const r of records) console.log(`  ${r.exit ? `EXIT reason=${r.exit.reason}` : `diag ${JSON.stringify(r.diagnostic).slice(0, 90)}`}`)

ok("the crash is ATTRIBUTED rather than silent", Boolean(exit), exit ? `reason=${exit.exit.reason}` : "no exit record at all")
ok("and named as an uncaught throw", exit?.exit?.reason === "uncaught-exception" || exit?.exit?.reason === "unhandled-rejection", String(exit?.exit?.reason))
// Node's own semantics are preserved: installing the handler suppresses the default exit, so the
// explicit non-zero exit is load-bearing. Without it a crashed daemon LINGERS, wedged and unreachable.
ok("the daemon still dies, non-zero, exactly as an unhandled throw would", code === 1, `code=${String(code)}`)

rmSync(dir, { recursive: true, force: true })
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
