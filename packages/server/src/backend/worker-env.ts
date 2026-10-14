// THE one rule for what a dispatched worker's process environment contains: everything ntwine itself was
// started with, MINUS ntwine's own control-plane variables. One module, used by every transport, because
// the thing this replaced was three independent ALLOWLISTS that had already drifted apart.
//
// ── WHY THIS IS A DENYLIST NOW ─────────────────────────────────────────────────────────────────
// Until 2026-08-02 each transport curated its own allowlist of variables to forward: ENV_ALLOWLIST
// (claude broker, 16 keys), EXPLICIT_CLAUDE_ENV_KEYS (the SDK layer, which THREW on anything else) and
// CODEX_APP_SERVER_ENV_KEYS (~35 keys). The stated rationale was that an agent's tool subprocesses
// inherit its environment, so forwarding host secrets broadens agent authority.
//
// That reasoning does not survive contact with what an agent can already do. A worker has a shell and
// full filesystem read: anything in the environment worth stealing is also sitting in ~/.aws/credentials,
// ~/.config/gh/hosts.yml or ~/.npmrc. Withholding GITHUB_TOKEN from a process that can run
// `gh auth token` is not a boundary.
//
// Meanwhile the cost was real and had already produced a defect. The three lists diverged: HTTP_PROXY,
// HTTPS_PROXY, NO_PROXY and SSL_CERT_FILE reached a CODEX worker and not a CLAUDE one, so behind a
// corporate proxy the same task succeeded or failed depending on which backend the operator picked.
// Neither list carried SSH_AUTH_SOCK (no ssh-agent, so no git over SSH), NODE_EXTRA_CA_CERTS (custom
// CAs), or any toolchain variable — NVM_DIR, GOPATH, CARGO_HOME, JAVA_HOME, PYENV_ROOT — so a build run
// inside a worker could behave differently from the identical build in the operator's own shell, for
// reasons nothing in the logs would explain. Every new variable also cost two edits in two files.
//
// t3code, the closest comparable tool (a GUI wrapping the same provider CLIs), passes process.env
// through verbatim and merges user overrides on top — see mergeProviderInstanceEnvironment. So does
// essentially every other developer tool. Matching that is the least-surprise behavior: if you export
// something before launching ntwine, your agents see it.
//
// ── WHAT IS STILL DENIED, AND WHY ──────────────────────────────────────────────────────────────
// ntwine's OWN variables, by the `NTWINE_` prefix. These are control plane, not developer environment:
//   · NTWINE_CLAUDE_BROKER / NTWINE_CODEX_APP_SERVER_DAEMON carry a daemon's entire config as JSON,
//     including socket paths and the record path it publishes to.
//   · NTWINE_LAUNCH_OWNER_TOKEN, NTWINE_SERVER_LOCK and the NTWINE_LAUNCH_* set are the launch identity that
//     decides which server owns which project.
//   · NTWINE_THREAD / NTWINE_PERM_DIR / NTWINE_NATIVE_ASK / NTWINE_PERM_POLICY are what the cc-worker hooks
//     gate on. A worker dispatched to work ON ntwine would otherwise inherit the SERVER's values and the
//     hooks would read another thread's identity.
// Denying the whole prefix rather than a hand-kept list is deliberate: it is the same "cannot drift"
// property the allowlists failed to hold, pointing the other way. The handful of NTWINE_ variables a
// worker genuinely needs are re-added explicitly afterwards, because every caller merges its own
// `workerEnv` ON TOP of this (see the broker's `env:` and the bridge's `attach`).
//
// ── WHAT NTWINE ITSELF WROTE, AND WHY IT IS RESET RATHER THAN DENIED ────────────────────────────
// "What you exported" is the LAUNCH environment, and process.env is not that once ntwine is running:
// the dev server creates Vite in-process, and Vite 8's resolveConfig does
// `if (!isNodeEnvSet) process.env.NODE_ENV = defaultNodeEnv` (vite/dist/node/chunks/node.js), so
// every worker of a `nub run dev` ntwine started with NODE_ENV=development nobody exported. That broke
// real work: `next build` in a worker died prerendering /_global-error with "Cannot read properties of
// null (reading 'useContext')", because Next keeps a non-standard NODE_ENV (2026-09-30).
//
// Denying NODE_ENV would fix that and break the rule above — an operator who DID export
// NODE_ENV=production before launching ntwine must still see it. So the keys ntwine's own in-process
// tooling writes are instead taken from a snapshot of this process's environment at module load, which
// is before anything runs: an operator's value comes through, a value ntwine injected does not, and a
// key absent at launch is absent in the worker. The list is exactly what Vite writes into process.env
// (NODE_ENV in resolveConfig; VITE_USER_NODE_ENV, BROWSER and BROWSER_ARGS from a `.env` file in
// loadEnv); add a key here when another in-process dependency starts writing one.
//
// The snapshot is per PROCESS, which is why the daemon spawn sites (claude-broker-host, the codex and
// ACP hosts) hand their daemon `launchEnvironment()` rather than `process.env`: a broker forked with the
// server's live env would snapshot Vite's value as its own launch value, and the Claude SDK builds the
// worker's env inside the broker from the broker's own process.env.
//
// This is NOT a secrets boundary and must not be described as one. It keeps ntwine's plumbing out of a
// worker's environment; it does not keep the operator's credentials out, and it never could.
const NTWINE_INTERNAL_PREFIX = "NTWINE_"

/** Whether `key` is one of ntwine's own control-plane variables — never inherited by a worker. Exported so
 *  the transports and their tests share one predicate rather than three. */
export function isNtwineInternalEnvKey(key: string): boolean {
  return key.startsWith(NTWINE_INTERNAL_PREFIX)
}

// ── THE HUMAN'S EDITOR IS NOT A WORKER'S ─────────────────────────────────────────────────────────
// Launch ntwine from a terminal inside VS Code, Cursor or Windsurf with Claude Code's extension installed
// and the shell carries that window's address: the extension writes CLAUDE_CODE_SSE_PORT, the port of
// its own IDE server, into every terminal it can reach (`environmentVariableCollection.replace`, read out
// of anthropic.claude-code 2.1.287), and older releases also wrote ENABLE_IDE_INTEGRATION=true. Claude
// Code treats either as "you are running in that editor" (its `MNe` auto-connect check, 2.1.287: the
// port alone is enough), so every BACKGROUND worker would attach to the human's editor and could open
// diffs in it, steal focus, or read its selection as though the human had pointed at it — from a thread
// they are not looking at. ntwine's own window onto the editor is `mcp__ntwine__editor`, which reads and
// never drives; a worker must not hold a second, driving one.
//
// So the variables that POINT a process at an editor are not inherited: the port, the legacy switch,
// FORCE_CODE_TERMINAL (which makes Claude Code believe it runs in the editor's terminal), an operator's
// CLAUDE_CODE_AUTO_CONNECT_IDE (a Claude worker gets an explicit `false` instead, types.ts
// CLAUDE_WORKER_ENV), and the CLAUDE_CODE_IDE_* overrides that redirect or loosen the match
// (HOST_OVERRIDE, SKIP_VALID_CHECK). The one IDE_* variable that only switches something OFF,
// CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL, still comes through: it can only make a worker do less.
//
// Deliberately NOT stripped: TERM_PROGRAM and VS Code's GIT_ASKPASS / VSCODE_GIT_IPC_HANDLE. The first is
// read by many tools for colour and nothing here attaches through it once auto-connect is off; the second
// is how `git push` authenticates for an operator who signs in through VS Code, and taking it away would
// break a worker's push to protect against a credential prompt that only appears when it is needed.
const EDITOR_ATTACH_ENV_KEYS: ReadonlySet<string> = new Set([
  "CLAUDE_CODE_SSE_PORT",
  "ENABLE_IDE_INTEGRATION",
  "FORCE_CODE_TERMINAL",
  "CLAUDE_CODE_AUTO_CONNECT_IDE",
])
const EDITOR_ATTACH_PREFIX = "CLAUDE_CODE_IDE_"
const EDITOR_ATTACH_KEPT: ReadonlySet<string> = new Set(["CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL"])

/** Whether `key` would point a worker at the human's editor (see above) — never inherited. */
export function isEditorAttachEnvKey(key: string): boolean {
  if (EDITOR_ATTACH_ENV_KEYS.has(key)) return true
  return key.startsWith(EDITOR_ATTACH_PREFIX) && !EDITOR_ATTACH_KEPT.has(key)
}

/** Keys ntwine's own in-process dependencies write into process.env at runtime — see the header. */
export const RUNTIME_WRITTEN_ENV_KEYS = ["NODE_ENV", "VITE_USER_NODE_ENV", "BROWSER", "BROWSER_ARGS"] as const

let launchValues: ReadonlyMap<string, string | undefined> | undefined

/** Snapshot this process's launch values of RUNTIME_WRITTEN_ENV_KEYS. Runs at module load; idempotent,
 *  so the code that creates Vite calls it too, to keep the ordering from resting on the import graph. */
export function captureLaunchEnvironment(): ReadonlyMap<string, string | undefined> {
  launchValues ??= new Map(RUNTIME_WRITTEN_ENV_KEYS.map((key) => [key, process.env[key]]))
  return launchValues
}
captureLaunchEnvironment()

/** A copy of `source` with every runtime-written key it carries reset to this process's launch value
 *  (deleted if it was unset at launch). A key `source` does not carry stays absent: a caller that scoped
 *  its env down is not handed one back. Unlike inheritWorkerEnvironment it keeps NTWINE_ variables, so it
 *  is what a daemon's OWN environment is spawned from. */
export function launchEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source }
  for (const [key, value] of captureLaunchEnvironment()) {
    if (!(key in env)) continue
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  return env
}

/** The environment a dispatched worker starts from: `source` (ntwine's own process env by default) with
 *  the runtime-written keys put back to their launch values (see launchEnvironment), ntwine's
 *  control-plane variables and the editor-attach variables removed, and undefined values dropped.
 *  Callers merge their per-thread `workerEnv` on top — that is what puts the NTWINE_ variables a worker
 *  DOES need back, with this thread's values rather than the server's. */
export function inheritWorkerEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(launchEnvironment(source))) {
    if (value === undefined || isNtwineInternalEnvKey(key) || isEditorAttachEnvKey(key)) continue
    env[key] = value
  }
  return env
}
