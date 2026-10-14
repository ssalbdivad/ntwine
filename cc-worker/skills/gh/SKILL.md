---
name: gh
description: The gh-CLI playbook for an ntwine worker signed into GitHub (invoke as ntwine:gh). Load this whenever your effort touches GitHub — reading or triaging an issue or PR, reviewing a diff, checking CI/release status, or searching issues/PRs — to use `gh` eagerly and correctly: the read-vs-write boundary (never push/open a PR/comment/label/close/merge unless the human asks), concrete read recipes, and active Monitor/background-Bash CI/PR watches. Only meaningful when you are signed in (`gh auth status --active` exit 0); the session-seed hook injects a pointer here when you are.
version: 0.1.2
metadata:
  internal: true
---

# ntwine:gh — the gh-CLI playbook

You are a **ntwine worker** and you are **signed into the `gh` CLI in a GitHub repo** (the session-seed hook confirmed `gh auth status --active` before pointing you here). `gh` is the fastest path to issue / PR / CI / release context — reach for it before guessing, and prefer it over scraping the web UI or reasoning from memory.

This skill is the full playbook the injected `⟦gh available⟧` block summarizes: the **read-vs-write boundary**, concrete **read recipes**, and how to keep a **CI/PR watch** active until the next actionable event.

## The one hard rule — READ freely, WRITE only when asked

`gh` can mutate the repo, and your token has the scopes to do it. **Do not.** Unless the human's **current request explicitly asks** (or the project's `NTWINE.md`/`AGENTS.md`/`CLAUDE.md` tells workers to), you are strictly read-only:

- **NEVER** push a branch, open a pull request, comment, review, approve, request-changes, label, assign, milestone, edit, close, reopen, or merge — no state change of any kind on GitHub.
- **Permission covers the change it was given for.** "Open a PR for this" an hour ago is not a mandate to open one for the next request, nor to push that next change onto its branch because you happen to be standing on it — only a request that names the PR goes to it. Unasked, finished code stays local — uncommitted, or on a worktree's local branch — and your `done` card says where and that it is ready to commit or open a PR.
- Your deliverable is your **final message** (a findings write-up, a review, a recommendation) — NOT a GitHub post. Producing the review in-session is the job; posting it is a separate action the human authorizes.
- If posting would genuinely help, don't just do it — **ask** with a two-option `ntwinectl ask` question ("Post this review to the PR" / "Keep it in-session only", the recommended one first, and the posting option marked `external` so Ntwine's unanswered-question default never posts it), then rest. When the destructive edge is real (a force-merge, a close), that's the same question with `danger` set. Never a ` ```question ` fence — that fence is retired (2026-09-11), and a question in a fence body is plain prose.
- When the human HAS asked you to write, do exactly the scoped thing and report the resulting URL — nothing extra.

There is no server-side enforcement of this; the boundary is yours to hold.

## Read recipes

Always scope with `-R OWNER/REPO` so a command is dir-independent, and prefer `--json <fields>` (+ `-q <jq>`) so you pull exactly what you need.

**Issues**
```bash
gh issue view N -R OWNER/REPO --comments                          # full thread, human-readable
gh issue view N -R OWNER/REPO --json title,body,labels,state,url  # structured
gh issue list -R OWNER/REPO --search "sort:updated-desc" --json number,title,url,updatedAt --limit 30
gh issue list -R OWNER/REPO --search "sort:reactions-desc is:open" --json number,title,url --limit 30
```

**PRs + diffs**
```bash
gh pr view N -R OWNER/REPO --json title,body,state,labels,files,additions,deletions,url
gh pr diff N -R OWNER/REPO                # the unified diff
gh pr checks N -R OWNER/REPO              # CI check rollup for the PR
gh pr view N -R OWNER/REPO --comments     # review threads + conversation
```
Read the changed files **in context**, not just the hunks — `gh pr diff` shows what changed, but correctness lives in the surrounding code.

**Reading ONE review (what a `ntwinectl watch-pr` wake hands you)**

A wake permalink ending `#pullrequestreview-<id>` is a **review**, and a review's `body` is routinely
**empty** — review apps (pullfrog, coderabbit) and humans doing an inline pass put every word in the
review's *inline comments*. Reading the body and concluding the review is empty is the wrong turn here.
One endpoint answers it in one call:

```bash
gh api --paginate repos/OWNER/REPO/pulls/N/reviews/REVIEW_ID/comments \
  --jq '.[] | "\(.path):\(.line // .original_line // "file")\n\(.body)\n"'
```

Do **not** sweep `…/pulls/N/comments` and filter by `pull_request_review_id` — it pulls the whole PR's
history to find a handful of lines. Add the review's own body only if you need it
(`gh api repos/OWNER/REPO/pulls/N/reviews/REVIEW_ID --jq .body`). A `#issuecomment-<id>` permalink is
the other shape and *does* carry its substance in its body:
`gh api repos/OWNER/REPO/issues/comments/ID --jq .body`.

**`--paginate` is the default for any list endpoint.** `gh api` returns **30** items per page and caps
`per_page` at **100**, silently — a truncated page reads exactly like "that's all there is," so a
missing `--paginate` becomes a wrong answer rather than an error.

**CI / runs / releases**
```bash
gh run list -R OWNER/REPO --branch BRANCH --limit 10
gh run view RUN_ID -R OWNER/REPO --log-failed        # just the failing step logs
gh release view -R OWNER/REPO                         # latest release
```

**Search (across issues/PRs)**
```bash
gh search issues -R OWNER/REPO "crash on startup" --state open --json number,title,url --limit 30
gh search prs --repo OWNER/REPO "author:@me" --json number,title,url --limit 30
```
Use search to find duplicates, related work, and prior art before you conclude something is novel.

**Raw API** for anything the porcelain doesn't cover:
```bash
gh api repos/OWNER/REPO/commits/SHA/check-runs --jq '.check_runs[] | {name, conclusion}'
gh api "repos/OWNER/REPO/issues?state=open&labels=bug&per_page=50" --jq '.[] | {number, title, html_url}'
```

## Keep GitHub automation active

CI, automated review, releases, merge queues, and already-authorized merge progression are work you
can observe with `gh`; they do not earn an `awaiting` fence. Keep a live operation attached to the
thread and continue when it reports.

### Select monitor tooling explicitly

Before launching any CI/review monitor, inspect project-local `AGENTS.md`, active skills, repository
docs, `package.json` scripts, and declared monitor tooling. Prefer an explicit project-local monitor
only if it documents terminal semantics for this gate. Validate its absolute command and terminal
event/exit contract before launch. If declared tooling is missing, invalid, or has no terminal
semantics, stop and report that configuration error; never silently shadow it with an Ntwine script, and
never execute a monitor merely because its filename looks plausible.

When no project monitor is declared, the bundled fallback scripts are
`<this-skill-dir>/scripts/ci-watch.mjs` and `review-watch.mjs`. They are generated byte-for-byte from
Ntwine's canonical `monitors/` source and require only Node plus logged-in `gh`. Their stdout is
`ntwine.github-monitor/v1` NDJSON: `status` means keep waiting; `terminal` is a verdict. They join
exact-head workflow runs with PR checks, keeping `ACTION_REQUIRED` pending, and baseline every review
and comment so any new one wakes — bot or human, with no actor
filter. A GitHub/auth error is terminal exit 3; SIGINT/SIGTERM produces terminal
`cancelled` and exit 130. A `--once` pending/baseline snapshot is deliberately non-terminal exit 0.
For CI, retries are collapsed only within the same workflow name and event; distinct exact-head events
such as `push` and `pull_request` both contribute to the aggregate verdict.

- One-shot completion: launch `Bash` with `run_in_background: true`, for example
  `gh run watch RUN_ID -R OWNER/REPO --exit-status` or a repo watcher that exits when all PR checks
  settle. The completion task-notification re-invokes you. Diagnose/fix on red; continue the authorized
  release/merge path on green.
- State transitions: use native `Monitor` with a quiet loop that prints only changes or the terminal
  event. It is the Claude adapter for the selected script; do not make a sub-agent the monitor
  abstraction.
  Finite monitors run up to one hour; `persistent: true` runs until `TaskStop` or the Claude session
  ends. Stop a watch once its gate is obsolete.
- A background Bash launch exposes an output-file path. Use `Read` on that path only for diagnostics;
  `TaskOutput` is deprecated. Do not fake waiting with `echo waiting` or sleep-only Bash calls.

Both mechanisms are session-bound. If the next check deliberately belongs at a named wall-clock
instant, set a durable timer with `ntwinectl timer set` and park with its id in your fence's `timers:`
list. If a specific external human reviewer/approver is the only remaining gate, that is a
registered question (`ntwinectl ask`) — waiting on a person is never a park. For a GitHub PR, register it with
`ntwinectl watch-pr add` and name it in the fence's `prs:` list (`prs: [OWNER/REPO#NUMBER]`): ntwine
baselines current reviews/comments and wakes on ANY new activity after registration — bot or human —
durably across restarts. The registration creates the wait; the fence only declares it. The dashboard
operator's own go/no-go remains a registered question.

## Fitting gh work into your thread type

- **Investigating an issue** (a research thread): reproduce → trace to `file:line` (cite every load-bearing claim) → recommend the smallest correct fix; read the full thread and linked issues/PRs with `gh` for context. Don't implement — stop at the recommendation. Handback = findings in your final message.
- **Reviewing a PR** (an audit thread): read the diff AND the files in context, verify correctness/edges/tests, check CI (`gh pr checks`), then produce a review (blocking issues vs nits, each citing `file:line`) as your final message. Approve/merge only if explicitly asked.

In both cases: read-only on GitHub unless told otherwise, and the review/findings live in your session, not in a GitHub post.
