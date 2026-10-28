---
name: ntwine-artifact-e2e
description: End-to-end verification of an ntwine change on a REAL PROMOTED ARTIFACT (not dev source), driven in a real browser. Use this whenever a change could behave differently in a promoted build than in the dev stack — anything touching packaging/bundling, detached daemons (codex app-server, the Claude broker), spawn/exec paths, worker-environment resolution, or "it works on the dev stack but does it ship?" The `ntwine-stack` skill runs `startServer({dev:true})` = SOURCE and will pass while the promoted artifact is broken. This skill launches the actual artifact. Do this before claiming a dispatch/runtime change is done.
version: 0.1.0
metadata:
  internal: true
---

# ntwine-artifact-e2e — verify on the promoted artifact, not the dev stack

ntwine serves a PROMOTED ARTIFACT from `~/.ntwine/builds/<digest>/runtime/`, never the source checkout
(see the `ntwine-servers-run-promoted-artifacts` memory). The `ntwine-stack` isolated stack runs
`startServer({dev:true})` — SOURCE. So a green `ntwine-stack` run proves the dev path, NOT the shipped build:
bundling, detached-daemon emission (`build-runtime.mjs` writes each `DETACHED_DAEMON_ENTRIES` file beside
`index.js`), and executable/PATH resolution all differ. A real regression class (e.g. the Claude broker's
daemon needing an ABSOLUTE claude path — a bare `"claude"` crashes it before it publishes its record, so
every dispatch times out "did not become ready") is invisible to dev-source gates and to static checks
(`node loads the file`, `the daemon publishes standalone`). Only launching the artifact + dispatching
catches it.

## The recipe

### 1. Launch a real promoted-artifact instance, isolated

`ntwine-dev` (= `node … src/index.ts`) builds/promotes an artifact from CURRENT SOURCE and runs
it. Two gotchas:

- **You are probably running inside an ntwine worker**, so your env has `NTWINE_DEV_CHILD=1` and `NTWINE_LAUNCH_*`.
  Left set, `ntwine-dev` takes the CHILD path and dies `"ntwine control-plane child has no live matching
  project launch owner"`. Strip them.
- Use a **throwaway git repo** as the project (isolated `~/.ntwine/projects/<id>`), **real HOME** (so
  Keychain claude auth works — a sandbox HOME fails `AUTH_REQUIRED:claude`), and force the feature on.

```bash
REPO=$(mktemp -d /tmp/fae-XXXX); (cd "$REPO" && git init -q . && git commit -q --allow-empty -m init)
cd "$REPO" && exec env \
  -u NTWINE_DEV_CHILD -u NTWINE_DEV_PORT -u NTWINE_DIRECT_SUPERVISOR -u NTWINE_LAUNCH_OWNER_TOKEN \
  -u NTWINE_LAUNCH_PROJECT_DIR -u NTWINE_LAUNCH_PROJECT_ID -u NTWINE_LAUNCH_STATE_DIR -u NTWINE_LAUNCH_IDENTITY_SCOPE \
  -u NTWINE_PERM_DIR -u NTWINE_SCRIPTS_DIR \
  -u NTWINE_SOURCE_COMMAND -u NTWINE_STABLE_ARTIFACT -u NTWINE_STABLE_WEB_DIST -u NTWINE_THREAD -u NTWINE_WORKER_PLUGIN_DIR \
  NTWINE_CLAUDE_BROKER_BRIDGE=1 ntwine-dev
```

**REAL HOME MEANS REAL SHARED STATE, and the project registry is the part that bites.** `~/.ntwine/registry.json` is global to HOME, not per-server — so the throwaway repo you launch against is written straight into the maintainer's real project list, and it shows up in the project list on their page. This is not hypothetical: it happened on 2026-08-19, during the run that added this warning. There is no flag that prevents it, because the isolation this recipe gives you is a throwaway PROJECT, never a throwaway HOME.

So treat the registry as something you borrowed and must put back:

```bash
node -e 'const r=JSON.parse(require("fs").readFileSync(process.env.HOME+"/.ntwine/registry.json","utf8"));console.log(r.projects.length);for(const p of r.projects)console.log(p.slug,p.path)'
```

Run that BEFORE you launch and again after you clean up, and diff the two. Any project of yours that survives is one the maintainer now has to delete by hand. Remove the registry entry and its `~/.ntwine/projects/<id>` state dir, then re-run the check and confirm the list matches what you started with.

Run it with Bash `run_in_background: true`. First launch BUILDS the artifact (esbuild runtime + web build,
~30-90s). Wait for `requested ntwine in your default browser — http://127.0.0.1:<PROXY>` (the proxy port; the
child API logs `server on http://127.0.0.1:<CHILD> (prod)` — `(prod)` confirms it's the artifact, not dev).
Drive the PROXY url.

### 2. Dispatch through the real RPC surface

Use `scripts/lib/rpc-client.mjs` (never hand-rolled fetch — queries are `GET /rpc/<name>?input=`,
mutations `POST`, every response is `{result}`/`{error}`):

```js
import { createRpcClient } from ".../scripts/lib/rpc-client.mjs"
const api = createRpcClient(`http://127.0.0.1:${PROXY}/`); await api.waitForHealth()
const { slug, sessionId } = await api.mutate("dispatch", { prompt: "Reply with exactly HELLO-OK then stop." })
// poll for the agent's reply — this is the real end-to-end signal, not a status field
for (let i=0;i<40;i++){ await sleep(3000)
  const tr = await api.query("threadTranscript",{slug}); if (JSON.stringify(tr).includes("HELLO-OK")) break }
```

For a worker-environment change, dispatch a prompt that uses the real surface — a `ntwine:haiku` sub-agent,
the ntwine MCP (`mcp__ntwine__spawn_thread`), the cc-worker hooks — and assert the sub-agent's marker token
routes back. A plain "write a file" proves almost nothing. ntwine mounts **no browser** into a worker (since
2026-08-26 the only server it injects is `ntwine`), so a dispatched worker has chrome-devtools tools only
when the project it runs in brings them — this repo does, through its own `.mcp.json`; a throwaway repo
does not. If your change is about the worker environment, assert which of the two you expect.

### 2b. A HAPPY-PATH PROMPT IS NOT A TEST — drive the ugly shapes

**This is the step that has actually failed.** 2026-07-26 a spike shipped with a promoted-artifact e2e,
a real-Chrome screenshot, a sub-agent round-trip, a kill-the-server survival test and 2150 green unit
tests. Every dispatched prompt was a toy: *"reply with exactly HELLO-OK"*, *"write a marker file"*,
*"count to 5"*. Within a day a real orchestrator thread and every one of its sub-agents were destroyed
by a real agent running `printf '\033[31m…'` — an ANSI escape hit a strict protocol validator, the
validator threw, and the daemon's pump read that as the session ending.

A toy prompt cannot find that, and no amount of MORE toy prompts would have. The risk in a provider
integration is not in the control flow you wrote; it is in the **values the provider sends back**, and a
clean prompt only ever produces clean values. So the workload has to be hostile ON PURPOSE:

- **control bytes and ANSI escapes** in a tool argument (`printf '\033[31mX\033[0m'`) — the shape that
  actually killed a thread;
- **output far past the size bounds** in `claude-agent-sdk-protocol.ts` (128 KB event text, 64 KB JSON) —
  `head -c 400000 /dev/zero | tr '\0' 'x'`;
- **non-UTF-8 / binary** bytes (`head -c 2048 /dev/urandom | base64`);
- **unicode the validators single out** — bidi overrides, zero-width joiners, astral plane, combining marks;
- **a long tool chain and a live sub-agent**, so turn bracketing and liveness are exercised together.

`packages/server/src/backend/_live_broker_hostile.mts` is exactly this workload against a real session;
run it (or extend it) rather than re-deriving the list. When you add a bound to the protocol, add a case.

The assertion that matters is not "the reply was correct" — it is **"the session is still alive and
still answering afterwards"**, checked against the daemon's own diagnostics log for a `lifecycle:crashed`
record. A thread that dies quietly is the failure mode; a wrong answer is a much smaller problem.

### 3. Screenshot in a real browser tab

The `chrome-devtools` MCP is the reliable path here (`scripts/shot.mjs`'s puppeteer Chrome tends to hang in
a worker env). It is YOUR tool, from this repo's `.mcp.json` — not something ntwine put in the worker you
dispatched. `new_page` the proxy url → `wait_for` the thread text → `take_screenshot`. **Write the shot
under a chrome workspace root** (e.g. the ntwine repo dir), NOT `/tmp` (access denied); then move it to a
trusted embed root (`~/Screenshots`, the project dir, or `os.tmpdir()`) for the handoff and clean the repo.
ntwine only lists a project's threads when the project has a `.ntwine/` dir — `mkdir -p $REPO/.ntwine/threads` if it's
otherwise empty.

### 4. Clean up

Kill the instance by its EXACT proxy+child PIDs (`lsof -nP -iTCP:<port> -sTCP:LISTEN -t`, never broad
`pkill`), and `rm -rf` the throwaway repo + its `~/.ntwine/projects/<id>`. An ntwine server retains its artifact
snapshot for its process lifetime, so the *in-app restart button* does NOT pick up a new build — only a
full process kill + relaunch re-promotes from current source.
