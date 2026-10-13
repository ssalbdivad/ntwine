import { test, after } from "node:test"
import assert from "node:assert/strict"
import { Marked } from "marked"
import type { ProjectCard } from "@ntwine/shared"
import { MARKDOWN_OPTIONS } from "./markdown.ts"
import { setGithubRepo } from "./githubAutolink.ts"
import { mentionIndexVersion } from "./mentionAutolink.ts"
import {
  insertProjectMention,
  matchProjects,
  projectMentionCandidates,
  projectMentionIndex,
  projectQueryAt,
  scanProjectMentions,
  setProjectMentions,
} from "./projectMentions.ts"

const card = (slug: string, name: string, over: Partial<ProjectCard> = {}) =>
  ({ id: `id-${slug}`, slug, name, path: `/home/u/${slug}`, lastOpenedAt: "", stale: false, iconStatus: "unknown", ...over }) as ProjectCard

const CARDS = [card("home", "Home"), card("arktype", "ArkType"), card("ntwine-web", "Ntwine web"), card("gone", "Gone", { stale: true }), card("2024", "2024")]
const PROJECTS = projectMentionCandidates(CARDS)

test("every project whose directory still exists, in the list's order", () => {
  assert.deepEqual(PROJECTS.map((p) => p.slug), ["home", "arktype", "ntwine-web", "2024"])
})

test("the query at the caret starts at a word boundary and never after another #, an & or a /", () => {
  assert.deepEqual(projectQueryAt("see #ark", 8), { start: 4, query: "ark" })
  assert.deepEqual(projectQueryAt("#", 1), { start: 0, query: "" })
  assert.deepEqual(projectQueryAt("(#home", 6), { start: 1, query: "home" })
  assert.equal(projectQueryAt("## heading", 2), undefined, "a markdown heading")
  assert.equal(projectQueryAt("a&#39", 5), undefined, "an HTML entity")
  assert.equal(projectQueryAt("x.com/a#frag", 12), undefined, "a URL fragment")
  assert.equal(projectQueryAt("word#ark", 8), undefined, "inside a word")
  assert.equal(projectQueryAt("#home now", 9), undefined, "a space closes it")
  assert.equal(projectQueryAt("#-x", 3), undefined, "a slug never starts with a joint")
})

test("ranking: slug prefix, word prefix, inside, display name, letters in order; digits are GitHub's", () => {
  assert.deepEqual(matchProjects(PROJECTS, "").map((p) => p.slug), ["home", "arktype", "ntwine-web", "2024"])
  assert.deepEqual(matchProjects(PROJECTS, "ark").map((p) => p.slug), ["arktype"])
  assert.deepEqual(matchProjects(PROJECTS, "web").map((p) => p.slug), ["ntwine-web"])
  assert.deepEqual(matchProjects(PROJECTS, "fw").map((p) => p.slug), ["ntwine-web"])
  assert.deepEqual(matchProjects(PROJECTS, "12"), [])
})

test("completion replaces the whole token and leaves one space after it", () => {
  assert.deepEqual(insertProjectMention("see #ar", 4, 7, "arktype"), { prose: "see #arktype ", caret: 13 })
  assert.deepEqual(insertProjectMention("see #ar|ktyp then", 4, 7, "arktype").prose, "see #arktype |ktyp then")
  assert.deepEqual(insertProjectMention("#ho now", 0, 3, "home"), { prose: "#home now", caret: 6 })
  assert.deepEqual(insertProjectMention("#homexx now", 0, 3, "home"), { prose: "#home now", caret: 6 }, "the rest of the token after the caret goes")
})

test("a finished mention resolves only when it IS a slug, case aside, and never a digit run or a path", () => {
  const found = (text: string) => scanProjectMentions(text, PROJECTS).map((m) => [m.start, m.text, m.slug])
  assert.deepEqual(found("move it to #arktype, then #Home."), [[11, "#arktype", "arktype"], [26, "#Home", "home"]])
  assert.deepEqual(found("#ntwine-web—ok"), [[0, "#ntwine-web", "ntwine-web"]])
  assert.deepEqual(found("#nobody #gone #2024 #123"), [], "unknown, stale, and digit runs (GitHub refs)")
  assert.deepEqual(found("#home/src x.com/#home ##home &#home #home-x #home.ts"), [], "a path, a fragment, a heading, an entity, a longer token")
})

after(() => setProjectMentions(null))

test("agent prose links a project mention to its board, and notifies on a change", () => {
  const marked = new Marked(MARKDOWN_OPTIONS)
  const render = (md: string) => marked.parseInline(md, { async: false }) as string
  setGithubRepo("acme/app")
  try {
    const before = mentionIndexVersion()
    setProjectMentions(CARDS)
    assert.ok(mentionIndexVersion() > before, "rendered prose rebuilds when the projects arrive")
    assert.equal(projectMentionIndex().length, 4)
    const settled = mentionIndexVersion()
    setProjectMentions([...CARDS])
    assert.equal(mentionIndexVersion(), settled, "the same projects again change nothing")
    assert.equal(render("ported to #arktype"), 'ported to <a href="/project/arktype" title="ArkType">#arktype</a>')
    assert.match(render("fixes #12 in #home"), /<a href="https:\/\/github\.com\/acme\/app\/(?:issues|pull)\/12"[^>]*>#12<\/a> in <a href="\/project\/home" title="Home">#home<\/a>/u)
    assert.equal(render("`#home` and #nobody"), "<code>#home</code> and #nobody")
  } finally {
    setGithubRepo(null)
  }
})
