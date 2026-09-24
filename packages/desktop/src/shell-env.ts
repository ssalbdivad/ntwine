import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"

/**
 * Variables Electron sets in its own process for Chromium's benefit. They would otherwise ride the
 * environment through the server into every agent — CHROME_DESKTOP, for one, tells a Chrome an agent
 * launches that it is this app.
 */
const ELECTRON_ONLY = new Set(["CHROME_DESKTOP", "FC_FONTATIONS", "NO_AT_BRIDGE", "GDK_BACKEND"])

export function withoutElectronVariables(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (ELECTRON_ONLY.has(key) || key.startsWith("ELECTRON_")) continue
    clean[key] = value
  }
  return clean
}

/**
 * The environment the operator's terminal would have.
 *
 * An app launched from the Dock, Finder or a desktop menu does not inherit a terminal's environment:
 * on macOS launchd hands it `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, and on Linux the session PATH
 * rarely includes what nvm, fnm, volta or a shell rc added. That PATH is not only how this app finds
 * `node` — the server it starts hands its environment to every agent, so git, gh, claude and codex
 * have to be on it too. So the server is started with what an interactive login shell prints.
 *
 * `-i` as well as `-l` because nvm and friends are conventionally wired up in the rc file, which only
 * an interactive shell reads. Markers fence the output, since an rc file is free to print a banner.
 * `env -0` where the platform has it, because a value may contain newlines (an exported bash
 * function prints as several lines, and would otherwise be read as part of the previous variable).
 * Windows GUI apps already inherit the user's PATH from the registry, so there is nothing to do there.
 */
export async function loginShellEnvironment(
  base: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  timeoutMs = 10_000,
): Promise<NodeJS.ProcessEnv> {
  const inherited = withoutElectronVariables(base)
  if (platform === "win32") return inherited
  const shell = inherited.SHELL || (platform === "darwin" ? "/bin/zsh" : "/bin/sh")
  const marker = `__FRIZZ_DESKTOP_ENV_${randomUUID()}__`
  const script = `printf '%s\\n' '${marker}'; command env -0 2>/dev/null || command env; printf '\\n%s\\n' '${marker}'`
  const output = await new Promise<string>((resolve) => {
    let stdout = ""
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(stdout)
    }
    // Its own process group, so a timeout can take down whatever the rc file started with it.
    const child = spawn(shell, ["-ilc", script], {
      // oh-my-zsh otherwise offers to update itself, and would wait for an answer nobody can give.
      env: { ...inherited, DISABLE_AUTO_UPDATE: "true" },
      stdio: ["ignore", "pipe", "ignore"],
      detached: true,
    })
    const timer = setTimeout(() => {
      try { process.kill(-child.pid!, "SIGKILL") } catch {}
      finish()
    }, timeoutMs)
    child.stdout.setEncoding("utf8")
    // Done at the closing marker, not when the pipe closes: an rc file that leaves a background job
    // running keeps the pipe open long after the shell itself has exited.
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk
      if (parseEnvBlock(stdout, marker)) finish()
    })
    child.on("error", finish)
    child.on("close", finish)
  })
  const parsed = parseEnvBlock(output, marker)
  // A shell that failed, timed out or printed no block leaves the inherited environment in charge —
  // the launch then fails later with a clear "could not find npx" rather than here with nothing.
  return parsed ? { ...inherited, ...withoutElectronVariables(parsed) } : inherited
}

/**
 * The `env` output between the two markers, as a map — NUL-separated when `env -0` ran, line by line
 * otherwise. Line by line, a line that does not start a `NAME=` entry continues the previous value.
 */
export function parseEnvBlock(output: string, marker: string): Record<string, string> | undefined {
  const open = output.indexOf(`${marker}\n`)
  if (open < 0) return undefined
  const start = open + marker.length + 1
  const end = output.indexOf(`\n${marker}\n`, start)
  if (end < 0) return undefined
  const block = output.slice(start, end)
  const env: Record<string, string> = {}
  if (block.includes("\0")) {
    for (const entry of block.split("\0")) {
      const eq = entry.indexOf("=")
      if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1)
    }
    return env
  }
  let current: string | undefined
  // `env` ends its last entry with a newline, and the closing marker's own newline follows it.
  for (const line of block.replace(/\n$/u, "").split("\n")) {
    // An exported bash function (`BASH_FUNC_nvm%%=() {`) is no NAME=, so it would otherwise be read as
    // more of the variable before it — PATH, as likely as any. It starts an entry, and is dropped whole.
    if (/^BASH_FUNC_[^=]*%%=/u.test(line)) {
      current = undefined
      continue
    }
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/su.exec(line)
    if (match) {
      current = match[1]!
      env[current] = match[2]!
    } else if (current !== undefined) {
      env[current] += `\n${line}`
    }
  }
  return env
}
