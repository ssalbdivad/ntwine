import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"
import { moveLogOf } from "@ntwine/shared"
import type { RequestOrigin } from "./audit.ts"
import type { AppContext } from "./context.ts"
import { openNtwineDatabase } from "./ntwine-db.ts"
import { createPeerService, PEER_ROUTE_PREFIX, remoteIdentity, type PeerService } from "./peer-service.ts"
import { ENVELOPE_MAGIC, frameMessage, generatePeerKey, openRequest, sealRequest, unframeMessage, type PeerKeyPair } from "./peer-crypto.ts"
import { loadOrCreatePeerKey, openPeerStore, peerKeyPath } from "./peer-store.ts"
import { cwdSlug } from "./project.ts"
import { unpackBundle } from "./thread-bundle.ts"
import { movedStamp } from "./thread-move.ts"
import { createStorage } from "./storage.ts"

// Two peer services in one process, each with its own home, whose `fetch` is the other's `handle`:
// the whole HTTP-level protocol (pairing, the envelope, replay) with no sockets.

const root = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-peer-")))
after(() => rmSync(root, { recursive: true, force: true }))

const services = new Map<string, PeerService>()
const captured: { url: string; body: Buffer }[] = []
const origin: RequestOrigin = { via: "direct", remote: "127.0.0.1", session: null, device: "test" }
const loopFetch: typeof fetch = async (input, init) => {
  const url = String(input)
  const target = services.get(new URL(url).origin)
  if (!target) throw new TypeError("fetch failed")
  const body = Buffer.from(init?.body as Uint8Array)
  captured.push({ url, body })
  return target.handle(new Request(url, { method: init?.method, headers: init?.headers, body: new Uint8Array(body) }), origin)
}

function service(name: string, url: string): PeerService {
  const home = join(root, name)
  const created = createPeerService({ home, name, fetch: loopFetch, startListener: false, workspaces: () => [], openProject: async () => undefined, storePath: join(home, "peers.json") })
  services.set(url, created)
  return created
}

describe("pairing two machines and talking between them", () => {
  const mac = service("mac", "http://mac.test")
  const desktop = service("desktop", "http://desktop.test")

  it("keeps its machine key private on disk", () => {
    assert.equal(statSync(peerKeyPath(join(root, "mac"))).mode & 0o777, 0o600)
  })

  it("refuses to pair when the machine shows no code, and on a wrong code", async () => {
    await assert.rejects(desktop.join("http://mac.test", "7K3M-9QWT-X2PB"), /mac is not showing a pairing code/)
    mac.mintPairCode()
    await assert.rejects(desktop.join("http://mac.test", "7K3M-9QWT-X2PB"), /That code does not match the one this machine is showing/)
    assert.deepEqual(mac.state().peers, [])
    assert.deepEqual(desktop.state().peers, [])
  })

  it("burns a code after five wrong guesses", async () => {
    const { code } = mac.mintPairCode()
    for (let i = 0; i < 5; i++) await assert.rejects(desktop.join("http://mac.test", "0000-0000-0000"))
    await assert.rejects(desktop.join("http://mac.test", code), /not showing a pairing code/)
  })

  it("pairs both ways on the code the other machine shows, which then cannot be used again", async () => {
    const { code } = mac.mintPairCode()
    const paired = await desktop.join("mac.test", code.toLowerCase())
    assert.equal(paired.name, "mac")
    assert.equal(paired.url, "http://mac.test")
    assert.equal(paired.id, mac.state().self.id)
    assert.deepEqual(mac.state().peers.map((peer) => [peer.name, peer.id]), [["desktop", desktop.state().self.id]])
    await assert.rejects(service("laptop", "http://laptop.test").join("http://mac.test", code), /not showing a pairing code/)
  })

  it("talks over the envelope once paired: nothing of the request travels in the clear", async () => {
    // Pairing gave the mac no address for the desktop (it advertised none); give it one.
    mac.setAddress(desktop.state().self.id, "http://desktop.test")
    captured.length = 0
    const pong = await mac.ping(desktop.state().self.id)
    assert.equal(pong.name, "desktop")
    const request = captured.at(-1)!
    assert.equal(request.url, `http://desktop.test${PEER_ROUTE_PREFIX}call`)
    assert.equal(request.body.includes(Buffer.from("ping")), false)
  })

  it("refuses a replayed request and one whose clock is far off", async () => {
    const macKey = loadOrCreatePeerKey(join(root, "mac"))
    const desktopKey = loadOrCreatePeerKey(join(root, "desktop"))
    const send = async (head: Record<string, unknown>) => {
      const sent = sealRequest(macKey, desktopKey.publicKey, frameMessage(head))
      const answer = async () => unframeMessage(sent.openResponse(Buffer.from(await (await desktop.handle(new Request(`http://desktop.test${PEER_ROUTE_PREFIX}call`, { method: "POST", body: new Uint8Array(sent.body) }), origin)).arrayBuffer()))).head
      return { first: await answer(), again: await answer() }
    }
    const ping = await send({ op: "ping", id: "req-1", ts: Date.now(), args: {} })
    assert.deepEqual(ping.first, { ok: true, result: { name: "desktop", protocol: 1 } })
    assert.deepEqual(ping.again, { ok: false, error: "replayed request" })
    const late = await send({ op: "ping", id: "req-2", ts: Date.now() - 10 * 60_000, args: {} })
    assert.deepEqual(late.first, { ok: false, error: "the two machines' clocks disagree by more than 5m" })
  })

  it("still refuses a replayed request after the receiving server restarts", async () => {
    const macKey = loadOrCreatePeerKey(join(root, "mac"))
    const desktopKey = loadOrCreatePeerKey(join(root, "desktop"))
    const sent = sealRequest(macKey, desktopKey.publicKey, frameMessage({ op: "ping", id: "req-restart", ts: Date.now(), args: {} }))
    const ask = async (to: PeerService) => unframeMessage(sent.openResponse(Buffer.from(await (await to.handle(new Request(`http://desktop.test${PEER_ROUTE_PREFIX}call`, { method: "POST", body: new Uint8Array(sent.body) }), origin)).arrayBuffer()))).head
    assert.deepEqual(await ask(desktop), { ok: true, result: { name: "desktop", protocol: 1 } })
    const home = join(root, "desktop")
    const restarted = createPeerService({ home, name: "desktop", fetch: loopFetch, startListener: false, workspaces: () => [], openProject: async () => undefined, storePath: join(home, "peers.json") })
    assert.deepEqual(await ask(restarted), { ok: false, error: "replayed request" })
    assert.equal(statSync(join(home, "peer-seen.json")).mode & 0o777, 0o600)
  })

  it("refuses a stranger having read only its envelope header, however much it sends", async () => {
    let pulled = 0
    const header = Buffer.concat([ENVELOPE_MAGIC, generatePeerKey().publicKey, generatePeerKey().publicKey])
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => controller.enqueue(new Uint8Array(header)),
      pull: (controller) => {
        // 32 MB in 1 MB chunks: what the route held before it judged the sender.
        if (pulled >= 32) return controller.close()
        pulled += 1
        controller.enqueue(new Uint8Array(1024 * 1024))
      },
    })
    const response = await desktop.handle(new Request(`http://desktop.test${PEER_ROUTE_PREFIX}call`, { method: "POST", body, duplex: "half" } as RequestInit), origin)
    assert.equal(response.status, 403)
    assert.equal(await response.text(), "this machine is not paired with the sender")
    // The stream may prefetch one chunk past what was read; never the rest.
    assert.ok(pulled <= 1, `pulled ${pulled} MB`)
  })

  it("refuses an unpaired machine's envelope before reading it", async () => {
    const stranger = service("stranger", "http://stranger.test")
    const { code } = desktop.mintPairCode()
    // The stranger pairs with the DESKTOP, then tries the mac, which never paired with it.
    await stranger.join("http://desktop.test", code)
    const mac = services.get("http://mac.test")!
    stranger.setAddress(desktop.state().self.id, "http://mac.test")
    await assert.rejects(stranger.ping(desktop.state().self.id), /refused this machine: this machine is not paired with the sender/)
    assert.equal(mac.state().peers.some((peer) => peer.name === "stranger"), false)
  })

  it("forgets a machine on both sides when one unpairs", async () => {
    await desktop.unpair(mac.state().self.id)
    assert.equal(desktop.state().peers.some((peer) => peer.name === "mac"), false)
    assert.equal(mac.state().peers.some((peer) => peer.name === "desktop"), false)
    assert.ok(readFileSync(join(root, "mac", "peers.json"), "utf8").includes('"peers"'))
  })
})

describe("matching a project across machines by its remotes", () => {
  it("reads every common remote form as the same host/owner/repo", () => {
    const same = [
      "git@github.com:ssalbdivad/ntwine.git",
      "https://github.com/ssalbdivad/ntwine",
      "https://github.com/ssalbdivad/ntwine.git/",
      "ssh://git@github.com:22/ssalbdivad/ntwine.git",
      "https://token@GitHub.com/SsalbDivad/Ntwine.git",
    ].map((url) => remoteIdentity(url, "/"))
    assert.deepEqual(new Set(same), new Set(["github.com/ssalbdivad/ntwine"]))
  })

  it("reads a remote on this disk as its real path", () => {
    assert.equal(remoteIdentity("/srv/git/app.git", "/"), "file:/srv/git/app")
    assert.equal(remoteIdentity("../remote.git", "/a/b"), "file:/a/remote")
  })
})

// ---- a destination whose answers the test writes, and a resting thread to move to it ----

function git(cwd: string, ...args: string[]) {
  execFileSync("git", args, { cwd, stdio: "ignore" })
}

/** A checkout with a remote, and a project in a folder of it (no `.git` of its own, so no WIP plan). */
function repoProject(name: string): string {
  const repo = join(root, name, "repo")
  mkdirSync(join(repo, "app"), { recursive: true })
  git(repo, "init", "-q")
  git(repo, "remote", "add", "origin", "https://github.com/example/app.git")
  return join(repo, "app")
}

function request(from: PeerKeyPair, to: Buffer, head: Record<string, unknown>) {
  const sent = sealRequest(from, to, frameMessage({ id: crypto.randomUUID(), ts: Date.now(), ...head }, Buffer.from("not a bundle")))
  return {
    send: async (service: PeerService) => unframeMessage(sent.openResponse(Buffer.from(await (await service.handle(new Request(`http://dest.test${PEER_ROUTE_PREFIX}call`, { method: "POST", body: new Uint8Array(sent.body) }), origin)).arrayBuffer()))).head,
  }
}

describe("a destination taking in a thread", () => {
  const home = join(root, "gate")
  const dir = repoProject("gate")
  const sender = generatePeerKey()
  openPeerStore(join(home, "peers.json")).upsert({ name: "mac", url: "", publicKey: sender.publicKey.toString("base64url"), pairedAt: new Date().toISOString() })
  let opened = 0
  let release: (value: undefined) => void = () => {}
  const dest = createPeerService({
    home, name: "dest", startListener: false, storePath: join(home, "peers.json"),
    workspaces: () => [{ id: "proj-dest", path: dir }],
    // The first import parks here, holding the gate, until the test lets it go.
    openProject: () => (++opened === 1 ? new Promise<undefined>((resolve) => { release = resolve }) : Promise.resolve(undefined)),
  })
  const destKey = loadOrCreatePeerKey(home)
  const importing = (moveId: string) => request(sender, destKey.publicKey, { op: "import", args: { identities: ["github.com/example/app"], moveId } })

  it("takes one import at a time, and tells a second delivery of the same move that it is not decided yet", async () => {
    const first = importing("move-1").send(dest)
    while (opened === 0) await new Promise((done) => setImmediate(done))
    assert.deepEqual(await importing("move-2").send(dest), { ok: false, error: "dest is taking in another thread; try again in a moment" })
    assert.deepEqual(await importing("move-1").send(dest), { ok: false, error: "This thread is already arriving", unconfirmed: true })
    assert.equal(opened, 1)
    release(undefined)
    assert.deepEqual(await first, { ok: false, error: "dest could not open its copy of this project" })
    assert.deepEqual(await importing("move-2").send(dest), { ok: false, error: "dest could not open its copy of this project" })
  })
})

describe("moving a thread when the answer to its import cannot be authenticated", () => {
  const home = join(root, "origin-home")
  const dir = repoProject("origin")
  const stateDir = join(root, "origin", "state")
  mkdirSync(stateDir, { recursive: true })
  const sid = "0b6c9d64-5f3e-4c2a-9a51-6d0b1f2e3a4b"
  const bucket = join(home, ".claude", "projects", cwdSlug(dir))
  mkdirSync(bucket, { recursive: true })
  writeFileSync(join(bucket, `${sid}.jsonl`), `${JSON.stringify({ type: "user", cwd: dir, message: { role: "user", content: "fix it" } })}\n`)
  const db = openNtwineDatabase({ path: join(root, "origin", "ui.db") })
  after(() => db.db.close())
  const storage = createStorage(db.db, "proj-origin")
  storage.upsertSession({
    slug: "fix-parser", session_id: sid, thread_name: "ntwine-fix-parser", spawned_at: "2026-11-12T10:00:00.000Z",
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: "2026-11-12T10:05:00.000Z", title_auto: 0,
    title: "Fix the parser", state: "open", meta: null, seen_at: null, transcript_id: null,
  })
  storage.setBackend("fix-parser", "claude")
  storage.setClaudeRuntime("fix-parser", "broker")
  const ctx = {
    project: { id: "proj-origin", name: "app", dir, workDir: dir, stateDir },
    storage,
    tailer: { get: () => ({ turn: "idle", subAgents: [], bgShells: [] }) },
    board: { rebuild: async () => {} },
  } as unknown as AppContext

  // The destination's key, and a fetch that plays it: `prepare` gets a real sealed yes; `import` gets
  // whatever the test (an attacker on the path, or the destination itself) answers.
  const destKey = generatePeerKey()
  let answerImport: (sealed: (head: unknown) => Response) => Response = () => new Response("unset", { status: 500 })
  const fakeFetch: typeof fetch = async (_input, init) => {
    const received = openRequest(destKey, Buffer.from(init?.body as Uint8Array), () => true)
    const head = unframeMessage(received.plaintext).head as { op: string }
    const sealed = (answer: unknown) => new Response(new Uint8Array(received.sealResponse(frameMessage(answer))), { status: 200 })
    return head.op === "prepare" ? sealed({ ok: true, result: { project: "app", dir: "/dest/app" } }) : answerImport(sealed)
  }
  const origin = createPeerService({ home, name: "origin", fetch: fakeFetch, startListener: false, storePath: join(home, "peers.json"), workspaces: () => [], openProject: async () => undefined })
  const peerId = openPeerStore(join(home, "peers.json")).upsert({ name: "dest", url: "http://dest.test", publicKey: destKey.publicKey.toString("base64url"), pairedAt: new Date().toISOString() }).id
  const stamp = () => JSON.parse(storage.getSession("fix-parser")?.moved_to ?? "null") as { pending?: boolean } | null

  it("keeps the move pending on a plain refusal or an answer that does not open, and clears it only on the destination's sealed no", async () => {
    answerImport = () => new Response("this machine is not paired with the sender", { status: 403 })
    await assert.rejects(origin.move(ctx, "fix-parser", peerId), /dest refused this machine: this machine is not paired with the sender\. The thread may already be on dest/)
    assert.equal(stamp()?.pending, true)

    answerImport = () => new Response(new Uint8Array(64), { status: 200 })
    await assert.rejects(origin.move(ctx, "fix-parser", peerId), /dest's answer could not be verified\. The thread may already be on dest/)
    assert.equal(stamp()?.pending, true)

    answerImport = (sealed) => sealed({ ok: false, error: "Its branch has diverged here" })
    await assert.rejects(origin.move(ctx, "fix-parser", peerId), { message: "Its branch has diverged here" })
    assert.equal(stamp(), null)
  })
})

describe("moving a main-checkout thread with nothing uncommitted", () => {
  it("sends no checkout, so the other clone's own main never refuses it", async () => {
    const home = join(root, "clean-home")
    const dir = join(root, "clean", "repo")
    mkdirSync(dir, { recursive: true })
    git(dir, "init", "-q")
    git(dir, "remote", "add", "origin", "https://github.com/example/clean.git")
    writeFileSync(join(dir, "a.txt"), "a\n")
    git(dir, "add", "-A")
    git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "seed")
    const stateDir = join(root, "clean", "state")
    mkdirSync(stateDir, { recursive: true })
    const sid = "1b6c9d64-5f3e-4c2a-9a51-6d0b1f2e3a4b"
    const bucket = join(home, ".claude", "projects", cwdSlug(dir))
    mkdirSync(bucket, { recursive: true })
    writeFileSync(join(bucket, `${sid}.jsonl`), `${JSON.stringify({ type: "user", cwd: dir, message: { role: "user", content: "look around" } })}\n`)
    const db = openNtwineDatabase({ path: join(root, "clean", "ui.db") })
    after(() => db.db.close())
    const storage = createStorage(db.db, "proj-clean")
    storage.upsertSession({
      slug: "look-around", session_id: sid, thread_name: "ntwine-look-around", spawned_at: "2026-11-12T10:00:00.000Z",
      last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: "2026-11-12T10:05:00.000Z", title_auto: 0,
      title: "Look around", state: "open", meta: null, seen_at: null, transcript_id: null,
    })
    storage.setBackend("look-around", "claude")
    storage.setClaudeRuntime("look-around", "broker")
    const ctx = {
      project: { id: "proj-clean", name: "clean", dir, workDir: dir, stateDir, cwdSlug: cwdSlug(dir) },
      storage,
      tailer: { get: () => ({ turn: "idle", subAgents: [], bgShells: [] }) },
      board: { rebuild: async () => {} },
    } as unknown as AppContext
    const destKey = generatePeerKey()
    let sentGit: unknown = "never sent"
    const fakeFetch: typeof fetch = async (_input, init) => {
      const received = openRequest(destKey, Buffer.from(init?.body as Uint8Array), () => true)
      const { head, blob } = unframeMessage(received.plaintext) as { head: { op: string }; blob?: Buffer }
      const sealed = (answer: unknown) => new Response(new Uint8Array(received.sealResponse(frameMessage(answer))), { status: 200 })
      if (head.op === "prepare") return sealed({ ok: true, result: { project: "clean", dir: "/dest/clean" } })
      sentGit = (await unpackBundle(blob!)).manifest.git
      return sealed({ ok: true, result: { slug: "look-around", notes: [] } })
    }
    const service = createPeerService({ home, name: "origin", fetch: fakeFetch, startListener: false, storePath: join(home, "peers.json"), workspaces: () => [], openProject: async () => undefined })
    const peerId = openPeerStore(join(home, "peers.json")).upsert({ name: "dest", url: "http://dest.test", publicKey: destKey.publicKey.toString("base64url"), pairedAt: new Date().toISOString() }).id
    assert.equal((await service.preview(ctx, "look-around", peerId)).checkout, undefined)
    await service.move(ctx, "look-around", peerId)
    assert.equal(sentGit, null)
  })
})

describe("resuming a thread on the machine it left", () => {
  const sid = "2b6c9d64-5f3e-4c2a-9a51-6d0b1f2e3a4b"
  const identities = ["github.com/example/app"]
  function side(name: string) {
    const home = join(root, `recall-${name}`)
    const dir = repoProject(`recall-${name}`)
    const stateDir = join(home, "state")
    mkdirSync(stateDir, { recursive: true })
    const db = openNtwineDatabase({ path: join(home, "ui.db") })
    after(() => db.db.close())
    const storage = createStorage(db.db, `proj-${name}`)
    const state = { busy: false }
    const ctx = {
      project: { id: `proj-${name}`, name: "app", dir, workDir: dir, stateDir },
      storage,
      tailer: { get: () => ({ turn: state.busy ? "running" : "idle", subAgents: [], bgShells: [] }), nudge: () => {} },
      board: { rebuild: async () => {}, refresh: () => {} },
    } as unknown as AppContext
    return { name, home, dir, storage, ctx, state, key: loadOrCreatePeerKey(home), url: `http://recall-${name}.test` }
  }
  const mac = side("mac")
  const desktop = side("desktop")
  const stranger = generatePeerKey()
  const pair = (on: typeof mac, other: { name: string; url: string; key: PeerKeyPair }) =>
    openPeerStore(join(on.home, "peers.json")).upsert({ name: other.name, url: other.url, publicKey: other.key.publicKey.toString("base64url"), pairedAt: new Date().toISOString() }).id
  const desktopId = pair(mac, desktop)
  pair(desktop, mac)
  pair(desktop, { name: "stranger", url: "", key: stranger })

  // The desktop cannot reach the mac at all (it cannot resolve the mac's name, say): everything below
  // must work from the mac's calls alone. `loseNextAnswer`: the next call reaches the other machine,
  // which acts on it, and its answer never comes back.
  let loseNextAnswer = false
  const recallFetch: typeof fetch = async (input, init) => {
    if (String(input).startsWith(mac.url)) throw new TypeError("fetch failed")
    const response = await loopFetch(input, init)
    if (!loseNextAnswer) return response
    loseNextAnswer = false
    throw new TypeError("fetch failed")
  }
  const serve = (s: typeof mac) => {
    const created = createPeerService({ home: s.home, name: s.name, fetch: recallFetch, startListener: false, storePath: join(s.home, "peers.json"), workspaces: () => [{ id: s.ctx.project.id, path: s.dir }], openProject: async () => s.ctx })
    services.set(s.url, created)
    return created
  }
  const macPeers = serve(mac)
  const desktopPeers = serve(desktop)

  mac.storage.upsertSession({
    slug: "fix-parser", session_id: sid, thread_name: "ntwine-fix-parser", spawned_at: "2026-11-12T10:00:00.000Z",
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: "2026-11-12T10:05:00.000Z", title_auto: 0,
    title: "Fix the parser", state: "open", meta: null, seen_at: null, transcript_id: null,
  })
  mac.storage.setBackend("fix-parser", "claude")
  mac.storage.setClaudeRuntime("fix-parser", "broker")
  const macBucket = join(mac.home, ".claude", "projects", cwdSlug(mac.dir))
  mkdirSync(macBucket, { recursive: true })
  writeFileSync(join(macBucket, `${sid}.jsonl`), `${JSON.stringify({ type: "user", cwd: mac.dir, message: { role: "user", content: "fix it" } })}\n`)

  const awayOf = (s: typeof mac) => movedStamp(s.storage.getSession("fix-parser")?.moved_to)
  const history = (s: typeof mac) => moveLogOf(s.storage.getSession("fix-parser")?.move_log).map((entry) => `${entry.from} > ${entry.to}`)

  it("refuses a machine the thread did not come from, and a thread still busy there, changing nothing", async () => {
    await macPeers.move(mac.ctx, "fix-parser", desktopId)
    assert.equal(awayOf(mac)?.peerName, "desktop")
    // A pairing lets a machine hand threads over; it does not let it take this machine's threads.
    const asked = await request(stranger, desktop.key.publicKey, { op: "recall", args: { identities, slug: "fix-parser", sessionId: sid, moveId: "m" } }).send(desktopPeers)
    assert.deepEqual(asked, { ok: false, error: "desktop's copy of this thread did not come from stranger" })
    desktop.state.busy = true
    await assert.rejects(macPeers.recall(mac.ctx, "fix-parser"), { message: "desktop cannot hand it back yet: wait for the thread to come to rest" })
    desktop.state.busy = false
    assert.equal(awayOf(desktop), undefined)
    assert.equal(awayOf(mac)?.pending, undefined)
  })

  it("leaves the thread running there when it cannot be written here", async () => {
    const notes = join(mac.dir, ".ntwine", "threads", sid)
    mkdirSync(join(mac.dir, ".ntwine", "threads"), { recursive: true })
    symlinkSync(root, notes)
    try {
      await assert.rejects(macPeers.recall(mac.ctx, "fix-parser"), /is a symlink, so the thread's notes cannot be placed\. It stays on desktop$/)
    } finally {
      rmSync(notes)
    }
    assert.equal(awayOf(desktop), undefined, "the desktop was told to keep it")
    assert.equal(awayOf(mac)?.peerName, "desktop")
  })

  it("comes back with its history, finishing on a retry when the first answer is lost", async () => {
    loseNextAnswer = true
    await assert.rejects(macPeers.recall(mac.ctx, "fix-parser"), /desktop may be holding it for this machine/)
    const held = awayOf(desktop)
    assert.deepEqual([held?.peerName, held?.pending], ["mac", true], "the desktop packed it for the mac and runs it nowhere")

    const back = await macPeers.recall(mac.ctx, "fix-parser")
    assert.deepEqual(back, { peer: { id: desktopId, name: "desktop" }, slug: "fix-parser", notes: ["Its checkout did not move: it had no uncommitted work in this project's repository"] })
    assert.equal(awayOf(mac), undefined)
    assert.equal(movedStamp(mac.storage.getSession("fix-parser")?.moved_from)?.moveId, held!.moveId, "the retry finished the same hand-back")
    const left = awayOf(desktop)
    assert.deepEqual([left?.peerName, left?.moveId, left?.pending], ["mac", held!.moveId, undefined], "and the desktop let go of it")
    assert.equal(desktop.storage.getSession("fix-parser")?.state, "archived")
    assert.deepEqual(history(mac), ["mac > desktop", "desktop > mac"])
    assert.deepEqual(history(desktop), ["mac > desktop", "desktop > mac"])
    await assert.rejects(macPeers.recall(mac.ctx, "fix-parser"), { message: "This thread is already on this machine" })
  })
})
