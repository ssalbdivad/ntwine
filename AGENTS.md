# Principles: never break one without explicit confirmation

Colin McDonnell designed Frizz ([colinhacks/frizz](https://github.com/colinhacks/frizz)), the original, and David Blass maintains Ntwine, its standalone continuation. Each line below is a decision one of them made on
purpose and has said matters most. **Do not write code, copy, docs or worker-contract text that breaks one unless the
maintainer has explicitly confirmed it in the current conversation.** If a task seems to need it, that is a question to ask
first, not a call to make. An approval given for one case does not carry over to the next. Detail lives where each line
points.

**How a thread hands off (original design; ARCHITECTURE.md § How a thread hands off its state)**
- The worker's own last word decides its thread's state, and Ntwine only checks it. There is no status field: the final
  message is the interface, and its fence language is the state.
- Ntwine never answers, withdraws, parks or queues on a worker's behalf. The few deliberate exceptions are listed in
  § Where Ntwine acts on a clock or with a model, and adding one needs confirmation.
- A row beats a sentence. What must outlive a message is registered (`done`, `ask`, `watch`), and a wait always takes the
  awaiting fence.
- A gate can refuse, and it has no bypass. A parameter on the gated call that skips the gate is not a gate.
- A question is a row with a lifecycle. It stays open until it is answered, dismissed or withdrawn with `unask`; Ntwine
  never retracts one by omission.
- Every queue item can be answered or archived. Nothing enters the queue just to be dismissed, and a running thread never
  enters it.
- The worker contract states rules, not rationale. A new rule earns its tokens only if a worker measurably gets it wrong
  without it (header of `packages/server/src/workerPrompt.ts`).

**The board (original design; § Board nomenclature)**
- Every thread is in exactly one of five rails (Pinned, Queue, Running, Snoozed, Done), and no view may lose that
  distinction. On a board, Pinned, Queue and Running never fold.
- Projects stay separate. The default view is one project's board at `/project/<slug>`; All projects lives at `/all`.
- The default view shows at least as much as upstream's board at heavy load (17 projects, ~70 threads).
  `packages/web/src/capacityParity.e2e.test.ts` is the bar.
- Density over decoration, and few settings.
- One server serves every project. Nothing Ntwine runs on its own uses a pty or tmux.
- Ntwine brings no model of its own: the few calls it makes itself (names, status lines, Auto effort,
  schedule reading) run on the operator's Claude sign-in, each with a `NTWINE_*=0` off-switch.
- Upstream takes changes in pieces: soundness fixes first, never a wholesale structural change.

**Working here (David)**
- Copy says what the human can do, never how Ntwine works. It is sentence case, and durations use one grammar.
- Never run unmerged code against the maintainer's live Ntwine data (`~/.local/share/ntwine`). Use a disposable stack (the
  `ntwine-stack` skill).
- Preserve evidence: never delete or rewrite a stored measurement. Experiments are temporary: record the conclusion and
  its numbers, then delete the harness. Keep benchmarks few.
- Report honest effect sizes. Treat the maintainer's pushback as a bug report on the measurement before defending a
  result.
- Be terse with the human: lead with what changed or what is true. The why goes in commit messages and code comments.
- Size work by scope, never in days. "Shipped" means merged.
- Use `nub` for the toolchain, and write every new script as `.ts`.
- Never interrupt a running agent (§ Agent completion invariant).
- A worker snoozes a thread only while its own task still waits on something (a merge the human asked for, CI
  that could fail it, a release, a reply). Following a FINISHED thread's PR or issue is the human's choice, made
  from its done card, never a worker's silent park (2026-10-07: a comment-only push sat 180d in Snoozed).

# Git: how work lands here

**Contributing from your own fork.** Ntwine takes pull requests. Fork the repo, branch, open a PR against `main`, and CI runs on it — see [Contributing](README.md). **Keep "Allow edits by maintainers" checked on every PR you open** (GitHub offers it only on a fork owned by a personal account, not an organization, so fork into your own account), so the maintainer can push a follow-up commit onto your branch; with it cleared the push is rejected, and the follow-up lands on `main` separately after the merge instead of in your PR (maintainer 2026-10-10, on upstream PR #56). `gh pr create` leaves it on unless passed `--no-maintainer-edit`; a PR opened through the REST API needs `"maintainer_can_modify": true` in its `POST /repos/ssalbdivad/ntwine/pulls` body. Nothing else in this section concerns you.

**Working in the maintainer's own checkout** — which is every agent Ntwine dispatches on that machine, and every sub-agent it dispatches in turn — read [`AGENTS.local.md`](AGENTS.local.md) FIRST and follow it, because the git rules there are strict and this is the most-violated one in the repo: that checkout does NOT use pull requests, at all, ever. Finished work is committed to its local `main`, and `gh pr create` is always the wrong move there. The same file covers committing out of a working tree other agents are editing concurrently, which has its own traps.

# Cutting a release — `release` is what ships, and a dispatch is what starts it

**Releases belong to ONE dedicated releaser thread, and it is not you unless the maintainer told you to cut one.** Every other thread's job ends when its work is committed to local `main`: land it there, and the releaser picks it up with everything else since the last release. Never cut a release, bump a version in `package.json` or `packages/server-release/package.json`, move or push `release`, or dispatch the workflow on your own initiative — and never OFFER to: no "want me to cut a patch?", no release option in a question, no "this needs a release to reach users" as a follow-up in your handoff. Saying the change is on `main` is the whole report (maintainer 2026-10-11: *"there's a dedicated releaser agent … threads should just get all their stuff merged into main, but never offer to cut releases"*). The procedure below is for that releaser, and for a thread the maintainer explicitly asked to cut one.

Ntwine publishes to npm from the [`release`](.github/workflows/release.yml) branch, never from `main`. `main` moves under you — several agents land on it continuously — so the commit you verified and the one that would publish are routinely different, and a release from `main` carries whatever happened to arrive in between. `main` answers "has this landed?"; `release` answers "has this been VERIFIED and chosen to ship?", and only the second is ever released (maintainer 2026-09-08: *"you can bump these versions and do your own testing independent of whatever's landed on `main`"*). **`release` is a fast-forward pointer into `main`, never a fork.** It holds no commits of its own: you move it to the `main` commit you tested. If it ever needs a non-fast-forward push, stop and look rather than forcing it.

**No push publishes anything (2026-09-23).** Moving `release` selects the commit; a maintainer's `gh workflow run release.yml --ref release` is what starts a release. A `workflow_dispatch` needs a GitHub session or token carrying write access, which a stolen git push credential does not give — so a credential that can push can no longer ship a package.

When the maintainer says "cut a patch" or "cut a release", this is the whole job, in order:

1. **Bump the package that changed on `main`.** Server, frontend and provider-runtime changes bump `version` in [`packages/server-release/package.json`](packages/server-release/package.json); ordinary server updates leave the stable root `ntwine` version alone. Launcher changes also bump root [`package.json`](package.json). A new shell's `ntwineServer.version` names its exact compatible bootstrap server. **That pin only reaches a machine with no server yet**: everyone else keeps the server they have until they click Update, so a new shell on a server several releases old is the ordinary pairing. A shell that depends on something a server release learned raises `ntwineServer.minimum` to that release in the same commit, and a machine below it is then started on the pinned server instead ([`plans/server-side-launch-routing.md`](plans/server-side-launch-routing.md) § 7). Protocol/data-epoch changes require an explicitly compatible shell and server together; see [`plans/stable-server-publishing.md`](plans/stable-server-publishing.md). Commit version changes as `chore(release): <package> X.Y.Z`; patch bumps remain the default.
2. **Look at what ships with you.** `git log release..HEAD` is the exact set. Anything there you have not verified either gets verified now or gets left behind by pointing `release` at an earlier commit — that choice is the whole reason the branch exists.
3. **Verify the commit you are about to publish, not "the tree".** `nub run typecheck` and `nub run test` against that sha. Typecheck is the workflow's own gate, deliberately not the full suite: the suite drives real provider CLIs and a real browser and has never run on a CI box, so it runs HERE, before the push, or the release goes out untested.
4. **Push `main`, then fast-forward and push `release`.** `git push origin main`, then `git branch -f release <sha> && git push origin release`. This chooses the commit that will ship; it starts nothing. It is the one push the no-PR rule in [`AGENTS.local.md`](AGENTS.local.md) does not reach — that rule forbids pushing a branch to STAGE A REVIEW, and a release push stages no review.
5. **Dispatch the workflow.** `gh workflow run release.yml --ref release`. This is the only thing that starts a release, and the workflow refuses any ref but `release`. **It also refuses to publish a version that does not directly follow the highest one npm serves** ([`npm-refuse-overtake.sh`](.github/scripts/npm-refuse-overtake.sh)): npm serves two versions held in its review in whichever order it likes, and on 2026-10-11 it served `ntwine` 0.13.11 eighteen minutes before 0.13.10, which had been accepted nearly six hours earlier. So never dispatch a release while an earlier version of the same package is still in review — wait for npm to serve it and re-run. Only when the number in between was never published at all (its run was cancelled before the publish step) does the dispatch take `-f allow_version_gap=true`.
6. **Watch the run to the end, and do not call it cut until npm serves both versions.** `gh run list --workflow=release.yml --limit 1` names the run; `gh run watch <id> --exit-status` follows it. The workflow typechecks, publishes `ntwine-server` through npm Trusted Publishing, waits until the registry serves it, and only then publishes `ntwine`: the shell fetches its pinned server from the registry on first boot, so a live shell with no server behind it is broken for whoever installs it in that window. A direct publish is not served at once — npm holds each new version in automated review (6m 40s for 0.13.5 on 2026-09-14; pullfrog has measured up to 236 minutes) — so the job polls the registry through that hold. A green run therefore means npm serves both versions. Both waits share one deadline under the job's six-hour cap; if it expires, re-run the job once npm serves the version, since each package keeps its own registry existence check and a publish npm is still reviewing is tolerated. A publish that fails with `E403 OIDC permission denied for this action` means the package's trusted publisher on npmjs.com does not allow `npm publish`; a maintainer must allow it there. (Staged publishing, where every version waited for a maintainer's 2FA approval, ran from 2026-09-22 and was dropped on 2026-09-30 as too onerous. The dispatch-only trigger stays.) If the run dies after npm accepts a package, `gh workflow run release.yml --ref release` finishes it without republishing.
7. **Tag the shell and create its GitHub release yourself: `nub scripts/tag-release.mjs`.** Run it once the run is green, from your own `gh` session; it is idempotent, so run it after every release, server-only ones included. Tags `vX.Y.Z` and GitHub releases belong to the shell only and target its registry-recorded `gitHead`, never a checkout, and an existing tag is never moved. The workflow did this until 2026-10-12 and no longer can: GitHub refuses a workflow's own token a ref whose commit carries a different `.github/workflows/` than the run's checkout, which is the usual case once a later run reconciles an earlier shell (ntwine 0.13.13). Your `gh` session has the workflow scope; the job now has read-only access to the repository (maintainer 2026-10-12: the releaser tags after the run).

**A version bump on `main` is INERT until step 5 dispatches the workflow.** Pushing `main` publishes nothing, and neither does moving `release`; that silence is by design, and it is why step 4 has two pushes and step 5 exists at all. Release checks must compare both public manifests against their respective npm packages; a provider pin now ships in `ntwine-server`, not necessarily a new shell. The trap that has actually broken releases at the install step — `pnpm install --frozen-lockfile` disagreeing with a lockfile `nub` wrote — and the full reasoning live in [`plans/runtime-pin-bumps.md`](plans/runtime-pin-bumps.md) § Then the releaser ships it.

# Web UI completion rule — proportionate, not reflexive

Browser QA is for the changes where a browser is what actually settles the question, not for every diff
that happens to touch a `.tsx` file. Judge the change in front of you.

**Drive it in Chrome, and carry the evidence in your handoff** (inspected screenshots, console/page-error
check, the optical-review result, explicit browser-cleanup confirmation) when the change is: a new or
restructured surface, layout or interaction flow; anything judged OPTICALLY — spacing, alignment, colour,
truncation, a glyph beside text; behaviour you cannot predict from the code alone (live state, timing,
streaming, restart/recovery, a seam between processes); a fix no test pins where the bug actually lives;
or anything large, cross-cutting, or that you are unsure of.

**Skip it for the small and the certain** — a targeted fix in code you have read, pinned by a test at the
right level, with a blast radius you can name; docs, comments, types, provably mechanical edits; and
anything with no browser surface at all (prove that in its own real runtime). Then say plainly in the
handoff what you verified and how, so the maintainer can weigh the call. Confidence is earned, never
asserted: "it should work" is not confidence, a green unit test over a stubbed seam is not either, and
you never describe something as driven or verified when it was not.

**Load the skill that matches what you need**, and compose them — they were one 300-line skill until
2026-08-08, which meant a backend fix had to read the browser rules and a CSS tweak had to read the
stack rules:

- **`ntwine-stack`** — boot a real, fully-isolated disposable Ntwine (`scripts/adhoc-stack.mjs`), including
  the multi-project/tenant case, and seed real state through its own RPC surface.
- **`headless-browser`** — take the shot without putting a window on the maintainer's screen
  (`scripts/shot.mjs` is the DEFAULT; Chrome DevTools MCP second, and only because this repo forces it
  headless through its own `.mcp.json` — Ntwine mounts no browser into the workers it dispatches),
  which states and widths to capture, browser process hygiene (one owned instance per task;
  never a global close or a broad `pkill`), and how to embed evidence so Ntwine renders it inline.
- **`real-subsystem-harness`** — for behavior no browser can reach: the broker socket, spawn/exec
  paths, migrations, a detached daemon's environment. Real resource, real function, negative control.

# Agents never touch the maintainer's real Chrome

**No agent launches, scripts, attaches to, or reads the profile of the installed Google Chrome — not headless, not on a throwaway profile, not for one screenshot** (maintainer 2026-10-11: *"an agent should not be allowed to drive my real Chrome. Ever"*). Every browser an agent starts is puppeteer's own `chrome-headless-shell` on a temp profile, through `launchHeadless()` in [`scripts/lib/headless-browser.mjs`](scripts/lib/headless-browser.mjs). `scripts/shot.mjs`, every `verify-*` script and every e2e test go through it, and a scratch driver you write imports it too rather than calling `puppeteer.launch`. That file's header has the measurements behind each choice, including why it is the headless shell and not "new" headless: the full Chrome for Testing app made the Dock flicker once per launch, 187 times in 40 minutes.

- **Why the binary matters even on an empty profile.** The signed Google Chrome is the one program macOS lets read the "Chrome Safe Storage" keychain item without asking. That binary pointed at a COPY of the real profile, with a debugging pipe attached or `--dump-dom`, is the maintainer's logged-in sessions. Nothing else on the machine can do that silently, so the rule is about the binary, not about which profile it is given.
- **What it rules out, by name.** `"/Applications/Google Chrome.app/…"` in any command; `executablePath`, `channel: "chrome"` or `CHROME_PATH` in a script; `open -a "Google Chrome"`; `osascript` aimed at Chrome; anything under `~/Library/Application Support/Google/Chrome`; and `chrome-devtools-mcp` run any way but through [`scripts/chrome-devtools-mcp.mjs`](scripts/chrome-devtools-mcp.mjs) — the server's default browser IS the installed Chrome, and its `--autoConnect` / `--browserUrl` attach to the one already running.
- **What enforces it.** `scripts/browser-launch-policy.test.mjs` fails the suite on a launch outside the launcher, a script that names the installed Chrome, or an agent config that bypasses the wrapper. On the maintainer's machine a `PreToolUse` hook (`~/.claude/hooks/no-real-chrome.sh`) refuses the command forms above, and a Chrome managed policy (`RemoteDebuggingAllowed: false`, `HeadlessMode: 2`, delivered as a configuration profile) makes the real browser itself refuse a debugging pipe or a headless start, whoever asks. If one of them stops you, the task does not need the real browser. Do not route around it; ask.
- **`src/browser.ts` is a different thing, not an exception**: the product opening the HUMAN's browser for them (`ntwine --app`). It is not automation, and no agent calls it to drive a page.

# Never put a macOS keychain dialog on the maintainer's screen

**Every command that starts a Chromium directly carries `--use-mock-keychain`**: a `--headless` screenshot, `--print-to-pdf`, `--dump-dom`, or a script that builds the command line. Chrome stores its "Chrome Safe Storage" key in the login keychain when it starts, and macOS finds that keychain through `HOME`. Under a temporary `HOME` with no keychain, which is what every sandbox here gives its workers, the write fails with `errSecNoDefaultKeychain` (-25307) and macOS puts a modal *"Keychain Not Found — A keychain cannot be found to store "Chrome.""* on the maintainer's screen, once per Chrome start. 23 Chrome processes did that in two lightbox e2e runs on 2026-10-03, all started by sandboxed workers obeying a prompt that said to use headless Chrome from the command line (maintainer: *"It's still fucking happening"*).

- `scripts/shot.mjs`, `launchHeadless()`, Puppeteer and the chrome-devtools MCP pass the flag already. The rule is for a raw command line you build around the headless shell (`await puppeteer.executablePath({ headless: "shell" })` is its path; the installed Chrome is never the browser, see the section above), and for every prompt you write that asks a sandboxed worker for a browser: the worker runs whatever command it writes, so put the flag — and the launcher — in the prompt.
- **Never give a sandbox `HOME` an empty keychain to make the dialog stop.** Claude Code reads the keychain before `~/.claude/.credentials.json`, and its next token write into an empty keychain deletes that file. Under `--creds` that is the maintainer's real file, through the `.claude` link (`update()` in the secure-storage fallback of Claude Code 2.1.288). `ntwine-stack` § A real Claude worker covers sandboxes.
- To name the process after the fact: `/usr/bin/log show --last 1h --style compact --predicate 'eventMessage CONTAINS "MacOS error: -25307"'`. A Chrome in that list took the dialog path; a `security` or `codex` there only read the keychain. (In zsh, a bare `log` is a builtin.)

# Visual alignment is the implementer's job, not a review someone else does

**Load the `visual-review` skill whenever you place an icon, glyph, emoji, badge, chip, or counter next
to text — and before you declare any new UI correct.** It carries the ink-measurement routine, the
per-glyph offsets it produced, and the instrument bug that makes a naive baseline probe report ~3x the
real error. Two non-negotiables from it:

- **You are the first reviewer of your own screenshot.** Capturing evidence is not reviewing evidence.
  Read the shot back and actively hunt for what is wrong with it — a glyph riding high, mismatched visual
  weight, a collision at a narrow width. Never hand over a screenshot you have not personally critiqued.
  Capture at a scale where the detail is judgeable; a 40px component inside a 1400px shot cannot be
  reviewed, and glancing at it counts for nothing.
- **Icon-beside-text alignment is an INK problem, and every glyph differs.** `items-center` centers a
  glyph's BOX on the flex line; the eye aligns ink. A digit has no descender, an SVG's ink sits wherever
  its path falls inside its viewBox, an emoji ignores your font size — so one shared nudge cannot fix a
  cluster. Measure each glyph, correct each in `em`, then re-measure and confirm the residual is ~0.

**And load the `optical-spacing` skill whenever you set or judge the spacing of a ROW of controls** —
an icon strip, a button rail, a footer of mixed glyphs and pills. The same law sideways: `gap` spaces
boxes, so a bare glyph in a hover square and a bordered pill on one uniform `gap` drew ink distances
from 5.78px to 20.50px on a single strip. It carries the ink-gap instrument (this repo's copy is
`scripts/ink-gaps.mjs`), the negative-margin fix, and the pen-width rule for matching perceived weight
— which no colour token can fix. It is a GLOBAL skill, not one of this repo's, so it needs no entry in
`.agents/skills/`.

## Every UI change gets an OPTICAL SPACING PASS before you call it done — no exceptions, no threshold

Any time you implement or touch any UI, measure the spacing the eye actually reads before you hand it over. This is not conditional on the change looking like an "icon strip", and not something to reach for only when someone complains. It is the last step of implementing UI, the same way running the tests is the last step of implementing logic.

- **Two marks on one line ARE a row.** A label and its chevron. A gerund and its elapsed clock. A badge beside a title. If you can name two things sitting side by side, the skill applies — that is the reading that keeps getting missed, because "row of controls" sounds like a toolbar and a disclosure row does not.
- **A `gap` is not a distance.** It spaces BOXES, and small glyphs are mostly empty box. Lucide's chevron paints 4.67 of its 14 box px, a third of dead space per side — so `gap-1` beside its label and `gap-2` before its clock drew **9.06px and 13.00px** of ink where the CSS claimed 4 and 8, and the chevron floated equidistant between the two instead of reading as the label's handle (maintainer 2026-08-05: *"Fix the fucking optical spacing on that chevron"*). Nothing in the CSS looks wrong; you only see it by measuring the pixels.
- **Run the instrument, both axes.** `scripts/ink-gaps.mjs` for horizontal ink gaps, the `visual-review` ink routine for vertical ink-vs-cap-band. One caveat that will bite: once a negative margin makes boxes overlap, `ink-gaps.mjs` unions the NEIGHBOUR's ink into the mark and reports nonsense — switch to geometry then (an SVG child's `getBoundingClientRect` IS its ink box; canvas `actualBoundingBox*` gives a string's ink edges).
- **Then look at it, cropped, at dsf 6–8.** The numbers say whether the gap is what you set; only the picture says whether what you set is right. Both failures happened here in one sitting: shipping 9.06px because the CSS said 4, then over-collapsing to 4.4px because the trim was correct and the target was not.
- **THE APP RENDERS IN SANS, BUT THE STYLESHEET STILL DEFAULTS TO MONO — set `data-font="sans"` on any fixture you measure on.** The prose/UI font was a user setting until 2026-09-19 (`html[data-font="sans"|"mono"]`; maintainer: *"let's drop monospace as an option"*), and the setting is gone: `index.html` pins `data-font="sans"` on the `<html>` tag and no user can reach the mono family. The sheet's structure is unchanged, though — its sans rules still key on that attribute, so a fixture page that does not set it silently renders the mono default nobody sees in the product: a chevron measured there at a 0.00px residual rode visibly high in the maintainer's sans window (2026-08-05: *"this is awful"*). Sans is the only reading that matters now; the per-font measurements in `styles.css` and the components are kept for the day the attribute is dropped, not as a second target.
- **Prefer a correction the BROWSER computes to one you fit by hand.** `1cap` is the resolved font's cap height, so `self-baseline` + `translate-y-[calc(0.5em_-_0.5cap)]` puts a symmetric 1em glyph's ink exactly on the cap band **in any font, at any size**, with nothing to re-measure when the setting flips or the type scale moves. Reach for a measured `em` constant only where no derivable reference exists — and say which font you measured. (`align-self: baseline` needs a shared baseline to align against: if the row is `items-center`, the glyph has nothing to align to and silently lands ~1px off. Make the row `items-baseline`.)
- **Put the corrections in ONE place with the readings in the comment,** not per call site. Three chevrons in one column each placed by hand had drifted into two vertical offsets, two tones, and a horizontal rhythm nobody had ever measured. They are measurements, not taste — the next reader has to know to re-measure rather than re-guess.

Do not ship "it renders" and wait to be told it looks wrong. If the pattern exists in a real product
(GitHub, Linear, this app's own components), measure the real one and mirror it instead of designing
from taste.

# Copy says what the human can do, never how Ntwine works

A card, banner, toast or empty state tells the operator what is true and what they can do about it — in
the fewest words that do that. It never recites internal machinery: no worker-contract vocabulary ("done
card", "registered wait", "sign-off", "handoff", "fence"), no scheduler behaviour ("Ntwine nudges it"), no process
mechanics ("the process exited"). Pick the message that is most USEFUL at that moment and stop; the
mechanism belongs in a code comment. Before: "The worker stopped without a done card, a question or a
registered wait. Ntwine nudges it for one; a reply here also wakes it." After: a one-line card,
"Reply to continue." (David 2026-09-29.)

# Copy capitalization: sentence case, never title case

All user-visible copy uses SENTENCE case — capitalize only the first word and any proper nouns. This
covers button and menu labels, headings, section titles, toasts, and thread titles. Never Title-Case
Every Word (write "Confirm snooze", "Mark as done", "Fix queue focus" — not "Confirm Snooze", "Mark As
Done", "Fix Queue Focus"). Acronyms (PR, CI, API) keep their established casing. When an agent titles a
thread, the same rule applies.

**"Ntwine" is a proper noun — always capitalize it in prose.** The product is Ntwine; write "Ntwine
dispatches a worker", never "ntwine dispatches a worker". Lowercase survives only in literal
identifiers, where it is part of the name: `npx ntwine`, `NTWINE.md`, `.ntwine/`, `~/.ntwine/`,
`ntwine-<slug>` session names, the `ntwine`/`ntwine-update` CLIs, and the `ntwine:*` skill and sub-agent profile names.

# Durations: ONE grammar, every reading — `40m`, `2h 35m`

Every duration and relative age the product renders uses one spelling, and it is not negotiable per surface (maintainer 2026-08-31, after finding five of them in one app: *`"40 minutes" -> "40m"` … `2hr 35m` … Use this stylization everywhere. EVERYWHERE*, then, hours corrected the same evening: *h is better than hr*).

**The units are `ms` · `s` · `m` · `h` · `d` · `w` · `mo` · `y`.** The unit is a SUFFIX glued to the number with no space (`40m`, never `40 min` and never `40 minutes`), and a compound reading joins at most two of them with one space (`2h 35m`, `3d 4h`, `12m 05s`). Every unit is ONE letter except months, which are `mo` because a bare `m` is already minutes — so hours are `h`, never `hr` and never `hour`.

- **The canonical statement, with the reasoning, is the header comment of [`packages/web/src/lib/durationLabels.ts`](packages/web/src/lib/durationLabels.ts)**, and a test in that directory pins it as a SHAPE, so a reading that reverts to `40 min`, `12 minutes` or `1hr 5m` fails rather than shipping. Relative ages share one ladder in [`activityTime.ts`](packages/web/src/lib/activityTime.ts) (`ageLadder`) for the same reason: three copies of it had already drifted, and one carried a `0y ago` bug the other two also had.
- **It reaches past the browser.** The same grammar spells the cadence in a Goal's trailer, the elapsed in a worker's wake header (`you last spoke 3h 12m ago`), the quota chips, the `ntwine --sessions` CLI, and the board CLI's ETA. A worker reads its own duration readings; two vocabularies teach it there are two.
- **What is NOT unified is the LADDER** — which units a reading climbs to, and how much precision it keeps. A countdown pads and ticks (`3h 05m`), the runtime slot drops seconds past a minute, a tool call keeps them, the GitHub cards stop at `2w` and then give a date. Those are per-surface behaviours with their own documented reasons; only the SPELLING is shared.
- **The `for:` fence vocabulary is a separate contract that happens to agree.** `30s` / `15m` / `2h` / `3d` is a grammar the worker WRITES and Ntwine PARSES, defined in the worker contract; the card echoes the worker's own token back. It reads identically to the house grammar today, which is a coincidence worth not relying on — a change to one must never be applied to the other by sweep, because restyling the fence breaks the parse and the contract at once.
- **Running prose keeps its words.** "expires in 5 minutes" in a help line is a sentence, not a reading. The grammar governs a duration rendered as a VALUE: a column, a chip, a label, a status tail, a countdown, a tooltip.

# ONE server, EVERY project — never one per repo

Ntwine is a SINGLETON. One server on one origin serves every project on the machine, each named by a URL prefix (`/project/<slug>/…`). It ran one server per repo until 2026-08 and the change is recent enough that stale statements survive in comments, docs and muscle memory — `ARCHITECTURE.md` itself still said "One server per repo" in one bullet while explaining the singleton in another, and the README still promised "one server and one tab per repo" (both corrected 2026-08-19).

The practical consequences, because getting these wrong produces working-but-wrong code and copy:

- **Nothing is scoped to "the repo you launched from."** A command does not serve *a project*; it starts *the server*. Copy that says "serve this repo" is wrong, and so is a CLI shape that takes a repository path to decide what to serve.
- **`--host` / `--public-origin` / a tunnel expose EVERY project**, not the one you are standing in. Any auth story has to be told at that altitude.
- **A second launch JOINS the running server rather than starting one**, so flags on it are not applied — the launcher now refuses rather than ignoring them silently (`352455e`).
- Full detail, including the characteristic bug (another project's data rendered under this project's URL), is in `ARCHITECTURE.md` § "URL shape (one server, every project — the singleton)".

# There is NO tmux. Agents are detached broker daemons

Agents ran in tmux panes once, and the vocabulary outlived the transport by weeks: a `tmux_name` column, a `NTWINE_LAUNCH_TMUX_SOCKET` launch variable, hundreds of comments in `router.ts`, `tailer.ts` and `dispatch.ts` narrating a pane, and 53 seed scripts opening a dummy pane nothing read. Every agent that read them eventually told the maintainer that stopping Ntwine was safe "because the agents are in tmux" — wrong, and saying the wrong reason cost real trust. **That vocabulary was swept out on 2026-08-19.** The column is `thread_name`, the launch variable is gone, no script execs or installs tmux, and `packages/server/src/tmux.ts` has not existed since 2026-08-02. Check it in ten seconds with `grep -rn tmux --include='*.ts' packages/server/src`.

What actually happens: a Claude thread is `claude_runtime="broker"`, and `claude-broker-host.ts` forks a daemon with `detached: true, stdio: "ignore"` into its **own process group**. That single fact is the answer to most operational questions — Ctrl-C on the server signals the launcher's group and cannot reach the daemon, so a running turn survives a stop; its events queue in a 20,000-frame backlog rather than dropping while nothing is attached, and the bridge replays them on reconnect. Sub-agents live inside that daemon's SDK session, so they ride along too.

**So: never tell the operator anything about tmux, and never repeat "the agents are in tmux" as a reason a restart is safe.** It is safe, for a different reason, and saying the wrong one has cost real trust here. Exactly one tmux reference survives on purpose — `isTmuxServer` in `orphan-reaper.ts`, which refuses to reap a tmux server process, because upgrading from a pre-cutover Ntwine can leave one holding panes an operator is still reading. Everything else that still says tmux is either dated design history under `plans/` (left as a record, not as guidance) or something the sweep missed; treat the second kind as a bug and prefer `git log -S` over believing it.

# No agent runs in a pty. Everything Ntwine runs on its own talks over pipes

Nothing the server runs on its own opens a pseudo-terminal. A Claude thread runs in the session broker, a Codex thread in the app-server, an ACP agent over newline-delimited JSON-RPC — all pipes. Provider sign-in runs nothing at all: the sign-in modal behind `/login` shows `claude auth login` / `codex login` for the human to run in their own terminal, then re-reads the credential. Sign-in was the last pty — an embedded terminal on node-pty and the `/term` socket — until 2026-09-24; node-pty publishes no Linux prebuild, so every Linux and WSL install died at boot on `import "node-pty"` (upstream PR #42). The maintainer then chose the command alone over keeping any hosted sign-in, and `/term` went with it.

**So: never propose a pty, node-pty, or "just run it in a terminal" for an agent, for sign-in, or for anything else the server does on its own, and never describe sign-in or an agent as running in one.** If a CLI seems to need a TTY, prove it over pipes first — both provider logins were assumed to need one and neither did. `scripts/verify-linux-package.mjs` (run it in Docker; its header has the command) boots a packed Ntwine on a Linux box with no C++ toolchain.

**One exception is real: a terminal the HUMAN opens on a thread.** The drawer's ⋯ menu (Open terminal), `t`, or a `$ npm test` line in a thread's prompt box starts a shell command — or a bare shell — in the folder that thread's agent is working in, and it belongs to that thread: no row of its own, a line in the thread's strip, stopped when the thread is marked done (ARCHITECTURE.md § Board nomenclature). `server/src/thread-terminals.ts` owns one node-pty process per terminal, and `/term/<id>` (`terminal.ts`) streams it to xterm.js. That is the only pty and the only `/term` traffic. It shipped first (2026-09-23) as top-level terminal command threads from a Terminal tab in the prompt box; on 2026-09-29 the maintainer folded it into threads and made the addon lazy. **This exception is the fork's and still needs sign-off from upstream** — upstream's objections were the extra thread kind and a pty on the boot path, and the reshape answers both, but it is upstream's call.

**node-pty is loaded LAZILY, and that is load-bearing.** `await import("node-pty")` runs on a terminal's start and nowhere else; no server module imports it at load (`thread-terminals.test.ts` fails if one does, with `import type` exempt). So a box where the addon will not load — no prebuild for its platform, a broken install — boots and serves every project, and the terminal pane says why it could not start (#42 was the eager version of this killing every Linux boot). Both the source server and the published `ntwine-server` depend on `node-pty@1.2.0-beta.15`, the beta that ships glibc Linux prebuilds; the server generation installs `--ignore-scripts` and node-pty loads its prebuild directly, so no install script and no `node-gyp` fallback ever runs, and it needs no `onlyBuiltDependencies` entry (`src/package-contents.test.ts` pins all of that). Sign-in and agents stay off it.

Two more things look like exceptions and are not. node-pty is a ROOT `devDependency` for `scripts/verify-product-e2e.mjs` alone, which drives the launcher's interactive readout and never ships. "PTY" in the Codex code (`codex-app-server.ts`, `transcript.ts`) is Codex's own logical terminal handle inside its app-server, not an Ntwine process.

# Board nomenclature: "active" means SPINNING, and nothing else

The sidebar's row groups have names the maintainer uses precisely (2026-08-05: *"when I say active, I'm only referring to the things that are currently spinning; the things beneath that, I would refer to as rested, or just items in the queue"*). The UI labels the same bands with the original names, **Queue** and **Running** (`BANDS` in `web/src/components/BandLabel.tsx`, since 2026-10-06), and the two vocabularies map one to one: say Queue and Running in copy; in code, comments and when reporting back say either pair, never both in one sentence. (The quote says "beneath" because Rested sat below Active when it was said; on 2026-08-08 the two bands SWAPPED position — the cue moved up under the prompt box — and the vocabulary did not change with them.)

Every thread Ntwine started is in exactly one of five bands, top to bottom:

- **Pinned** — the human's shelf, above everything. A pinned thread stays here, whatever it is doing, until it is unpinned.
- **Queue** — the maintainer's **Rested**, the CUE: directly under the pins, the same set as **"the queue"** / "items in the queue", one row per card, each with a right-justified rest time.
- **Running** — the maintainer's **Active**: the rows below that rule, in practice the ones currently spinning. Never carries a queue card, and never a rest time — the rule is drawn on the CARD, so a thread the server excused from the queue while it rests lands here too, and so does an archived thread whose worker is still running, until it rests (see `ARCHITECTURE.md`).
- **Snoozed** — the dimmed park band (an armed timer, a wall-clock snooze, the resting card's event-snooze, a rest its worker called `status: watching`). A limit pause was a member until 2026-08-31; it queues as a failed thread now. It was called **Held** until 2026-08-26; the group key moved with the label, so `sectionOf` returns `"snoozed"` and nothing reads `"held"` any more.
- **Done** — the archived section.

**External** (agent sessions Ntwine did not start) is listed apart, never a sixth band. A project's board (`/project/<slug>`, the default view) names all five under headers, and Pinned, Queue and Running never fold; a working row's status there is a hover, with only its clock on the line. All projects (`/all`, one click away; a bare `/` goes back to whichever view the browser showed last) names none — each row says its band by its own mark (a pin, a rest time, a spinner), its status inline — and a folded project's row counts its Pinned, Queue and Running.

The trap is that `sectionOf` (`@ntwine/shared`, re-exported by `groups.ts`) returns `"active"` for Running AND Queue rows alike — that key names the `<section>` holding both bands, not the maintainer's word — and the band keys are still the fork's old labels, `ready` (Queue) and `working` (Running). `partitionActive` splits the section (`.running` = Running, `.rested` = Queue), and `inActiveBand` is the one predicate that means Running exactly. Full detail, including why the archived key is `"inactive"` while its label reads Done, in `ARCHITECTURE.md` § Board nomenclature.

# "Shipped" means merged into the primary branch

Never describe a created, opened, or pushed PR as "shipped." An open PR is implemented, pushed,
ready for review, or awaiting merge. Use "shipped" only after the change has actually been merged
into the repository's primary branch. This applies to progress updates, final handoffs, and signal-card
bullets.

# No timetable estimates — size work by scope, not by days

Never estimate work in human time ("~1 day", "2–3 days", "a week"). Agents build here, so the build
itself is minutes to hours, and the wall clock is set by review, verification and the maintainer's
decisions. A day count borrowed from human engineering means nothing (David 2026-10-01). Say what
the cost actually is: the surfaces and files it touches, which existing code paths change, the risk, and
what needs the maintainer's review or a decision.

# Project-local skills and tools are shared across agents

Any project-local skill or tool lives in ONE agent-neutral copy that every agent configuration
discovers — never a per-agent fork. Skills live canonically in `.agents/skills/<name>/` (Codex
discovers this path natively); `.claude/skills/<name>` is a relative symlink into that canonical copy
so Claude Code discovers the identical content. When adding a skill, create it under
`.agents/skills/` and add the symlink; verified end-to-end 2026-07-21 with `adhoc-cdp` (Claude lists
it through the symlink, `codex exec` resolves it at `.agents/skills/<name>/SKILL.md`) — that skill has
since been split into `ntwine-stack` / `headless-browser` / `real-subsystem-harness`, which is also the
shape to copy: **one skill, one job**, cross-linked, rather than a single file every caller must skim. Shared
tooling scripts follow the same rule: one copy in an agent-neutral location (e.g. `scripts/`),
referenced from skills — never duplicated into agent-specific config trees.

**A GLOBAL skill takes the identical shape one level up**: canonical in `~/.agents/skills/<name>/`,
with relative symlinks at `~/.claude/skills/<name>` and `~/.codex/skills/<name>` (both `../../.agents/…`
— `~/.codex/skills` is two levels deep, not one, and getting that wrong yields a dangling link that
still `ls`es fine). A global skill must BUNDLE any script it needs beside its `SKILL.md`; it cannot
reach into a repo's `scripts/`. And a skill belongs in exactly one scope — never a project copy AND a
global copy of the same name, or they drift and the agent lists it twice.

# Use Nub for the Node toolchain

Prefer Nub over direct `node`, `npm`, `npx`, `pnpm`, `yarn`, `tsx`, or `ts-node` commands. Run
JavaScript and TypeScript files with `nub <file>`, package scripts with `nub run <script>`, installed
CLIs with `nubx <tool>`, tests with `nub --test`, and installs with `nub install`. Nub transpiles
TypeScript but does not typecheck it, so keep `tsc --noEmit` and project typecheck gates separate.

# Always `.ts`, never `.mjs`

Every new script, seed, verifier, harness or tool in this repo is a `.ts` file — never `.mjs`, `.js` or
`.cjs`, even though most of `scripts/` is still `.mjs` and even when you copy one of those as a template
(David 2026-10-01: "always use .ts never .mjs"). `nub` runs `.ts` directly, so there is no build step
to save. The existing `.mjs` files are legacy: run them as they are, but do not add to them by example.

# Agent completion invariant

Once spawned, an agent runs to its terminal return. Do not interrupt or cut off an active agent to
reduce churn, reclaim slots or quota, redirect work, respond to a user steer, contain live-server
instability, or hurry completion. Deliver new direction through the agent's message/follow-up path,
then reconcile obsolete or conflicting results after it returns. Mid-turn interruption can leave
partially applied edits, tests, and owned processes behind, making the resulting repository state
unsound. Isolate or restart only the affected unstable service; never stop a writer to stabilize it.
If an agent appears hung or continuing would be dangerous, use the interactive question path to ask the
user. The sole exception is an explicit user instruction that names the interruption.
