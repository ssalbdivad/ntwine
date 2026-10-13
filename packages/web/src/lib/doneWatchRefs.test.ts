import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { Marked } from "marked"
import { MARKDOWN_OPTIONS } from "./markdown.ts"
import { setGithubRepo } from "./githubAutolink.ts"
import { doneWatchRefs, watchedRefs } from "./doneWatchRefs.ts"

// What a done card's Watch buttons offer: the PRs and issues its prose LINKS, through the app's real
// marked configuration (mdToHtml's sanitizer needs a DOM; it keeps these anchors' hrefs as they are —
// markdownSanitizer.e2e.test.ts). So `#123` resolves to the thread's repo exactly as its link does.
const marked = new Marked(MARKDOWN_OPTIONS)
const render = (md: string) => marked.parse(md, { async: false }) as string
const REPO = "colinhacks/frizz"

before(() => setGithubRepo(REPO))
after(() => setGithubRepo(null))

test("a bare #N is the thread's own repo and reads as #N; a cross-repo ref keeps its name", () => {
  assert.deepEqual(doneWatchRefs(render("Pushed the fix to #1685; filed nubjs/nub#587 upstream."), REPO), [
    { ref: "colinhacks/frizz#1685", label: "#1685" },
    { ref: "nubjs/nub#587", label: "nubjs/nub#587" },
  ])
})

test("a pasted PR or issue URL counts; a commit, a code span and a non-GitHub link do not", () => {
  const md = [
    "Opened https://github.com/colinhacks/frizz/pull/1700 and landed 749a37b.",
    "Not `#12`, not [the docs](https://example.com/x), not https://github.com/colinhacks/frizz/tree/main.",
  ].join("\n")
  assert.deepEqual(doneWatchRefs(render(md), REPO), [{ ref: "colinhacks/frizz#1700", label: "#1700" }])
})

test("one button per thing: repeats, case variants and a link to a comment collapse", () => {
  const md = "#9, again #9, Colinhacks/Frizz#9 and https://github.com/colinhacks/frizz/issues/9#issuecomment-1"
  assert.deepEqual(doneWatchRefs(render(md), REPO), [{ ref: "colinhacks/frizz#9", label: "#9" }])
})

test("no references, no buttons — and a project with no GitHub repo links none", () => {
  assert.deepEqual(doneWatchRefs(render("Refactored the parser. All tests pass."), REPO), [])
  setGithubRepo(null)
  try {
    assert.deepEqual(doneWatchRefs(render("Fixed #12."), null), [])
  } finally { setGithubRepo(REPO) }
})

test("watchedRefs reads the board's armed github rows, case-blind", () => {
  const set = watchedRefs([
    { kind: "github", target: "Colinhacks/Frizz#9", state: "armed" },
    { kind: "github", target: "colinhacks/frizz#10", state: "dropped" },
    { kind: "timer", target: "tmr_1", state: "armed" },
  ])
  assert.deepEqual([...set], ["colinhacks/frizz#9"])
})
