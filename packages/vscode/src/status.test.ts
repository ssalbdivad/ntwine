import { test } from "node:test"
import assert from "node:assert/strict"
import { notConnectedMessage, statusView } from "./status.ts"

const connected = { kind: "connected" as const, origin: "http://127.0.0.1:9393", bootId: "b" }

test("connected, the item reads Ntwine plus the workspace's Ready count, and the tooltip names each project", () => {
  const view = statusView(connected, [
    { id: "a", slug: "a", name: "ntwine", dir: "/r/ntwine", ready: 2, working: 1 },
    { id: "b", slug: "b", name: "site", dir: "/r/site", ready: 1, working: 0 },
    { id: "c", slug: "c", name: "docs", dir: "/r/docs" },
  ])
  assert.deepEqual(view, {
    text: "Ntwine · 3 ready",
    tooltip: "ntwine: 2 ready · 1 working\nsite: 1 ready · 0 working\ndocs\nClick to show Ntwine.",
    command: "ntwine.sidebar.focus",
    ready: 3,
  })
  assert.equal(statusView(connected, [{ id: "a", slug: "a", name: "ntwine", dir: "/r", ready: 0, working: 4 }]).text, "Ntwine", "nothing waiting, no number")
  assert.equal(statusView(connected, []).tooltip, "Click to show Ntwine.")
})

test("offline or incompatible, a click tries again and the tooltip says why", () => {
  assert.deepEqual(statusView({ kind: "offline", reason: "Ntwine isn't running." }, []), {
    text: "$(debug-disconnect) Ntwine",
    tooltip: "Ntwine isn't running. Click to try again.",
    command: "ntwine.reconnect",
    ready: 0,
  })
  const incompatible = statusView({ kind: "incompatible", reason: "Update Ntwine or the extension." }, [])
  assert.equal(incompatible.command, "ntwine.reconnect")
  assert.match(incompatible.tooltip, /^Update Ntwine or the extension\. Click to try again\.$/)
  assert.equal(statusView({ kind: "connecting" }, []).command, "ntwine.reconnect")
})

test("a command with no connection says the connection's own reason, not that Ntwine is stopped", () => {
  // An Ntwine that is up but refused this window: the commands must not contradict the tooltip.
  assert.equal(notConnectedMessage({ kind: "offline", reason: "This Ntwine has no editor connection yet. Update Ntwine." }), "This Ntwine has no editor connection yet. Update Ntwine.")
  assert.equal(
    notConnectedMessage({ kind: "incompatible", reason: "This Ntwine speaks a different version of the editor connection. Update Ntwine or the extension." }),
    "This Ntwine speaks a different version of the editor connection. Update Ntwine or the extension.",
  )
  assert.equal(notConnectedMessage({ kind: "offline", reason: "Ntwine isn't running." }), "Ntwine isn't running.", "when it really is not running, it says so")
  assert.equal(notConnectedMessage({ kind: "connecting" }), "Still connecting to Ntwine. Try again in a moment.")
})

test("the tooltip's last line names the extension's build, in every state", () => {
  assert.equal(statusView(connected, [], "0.1.0+1a2b3c4d").tooltip, "Click to show Ntwine.\nNtwine extension 0.1.0+1a2b3c4d")
  assert.equal(statusView({ kind: "offline", reason: "Ntwine isn't running." }, [], "0.1.0+1a2b3c4d-dirty").tooltip, "Ntwine isn't running. Click to try again.\nNtwine extension 0.1.0+1a2b3c4d-dirty")
  assert.equal(statusView({ kind: "connecting" }, []).tooltip, "Looking for Ntwine…", "no build named, no line")
})
