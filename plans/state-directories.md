# Where ntwine's global state lives

Spec, 2026-08-01. `~/.ntwine` is not idiomatic; honor XDG where it is defined, write to the right place
on Windows, and fall back to `~/.ntwine`. Downstream of [`gitless-projects.md`](gitless-projects.md)
§10, which measured what is actually stored.

## The rule

Two phases, and the order matters: **detect first, then decide.**

**Phase 1 — detect an existing installation.** Probe every candidate root, in this precedence, and
take the first that already exists on disk:

1. `~/.ntwine` — the legacy location, and the one an upgrading user's live state is actually in.
2. `$XDG_DATA_HOME/ntwine`, when that variable is set.
3. `%LOCALAPPDATA%\ntwine` on Windows.
4. The OS-native default for the platform (`~/.local/share/ntwine`, and see §macOS).

Whichever is found is used verbatim, unchanged, forever. Probing several places costs a few `stat`
calls once per launch and buys exact backwards compatibility — including for someone who already
moved their state by hand. If more than one exists, the order above decides, and the launcher logs
which root it picked so a split installation is diagnosable rather than mysterious.

**Phase 2 — a fresh install picks the idiomatic location.** Only when *no* candidate exists does
ntwine create one, and then it uses the most idiomatic place available:

1. **The XDG variables, each honored individually when SET** — `$XDG_DATA_HOME`, `$XDG_STATE_HOME`,
   `$XDG_CACHE_HOME`, `$XDG_RUNTIME_DIR`, each `+ /ntwine`. A user who defines only `XDG_CACHE_HOME`
   gets the cache relocated and nothing else.
2. **`%LOCALAPPDATA%\ntwine` on Windows** — see below. Windows never falls through to a dotfile.
3. **`~/.ntwine`** otherwise, with today's layout unchanged.

So the only user who ever sees a new path is one who has never run ntwine, which is exactly the
population for whom no compatibility is owed.

## Why split at all: the sizes make the case

From a real machine with 35 projects (measured in the gitless plan, §10):

| content | today | size | XDG role |
| --- | --- | --- | --- |
| `builds/` — promoted artifacts | `~/.ntwine/builds` | **1.8 GB** | **cache** — regenerable from source, deduped by digest |
| `projects/<id>/browser-profile` | `~/.ntwine/projects` | **1.51 GB** | **cache** — a Chrome profile, rebuilt on demand |
| `quota-cache/` | `~/.ntwine/quota-cache` | 4 KB | **cache** — it says so |
| `projects/<id>/ui.db`, attachments, identity | `~/.ntwine/projects` | **27.8 MB total** | **data** — the threads. Losing this loses the product |
| logs, `launcher.json`, locks, owner files | `~/.ntwine/projects` | small | **state** |
| daemon sockets | `$TMPDIR` (hashed) | — | **runtime** — already correct; see below |

**3.3 of the 3.4 GB is regenerable.** That is the whole argument: with the split, `rm -rf
~/.cache/ntwine` frees 3.3 GB and costs nothing but a rebuild, backup tools skip it by default, and the
27.8 MB that actually matters sits in `~/.local/share/ntwine` where a backup will find it. Under
`~/.ntwine` those three populations are indistinguishable, which is why the directory grows to gigabytes
and nobody dares delete it.

## Mapping

```
data    $XDG_DATA_HOME/ntwine      ~/.local/share/ntwine    projects/<id>/{ui.db,attachments,identity.json}
state   $XDG_STATE_HOME/ntwine     ~/.local/state/ntwine    projects/<id>/{logs,launcher.json,*.lock,*.owner}
cache   $XDG_CACHE_HOME/ntwine     ~/.cache/ntwine          builds/, projects/<id>/browser-profile, quota-cache/
runtime $XDG_RUNTIME_DIR/ntwine    $TMPDIR                sockets, port reservations
```

`XDG_STATE_HOME` is part of the spec as of 0.8 and is the correct home for logs — they are neither
precious enough for `data` nor regenerable enough for `cache`.

Note the project id stays the directory name under each root, so `<root>/projects/<id>/` is the shape
in all three. Nothing about identity (`gitless-projects.md` §3) changes.

### Windows

Never Roaming — a 1.8 GB build cache must not follow a user between machines, and roaming profiles
choke on exactly this.

```
data     %LOCALAPPDATA%\ntwine\Data
state    %LOCALAPPDATA%\ntwine\State        (or \Logs for the log subtree, matching convention)
cache    %LOCALAPPDATA%\ntwine\Cache
runtime  named pipes — already correct (claude-broker-host.ts:31)
```

`%APPDATA%` (Roaming) gets nothing. If `%LOCALAPPDATA%` is somehow unset, fall back to
`%USERPROFILE%\AppData\Local\ntwine`, and only then to `~/.ntwine`. There is precedent for reading it:
`src/browser.ts:131` already resolves Chrome through `LOCALAPPDATA`.

### macOS

The strictly idiomatic answer is `~/Library/Application Support/ntwine` and `~/Library/Caches/ntwine`.
This spec deliberately does **not** use it: the rule is XDG-if-set, then `~/.ntwine`, and that matches
what every tool in this product's neighbourhood does — `~/.claude`, `~/.codex`, `~/.gitconfig`. A
macOS user who has set `XDG_*` (many developers do) gets XDG; everyone else keeps `~/.ntwine`.

### Sockets are already right

`claude-broker-host.ts:29` hashes the socket path into `$TMPDIR` — not because of tidiness but because
a unix socket path cannot exceed 104 bytes on macOS. `$XDG_RUNTIME_DIR` is the correct root where it
is defined (Linux), and it is short enough. Everywhere else `$TMPDIR` stays. This subtree is the one
part of the layout that needs no change.

## Migration: none, deliberately

**An existing `~/.ntwine` keeps winning, permanently.** Not a deprecation window, not a nag.

Automatically relocating gigabytes of live state — while agents are running against it, with detached
daemons holding open file descriptors into it — is a class of change that goes wrong once and is
unrecoverable. The 27.8 MB of real data has no backup anywhere else. And a partial move (interrupted
by a laptop lid) leaves a project whose database and logs are on opposite sides of the boundary.

So: new installs get the new layout; existing installs never move. A user who wants to migrate can do
it themselves while ntwine is stopped — `mv ~/.ntwine ~/.local/share/ntwine` and so on — and rule 1 stops
applying the moment `~/.ntwine` is gone. Document that in the FAQ; do not automate it.

The cost is that existing users never benefit, which is acceptable because the benefit is
housekeeping, not function.

## Implementation

`~/.ntwine` is hardcoded at **64 sites across ~14 source files** (plus ~28 dev scripts) — `project.ts`,
`launcher.ts`, `artifacts.ts`, `logging.ts`, `project-identity.ts`, `stable-plugin-path.ts`,
`claude-quota.ts`, and others. There is no existing helper.

1. One module — `ntwinePaths({ env, platform, home })` returning `{ data, state, cache, runtime }`,
   pure and fully injectable, so the whole matrix (XDG set / unset, win32, legacy present / absent)
   is table-testable without touching a filesystem.
2. Replace the call sites mechanically. Most read `join(home, ".ntwine", "projects", id)` and become
   `join(paths.data, "projects", id)`; the split is only interesting for `builds/` (cache), the log
   root (state), and `quota-cache` (cache).
3. `ProjectLaunchTarget.stateDir` is threaded through the server, the launcher and every daemon
   already, so per-project consumers mostly do not change — but note it currently means "one directory
   holding everything for this project", and the split makes that three. Either widen the target to
   carry all three roots, or keep `stateDir` as the data root and derive the others beside it. The
   second is smaller and keeps every existing signature.
4. Dev scripts can keep hardcoding `~/.ntwine` until the module exists, then import it.

## Open

- **Linux with `XDG_DATA_HOME` unset.** Strict XDG says use the `~/.local/share` default
  unconditionally; this spec only honors the variable when it is SET, so an ordinary Linux user stays
  on `~/.ntwine`. That is the conservative reading of "XDG if it is defined" and it means Linux mostly
  does not change. Worth confirming that is intended, since it is the platform where XDG is the norm
  rather than an opt-in.
