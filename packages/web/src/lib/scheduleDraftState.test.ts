// What the human said about the draft's schedule — "not a schedule", or an Undo — is part of the draft
// (scheduleDraftState.ts): a sibling key of the prompt's, surviving a remount and a same-tab reload, read as one
// value by every box on the draft, cleared and carried in the same commit as the text. And a create in flight
// owns its draft until it lands.
import assert from "node:assert/strict"
import test from "node:test"
import { DraftStore, draftKey, draftStore } from "./drafts.ts"
import {
  SCHEDULE_DRAFT_NONE,
  afterDraftCreates,
  beginDraftCreate,
  carryDispatchDraft,
  clearDispatchDraft,
  isDraftCreating,
  parseScheduleDraftState,
  readScheduleDraftState,
  routeDispatchDraft,
  serializeScheduleDraftState,
  writeScheduleDraftState,
} from "./scheduleDraftState.ts"

class MemoryStorage {
  values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
}

const dir = "/work/ntwine"
const promptKey = draftKey.dispatch(dir)
const scheduleKey = draftKey.dispatchSchedule(dir)
const pickKey = draftKey.dispatchProfile(dir)
const TEXT = "every Monday at 9am triage new issues"
const PHRASE = "every Monday at 9am"

test("the dismissal is a sibling of the prompt's key, per project", () => {
  assert.notEqual(scheduleKey, promptKey)
  assert.notEqual(scheduleKey, pickKey)
  assert.notEqual(draftKey.dispatchSchedule("/other"), scheduleKey)
})

test("nothing dismissed is the absent key; a corrupt record, or the retired mode record, dismisses nothing", () => {
  assert.equal(serializeScheduleDraftState(SCHEDULE_DRAFT_NONE), "")
  assert.equal(serializeScheduleDraftState({ v: 2, dismissed: "  " }), "")
  assert.deepEqual(parseScheduleDraftState(""), SCHEDULE_DRAFT_NONE)
  assert.deepEqual(parseScheduleDraftState("{"), SCHEDULE_DRAFT_NONE)
  assert.deepEqual(parseScheduleDraftState(JSON.stringify({ v: 2, dismissed: 3 })), SCHEDULE_DRAFT_NONE)
  // Before 2026-10-06 the record held a schedule MODE and a local grammar's per-edge dismissals.
  assert.deepEqual(parseScheduleDraftState(JSON.stringify({ v: 1, on: true, dismissed: { open: true } })), SCHEDULE_DRAFT_NONE)
  const undone = { v: 2 as const, dismissed: PHRASE, undone: true as const }
  assert.deepEqual(parseScheduleDraftState(serializeScheduleDraftState(undone)), undone)
  assert.deepEqual(parseScheduleDraftState(serializeScheduleDraftState({ v: 2, dismissed: PHRASE })), { v: 2, dismissed: PHRASE })
  // Said over a reading of earlier words, a dismissal is pending its words' own reading (scheduleIntent.ts
  // `dismissedPhrase`), and a reload must not turn it into a dismissal of the older phrase alone.
  const pending = { v: 2 as const, dismissed: "every Monday", pending: true as const }
  assert.deepEqual(parseScheduleDraftState(serializeScheduleDraftState(pending)), pending)
})

test("a dismissal survives a same-tab reload: a fresh DraftStore over the same storage reads it", () => {
  const storage = new MemoryStorage()
  const before = new DraftStore(storage)
  before.set(promptKey, TEXT)
  writeScheduleDraftState(scheduleKey, { v: 2, dismissed: PHRASE }, before)
  const after = new DraftStore(storage) // the reload
  assert.equal(after.get(promptKey), TEXT)
  assert.deepEqual(readScheduleDraftState(scheduleKey, after), { v: 2, dismissed: PHRASE })
  // Lifting it writes the absent key, so the next reload has nothing dismissed either.
  writeScheduleDraftState(scheduleKey, SCHEDULE_DRAFT_NONE, after)
  assert.equal(after.get(scheduleKey), "")
  assert.deepEqual(readScheduleDraftState(scheduleKey, new DraftStore(storage)), SCHEDULE_DRAFT_NONE)
})

test("two boxes on one key — the page box and the `c` dialog over it — see a dismissal in the same notify", () => {
  const drafts = new DraftStore(new MemoryStorage())
  const seen: Array<[string, string | undefined]> = []
  for (const box of ["page", "dialog"]) drafts.subscribe(() => seen.push([box, readScheduleDraftState(scheduleKey, drafts).dismissed]))
  writeScheduleDraftState(scheduleKey, { v: 2, dismissed: PHRASE }, drafts)
  assert.deepEqual(seen, [["page", PHRASE], ["dialog", PHRASE]])
})

test("functional writes read the store at call time, so two in one handler compose", () => {
  const drafts = new DraftStore(new MemoryStorage())
  writeScheduleDraftState(scheduleKey, { v: 2, dismissed: PHRASE }, drafts)
  writeScheduleDraftState(scheduleKey, (prev) => ({ ...prev, undone: true }), drafts)
  assert.deepEqual(readScheduleDraftState(scheduleKey, drafts), { v: 2, dismissed: PHRASE, undone: true })
})

test("clearDispatchDraft clears the prompt, the dismissal and the pick in ONE notify, and nothing else", () => {
  const storage = new MemoryStorage()
  const drafts = new DraftStore(storage)
  const otherProject = draftKey.dispatch("/elsewhere")
  drafts.set(promptKey, TEXT)
  drafts.set(pickKey, JSON.stringify({ backend: "claude", model: "opus", effort: "high" }))
  writeScheduleDraftState(scheduleKey, { v: 2, dismissed: PHRASE }, drafts)
  drafts.set(otherProject, "keep me")
  const observed: Array<{ prompt: string; dismissed: string | undefined; pick: string }> = []
  drafts.subscribe(() => observed.push({ prompt: drafts.get(promptKey), dismissed: readScheduleDraftState(scheduleKey, drafts).dismissed, pick: drafts.get(pickKey) }))
  clearDispatchDraft(dir, {}, drafts)
  assert.deepEqual(observed, [{ prompt: "", dismissed: undefined, pick: "" }], "one notify: no box ever sees the text with another draft's dismissal")
  assert.equal(drafts.get(otherProject), "keep me")
  observed.length = 0
  clearDispatchDraft(dir, {}, drafts)
  assert.deepEqual(observed, [], "nothing to clear: no notify")
})

test("clearDispatchDraft keepPick: an account alias consumes the text, not the profile about to be used", () => {
  const drafts = new DraftStore(new MemoryStorage())
  drafts.set(promptKey, "/login")
  drafts.set(pickKey, JSON.stringify({ backend: "codex", model: "gpt-5", effort: "high" }))
  writeScheduleDraftState(scheduleKey, { v: 2, dismissed: PHRASE }, drafts)
  clearDispatchDraft(dir, { keepPick: true }, drafts)
  assert.equal(drafts.get(promptKey), "")
  assert.equal(drafts.get(scheduleKey), "")
  assert.notEqual(drafts.get(pickKey), "")
})

test("re-aiming the box carries the dismissal with the text, in the same commit, and leaves nothing behind", () => {
  const a = "/work/carry-a", b = "/work/carry-b"
  draftStore.set(draftKey.dispatch(a), TEXT)
  writeScheduleDraftState(draftKey.dispatchSchedule(a), { v: 2, dismissed: PHRASE })
  // A stale record under the target with no text there: the carried draft's own state replaces it.
  writeScheduleDraftState(draftKey.dispatchSchedule(b), { v: 2, dismissed: "every Friday" })
  const observed: Array<{ text: string; dismissed: string | undefined }> = []
  const unsubscribe = draftStore.subscribe(() => observed.push({ text: draftStore.get(draftKey.dispatch(b)), dismissed: readScheduleDraftState(draftKey.dispatchSchedule(b)).dismissed }))
  carryDispatchDraft(a, b)
  unsubscribe()
  assert.equal(draftStore.get(draftKey.dispatch(b)), TEXT)
  assert.deepEqual(readScheduleDraftState(draftKey.dispatchSchedule(b)), { v: 2, dismissed: PHRASE })
  assert.equal(draftStore.get(draftKey.dispatch(a)), "")
  assert.equal(draftStore.get(draftKey.dispatchSchedule(a)), "", "nothing orphaned under the project the text left")
  for (const o of observed) assert.ok(!(o.text === TEXT && o.dismissed !== PHRASE), `observed ${JSON.stringify(o)}`)
  // Never into a draft already waiting there.
  draftStore.set(draftKey.dispatch(a), "mine")
  carryDispatchDraft(b, a)
  assert.equal(draftStore.get(draftKey.dispatch(a)), "mine")
  assert.equal(draftStore.get(draftKey.dispatch(b)), TEXT)
  for (const d of [a, b]) clearDispatchDraft(d)
})

// A CREATE IN FLIGHT owns its draft until it lands: re-aimed mid-create, the words moved to the other project
// while the create cleared the old, empty key — a second identical schedule one Enter away; and Undo of the
// previous schedule clicked mid-create merged its words above the ones being created, which then stayed.
test("a create in flight holds its draft: no carry while it creates, and the carry works again once it lands", () => {
  const a = "/work/inflight-a", b = "/work/inflight-b"
  const key = draftKey.dispatchSchedule(a)
  draftStore.set(draftKey.dispatch(a), TEXT)
  assert.equal(isDraftCreating(key), false)
  const end = beginDraftCreate(key)
  assert.equal(isDraftCreating(key), true)
  carryDispatchDraft(a, b)
  assert.equal(draftStore.get(draftKey.dispatch(b)), "", "nothing moved into the other project's box")
  assert.equal(draftStore.get(draftKey.dispatch(a)), TEXT, "the words stay where the create will take them from")
  end()
  end() // idempotent: a second end never releases another create's hold
  assert.equal(isDraftCreating(key), false)
  carryDispatchDraft(a, b)
  assert.equal(draftStore.get(draftKey.dispatch(b)), TEXT, "landed: the draft moves again")
  for (const d of [a, b]) clearDispatchDraft(d)
})

test("afterDraftCreates waits for every create on that draft, and only that draft", async () => {
  const key = draftKey.dispatchSchedule("/work/inflight-c")
  const other = draftKey.dispatchSchedule("/work/inflight-d")
  const settled = (p: Promise<void>) => Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 20))])
  assert.equal(await settled(afterDraftCreates(key)), true, "nothing in flight: at once")
  const first = beginDraftCreate(key)
  const second = beginDraftCreate(key)
  const busy = beginDraftCreate(other)
  const waiting = afterDraftCreates(key)
  assert.equal(await settled(waiting), false, "two in flight")
  first()
  assert.equal(await settled(waiting), false, "one still in flight")
  second()
  assert.equal(await settled(waiting), true, "both landed; the other draft's create does not hold this one")
  busy()
})

// ONE HELD ENTER PER DRAFT (finding A). The page box held an Enter; the \`c\` dialog opened on the same draft and its
// Enter held too; the one answer landed in both, in one effect pass, and each acted: two identical schedules, or
// two threads. A hold is now the draft's: the newest Enter takes it, and the box that held it before lets go.

// A leading `#slug` ADDRESSES the words, so unlike a re-aim they go even where the target holds a draft —
// above it, so neither is lost.
test("a routed draft moves into an empty box, goes above a waiting draft, and stays put when it cannot go", () => {
  const a = "/work/route-a", b = "/work/route-b", c = "/work/route-c"
  draftStore.set(draftKey.dispatch(a), "#route-b fix it")
  assert.equal(routeDispatchDraft(a, b, "fix it"), true)
  assert.equal(draftStore.get(draftKey.dispatch(b)), "fix it")
  assert.equal(draftStore.get(draftKey.dispatch(a)), "")
  draftStore.set(draftKey.dispatch(c), "waiting")
  writeScheduleDraftState(draftKey.dispatchSchedule(b), { v: 2, dismissed: PHRASE })
  assert.equal(routeDispatchDraft(b, c, "fix it"), true)
  assert.equal(draftStore.get(draftKey.dispatch(c)), "fix it\n\nwaiting")
  assert.equal(draftStore.get(draftKey.dispatch(b)), "")
  assert.equal(draftStore.get(draftKey.dispatchSchedule(b)), "", "nothing orphaned under the project the text left")
  assert.equal(routeDispatchDraft(c, undefined, "x"), false, "no directory for the target yet")
  assert.equal(draftStore.get(draftKey.dispatch(c)), "fix it\n\nwaiting")
  for (const d of [a, b, c]) clearDispatchDraft(d)
})
