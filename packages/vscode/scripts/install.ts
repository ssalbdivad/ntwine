// Install the packaged extension (dist/ntwine-vscode-<version>.vsix — `pnpm run vscode:package` builds it)
// into the VS Code whose windows will run it.
//
// The extension is `extensionKind: ["workspace"]`: it runs where the files and ntwine are. Under WSL that
// is NOT the Windows VS Code the `code` on PATH belongs to — a window on a WSL folder runs its workspace
// extensions in the VS Code Server inside WSL, so the .vsix is installed there, with that server's own
// CLI (the newest of `~/.vscode-server/bin/<commit>` and `~/.vscode-server/cli/servers/Stable-<commit>/server`).
// Anywhere else, `code --install-extension`.
//
//   node packages/vscode/scripts/install.ts            install
//   node packages/vscode/scripts/install.ts --dry-run  say what would run, run nothing

import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * How to run `<cli> --install-extension <vsix> --force` on this platform. On Windows `code` is
 * `code.cmd`, a batch file Node runs only through a shell (cmd.exe), and with `shell: true` Node joins
 * the arguments with spaces and escapes NOTHING (DEP0190) — so a checkout under `C:\Users\Jane Doe`
 * handed `code` two arguments, `C:\Users\Jane` and `Doe\…\x.vsix`. The path is quoted there instead
 * (a Windows path cannot contain `"`). Everywhere else there is no shell, and nothing to quote.
 */
export function installInvocation(platform: NodeJS.Platform, cli: string, vsix: string): { file: string; args: string[]; shell: boolean } {
  const shell = platform === "win32"
  return { file: cli, args: ["--install-extension", shell ? `"${vsix}"` : vsix, "--force"], shell }
}

function underWsl(): boolean {
  if (process.platform !== "linux") return false
  if (process.env.WSL_DISTRO_NAME) return true
  try {
    return /microsoft/iu.test(readFileSync("/proc/version", "utf8"))
  } catch {
    return false
  }
}

/** Every VS Code Server CLI under ~/.vscode-server, newest first. */
function serverClis(): string[] {
  const root = join(homedir(), ".vscode-server")
  const candidates: string[] = []
  const list = (dir: string) => (existsSync(dir) ? readdirSync(dir) : [])
  for (const commit of list(join(root, "bin"))) candidates.push(join(root, "bin", commit, "bin", "code-server"))
  for (const server of list(join(root, "cli", "servers"))) candidates.push(join(root, "cli", "servers", server, "server", "bin", "code-server"))
  return candidates.filter((cli) => existsSync(cli)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
}

function main(): void {
  const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..")
  const { name, version } = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")) as { name: string; version: string }
  const vsix = join(pkg, "dist", `${name}-${version}.vsix`)
  const dryRun = process.argv.includes("--dry-run")

  if (!existsSync(vsix)) {
    console.error(`No ${vsix}. Build it first: pnpm run vscode:package`)
    process.exit(1)
  }

  let cli = "code"
  if (underWsl()) {
    const server = serverClis()[0]
    if (!server) {
      console.error("This is WSL, but there is no VS Code Server in ~/.vscode-server yet. Open a folder in WSL from VS Code once (Remote - WSL), then run this again.")
      process.exit(1)
    }
    cli = server
  }

  const invocation = installInvocation(process.platform, cli, vsix)
  console.log(`${dryRun ? "would run" : "running"}: ${invocation.file} ${invocation.args.join(" ")}`)
  if (!dryRun) {
    execFileSync(invocation.file, invocation.args, { stdio: "inherit", shell: invocation.shell })
    console.log("Installed. Reload the editor window (Developer: Reload Window) to start it.")
  }
}

// Run as a script; a test imports `installInvocation` without installing anything.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
