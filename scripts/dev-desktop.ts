// `pnpm run dev-desktop` (alias `dd`): the dev server and the desktop window onto it, in one terminal.
//
// The window is pinned to the dev board's port rather than left to search: a window that searches and
// finds nothing starts a dev board of its own (as a terminal thread), which it would do before this one
// is up. A pinned window starts nothing and waits for its board. (Plain `pnpm run desktop` now does what
// this script is for, with the dev board's keys and output in its thread's drawer instead of here.) Closing the window stops the server; the server exiting leaves
// the window, since that is usually a dev server already running elsewhere, which the window shows.
import { spawn, type ChildProcess } from "node:child_process"
import { DEFAULT_DEV_PORT } from "@ntwine/shared"

const extra = process.argv.slice(2).filter((arg) => arg !== "--")
// The server gets the same port the window is pinned to: `pnpm run dev` alone defaults to DEFAULT_PORT,
// so without this the window waits on a port nothing serves unless a dev board is already up there.
const server = spawn("pnpm", ["run", "dev", "--", "--port", String(DEFAULT_DEV_PORT)], { stdio: "inherit" })
const desktop = spawn("pnpm", ["run", "desktop", "--", `--url=http://127.0.0.1:${DEFAULT_DEV_PORT}`, ...extra], { stdio: "inherit" })
const children: ChildProcess[] = [server, desktop]

let stopping = false
function stop(code: number): void {
  if (stopping) return
  stopping = true
  for (const child of children) if (child.exitCode === null) child.kill("SIGINT")
  process.exitCode = code
}
desktop.on("exit", (code) => stop(code ?? 0))
process.on("SIGINT", () => stop(130))
process.on("SIGTERM", () => stop(143))
