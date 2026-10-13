import { test } from "node:test"
import assert from "node:assert/strict"
import type { GithubRefCard } from "@ntwine/shared"
import { coarseAgo, diffBlocks, renderExcerpt, shortDate, stateKey } from "./GithubRefCardBody.tsx"

const card = (over: Partial<GithubRefCard>): GithubRefCard => ({
  ref: "a/b#1", kind: "issue", repo: "a/b", url: "", title: "t", body: "", state: "OPEN", labels: [], fetchedAt: 0, ...over,
})

test("the state pill distinguishes every state a reader is actually asking about", () => {
  assert.equal(stateKey(card({ kind: "issue", state: "OPEN" })), "OPEN_ISSUE")
  assert.equal(stateKey(card({ kind: "issue", state: "CLOSED" })), "CLOSED_ISSUE")
  // "Closed" and "closed as not planned" are the same word and opposite news — one says it was
  // handled, the other says it never will be. GitHub paints them differently and so does this.
  assert.equal(stateKey(card({ kind: "issue", state: "CLOSED", stateReason: "NOT_PLANNED" })), "NOT_PLANNED")
  assert.equal(stateKey(card({ kind: "pr", state: "OPEN" })), "OPEN_PR")
  assert.equal(stateKey(card({ kind: "pr", state: "DRAFT" })), "DRAFT")
  assert.equal(stateKey(card({ kind: "pr", state: "MERGED" })), "MERGED")
  assert.equal(stateKey(card({ kind: "pr", state: "CLOSED" })), "CLOSED_PR")
  assert.equal(stateKey(card({ kind: "commit", state: "" })), null, "a commit has no state to show")
})

test("the diffstat gauge matches the one github.com actually draws", () => {
  // MEASURED, not designed: these four rows are the per-file gauges github.com rendered for
  // nubjs/nub@92ed4cc — the very commit in the maintainer's reference screenshot — read off the page
  // on 2026-08-14. They pin the two things guessing got wrong: it is a FLOOR of each side's share,
  // and the remainder is NEUTRAL, so 19 deletions out of 273 genuinely draw no red square.
  assert.deepEqual(diffBlocks(254, 19), ["add", "add", "add", "add", "none"])
  assert.deepEqual(diffBlocks(7, 0), ["add", "add", "add", "add", "add"])
  assert.deepEqual(diffBlocks(76, 12), ["add", "add", "add", "add", "none"])
  assert.deepEqual(diffBlocks(51, 7), ["add", "add", "add", "add", "none"])

  assert.deepEqual(diffBlocks(0, 10), ["del", "del", "del", "del", "del"])
  assert.deepEqual(diffBlocks(1, 1), ["add", "add", "del", "del", "none"])
  assert.deepEqual(diffBlocks(0, 0), ["none", "none", "none", "none", "none"])
  // Whatever the split, the gauge is always exactly five blocks wide — a row that changes width by
  // input would make a column of cards ragged.
  for (const [a, d] of [[1, 999], [999, 1], [3, 4], [50, 50], [7, 0], [0, 7], [0, 0]]) {
    assert.equal(diffBlocks(a, d).length, 5, `${a}/${d}`)
  }
})

// The LADDER is coarse — a card says `2w`, never `358h` — but the SPELLING is the app's house duration
// grammar, which is why these read `40m` rather than the "40 minutes" they said until 2026-08-31.
test("recency reads in GitHub's coarse vocabulary, in the house duration grammar", () => {
  const now = Date.parse("2026-08-14T12:00:00Z")
  const ago = (iso: string) => coarseAgo(iso, now)
  assert.equal(ago("2026-08-14T11:59:30Z"), "just now")
  assert.equal(ago("2026-08-14T11:20:00Z"), "40m ago")
  assert.equal(ago("2026-08-14T09:00:00Z"), "3h ago")
  assert.equal(ago("2026-08-13T09:00:00Z"), "1d ago")
  assert.equal(ago("2026-07-31T10:55:44Z"), "2w ago")
  assert.equal(ago("2026-05-14T12:00:00Z"), "3mo ago")
  // Past a year "1y ago" stops telling anyone anything, so the card gives the date instead.
  assert.match(ago("2020-01-02T12:00:00Z"), /^on /)
  assert.equal(coarseAgo(undefined, now), "")
  assert.equal(coarseAgo("not a date", now), "")
})

test("the header date carries a year only once it stops being this one", () => {
  const now = Date.parse("2026-08-14T12:00:00Z")
  assert.equal(shortDate("2026-08-01T00:00:00Z", now).includes("2026"), false)
  assert.ok(shortDate("2024-08-01T00:00:00Z", now).includes("2024"))
  assert.equal(shortDate(undefined, now), "")
})

test("an issue body's inline code becomes code; a commit message's backticks stay literal", () => {
  // github.com's own split, and it is not an inconsistency: an issue body IS markdown, a commit
  // message is not. The reference screenshots show `optionalDependencies` as a mono chip on the
  // issue card and as bare backticked text on the commit card.
  assert.deepEqual(renderExcerpt("run `nub install` first", true), ["run ", { code: "nub install" }, " first"])
  assert.deepEqual(renderExcerpt("run `nub install` first", false), ["run `nub install` first"])
})

test("the excerpt renderer never loses or duplicates the author's text", () => {
  const rejoin = (parts: (string | { code: string })[]) =>
    parts.map((p) => (typeof p === "string" ? p : `\`${p.code}\``)).join("")
  for (const text of [
    "`leading` code",
    "trailing `code`",
    "`a``b`",
    "an unpaired ` backtick",
    "```fence-ish```",
    "no code at all",
    "",
  ]) {
    assert.equal(rejoin(renderExcerpt(text, true)), text, text)
  }
})
