# Running Ntwine without Git

Brainstorm, 2026-08-01. Prompted by "a lot of people don't use Git" after `npx ntwine` was found to
hard-fail outside a repository.

## First: separate three different asks

They need very different work, and only one of them is hard.

1. **"I don't use Git *workflows*"** — no branches, no PRs, no worktrees. **Already supported.** The
   README promises it ("Ntwine adds no worktrees, no branches"), and nothing in the launcher creates
   one. The one thing that contradicts the promise is the worker prompt: `GIT_DISCIPLINE`
   (`packages/server/src/workerPrompt.ts:200`) tells every dispatched agent to commit small and often,
   to work from `git worktree add`, and to treat "landed" as a merge. A user who just wants edits in
   their folder gets an agent narrating a git workflow at them. Cheap to fix — see §5.
2. **"My project directory isn't a repository"** — a scratch folder, a Downloads dir, a Dropbox
   folder of scripts, an Obsidian vault, a `~/site` someone `scp`s. **This is the real blocker** and
   the rest of this document is about it.
3. **"`git` isn't installed on my machine"** — genuinely rare on a machine that already has Claude
   Code or Codex on it. Once §6 is honored, **this collapses into (2)**: nothing in a plain directory
   calls `git` at all, so serving (2) serves (3) for free.

My read: **(2), with (1) folded in.** They are one change, and (3) comes along with them.

## 1. What actually depends on Git today

| Use | Where | Hard? |
| --- | --- | --- |
| Project root = repo root | `src/launcher.ts:363`, `packages/server/src/project.ts:60` | **Hard** — the launcher throws `ntwine-dev must be run inside a Git repository` |
| Project identity (`ntwine.id`) | `project-identity.ts` writes `git config --local --add ntwine.id <uuid>` | **Hard** — the id keys `~/.ntwine/projects/<id>/`, the SQLite DB, logs, and scratchpads |

Since the rebrand a pre-existing checkout carries BOTH keys: `migrate-fray.ts` adopts `fray.id` → `ntwine.id` and deliberately keeps the old one, because its survival is the only reason the boards were recoverable when the first cut of that migration forgot the key entirely and every board opened empty. Any future move of identity storage inherits that lesson — see §11.
| Worktree scope | `project-identity.ts:382` (`--git-dir` vs `--git-common-dir`), private `ntwine.config` at `:395` | Hard, but **moot** for a non-repo directory |
| `owner/repo` label | `project.ts:135` (`git remote get-url origin`) | Soft — already `?? name` |
| GitHub picker / PR watch | `github.ts:49` (`gh repo view`) | Soft — already returns `null`, never throws |
| Artifact source stamp | `src/artifacts.ts:241` (`rev-parse HEAD`) | Soft — already `try/catch` |
| Worker git advice | `workerPrompt.ts:200` | Soft — one entry in a section array (`:733`) |

So the surface is small: **root discovery and identity**. Everything else already degrades, which is
a good sign that gitless was half-anticipated.

## 2. The four properties `git config` is buying us

Any replacement has to match these or it's a regression, not a port. This is the real spec:

1. **Atomic creation under a race.** Two `npx ntwine` processes starting at once must commit exactly
   one id. Today: Git's own config lock, plus `acquireNamedLaunchLockSync` keyed on the common git dir
   (`project-identity.ts:350`). There is a test for it — "simultaneous first-run CLI processes commit
   one project identity".
2. **Alias-independence.** `/Users/me/proj` and a symlink to it are one project. Today: `realpathSync`
   on the root, then reading the same config.
3. **Move-survival.** Rename or move the checkout and the board keeps its threads, because nothing is
   keyed on the path.
4. **Sub-directory equivalence.** `cd src/components && npx ntwine` opens the *project's* board, not a
   new one. Today: `rev-parse --show-toplevel` from anywhere inside the tree.

(3) and (4) are the ones a naive "hash the cwd" design silently loses.

## 3. Identity without Git — `.ntwine/ntwine.id`, cross-checked against `~/.ntwine`

**Decided: the id is a file in the project, at `.ntwine/ntwine.id`.** Ntwine already writes `.ntwine/` into
the working tree on first dispatch (thread scratchpads, hook state), so this adds no new footprint
and nothing new to explain, and whether that directory is ignored is the user's call — the README
already tells them to add `.ntwine/` to `.gitignore` themselves.

It also wins the properties outright. §2's move-survival and alias-independence are **free**, because
the id lives *inside* the thing being moved; a path-keyed lookup has to work to recover what a file
gets by construction. Atomic creation reuses `project-launch.ts:148`'s `atomicJson` (open `wx` → fsync →
rename → fsync dir) under `acquireNamedLaunchLockSync` (`project-identity.ts:323`), re-keyed from
`commonGitDir` to a hash of the canonical path — the existing mechanism, so the
concurrent-first-launch test keeps its guarantee.

### The one hazard, and the rule that removes it

Unlike `git config --local`, a file in the tree **can be committed** — and then two clones of that
repo *on one machine* resolve to the same project id at two different paths.

> **STALE, re-derive before building this (2026-08-04).** This paragraph used to name the exact
> failure: `validateFullSocket` in `tmux-socket.ts:399` fails closed on a duplicate id with "unknown
> or foreign ownership". That file went out with tmux and the function no longer exists, so the
> consequence motivating the whole cross-check below is currently unverified — two checkouts sharing
> an id might now collide on the launch lock, quietly interleave on one `ui.db`, or be benign.
> Establish which BEFORE designing `identity.json` to prevent it; the right mitigation depends on the
> actual failure. (`atomicJson` also moved — it is `project-launch.ts:148` now.)

Don't rely on the user's `.gitignore` to prevent it — detect it, and self-heal:

> On resolve, read `.ntwine/ntwine.id`. Cross-check it against `~/.ntwine/projects/<id>/identity.json`,
> which records the path (plus `dev`/`ino`) this id was minted for. If that record names a
> **different path that still exists**, this is a second checkout of a shared id: mint a new id for
> this directory, rewrite `.ntwine/ntwine.id`, and carry on. Otherwise adopt the id and refresh the
> record.

To be clear about the location, because it looks like a new one and isn't:
`~/.ntwine/projects/<id>/` is **already** where a project's entire durable state lives — `ui.db`, the
logs, the launch owner, the artifact pointer. The README states it as the deal ("everything durable
lives outside your checkout in `~/.ntwine/projects/<id>/`, so you can delete `.ntwine/` and keep every
thread and setting"). `identity.json` is one small file beside the database it identifies, in a
directory that exists the moment the project does. Nothing new is written to the home directory.

Two of those files already record the project's path today — `tmux-socket-migration.json` carries
`projectDir` and so does `launcher.json` — so the check could read one of them instead of adding a
file. Not worth it: one is tmux-specific and would follow tmux out, the other is launch state whose
lifetime is a run, and identity deserves a record that means what it says.

No user action, no error, and a moved project still adopts its own id because the recorded path no
longer exists. `(dev, ino)` earns its place here rather than as a primary key: a same-volume `mv`
preserves a directory's inode while `cp -R` does not (measured on APFS — `mv` kept
`16777234:1026769676`, the copy did not), which is what distinguishes "the project moved" from "the
project was duplicated" when both end up at a path the record doesn't know.

The same record is also the recovery path when someone deletes `.ntwine/`: a directory whose path or
inode matches a known project rejoins its board instead of silently starting a new one. Today that
deletion is advertised as safe ("you can delete `.ntwine/` and keep every thread and setting"), and
this keeps the promise true.

### Prevention: offer to ignore it, at the moment it is created

**Decided: ask.** The first-run prompt (§4) offers to add `.ntwine/` to a `.gitignore` that already
exists. That is not an opinion about the user's version control — it is Ntwine asking what to do about
Ntwine's own footprint, at the one moment the question is in front of them.

Rejected alternative: a `.ntwine/.gitignore` containing a single `*`, which makes the directory
invisible to Git and ignores *itself*, so `git add -A` cannot commit any of it (verified: clean `git
status`, `check-ignore` reports both the id and the `.gitignore` as ignored). Strictly more reliable,
and it needs no existing `.gitignore` — but it is Ntwine deciding unilaterally what belongs in
someone's repository, silently, in a file they did not write. Asking is worse mechanically and better
on the principle, and the principle is the one being defended here.

The detection rule above stands either way: a user may decline, may have no `.gitignore`, or may
commit the directory deliberately.

## 4. Root discovery without `rev-parse --show-toplevel`

Property 4 is the subtle one, and it is where a lazy implementation makes users angry: with `cwd` as
the root, `npx ntwine` in `~/proj` and in `~/proj/src` are two different boards with two different
thread histories, and nothing tells you why.

Walk up from cwd to `$HOME` (never past it, never to `/`), taking the first hit:

1. `.ntwine/ntwine.id` — an existing Ntwine project always wins (§3).
2. A repository marker: `.git`, and while we're here `.jj`, `.hg`, `.svn` (see §7).
3. A project marker: `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `deno.json`,
   `composer.json`, `Gemfile`… — the same heuristic every editor already uses to pick a workspace root.
4. Otherwise **cwd**. The readout already prints the chosen root (`project: notes — ~/notes`), which
   is the whole disclosure needed — it is a statement of what Ntwine picked, not a remark about what
   the directory is or isn't.

Two guards worth building in from the start:

- **Never adopt `$HOME` itself** as a project root. A stray `~/package.json` would otherwise turn a
  user's entire home directory into one Ntwine project, with agents dispatched at it.
- **Confirm on first use, and say what will be written.** The prompt's job is not to ask permission
  in the abstract — it is to name the directory Ntwine is about to create, at the moment it would be
  created. The maintainer's copy, verbatim:

  ```
  Ntwine writes into a .ntwine directory to store session state. 
  This directory will be created automatically and added to .gitignore.
  Continue? [Y/n] >
  ```

  Skip it with `--yes`, and never ask again once `.ntwine/ntwine.id` exists.

  **One detail to settle:** line 2 states the `.gitignore` addition as fact, but the standing rule is
  to append only to a `.gitignore` that already exists — Ntwine creating one would be Ntwine deciding the
  user should have version control, which §6 rules out. So in a directory with no `.gitignore` the
  sentence is not true as written. Either drop that sentence in that case, or create the file. The
  copy above is exact for the common case; the no-`.gitignore` variant is the human's call.

## 5. The worker prompt

`GIT_DISCIPLINE` is one element of the section array at `workerPrompt.ts:733`, so this is a swap, not
a refactor: pass the project's VCS scope into `loadWorkerPrompt` and select `GIT_DISCIPLINE` or a new
`NO_VCS_DISCIPLINE`.

The replacement block has real content, not just an absence:

- There is no commit to be your undo. Read a file before you overwrite it; prefer additive edits.
- "Landed" means the change is on disk and you have run it — there is no branch, merge, or PR ladder,
  so `done` means verified working, and never mention commits or PRs to this human.
- The `awaiting` fence keeps `human:` and `timer:`; `pr-watch:` is unavailable.

Also make `ntwineConfigBlock` and the queue's own copy stop assuming a repo — and note the FAQ already
says "Ntwine doesn't own your git workflow", which becomes true rather than aspirational.

## 6. What Ntwine deliberately does NOT do here

**Ntwine has no opinion about version control.** That is a product position, not an oversight, and it
is the one the README already makes: *"Ntwine adds no worktrees, no branches, no dev server, no build
integration, no workflow engine to fight with"* and *"Ntwine doesn't own your git workflow."* Running
outside a repository must not become the exception where Ntwine suddenly develops opinions.

So, concretely, none of these:

- **No `git init` offer.** Not a prompt, not a flag suggestion, not a hint in the readout. A user in a
  plain directory has either decided about version control or hasn't thought about it, and neither is
  Ntwine's business.
- **No warning that agents can't undo.** Nobody needs a localhost dashboard editorializing about
  their setup, and a notice nobody can action is just nagging.
- **No snapshots, no backups, no shadow anything.** See below.
- **No `.gitignore` writing** — already the standing promise, and it extends to not writing a
  `.gitignore` *inside* `.ntwine/` unless that is chosen on its own merits (§3), not as a safety measure.

The only thing that IS ours is the inverse: a worker prompt that assumes a repo when there isn't one.
`GIT_DISCIPLINE` (`workerPrompt.ts:200`) currently tells every agent to commit small and often and to
treat "landed" as a merge. Swapping it for `NO_VCS_DISCIPLINE` in a non-repo (§5) is **removing** an
opinion Ntwine holds, not adding one — which is exactly the direction this section argues for.

### Rejected: a hidden "shadow" repository

An earlier draft's headline idea was a bare repo at `~/.ntwine/projects/<id>/shadow.git`, driven with
`GIT_DIR`/`GIT_WORK_TREE` at the project, snapshotting every turn — version control the user never
sees. **Rejected, and it should stay rejected**, for reasons that outlive the opinionation argument:

- It copies the entire contents of a directory the user never offered into a store outside it. A
  `.env`, an `id_rsa`, a customer CSV sitting in a scratch folder all end up in `~/.ntwine`, and they
  **survive deleting the project**, because the shadow lives outside it. Ntwine's README promises its
  state lives outside your checkout; silently doing the reverse with your file *contents* is a
  different promise entirely.
- `GIT_DIR`/`GIT_WORK_TREE` are environment variables, and Ntwine's whole job is spawning agent
  processes that run `git`. Any leak into a worker's environment points that agent's commits at the
  shadow — or, in a directory that later becomes a real repo, silently mixes the two. That is a
  data-loss footgun, not an inconvenience.
- It grows without bound and without visibility, per turn, on a directory of unknown size.

The principle worth keeping from all of it: **Ntwine should never copy a user's files somewhere they
did not ask for, and should not become a backup system.**

### The consequence, stated plainly

An agent working in a directory with no version control can destroy work, and Ntwine will neither
prevent it nor mention it. That is the same deal a user already gets from running `claude` in that
directory themselves, which is the bar Ntwine holds itself to everywhere else: *"a thread behaves like
a Claude Code session you started yourself."* Document it once in the README's FAQ, where someone
looking for it will find it, and nowhere else.

One thing falls out of this: with the `git init` offer gone, **nothing in a plain directory wants the
`git` binary at all.** Ask (3) from the top of this document collapses into ask (2) rather than being
a separate project.

## 7. Adjacent, nearly free

Once identity is behind an interface rather than `git config`, other VCSs are a small increment, and
`jj` in particular is worth doing — jj users are disproportionately the "many agents at once" crowd
this product is for.

- **jj**: a colocated repo already has `.git`, so it works today by accident. A non-colocated one has
  only `.jj`; `jj config set --repo ntwine.id <uuid>` is the direct analogue of the git call.
- **hg / svn / fossil**: root markers for §4; identity falls through to `.ntwine/ntwine.id` (§3) like any
  other non-Git directory.

Shape: a `ProjectIdentityProvider` with `detect(dir)`, `readId`, `createId`, `scope` — the git
implementation being the existing code moved behind it, and the file implementation being the
fallback that always matches.

## 8. Suggested order

1. `NO_VCS_DISCIPLINE` in the worker prompt + honest degradation of the GitHub surface. Ships value to
   ask (1) immediately and touches no identity code.
2. Identity provider interface; move today's git code behind it unchanged (no behavior change, all
   existing tests must still pass — including the concurrent-first-run one).
3. The `.ntwine/ntwine.id` provider plus its `~/.ntwine/projects/<id>/identity.json` cross-check, and the
   walk-up root discovery with the `$HOME` guard and the first-use confirmation. Drop `git` from
   `REQUIRED_EXECUTABLES` — outright, not to a soft probe, since §6 leaves nothing that wants it.
4. One FAQ line in the README about what a plain directory does and doesn't get. Nothing in the
   product (§6).
5. jj, if anyone asks.

Steps 1-3 are the feature; there is no separate safety workstream, by design.

## 9. What this does NOT do: Git stops being REQUIRED, not used

Worth stating flatly, because "drop `git` from `REQUIRED_EXECUTABLES`" reads like more than it is.
After all of the above, Ntwine launches and runs in any directory — but on a machine that has Git, in a
directory that is a repository, **almost nothing changes**:

| | in a Git repo | in a plain directory |
| --- | --- | --- |
| Project root | `rev-parse --show-toplevel`, as today | marker walk-up (§4) |
| Identity | `git config --local ntwine.id`, as today | `.ntwine/ntwine.id` (§3) |
| Worktree = its own board | yes, via `--git-dir`/`--git-common-dir` | n/a — no worktrees |
| GitHub picker, `pr-watch:` | yes | hidden; the fence keeps `human:`/`timer:` |
| Worker prompt | `GIT_DISCIPLINE` | `NO_VCS_DISCIPLINE` (§5) |
| Undo for a bad turn | whatever the user set up | whatever the user set up — Ntwine neither supplies nor mentions one (§6) |

**Existing repo projects keep using `git config --local ntwine.id`, and do not migrate.** Using the
file everywhere would be one less code path, but it would hand every existing user a new tracked file
in a directory many of them have never ignored — reintroducing the committed-id hazard for the
largest population, where today it is structurally impossible. The provider interface exists for
exactly this; two implementations is the point, not a compromise.

So the honest summary is: **in a repository Ntwine keeps using Git exactly as it does today, and in a
plain directory it does not call Git at all.** What goes away is the hard failure — `ntwine-dev must be
run inside a Git repository` — and the assumption that a project must be a repo. What does *not*
appear is any new opinion: no offer, no warning, no fallback version control. A repo is better
because Git is better, not because Ntwine rewards you for it.

## 10. What is in `~/.ntwine`, and what could be project-local

The question this document kept provoking — *why write to the home directory at all?* — deserves the
measurements rather than an argument. Taken from this machine, 35 projects:

| | where | size | could it be project-local? |
| --- | --- | --- | --- |
| `builds/` — promoted Ntwine artifacts | `~/.ntwine` | **1.8 GB**, 59 digests | **No.** One artifact serves every project; per-project means copying the runtime 35 times |
| `ports/`, the global launch lock | `~/.ntwine` | ~0 | **No.** Port allocation coordinates ACROSS projects; that is what makes it global |
| `quota-cache/` | `~/.ntwine` | 4 KB | **No.** Keyed by provider account, not by project |
| `projects/<id>/browser-profile` | `~/.ntwine` | **1.51 GB** | Technically yes, and obviously not — that is a Chrome profile per project, in someone's source tree |
| `projects/<id>/` everything else — `ui.db`, logs, attachments, daemon records, locks | `~/.ntwine` | **27.8 MB total**, ~800 KB per project | **Yes.** This is the part a reasonable person means by "session state" |
| daemon sockets | `$TMPDIR` | — | Already neither: hashed into `$TMPDIR` because a unix socket path cannot exceed 104 bytes on macOS (`claude-broker-host.ts:29`) |

So the split is: **two large caches and one cross-project coordinator that cannot move, a Chrome
profile nobody wants in their repo, and about 800 KB per project of actual session state that
genuinely could live in `.ntwine/`.**

Worth correcting an implication from earlier in this document: socket path length is *not* an
argument for `~/.ntwine`. Sockets already live in `$TMPDIR` under a 16-hex-char hash for exactly that
reason, and the record that points at them notes "long paths are fine here". The layout question is
about size, sharing and coordination — not about paths.

### If the 800 KB moved into `.ntwine/`

For, honestly:

- The project becomes self-contained. Move it, copy it to another machine, and its threads come with
  it — the same property that made the id belong there (§3).
- No orphaned state. Today, deleting a project directory leaves its state dir behind forever; there
  are 35 of them here, and no one can say which still have a directory on the other end.
- It answers this question permanently, which has non-trivial value for a tool asking people to trust
  it with a repo.

Against:

- **A live SQLite database in a synced directory is a corruption hazard.** Dropbox, iCloud Drive and
  OneDrive do not understand WAL files, and a scratch folder is exactly the kind of place that gets
  synced. `~/.ntwine` is not.
- It inverts a promise the README currently makes — "everything durable lives outside your checkout
  … you can delete `.ntwine/` and keep every thread and setting" — and that promise is load-bearing for
  the §3 recovery rule.
- `ui.db-wal`/`ui.db-shm` churn inside a working tree, which every `git status` and every file
  watcher in the user's editor will see. The `.gitignore` offer covers Git; it does not cover the
  watcher.

**Not a decision this document needs to make.** Gitless projects work identically either way, and the
`.ntwine/ntwine.id` file (§3) is settled regardless. Recorded here so the layout question is answered
with numbers next time it comes up, rather than re-litigated.

## 11. Identity is a durable pointer, so moving it needs a migration — and one owner of the list

Added 2026-08-04, after the rebrand from fray to the product's next name shipped without carrying `git config fray.id`. The id
was never lost; the *pointer* to it was. `resolveGitProjectIdentity` found no `ntwine.id`, minted a
fresh UUID, and opened an empty board beside the real one — on all four active projects at once.

The instructive part is why it was missed. Identity is recorded in three places today, and the
migration carried two:

| location | carried by the first cut? |
| --- | --- |
| `~/.fray/projects/<id>/` — the state directory the id names | yes (global root rename) |
| `<gitdir>/fray.config` — a linked worktree's private scope | no |
| `git config --local fray.id` — the id itself | **no** |

Nobody enumerated the set. Each site was migrated by whoever happened to think of it, which is a
process that finds most of a list and never tells you which part it missed.

So the rule this document should hold any identity work to:

> **The identity provider owns an explicit, enumerable list of every location it may have written,
> and a migration hook that walks that list.** Not a comment — a value in code the migration reads,
> so that adding a storage location without adding it to the list is the thing that breaks a test.

The first version of this section drew the wrong conclusion from that — it argued the lesson raises
the value of a provider interface, and justifies keeping §9's two implementations. Backwards. **The
strongest form of "the list has one owner" is a list with one entry.** Every abstraction that lets
identity live in two stores is another pair of sites to keep in step, forever, for the benefit of a
hazard §3 can eliminate outright (see below). One store needs no interface, no `detect`, and no
migration hook — because there is nothing to enumerate.

And keep the retired key. `fray.id` was left in place deliberately; it is the only reason four boards
were recoverable at all. A migration that deletes its own source has no undo — which is also the rule
for a `git config ntwine.id` → `.ntwine/ntwine.id` move: keep reading the config key as a fallback
forever, and the one-store end state costs one careful migration rather than a permanent split.

### The rejection in §3 does not survive contact with precedent

§3 rejects a `.ntwine/.gitignore` containing `*` — which it concedes is "strictly more reliable" and
"needs no existing `.gitignore`" — on the principle that it is "Ntwine deciding unilaterally what
belongs in someone's repository." That principle is misapplied. Declaring that *your own scratch
directory is not source* is not an opinion about the user's version control, and it is the ordinary
convention: on this machine `.venv/.gitignore` (Python venv) and `.swc/.gitignore` (SWC) are both
exactly `*`, written by the tool, unremarked.

This matters far beyond tidiness, because the committed-id hazard is the *root* of the plan's
complexity. Remove it and the tree collapses: no two implementations (§9), no `identity.json`
cross-check as a mitigation, no `(dev, ino)` duplicate-vs-moved heuristic, no provider interface
(§7). jj, hg, svn and no-VCS-at-all then need no per-VCS work at all — they are the same path.

What remains is genuinely small: walk up for a root (§4, needed regardless for sub-directory
equivalence), read/write `.ntwine/ntwine.id` atomically under the existing named lock, and one
migration off `git config`.

### And then `identity.json` goes too — nothing about identity is global

The last global piece survived only to answer "what if someone deletes `.ntwine/`?", and that question
is asked by one sentence in the README FAQ: *"Everything durable lives outside your checkout in
`~/.ntwine/projects/<id>/`, so you can delete `.ntwine/` and keep every thread and setting."* Honour
that and the id cannot live solely in the project — you need a global record keyed by path and
`(dev, ino)` so an orphaned directory can rejoin its board.

**Amend the promise instead.** Once the id lives there, `.ntwine/` IS load-bearing, and a FAQ calling
it disposable is false whether or not the recovery record exists — the record only papers over it
with a guess. And the guess is genuinely ambiguous: the `mv`-preserves-inode / `cp -R`-does-not
distinction exists precisely because "moved" and "duplicated" are otherwise indistinguishable. Today
proved what a mis-resolved pointer costs; the fix is pointers that do not get lost, not heuristics
that reconstruct them.

Nothing is destroyed by the change: delete `.ntwine/` and the threads are still in
`~/.ntwine/projects/<id>/`, the directory has just forgotten which board is its. Nobody expects
`rm -rf .git` to be a no-op. The honest sentence is that `.ntwine/` holds the scratchpads and the
project's id, the heavy state still lives outside the checkout, and deleting it starts a fresh board.

One clause of the FAQ gets *better*: "Ntwine does not touch your `.gitignore`, so add `.ntwine/`
yourself" stops being needed, because `.ntwine/.gitignore` self-ignores. Note that promise was never
in tension with it — the file goes inside Ntwine's own directory, not in the user's `.gitignore`.

End state: **no global identity state at all.** `~/.ntwine/projects/<id>/` remains where the heavy
state lives, but it is keyed BY the id, never a source of truth ABOUT it.

## Open questions for the human

None outstanding — §3 (identity), §4 (root discovery and the first-run prompt) and §6 (no opinions)
are all settled. The next move is step 1 of §8, which is independent of everything else here.
