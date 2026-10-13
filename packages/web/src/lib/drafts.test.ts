import assert from "node:assert/strict"
import test from "node:test"
import { DRAFT_STORAGE_KEY, DRAFT_TTL_MS, DraftStore, draftKey, draftStore, mergeIntoDraft, parseDraftSnapshot } from "./drafts.ts"

class MemoryStorage {
  values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
  removeItem(key: string) { this.values.delete(key) }
}

test("draft snapshot rejects corrupt, old and oversized schema entries", () => {
  assert.deepEqual(parseDraftSnapshot("{"), { version: 1, entries: {} })
  assert.deepEqual(parseDraftSnapshot(JSON.stringify({ version: 0, entries: { a: { value: "x", touchedAt: 1 } } })), { version: 1, entries: {} })
  const huge = "x".repeat(513 * 1024)
  assert.deepEqual(parseDraftSnapshot(JSON.stringify({ version: 1, entries: { a: { value: huge, touchedAt: 1 } } })), { version: 1, entries: {} })
})

test("typing across the persistence boundary never blanks the live controlled draft", () => {
  const storage = new MemoryStorage()
  const drafts = new DraftStore(storage)
  const key = "long"
  const atLimit = "x".repeat(512 * 1024)
  const overLimit = `${atLimit}y`
  drafts.set(key, atLimit)
  assert.equal(drafts.get(key), atLimit)
  drafts.set(key, overLimit)
  assert.equal(drafts.get(key), overLimit, "the current tab retains the exact over-limit text")
  assert.equal(new DraftStore(storage).get(key), "", "the bounded reload snapshot omits only the unpersistable value")
})

test("drafts hydrate, clear, evict older values, and remain project/session isolated", () => {
  const storage = new MemoryStorage()
  const first = new DraftStore(storage)
  const a = draftKey.followUp("/one", "thread", "session-a")
  const b = draftKey.followUp("/one", "thread", "session-b")
  const otherProject = draftKey.followUp("/two", "thread", "session-a")
  first.set(a, "keep me")
  first.set(b, "other session")
  first.set(otherProject, "other project")
  assert.equal(new DraftStore(storage).get(a), "keep me")
  assert.equal(new DraftStore(storage).get(b), "other session")
  assert.equal(new DraftStore(storage).get(otherProject), "other project")
  first.clear(a)
  assert.equal(new DraftStore(storage).get(a), "")
  for (let i = 0; i < 100; i++) first.set(`k${i}`, String(i))
  const parsed = JSON.parse(storage.getItem(DRAFT_STORAGE_KEY)!) as { entries: Record<string, unknown> }
  assert.ok(Object.keys(parsed.entries).length <= 80)
})

// TWO STORES OVER ONE STORAGE ARE TWO TABS. The queue card in one and the thread's /full page in the
// other are the same prompt box, and before drafts were shared the second tab opened on an empty one.
test("a draft typed in one tab is in a tab opened after it, and reaches one already open", () => {
  const storage = new MemoryStorage()
  const key = draftKey.followUp("/one", "thread", "session")
  const board = new DraftStore(storage)
  const alreadyOpen = new DraftStore(storage)
  let heard = 0
  alreadyOpen.subscribe(() => { heard++ })
  board.set(key, "typed in the queue card")
  assert.equal(new DraftStore(storage).get(key), "typed in the queue card", "a tab opened afterwards reads it")
  assert.equal(alreadyOpen.get(key), "", "an open tab holds its own snapshot until the browser tells it")
  alreadyOpen.refresh()
  assert.equal(alreadyOpen.get(key), "typed in the queue card")
  assert.equal(heard, 1)
  alreadyOpen.refresh()
  assert.equal(heard, 1, "nothing new stored, nothing re-rendered")
  // The send empties the box everywhere, not just where Send was pressed.
  board.clear(key)
  alreadyOpen.refresh()
  assert.equal(alreadyOpen.get(key), "")
  assert.equal(heard, 2)
})

// Every write stores the whole snapshot, so a tab that wrote from a stale one would undo the others.
test("a tab that missed the other's write neither erases its draft nor brings back a sent one", () => {
  const storage = new MemoryStorage()
  const mine = draftKey.followUp("/one", "mine", "session")
  const theirs = draftKey.followUp("/one", "theirs", "session")
  const sent = draftKey.followUp("/one", "sent", "session")
  const a = new DraftStore(storage)
  a.set(sent, "about to be sent")
  const b = new DraftStore(storage)
  assert.equal(b.get(sent), "about to be sent")
  a.clear(sent)
  a.set(theirs, "typed in the other tab")
  // No refresh: b writes with whatever it last saw.
  b.set(mine, "typed here")
  const reloaded = new DraftStore(storage)
  assert.equal(reloaded.get(theirs), "typed in the other tab")
  assert.equal(reloaded.get(mine), "typed here")
  assert.equal(reloaded.get(sent), "", "the cleared draft stays cleared")
  assert.equal(b.get(theirs), "typed in the other tab", "and the writing tab caught up as it wrote")
})

test("another tab's write never blanks a value this tab could not store", () => {
  const storage = new MemoryStorage()
  const long = draftKey.followUp("/one", "long", "session")
  const other = draftKey.followUp("/one", "other", "session")
  const a = new DraftStore(storage)
  const b = new DraftStore(storage)
  const overLimit = "x".repeat(512 * 1024 + 1)
  a.set(long, overLimit)
  b.set(other, "short")
  a.refresh()
  assert.equal(a.get(long), overLimit)
  assert.equal(a.get(other), "short")
  // Emptied storage (site data cleared under the page) is not a reason to blank a live box either.
  storage.values.clear()
  b.refresh()
  assert.equal(b.get(other), "short")
})

test("a draft untouched past its lifetime is not read back", () => {
  const storage = new MemoryStorage()
  const now = Date.now()
  storage.setItem(DRAFT_STORAGE_KEY, JSON.stringify({ version: 1, entries: {
    stale: { value: "from a thread archived long ago", touchedAt: now - DRAFT_TTL_MS - 60_000 },
    recent: { value: "still wanted", touchedAt: now - DRAFT_TTL_MS + 60_000 },
  } }))
  const drafts = new DraftStore(storage)
  assert.equal(drafts.get("stale"), "")
  assert.equal(drafts.get("recent"), "still wanted")
})

// The move out of sessionStorage: what this tab typed before the build that moved them is not lost.
test("a tab's old sessionStorage drafts are folded in once, the newer copy of a key winning", () => {
  const shared = new MemoryStorage()
  const tab = new MemoryStorage()
  const now = Date.now()
  shared.setItem(DRAFT_STORAGE_KEY, JSON.stringify({ version: 1, entries: {
    both: { value: "newer, from another tab", touchedAt: now },
    onlyShared: { value: "shared", touchedAt: now },
  } }))
  tab.setItem(DRAFT_STORAGE_KEY, JSON.stringify({ version: 1, entries: {
    both: { value: "older, from this tab", touchedAt: now - 5_000 },
    onlyTab: { value: "typed before the move", touchedAt: now - 5_000 },
  } }))
  const drafts = new DraftStore(shared, tab)
  assert.equal(drafts.get("onlyTab"), "typed before the move")
  assert.equal(drafts.get("both"), "newer, from another tab")
  assert.equal(drafts.get("onlyShared"), "shared")
  assert.equal(tab.getItem(DRAFT_STORAGE_KEY), null, "the old key is retired")
  assert.equal(new DraftStore(shared).get("onlyTab"), "typed before the move", "and the words are in the shared store")
})

test("interaction keys include epoch so an old session cannot receive a new session draft", () => {
  const oldKey = draftKey.interaction("/project", "project", "thread", "session", 1, "ask", "text")
  const newKey = draftKey.interaction("/project", "project", "thread", "session", 2, "ask", "text")
  assert.notEqual(oldKey, newKey)
})

test("answer drafts use the transcript message identity and session, never a queue position", () => {
  const first = draftKey.answer("/project", "thread", "session-a", "message-a", 0)
  const sameQuestionInDrawer = draftKey.answer("/project", "thread", "session-a", "message-a", 0)
  const reorderedQuestion = draftKey.answer("/project", "thread", "session-a", "message-b", 0)
  const replacementSession = draftKey.answer("/project", "thread", "session-b", "message-a", 0)
  assert.equal(first, sameQuestionInDrawer)
  assert.notEqual(first, reorderedQuestion)
  assert.notEqual(first, replacementSession)
})

// A failed send's words go back into the prompt box WITHOUT displacing what the operator typed since.
// The composer's rollback used to restore only into an EMPTY box, so a failed message was silently
// discarded the moment anything else was in it.
test("mergeIntoDraft never drops either text, and never duplicates the returned one", () => {
  const key = draftKey.followUp("/merge", "thread", "session")
  draftStore.clear(key)
  mergeIntoDraft(key, "the failed steer")
  assert.equal(draftStore.get(key), "the failed steer")
  draftStore.set(key, "typed while it was in flight")
  mergeIntoDraft(key, "the failed steer")
  assert.equal(draftStore.get(key), "the failed steer\n\ntyped while it was in flight")
  mergeIntoDraft(key, "the failed steer")
  assert.equal(draftStore.get(key), "the failed steer\n\ntyped while it was in flight", "a second rollback adds nothing")
  draftStore.clear(key)
})
