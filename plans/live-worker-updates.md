# Updating a LIVE worker — finishing option A

Written 2026-08-08, after the singleton broke every non-launching project's frizz MCP tools and the fix could not reach a single already-running worker. Maintainer, the same day: *"The whole fucking point is that my update frizz button is supposed to just update everything. The fact that there are these stateful daemons that are blocking us from properly updating is unfortunate. Is there no more complete solution here?"*

**Partly. Hooks, skills, agents and commands can be updated in a LIVE worker; the MCP servers cannot.** That split is measured, not reasoned — see §0 — and it is the single fact this plan turns on.

**STATUS 2026-10-11: both halves of "The wire" below are built, and the reload needs nobody.** Everything under this note is the plan as written on 2026-08-08, kept as the record of why; where it says `stageStablePluginDir` has zero production callers, or names line numbers, it describes that day.

- **§1 landed as written.** `workerPluginDir()` returns the stable path for an artifact launch. The version identity is a content digest of the plugin directory in every case, which settles the question §1 left open: a published release, a promoted build and a rebuilt-in-place artifact all change it exactly when the content changes. A DEV SOURCE checkout is NOT staged — its `cc-worker/` is edited in place, so a worker launched against it already reads every change, and the same fingerprint that notices a repoint notices an edit.
- **§2 landed differently, and smaller.** The plan had the server repoint the link and then ask each idle thread to reload. Instead each worker's DAEMON compares a fingerprint of its plugin at its own turn boundaries and reloads itself (`packages/server/src/backend/claude-plugin-sync.ts`). The daemon is the one process that knows exactly when its session is between turns, so the "idle threads only" rule needs no board reading and no race with a follow-up; an input simply waits behind a reload in flight. The server's whole part is the repoint that booting already performs.
- **It watches more than this plan asked for.** The same fingerprint covers the project's and the operator's own skills, agents, commands and installed plugins, which a live session does not notice by itself either (measured) and which the button was the only way to pick up.
- **The Reload plugins button and its RPC are gone**, since the thing they did by hand now happens.
- **Verified** as the section below asks, with the control it insists on: `packages/server/src/backend/_live_plugin_sync.mts` against real claude 2.1.296 (a skill and a hook registration that exist only in the new version are live after a repoint, same daemon pid; with the sync off, neither is), and `scripts/verify-artifact-plugin-sync.mjs` on a built artifact across a server replacement.
- **§0 still holds and is still the limit**: an MCP server is not re-spawned by any of this.
- **Codex was never in this plan and has its own half.** A Codex thread has no plugin directory to repoint: it is rebuilt from the config bag of whichever `thread/resume` loads it, so the bridge now sends one whole bag with every resume and releases a thread between turns to make the resume rebuild it. `ARCHITECTURE.md` § Stable server updates has the rule, and `packages/server/src/backend/_live_codex_config_sync.mts` is the check. There §0 does not hold: a rebuilt Codex thread gets a new MCP child.

## 0. MEASURED 2026-08-08, before believing any of this

Two staged copies of the worker plugin (`v1`, `v2`), each declaring a marker MCP server in `.mcp.json` that reports which copy spawned it, published through one repointable symlink exactly as `stable-plugin-path.ts` does. A real dispatched worker, a real reload:

| step | result |
| --- | --- |
| worker dispatched against `current -> v1` | marker server MOUNTED and callable, as `mcp__plugin_frizz_marker__which_plugin` (pid 21779) |
| repoint `current -> v2`, then `reloadThreadPlugins` on the LIVE thread | reload reports `mcpServers: ["plugin:frizz:marker", …]`, `plugins: 1, commands: 50, agents: 21` — **but pid 21779 is untouched and no v2 process is spawned** |
| control: a FRESH session against `current -> v2` | v2 spawned immediately (pid 41537) — so the v2 copy is fine, and the failure is specific to reload |

**`reloadPlugins()` re-reads the plugin and REPORTS its MCP servers; it does not re-spawn one that is already connected.** The report is what makes this trap expensive: it looks like success.

Two consequences:

- **Moving the frizz MCP into the plugin buys nothing for live updates.** Cut from this plan. (It would also rename every tool from `mcp__frizz__spawn_thread` to `mcp__plugin_frizz_frizz__spawn_thread`, breaking every prompt, doc and allow-list that names them — a second, independent reason not to.)
- **A worker's MCP shim can only change when its session's MCP child is re-spawned, i.e. on a NEW session.** No repointing, no reload, no server-side change reaches it. That is a property of the SDK, not of frizz.

So the shim's own logic is the thing that must be right the first time, because it cannot be patched later — which is exactly why `c5784a1` moved it from being TOLD its server address to DISCOVERING it (the machine address, then any live project lock, skipping dead pids) and its project (the stamp, else `.frizz/.id` walked up from cwd). Those are the two facts that would otherwise go stale, and they now re-resolve per call from the filesystem. A shim shipped today survives every future restart without an update; only a change to the shim's own code needs a new session.

**What is still worth building** is §1 alone: stage the plugin and launch workers against the stable path, so hooks, skills, sub-agent profiles and commands — everything except MCP servers — reach a live worker on reload. That is a real capability, it is measured above (`plugins: 1, commands: 50, agents: 21` reloaded), and it is what `4857ee8` set out to finish.

## The problem, precisely

A worker is a DETACHED daemon that outlives frizz restart after restart. Two things about it are frozen the moment it forks, and an update reaches neither:

1. **Its plugin directory** — hooks, sub-agent profiles, skills and commands all come from the path it was launched against. Every one of frizz's paths is immutable and version-specific (`~/.frizz/builds/<sha>/runtime/cc-worker` in dev, `<npm package>/runtime/cc-worker` in production), so `reloadPlugins()` — which takes no arguments and re-reads whatever path the session started with — re-reads the same bytes. **This one is fixable**, and §1 is the fix.
2. **Its MCP server processes**, including `bin/frizz-mcp.mjs` — spawned once, at session start. **This one is not fixable in place**, per §0: a reload does not re-spawn a connected server, whichever way it was mounted.

So an "Update & Restart" today leaves every live worker on the old plugin indefinitely. One of those two is a missing wire; the other is a property of the SDK, and the honest answer for it is that a shim change costs a new session.

## What already exists (do not rebuild it)

`packages/server/src/stable-plugin-path.ts` — staging + one repointable symlink, with `ensureSymlink`'s four cases handled explicitly and the version directory published by atomic RENAME. Its own commit (`4857ee8`, 2026-07-31) measured the payoff: *"Repointing that link and asking a live worker to reload is measured to arm a hook the process did not start with — no restart, no lost context, no lost in-memory sub-agents."* That commit ends: **"Not yet wired into either launcher; that is the next step of option A."** It still is not — `stageStablePluginDir` has zero production callers.

`reloadPlugins()` is plumbed end to end already: `claude-agent-sdk.ts:439` → `claude-broker-client.ts` → `claude-agent-broker-bridge.ts:660` → the `reloadThreadPlugins` RPC (`router.ts:1884`). It returns the reloaded plugin/command/agent counts **and `mcpServers`**.

## The wire

### 1. Launch every worker against the stable path

`workerPluginDir()` (`dispatch.ts:622`) is the single chokepoint — the `--plugin-dir` flag, the broker's `workerEnv.pluginDir`, and `resolveFrizzMcp`'s script path all come from it. Stage the resolved immutable directory on boot and return the stable path instead.

The one real decision is the **version identity**, which must change whenever the plugin content changes or a worker reloads and sees the same bytes:

- production → the package version;
- a promoted artifact → the build digest, which is already in the path (`~/.frizz/builds/<sha>/…`), so it needs no new plumbing;
- a DEV SOURCE checkout → neither works, because `cc-worker/` is edited constantly under a fixed `plugin.json` version. Use a content digest of the directory, or accept that dev does not hot-reload and skip staging there. **Decide this explicitly** — a silently-never-restaging dev path is exactly the failure this whole plan exists to remove.

### 2. Then: reload on update

With the wire in, an update becomes *repoint the link, then ask live threads to reload* — for everything except MCP servers. Reload only threads that are IDLE — never mid-turn — so nothing is interrupted and the agent-completion invariant holds. A thread mid-turn picks it up at its next turn boundary.

## Verification, before this goes anywhere near the maintainer's board

Use `frizz-stack` with `--creds` (isolated, real credentials, real dispatch):

1. dispatch a real worker; confirm it HAS `mcp__frizz__*` and that a tool call succeeds;
2. edit the staged plugin to a NEW version identity and repoint the link;
3. call `reloadThreadPlugins` on that live thread;
4. confirm a HOOK or sub-agent profile that exists only in the new version is now live — a marker the old copy cannot produce, so "it still works" cannot be confused with "it never reloaded";
5. negative control: a fresh session must show the new marker too, or you have proven nothing about the reload (this is the control that caught §0 — without it, "the reload reported the server" reads as success).

## Blast radius, and why this was not done on 2026-08-08

`workerPluginDir()` feeds every worker spawn. A staging bug takes out hooks, sub-agent profiles and the frizz tools for every thread at once. On the day this was written the maintainer's machine had ~15 live workers mid-triage-sweep, so re-plumbing it in the same session as three other worker-spawn changes was the wrong trade. It wants its own session, with the verification above run first.
