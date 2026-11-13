import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"
import { openNtwineDatabase, type NtwineDatabase } from "./ntwine-db.ts"
import { createStorage, type SessionRow, type Storage } from "./storage.ts"
import { unpackBundle } from "./thread-bundle.ts"
import { moveLogOf, type TranscriptMessage } from "@ntwine/shared"
import { exportThread, importThread, markMovedAway, movedStamp, parseManifest, untoldMoveNote, type MoveManifest } from "./thread-move.ts"
import { withMoveDividers } from "./transcript.ts"

// Two "machines" on one disk: each its own home, checkout, state dir and database, as the real move
// sees them. The git half is thread-wip.test.ts's; here a thread with no repository moves without one.

const root = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-move-")))
after(() => rmSync(root, { recursive: true, force: true }))

interface Machine {
  home: string
  project: { id: string; name: string; dir: string; workDir: string; stateDir: string }
  bucket: string
  db: NtwineDatabase
  storage: Storage
}

function machine(name: string, projectId: string, checkout: string): Machine {
  const home = join(root, name, "home")
  const dir = join(home, checkout)
  const stateDir = join(root, name, "data", "projects", projectId)
  for (const path of [dir, stateDir]) mkdirSync(path, { recursive: true })
  const db = openNtwineDatabase({ path: join(root, name, "ui.db") })
  return {
    home,
    project: { id: projectId, name: "app", dir, workDir: dir, stateDir },
    bucket: dir.replace(/[^A-Za-z0-9]/g, "-"),
    db,
    storage: createStorage(db.db, projectId),
  }
}

const SID = "0b6c9d64-5f3e-4c2a-9a51-6d0b1f2e3a4b"
let tags = 0
const randomTag = () => `${++tags}`

function row(slug: string, sessionId = SID): SessionRow {
  return {
    slug, session_id: sessionId, thread_name: `ntwine-${slug}`, spawned_at: "2026-11-12T10:00:00.000Z",
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: "2026-11-12T10:05:00.000Z", title_auto: 0,
    title: "Fix the parser", state: "open", meta: null, seen_at: null, transcript_id: null, backend: "claude", claude_runtime: "broker",
    permission_mode: "bypassPermissions",
  }
}

/** A resting thread on `m`: its row, a question, a done card, an armed timer, a transcript, notes and an attachment. */
function seedThread(m: Machine, slug: string) {
  m.storage.upsertSession(row(slug))
  m.db.db.prepare("UPDATE session SET recurring_prompt = 'keep going', recurring_on_rest = 1 WHERE project_id = ? AND slug = ?").run(m.project.id, slug)
  m.storage.markThreadDone(slug, "**Fixed** the parser", 1)
  m.db.db.prepare("INSERT INTO thread_timer (id, project_id, thread_slug, prompt, fire_at, state, created_at) VALUES (?, ?, ?, ?, ?, 'armed', ?)")
    .run(`tmr-${slug}`, m.project.id, slug, "check CI", Date.now() + 60_000, Date.now())
  const attachment = join(m.project.stateDir, "attachments", "1700000000000-abcd1234-shot.png")
  mkdirSync(join(m.project.stateDir, "attachments"), { recursive: true })
  writeFileSync(attachment, "PNG")
  writeFileSync(join(m.project.stateDir, "attachments", "1700000000001-ffff0000-unrelated.png"), "not cited")
  const bucket = join(m.home, ".claude", "projects", m.bucket)
  const toolResult = join(bucket, SID, "tool-results", "b1.txt")
  const records = [
    { type: "user", cwd: m.project.workDir, message: { role: "user", content: `look at ${attachment} — the old home was ${m.home}` } },
    { type: "assistant", cwd: join(m.project.workDir, "src"), message: { content: [
      { type: "thinking", thinking: `the file is at ${toolResult}`, signature: "c2ln" },
      { type: "tool_result", content: `Output too large. Full output saved to: ${toolResult}` },
    ] } },
  ]
  mkdirSync(join(bucket, SID, "tool-results"), { recursive: true })
  mkdirSync(join(bucket, SID, "ntwine-inbox", "agent-1"), { recursive: true })
  writeFileSync(join(bucket, `${SID}.jsonl`), `${records.map((r) => JSON.stringify(r)).join("\n")}\n`)
  writeFileSync(toolResult, "big output")
  writeFileSync(join(bucket, SID, "ntwine-inbox", "agent-1", "1.json"), "{}")
  const scratch = join(m.project.dir, ".ntwine", "threads", SID)
  mkdirSync(join(scratch, "evidence"), { recursive: true })
  writeFileSync(join(scratch, "notes.md"), "# notes")
  writeFileSync(join(scratch, "evidence", "a.txt"), "a")
  return { toolResult }
}

/** Export from one machine and import into the other; `tamper` plays a paired machine that lies. */
async function move(from: Machine, to: Machine, slug: string, moveId: string, tamper?: (manifest: MoveManifest) => void) {
  const exported = exportThread({ db: from.db.db, project: from.project, bucket: from.bucket, slug, home: from.home, moveId, git: null })
  const unpacked = await unpackBundle(exported.blob)
  const manifest = parseManifest(unpacked.manifest)
  assert.ok(manifest, "the manifest parses on the other side")
  tamper?.(manifest)
  return importThread(
    { scope: to.storage.scope, project: to.project, home: to.home, bucket: to.bucket },
    manifest, unpacked.files, { id: "a".repeat(32), name: "mac" }, { name: "desktop" }, undefined,
  )
}

describe("moving a thread between two machines' data", () => {
  const mac = machine("mac", "proj-mac", "code/app")
  const desktop = machine("desktop", "proj-desktop", "app")
  const { toolResult } = seedThread(mac, "fix-parser")

  it("arrives with its rows, transcript, notes and cited attachments, its paths mapped to this machine", async () => {
    assert.deepEqual(desktop.storage.allSessions(), [])
    const result = await move(mac, desktop, "fix-parser", "move-0001-aaaa")
    assert.deepEqual(result, { ok: true, slug: "fix-parser", duplicate: false, notes: [
      "Its checkout did not move: it had no uncommitted work in this project's repository",
      "Not re-armed on desktop: 1 timer, its recurring prompt",
    ] })

    assert.deepEqual(desktop.storage.allSessions().map((row) => row.slug), ["fix-parser"])
    const arrived = desktop.storage.getSession("fix-parser")!
    assert.equal(arrived.session_id, SID)
    assert.equal(arrived.title, "Fix the parser")
    assert.equal(movedStamp(arrived.moved_from)?.peerName, "mac")
    assert.deepEqual(moveLogOf(arrived.move_log).map(({ from, to, moveId }) => [from, to, moveId]), [["mac", "desktop", "move-0001-aaaa"]])
    assert.equal(desktop.storage.getThreadDone("fix-parser")?.body, "**Fixed** the parser")
    // What would run it here without the human arrives settled, at this machine's defaults.
    assert.equal(desktop.db.db.prepare("SELECT state FROM thread_timer WHERE project_id = ? AND thread_slug = ?").get("proj-desktop", "fix-parser")?.state, "cancelled")
    assert.deepEqual([arrived.permission_mode, arrived.recurring_prompt, arrived.recurring_on_rest], [null, null, 0])

    const bucket = join(desktop.home, ".claude", "projects", desktop.bucket)
    const lines = readFileSync(join(bucket, `${SID}.jsonl`), "utf8").trim().split("\n").map((line) => JSON.parse(line))
    assert.deepEqual(lines.map((line) => line.cwd), [desktop.project.workDir, join(desktop.project.workDir, "src")])
    const movedToolResult = join(bucket, SID, "tool-results", "b1.txt")
    assert.equal(lines[1].message.content[1].content, `Output too large. Full output saved to: ${movedToolResult}`)
    // The signed block is byte-for-byte what it was, and so is the prose naming the old home.
    assert.deepEqual(lines[1].message.content[0], { type: "thinking", thinking: `the file is at ${toolResult}`, signature: "c2ln" })
    assert.match(lines[0].message.content, new RegExp(`the old home was ${mac.home}$`))
    assert.ok(lines[0].message.content.startsWith(`look at ${join(desktop.project.stateDir, "attachments", "1700000000000-abcd1234-shot.png")}`))

    assert.equal(readFileSync(movedToolResult, "utf8"), "big output")
    assert.equal(existsSync(join(bucket, SID, "ntwine-inbox")), false, "a live sub-agent mailbox stays behind")
    assert.equal(readFileSync(join(desktop.project.dir, ".ntwine", "threads", SID, "evidence", "a.txt"), "utf8"), "a")
    assert.equal(readFileSync(join(desktop.project.stateDir, "attachments", "1700000000000-abcd1234-shot.png"), "utf8"), "PNG")
    assert.equal(existsSync(join(desktop.project.stateDir, "attachments", "1700000000001-ffff0000-unrelated.png")), false)

    // The worker hears where it came from once.
    const note = untoldMoveNote(arrived.moved_from)
    assert.match(note!, /^⟦ntwine⟧ This thread moved from mac to desktop\./)
    assert.ok(note!.includes(`\`${mac.project.workDir}\` is now \`${desktop.project.workDir}\``))
  })

  it("leaves a read-only stub behind whose waits are settled, so each fires on one machine", () => {
    // Read through storage first: it memoises the session rows, and a stamp written around its scope
    // would never be seen by the board or a guard (the first real move's stub stayed live this way).
    assert.equal(mac.storage.allSessions().find((row) => row.slug === "fix-parser")?.moved_to ?? null, null)
    markMovedAway(mac.storage.scope, "fix-parser", { peerId: "b".repeat(32), peerName: "desktop", at: "2026-11-12T11:00:00.000Z", moveId: "move-0001-aaaa" }, { from: "mac", at: "2026-11-12T10:59:00.000Z" })
    const stub = mac.storage.getSession("fix-parser")!
    assert.deepEqual(moveLogOf(stub.move_log), [{ from: "mac", to: "desktop", at: "2026-11-12T10:59:00.000Z", moveId: "move-0001-aaaa" }])
    assert.equal(stub.state, "archived")
    assert.equal(mac.storage.allSessions().find((row) => row.slug === "fix-parser")?.state, "archived")
    assert.deepEqual(movedStamp(stub.moved_to), { peerId: "b".repeat(32), peerName: "desktop", at: "2026-11-12T11:00:00.000Z", moveId: "move-0001-aaaa" })
    assert.equal(mac.db.db.prepare("SELECT state FROM thread_timer WHERE project_id = ? AND thread_slug = ?").get("proj-mac", "fix-parser")?.state, "cancelled")
  })

  it("answers a repeat of the same move without writing again", async () => {
    desktop.storage.markThreadDone("fix-parser", "changed on the desktop", 2)
    const again = await move(mac, desktop, "fix-parser", "move-0001-aaaa")
    assert.deepEqual(again, { ok: true, slug: "fix-parser", duplicate: true, notes: [] })
    assert.equal(desktop.storage.getThreadDone("fix-parser")?.body, "changed on the desktop")
  })

  it("comes home over its own stub, and refuses a different thread that happens to share the name", async () => {
    const back = await move(desktop, mac, "fix-parser", "move-0002-bbbb")
    assert.equal("ok" in back && back.ok, true)
    const home = mac.storage.getSession("fix-parser")!
    assert.equal(home.moved_to, null)
    assert.equal(movedStamp(home.moved_from)?.moveId, "move-0002-bbbb")
    // The history came back with it: both moves, oldest first, on the machine it is home on.
    assert.deepEqual(moveLogOf(home.move_log).map((entry) => entry.moveId), ["move-0001-aaaa", "move-0002-bbbb"])
    assert.equal(mac.storage.getThreadDone("fix-parser")?.body, "changed on the desktop")
    // The desktop's copy is live (nothing marked it moved here), so a third machine's same-named thread is refused.
    const stranger = machine("laptop", "proj-laptop", "src/app")
    stranger.storage.upsertSession(row("fix-parser", "11111111-2222-4333-8444-555555555555"))
    const bucket = join(stranger.home, ".claude", "projects", stranger.bucket)
    mkdirSync(bucket, { recursive: true })
    writeFileSync(join(bucket, "11111111-2222-4333-8444-555555555555.jsonl"), `${JSON.stringify({ type: "user", cwd: stranger.project.workDir })}\n`)
    assert.deepEqual(await move(stranger, desktop, "fix-parser", "move-0003-cccc"), { refused: "This machine already has a different thread named @fix-parser in this project" })
  })
})

describe("where a thread changed machines, in its conversation", () => {
  const said = (text: string, at: string): TranscriptMessage => ({ sourceId: text, role: "user", text, tools: [], parts: [], at })
  const conversation = [said("before", "2026-11-12T10:00:00.000Z"), said("after", "2026-11-12T12:00:00.000Z")]
  const lines = (messages: TranscriptMessage[]) => messages.map((m) => (m.boundary === "moved" ? `— ${m.text} —` : m.text))
  const storageOf = (fields: Partial<SessionRow>) => ({ getSession: () => ({ ...row("t"), ...fields }) })

  it("draws every move in its log where it happened, the one it left on included", () => {
    const log = JSON.stringify([
      { from: "mac", to: "desktop", at: "2026-11-12T11:00:00.000Z", moveId: "move-1" },
      { from: "desktop", to: "mac", at: "2026-11-12T13:00:00.000Z", moveId: "move-2" },
    ])
    assert.deepEqual(lines(withMoveDividers(conversation, storageOf({ move_log: log }), "t")),
      ["before", "— Moved to desktop —", "after", "— Moved to mac —"])
  })

  it("reads a thread moved before the log from its stamps, and draws nothing for an unconfirmed move", () => {
    const stamp = (peerName: string, at: string, extra: Record<string, unknown> = {}) => JSON.stringify({ peerId: "p", peerName, at, moveId: `m-${peerName}`, ...extra })
    assert.deepEqual(lines(withMoveDividers(conversation, storageOf({ moved_from: stamp("mac", "2026-11-12T11:00:00.000Z"), moved_to: stamp("laptop", "2026-11-12T13:00:00.000Z") }), "t")),
      ["before", "— Moved here from mac —", "after", "— Moved to laptop —"])
    assert.deepEqual(lines(withMoveDividers(conversation, storageOf({ moved_to: stamp("laptop", "2026-11-12T13:00:00.000Z", { pending: true }) }), "t")), ["before", "after"])
  })
})

describe("an import from a machine that lies", () => {
  const VICTIM = "22222222-3333-4444-8555-666666666666"
  /** A desktop holding its own thread @victim, and another project's timer, each something a lie could hit. */
  function scene() {
    const mac = machine(`mac-${randomTag()}`, "proj-mac", "code/app")
    const desktop = machine(`desktop-${randomTag()}`, "proj-desktop", "app")
    seedThread(mac, "fix-parser")
    desktop.storage.upsertSession(row("victim", VICTIM))
    desktop.storage.markThreadDone("victim", "the real done card", 1)
    desktop.db.db.prepare("INSERT INTO thread_timer (id, project_id, thread_slug, prompt, fire_at, state, created_at) VALUES ('tmr-other', 'proj-other', 'theirs', 'p', 1, 'armed', 1)").run()
    const nothingWritten = () => {
      assert.equal(desktop.storage.getSession("fix-parser"), undefined)
      assert.equal(existsSync(join(desktop.home, ".claude", "projects", desktop.bucket, `${SID}.jsonl`)), false)
      assert.equal(desktop.storage.getThreadDone("victim")?.body, "the real done card")
      assert.deepEqual({ ...desktop.db.db.prepare("SELECT project_id, thread_slug, state FROM thread_timer WHERE id = 'tmr-other'").get() }, { project_id: "proj-other", thread_slug: "theirs", state: "armed" })
    }
    return { mac, desktop, nothingWritten }
  }

  it("refuses a record of another thread, or one another project holds by its id", async () => {
    const { mac, desktop, nothingWritten } = scene()
    assert.deepEqual(await move(mac, desktop, "fix-parser", "move-1000-aaaa", (m) => {
      m.rows.thread_done = [{ thread_slug: "victim", body: "FORGED", done_at: 2 }]
    }), { refused: "The thread's bundle carries a record of another thread" })
    nothingWritten()
    assert.deepEqual(await move(mac, desktop, "fix-parser", "move-1001-aaaa", (m) => {
      m.rows.thread_timer = [{ id: "tmr-other", thread_slug: "fix-parser", prompt: "x", fire_at: 1, state: "armed", created_at: 1 }]
    }), { refused: "The thread's bundle carries a record that belongs to another thread on this machine" })
    nothingWritten()
  })

  it("refuses a conversation that is not the thread's own, or that another thread here has", async () => {
    const { mac, desktop, nothingWritten } = scene()
    assert.deepEqual(await move(mac, desktop, "fix-parser", "move-1002-aaaa", (m) => {
      m.thread.transcriptIds = [SID, VICTIM]
    }), { refused: "The thread's bundle names a conversation that is not its own" })
    nothingWritten()
    assert.deepEqual(await move(mac, desktop, "fix-parser", "move-1003-aaaa", (m) => {
      m.thread.transcriptIds = [SID, VICTIM]
      m.rows.session[0]!.transcript_id = VICTIM
    }), { refused: "The thread's conversation belongs to another thread on this machine" })
    nothingWritten()
  })

  it("will not place the notes through a symlinked folder", async () => {
    const { mac, desktop, nothingWritten } = scene()
    const outside = join(root, `outside-${randomTag()}`)
    mkdirSync(outside)
    mkdirSync(join(desktop.project.dir, ".ntwine"), { recursive: true })
    symlinkSync(outside, join(desktop.project.dir, ".ntwine", "threads"))
    assert.deepEqual(await move(mac, desktop, "fix-parser", "move-1004-aaaa"), { refused: ".ntwine/threads is a symlink, so the thread's notes cannot be placed" })
    nothingWritten()
    assert.deepEqual(readdirSync(outside), [])
  })
})
