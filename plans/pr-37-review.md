# PR #37 review: Windows file links

## Final disposition

**Fixed and merged.** The revised [PR #37](https://github.com/colinhacks/frizz/pull/37) merged on 2026-09-16 as `99988231c029e96b930c7e4cbedbc17c3c9cd358` and landed on local `main` through `c03d9296`. Both review findings are resolved.

The [repository CI check](https://github.com/colinhacks/frizz/actions/runs/35162066758/job/105014851441) passed for revised head `24e45093d75d134fc4fa254f1f93ce3d95b90879`. The [Pullfrog review run](https://github.com/colinhacks/frizz/actions/runs/35162070796) failed after a lockfile-configuration error and repeated provider usage-limit errors; it produced no review findings. The authorized merge used the normal merge path without a protection override. The disposable Windows VM was deleted, and the owned browser and fixture server were closed. No release was published.

## Revision and native Windows verification

The maintainer requested direct fixes to the existing PR on 2026-09-16. Commit `9d1ca082` addresses both findings below: Windows containment compares directory identities rather than folded names, and only the server normalizes a URL pathname's leading slash before a Windows drive. The browser preserves raw POSIX paths. The shared normalization helper is used by both file and image resolvers.

Verified after merging upstream `main` into the PR branch:

- Typecheck passed; the full local suite reported **4,635 passed, 89 skipped, zero failures**.
- After landing on local `main`, typecheck and the focused classifier/file/image/HTTP suite passed again: **45 passed, four Windows-only tests skipped** on macOS.
- The browser fixture passed with a real headless Chrome and its existing stubbed backend responses.
- On a disposable **Windows Server 2022** VM with **Node 24.15.0**, all **17 native filesystem/opener-command tests passed with zero skips**. This includes mixed-case aliases, case-distinct NTFS siblings, escaping symlinks, trusted junctions, outside hard links, URL-shaped Markdown paths, and image reads.
- The original PR's containment implementation failed the same native case-distinct-sibling test with `Missing expected exception`; the revised implementation passed. The earlier source-level finding is now reproduced on the real filesystem.

The native run used `NTWINE_REQUIRE_CASE_SENSITIVE_FS=1` so unavailable NTFS case-sensitivity support could not silently skip its regression. Evidence is retained in `.ntwine/threads/34b7874a-d89b-42ba-a69f-73c7c7c0b4a4/windows-tests.log`; the full macOS output is in `full-tests.log`. The desktop applications themselves were not launched: opener tests capture the command or exercise copy mode. These changes do not alter desktop process launching.

## Original review of `5cf9f39a`

The remainder records the original review before revision. Its status, recommendations, and evidence limits describe that earlier head, not the merged change.

**Recommendation: request changes.** This fixes a real bug and should not be declined, but the path-rewriting and containment changes should not land as written.

Reviewed on 2026-09-16: [PR #37](https://github.com/colinhacks/frizz/pull/37), head `5cf9f39ab42276215ad67e3958f067cae0c0d4af`, against local `main` at `4c7ba5f65be49e472d9c813dd04898bb892ae2d9`. The PR is open, has no labels or submitted reviews, and has three discussion comments, all automated-review failure notices. All eight changed files and the complete discussion were read. No GitHub mutations were made.

## Classification and reproduction

**BUG**, not a feature request. The existing renderer recognizes absolute Windows paths as local destinations, then discards the actionable path. Its button consequently has no `data-local-path`; its image has no proxy URL and is removed. The defect remains on current `main`.

The affected contract is Markdown links and images, including relative links resolved against a Windows project directory. The PR's description overstates this as every file link: tool-header links and server-resolved inline-code paths have separate producers.

In a real headless Chrome, both current `main` and the PR head ran their actual `mdToHtml` and classifier modules through Vite. Input:

```markdown
[plan](D:/fixture/plan.md)

![shot](D:/fixture/shot.png)
```

Observed output:

| Observation | Current `main` | PR head |
| --- | --- | --- |
| Button's `data-local-path` | `null` | `D:/fixture/plan.md` |
| Image's `src` | `null` (image removed) | `/_ntwine/local-image?path=D%3A%2Ffixture%2Fshot.png` |
| Relative `./plan.md` under `D:\fixture` | Display only | Actionable `D:\fixture\plan.md` |
| Browser page errors | None | None |

The root cause is `packages/web/src/lib/markdownTargets.ts:68,82,109–112` on reviewed `main`. The downstream renderer is `packages/web/src/lib/markdown.ts:368–409`; the delegated click handler returns without a path at `packages/web/src/lib/local-file-links.ts:12–14`.

The additional browser fixture passed: Windows Markdown links selected the reader, a backslash JSON path reached the opener request, and the image rendered through the proxy URL. That fixture stubs the opener response and image bytes; this is browser routing evidence, not a native Windows filesystem test.

## Findings

### P1 — Whole-path lowercasing weakens containment for case-sensitive Windows directories

Location: [`packages/server/src/local-file.ts:23–31`](https://github.com/colinhacks/frizz/blob/5cf9f39ab42276215ad67e3958f067cae0c0d4af/packages/server/src/local-file.ts#L23-L31).

The new `sameCase` lowercases every component of the canonical candidate and trusted root. Windows supports case-sensitive directories, including directories containing distinct `Repo` and `repo` children. This is a filesystem property, not something `process.platform === "win32"` rules out. [Microsoft's case-sensitivity documentation](https://learn.microsoft.com/en-us/windows/wsl/case-sensitivity) describes the per-directory flag; [Node's filesystem documentation](https://nodejs.org/api/fs.html#fsrealpathpath-options-callback) also warns that realpath does not perform case conversion on case-insensitive filesystems.

Executing the PR's actual comparison functions with these canonical Windows names produces:

```text
trusted root: C:\case-sensitive\Repo
candidate:    C:\case-sensitive\repo\secret.md
isUnder:      true

control:      C:\case-sensitive\Repo-other\secret.md
isUnder:      false
```

If those case-distinct directories exist and the sibling is outside every other permitted root, the comparison admits an out-of-root file. The gate is shared by Markdown/text reads, the opener, path-reference resolution, saved file links, and live-watch eligibility. The image resolver is already deliberately path-unconfined and is not affected by this containment change.

**Evidence limit:** the predicate was executed with supplied canonical paths; no native Windows case-sensitive filesystem was available. This is a source-backed conditional containment defect, not a claimed end-to-end exploit reproduction. The PR's ordinary mixed-case test does not exercise case-distinct siblings.

**Required change:** remove unconditional whole-path folding. Prefer filesystem-aware identity/canonical-name comparison, with a native Windows regression showing that alternate spelling of the same directory succeeds while a distinct case-only sibling remains rejected. Comparing the filesystem identity of the candidate's ancestor at the root's depth with the trusted root is one bounded approach; verify it on the supported Windows filesystems before adopting it. Replacing the check with a case-insensitive lexical `relative` calculation would retain the same flaw.

### P2 — Browser-side drive unrooting unnecessarily breaks valid POSIX paths

Location: [`packages/web/src/lib/markdownTargets.ts:43–44,97–99,121`](https://github.com/colinhacks/frizz/blob/5cf9f39ab42276215ad67e3958f067cae0c0d4af/packages/web/src/lib/markdownTargets.ts#L43-L44).

The browser cannot know the server's filesystem. Nevertheless, the new helper changes a raw `/C:/docs/plan.md` into `C:/docs/plan.md` on every platform. A POSIX directory may legally be named `C:`. The same problem affects images. The comment acknowledges the regression as an acceptable rarity, but it is avoidable.

The real browser classifier returned:

```text
input:   /C:/docs/plan.md
main:    { display: "/C:/docs/plan.md", posixPath: "/C:/docs/plan.md" }
PR:      { display: "C:/docs/plan.md", filePath: "C:/docs/plan.md" }
```

Passing the rewritten value into the actual macOS server resolver returns `Local path must be absolute`. The review did not create a directory at the filesystem root; it verified the destructive rewrite and downstream rejection independently.

**Required change:** preserve raw single-slash absolute paths in the browser. The PR already normalizes `/D:/…` inside `resolveLocalFile` and `resolveLocalImage` only on Windows, where the OS is known. Let those functions own that conversion, including decoded `file:` URL pathnames. There is no need to trade POSIX correctness for Windows support. Preserve the existing explicit editor-link grammar without adding a broader raw-path rewrite.

## Smallest correct fix and impact

Keep the `posixPath` → `filePath` rename and populate it for Windows drive paths. All production readers of the field are in the same classifier/renderer pair and were updated. This is an internal representation change, not an RPC, persistence, or public API migration. Keep the single-letter URL-scheme guard: `x://host/p` now remains a URL instead of an inert local control. Remote `file://host` destinations remain non-actionable; do not add UNC/network-share support to this fix.

Keep Windows-only leading-slash normalization at the two server entry points, ideally through one small shared helper. Remove the browser's redundant normalization. Keep realpath, regular-file checks, and the existing authorization split.

Two implementation choices:

1. **Recommended: revise the PR in place.** Fix containment with filesystem-aware comparison, add native Windows coverage, and remove raw browser unrooting. This retains all intended fixes. Main files: `packages/web/src/lib/markdownTargets.ts`, `markdownTargets.test.ts`, `markdown.ts`, the browser fixture/test, `packages/server/src/local-file.ts`, `local-file.test.ts`, `local-image.ts`, and image-route coverage in `app.test.ts`. The renderer work is low risk; containment needs the stronger Windows gate.
2. **Narrow the first landing.** Keep actionable Windows paths and server-only slash normalization, but omit the case-folding change until it has a safe implementation. Smaller authorization impact, but the reported mixed-case rejection remains unresolved and must not be described as fixed.

No broad refactor or new dependency is needed. The proactive survey covered relative/home resolution, editor URLs, plain inline-code paths, saved file links, reader/opener routing, live-watch eligibility, and image routing. Saved file URLs already use server-side `fileURLToPath` in `packages/server/src/thread-links.ts:17–21`; the browser's previous POSIX-only actionable field is the shared failure for the Markdown surfaces.

Trim the new historical/all-caps comments to the behavior being preserved. Correct touched comments that still describe images as POSIX-only or trusted-root-confined; the actual image endpoint intentionally accepts any absolute regular image behind its HTTP origin gate. The PR body should not claim POSIX paths are untouched or containment is unchanged.

## Verification and CI

Executed on macOS against the exact PR head, using installed external dependencies with workspace-package links redirected into the isolated review worktree:

| Command | Result |
| --- | --- |
| `nub run typecheck` | Passed |
| `nub --test packages/web/src/lib/markdownTargets.test.ts packages/server/src/local-file.test.ts packages/server/src/app.test.ts` | 43 passed; 2 Windows-only tests skipped |
| `nub run test:e2e -- packages/web/src/lib/localFileMarkdown.e2e.test.ts` | 1 passed; actual headless Chrome, stubbed backend responses |
| `nub --test board/*.test.mjs` | 73 passed |
| `nub scripts/sync-portable-monitors.mjs --check` | Passed |
| `nub --test monitors/*.test.mjs` | 16 passed |

An initial typecheck accidentally resolved workspace packages from the shared checkout and failed on unrelated newer types. That setup was corrected before the passing run; the initial errors are not attributed to this PR. The full provider-driven suite was not run. No native Windows reads, watches, desktop launches, or case-sensitive-directory tests were independently executed. The author's Windows verification is useful but remains author-supplied evidence.

GitHub remains red at the reviewed head:

- The [CI check](https://github.com/colinhacks/frizz/actions/runs/34963124134/job/104361183268) tested synthetic merge `6dddb9b9205644773ce1852837bd0b18b50f4bf6`, merging the PR into `dc493b98830cc8e96efc7bab5102e6c9eeb438b3`. It failed `monitors/portable-monitors.test.mjs:58`, expecting `/dispatch a SUB-AGENT to own the wait/` in worker guidance. That base's guidance uses different casing/wrapping; these files are untouched by the PR. This explains why the standalone PR-head run passes while the recorded merge run fails. It is not a file-link regression or a green merge gate.
- The [Pullfrog run](https://github.com/colinhacks/frizz/actions/runs/34963125106) encountered `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`, then terminated with `The usage limit has been reached`. It produced no substantive review.

Before acceptance, rerun checks against the revised integration head and exercise native Windows file and image reads with the two missing regressions above. Existing tests cover normal POSIX behavior, malformed encoding, URL-scheme separation, reader/opener routing, origin rejection, symlink behavior, and ordinary out-of-root denial. They do not pin case-distinct Windows siblings or preservation of raw POSIX `/C:/…` paths; there is also no added native Windows image-normalization test.

The owned Chrome exited and both Vite instances were closed. No product styling changed, so an optical-spacing pass was not needed for this review.

## Local evidence

The differential harness and raw results are retained in `.ntwine/threads/34b7874a-d89b-42ba-a69f-73c7c7c0b4a4/reproduce.mjs` and `reproduction.json`; the CI-command output is in `ci-monitors.log`. The harness expects the PR checkout at the sibling `pr-37` directory with dependencies installed. Recreate that detached worktree at the reviewed head before rerunning `NTWINE_E2E_STATIC_VITE=1 nub .ntwine/threads/34b7874a-d89b-42ba-a69f-73c7c7c0b4a4/reproduce.mjs`.
