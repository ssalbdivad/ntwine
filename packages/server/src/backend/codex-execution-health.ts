import { execFile } from "node:child_process"

// This reads a local launchd service, not DNS configuration or an Internet endpoint. Offline/VPN
// changes must not invalidate a listener. Run it THROUGH Codex: a newly restarted ntwine can be healthy
// while the detached app-server still has the previous login session's dead bootstrap context.
export const MACOS_SERVICE_PROBE = ["/bin/launchctl", "print", "system/com.apple.configd"]
export const MACOS_SERVICE_PROBE_TIMEOUT_MS = 3_000

export interface ExecutionHealthConnection {
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>
}

export function probeHostMacOSServices(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(MACOS_SERVICE_PROBE[0]!, MACOS_SERVICE_PROBE.slice(1), {
      timeout: MACOS_SERVICE_PROBE_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024,
    }, (error) => resolve(!error))
  })
}

export class CodexExecutionHealth {
  private readonly checking = new WeakMap<ExecutionHealthConnection, Promise<void>>()

  private readonly platform: NodeJS.Platform
  private readonly hostProbe: () => Promise<boolean>

  constructor(
    platform: NodeJS.Platform = process.platform,
    hostProbe: () => Promise<boolean> = probeHostMacOSServices,
  ) {
    this.platform = platform
    this.hostProbe = hostProbe
  }

  check(connection: ExecutionHealthConnection, scope: string): Promise<void> {
    if (this.platform !== "darwin") return Promise.resolve()
    const pending = this.checking.get(connection)
    if (pending) return pending
    // Share concurrent probes, but never cache success across admissions: the login session can
    // disappear without the transport disconnecting. Failure never kills or replaces the backend.
    const check = this.probe(connection, scope)
    this.checking.set(connection, check)
    void check.finally(() => this.checking.delete(connection)).catch(() => undefined)
    return check
  }

  private async probe(connection: ExecutionHealthConnection, scope: string): Promise<void> {
    let detail: string
    try {
      const raw = await connection.request("command/exec", {
        command: MACOS_SERVICE_PROBE,
        cwd: "/",
        timeoutMs: MACOS_SERVICE_PROBE_TIMEOUT_MS,
        sandboxPolicy: { type: "dangerFullAccess" },
      }, MACOS_SERVICE_PROBE_TIMEOUT_MS + 1_000)
      const result = raw as { exitCode?: unknown; stdout?: unknown; stderr?: unknown } | null
      if (result?.exitCode === 0 && typeof result.stdout === "string" && result.stdout.includes("system/com.apple.configd = {")) return
      detail = typeof result?.exitCode === "number" ? `launchctl exited ${result.exitCode}` : "invalid probe response"
    } catch {
      detail = "the local service probe failed or timed out"
    }
    const hostHealthy = await this.hostProbe().catch(() => false)
    throw new Error(
      `Codex cannot access macOS system services (${detail}; ${scope}). ` +
      "New conversations and turns are blocked; existing work and conversation history were not changed. " +
      (hostHealthy
        ? "ntwine's host context is healthy, but this backend is not. Stop this project's Codex turns before replacing its shared backend; restarting ntwine alone can reuse it."
        : "ntwine's host context also failed the check. Relaunch ntwine from a fresh terminal after stopping this project's Codex turns; its shared backend must also be replaced."),
    )
  }
}
