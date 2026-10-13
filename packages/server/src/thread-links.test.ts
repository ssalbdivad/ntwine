import assert from "node:assert/strict"
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import test from "node:test"
import { UpsertOwnLinkInput } from "@ntwine/shared"
import type { AppContext } from "./context.ts"
import { createRouter } from "./router.ts"
import { createStorage, type SessionRow } from "./storage.ts"
import { resolveThreadLink } from "./thread-links.ts"

function harness() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-links-")))
  const path = join(dir, "ui.db")
  const storage = createStorage(path, "links-a")
  for (const slug of ["own", "other"]) storage.upsertSession({
    slug, session_id: `sid-${slug}`, thread_name: `ntwine-${slug}`, spawned_at: new Date().toISOString(),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0,
    title: slug, state: "open", meta: null, seen_at: null, transcript_id: null,
  } satisfies SessionRow)
  let refreshes = 0
  const router = createRouter({
    project: { dir, stateDir: dir }, storage,
    board: { refresh: () => { refreshes++ } }, tailer: { get: () => undefined },
  } as unknown as AppContext)
  return { dir, path, storage, router, refreshes: () => refreshes, close: () => { storage.close(); rmSync(dir, { recursive: true, force: true }) } }
}

test("registration updates one labeled slot, persists, and is not running work or a completion blocker", async () => {
  const h = harness()
  try {
    h.storage.markThreadDone("own", "Finished", 1)
    const add = (target: string) => h.router.upsertOwnLink.handler({ input: UpsertOwnLinkInput.parse({ slug: "own", label: "Open dev server", target }) })
    const first = (await add("http://localhost:5173")).link
    const second = (await add("http://localhost:6173")).link
    assert.equal(second.id, first.id)
    assert.equal(second.target, "http://localhost:6173/")
    assert.equal(h.storage.listThreadLinks("own").length, 1)
    assert.equal(h.refreshes(), 2)
    assert.equal(h.storage.getThreadDone("own")?.body, "Finished")
    const activity = await h.router.listOwnThreadActivity.handler({ input: { slug: "own" } })
    assert.deepEqual(activity.activity, [])
    assert.deepEqual(activity.links, [second])
    const reopened = createStorage(h.path, "links-a")
    try { assert.equal(reopened.listThreadLinks("own")[0].id, first.id) } finally { reopened.close() }
  } finally { h.close() }
})

test("local files resolve from the project and keep the existing opener's trust boundary", async () => {
  const h = harness()
  try {
    const path = join(h.dir, "working plan.md")
    writeFileSync(path, "# Working plan\n")
    for (const target of ["working plan.md", path, pathToFileURL(path).href]) {
      const { link } = await h.router.upsertOwnLink.handler({ input: { slug: "own", label: "Working plan", target } })
      assert.equal(link.kind, "file")
      assert.equal(link.target, path)
    }
    assert.equal(h.storage.listThreadLinks("own").length, 1)
    assert.throws(() => resolveThreadLink(h.dir, h.dir, [h.dir]), /not found|trusted roots/)
    assert.throws(() => resolveThreadLink("missing.md", h.dir, [h.dir]), /not found/)
    const outside = mkdtempSync(join(tmpdir(), "ntwine-link-outside-"))
    try {
      writeFileSync(join(outside, "private.md"), "outside")
      symlinkSync(join(outside, "private.md"), join(h.dir, "escape.md"))
      assert.throws(() => resolveThreadLink("escape.md", h.dir, [h.dir]), /trusted roots/)
    } finally { rmSync(outside, { recursive: true, force: true }) }
  } finally { h.close() }
})

test("unsafe URLs and malformed registrations are refused without changing saved rows", async () => {
  const h = harness()
  try {
    for (const target of ["javascript:alert(1)", "data:text/html,x", "ftp://example.com/a", "http://", "http://user:secret@example.com", "file:///tmp/a.md#heading"]) {
      await assert.rejects(h.router.upsertOwnLink.handler({ input: { slug: "own", label: "Bad", target } }))
    }
    for (const fields of [{ label: "", target: "https://example.com" }, { label: "Line\nbreak", target: "https://example.com" }, { label: "URL", target: "https://example.com/\u0000" }]) {
      assert.equal(UpsertOwnLinkInput.safeParse({ slug: "own", ...fields }).success, false)
    }
    assert.equal(h.storage.listThreadLinks("own").length, 0)
    assert.equal(h.refreshes(), 0)
    await assert.rejects(h.router.upsertOwnLink.handler({ input: { slug: "absent", label: "A", target: "https://example.com" } }), /not registered/)
    h.storage.setState("own", "archived")
    await assert.rejects(h.router.upsertOwnLink.handler({ input: { slug: "own", label: "A", target: "https://example.com" } }), /Reopen/)
  } finally { h.close() }
})

test("same-slug projects and other threads cannot overwrite or remove each other's registrations", async () => {
  const h = harness()
  const other = createStorage(h.path, "links-b")
  try {
    const { link } = await h.router.upsertOwnLink.handler({ input: { slug: "own", label: "Plan", target: "https://example.com" } })
    const foreign = other.upsertThreadLink({ id: "lnk_foreign", slug: "own", kind: "link", label: "Plan", target: "https://other.example/", createdAtMs: 1 })
    assert.equal(other.dropThreadLink("own", link.id), false)
    assert.equal((await h.router.dropOwnLink.handler({ input: { slug: "other", id: link.id } })).dropped, false)
    assert.equal(h.storage.listThreadLinks("own")[0].id, link.id)
    assert.equal(other.listThreadLinks("own")[0].id, foreign.id)
    assert.deepEqual(h.storage.threadLinksBySlug().get("own"), h.storage.listThreadLinks("own"))
    assert.equal((await h.router.dropOwnLink.handler({ input: { slug: "own", id: link.id } })).dropped, true)
    assert.equal((await h.router.dropOwnLink.handler({ input: { slug: "own", id: link.id } })).dropped, false)
    assert.equal(other.listThreadLinks("own").length, 1)
    await h.router.upsertOwnLink.handler({ input: { slug: "own", label: "Plan", target: "https://example.com" } })
    h.storage.forgetSession("own")
    assert.deepEqual(h.storage.listThreadLinks("own"), [])
    assert.equal(other.listThreadLinks("own").length, 1)
  } finally { other.close(); h.close() }
})
