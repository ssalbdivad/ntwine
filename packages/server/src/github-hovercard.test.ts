import { test } from "node:test"
import assert from "node:assert/strict"
import {
  buildRefQuery,
  cardFromNode,
  createGithubHovercardService,
  excerptBody,
  isImmutableRef,
  parseRef,
  parseRefResponse,
} from "./github-hovercard.ts"

const AT = 1_700_000_000_000

test("a canonical ref parses into its owner, name and number or sha", () => {
  assert.deepEqual(parseRef("colinhacks/frizz#123"), { key: "colinhacks/frizz#123", owner: "colinhacks", name: "frizz", number: 123 })
  assert.deepEqual(parseRef("nubjs/nub@92ed4cc"), { key: "nubjs/nub@92ed4cc", owner: "nubjs", name: "nub", sha: "92ed4cc" })
  assert.equal(parseRef("nubjs/nub#123")!.sha, undefined)
})

test("anything that is not a canonical ref is refused rather than guessed at", () => {
  // The refs arrive from the browser. None of this reaches GitHub as a bound variable, so refusing
  // here is about not burning a query slot — but it also means a bad key can never shape a request.
  for (const bad of ["#123", "frizz#123", "owner/repo", "owner/repo#0", "owner/repo#abc", "owner/repo@xyz", "owner/repo@92ed4", "a/b#123 extra", "../../etc#1"]) {
    assert.equal(parseRef(bad), null, bad)
  }
})

test("only a commit is immutable", () => {
  assert.equal(isImmutableRef(parseRef("a/b@92ed4cc")!), true)
  assert.equal(isImmutableRef(parseRef("a/b#1")!), false)
})

test("the batched query aliases every ref and binds each value as a variable", () => {
  const refs = [parseRef("nubjs/nub#660")!, parseRef("colinhacks/frizz@92ed4cc")!]
  const { query, variables } = buildRefQuery(refs)
  assert.match(query, /a0: repository\(owner: \$owner0, name: \$name0\)/)
  assert.match(query, /issueOrPullRequest\(number: \$number0\)/)
  // An abbreviated sha is not a GitObjectID — `object(oid:)` rejects it outright, so a commit is
  // looked up by EXPRESSION. Measured against the real API 2026-08-14.
  assert.match(query, /object\(expression: \$rev1\)/)
  assert.deepEqual(variables, { owner0: "nubjs", name0: "nub", number0: 660, owner1: "colinhacks", name1: "frizz", rev1: "92ed4cc" })
  // Nothing foreign is concatenated into the document: every literal in it is an alias index.
  assert.equal(query.includes("nubjs"), false)
  assert.equal(query.includes("92ed4cc"), false)
})

test("an issue node becomes a card", () => {
  const card = cardFromNode(parseRef("nubjs/nub#660")!, {
    __typename: "Issue",
    number: 660,
    title: "A failing optionalDependency build fails the whole install",
    body: "When an `optionalDependencies` entry has a lifecycle script that exits non-zero…",
    state: "OPEN",
    url: "https://github.com/nubjs/nub/issues/660",
    createdAt: "2026-08-02T03:52:56Z",
    author: { login: "colinhacks", avatarUrl: "https://avatars.githubusercontent.com/u/3084745" },
    labels: { nodes: [{ name: "bug", color: "d73a4a" }] },
    comments: { totalCount: 4 },
  }, AT)
  assert.equal(card?.kind, "issue")
  assert.equal(card?.repo, "nubjs/nub")
  assert.equal(card?.state, "OPEN")
  assert.equal(card?.authorLogin, "colinhacks")
  assert.deepEqual(card?.labels, [{ name: "bug", color: "d73a4a" }])
  assert.equal(card?.comments, 4)
  assert.equal(card?.fetchedAt, AT)
})

test("a draft pull request reads as DRAFT, not as OPEN", () => {
  // GitHub models a draft as `state: OPEN` + `isDraft`, and the difference between them is the whole
  // question a reader is asking the card ("is this ready for me?").
  const draft = cardFromNode(parseRef("a/b#7")!, { __typename: "PullRequest", title: "wip", state: "OPEN", isDraft: true }, AT)
  assert.equal(draft?.state, "DRAFT")
  const ready = cardFromNode(parseRef("a/b#7")!, { __typename: "PullRequest", title: "ready", state: "OPEN", isDraft: false }, AT)
  assert.equal(ready?.state, "OPEN")
  assert.equal(ready?.kind, "pr")
})

test("a commit node becomes a card with its diffstat and git author", () => {
  const card = cardFromNode(parseRef("nubjs/nub@92ed4cc")!, {
    __typename: "Commit",
    oid: "92ed4cc78f4a567a68425c8493421eadf2ea8139",
    url: "https://github.com/nubjs/nub/commit/92ed4cc78f4a567a68425c8493421eadf2ea8139",
    messageHeadline: "aube: an optional dependency's build failure no longer fails the install",
    messageBody: "A package reachable only through `optionalDependencies`…",
    committedDate: "2026-07-31T10:55:44Z",
    additions: 254,
    deletions: 19,
    changedFilesIfAvailable: 4,
    author: { name: "Colin McDonnell", user: null },
  }, AT)
  assert.equal(card?.kind, "commit")
  assert.equal(card?.state, "")
  assert.equal(card?.additions, 254)
  assert.equal(card?.deletions, 19)
  assert.equal(card?.changedFiles, 4)
  // A commit's git author often has no GitHub account behind it, so the NAME is what the byline gets.
  assert.equal(card?.authorName, "Colin McDonnell")
  assert.equal(card?.authorLogin, undefined)
})

test("a null alias or a foreign shape yields no card rather than a fabricated one", () => {
  const ref = parseRef("a/b#1")!
  assert.equal(cardFromNode(ref, null, AT), null)
  assert.equal(cardFromNode(ref, { __typename: "Repository" }, AT), null)
  assert.equal(cardFromNode(ref, { __typename: "Issue" }, AT), null) // no title
})

test("a partial response yields cards for what resolved and misses for what did not", () => {
  // This is the SHAPE the real API returns for a batch containing one bad number: `data` is fully
  // populated except for that alias, and the NOT_FOUND lives in a sibling `errors` array. Verified
  // against api.github.com 2026-08-14.
  const refs = [parseRef("a/b#1")!, parseRef("a/b#999999")!]
  const raw = {
    data: { a0: { target: { __typename: "Issue", title: "real", state: "OPEN" } }, a1: { target: null } },
    errors: [{ type: "NOT_FOUND", path: ["a1"] }],
  }
  const { cards, missing } = parseRefResponse(raw, refs, AT)
  assert.equal(cards.length, 1)
  assert.equal(cards[0].ref, "a/b#1")
  assert.deepEqual(missing, ["a/b#999999"])
})

test("a body excerpt drops HTML comments and is bounded", () => {
  assert.equal(excerptBody("<!-- template -->\n\nreal text"), "real text")
  assert.equal(excerptBody(undefined), "")
  const long = excerptBody("x".repeat(1000))
  assert.ok(long.length <= 401, `got ${long.length}`)
  assert.ok(long.endsWith("…"))
})

// ---- the cache ----

function stubService(responses: unknown[]) {
  let calls = 0
  const bodies: string[] = []
  const service = createGithubHovercardService({
    getToken: async () => "t",
    request: (async (_url: string, init: { body: string }) => {
      bodies.push(init.body)
      const body = responses[Math.min(calls, responses.length - 1)]
      calls += 1
      return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(body) } as unknown as Response
    }) as unknown as typeof globalThis.fetch,
    now: () => AT,
  })
  return { service, bodies, calls: () => calls }
}

const issueResponse = (n: number) => ({ data: { a0: { target: { __typename: "Issue", number: n, title: `issue ${n}`, state: "OPEN" } } } })

test("a second request for the same ref is answered from the cache with no fetch", async () => {
  const { service, calls } = stubService([issueResponse(1)])
  const first = await service.preview(["a/b#1"])
  assert.equal(first.cards.length, 1)
  assert.equal(calls(), 1)
  const second = await service.preview(["a/b#1"])
  assert.equal(second.cards[0].title, "issue 1")
  assert.equal(calls(), 1, "the second request must not reach GitHub")
})

test("refresh re-fetches a cached issue; a commit is never re-fetched", async () => {
  const { service, calls } = stubService([issueResponse(1)])
  await service.preview(["a/b#1"])
  await service.preview(["a/b#1"], { refresh: true })
  assert.equal(calls(), 2, "refresh must bypass the TTL")

  const commit = { data: { a0: { target: { __typename: "Commit", oid: "92ed4cc", messageHeadline: "c" } } } }
  const { service: s2, calls: c2 } = stubService([commit])
  await s2.preview(["a/b@92ed4cc"])
  await s2.preview(["a/b@92ed4cc"], { refresh: true })
  assert.equal(c2(), 1, "a commit cannot change, so even a refresh is served from cache")
})

test("concurrent requests for the same ref open ONE fetch", async () => {
  const { service, calls } = stubService([issueResponse(1)])
  const [a, b] = await Promise.all([service.preview(["a/b#1"]), service.preview(["a/b#1"])])
  assert.equal(calls(), 1)
  assert.equal(a.cards.length, 1)
  assert.equal(b.cards.length, 1)
})

test("a missing ref is cached, so prose scrolling past it never re-asks", async () => {
  const { service, calls } = stubService([{ data: { a0: { target: null } } }])
  const first = await service.preview(["a/b#1"])
  assert.deepEqual(first.missing, ["a/b#1"])
  const second = await service.preview(["a/b#1"])
  assert.deepEqual(second.missing, ["a/b#1"])
  assert.equal(calls(), 1)
})

test("a failed fetch surfaces an error and never throws", async () => {
  const service = createGithubHovercardService({
    getToken: async () => { throw new Error("gh not installed") },
    request: (async () => { throw new Error("unreachable") }) as unknown as typeof globalThis.fetch,
    now: () => AT,
  })
  const result = await service.preview(["a/b#1"])
  assert.deepEqual(result.cards, [])
  assert.match(result.error ?? "", /gh not installed/)
})

test("an unparseable ref is reported missing without costing a query slot", async () => {
  const { service, bodies, calls } = stubService([issueResponse(1)])
  const result = await service.preview(["not-a-ref", "a/b#1"])
  assert.ok(result.missing.includes("not-a-ref"))
  assert.equal(calls(), 1)
  assert.equal(bodies[0].includes("not-a-ref"), false)
})
