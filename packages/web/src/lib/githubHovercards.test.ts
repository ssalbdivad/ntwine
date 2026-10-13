import { test } from "node:test"
import assert from "node:assert/strict"
import { githubRefFromUrl } from "./githubAutolink.ts"
import { githubRefsInHtml } from "./githubHovercards.ts"

// The hovercard's HANDLE: every anchor in rendered prose gets its canonical `owner/repo#N` /
// `owner/repo@sha` key stamped on it from its HREF (lib/markdown.ts's sanitizer), and the render hook
// harvests those keys out of the HTML string for one batched request.

test("a github issue, pull or commit URL yields its canonical key", () => {
  assert.equal(githubRefFromUrl("https://github.com/nubjs/nub/issues/660"), "nubjs/nub#660")
  // `/pull/N` and `/issues/N` collapse to ONE key: the API resolves either from the number alone,
  // which is also why the autolinker can mint `/issues/N` for a ref that turns out to be a PR.
  assert.equal(githubRefFromUrl("https://github.com/nubjs/nub/pull/660"), "nubjs/nub#660")
  assert.equal(githubRefFromUrl("https://github.com/ssalbdivad/ntwine/commit/92ed4cc"), "ssalbdivad/ntwine@92ed4cc")
  assert.equal(githubRefFromUrl("https://github.com/a/b/commit/92ED4CC"), "a/b@92ed4cc", "a sha key is lower-cased")
})

test("a fragment or query on the URL does not stop it resolving", () => {
  assert.equal(githubRefFromUrl("https://github.com/a/b/issues/12#issuecomment-99"), "a/b#12")
  assert.equal(githubRefFromUrl("https://github.com/a/b/pull/12/files"), "a/b#12")
})

test("anything else on github.com — and anything off it — has no card", () => {
  for (const url of [
    "https://github.com/nubjs/nub",
    "https://github.com/nubjs/nub/tree/main/src",
    "https://github.com/nubjs/nub/releases/tag/v1",
    "https://github.com/nubjs/nub/issues",
    "https://github.com/nubjs/nub/issues/0",
    "https://gitlab.com/a/b/issues/1",
    // Host-strict: a look-alike domain must not mint a key that then asks GitHub about it.
    "https://github.com.evil.test/a/b/issues/1",
    "https://evil.test/https://github.com/a/b/issues/1",
    "http://github.com/a/b/issues/1",
    "",
  ]) {
    assert.equal(githubRefFromUrl(url), null, url)
  }
  assert.equal(githubRefFromUrl(null), null)
})

test("every stamped reference in one block of prose is harvested, deduplicated", () => {
  const html = '<p>See <a data-gh-ref="a/b#1" href="x">#1</a>, <a data-gh-ref="a/b#1" href="x">#1</a> and <a data-gh-ref="a/b@92ed4cc" href="y">92ed4cc</a></p>'
  assert.deepEqual(githubRefsInHtml(html).sort(), ["a/b#1", "a/b@92ed4cc"])
})

test("prose with no references costs one substring search and returns nothing", () => {
  assert.deepEqual(githubRefsInHtml("<p>Just words, and a <a href=\"https://example.com\">link</a>.</p>"), [])
  assert.deepEqual(githubRefsInHtml(""), [])
})
