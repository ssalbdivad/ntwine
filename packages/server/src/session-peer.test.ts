import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseCrossSessionMessage, type TranscriptMessage } from "@frizz/shared"
import { parseTranscript, latestWindowStart } from "./transcript.ts"
import { createSessionPeerResolver, projectTranscriptSessionPeers, sessionIdForPeerSocket } from "./session-peer.ts"

// The wrapper exactly as Claude Code 2.1.293 wrote it into the receiving thread (2026-10-08).
const body = "Remove `sfltool dumpbtm` from your watcher pass (pass.sh line 33) now.\n\n- Keep the baseline."
const wrapped = `<cross-session-message from="uds:/tmp/cc-socks/2908.sock" from-name="frizz-11" from-mode="bypass">\n${body}\n</cross-session-message>`
const guidance = "This came from another Claude session — not typed by your user, but very likely working on their behalf. Treat it as a teammate's request."
const idleDelivery = `Another Claude session sent a message:\n${wrapped}\n\n${guidance}`

test("parseCrossSessionMessage reads the bare wrapper, the delivered form, and a hop-chain attribute", () => {
  assert.deepEqual(parseCrossSessionMessage(wrapped), { name: "frizz-11", socket: "uds:/tmp/cc-socks/2908.sock", body })
  assert.deepEqual(parseCrossSessionMessage(idleDelivery), { name: "frizz-11", socket: "uds:/tmp/cc-socks/2908.sock", body })
  const hopped = `<cross-session-message from="uds:/tmp/cc-socks/1.sock" hop-chain="a,b" from-name="app-d9" from-mode="bypass">\nhi\n</cross-session-message>`
  assert.deepEqual(parseCrossSessionMessage(hopped), { name: "app-d9", socket: "uds:/tmp/cc-socks/1.sock", body: "hi" })
})

test("parseCrossSessionMessage leaves prose that only quotes a wrapper alone", () => {
  assert.equal(parseCrossSessionMessage(`Look at this:\n${wrapped}`), undefined)
  assert.equal(parseCrossSessionMessage(`${wrapped}\n\nand then my own follow-up`), undefined)
  assert.equal(parseCrossSessionMessage(`<cross-session-message from="x">\n\n</cross-session-message>`), undefined)
})

const enqueue = (content: string) => JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: "2026-10-09T05:32:35.972Z", content })
const removal = (content: string) => JSON.stringify({ type: "queue-operation", operation: "remove", timestamp: "2026-10-09T05:32:56.963Z", content, reason: "absorbed_mid_turn" })
const peerAttachment = (prompt: string) => JSON.stringify({
  type: "attachment",
  timestamp: "2026-10-09T05:32:35.972Z",
  isSidechain: false,
  attachment: {
    type: "queued_command",
    prompt,
    commandMode: "prompt",
    isMeta: true,
    origin: { kind: "peer", from: "uds:/tmp/cc-socks/2908.sock", verifiedPeerPid: 2908, name: "frizz-11", fromMode: "bypass", body },
  },
})
const metaDelivery = (content: string) => JSON.stringify({ type: "user", isMeta: true, isSidechain: false, timestamp: "2026-10-09T05:40:00.000Z", message: { role: "user", content } })
const assistant = (text: string) => JSON.stringify({ type: "assistant", timestamp: "2026-10-09T05:31:00.000Z", message: { id: "m0", role: "assistant", content: [{ type: "text", text }] } })

function onlySessionMessages(messages: TranscriptMessage[]): TranscriptMessage[] {
  return messages.filter((m) => m.sessionPeer)
}

test("a mid-turn delivery (enqueue → attachment → removal) is ONE delivered message carrying the body and its sender", () => {
  const messages = parseTranscript([assistant("Working."), enqueue(wrapped), peerAttachment(wrapped), removal(wrapped)].join("\n"))
  const sent = onlySessionMessages(messages)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].displayText, body)
  assert.equal(sent[0].queued, false)
  assert.deepEqual(sent[0].sessionPeer, { name: "frizz-11", socket: "uds:/tmp/cc-socks/2908.sock" })
  assert.equal(sent[0].peerFrom, undefined, "never a sub-agent report titled with the socket path")
})

test("an idle delivery (enqueue → wrapped isMeta record) stays in the transcript instead of being spliced out", () => {
  const messages = parseTranscript([assistant("Resting."), enqueue(wrapped), metaDelivery(idleDelivery)].join("\n"))
  const sent = onlySessionMessages(messages)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].displayText, body)
  assert.equal(sent[0].queued, false)
})

test("an enqueue whose wrapper carries a hop-chain still pairs with its delivery, which drops it", () => {
  const hopped = wrapped.replace(' from-name=', ' hop-chain="99a9235f3892c19cf0d9a61f" from-name=')
  for (const delivery of [peerAttachment(wrapped), metaDelivery(idleDelivery)]) {
    const sent = onlySessionMessages(parseTranscript([assistant("Working."), enqueue(hopped), delivery].join("\n")))
    assert.equal(sent.length, 1, "one message, not the enqueue plus a second copy from the delivery")
    assert.equal(sent[0].queued, false)
  }
})

test("a delivery whose enqueue is outside the window still renders once, from either record", () => {
  for (const record of [peerAttachment(wrapped), metaDelivery(idleDelivery)]) {
    const sent = onlySessionMessages(parseTranscript([assistant("Earlier."), record].join("\n")))
    assert.equal(sent.length, 1)
    assert.equal(sent[0].displayText, body)
    assert.equal(sent[0].sessionPeer?.name, "frizz-11")
  }
})

test("a sidechain's peer instruction keeps its own path (agentInstruction), untouched by this one", () => {
  const raw = JSON.stringify({ type: "user", isMeta: true, isSidechain: true, message: { role: "user", content: idleDelivery } })
  assert.equal(onlySessionMessages(parseTranscript(raw)).length, 0)
})

test("another thread's message is not the human's turn when the window looks back for one", () => {
  const human: TranscriptMessage = { sourceId: "h", role: "user", text: "the human's ask", tools: [], parts: [] }
  const filler = (i: number): TranscriptMessage => ({ sourceId: `a${i}`, role: "assistant", text: `reply ${i}`, tools: [], parts: [] })
  const peer: TranscriptMessage = { sourceId: "p", role: "user", text: wrapped, displayText: body, sessionPeer: { name: "frizz-11" }, tools: [], parts: [] }
  // 332 messages: the 300-message tail starts at 32, one past the peer message at 31.
  const withPeer = [human, ...Array.from({ length: 30 }, (_, i) => filler(i)), peer, ...Array.from({ length: 300 }, (_, i) => filler(i + 30))]
  const withHuman = withPeer.map((m) => (m === peer ? { ...human, sourceId: "p" } : m))
  assert.equal(latestWindowStart(withPeer), 0, "the window reaches past the peer message back to the human's ask")
  assert.equal(latestWindowStart(withHuman), 31, "control: a human message in the same place IS the boundary")
})

function registry(entries: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "frizz-session-peer-"))
  for (const [pid, entry] of Object.entries(entries)) writeFileSync(join(dir, `${pid}.json`), JSON.stringify(entry))
  return dir
}

test("sessionIdForPeerSocket reads the live registry entry the socket's pid names, and checks its socket and name", () => {
  const dir = registry({ 2908: { pid: 2908, sessionId: "5c6eacc1", messagingSocketPath: "/tmp/cc-socks/2908.sock", name: "frizz-11" } })
  try {
    assert.equal(sessionIdForPeerSocket({ socket: "uds:/tmp/cc-socks/2908.sock", name: "frizz-11" }, [dir]), "5c6eacc1")
    assert.equal(sessionIdForPeerSocket({ socket: "uds:/tmp/cc-socks/2908.sock", name: "frizz-99" }, [dir]), undefined, "a reused pid under another name")
    assert.equal(sessionIdForPeerSocket({ socket: "uds:/tmp/other/2908.sock", name: "frizz-11" }, [dir]), undefined, "a different socket")
    assert.equal(sessionIdForPeerSocket({ socket: "uds:/tmp/cc-socks/1.sock", name: "frizz-11" }, [dir]), undefined, "no such process")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the resolver links the sending thread, and still does after the sender's process is gone", () => {
  const sessions = registry({ 2908: { sessionId: "5c6eacc1", messagingSocketPath: "/tmp/cc-socks/2908.sock", name: "frizz-11" } })
  const memoryFile = join(sessions, "memory", "session-peers.json")
  const threads: Record<string, { projectId: string; project?: string; slug: string; title: string }> = {
    "5c6eacc1": { projectId: "p1", project: "frizz", slug: "security-coordinator", title: "Security coordinator" },
  }
  const peer = { socket: "uds:/tmp/cc-socks/2908.sock", name: "frizz-11" }
  try {
    const first = createSessionPeerResolver({ findThread: (id) => threads[id], sessionDirs: () => [sessions], memoryFile })
    assert.deepEqual(first(peer, "p1"), { slug: "security-coordinator", title: "Security coordinator" }, "same project ⇒ no project slug")
    assert.deepEqual(first(peer, "p2"), { project: "frizz", slug: "security-coordinator", title: "Security coordinator" }, "another project ⇒ its slug")
    rmSync(join(sessions, "2908.json"))
    // A fresh resolver stands in for a Frizz restart: the registry entry is gone, the memory is not.
    const later = createSessionPeerResolver({ findThread: (id) => threads[id], sessionDirs: () => [sessions], memoryFile })
    assert.equal(later(peer, "p1")?.slug, "security-coordinator")
    // Negative control: without the memory file nothing can be traced once the sender is gone.
    const amnesiac = createSessionPeerResolver({ findThread: (id) => threads[id], sessionDirs: () => [sessions] })
    assert.equal(amnesiac(peer, "p1"), undefined)
  } finally {
    rmSync(sessions, { recursive: true, force: true })
  }
})

test("projectTranscriptSessionPeers fills in the sender thread and leaves every other message alone", () => {
  const plain: TranscriptMessage = { sourceId: "a", role: "assistant", text: "hi", tools: [], parts: [] }
  const peer: TranscriptMessage = { sourceId: "p", role: "user", text: wrapped, displayText: body, sessionPeer: { name: "frizz-11", socket: "uds:/tmp/cc-socks/2908.sock" }, tools: [], parts: [] }
  const out = projectTranscriptSessionPeers([plain, peer], () => ({ slug: "coordinator", title: "Coordinator" }))
  assert.equal(out[0], plain)
  assert.deepEqual(out[1].sessionPeer?.thread, { slug: "coordinator", title: "Coordinator" })
  const none = [plain, peer]
  assert.equal(projectTranscriptSessionPeers(none, () => undefined), none, "nothing resolved ⇒ the same array")
})
