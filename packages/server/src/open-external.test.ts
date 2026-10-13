import { EventEmitter } from "node:events"
import { test } from "node:test"
import assert from "node:assert/strict"
import type { LocalFileSpawn } from "./local-file.ts"
import { externalUrlOpenCommand, openExternalUrl, validateExternalUrl } from "./open-external.ts"

test("allowed: http URL → ok", () => {
  const r = validateExternalUrl("http://example.com/path?q=1")
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.url, "http://example.com/path?q=1")
})

test("allowed: https URL → ok", () => {
  const r = validateExternalUrl("https://github.com/ntwine/ui/issues/1")
  assert.equal(r.ok, true)
})

test("blocked: javascript: scheme → rejected", () => {
  assert.equal(validateExternalUrl("javascript:alert(1)").ok, false)
})

test("blocked: file: scheme → rejected", () => {
  assert.equal(validateExternalUrl("file:///etc/passwd").ok, false)
})

test("blocked: data: scheme → rejected", () => {
  assert.equal(validateExternalUrl("data:text/html,<script>alert(1)</script>").ok, false)
})

test("blocked: mailto: scheme → rejected", () => {
  assert.equal(validateExternalUrl("mailto:a@b.com").ok, false)
})

test("blocked: garbage / unparseable → rejected", () => {
  assert.equal(validateExternalUrl("not a url").ok, false)
  assert.equal(validateExternalUrl("").ok, false)
})

test("blocked: shell metacharacters do not bypass the scheme check", () => {
  // Even a string with shell-dangerous characters is rejected unless it parses as http(s).
  assert.equal(validateExternalUrl("http; rm -rf /").ok, false)
  assert.equal(validateExternalUrl("$(rm -rf /)").ok, false)
})

test("the default-browser command per platform: open / xdg-open / rundll32, argv array throughout", () => {
  const url = "https://example.com/a?b=1"
  assert.deepEqual(externalUrlOpenCommand(url, "darwin"), { command: "open", args: [url] })
  assert.deepEqual(externalUrlOpenCommand(url, "linux"), { command: "xdg-open", args: [url] })
  assert.deepEqual(externalUrlOpenCommand(url, "win32"), { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] })
})

// The same stand-in as local-file.test.ts: an `error` EVENT with no listener of the fake's own, so an
// opener that stopped listening would crash the test process the way it crashed the server.
function fakeSpawn(calls: Array<{ command: string; args: readonly string[]; windowsHide: unknown }>, fail?: NodeJS.ErrnoException): LocalFileSpawn {
  return (command, args, options) => {
    calls.push({ command, args, windowsHide: options.windowsHide })
    const child = Object.assign(new EventEmitter(), { unref() {} })
    queueMicrotask(() => { if (fail) child.emit("error", fail); else child.emit("spawn") })
    return child
  }
}

test("an opener that cannot start is reported and resolved, never an unhandled `error` event", async () => {
  // Windows audit 2026-09-11, finding 1. The router calls this fire-and-forget, so the failure goes
  // to the log (here: `onError`) and the resolved value, not a rejection.
  const calls: Array<{ command: string; args: readonly string[]; windowsHide: unknown }> = []
  const reported: string[] = []
  const enoent = Object.assign(new Error("spawn xdg-open ENOENT"), { code: "ENOENT" })
  const failed = await openExternalUrl("https://example.com/", { platform: "linux", spawn: fakeSpawn(calls, enoent), onError: (m) => reported.push(m) })
  assert.deepEqual(failed, { opened: false, error: "xdg-open is not installed or not on PATH" })
  assert.deepEqual(reported, ["could not open https://example.com/: xdg-open is not installed or not on PATH"])
  const opened = await openExternalUrl("https://example.com/", { platform: "win32", spawn: fakeSpawn(calls), onError: (m) => reported.push(m) })
  assert.deepEqual(opened, { opened: true })
  assert.equal(reported.length, 1)
  assert.equal(calls[1]!.command, "rundll32.exe")
  assert.equal(calls[1]!.windowsHide, true)
  // The scheme gate still throws synchronously-in-promise: a bad URL never reaches a spawn.
  await assert.rejects(openExternalUrl("javascript:alert(1)", { spawn: fakeSpawn(calls) }), /unsupported scheme/u)
  assert.equal(calls.length, 2)
})
