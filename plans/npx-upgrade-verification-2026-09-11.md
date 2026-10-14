# npm upgrade verification — 2026-09-11

The legacy upgrade failure is repaired on local `main` by `aadc92a3`. A real browser upgraded the published `0.12.10` package into a packaged build containing that repair and automatically recovered on the same project URL. The separately reported macOS filesystem denial remains unconfirmed; the supplied panic identifies an fnm shell hook, not evidence of system corruption.

## Upgrade failure and repair

The published `0.12.10` launcher starts its successor with `--_ntwine-production-reexec --port <n> <projectDir>`. The `0.12.11` receiver rejects the positional directory and exits after the old launcher has drained its server. The previous worker reproduced the resulting permanent connection refusal. The fix removes legacy positionals only in the internal re-exec path; project identity comes from the existing tokenized environment.

- Source: [`reexecArgv`](../src/production-update.ts), its integration in [`production.ts`](../src/production.ts), and [`production-update.test.ts`](../src/production-update.test.ts).
- Direct negative control against the published `0.12.11` launcher returned exit `1` with “ntwine takes no repository path” for the old argument shape.
- At verification time, npm `latest` was still `0.12.11`, with `gitHead` `e330dbd174bb5c39720592ca897680e665141f51`. The repair is later than that release. No public package was published by this continuation.

## Real browser verification

The test used macOS, Node `26.7.0`, npm `11.19.0`, a disposable project and HOME, a private npm cache, and a loopback registry. The start command was actual `npx --yes ntwine@0.12.10 --no-app --port 47114`. Its successor was the previous worker's packaged `aadc92a3` build, labelled `0.12.12-rescue.1` solely for the local registry.

| Check | Observed result |
| --- | --- |
| Real Update ntwine button | Sent the update request; HTTP `202` |
| Successor readiness | `5.0s` in the final warm-cache run; `7.5s` in the preceding successful run |
| Browser recovery | Automatic reload onto the same project URL; popover displayed `0.12.12-rescue.1` |
| Artifact identity | Running launcher's SHA-256 matched the tarball's launcher exactly |
| Desktop / narrow | Inspected `1280×850` and `390×844` screenshots; no horizontal overflow |
| JavaScript exceptions | None |
| Network console | Expected `503`, connection refusal and WebSocket reconnect messages during the legacy handoff |
| Cleanup | Browser closed; test server, registry and their children stopped; no owned process remained |

Launcher SHA-256: `d01208f1b6907f7be01f3cf62b19357a33cdd70bccedbd33173cb7350ea7b662`.

Tarball SHA-256: `256295fc2227ff637047300650c99ffa6cd7586fd8d30f9f7c71ffeecea26de6`.

Evidence and replay harness are preserved in `.ntwine/threads/83fb409a-c418-422d-8173-c7fb7823d626/`: `browser-evidence.json`, `verify-upgrade.mjs`, `fixture/`, launcher/registry logs, and before/after screenshots. The harness uses ports `47114` and `47873`; `VERDACCIO_BIN` overrides its cached local Verdaccio executable. Run from the repository with `nub .ntwine/threads/83fb409a-c418-422d-8173-c7fb7823d626/verify-upgrade.mjs`.

The initial browser fixture pointed at the server root instead of its registered project URL; another attempt did not tolerate responsive remounting and the navigation during recovery. Those harness faults were corrected before the two successful runs. The old worker's first local-registry result reused another cached package with the same version; it is excluded from the evidence. The final test required a private cache and byte-for-byte artifact verification.

This was an empty-board upgrade test, not a live Claude/Codex worker-survival test. Windows, Node `22.13`, the affected friend's machine, and macOS TCC transitions were not exercised. No UI code or styling changed; the optical check was inspection of the unchanged controls, not a new ink-measurement claim.

## Local gates and review

- Updater regression suite: `9/9` passed.
- CI board tests: `73/73` passed.
- Portable monitor sync check: passed.
- CI monitor tests: `16/16` passed.
- Repository typecheck: passed.
- Independent source review found no functional blocker in the repaired legacy argument path. It confirmed that dropping the old directory preserves the pinned project identity and ownership token. The broad internal argument normalization was not expanded into a separate parser redesign.

The inherited `upd-pack-test` worktree and local branch were removed after verifying its only uncommitted change was the test version label. Its fix was already on `main`. The inherited test board and private prerelease npm-cache entry were removed. Shared real-release caches and the production dashboard were left untouched.

## macOS error report

The reported sequence was a directory change into `~/Documents/code`, followed by a Rust panic at `src/commands/use.rs:42:59` with `EPERM` (`Operation not permitted`). The accompanying worker screenshot also reports repository access failure, desktop screenshot failure, and an absent `NTWINE_THREAD_SLUG`.

### Confirmed source match

In fnm releases `v1.34.0` through `v1.38.1`, that source location is `std::env::current_dir().unwrap()`. The fnm zsh integration registers a `chpwd` hook that invokes `fnm use --silent-if-unchanged` after a directory change. The evidence therefore points to a post-`cd` child failing to resolve its working directory; it does not show that the shell builtin itself failed. See [fnm's source at the reported line](https://github.com/Schniz/fnm/blob/v1.38.1/src/commands/use.rs#L39-L46) and [its zsh hook](https://github.com/Schniz/fnm/blob/master/src/shell/zsh.rs#L32-L60).

ntwine's runtime, updater and dependency manifests contain no fnm integration. ntwine's production updater invokes npm; development and verification use Nub. Replacing the user's fnm hook would not itself restore OS-level filesystem access.

### Ranked hypotheses

1. **macOS privacy denial for Documents access.** The location and `EPERM` fit. Apple distinguishes this from ordinary BSD/ACL denials, which normally report `EACCES`, and documents TCC's dependence on the process responsible for an operation. This remains a hypothesis, not a verified permission revocation. See [Apple's filesystem-permissions explanation](https://developer.apple.com/forums/thread/678819) and [Documents-access policy](https://support.apple.com/guide/security/controlling-app-access-to-files-secddd1d86a6/web).
2. **Changed permission attribution after the detached update.** The legacy updater demonstrably launches a detached successor. Apple explicitly identifies daemonization as a possible way to break responsible-app attribution. That could explain an upgraded ntwine process losing protected-folder access. It does not, by itself, explain an independently opened terminal losing access, nor prove that any stored permission was changed.
3. **Other filesystem policy or provider state.** Endpoint-security software can also return `EPERM`; directory relocation or provider problems need a direct check. The supplied message cannot distinguish these cases.

The reviewed updater paths install a new npm cache entry, hand off process ownership, and restart the server. They do not edit shell startup files, invoke fnm, reset TCC, or recursively change Documents permissions. The native-helper permission repair adds executable bits only to node-pty's package-local `spawn-helper`. This source review does not exclude actions taken by other software or workers on the affected machine.

An absent `NTWINE_THREAD_SLUG` in a shell is not sufficient evidence that a thread was lost: it is an identity supplied to the ntwine MCP subprocess. Confirm an actual MCP error and backend/version before diagnosing it. Current mount code: [`dispatch.ts`](../packages/server/src/dispatch.ts), [`claude-agent-broker-bridge.ts`](../packages/server/src/backend/claude-agent-broker-bridge.ts), and [`codex-mcp.ts`](../packages/server/src/backend/codex-mcp.ts).

### Read-only discriminating check

Run in the affected terminal app:

```zsh
/bin/zsh -f -c 'cd "$HOME/Documents/code" && /bin/pwd && /bin/ls -A . >/dev/null'
```

This skips user startup hooks and separately tests directory traversal, physical working-directory resolution and directory listing without printing filenames. If it succeeds while the normal shell command panics, investigate fnm's hook/process context. If it fails with `EPERM`, check that terminal app's Documents permission under System Settings → Privacy & Security → Files and Folders, and compare with a freshly opened terminal. Capture the terminal app, macOS version, fnm version, and the exact error before changing settings. No recursive `chmod`, broad TCC reset, cache deletion, or full-disk permission grant is warranted by the current evidence.

## Launcher design decision

Keep the compatibility fix as the immediate repair. It is required for already-published launchers regardless of future architecture.

| Option | Benefit | Cost |
| --- | --- | --- |
| Existing immutable npm installs plus compatible handoff | Small repair; already exercised; no new prerequisite | Bootstrap and server protocols must remain compatible across releases |
| Separate stable launcher package | Provisioning, readiness checks and rollback can be owned outside the server generation | A second release/migration contract; does not repair old receivers by itself |
| Durable launcher installed outside npm's execution cache, distributed by the same package | Can separate generation lifecycle without a second public package | Still requires a persistent bootstrap, versioning and rollback protocol |

A stable launcher is a reasonable design direction, but it must retain process identity where needed and verify a new server before relinquishing the old one. Introducing Nub as an internal installer is a separate dependency/distribution decision; it does not solve the legacy argument mismatch or a TCC denial. No launcher redesign or new runtime dependency was implemented in this effort.
