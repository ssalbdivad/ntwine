import { test } from "node:test"
import assert from "node:assert/strict"
import type { ProjectQueue, SubAgentDirectory, ThreadView } from "@ntwine/shared"
import { threadHandle } from "@ntwine/shared"
import {
  crossProjectMentionCandidates,
  foldAddress,
  foldHandle,
  humpStarts,
  insertMention,
  matchMentions,
  mentionCandidates,
  mentionQueryAt,
  mentionSegments,
  resolveMention,
  resolveSubAgentMention,
  scanMentions,
  splitMentionQuery,
  subAgentMentionCandidates,
  subAgentMentionStatus,
} from "./threadMentions.ts"

function thread(over: Partial<ThreadView>): ThreadView {
  return {
    id: "t", title: "t", status: "active", mechanism: null, humanBlocked: false, ready: false, dependsOn: [], externalDeps: [],
    agents: [], errors: [], warnings: [], runtime: "turn-idle", unread: false, archived: false, hasPlan: false, subAgents: [],
    bgShells: [], watches: [], questions: [], pendingQuestion: false, kind: "session", state: "open", titleAuto: false,
    ...over,
  } as ThreadView
}

const board = [
  thread({ id: "a", title: "Shell budgets", statusLine: "Tuning the cap", lastAssistantAt: "2026-09-29T10:00:00Z" }),
  thread({ id: "b", title: "Focus mode", lastAssistantAt: "2026-09-29T12:00:00Z" }),
  thread({ id: "c", title: "Budget report", state: "archived", lastAssistantAt: "2026-09-29T13:00:00Z" }),
  thread({ id: "d", title: "A sentence far too long to be any name" }),
  thread({ id: "e", title: "External", foreign: true }),
  thread({ id: "f", title: "Spinning", titleAuto: true, spawnedAt: new Date().toISOString() }),
]

test("mentionCandidates: open threads by recency, then done ones; no self, externals, placeholders or sentences", () => {
  const all = mentionCandidates(board)
  assert.deepEqual(all.map((c) => c.handle), ["focus-mode", "shell-budgets", "budget-report"])
  assert.deepEqual(all.map((c) => c.done), [false, false, true])
  assert.equal(all[1]!.status, "Tuning the cap")
  assert.deepEqual(mentionCandidates(board, "b").map((c) => c.handle), ["shell-budgets", "budget-report"], "the thread being written into is not offered")
})

test("mentionQueryAt: an @ at a word boundary before the caret, never an email address", () => {
  assert.deepEqual(mentionQueryAt("ask @she", 8), { start: 4, query: "she" })
  assert.deepEqual(mentionQueryAt("@", 1), { start: 0, query: "" })
  assert.deepEqual(mentionQueryAt("(@focus", 7), { start: 1, query: "focus" })
  assert.equal(mentionQueryAt("mail me@host", 12), undefined)
  assert.equal(mentionQueryAt("ask @she about", 14), undefined, "the caret has left the token")
  assert.equal(mentionQueryAt("ask @she", null), undefined)
  assert.equal(mentionQueryAt("a/@b", 4), undefined)
})

test("matchMentions: handle prefix, then a word's prefix, then substring, then letters in order", () => {
  const all = mentionCandidates(board)
  assert.deepEqual(matchMentions(all, "").map((c) => c.handle), ["focus-mode", "shell-budgets", "budget-report"])
  assert.deepEqual(matchMentions(all, "bud").map((c) => c.handle), ["budget-report", "shell-budgets"])
  assert.deepEqual(matchMentions(all, "SHELL").map((c) => c.handle), ["shell-budgets"])
  assert.deepEqual(matchMentions(all, "fmd").map((c) => c.handle), ["focus-mode"])
  assert.deepEqual(matchMentions(all, "zzz"), [])
})

test("matchMentions: a handle typed with its hyphens, or without them, is still a prefix hit", () => {
  const two = mentionCandidates([thread({ id: "r", title: "Refocus mode", lastAssistantAt: "2026-09-29T12:00:00Z" }), thread({ id: "b", title: "Focus mode", lastAssistantAt: "2026-09-29T10:00:00Z" })])
  assert.deepEqual(two.map((c) => c.handle), ["refocus-mode", "focus-mode"], "recency order, which each rank keeps")
  assert.deepEqual(matchMentions(two, "focus-m").map((c) => c.handle), ["focus-mode", "refocus-mode"], "typed as shown")
  assert.deepEqual(matchMentions(two, "focusm").map((c) => c.handle), ["focus-mode", "refocus-mode"], "typed without the hyphen")
  assert.deepEqual(matchMentions(two, "mode").map((c) => c.handle), ["refocus-mode", "focus-mode"], "a word after a hyphen is a word start, for both")
})

test("insertMention: completes the token in place and leaves the caret after one space", () => {
  assert.deepEqual(insertMention("ask @she", 4, 8, "shell-budgets"), { prose: "ask @shell-budgets ", caret: 19 })
  // Mid-token caret: the rest of the token is replaced, and an existing space is reused.
  assert.deepEqual(insertMention("ask @shxx about", 4, 7, "shell-budgets"), { prose: "ask @shell-budgets about", caret: 19 })
})

test("resolveMention / foldHandle: case, punctuation and a plain plural fold away", () => {
  const all = mentionCandidates(board)
  assert.equal(resolveMention(all, "ShellBudget")?.slug, "a")
  assert.equal(resolveMention(all, "shell-budgets")?.slug, "a")
  assert.equal(resolveMention(all, "shellBudgets")?.slug, "a", "a camelCase handle written before the kebab switch")
  assert.equal(resolveMention(all, "nothing"), undefined)
  assert.equal(foldHandle("class"), "class", "a double s is not a plural")
})

test("foldHandle: dev-ops, devOps and devops are one key, and it is the thread's", () => {
  const keys = ["dev-ops", "devOps", "devops"].map(foldHandle)
  assert.deepEqual(keys, ["devop", "devop", "devop"])
  assert.equal(resolveMention(mentionCandidates([thread({ id: "d", title: "Dev ops" })]), "devOps")?.slug, "d")
})

test("mentionSegments: a mention that names a thread becomes a link run; anything else stays text", () => {
  const all = mentionCandidates(board)
  const text = "ask @shell-budgets, not @nobody or me@focus-mode"
  const segs = mentionSegments(text, all)
  assert.equal(segs.map((s) => s.text).join(""), text, "byte-for-byte")
  assert.deepEqual(segs.filter((s) => s.kind === "mention").map((s) => [s.text, s.kind === "mention" && s.slug]), [["@shell-budgets", "a"]])
  assert.deepEqual(mentionSegments("@focus-mode!", all).map((s) => s.kind), ["mention", "text"])
  // A legacy camelCase mention still links to the kebab-named thread.
  assert.deepEqual(mentionSegments("see @shellBudgets", all).flatMap((s) => (s.kind === "mention" ? [[s.text, s.slug]] : [])), [["@shellBudgets", "a"]])
  // A dash after a mention is punctuation: the mention links, the dash stays text.
  assert.deepEqual(mentionSegments("ask @shell-budgets- then", all).map((s) => s.text), ["ask ", "@shell-budgets", "- then"])
  // A mention cut short by `/` or `@` is a package or a path, never its first letters (`@shell`).
  assert.deepEqual(mentionSegments("npm i @shell-budgets/core and @shell-budgets@2", all).map((s) => s.kind), ["text"])
})

test("scanMentions: a kebab mention ends at the punctuation after it; a package path is never a mention", () => {
  const all = mentionCandidates([...board, thread({ id: "ty", title: "Types" })])
  assert.deepEqual(scanMentions("see @shell-budgets—ok", all).map((m) => [m.start, m.text, m.slug]), [[4, "@shell-budgets", "a"]])
  assert.deepEqual(scanMentions("ask @shell-budgets- then", all).map((m) => m.text), ["@shell-budgets"])
  assert.deepEqual(scanMentions("@types first", all).map((m) => m.slug), ["ty"], "the thread the package guard is tested against")
  assert.deepEqual(scanMentions("npm i @types/node", all), [], "`@types/node` is a package, never `@types` or `@type`")
})

// ── SUB-AGENTS AFTER THE DOT ─────────────────────────────────────────────────────────────────────────

const NOW = Date.parse("2026-09-30T12:00:00Z")
// The server's order: live first, then the returned ones newest first. One child has no address (its
// name is a sentence) and one sits under a Workflow.
const directory: SubAgentDirectory = {
  threadHandle: "shell-budgets",
  agents: [
    { id: "t1", label: "Cache keys", address: "shell-budgets.cache-keys", depth: 1, state: "running", startedAt: "2026-09-30T11:48:00Z" },
    { id: "w1", label: "wave-2", address: "shell-budgets.wave-2", depth: 1, state: "running", workflow: true, startedAt: "2026-09-30T11:30:00Z" },
    { id: "w1a", label: "impl:W3", address: "shell-budgets.wave-2.impl-w3", parentId: "w1", depth: 2, state: "stale", startedAt: "2026-09-30T11:20:00Z" },
    { id: "t2", label: "Look at every call site of the cap and report back", depth: 1, state: "running" },
    { id: "t3", label: "Cap audit", address: "shell-budgets.cap-audit", depth: 1, state: "done", outcome: "completed", finishedAt: "2026-09-30T09:00:00Z" },
    { id: "t4", label: "Cache sweep", address: "shell-budgets.cache-sweep", depth: 1, state: "done", outcome: "failed", finishedAt: "2026-09-28T12:00:00Z" },
  ],
}

test("mentionQueryAt: the query runs on through dots, but a mention never starts with one", () => {
  assert.deepEqual(mentionQueryAt("ask @shell-budgets.", 19), { start: 4, query: "shell-budgets." })
  assert.deepEqual(mentionQueryAt("ask @shell-budgets.ca", 21), { start: 4, query: "shell-budgets.ca" })
  assert.deepEqual(mentionQueryAt("@a.wave-2.im", 12), { start: 0, query: "a.wave-2.im" })
  assert.equal(mentionQueryAt("ask @.", 6), undefined, "a leading dot is not a mention")
  assert.equal(mentionQueryAt("ask @.ca", 8), undefined)
  assert.equal(mentionQueryAt("see me.@x", 9), undefined, "an @ right after a dot is not at a word boundary")
})

test("splitMentionQuery: a plain query is untouched; a dotted one splits at its first dot", () => {
  assert.equal(splitMentionQuery("shell-bud"), undefined)
  assert.deepEqual(splitMentionQuery("shell-budgets."), { head: "shell-budgets", rest: "" })
  assert.deepEqual(splitMentionQuery("shell-budgets.wave-2.im"), { head: "shell-budgets", rest: "wave-2.im" })
})

test("humpStarts: a word starts after a dash, an underscore or a dot, and at a legacy camelCase hump", () => {
  assert.deepEqual(humpStarts("shell-budgets"), [0, 6])
  assert.deepEqual(humpStarts("port-the-parser.cache-keys"), [0, 5, 9, 16, 22], "every word start, across the sub-agent dot")
  assert.deepEqual(humpStarts("shell_budgets"), [0, 6])
  assert.deepEqual(humpStarts("shell--budgets"), [0, 7], "a doubled dash starts one word, not two")
  assert.deepEqual(humpStarts("portTheParser.cacheKeys"), [0, 4, 7, 14, 19], "a handle written before the kebab switch")
  assert.deepEqual(humpStarts("a.B"), [0, 2], "an uppercase segment start is counted once")
})

test("subAgentMentionCandidates: every addressed child, live before returned, each dimmed with how it stands", () => {
  const subs = subAgentMentionCandidates("a", directory, NOW)
  assert.deepEqual(subs.map((c) => c.handle), ["shell-budgets.cache-keys", "shell-budgets.wave-2", "shell-budgets.wave-2.impl-w3", "shell-budgets.cap-audit", "shell-budgets.cache-sweep"], "the sentence-named child has no address and is not offered")
  assert.deepEqual(subs.map((c) => c.done), [false, false, false, true, true])
  assert.deepEqual(subs.map((c) => c.subAgentId), ["t1", "w1", "w1a", "t3", "t4"])
  assert.ok(subs.every((c) => c.slug === "a"), "a sub-agent candidate names its thread's slug")
  assert.deepEqual(subs.map((c) => c.status), ["running 12m", "running 30m", "stale 40m", "returned 3h ago", "failed 2d ago"])
  // The server's order is not trusted blindly: a returned child listed early still lands after the live.
  const shuffled = { ...directory, agents: [directory.agents[4]!, ...directory.agents.slice(0, 4)] }
  assert.deepEqual(subAgentMentionCandidates("a", shuffled, NOW).map((c) => c.done), [false, false, false, true])
})

test("subAgentMentionStatus: the house duration grammar, and the child-op row's words for how it ended", () => {
  assert.equal(subAgentMentionStatus({ state: "running", startedAt: "2026-09-30T11:59:22Z" }, NOW), "running 38s")
  assert.equal(subAgentMentionStatus({ state: "rested", startedAt: "2026-09-30T11:00:00Z" }, NOW), "rested")
  assert.equal(subAgentMentionStatus({ state: "done", outcome: "killed", finishedAt: "2026-09-30T11:20:00Z" }, NOW), "stopped 40m ago")
  assert.equal(subAgentMentionStatus({ state: "done", outcome: "completed" }, NOW), "returned", "no instant, no age")
  assert.equal(subAgentMentionStatus({ state: "running" }, NOW), "running")
})

test("matchMentions over sub-agents: ranked on the address below the thread, dots kept", () => {
  const subs = subAgentMentionCandidates("a", directory, NOW)
  const handles = (rest: string) => matchMentions(subs, rest).map((c) => c.handle)
  assert.deepEqual(handles(""), subs.map((c) => c.handle), "`@shell-budgets.` offers every child, live first")
  assert.deepEqual(handles("ca"), ["shell-budgets.cache-keys", "shell-budgets.cap-audit", "shell-budgets.cache-sweep"], "a prefix of the child, live before returned")
  assert.deepEqual(handles("cache"), ["shell-budgets.cache-keys", "shell-budgets.cache-sweep"])
  assert.deepEqual(handles("keys"), ["shell-budgets.cache-keys"], "a word inside the child's handle")
  assert.deepEqual(handles("wave-2.im"), ["shell-budgets.wave-2.impl-w3"], "a dot typed below the thread separates the same segments")
  assert.deepEqual(handles("impl"), ["shell-budgets.wave-2.impl-w3"], "the segment after a dot is a word start")
  assert.deepEqual(handles("shell"), [], "the head was already typed; it is not matched again")
})

test("matchMentions over threads: a query with no dot behaves exactly as before", () => {
  const all = mentionCandidates(board)
  assert.deepEqual(matchMentions(all, "bud").map((c) => c.handle), ["budget-report", "shell-budgets"])
  assert.deepEqual(matchMentions(all, "shell-budgets").map((c) => c.handle), ["shell-budgets"], "punctuation still folds away")
})

test("a dotted query's head resolves to a thread by the same fold a plain mention uses", () => {
  const all = mentionCandidates(board)
  const head = (query: string) => {
    const split = splitMentionQuery(query)
    return split && resolveMention(all, split.head)?.slug
  }
  assert.equal(head("shell-budgets.ca"), "a")
  assert.equal(head("ShellBudget.ca"), "a", "case and a plural fold away")
  assert.equal(head("shell-bud.ca"), undefined, "a partial head names no thread — the menu stays closed")
  assert.equal(head("focus-mode."), "b")
})

test("insertMention: a partly typed dotted token is replaced whole; a sentence's full stop is kept", () => {
  const address = "shell-budgets.cache-keys"
  assert.deepEqual(insertMention("ask @shell-budgets.ca", 4, 21, address), { prose: "ask @shell-budgets.cache-keys ", caret: 30 })
  // Caret mid-token, the rest of the dotted token after it replaced too.
  assert.deepEqual(insertMention("ask @shell-budgets.caXX about", 4, 21, address), { prose: "ask @shell-budgets.cache-keys about", caret: 30 })
  assert.deepEqual(insertMention("ask @shell-|budgets.cache-keys now".replace("|", ""), 4, 11, address), { prose: "ask @shell-budgets.cache-keys now", caret: 30 })
  // A full stop right after the caret ends the sentence; it is not part of the token.
  assert.deepEqual(insertMention("ask @shell-bud. Then", 4, 14, "shell-budgets"), { prose: "ask @shell-budgets . Then", caret: 19 })
  assert.deepEqual(insertMention("ask @shell-bud.", 4, 14, "shell-budgets"), { prose: "ask @shell-budgets .", caret: 19 })
})

test("mentionSegments: a dotted mention links when its thread resolves, and carries its address", () => {
  const all = mentionCandidates(board)
  const text = "ask @shell-budgets.cache-keys about @shell-budgets. Then @nobody.child and @focus-mode.wave-2.impl-w3."
  const segs = mentionSegments(text, all)
  assert.equal(segs.map((s) => s.text).join(""), text, "byte-for-byte")
  const mentions = segs.flatMap((s) => (s.kind === "mention" ? [[s.text, s.slug, s.address ?? null]] : []))
  assert.deepEqual(mentions, [
    ["@shell-budgets.cache-keys", "a", "shell-budgets.cache-keys"],
    ["@shell-budgets", "a", null],
    ["@focus-mode.wave-2.impl-w3", "b", "focus-mode.wave-2.impl-w3"],
  ], "a trailing full stop is never part of a mention; an unknown thread's child stays text")
  // A plain mention still carries its thread's status; a sub-agent's is the directory's to say.
  const plain = segs.find((s) => s.kind === "mention" && s.address === undefined)
  assert.equal(plain?.kind === "mention" && plain.status, "Tuning the cap")
})

test("resolveSubAgentMention / foldAddress: a mention finds its directory entry by the folded address", () => {
  assert.equal(foldAddress("@PortTheParser.CacheKeys"), "porttheparser.cachekey")
  assert.equal(resolveSubAgentMention(directory, "shell-budgets.cache-keys")?.id, "t1")
  assert.equal(resolveSubAgentMention(directory, "ShellBudget.cache-key")?.id, "t1", "case, punctuation and a plural fold away per segment")
  assert.equal(resolveSubAgentMention(directory, "shell-budgets.wave-2.impl-w3")?.id, "w1a")
  assert.equal(resolveSubAgentMention(directory, "shell-budgets.cap-audit")?.id, "t3", "a returned child still resolves")
  assert.equal(resolveSubAgentMention(directory, "shell-budgets.impl-w3"), undefined, "an address skipping its Workflow names nothing")
  assert.equal(resolveSubAgentMention(directory, "shell-budgets.nothing"), undefined)
})

test("a thread's former names still resolve, after every current handle, and are never offered", () => {
  const renamed = thread({ id: "r", title: "Done reappears", titleAuto: false, formerTitles: ["Done persistence", "A sentence far too long to ever be a handle"] })
  const taken = thread({ id: "p", title: "Done persistence", titleAuto: false })
  const all = mentionCandidates([renamed])
  assert.deepEqual(all[0]?.formerHandles, [threadHandle("Done persistence")], "a sentence has no handle to keep")
  assert.equal(resolveMention(all, "donePersistence")?.slug, "r")
  assert.deepEqual(mentionSegments("Waiting on @donePersistence.doneRepro's reproduction", all).flatMap((s) => (s.kind === "mention" ? [[s.slug, s.address]] : [])), [["r", "donePersistence.doneRepro"]])
  assert.equal(resolveMention(mentionCandidates([renamed, taken]), "donePersistence")?.slug, "p", "a thread that holds the name now wins")
  assert.deepEqual(matchMentions(all, "persist"), [], "the typeahead offers current handles only")
  // Its sub-agents' addresses are rebuilt under the new name; the old address still finds the child.
  assert.equal(resolveSubAgentMention(directory, "anOldName.cacheKeys")?.id, "t1")
  assert.equal(resolveSubAgentMention(directory, "shellBudgets"), undefined, "a bare thread names no child")
})

test("crossProjectMentionCandidates: other projects' threads, tagged, minus the box's project and handles it has", () => {
  const queue = (projectSlug: string, threads: ThreadView[]) =>
    ({ projectId: projectSlug, projectSlug, projectName: `${projectSlug} name`, projectDir: "/", threads, doneCount: 0 }) as ProjectQueue
  const own = mentionCandidates(board)
  const queues = [
    queue("ntwine", board),
    queue("nub", [thread({ id: "n1", title: "Shell budgets" }), thread({ id: "n2", title: "Parser port" })]),
    queue("app", [thread({ id: "p1", title: "Parser port" }), thread({ id: "p2", title: "Billing" })]),
  ]
  const cross = crossProjectMentionCandidates(queues, "ntwine", own)
  assert.deepEqual(cross.map((c) => [c.handle, c.slug, c.project?.slug]), [
    ["parser-port", "n2", "nub"],
    ["billing", "p2", "app"],
  ], "a handle the box's project has, or an earlier project already offered, is not offered again")
  assert.equal(cross[0]!.project?.name, "nub name")
  const typed = matchMentions([...own, ...cross], "bil")
  assert.equal(typed[0]?.slug, "p2")
  assert.deepEqual(mentionSegments("ask @billing", [...own, ...cross]).at(-1), { kind: "mention", text: "@billing", slug: "p2", status: undefined, project: "app" })
})

test("crossProjectMentionCandidates: another project's recent done threads, after every project's open ones", () => {
  const queues = [
    { projectId: "home", projectSlug: "home", projectName: "Home", projectDir: "/", doneCount: 1,
      threads: [thread({ id: "h1", title: "Tea recipes" })],
      recentDone: [thread({ id: "h2", title: "Standup notes", state: "archived" })] },
    { projectId: "nub", projectSlug: "nub", projectName: "nub", projectDir: "/", doneCount: 0, threads: [thread({ id: "n1", title: "Parser port" })] },
  ] as ProjectQueue[]
  const cross = crossProjectMentionCandidates(queues, "ntwine", [])
  assert.deepEqual(cross.map((c) => [c.handle, c.done, c.project?.slug]), [
    ["tea-recipes", false, "home"],
    ["parser-port", false, "nub"],
    ["standup-notes", true, "home"],
  ])
  assert.equal(matchMentions(cross, "standup")[0]?.slug, "h2")
})

// mentionCandidates is memoised per thread array and narrowed per caller (2026-10-01). The narrowed list
// must be exactly what computing it for the board without that thread gives — above all at the done
// bound, where an excluded done thread lets the next one in.
test("mentionCandidates: the memoised list, narrowed by excludeSlug, is the list for the board without it", () => {
  const many = Array.from({ length: 30 }, (_, i) => thread({
    id: `t${i}`, title: `Thread number ${i}`, state: i % 3 === 0 ? "open" : "archived",
    lastAssistantAt: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
  }))
  for (const excluded of [undefined, ...many.map((t) => t.id)]) {
    const expected = mentionCandidates([...many].filter((t) => t.id !== excluded))
    assert.deepEqual(mentionCandidates(many, excluded), expected, `excluding ${excluded}`)
    assert.ok(mentionCandidates(many, excluded).filter((c) => c.done).length <= 20)
  }
  // Repeat calls on one array return fresh arrays: a caller that pushes onto one cannot touch the next.
  assert.notEqual(mentionCandidates(many), mentionCandidates(many))
})
