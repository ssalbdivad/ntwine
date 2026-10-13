---
name: frizz-stack
description: Boot a REAL, fully-isolated, disposable Frizz you can poke — `scripts/adhoc-stack.mjs` (own server, sandbox HOME, throwaway port, one or many projects) — and seed real state through its own RPC surface. LOAD THIS BEFORE HAND-ROLLING ANY VERIFICATION HARNESS: the sandbox HOME, real credentials, extra registered projects, the launcher's lock path and every tenant's id/slug are already flags, and rebuilding them by hand costs a boot cycle per mistake. Use it whenever the question is "does this actually work in a running Frizz" — a new surface, live/timing/restart behavior, a seam between processes, a bug no test pins — and above all anything touching the SINGLETON: one Frizz serving N projects, tenant routing (`/_frizz/<project>/rpc/…`), a project the server did NOT launch from, dispatching a real worker, or the Frizz MCP worker tools (`spawn_thread`, `recurring_prompt`, `timer`). Pair with `headless-browser` to LOOK at it and `real-subsystem-harness` for what a browser cannot reach.
version: 0.1.0
metadata:
  internal: true
---

# frizz-stack — a real Frizz that touches nothing real

A throwaway instance, sandboxed on every axis, so you can verify against the running thing instead of
reasoning about it. Booting it is cheap; being wrong in front of the maintainer is not.

**It is not a tax on every diff.** A targeted fix in code you have read, pinned by a test at the right
level and with a blast radius you can name, is verified without a stack — say what you verified and how,
and move on. Judge which one you have; both directions are real failures.

---

## 1. Boot it

`scripts/adhoc-stack.mjs` sandboxes every axis so it can never touch the maintainer's live instance or
real `~/.frizz` SQLite:

- `HOME` → a fresh temp dir (the SQLite DB + `server.lock` live in an empty `~/.frizz` there)
- `PORT` → a unique high port (never fights the dev server on 5175)
- `FRIZZ_WAKERS_OFF=1` → scheduler OFF by default; pass `--wakers` to arm it when testing wake delivery
- the orphan reaper OFF by default, so a disposable stack never reaps the real machine's processes
- tenant priming OFF by default (`FRIZZ_TENANT_PRIME_OFF=1`), so a stack run with `--home=$HOME` never puts a second tailer on the maintainer's live boards; pass `--prime` to arm it under a sandbox HOME

Boot it in the **background** (never foreground — it stays up until killed) and read back its json line:

```bash
nub scripts/adhoc-stack.mjs --port=4930 > /tmp/stack.log 2>&1     # Bash run_in_background: true
# → {"url","gridUrl","slug","port","home","project","launcher":{id,slug,serverLock},"tenants":[…]}
```

`url` is the launcher's drawer prefix, `/all/<slug>`: append `/thread/<t>` for that thread's drawer over
the one page, or `/thread/<t>/full` for its fullscreen page. A bare `url` lands on `/all`, All projects,
which `gridUrl` names directly. A project's BOARD (the page focused on it, the default view) is
`/project/<slug>`, and its threads `/project/<slug>/thread/<t>` (a queued one lands on its card,
anything else opens its drawer). A bare `/` is neither: it goes to the view this browser showed last,
and in a fresh headless profile that is a project's board — so name the view you mean.

**Never pipe it through `head`/`sed`/`grep` to read that line.** The stack keeps logging (every Vite HMR
update, and the shared tree is edited constantly), so the reader exits, the pipe closes, and the next
write kills the server with SIGPIPE — minutes later, mid-verification, looking like an unrelated crash.
Redirect to a file and poll the file.

Flags: `--port=N`, `--project=/abs/dir` (defaults to the frizz repo), `--also-project=/abs/dir`
(repeatable — see §2), `--creds` (real credentials, needed for a real dispatch), `--wakers`, `--reaper`,
`--prime`, `--keep`, `--home=/abs`, `--seed`.

`--home=/abs` reuses a sandbox a previous `--keep` run left behind, which is the only way to verify
anything that happens at BOOT against state that already exists — a schema migration, a registry repair,
resume/recovery. It implies `--keep`: a HOME you were handed is never one this run may delete.

**Cleanup:** send SIGTERM/SIGINT — it deletes the temp HOME automatically. Always kill it before you come
to rest; never rest on a running stack. Kill by the **exact PID** you started, never a broad `pkill`:
other agents run stacks on this machine at the same time.

**A SERVER change needs a RESTART; only the web hot-reloads.** Vite HMR covers `packages/web`, so a
component edit is live on the next reload — but the server modules (`transcript.ts`, the tailer, the RPC
router) were loaded once at boot, so an edit there is invisible until you restart the stack. The failure
is silent and reads as "my fix didn't work": the page renders the OLD projection and your assertion fails
against code you already corrected. If a server-side assertion fails and the code plainly says otherwise,
restart before debugging.

---

## 2. TWO projects on one server — the singleton half most bugs hide in

One Frizz serves N projects, so "it works" in the LAUNCHING project proves almost nothing about the
others. A whole class of defect exists only in a *tenant* — a project the server did not launch from —
because the launcher is the one that gets the `server.lock`, the unprefixed routes and the boot-time
context. That is exactly where the Frizz MCP tools broke (2026-08-08: every worker outside the launching
project lost `spawn_thread`, `recurring_prompt` and `timer`, because it was reading a lock that only the
launcher publishes, and POSTing an unprefixed RPC that means "the launching project" by definition).

```bash
# a launcher + one tenant, with REAL credentials so a dispatched worker can actually start
nub scripts/adhoc-stack.mjs --port=45571 --project=/abs/launcher --also-project=/abs/tenant --creds \
  > /tmp/stack.log 2>&1
# → …"launcher":{"id","slug","serverLock"},"tenants":[{"id","slug","dir","stateDir"}]
```

Then address a tenant by **id or slug** — both work, and the id is what a worker is stamped with:

```bash
curl -s -H 'sec-fetch-site: same-origin' "http://127.0.0.1:45571/_frizz/<tenant-id>/rpc/board"
```

**In a browser, every project is on ONE page, `/all`** (All projects), and one project's board is
`/project/<slug>` (the switcher over the prompt box goes there too). Never aim at a bare `/`: it
redirects to the browser's last view, a board in a fresh profile. A tenant's thread is
`http://127.0.0.1:45571/all/<tenant-slug>/thread/<t>` on All projects, or
`/project/<tenant-slug>/thread/<t>` on its board. `…/thread/<t>/full` is its fullscreen page.
`scripts/verify-all-queues.mjs` is a worked example of driving the page across four projects.

The traps, each of which costs a full boot cycle to rediscover:

- **RPC verbs are HTTP verbs.** A `query` is a GET and a `mutation` is a POST; POSTing a query answers
  `unknown RPC procedure` — which reads exactly like a version mismatch and sends you hunting the wrong bug.
- **An unprefixed `/_frizz/rpc/…` is the LAUNCHING project**, silently. That is the correct design, and it
  is why a tenant bug looks like "it worked" — your call landed on the launcher's board. An UNKNOWN project
  segment 404s instead, which is the safe direction; check for the 404 before assuming your id is wrong.
- **The broker is the SOLE claude transport.** The interactive-TUI path is retired, so `FRIZZ_CLAUDE_BROKER_BRIDGE=0`
  does not "fall back" — dispatch fails outright with *"Claude session broker is unavailable"*. You cannot
  capture a worker's argv with a stub `claude`; to see the env a worker really gets, dispatch a real one and
  read it off the process table (`ps -Ao pid,command | grep FRIZZ_PROJECT_ID`).
- **A sandbox HOME has no credentials**, so a real dispatch needs `--creds`.
- **`startServer({port: 0})` does not give you an ephemeral port** — pick a real high port.
- **A dispatched worker is a DETACHED daemon.** It survives the stack it was born in and keeps burning
  quota. `ps -Ao pid,command | grep <your temp HOME>` → `kill <pid>` each, then re-check none survive.

---

## 3. Seeding real state

An empty board proves the shell renders but not much else. Drive the app's own RPC surface or the UI
itself so state is created the way production creates it — never hand-write rows into the sandbox SQLite.

**Use `scripts/lib/rpc-client.mjs`. Never hand-roll `fetch` against `/rpc`.** Two details are easy to get
wrong, and both fail SILENTLY — a plausible wrong answer instead of an error, which is how a harness ends
up "proving" something it never tested:

- **queries are `GET /rpc/<name>?input=<json>`, mutations are `POST /rpc/<name>`.** POSTing a query does
  not throw; it 404s, and reads back as "no data" (this is what made a verify run report an empty board).
- **every response is `{result}` or `{error}` — never the payload bare.** Reading `body.slug` off the
  envelope yields `undefined` for a call that actually SUCCEEDED.

```js
import { createRpcClient } from "./lib/rpc-client.mjs"
const api = createRpcClient(`http://127.0.0.1:${port}/`)
await api.waitForHealth()
const { slug, sessionId } = await api.mutate("dispatch", { prompt: "…", backend: "codex" })
const board = await api.query("board")            // unwrapped result; throws RpcError on {error}
```

The client also sets the loopback `Origin` header, without which any write 403s.

### A real Claude worker

`--creds` symlinks the real `~/.claude*` into the sandbox, which is what a dispatch needs. The older
workaround — keep the real HOME and isolate only the PROJECT (`--home=$HOME --project=/tmp/<throwaway>`)
— still works and is the one to use when you need the real keychain path exercised. Either way: HOME's
keychain is why a bare temp HOME fails `AUTH_REQUIRED:claude` (the macOS login keychain lives at
`$HOME/Library/Keychains`, so redirecting HOME hides the credential even though it is user-scoped).

**The same redirect puts a modal dialog on the maintainer's screen.** A process in a sandbox HOME that starts a Chromium without `--use-mock-keychain` — it was the real `/Applications/Google Chrome.app`, which no agent starts at all any more (AGENTS.md § Agents never touch the maintainer's real Chrome) — makes Chrome store its "Chrome Safe Storage" key, macOS finds no default keychain under that HOME, and the system shows *"Keychain Not Found — A keychain cannot be found to store "Chrome.""* for every Chrome start. Headless `--screenshot` Chrome also often hangs at exit on its own, so a worker kills and restarts it, and every restart opens another dialog (2026-10-03: two harness runs, 13 SecurityAgent processes, maintainer: *"It's shown up hundreds of times"*). Chrome that puppeteer launches is immune, because puppeteer passes `--use-mock-keychain --password-store=basic`. So a worker's browser comes from `launchHeadless()` (`scripts/lib/headless-browser.mjs`), every raw headless-shell command a sandbox worker runs carries `--use-mock-keychain`, and when your prompt asks a worker for a browser, the launcher or the flag goes in the prompt you hand it. The sandbox HOME itself stays WITHOUT a keychain: the maintainer declined linking the real `~/Library/Keychains` in (2026-10-03), and an empty keychain there is worse, because Claude Code deletes the real `~/.claude/.credentials.json` after its first token write into one. `log show --last 3h --style compact --predicate 'process == "SecurityAgent"'` tells you whether a dialog fired.

Clean up after yourself: kill the stack by exact PID, kill the leftover `claude` broker processes (find
them by their `FRIZZ_STATE_DIR=<that project id>` in `ps`), then
`rm -rf ~/.frizz/projects/<id> <throwaway-repo> ~/.claude/projects/<cwd-slug>`. Do NOT write settings
through a real-HOME stack — `~/.frizz/ui.db` settings are global and shared with the real boards.

### Simulating a worker (no live provider)

For transcript/board/telemetry flows, the tailer needs only three things, all inside the sandbox:

1. a JSONL at `<tempHome>/.claude/projects/<cwd-slug>/<sessionId>.jsonl` you append records to
   (copy real record shapes: `user` / `assistant` (+`stop_reason`) / `queue-operation` / `queued_command`
   attachment — `transcript.ts` + `tailer.ts` document what each field drives);
2. one `session` row in the sandbox DB (`sqlite3 <tempHome>/.frizz/projects/*/ui.db "INSERT INTO session
   (slug, session_id, thread_name, spawned_at, title, backend, model, effort, permission_mode) VALUES (…)"`)
   — `thread_name` is the thread identity string `frizz-<slug>`. There is nothing to spawn beside it:
   liveness comes from the row's runtime, so a simulated worker needs no process at all.

This is the sanctioned exception to "never hand-write rows": the row is the fixture, and appending records
then exercises the REAL tailer → board → push → render pipeline end-to-end. Dozens of worked examples live
in `scripts/seed-*.mjs`.

---

## Composes with

- **`headless-browser`** — how to LOOK at this stack without putting a window on the maintainer's screen.
- **`real-subsystem-harness`** — for behavior no browser can reach (broker socket, pty, migrations).
- **`frizz-artifact-e2e`** — this stack runs `startServer({dev:true})` = SOURCE. A green run here does NOT
  prove the promoted artifact works. For packaging, detached daemons, spawn/exec paths, use that skill.
- **`visual-review`** / **`optical-spacing`** — how to judge what you captured.
