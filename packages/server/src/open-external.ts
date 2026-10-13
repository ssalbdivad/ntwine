import { spawn } from "node:child_process"
import { awaitOpenerStart, type LocalFileSpawn } from "./local-file.ts"
import { log } from "./logging.ts"

// Validate a URL handed to us by the web client before we let the OS open it. The ntwine UI runs as a
// chromeless Chrome --app window with a DEDICATED user-data-dir, so links clicked inside would open
// in that anonymous-looking profile; we instead route them to the OS default browser. This endpoint
// must NOT become a shell-injection or arbitrary-file-open vector, so we accept ONLY http/https URLs
// that actually parse — everything else (javascript:, file:, data:, mailto:, garbage) is rejected.
export function validateExternalUrl(
  raw: string,
): { ok: true; url: string } | { ok: false; reason: string } {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return { ok: false, reason: "unparseable URL" }
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: `unsupported scheme: ${parsed.protocol}` }
  }
  return { ok: true, url: parsed.toString() }
}

export interface OpenExternalOptions {
  platform?: NodeJS.Platform
  spawn?: LocalFileSpawn
  /** Where a failure to START the opener goes. Defaults to the server log. */
  onError?: (message: string) => void
}

/** The fixed command plus argv that hands `url` to the OS default browser on `platform`. */
export function externalUrlOpenCommand(url: string, platform: NodeJS.Platform = process.platform): { command: string; args: readonly string[] } {
  if (platform === "darwin") return { command: "open", args: [url] }
  // The same spelling `src/browser.ts` uses to open the board itself: there is no `xdg-open` on
  // Windows, and `start` is a cmd.exe builtin, not a program.
  if (platform === "win32") return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] }
  return { command: "xdg-open", args: [url] }
}

// Open a validated http(s) URL in the OS default browser. Uses spawn with an ARGS ARRAY (never a
// shell string) so the URL can never be reinterpreted as a command. macOS-first (`open`); linux uses
// `xdg-open`; Windows `rundll32`. The child is detached + unref'd so it outlives this request.
//
// A failure to start the opener is REPORTED, never thrown: the router calls this fire-and-forget, so
// a rejection here would be an unhandled one, and an `error` event with no listener on the child was
// the crash this replaces (Windows audit 2026-09-11, finding 1 — `awaitOpenerStart` tells the story).
// The resolved value says whether it started, for a caller that does await.
export async function openExternalUrl(raw: string, options: OpenExternalOptions = {}): Promise<{ opened: true } | { opened: false; error: string }> {
  const v = validateExternalUrl(raw)
  if (!v.ok) throw new Error(v.reason)
  const spec = externalUrlOpenCommand(v.url, options.platform)
  const child = (options.spawn ?? spawn)(spec.command, [...spec.args], { detached: true, stdio: "ignore", windowsHide: true })
  try {
    await awaitOpenerStart(child, spec.command)
    return { opened: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ;(options.onError ?? ((line) => log.warn("open-external", line)))(`could not open ${v.url}: ${message}`)
    return { opened: false, error: message }
  }
}
