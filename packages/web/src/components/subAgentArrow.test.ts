import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { ANSWER_FOLLOW_UP_MARKER } from "@ntwine/shared"

// The "child of / branches from" affordance is ONE glyph: ⤷ (U+2937), established by the sidebar's
// sub-agent rows and reused by the drawer's operation lines, the queue card's child lines and the
// completion dialog. The queue card drifted to ↳ (U+21B3) when it was added, so a single queue card
// rendered two different down-right arrows a few pixels apart.
//
// The original guard banned the WRONG glyph. This one is strictly stronger: the arrow is now a token
// in lib/childOps.ts and NO OTHER SOURCE MAY SPELL EITHER ARROW IN RENDERED CODE AT ALL. A surface
// cannot drift to the wrong arrow — or to a right-but-hand-copied one that later drifts — if it has no
// literal to drift with. It has to import CHILD_ARROW, which is one string for everyone by construction.
const CHILD_ARROW = "⤷"
const WRONG_ARROW = "↳"
const ARROWS = [CHILD_ARROW, WRONG_ARROW]

const SRC = fileURLToPath(new URL("..", import.meta.url))
const SELF = fileURLToPath(import.meta.url)
// The token module DEFINES the glyph; this test NAMES both in order to search for them. Every other
// web source must be arrow-free in the code it actually renders.
const TOKENS = join(SRC, "lib", "childOps.ts")

// A source file's path RELATIVE to src/, always with `/` separators. The assertions below name files
// the way the imports do; `path.slice()` alone yields `lib\\dismissChildOp.ts` on win32, which no
// hand-written expectation matches.
function relative(path: string): string {
  return path.slice(SRC.length).replaceAll("\\", "/")
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(path))
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(path)
  }
  return out
}

// COMMENTS may still name the glyph: several explain why a surface renders a child row, and a design
// note is not a second source of truth. Strip line and block comments (the block form also covers JSX's
// {/* … */}) so only rendered code is judged. The one blind spot this leaves — an arrow inside a string
// that follows a `//` on the same line — is not reachable by anything that renders.
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")
}

test("no web source outside lib/childOps.ts spells a child arrow — every surface imports the token", () => {
  const offenders = sourceFiles(SRC)
    .filter((path) => path !== SELF && path !== TOKENS)
    .filter((path) => ARROWS.some((arrow) => code(readFileSync(path, "utf8")).includes(arrow)))
    .map(relative)
  assert.deepEqual(
    offenders,
    [],
    `a down-right arrow must never be written out in a component — import CHILD_ARROW from lib/childOps.ts: ${offenders.join(", ")}`,
  )
})

test("the banned U+21B3 arrow appears nowhere at all, not even in a comment", () => {
  const offenders = sourceFiles(SRC)
    .filter((path) => path !== SELF && readFileSync(path, "utf8").includes(WRONG_ARROW))
    .map(relative)
  assert.deepEqual(offenders, [], `U+21B3 ↳ must not appear in web sources — the child arrow is U+2937 ⤷: ${offenders.join(", ")}`)
})

test("the answer wire's follow-up marker IS the child arrow — one glyph, two packages", () => {
  // A ROW in an answers message is marked as a follow-up with this glyph, and the server writes it while
  // the browser parses it, so the token has to live in @ntwine/shared where both can reach it. That puts a
  // second declaration of the same character outside the reach of the sweep above — hence this: the two
  // are asserted equal rather than trusted to stay so. Drift here does not throw, it just stops the
  // parser matching, and an unmatched row silently loses the human's answer to a raw prose bubble.
  assert.equal(ANSWER_FOLLOW_UP_MARKER, CHILD_ARROW)
})

test("lib/childOps.ts holds the one child-arrow token, and it is U+2937", () => {
  const tokens = readFileSync(TOKENS, "utf8")
  assert.match(tokens, /export const CHILD_ARROW = "⤷"/)
  assert.ok(!tokens.includes(WRONG_ARROW), "the token module must not name the banned arrow")
})

// Every surface that lists a thread's children as operation rows: the queue card's sub-agent lines,
// the queue card's reproduction of the drawer strip, the thread view's own ops strip, and a project
// board's rows under each thread (Sidebar.tsx SubAgentRows, since 2026-10-06).
const CHILD_ROW_SURFACES = ["components/QueueSubAgentLines.tsx", "components/QueueChildOps.tsx", "components/ChatView.tsx", "components/Sidebar.tsx"]

test("every child-operation surface renders through the one shared row component", () => {
  // ChildOpRow is the only renderer of a child row; these are its four adoption sites. A new surface
  // that hand-rolled the row would already fail the arrow guard above — this pins the existing four so
  // none of them quietly regresses back to a local copy. All projects' list is deliberately NOT one of
  // them: since 54309fb2 it lists no child rows at all, only a count and a robot on the thread's own row
  // (pinned by Sidebar.subAgentCount.test.ts), so it must not grow one back either. A project's board
  // lists them as rows under each thread, as upstream's sidebar did (2026-10-06, ProjectBoard.tsx).
  for (const file of CHILD_ROW_SURFACES) {
    assert.match(readFileSync(join(SRC, file), "utf8"), /<ChildOpRow\b/, `${file} must render the shared ChildOpRow`)
  }
  assert.doesNotMatch(readFileSync(join(SRC, "components/ProjectList.tsx"), "utf8"), /<ChildOpRow\b|<SubAgentRows\b/, "All projects shows a count, not child rows")
  assert.match(readFileSync(join(SRC, "components/ProjectBoard.tsx"), "utf8"), /<SubAgentRows\b/, "a project's board lists them under each thread")
  // The completion-hold dialog lists children as PROSE inside a dialog, not as operation rows (no
  // liveness mark, no drill-in, no dismiss), so it consumes the tokens directly rather than the row.
  assert.match(readFileSync(join(SRC, "components/ThreadLifecycle.tsx"), "utf8"), /CHILD_ARROW\b/)
})

test("every child-operation surface offers the dismiss ×, through the one shared dismisser", () => {
  // Maintainer 2026-07-30: "the X button to stop a sub-agent should show up everywhere sub-agents are
  // listed — in the sidebar, in the cue cards, in the full view." The × was an ops-strip-only control,
  // so the rail and the queue card named a phantom child and offered no way to retire it. This is the
  // guard against a surface silently dropping the control again, and against one of them growing its
  // own dismiss call: `childOpDismisser` is where the direct-child / has-an-id rule lives, and a local
  // `stopBackgroundOp` call on any client — the page's `rpc` or a project-scoped one — would route
  // around it. All projects' list stopped listing children (54309fb2); a project's board lists them again
  // (Sidebar.tsx SubAgentRows), and is on the list.
  for (const file of CHILD_ROW_SURFACES) {
    const source = readFileSync(join(SRC, file), "utf8")
    assert.match(source, /onDismiss=\{childOpDismisser\(/, `${file} must pass the shared dismisser to its ChildOpRow`)
  }
  const callers = sourceFiles(SRC).filter((path) => /\.stopBackgroundOp\(/.test(readFileSync(path, "utf8")))
  assert.deepEqual(
    callers.map(relative),
    ["lib/dismissChildOp.ts"],
    "stopBackgroundOp has exactly one caller — the shared dismisser",
  )
})
