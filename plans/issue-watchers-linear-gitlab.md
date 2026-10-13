# Watchers beyond GitHub — what Linear and GitLab would take

Status: assessment, written 2026-09-14 alongside the GitHub issue watcher (`mcp__ntwine__watch_issue`, commit `7a274712` and the follow-ups on `main`). Nothing here is built. The maintainer's framing: "a similar structure where we require the user to be signed in to their respective CLIs."

## What a watcher is made of today

The GitHub issue watcher was built by threading one new `kind` through every layer the PR watcher already had. Those layers are the checklist for any further provider, and each one is a place a second provider would either reuse or fork:

| Layer | Where it lives | GitHub PR | GitHub issue (2026-09-14) |
| --- | --- | --- | --- |
| Registry row | `pr_watch` (`storage.ts`): `kind`, `owner`, `repo`, `number`, `cursor`, `expires_at` | `kind='pull'` | `kind='issue'`, same columns |
| Ref grammar | `awaiting.ts` `parsePrRef` / `parseIssueRef` | `owner/repo#N`, `/pull/N` URL | `owner/repo#N`, `/issues/N` URL |
| Registration probe | `scheduler.ts` `probePrReadable` / `probeIssueReadable` | `gh pr view` | `gh issue view`, refuses a PR number |
| Fetch | `github-review.ts`, one batched GraphQL request per tick, token from `gh auth token` | `pullRequest(number:)` fragment | `issue(number:)` fragment in the same batch |
| Diff and report | `scheduler.ts` `evalPrWatches` / `evalIssueWatch`: cursor of seen ids plus baselines, one undelivered report, re-mint | CI verdict, reviews, comments, labels, conflicts, reviewers, merge/close | comments, labels, assignees, close with reason |
| Wake text | `@ntwine/shared` `prWatchWakeMessage` / `issueWatchWakeMessage`, parsed back by the chat's divider parsers | | same line shapes on purpose |
| Status book | `awaiting.ts` `GITHUB_STATUS_SETTING` / `GITHUB_ISSUE_STATUS_SETTING` | `GithubWatchStatus` | `GithubIssueStatus` |
| Board row | `board.ts` `fenceWatchViews`: `kind: "github"`, `subject: pull \| issue` | checks glyph, counts | issue glyph, "Open · N comments" |
| Fence key | `prs:` / `issues:` → hint kinds `pr` / `issue`, checked against the registry | | |
| Worker tool | `ntwine-mcp.mjs` `watch_pr` / `watch_issue`, both over `addOwnPrWatch` / `dropOwnPrWatch` / `listOwnPrWatches` | | `kind: "issue"` on the add |
| Everything that names kinds | `activity`, `done` blockers, the sign-off nudge, the park corrections, `workerPrompt.ts`, the `gh` skill | | |

The row and the RPCs are GitHub-shaped: `owner`, `repo` and an integer `number`. That is the one thing a second provider cannot reuse as-is, and it is the first thing to change.

## The generalization to do first

Before a second provider, turn the registry into a provider-generic one and put the GitHub code behind an interface. Doing it as part of the first non-GitHub watcher is how the tmux vocabulary outlived tmux: the second provider would be bolted onto GitHub's row and column names and every later reader would have to know that `owner/repo#N` sometimes means `TEAM-123`.

- **Row.** Add `provider TEXT NOT NULL DEFAULT 'github'` and `target TEXT` (the normalized ref, opaque to storage) to `pr_watch`; GitHub keeps writing `owner`/`repo`/`number` and the other providers leave them null. The table keeps its name; renaming buys nothing and touches 60 call sites.
- **Interface.** One `WatchProvider` per provider: `parseRef(kind, text) → target | undefined`, `probe(target) → PrProbe`, `fetchBatch(targets) → Map<target, snapshot | failure>`, `diff(cursor, snapshot) → { changes, settled, status }`, `wake(...)`. `evalPrWatches` becomes a loop over providers; the GitHub implementation is the existing code moved, not rewritten. The issue watcher already shows every seam this interface cuts at (the `kind === "issue"` branches in the fetch, the eval, the probe and the views).
- **Status.** One status book per provider, or one book keyed by `provider:target` with a per-provider reading schema. The board row gains `provider`, and the web branches its glyph, its link and its status line on it. GitHub hovercards stay GitHub-only.
- **Fence and tools.** Either one key per provider-kind (`mrs:`, `linear:`) or one `watches:` key with prefixed refs (`gitlab:group/project!12`). The per-kind keys match what exists; the prefixed form scales better and is what the `activity` readout would print either way. Decide once, before the first non-GitHub key ships.

That refactor is roughly the size of the issue watcher itself: it moves code rather than writing it, but it touches the same 24 files.

## GitLab — the close cousin

**Auth: fits the premise exactly.** `glab` is GitLab's official CLI; `glab auth token` prints the token the way `gh auth token` does, and `glab config get host` names the instance, so self-hosted GitLab comes for free. A registration probe is `glab mr view <iid> -R group/project` or `glab issue view`.

**Refs.** `group/project!12` for a merge request, `group/project#12` for an issue, and the `/-/merge_requests/12` and `/-/issues/12` URL forms. Project paths can carry subgroups (`group/sub/project`), which is why the row needs an opaque `target` rather than `owner`/`repo`.

**Fetch.** GitLab's GraphQL endpoint (`<host>/api/graphql`) takes aliased fields like GitHub's, so the one-request-per-tick batching carries over: `project(fullPath:) { mergeRequest(iid:) { state mergedAt headPipeline { status } approvedBy { nodes { username } } notes(last: 50) { ... } labels { nodes { title } } reviewers { nodes { username } } detailedMergeStatus } }` and `issue(iid:) { state closedAt notes labels assignees }`. Rate limiting is by response headers (`RateLimit-Remaining`, `RateLimit-Reset`) rather than a `rateLimit` field, so the budget guard reads headers instead of the body.

**Report.** A merge request maps onto the PR report almost one-to-one: pipeline status is the CI verdict (a pipeline is one status, not a rollup of checks, so "which job failed" needs `headPipeline { jobs(statuses: FAILED) }`), approvals are reviews, notes are comments, `detailedMergeStatus: CONFLICT` is the conflict clause, and the close/merge settles. A GitLab issue is the GitHub issue report with `notes` for `comments`. The wake text can reuse the GitHub composers with the noun swapped, and the chat's divider parsers would need the `!12` ref shape added to `WAKE_REF`.

**Size.** About the issue watcher again on top of the generalization: the fetcher and the probe are new, the diff and the wake are ports, the web gets a GitLab glyph and link. Call it two to three days of agent work including the refactor, with the real-runtime check needing a `glab`-authenticated account and a project the server can read.

## Linear — smaller surface, weaker premise

**Auth: the premise does not quite hold.** Linear ships no official CLI. The community ones (`linear-cli`, `lin`, a few npm packages) each keep their own config, none of them is the thing a user is reliably "signed in to", and Linear's own supported path is a personal API key or an OAuth app. The honest shape is `LINEAR_API_KEY` in the server's environment (or a `~/.ntwine` setting), with the registration probe refusing when it is unset, rather than reading a CLI's config file. That is a different story from `gh`/`glab` and should be said in the tool description.

**Refs.** `TEAM-123` identifiers, and `https://linear.app/<workspace>/issue/TEAM-123/<slug>` URLs. String identifiers, so again the opaque `target` column.

**Fetch.** Linear's GraphQL API accepts the identifier directly: `issue(id: "TEAM-123") { state { name type } title comments(last: 50) { nodes { id body createdAt url user { name } } } labels { nodes { name } } assignee { name } priority history(last: 20) { nodes { fromState { name } toState { name } createdAt } } }`. Aliased batching works. The rate limit is complexity-based per API key; the guard would read `X-Complexity` and `X-RateLimit-*` headers.

**Report.** Comments and labels as for a GitHub issue; assignee changes; and state transitions, which on Linear are the whole point — `Backlog → In Progress → Done` is what a worker waiting on triage wants to hear. Workflow states are per-team and named freely, but every state carries a `type` (`backlog`, `unstarted`, `started`, `completed`, `canceled`), so "settle when `type` is `completed` or `canceled`" is stable across teams. Priority changes are a fifth reportable thing GitHub has no equivalent of.

**Size.** Smaller than GitLab in code (one subject, no CI, no merge) but it needs the new status shape, the new auth source and a decision on where the key lives. One to two days on top of the generalization; the real-runtime check needs a Linear workspace and a key, which this repo has no fixture for.

## Recommendation

1. Do the generalization first, as its own effort, moving GitHub behind the provider interface with no behaviour change. It is the part that gets harder every time a provider lands without it.
2. GitLab second, because its CLI fits the sign-in premise exactly and its report is a port of GitHub's.
3. Linear third, once the key-source question is settled; without an official CLI its "signed in" story is an environment variable, and that should be a deliberate choice rather than an accident of which community CLI happened to be installed.

## Alternative raised 2026-09-14: a generic change-detecting command watcher

The maintainer's counter-proposal, after the issue watcher landed: register an arbitrary shell command; Ntwine runs it once at registration to take a baseline, keeps running it on a cadence, and wakes the worker only when the output changes. This section is the assessment; nothing is decided.

**What it buys.** One mechanism covers the whole long tail this document sizes provider by provider — a GitLab MR, a Linear issue, an npm publish, a deploy URL, a CI run by id, a file on disk — because the worker writes the command and the "signed in to their CLI" premise becomes literally the command (`glab mr view 12 --output json`, `npm view ntwine version`, `curl -s …`). The provider-generic registry refactor above stops being a prerequisite for GitLab and Linear: each becomes a skill snippet showing the right command and projection, with no server code. It is also the durable form of the wait the worker contract already teaches (`Monitor` with an until-loop, or a sub-agent owning the wait), which today dies with the session.

**What the bespoke PR watcher knows that "output changed" does not.** Every one of these was a bug report before it was a rule, and a generic watcher re-exposes each unless the worker projects the output carefully:

- Terminal-verdict-only for CI, keyed on the head commit (`checksChanged` in `scheduler.ts`): `gh pr view --json statusCheckRollup` changes on every per-job transition, so a change-detector on it fires several times per CI run.
- Gated-after-gated is quiet on any commit; red-again-on-a-new-commit is loud.
- The registration-instant baseline and the `seen` cursor for comments, and the measured noise list (`pr-watch-noise.ts`) for deploy-preview and coverage bots.
- The wake says WHAT to do (permalink to the exact comment, "ask a maintainer for the approval") rather than "something changed".
- Batching: 20 refs per GraphQL request and a rate-limit budget, versus one subprocess per watcher per tick — the fan-out that `PR_STATUS_FALLBACK_LIMIT = 4` exists to contain.

So the generic watcher complements the GitHub ones rather than replacing them: keep the bespoke watchers where the semantics are known and paid for, and use the generic one for everything else.

**A shape that would work.**

- `mcp__ntwine__watch_cmd` (`add` / `list` / `drop`): `command` (run with `sh -c`, cwd pinned to the project dir, no stdin, 30s timeout, output capped), `every` (a duration, floor 30s, default 60s), `for` (required, the PR watcher's ceilings), `label`, and an optional settle rule (`exit0`, or a regex on the output) so a wait with a known end can end itself instead of running out its `for`.
- Registration runs the command once, synchronously, and returns the baseline output so the worker sees exactly what will be diffed; it refuses only when the command cannot be spawned or times out, since a non-zero exit may be the state being waited on.
- One `cmd_watch` row per registration; the cursor holds the last output's hash, its head and tail, the exit code and the run instant. Identical `(cwd, command)` pairs across threads run once per tick, as identical PR refs do.
- Change means the normalized output (trailing whitespace stripped) or the exit code differs. The wake body is a capped unified diff of the two outputs plus the exit-code change, under an armed trailer — a diff of JSON is a good steer for a model, and it is what `changes` already is on the PR wake. One undelivered report per row, re-minted as the PR watcher's is.
- A concurrency gate on the runs (four at a time, like the fallback), and the poll's usual once-per-distinct-failure logging.
- Board: a `command` row under the resting card and the ops strip with its label, last-changed age and next run; it counts as a registered wait the way a PR watcher does (a visible queue handoff, never Snoozed).
- The tool description carries the footgun in the open: project the output (`--jq '{state, comments: .comments | length}'`) or the watcher fires on a timestamp.

**The one decision that is the maintainer's.** The server would run worker-written commands on its own cadence, with its own environment and credentials (`gh`'s token, `HOME`), outside the worker's permission mode, and after the worker's session has ended. A worker already runs arbitrary commands in its own session, so the trust boundary is not new — but the permission gate is bypassed and the run outlives the session, which is a posture question rather than an engineering one.

**Size.** About the issue watcher: one table, one evaluation function that is simpler than either GitHub one, one tool, the board rows and tests. Roughly a day, with the real-runtime check being a registered `npm view` or `gh run view` against a real target.
