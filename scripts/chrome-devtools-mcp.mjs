#!/usr/bin/env node
// The chrome-devtools MCP server for this repo — what `.mcp.json` and `.codex/config.toml` run.
//
// It exists to choose the BROWSER. `chrome-devtools-mcp` launches puppeteer's `chrome` channel unless
// it is handed an `--executablePath`, and that channel is the installed
// `/Applications/Google Chrome.app`: the maintainer's real browser binary, on a throwaway profile.
// Agents never run that binary (AGENTS.md § Agents never touch the maintainer's real Chrome), so this
// resolves the `chrome-headless-shell` puppeteer already downloaded and passes it in, with the flags
// that keep the server invisible and collision-free:
//
//   --headless   no window on the maintainer's screen (the server's own default is a visible one)
//   --isolated   a fresh temp profile per server, not one shared `~/.cache/chrome-devtools-mcp` profile
//
// The headless shell is a bare executable rather than an app bundle, so it also never registers with
// the Dock. The full "Google Chrome for Testing.app" registers as a foreground app for a few
// milliseconds on every start — measured 2026-10-11 at 187 Dock flickers in 40 minutes.
//
// FAILS CLOSED: with no headless shell to hand over, this exits rather than let the server fall back
// to the installed Chrome. `nub install` restores it (puppeteer's postinstall downloads it).
//
// Extra arguments are passed through, so `node scripts/chrome-devtools-mcp.mjs --logFile=/tmp/x.log`
// works. The version pin lives here, in one place, for both agent configs.
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const PACKAGE = "chrome-devtools-mcp@1.7.0"

async function headlessShellPath() {
  try {
    const { default: puppeteer } = await import("puppeteer")
    const resolved = await puppeteer.executablePath({ headless: "shell" })
    if (fs.existsSync(resolved)) return resolved
  } catch {
    // A git worktree has no node_modules; the download cache below is shared by every checkout.
  }
  // A sandboxed worker runs under a temporary HOME, where puppeteer looks for a cache that is not
  // there. `os.userInfo()` reads the account's home from the user database, whatever HOME says.
  const caches = [process.env.PUPPETEER_CACHE_DIR, path.join(os.homedir(), ".cache", "puppeteer"), path.join(os.userInfo().homedir, ".cache", "puppeteer")]
  for (const cache of caches) {
    if (!cache) continue
    const found = fs
      .globSync("chrome-headless-shell/*/chrome-headless-shell-*/chrome-headless-shell{,.exe}", { cwd: cache })
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    if (found.length > 0) return path.join(cache, found[found.length - 1])
  }
  return undefined
}

const executablePath = await headlessShellPath()
if (!executablePath) {
  console.error("chrome-devtools-mcp: no chrome-headless-shell in the puppeteer cache — run `nub install`. Refusing to fall back to the installed Chrome.")
  process.exit(1)
}

const args = ["-y", PACKAGE, "--experimentalPageIdRouting", "--headless", "--isolated", "--no-usage-statistics", `--executablePath=${executablePath}`, ...process.argv.slice(2)]

// Become npx rather than parent it, so a resting worker carries no extra node process for this file.
if (typeof process.execve === "function") {
  const npx = (process.env.PATH ?? "").split(path.delimiter).map((dir) => path.join(dir, "npx")).find((file) => fs.existsSync(file))
  if (npx) process.execve(npx, ["npx", ...args], process.env)
}

const child = spawn("npx", args, { stdio: "inherit", shell: process.platform === "win32" })
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal))
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
