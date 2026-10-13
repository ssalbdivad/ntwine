import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStorage, type SessionRow, type Storage } from "./storage.ts"
import type { ClaudeOneShotRequest } from "./backend/claude-oneshot.ts"
import {
  cleanThreadName,
  cleanThreadStatus,
  createThreadNamer,
  distinguishingName,
  foldThreadName,
  nameHolder,
  openThreadsElsewhere,
  namesForPrompt,
  namingRequest,
  projectThreadNames,
  rowThreadName,
  statusRequest,
  threadNameProblem,
} from "./thread-names.ts"

function store(): Storage {
  return createStorage(join(mkdtempSync(join(tmpdir(), "ntwine-names-")), "ui.db"), "p")
}

function row(slug: string, over: Partial<SessionRow> = {}): SessionRow {
  return {
    slug, session_id: `sid-${slug}`, thread_name: `ntwine-${slug}`, spawned_at: "2026-09-29T00:00:00.000Z",
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1, title_locked: 0,
    title: `${slug} chop…`, state: "open", meta: null, seen_at: null, transcript_id: null, ...over,
  } as SessionRow
}

/** A row that already carries a persisted name, the way the mint leaves one (upsert never writes it). */
function named(s: Storage, slug: string, title: string, over: Partial<SessionRow> = {}): void {
  s.upsertSession(row(slug, over))
  assert.equal(s.setMintedTitle(slug, `sid-${slug}`, title), true)
}

/** A namer whose model is a script: each call records its request and answers the next line. */
function scripted(storage: Storage, answers: string[]) {
  const asked: ClaudeOneShotRequest[] = []
  const namer = createThreadNamer({
    storage,
    complete: async (request) => {
      asked.push(request)
      const next = answers.shift()
      if (next === undefined) throw new Error("the script ran out")
      return next
    },
  })
  return { namer, asked }
}

test("names compare with case, punctuation and spacing folded away", () => {
  assert.equal(foldThreadName("Focus mode"), foldThreadName("focus-mode"))
  assert.equal(foldThreadName("Focus  Mode!"), foldThreadName("FOCUS MODE"))
  assert.equal(foldThreadName("Café"), foldThreadName("cafe"))
  assert.equal(foldThreadName("Shell budget"), foldThreadName("Shell budgets"), "a plain plural is the same name")
  assert.notEqual(foldThreadName("Class"), foldThreadName("Clas"))
  assert.notEqual(foldThreadName("Focus mode"), foldThreadName("Focus rail"))
  assert.equal(foldThreadName("—"), "", "a name with no letters or digits is no name")
})

test("a row's name is its PERSISTED name — never the dispatch chop, never the live session title", () => {
  assert.equal(rowThreadName(row("a")), undefined, "a bare chop is a placeholder, not a name")
  assert.equal(rowThreadName(row("a", { title: "Shell budgets", title_agent: 1 })), "Shell budgets")
  assert.equal(rowThreadName(row("a", { title: "Named by hand", title_auto: 0, title_locked: 1 })), "Named by hand")
  assert.equal(rowThreadName(row("a", { title: "Cache review", title_auto: 0 })), "Cache review", "a caller's dispatch title is a name")
})

test("an unnamed row is still listed, holding no name, so its slug addresses it", () => {
  const threads = projectThreadNames([row("unnamed"), row("named", { title: "Shell budgets", title_agent: 1 })])
  assert.deepEqual(threads.map((t) => [t.slug, t.name]), [["unnamed", ""], ["named", "Shell budgets"]])
  assert.equal(nameHolder("", threads), undefined)
})

test("the prompt lists the open names first, then recently done ones, capped and deduplicated", () => {
  const threads = projectThreadNames([
    row("old-open", { title: "Old open", title_agent: 1, spawned_at: "2026-09-01T00:00:00Z" }),
    row("new-open", { title: "New open", title_agent: 1, spawned_at: "2026-09-28T00:00:00Z" }),
    row("done", { title: "Done one", title_agent: 1, state: "archived" }),
    row("dupe", { title: "new-open", title_agent: 1, spawned_at: "2026-09-02T00:00:00Z" }),
    row("self", { title: "Myself", title_agent: 1 }),
  ])
  assert.deepEqual(namesForPrompt(threads, "self"), ["New open", "Old open", "Done one"])
})

test("THE NAMING PROMPT carries the taken names, the subject rule, and a rejected answer's reason", () => {
  const { system, prompt } = namingRequest("fix the shell budget default", ["Shell budgets", "Focus mode"])
  assert.match(system, /name threads/)
  assert.match(prompt, /ONE or TWO words/)
  assert.match(prompt, /kebab-case @handle .* at most 20 characters/)
  assert.match(prompt, /"Shell budgets" → @shell-budgets/)
  assert.match(prompt, /SUBJECT or intent of the request, not the action taken/)
  assert.match(prompt, /Names already taken:\n- Shell budgets\n- Focus mode\n/)
  assert.match(prompt, /<request>\nfix the shell budget default\n<\/request>/)
  assert.doesNotMatch(prompt, /previous answer/)
  const retry = namingRequest("x", [], { name: "Shell budgets", reason: "is already the name of another thread (Shell budgets)" })
  assert.match(retry.prompt, /\(none\)/)
  assert.match(retry.prompt, /Your previous answer, "Shell budgets", is already the name of another thread/)
})

test("a model's answer becomes a name only when it is one or two words, in sentence case", () => {
  assert.equal(cleanThreadName("\"Shell Budget\".", "fix the shell budget"), "Shell budget")
  assert.equal(cleanThreadName("Name: focus mode"), "Focus mode")
  assert.equal(cleanThreadName("ArkType perf", "ArkType is slow"), "ArkType perf")
  assert.equal(cleanThreadName("Zod Docs", "the Zod Docs site"), "Zod Docs", "a word the request capitalizes is a proper noun")
  assert.equal(cleanThreadName("z.properties docs"), "z.properties docs", "an identifier keeps its spelling")
  assert.equal(cleanThreadName("Fix the shell budget default"), undefined)
  assert.equal(cleanThreadName("  \n"), undefined)
})

test("a name is short enough to TYPE: its kebab-case handle is at most 20 characters", () => {
  assert.equal(threadNameProblem("Shell budgets"), undefined)
  assert.equal(threadNameProblem("Background shells"), undefined, "@background-shells is 17")
  assert.equal(threadNameProblem("Dispatch permissions"), undefined, "@dispatch-permissions is exactly 20")
  assert.match(threadNameProblem("Spinoff feature scope and UI") ?? "", /longer than two words/)
  assert.match(threadNameProblem("Visualization distinctions") ?? "", /@visualization-distinctions is 26 characters, past the limit of 20/)
  assert.match(threadNameProblem("Deinstitutionalization") ?? "", /too long to type/, "one word can be too long too")
  assert.equal(cleanThreadName("Visualization distinctions"), undefined)
  // The fallbacks hold the same bound: they skip a request word that would push the handle past it.
  assert.equal(distinguishingName("Shell budgets", "shell internationalization defaults", (name) => name === "Shell budgets"), "Shell defaults")
})

test("the status line is one clamped line", () => {
  assert.equal(cleanThreadStatus("\"Waiting on CI for the budget fix.\"\nextra"), "Waiting on CI for the budget fix")
  const long = cleanThreadStatus("word ".repeat(40))!
  assert.ok(long.length <= 80 && long.endsWith("…"))
  const { prompt, model } = statusRequest("Shell budgets", "User: ship it\n\nAssistant: pushed")
  assert.equal(model, "sonnet", "the status asks for judgement; the name asks for speed")
  assert.equal(namingRequest("x", []).model, undefined)
  assert.match(prompt, /RIGHT NOW, judged mostly from the LAST exchange/)
  assert.match(prompt, /already named "Shell budgets" .* do not repeat it/)
  assert.match(prompt, /Never generic/)
  // The conversation comes FIRST and the rules after it — measured to matter on Haiku (thread-names.ts).
  assert.ok(prompt.indexOf("<conversation>\nUser: ship it") < prompt.indexOf("Rules:"))
})

test("the distinguishing fallback keeps the lead word and borrows a free second word from the request", () => {
  const taken = new Set(["Shell budgets", "Shell defaults"].map(foldThreadName))
  const isTaken = (name: string) => taken.has(foldThreadName(name))
  assert.equal(distinguishingName("Focus mode", "anything", isTaken), "Focus mode", "a free name is kept")
  assert.equal(distinguishingName("Shell budgets", "raise the shell defaults and the ceiling", isTaken), "Shell ceiling")
  assert.equal(distinguishingName("Shell budgets", "budgets", isTaken), "Shell budgets 2", "a number only when no word is left")
})

test("the namer asks once, asks again NAMING the collision, then falls back — never returning a taken name", async () => {
  const s = store()
  named(s, "holder", "Shell budgets")
  const { namer, asked } = scripted(s, ["Shell budgets", "shell-budgets"])
  const name = await namer.name("fix the shell budget default so it is 30m", "newcomer")
  assert.equal(asked.length, 2)
  assert.match(asked[0]!.prompt, /- Shell budgets\n/, "the taken name rides the FIRST prompt")
  assert.match(asked[1]!.prompt, /Your previous answer, "Shell budgets", is already the name of another thread \(Shell budgets\)/)
  assert.equal(namer.holder(name, "newcomer"), undefined)
  assert.equal(name, "Shell default")
  s.close()
})

test("NEGATIVE CONTROL: a distinct first answer is taken as-is, with no retry", async () => {
  const s = store()
  named(s, "holder", "Shell budgets")
  const { namer, asked } = scripted(s, ["Budget defaults"])
  assert.equal(await namer.name("fix the shell budget default", "newcomer"), "Budget defaults")
  assert.equal(asked.length, 1)
  s.close()
})

test("a done thread's name is free again; an open one's is not", async () => {
  const s = store()
  named(s, "done", "Focus mode")
  named(s, "live", "Focus rail")
  const { namer } = scripted(s, [])
  assert.equal(namer.holder("Focus mode")?.slug, "done", "open, so taken")
  s.setState("done", "archived")
  assert.equal(namer.holder("Focus mode"), undefined)
  assert.equal(namer.holder("focus-rail")?.slug, "live")
  assert.equal(namer.holder("Focus rail", "live"), undefined, "a thread never collides with itself")
  s.close()
})

// Names are unique across every project the server has open, not only the thread's own (see the header):
// the caller's project wins a handle both carry, so a duplicate here hides the other project's thread.
test("another open project's thread names are taken: listed in the prompt, refused, and fallen back from", async () => {
  const here = store()
  const there = store()
  named(there, "begin-a-full-audit-of-open", "Issues audit")
  named(there, "finished", "Focus mode")
  there.setState("finished", "archived")
  // The same slug in the other project must not count as this thread itself.
  named(there, "newcomer", "Shell budgets")
  const tenants = [
    { project: { id: "ntwine", name: "ntwine" }, ctx: { storage: here } },
    { project: { id: "arktype", name: "arktype" }, ctx: { storage: there } },
  ]
  const asked: string[] = []
  const answers = ["Issues audit", "issues-audit"]
  const namer = createThreadNamer({
    storage: here,
    elsewhere: () => openThreadsElsewhere(tenants, "ntwine"),
    complete: async ({ prompt }) => { asked.push(prompt); return answers.shift()! },
  })
  assert.equal(namer.holder("Issues audit")?.project, "arktype")
  assert.equal(namer.holder("Shell budgets", "newcomer")?.project, "arktype", "exceptSlug is this project's slug only")
  assert.equal(namer.holder("Focus mode"), undefined, "a finished thread elsewhere holds nothing")
  assert.deepEqual(namer.promptNames(), ["Issues audit", "Shell budgets"])

  const name = await namer.name("why does issues audit have no give", "newcomer")
  assert.match(asked[0]!, /Names already taken:\n- Issues audit\n- Shell budgets\n/)
  assert.match(asked[1]!, /"Issues audit", is already the name of another thread \(Issues audit in arktype\)/)
  assert.equal(namer.holder(name, "newcomer"), undefined)
  assert.notEqual(foldThreadName(name), foldThreadName("Issues audit"))

  // NEGATIVE CONTROL: with no other project wired, the same name is free.
  const alone = createThreadNamer({ storage: here })
  assert.equal(alone.holder("Issues audit"), undefined)
  here.close()
  there.close()
})

test("a handle the request @-mentions is taken, even when no open thread carries it", async () => {
  const s = store()
  const source = "why does @issues-audit.arkregex-redesign have no give"
  const { namer, asked } = scripted(s, ["Issues audit", "Issues audit"])
  const name = await namer.name(source, "newcomer")
  assert.match(asked[0]!.prompt, /Names already taken:\n- issues-audit\n/)
  assert.match(asked[1]!.prompt, /"Issues audit", is the handle of another thread the request mentions \(@issues-audit\)/)
  assert.notEqual(foldThreadName(name), foldThreadName("Issues audit"))
  assert.notEqual(foldThreadName(namer.distinct("Issues audit", source)), foldThreadName("Issues audit"))
  // NEGATIVE CONTROL: unmentioned, the same answer is taken as-is.
  const plain = scripted(s, ["Issues audit"])
  assert.equal(await plain.namer.name("why does the issues audit have no give", "newcomer"), "Issues audit")
  s.close()
})

test("mints are serial, so the second of two near-identical dispatches is ASKED with the first's name taken", async () => {
  const s = store()
  s.upsertSession(row("first"))
  s.upsertSession(row("second"))
  const { namer, asked } = scripted(s, ["Shell budgets", "Budget defaults"])
  await Promise.all([
    namer.mint("first", "sid-first", "fix the shell budget default"),
    namer.mint("second", "sid-second", "fix the shell budget defaults please"),
  ])
  assert.equal(s.getSession("first")?.title, "Shell budgets")
  assert.equal(s.getSession("second")?.title, "Budget defaults")
  assert.match(asked[1]!.prompt, /- Shell budgets\n/)
  s.close()
})

test("a mint that collides at the WRITE falls back rather than duplicating, and never lands over a name", async () => {
  const s = store()
  s.upsertSession(row("racer"))
  s.upsertSession(row("human", { title: "Named by hand", title_auto: 0, title_locked: 1 }))
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const namer = createThreadNamer({
    storage: s,
    complete: async () => { await gate; return "Shell budgets" },
  })
  const pending = namer.mint("racer", "sid-racer", "fix the shell budget default")
  // While the model answers, another writer takes the name.
  named(s, "other", "Shell budgets")
  release()
  await pending
  assert.notEqual(foldThreadName(s.getSession("racer")!.title!), foldThreadName("Shell budgets"))
  await namer.mint("human", "sid-human", "anything")
  assert.equal(s.getSession("human")?.title, "Named by hand")
  s.close()
})
