import { useMemo, useState } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { AwaitingHint, BoardSnapshot, ThreadView } from "@frizz/shared"
import { composeBlockAnswer, parseQuestionBlock, type BlockAnswer } from "./lib/questionBlocks.ts"
import {
  FenceCard,
  Message,
  LimitPauseCard,
  PendingAskCard,
  PermPolicyDenialCard,
  ProviderFaultCard,
  QuestionBlockCard,
  ThreadSlugContext,
} from "./components/ChatView.tsx"
import { setBoard } from "./store.ts"
import "./styles.css"

// Every card FAMILY the transcript can render, side by side on one page — the surface the
// "right-justify the actions / give every card the done card's kind header" work is judged against.
// Nothing real is hit: rpc is stubbed the same way done-card-button-fixture does it.
const nativeFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.toString(), window.location.origin)
  if (url.pathname === '/_frizz/rpc/resolveLocalPaths') {
    return new Response(JSON.stringify({ result: { resolved: [] } }), { headers: { "content-type": "application/json" } })
  }
  if (url.pathname.startsWith("/_frizz/rpc/")) {
    return new Response(JSON.stringify({ result: {} }), { headers: { "content-type": "application/json" } })
  }
  return nativeFetch(input, init)
}

const thread = (id: string, title: string, live: Partial<Pick<ThreadView, "runtime" | "subAgents" | "bgShells" | "watches">> = {}): ThreadView => ({
  id,
  title,
  status: "active",
  mechanism: null,
  humanBlocked: false,
  ready: false,
  dependsOn: [],
  externalDeps: [],
  agents: [],
  errors: [],
  warnings: [],
  runtime: "turn-idle",
  unread: false,
  archived: false,
  hasPlan: false,
  pendingQuestion: false,
  kind: "session",
  foreign: false,
  subAgents: [],
  bgShells: [],
  watches: [],
  questions: [],
  ...live,
})

// THE SHELL FENCE, MET MID-TURN — the screenshot of 2026-08-27 ("for shells, I keep on seeing this
// fucking disgusting thing"). The worker parked on a shell and its human's follow-up landed in the same
// second, so the thread never came to rest and the fence card drew instead of the resting card — with
// the fence's machinery as one muted line, "shell b7w140a81   for 45m". The thread behind THIS entry
// carries exactly what a real bumped one does: the running shell and NO watch row for it. The board
// rows a declared shell only while the fence is the worker's last word, and the tailer clears that on the
// user record that bumps the thread — the first cut of this entry stubbed the row in, which is how the
// fence card shipped believing the rows survived the bump (maintainer 2026-08-28: "it hides the
// background shell for some reason"). The card must draw the resting card's own "Background shells"
// row off its own `shells:` hint, and never the id.
const shellStartedAt = new Date(Date.now() - 4 * 60_000).toISOString()
const midTurnShellThread: Partial<Pick<ThreadView, "runtime" | "subAgents" | "bgShells" | "watches">> = {
  runtime: "running",
  bgShells: [{ id: "toolu_shell1", taskId: "b7w140a81", label: "Compile matrix ×2 at 10 items, then the moltar bench", startedAt: shellStartedAt, state: "running" }],
  watches: [],
}

const timerIso = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString()

// An assistant rest whose fence names a sub-agent id that is not running — the shape frizz refuses. The
// prose above the fence is the worker's own and always survives; only the fence block is at stake.
const refusedMessageText = [
  "Both rework agents are back and I have folded their numbers in.",
  "",
  "```awaiting",
  "pr: colinhacks/zod#5910",
  "agent: toolu_theWrongId",
  "for: 3h",
  "---",
  "Waiting on CI and on the bisect that decides whether #5914 is salvageable at all.",
  "```",
].join("\n")

// No SETTLED entry: an ```awaiting fence whose wait is over draws nothing at all — not the card and not
// its prose — so the transcript skips the block before it ever reaches FenceCard (see ChatView.renderText).
// There is no such thing as a settled awaiting CARD to put in a gallery of cards.
const fences: { slug: string; label: string; kind: "done" | "awaiting"; body: string; hints: AwaitingHint[] }[] = [
  {
    slug: "g-done",
    label: "```done",
    kind: "done",
    body: "- Fixed the cache collision in `src/resolver.ts` — the lookup now keys on the normalized id.\n- Added a regression test; `npm test` green.",
    hints: [],
  },
  // FRONTMATTER + MARKDOWN — the shape a worker writes since 2026-08-17. The prose is arbitrary and
  // renders as BLOCKS, so a handoff with a list stays a list instead of being flattened into one run.
  {
    slug: "g-frontmatter",
    label: "```awaiting · frontmatter + markdown",
    kind: "awaiting",
    body: "Known-answer control on the new escape detector, before I commit the check.\n\n- angular (zero install-script deps) must report **clean**\n- puppeteer must be **flagged**\n\nIf either fails I will bisect rather than re-run.",
    hints: [
      { kind: "shell", value: "bb4sns0ye" },
      { kind: "pr", value: "acme/app#391" },
      { kind: "for", value: "20m" },
    ],
  },
  // THE STRUCTURAL FENCE, which is what a worker writes now: YAML frontmatter naming the things it waits
  // on and a duration, then its prose below the `---`. The card renders the prose; the raw fence syntax
  // must never reach the reader (maintainer 2026-08-16), and neither may its ids — the thread behind this
  // entry has nothing live, so the card draws the prose ALONE (the mid-turn entry below is the one with
  // a row).
  {
    slug: "g-structural",
    label: "```awaiting · the structural fence",
    kind: "awaiting",
    body: "Holding until the suite lands; I will fold the result in.",
    hints: [
      { kind: "shell", value: "bvg44v4ij" },
      { kind: "for", value: "40m" },
    ],
  },
  // A worker still on the OLD contract writes a deleted kind, which the parser drops into the BODY. It
  // must not be printed as prose — that is the exact "why does it look like this" screenshot.
  {
    slug: "g-stale-kind",
    label: "```awaiting · a stale `watch:` line",
    kind: "awaiting",
    // BOTH in the body, which is the post-2026-08-24 shape: `reason:` is retired, so the worker's prose
    // and the line frizz refused arrive in the same place, and the card has to tell them apart itself.
    body: "watch: bvg44v4ij\nCI on acme/app#1227 is running.",
    hints: [{ kind: "for", value: "40m" }],
  },
  {
    slug: "g-shell-midturn",
    label: "```awaiting · shells, thread mid-turn (the resting card's table, not a line of ids)",
    kind: "awaiting",
    body: "Running on the quiet machine (load 6.7): the compile matrix twice with both array rows at 10 items, then the cross-library moltar benchmark again. When they finish: fill the shared-axis chart, regenerate the compile post's SVGs and alt text, and re-sweep the \"array of 50\" mentions in both posts.",
    hints: [
      { kind: "title", value: "10-item arrays + moltar re-run" },
      { kind: "shell", value: "b7w140a81" },
      { kind: "for", value: "45m" },
    ],
  },
  { slug: "g-timer", label: "```awaiting · timer", kind: "awaiting", body: "Re-checking the rollout at the checkpoint.", hints: [{ kind: "timer", value: "tmr_a1b2c3" }, { kind: "for", value: "2h" }] },
  { slug: "g-pr", label: "```awaiting · prs", kind: "awaiting", body: "PR is open and CI is green. Watching for review.", hints: [{ kind: "pr", value: "acme/app#391" }] },
  // THE WORKER NAMED ITS OWN HEADING. The resting card has honoured `title:` since 2026-08-26; this card
  // did not, so a fence whose thread was not at rest — mid-turn, snoozed, or already past the fence —
  // headed itself "Awaiting" and dropped the one line that says which wait this is.
  {
    slug: "g-titled",
    label: "```awaiting · title + one pr",
    kind: "awaiting",
    body: "Waiting on the genuine CI run for #391 on head `85eca799`. Lint is green; the three TypeScript legs are still running.",
    hints: [
      { kind: "title", value: "Real CI run on the perf fix" },
      { kind: "pr", value: "acme/app#391" },
      { kind: "for", value: "12h" },
    ],
  },
  // The worst title the cap allows: 40 unbreakable characters sharing the row with a shrink-0 PR ref.
  // A code-authored kind never had one, which is why the header's wrap rule had never met it.
  {
    slug: "g-titled-unbreakable",
    label: "```awaiting · title with no break opportunity",
    kind: "awaiting",
    body: "Holding on the branch build.",
    hints: [
      { kind: "title", value: "release/2026-08-27-hotfix-abcdefghijklmno" },
      { kind: "pr", value: "acme/app#391" },
      { kind: "for", value: "2h" },
    ],
  },
  // Several watches is a different SHAPE, not the same card with more data: one ref rides the title row
  // in the `aside` slot, so a fence carrying three gets a wrapped row of its own under the prose.
  {
    slug: "g-pr-many",
    label: "```awaiting · prs (several)",
    kind: "awaiting",
    body: "All three adoption PRs are open and green, in their maintainers' hands.",
    hints: [
      { kind: "pr", value: "withastro/astro#17487" },
      { kind: "pr", value: "vitejs/vite#23019" },
      { kind: "pr", value: "strapi/strapi#26864" },
    ],
  },
  { slug: "g-human", label: "```awaiting · human", kind: "awaiting", body: "The API shape needs approval.", hints: [{ kind: "shell", value: "Alice to approve the API shape" }] },
  { slug: "g-legacy", label: "```awaiting · legacy ci (no action)", kind: "awaiting", body: "The legacy build is still running.", hints: [{ kind: "shell", value: "acme/app#7" }] },
]

// The `approval` kind is RETIRED (2026-07-26) — a go/no-go is just a two-option question, and the last
// two entries are exactly that: the gate shapes a worker used to tag `approval` / `approval danger`,
// now rendering through the ordinary staged chips + Send path like every other block.
const questions: { label: string; raw: string; kind: "question" | "multi"; danger?: boolean }[] = [
  {
    label: "```question",
    kind: "question",
    raw: "Should the settings store use SQLite or a JSON file?\n\n- A. SQLite — transactional, matches the session registry (recommended: consistency with what exists)\n- B. JSON file — zero deps, human-editable, racy under concurrent writes",
  },
  {
    label: "```question · go/no-go (was `approval`)",
    kind: "question",
    raw: "Ready to create CONTRIBUTING.md with the draft above?\n\n- A. Approve as-is\n- B. Approve with edits — tell me what to change",
  },
  {
    label: "```question multi",
    kind: "multi",
    raw: "Which of these findings should I fix in this pass?\n\n- A. Null-deref in parse() — crashes on empty input\n- B. Off-by-one in slice() — drops the last row\n- C. Flaky timeout in the retry test — passes on rerun",
  },
  {
    label: "```question danger",
    kind: "question",
    danger: true,
    raw: "Force-merge PR #391 over the failing flaky check and delete the `legacy-api` branch?\n\n- A. Do it — the failure is the known-flaky timeout\n- B. Hold — I'll wait for a green run",
  },
]

const board: BoardSnapshot = {
  projectDir: "/tmp/fixture",
  projectName: "fixture",
  projectLabel: "fixture/fixture",
  threads: fences.map((f) => thread(f.slug, f.label, f.slug === "g-shell-midturn" ? midTurnShellThread : {})),
  errors: [],
  warnings: [],
}
setBoard(board)

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[11px] text-muted">{label}</p>
      {children}
    </div>
  )
}

// One question block wired to REAL local answer state (chips toggle, the free-text box types) plus a
// readout of what Send would put ON THE WIRE. Live state is what makes the gallery answer the questions
// a static render can't: does a chip select, does the free-text box take a newline, does ⌘-Enter send.
function QuestionSection({ q }: { q: (typeof questions)[number] }) {
  const parsed = useMemo(() => parseQuestionBlock(q.raw, q.kind, q.danger), [q])
  const [answer, setAnswer] = useState<BlockAnswer>({ chosen: null, text: "", chosenSet: [] })
  const [sent, setSent] = useState<string | null>(null)
  return (
    <Section label={q.label}>
      <QuestionBlockCard
        raw={q.raw}
        questionKind={q.kind}
        danger={q.danger}
        interactive={{
          answer,
          onChip: (optIdx: number) =>
            setAnswer((a) =>
              q.kind === "multi"
                ? { ...a, chosen: null, chosenSet: (a.chosenSet ?? []).includes(optIdx) ? (a.chosenSet ?? []).filter((i) => i !== optIdx) : [...(a.chosenSet ?? []), optIdx].sort((x, y) => x - y) }
                : { ...a, chosen: a.chosen === optIdx ? null : optIdx },
            ),
          onText: (text: string) => setAnswer((a) => (q.kind === "multi" ? { ...a, text } : { chosen: null, text })),
          onSubmit: () => setSent(composeBlockAnswer(parsed, answer)),
        }}
      />
      {sent !== null && (
        <p data-sent className="whitespace-pre-wrap text-[11px] text-accent">
          sent → {sent}
        </p>
      )}
    </Section>
  )
}

function Fixture() {
  return (
    <QueryClientProvider client={client}>
      <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col gap-5 px-4 py-8">
        <p className="petite-caps text-[10px] text-accent">Signal fences</p>
        {fences.map((f) => (
          <Section key={f.slug} label={f.label}>
            <ThreadSlugContext.Provider value={f.slug}>
              <FenceCard fenceKind={f.kind} body={f.body} hints={f.hints} />
            </ThreadSlugContext.Provider>
          </Section>
        ))}
        {/* A REFUSED fence, at MESSAGE level — the only place it can be seen, because what it changes is
            that the fence block is never handed to a card at all. Both entries carry byte-identical text;
            only `fenceRefused` differs, so the pair reads as the before/after it is. */}
        <p className="petite-caps mt-4 text-[10px] text-accent">A refused fence</p>
        {[false, true].map((refused) => (
          <Section key={String(refused)} label={refused ? "fenceRefused — frizz declined the park" : "the same message, honoured"}>
            <ThreadSlugContext.Provider value="g-pr">
              <Message
                m={{
                  sourceId: `refused-${refused}`,
                  role: "assistant",
                  text: refusedMessageText,
                  tools: [],
                  parts: [{ kind: "text", text: refusedMessageText }],
                  ...(refused ? { fenceRefused: true as const } : {}),
                }}
              />
            </ThreadSlugContext.Provider>
          </Section>
        ))}
        <p className="petite-caps mt-4 text-[10px] text-accent">Question blocks</p>
        {questions.map((q) => (
          <QuestionSection key={q.label} q={q} />
        ))}
        <p className="petite-caps mt-4 text-[10px] text-accent">Runtime banners</p>
        {/* Denials only. The approval line this used to sit beside is gone — see PermPolicyDenialCard. */}
        <Section label="permission policy — denied">
          <PermPolicyDenialCard
            policy={{
              decision: "deny",
              rule: "catastrophic-delete",
              reason: "Refused: this recursively force-deletes a root-level or home directory, which is unrecoverable. If you genuinely need to remove a large tree, target an explicit project-relative path instead.",
              tool: "Bash",
              command: "rm -rf ~",
              at: new Date().toISOString(),
            }}
            denies={2}
          />
        </Section>
        <Section label="permission policy — denied (long command, wrapping)">
          <PermPolicyDenialCard
            policy={{
              decision: "deny",
              rule: "history-rewrite",
              reason: "Refused: this force-pushes a rewritten history over a shared branch, which destroys commits other agents may already be building on.",
              tool: "Bash",
              command: "cd ~/.cache/nub/worktrees/canary-debug && git fetch origin && git rebase origin/main && git push origin HEAD:main --force --follow-tags",
              at: new Date().toISOString(),
            }}
          />
        </Section>
        <Section label="provider fault (sign-in required)">
          <ProviderFaultCard
            slug="g-fault"
            sessionId="s1"
            fault={{ backend: "claude", category: "authentication_required" }}
            retryText="fix the flaky test"
          />
        </Section>
        <Section label="usage-limit pause">
          <LimitPauseCard
            slug="g-pause"
            sessionId="s1"
            pause={{ backend: "claude", window: "session", at: new Date().toISOString(), resumesAt: Math.round(Date.now() / 1000) + 7200, autoResume: true }}
          />
        </Section>
        <Section label="pending native ask">
          <PendingAskCard
            ask={{
              questions: [
                {
                  question: "Which library should we use for date formatting?",
                  header: "Library",
                  multiSelect: false,
                  options: [
                    { label: "date-fns", description: "tree-shakeable, no tz database" },
                    { label: "Luxon", description: "full tz support, larger" },
                  ],
                },
              ],
            }}
            onTerminal={() => {}}
          />
        </Section>
      </main>
    </QueryClientProvider>
  )
}

createRoot(document.getElementById("root")!).render(<Fixture />)
