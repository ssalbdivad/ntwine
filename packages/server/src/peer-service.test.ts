import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"
import type { RequestOrigin } from "./audit.ts"
import { createPeerService, PEER_ROUTE_PREFIX, remoteIdentity, type PeerService } from "./peer-service.ts"
import { frameMessage, sealRequest, unframeMessage } from "./peer-crypto.ts"
import { loadOrCreatePeerKey, peerKeyPath } from "./peer-store.ts"

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
