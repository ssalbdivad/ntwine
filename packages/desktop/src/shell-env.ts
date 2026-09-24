import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"

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
 * Windows GUI apps already inherit the user's PATH from the registry, so there is nothing to do there.
 */
export async function loginShellEnvironment(
  base: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  timeoutMs = 10_000,
): Promise<NodeJS.ProcessEnv> {
  if (platform === "win32") return base
  const shell = base.SHELL || (platform === "darwin" ? "/bin/zsh" : "/bin/sh")
  const marker = `__FRIZZ_DESKTOP_ENV_${randomUUID()}__`
  const output = await new Promise<string>((resolve) => {
    let stdout = ""
    const child = spawn(shell, ["-ilc", `printf '%s\\n' '${marker}'; env; printf '%s\\n' '${marker}'`], {
      // oh-my-zsh otherwise offers to update itself, and would wait for an answer nobody can give.
      env: { ...base, DISABLE_AUTO_UPDATE: "true" },
      stdio: ["ignore", "pipe", "ignore"],
    })
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs)
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => { stdout += chunk })
    child.on("error", () => { clearTimeout(timer); resolve("") })
    child.on("close", () => { clearTimeout(timer); resolve(stdout) })
  })
  const parsed = parseEnvBlock(output, marker)
  // A shell that failed, timed out or printed no block leaves the inherited environment in charge —
  // the launch then fails later with a clear "could not find npx" rather than here with nothing.
  return parsed ? { ...base, ...parsed } : base
}

/**
 * The `env` output between the two markers, as a map. A line that does not start a `NAME=` entry
 * continues the previous value, which is how a multi-line variable (an exported bash function, a
 * certificate) prints.
 */
export function parseEnvBlock(output: string, marker: string): Record<string, string> | undefined {
  const start = output.indexOf(`${marker}\n`)
  const end = output.lastIndexOf(`\n${marker}`)
  if (start < 0 || end <= start) return undefined
  const block = output.slice(start + marker.length + 1, end)
  const env: Record<string, string> = {}
  let current: string | undefined
  for (const line of block.split("\n")) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(line)
    if (match) {
      current = match[1]!
      env[current] = match[2]!
    } else if (current !== undefined) {
      env[current] += `\n${line}`
    }
  }
  return env
}
