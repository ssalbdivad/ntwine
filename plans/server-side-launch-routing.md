# Launch routing belongs to the server: one request, one fixed host, one more shell release

Design plan, 2026-10-11. Prompted by two `frizz` shell releases in one day that changed nothing but where a launch lands (0.13.10 and 0.13.11, which npm then served out of order), and by the maintainer's question that day: *"why did we need to bump Frizz in the first place. The whole point is that we don't need to bump Frizz very often, and we can just bump Frizz server."* Status: **BUILT on `main`.** §8 says what landed and what each release carries: `frizz-server` 0.15.23 and `frizz` 0.13.13 carry items 1–3, 5 and 6; item 4 waits for the next `frizz-server` release.

**Verdict: stop deciding anything about projects in the shell.** The shell keeps the machinery that has to work while the server is down: the supervisor, the public listener, the sign-in gate, the terminal readout, the installer. Everything that is a rule about folders moves to the server: which folder a launch is about, whether it is a project, whether to register it, and where the browser lands. Two changes do that, and they only work together:

1. **The shell asks the running server where to land** (`POST /_frizz/control/launch`), instead of working it out.
2. **The shell always starts the server on Frizz's own folder**, never on the folder the command was typed in, so it needs no rule about folders before a server exists to ask.

Both ride in ONE shell release. After it, a change to launch behaviour is a `frizz-server` release, which npm serves in minutes, not a shell release, which npm has held for 1h, 3.4h, 15h and 9h this week.

---

## 1. What has been forcing shell releases

Every shell release since 2026-10-01, and the launcher commits that made each one necessary (`git log <previous>..<release> -- src`, tests excluded):

| Shell | What forced it | A rule about folders? |
| --- | --- | --- |
| 0.13.7 | `R` after a restart, the sign-in screens, the QR glyphs | no, terminal readout |
| 0.13.8 | custom frizz.sh names through a GitHub device flow | no, tunnel sign-in |
| 0.13.9 | refuse a world-writable folder as a project; 30-day sessions | **partly** |
| 0.13.10 | the first `frizz` on a machine opens the folder it was run in | **yes, entirely** |
| 0.13.11 | a folder that is not a project opens the dashboard; revert of 0.13.10 | **yes, entirely** |
| 0.13.12 | nothing; re-cut so `latest` followed the out-of-order 0.13.10 | no |
| 0.13.13 | never borrow a project to run on; deleted launch folder; update errors | **partly** |
| next | a world-writable folder can be a project again (`7ff10189`, already on `main`) | **yes** |

Four of seven, and the next one too. The reason is mechanical: the shell bundle (`dist/frizz.js`) contains its own copy of the registry and project-root code from `packages/server/src`, so a rule changed there reaches a running server through a server release and reaches the launch path only through a shell release. `7ff10189` is the clean example. It edits `packages/server/src/project-root.ts` and is still inert for `npx frizz` in a folder until a shell ships.

## 2. What the shell decides today

All of it in [`src/launcher.ts`](../src/launcher.ts) and [`src/production.ts`](../src/production.ts), as of `a2a498dd`:

| Decision | Where | Needed before a server exists? |
| --- | --- | --- |
| Which folder is the launch about (Git top level, marker walk-up, worktree identity) | `resolveWorkspace`, `discoverProjectRoot` | only to pick the host |
| Is it a project Frizz knows, an offer, or nothing (`open` / `offer` / `grid`) | `resolveLaunchIntent` | only to pick the host |
| Which folder the server runs on: the project for `open`, Frizz's own folder otherwise | `resolveLaunchIntent`, `hostWorkspace` | **yes** |
| Register the project and mint its URL name | `ownSlug` → `registerProject` | no |
| The landing URL: `/project/<name>`, `/`, or `/?add=<folder>` | `slugPath` | no |

The third row is why the first two cannot simply move. On a cold start there is no server to ask, and the shell must already have classified the folder to choose what to run the server on. That is also the row behind today's incident: the server was run on a user's folder, the folder was deleted, and every restart and update on the machine failed with it.

## 3. The design

**Mechanism in the shell, rules in the server.** The shell knows how to start, supervise, expose and update a server. It does not know what a project is.

- A cold start runs the server on Frizz's own folder (`<data>/host`, which `a2a498dd` already uses for every launch outside a project), waits for it to be healthy, then asks it where to land.
- A second launch, which finds a server already running, asks the same question and exits.
- The server answers from the registry, with the same code that serves the dashboard's "add a folder".

The alternative the maintainer raised, moving the whole launcher into `frizz-server`, is rejected in §9.

## 4. The request

`POST /_frizz/control/launch` on the **server child**, not on the supervisor. The supervisor's routes run in the launcher process and ship with the shell, which is the thing being avoided. It is answered before tenant routing, as `/_frizz/<name>/health` already is, so asking never opens a project.

```
POST /_frizz/control/launch
x-frizz-launch-token: <owner token>
{ "protocol": 1, "dir": "/Users/me/code/app/packages/web", "args": [] }

200 { "protocol": 1, "path": "/project/app", "project": { "name": "app", "dir": "/Users/me/code/app" } }
200 { "protocol": 1, "path": "/?add=%2FUsers%2Fme%2Fscratch", "notice": "…" }
200 { "protocol": 1, "path": "/" }
```

- **`dir`** is the folder the command was typed in, untouched. The server does the walk-up, the Git lookup and the worktree identity. **`args`** is in the request shape for positional arguments, and the launcher sends none: it still refuses a positional argument by name ("Frizz takes no repository path"), and forwarding one silently would trade a clear error for nothing. Sending them is a one-line shell change for the day a server reads them.
- **`path`** is opaque to the shell, which appends it to the origin it already holds. The shell accepts only a path that starts with a single `/`, so no answer can send the browser to another origin. **`project`** feeds the readout's "Project" row; **`notice`** is one line to print.
- **Who may ask.** The server refuses any request without an `Origin` header except a short list ([`app.ts`](../packages/server/src/app.ts)); this route joins that list and is gated the way `/control/stop` is, by a token only the same OS user can read. For `npx frizz` that is the machine-wide owner token in `<state>/frizz-server/address.json`, which the server child already receives (`FRIZZ_SERVER_OWNERSHIP`, [`dev-child.ts`](../packages/server/src/dev-child.ts)) and now keeps. `frizz-dev` holds no machine-wide lease and sends the hosting folder's launch token, which is what `/control/stop` checks today.
- **What it may do.** Exactly what the shell does today in the same folder as the same user: run `git rev-parse` there, write `.frizz/.id`, add a registry entry. Nothing new is reachable.
- **One registration rule.** There were two launch-side copies: the launcher's (`resolveLaunchIntent`, `resolveWorkspace`) and the server's own resolver for the project it is started on (`resolveProject`). The route classifies with [`classifyLaunch`](../packages/server/src/launch-routing.ts), which the launcher's fallback now imports, and opens with `resolveProject`, which also re-mints the id of a copied checkout — something the launcher left undone. The dashboard's add ([`addProjectAtPath`](../packages/server/src/router.ts)) is deliberately different: a folder someone picked is that folder, not the repository above it.

**When the server cannot answer**, the shell uses the rules it carries today, frozen: a server that predates the route (403 or 404), a child that is restarting (503; the public address is published before the child is ready, so the shell retries for a few seconds first), or a timeout. That fallback is never edited again, only deleted one day.

## 5. Why the fixed host is not optional

The request alone moves the landing and the registration, but not the classification, because a cold start would still classify the folder to choose what to run the server on. Cold starts are most launches. A rule changed in the server would then disagree with the shell's frozen copy at exactly the moment it mattered: the server would be running on a folder its own rules no longer accept. (An earlier message on this thread said the request alone would have turned 0.13.10 and 0.13.11 into server releases. It would not have; both changed which folder the server runs on.)

With the host fixed, the cold start needs no rule at all, and it also removes a mode rather than adding one. After 0.13.13 there are two ways a server runs: on a user's project, and on Frizz's own folder. This deletes the first. The second is the one every launch outside a project already exercises.

What it fixes beyond release cadence:

- **A deleted, moved or unmounted launch folder can no longer break the machine's board.** Today (`755018d6`) Restart and Update are refused once the folder is gone, and the board must be stopped and started again.
- **Remote sign-ins stop depending on where the command was typed.** The session key, the signed-in device list and the session epoch live in the hosting folder's state folder (`loadSessionState(workspace.stateDir)`), so starting Frizz from a different project is a different key.
- **One remembered port, one place for launcher logs, one `--app` window profile**, instead of one per folder Frizz was ever started from.

## 6. What moves when the host is fixed

| Keyed on the hosting folder today | After |
| --- | --- |
| The launch owner record that `--stop` and `--status` read | Always the stand-in's. They read it directly, and keep today's port probe for a board an older shell started on a project. |
| Session key, device list, session epoch | The stand-in's. **Carried over once**, from the project state folder a device most recently signed in to, so no remote device is signed out by the move (`adoptSessionState`). Only into a stand-in that has no key of its own. |
| Preferred port, launcher logs, `--app` browser profile | The stand-in's. Not carried over: the default port is the usual answer, and the window profile resets once. |
| The server child's working directory (the supervisor requires it to equal the hosting folder) | A folder Frizz owns and nobody deletes. |
| "Another process is already serving this project" ([`servedByAnotherProcess`](../packages/server/src/project-launch.ts)) | The serving record, below, for every project a server opens. |
| Registry recovery after a lost `registry.json` (`backfillRegistry` reads the folder from three files a launch writes) | The serving record names the folder of every project a server opened, and keeps it after the server closes it, so recovery reads it first. The three launch files only ever covered folders Frizz was started on. |
| The unprefixed API (`/_frizz/rpc/…` with no project name) | Answers for the stand-in, an empty board, as it already does for every launch outside a project. |

**`frizz-dev` is not changed.** It runs from a checkout and has no release to wait for, so it keeps running its server on the project it is typed in. Under one home it and an installed Frizz share `<data>/host` for a launch outside a project (since `a2a498dd`): whichever starts second joins the first.

**Two servers on one project: refused, naming the other server** (the maintainer's decision, 2026-10-11). The double-serve check ([`servedByAnotherProcess`](../packages/server/src/project-launch.ts)) reads a project's launch owner record, and only the folder a server runs on has one. So it protected exactly one folder per server. A project the installed Frizz opened as one of many took nothing, and `frizz-dev` typed in it started a second server that scheduled the same timers and recurring prompts. With a fixed host that would be true of every project, where it used to be every project but one.

So a server writes a **serving record** ([`project-serving.ts`](../packages/server/src/project-serving.ts), `serving.json` in the project's state folder) when it opens a project: its process identity and the folder. It refuses a project whose record names another live process, with the existing message, *"kirby is already being served by another Frizz (pid 66482). Stop that one first"*. On close it drops itself from the record and keeps the folder, which is what registry recovery reads. Where the refusal lands:

- **A server opening a project as one of many** (a board request, the background priming pass): the project does not open, and the request answers 404 as for any project that will not open.
- **A launch that asks for it** (`POST /_frizz/control/launch`): it lands on the dashboard with the refusal as its notice.
- **A server booting on it**: the boot fails in its "launch ownership" phase, before it opens the database. The record alone counts there: under a supervisor the project's launch lease is the supervisor's own.
- **`frizz-dev` typed in it**: refused once it holds the project's launch lease, before any build or boot. So a `frizz-dev` of the same project that is still starting is joined, not refused.

A record whose process has exited, or whose pid now belongs to another process, never blocks. The supervisor never runs two server processes at once, so a restart or an update never meets its own predecessor's claim. Running `frizz-dev` on a project the installed Frizz has open now needs that Frizz stopped, or a separate home folder.

## 7. A shell newer than the installed server

This is normal, not an edge case. `npx frizz` fetches the newest shell on every run, and the server only moves when someone clicks Update: `ServerReleaseStore.load()` boots the selected server and never looks at the shell's pin unless the data epoch changed. The maintainer's own board was shell 0.13.11 on server 0.15.18 this morning.

**It already bites.** Shell 0.13.13 runs every launch outside a project on `<data>/host`. The server learned to keep that folder off the dashboard in 0.15.21 (`49000c91`). A server at 0.15.20 or older has no such refusal and re-registers every state folder at boot, so it lists the stand-in as a project named "host"; the entry outlived an update, because the refusal was at registration and nothing filtered the list. Reproduced 2026-10-11 with the published `frizz-server` 0.15.20 under a shell built from `main`: the dashboard's project list held `<data>/host` (the last scenario of [`scripts/verify-server-updates.mjs`](../scripts/verify-server-updates.mjs)).

**The rule: a shell declares the oldest server it works with, and installs its pinned one when the installed server is older.**

- `frizzServer.minimum` in the shell's manifest, beside `version`. Absent means no floor, which keeps every shell so far unchanged.
- At a cold start, a selected server below the floor is replaced by the pinned one through the path a new machine and a data-epoch change already take (`prepareInitial`): staged, validated, booted, and recorded as the selection only after it comes up. If it does not come up, the old selection is still on disk and the launch fails the way a new machine's would; the next launch tries the pinned release again.
- Never while a server is running. A second launch joins whatever is there and falls back per §4.
- If npm cannot be reached, the launch fails with that reason, as a new machine's does. A shell newer than its server came from npm seconds earlier, so this is a narrow case.

The cost is that starting Frizz can replace the server without a click on Update. It only ever moves it up, to the exact version the shell was released against, at a moment nothing is running. The floor is also what keeps §4 and §6 honest: the shell that fixes the host is never paired with a server that lacks the route, the serving record or the list filter.

## 8. Order of work

Server work first, because it ships in minutes and is inert until a shell asks for it. Then one shell release.

| # | Change | Ships in | State |
| --- | --- | --- | --- |
| 1 | The floor: `frizzServer.minimum`, raised at cold start | shell | **done**, on `main`; first floor is 0.15.21 |
| 2 | Keep the stand-in off the project list even when an older server registered it, and drop the entry | server | **done**, on `main` |
| 3 | The launch-routing module (classification, registration, landing) in the server package; `POST /_frizz/control/launch` | server | **done**, on `main` |
| 4 | The serving record: written on open, checked before opening, read by registry recovery | server, and `frizz-dev` from the checkout | **done**, on `main`; not in `frizz-server` 0.15.23 |
| 5 | Always host on the stand-in; carry the session state over; `--stop`, `--status`, `--link` and `--sessions` find the machine's board from any folder | shell | **done**, on `main` |
| 6 | Ask the server where to land; freeze today's rules as the fallback; stop registering from the shell | shell | **done**, on `main` |

Item 1 is useful alone and is the fix for §7. Items 5 and 6 work against any server from 0.15.21: one without the route gets the fallback, which is today's behaviour. **To release:** cut a `frizz-server` release carrying items 2 and 3, then a shell release whose `frizzServer.version` is that server. Raising `minimum` to it as well is what makes every launch use the server's rules rather than the fallback, at the cost that a relaunch then installs that server on machines below it.

## 9. Not doing

- **Moving the whole launcher into `frizz-server`.** The launcher is what replaces a broken server and what stays up while one restarts. Inside the server package it would be replaced by the thing it supervises, with no older copy to fall back to; a first boot would still need a pinned launcher in the shell; and a launcher fix would reach `npx frizz` users later than it does now, since the shell is fetched on every run and the server only on Update. It is also the least tested code in the repository to rewrite for a problem that §1 shows is mostly about folder rules.
- **Answering on a supervisor route.** It runs in the launcher process, so it ships with the shell.
- **A capability list instead of a floor.** The fallback in §4 is already per-request negotiation. A floor is one number, and it removes old pairings from the test matrix rather than adding branches for them.

## 10. Verification

On real built artifacts, in [`scripts/verify-server-updates.mjs`](../scripts/verify-server-updates.mjs), which already drives a packed shell and server against a fixture registry:

| # | Check | Where it is proven |
| --- | --- | --- |
| 1 | An installed server below the floor is replaced before boot, and the stand-in is not on the project list. Control: without the floor, the "host" entry appears. | harness, against the published 0.15.20 |
| 2 | `frizz` in a known project lands on `/project/<name>`; the server runs on the stand-in; the server wrote the registry entry. | harness |
| 3 | `frizz` in an unmarked folder lands on `/`; a marked one Frizz has not seen is offered at `/?add=`. | harness for `/`; unit for the offer |
| 4 | A second `frizz` in another project joins and lands on that project. | harness; the 503 wait is unit-tested |
| 5 | Against a server that predates the route, a launch in a project lands where it does today. | harness, against the published 0.15.20 |
| 6 | Deleting the folder the command was typed in leaves Restart and Update working. | harness |
| 7 | A device signed in before the move is still signed in after it. | harness: the first launch leaves the stand-in holding the same key bytes an earlier host held; unit for which folder is chosen (`adoptSessionState`). No signed-in browser is driven through the move |
| 8 | Two servers under one home never both open one project. | a disposable Frizz: a project another live process holds is refused as a board and as a launch, and opens once that process is gone; `frizz-dev` typed in a project the Frizz has open refuses, naming its pid, and leaves no lease. Unit, plus a real second process against a real boot, in `project-serving.test.ts` |

Plus unit coverage where each rule lives: the route's token and origin handling in `app.test.ts`, the classification table in `launch-routing.test.ts`, the floor in [`src/server-release.test.ts`](../src/server-release.test.ts), asking and falling back in [`src/launcher.test.ts`](../src/launcher.test.ts).
