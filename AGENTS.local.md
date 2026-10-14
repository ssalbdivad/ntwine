# Local setup — the maintainer's own checkout

This file is the operating manual for ONE machine: the maintainer's checkout of `ssalbdivad/ntwine`, where ntwine dispatches its own workers, where several agents and the human edit a single shared working tree at the same time, and where finished work lands by being committed to a local `main`. [`AGENTS.md`](AGENTS.md) links here; that file holds the norms that apply to everybody.

**None of this applies to an outside contributor.** If you cannot push to `ssalbdivad/ntwine`, stop reading — fork the repo and open a pull request, which is the only way to offer a change from outside and is welcome.

# No pull requests — land on local `main`

This repo does NOT use pull requests. Ever. NEVER run `gh pr create` (or the `gh api .../pulls` POST
equivalent, or the GitHub UI) — not for a typo, not for a big feature, no size threshold, no
exception. This binds EVERY agent that touches this checkout: the top-level worker and every sub-agent it
dispatches. If you find yourself about to open a PR, STOP — in this repo that is always the wrong move.

Land finished work on this machine's local `main` instead: work directly on `main`, or do
isolated/messy work in a git worktree on a local branch under `.ntwine/worktrees/`
(`git worktree add .ntwine/worktrees/<slug> -b <slug>`, then `nub install` inside it before you run
anything — a nested worktree with no `node_modules` of its own silently imports the main checkout's
`@ntwine/*` packages instead of failing) and, when it's done and you're confident, merge it back
yourself (`git switch main && git merge <slug>`) and remove the worktree
(`git worktree remove .ntwine/worktrees/<slug>`). Never create one beside the
checkout (`../ntwine-<slug>`): where repos live directly in `~`, that is a new folder in the home
directory. Getting the change onto local `main` is your job — never push a branch to stage a
review and never hand back an unmerged branch. Reading GitHub (issues, PRs, CI) is fine; creating or
pushing a PR is not. (`NTWINE.md` states this in full for ntwine
workers, whose contract is frozen at session start. This file is the copy for everything else running
in this checkout — a plain Codex or Claude session and the sub-agents it dispatches — which reach it
through the link in `AGENTS.md` rather than loading it automatically.)

**Every worktree lives in `.ntwine/worktrees/<slug>/`, inside this checkout, and nowhere else** — never
`/tmp`, never a sibling folder, never `.claude/worktrees/`. `.ntwine/` is ignored already, and the test
runner's globs, `tsc -b`, the dev server's watcher and ripgrep all stay out of it (checked 2026-10-11).
Run `nub install` in a new worktree before anything else: until you do, an `@ntwine/*` import there
resolves through the parent `node_modules` to the SHARED tree's packages, and the worktree quietly
tests `main`'s code instead of its own. A worktree you find anywhere else predates this rule
(2026-10-11) and belongs to someone: leave it. Its owner moves it, once nothing is running in it, with
`git worktree move <old-path> .ntwine/worktrees/<slug>`.

Git hygiene does NOT matter here — the only thing that matters is getting your changes onto local
`main`. Many agents (and the human) work in parallel against the same repo constantly, so `main` moves
under you and the shared working tree is often dirty with someone else's in-progress edits. Do not let
that block you and do not wait it out: commit whatever is in the working tree first (an intermediate
`git add -A && git commit -m "wip: snapshot in-flight work"` is fine — committing another agent's
uncommitted changes to unblock your merge is EXPECTED, not a violation), then merge your branch in and
resolve conflicts favoring a correct build of your own change. A messy history, a WIP commit that mixes
several agents' work, an ugly merge — all fine. Never `git stash` in the shared tree (it corrupts
concurrent agents), never force-discard someone's committed work, and never stall a landing on "the
tree isn't clean." Keep merging into `main`.

## Committing out of a tree other agents are editing

**Default to `git commit -m "…" -- <paths>`.** The pathspec form commits the working-tree content of
exactly those paths on top of `HEAD` through a temp index git seeds for you, so a concurrent `git add`
by another agent cannot ride along and the shared index is left as you found it.

**Do NOT reach for `GIT_INDEX_FILE=/tmp/idx git add … && git commit`.** A temp index path that does not
exist yet starts EMPTY, not as a copy of `HEAD` — `git commit` then writes a tree holding only the
paths you added, recording *every other tracked file* as deleted. The working tree is untouched, so
nothing looks wrong until someone checks that commit out. This has cost real recovery cycles more than
once. If you genuinely need a private index (only to `git apply --cached` one hunk out of a file
another agent is also editing), run `git read-tree HEAD` immediately after setting the path.

Either way, **verify the tree right after committing**: `git ls-tree -r --name-only HEAD | wc -l`
should be roughly what it was before, not collapsed to the size of your change.

`scripts/githooks/pre-commit` backstops this — it refuses any commit that records files as deleted
while they still exist on disk, which a genuine `git rm` cannot trigger because that removes the file
from disk too. It is wired through `core.hooksPath`, which is LOCAL config, so in a fresh clone run:

```sh
git config core.hooksPath scripts/githooks
```

**Keep that value RELATIVE, and re-check it whenever the checkout moves.** Git accepts an absolute `core.hooksPath`, and this machine had one — `/Users/me/Documents/projects/fray/scripts/githooks`, left from before the directory was renamed to `.../ntwine`. Git does not warn when `core.hooksPath` names a directory that does not exist; it simply runs no hooks. Measured 2026-08-11 with a control pair: pointed at a real dir, a failing hook blocks the commit (exit 1); pointed at a missing dir, the identical commit succeeds (exit 0). So the backstop above was silently OFF for every agent commit between the rename and 2026-08-11 — the one guard against a tree-collapsing commit, gone exactly while nobody could tell. `git config core.hooksPath` must print `scripts/githooks`; if it prints an absolute path, reset it.

# Come to rest in as few words as the answer needs

The resting message is read in a queue, cold, hours later. Make it maximally concise: the verdict, then only what the reader cannot get anywhere else. Length is not thoroughness — a long handoff buries the one line that mattered, and the maintainer has to read twice to find it.

Cut, every time: preambles and sign-offs ("Great question", "I've now completed", "Let me know if"), narration of your own process, restating the request back, hedging on something you verified, and any adjective doing no work ("comprehensive", "robust", "thorough"). Never restate the fenced card in the prose above it — see `NTWINE.md`; they are two surfaces, and a sentence that reads the same in both belongs in one.

No agent speak. Write what happened in plain words a colleague would use. If a sentence could be deleted without the reader losing a fact or a decision, delete it.
