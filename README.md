<p align="center">
  <h1 align="center"><img src="assets/logo-ntwine/final/tile.png" alt="" width="104" height="104"><br/>Ntwine</h1>
  <p align="center">An opinionated agent console for extreme productivity.
    <br/>
    by <a href="https://github.com/ssalbdivad">@ssalbdivad</a>, from an original design by <a href="https://x.com/colinhacks">@colinhacks</a>
  </p>
</p>
<br/>

<p align="center">
<a href="https://opensource.org/licenses/MIT" rel="nofollow"><img src="https://img.shields.io/github/license/ssalbdivad/ntwine" alt="License"></a>
<a href="https://www.npmjs.com/package/ntwine" rel="nofollow"><img src="https://img.shields.io/npm/dw/ntwine.svg" alt="npm"></a>
<a href="https://github.com/ssalbdivad/ntwine" rel="nofollow"><img src="https://img.shields.io/github/stars/ssalbdivad/ntwine" alt="stars"></a>
</p>

<br/>

Ntwine is for you if you have any of these opinions:

- Terminal UIs are dated and have fundamental limitations that are incompatible with good user experience.
- Orchestrator-style apps like Conductor feel overly complex.
- It's annoying to constantly switch between sessions to check in on my agents' progress.

Ntwine is a browser tab, a queue, and the agent CLIs you already pay for. Every agent that comes to rest needing you becomes a card, and you work the cards instead of polling ten terminals.

> **Attribution.** Ntwine began as Frizz, and its original design — the queue, the board and the principles below — is [Colin McDonnell](https://github.com/colinhacks)'s, from [colinhacks/frizz](https://github.com/colinhacks/frizz). Ntwine is [David Blass](https://github.com/ssalbdivad)'s standalone continuation: it keeps every one of those principles and adds the features listed under [What Ntwine adds](#what-ntwine-adds).

<br/>

<h2 align="center">Getting started</h2>

**Requirements.** Node 22.13+, and a [Claude Code](https://claude.com/claude-code) or [Codex](https://developers.openai.com/codex) subscription you are signed in to. Ntwine brings its own pinned copy of each CLI (downloaded once, on first start), so the version on your PATH never changes what a thread runs. Any agent that speaks the [Agent Client Protocol](https://agentclientprotocol.com) — OpenCode, Gemini CLI, GitHub Copilot CLI, Cursor's agent, goose, Qwen Code and more — runs too, from your PATH.

Run it from anywhere. A project is any folder you add: a repo, a jj checkout, or a folder of scripts. Ntwine has no opinion about version control and does not require Git.

```sh
$ npx ntwine

  NTWINE v0.4.0  ready in 4.0s

  ➜  Local:    http://127.0.0.1:9393/project/acme/
  ➜  Project:  acme — path/to/acme

  press ctrl-c to stop · run with --debug for the full event feed
```

A browser tab opens on acme's board, because acme is already a project. In a repository Ntwine has not seen it asks whether to add it, and anywhere else it opens **All projects**; running the command never makes a project by itself. The first time, a short tour points out the four things on the board. Ntwine listens on port 9393 (19393 if something else holds it), and one server serves every project on the machine, so a second run joins the server already running. Runs on macOS, Linux and Windows.

<p align="center">
  <img src="assets/board.png" alt="Ntwine focused on one project: the prompt box and the project's threads on the left, and on the right the first queue card, where an agent asks whether the settings store should use SQLite or a JSON file, with numbered options and a countdown to the recommended pick." width="100%">
</p>

<br/>

<h2 align="center">Principles</h2>

Colin designed Frizz, the original, around a few commitments. Every feature Ntwine adds is held to them too.

**The agent decides, and Ntwine checks.**

- **A thread's state is its agent's own last word.** The final message says whether the work is done, needs you, or is waiting on something, and Ntwine only checks that it holds up. There is no status field to set.
- **Ntwine never acts on an agent's behalf.** It does not answer, withdraw, park or queue for one. The few deliberate exceptions are listed below.
- **What must outlive a message is recorded.** A question, a finish and a watch are rows, not sentences, and a wait always names what it waits on.
- **A gate can refuse, and it has no bypass.**
- **A question stays open until it is answered, dismissed or withdrawn.** Typing past it leaves it open. Nothing retracts it by omission.
- **Every card can be answered or archived.** Nothing enters the queue just to be dismissed, and a running thread never enters it.

**The board shows what is true, densely.**

- **Five bands: Pinned, Queue, Running, Snoozed, Done.** Every thread is in exactly one, no view loses that, and on a board the first three never fold.
- **Projects stay separate.** The default view is one project's board. All projects is one click away.
- **Density over decoration, and few settings.** The default view shows at least as much as Colin's original board at heavy load (17 projects, ~70 threads), and [a test](packages/web/src/capacityParity.e2e.test.ts) holds it there.

**Ntwine is the process that outlives the agent.**

- **One server, every project.** Agents run detached and talk to Ntwine over pipes, so closing the tab, the browser or Ntwine itself never stops a turn.
- **A wait outlives the session that set it.** A watch on a pull request, an issue or another thread lasts as long as the server does, for years if need be, and wakes the thread the moment CI settles, a review or comment lands, or the other thread answers. Agents respond on their own, without polling and without you relaying.

**Ntwine brings nothing of its own.**

- **No model of its own.** Ntwine drives your CLIs on your sign-in. The few small model calls it makes itself run on your Claude sign-in.
- **No workflow of its own.** No branches or worktrees behind your back, no build steps, and no universal timeout on a background shell, since some run for days.

**Where Ntwine bends one, on purpose.** Each is argued in [`ARCHITECTURE.md`](ARCHITECTURE.md#where-ntwine-acts-on-a-clock-or-with-a-model) and can be turned off or ignored:

- A question the agent marks as safe to default, unanswered 10m after its thread rests, takes the agent's recommended option; never one that posts, merges, publishes or spends. Every other question waits for you. The × under the card turns it off.
- A parent waiting on its sub-agents is asked for a progress note every 30m, so a long fan-out never shows one stale line for hours.
- Thread names, status lines, Auto effort and reading a schedule out of a prompt use your Claude sign-in. `NTWINE_THREAD_NAMER=0` and `NTWINE_AUTO_EFFORT=0` turn them off.
- A clean worktree in `.ntwine/worktrees` idle for 7d is removed; its branch is kept. **Settings → Remove idle worktrees after** turns it off.
- Single-key shortcuts (`j`/`k`, `r`, `d`, `s`) are on. `?` lists them and rebinds any of them.

<br/>

<h2 align="center">Features</h2>

- 🗂️ **A task queue, not a sidebar.** Every agent that comes to rest needing you becomes a card. Work the queue top to bottom.
- 📁 **Projects.** Every folder you add gets its own board at `/project/<name>`, all on one server.
- 🔌 **Headless.** Every agent runs in its own detached background process. Close the tab, ctrl-c the server, reboot: your threads are still there, and Ntwine reconnects to the ones still running.
- 🤖 **Claude Code, Codex and any ACP agent.** Pick the agent per thread and run several against the same repo at once, on your sign-in, your settings and your skills.
- ❓ **Answerable questions.** An agent hands back numbered options with its own recommendation, so the common answer is one keystroke.
- 😴 **Snooze.** Park a card for an hour, until tomorrow morning, or until a date you pick, optionally with a follow-up prompt it wakes up working on.
- 🎯 **Goals.** A standing prompt Ntwine re-sends at every rest, on a clock, or both: "keep going until CI is green" without re-asking.
- 🐙 **GitHub.** Turn issues and pull requests into threads from the composer. Workers read issues, diffs and CI, and never write unless you ask.
- 👀 **Watchers.** A worker waiting on CI, a review or a reporter's reply watches, and picks the work back up when something lands. A watch outlives the agent's session.
- 📱 **Remote access.** Press R in Ntwine's terminal to reach it from your phone: a private frizz.sh name, a Cloudflare Tunnel, Tailscale, or a proxy of your own.
- 🔒 **Local only.** No cloud, no account, no telemetry. The server binds `127.0.0.1`, and its state lives in your user directory, never in your checkout.

<br/>

<h2 align="center">What Ntwine adds</h2>

- **Threads that address each other**: every thread has an `@handle`, and agents read, message and wait on other threads by it. `#slug` names a project.
- **Spinoff**: start a new thread from any card, carrying its context, without interrupting the one you are reading.
- **Snooze until sub-agents return**: a queued parent waiting on its sub-agents parks until every one is back, and each return still wakes it.
- **Thread names and status lines**: a stable name for every thread, a one-line status (a hover on a board), and Auto effort.
- **First-run onboarding**: a new browser picks a project, then gets a short tour of its board. **Take the tour** in ⌘K replays it.
- **Schedules**: type "every weekday at 9am triage new issues" and the prompt box reads the schedule as you type. Each run starts a fresh thread.
- **Time limits**: give a thread `2h` or `15:30`. The agent plans the best result it can deliver by then, its sub-agents get a share, and the card counts down. Running out never interrupts a turn.
- **Thread terminals**: press `t` on a thread, or start a prompt with `$ npm test`, for a shell in the folder its agent works in. It stops when the thread is done.
- **Home**, a board for work that belongs to no project yet: cloning a repo, a question about your machine. It is the switcher's last choice.
- **A VS Code, Cursor and Windsurf extension**: Ntwine in the editor's sidebar. Your selection goes with your message (⌘L), agents can read what you have open, and a thread's changes open as a multi-file diff.
- **Keyboard first**: single-key shortcuts for the queue, listed under `?`, every one rebindable.
- **Slash commands**: Claude Code's own, plus prompts of yours that work on every agent.
- **Files and pictures in Ntwine**: a reader that follows a file as it is saved, and a viewer that zooms, pans and pages through an agent's screenshots.
- **Usage**: a quota chip that warns before your plan runs out, and an optional Fable fallback for new Claude threads.
- **Housekeeping**: thread info (tokens, turns, cost), deleting done threads you have not touched in a while, and keeping the machine awake while an agent works.
- **All projects** at `/all`, the next step after Colin's project sidebar: every project's threads down the left, every waiting card beside them, never interleaved. A project's board stays the default, and the sidebar stays as he ships it, opt-in under **Settings → Project sidebar**.
- **[frizz.sh/docs](https://frizz.sh/docs)**: the full docs, one page per feature.

<br/>

<h2 align="center">The queue</h2>

When an agent comes to rest needing you, a card is added to the queue. You read what it has done since your last message, then answer its questions, steer it, snooze the card, or mark the thread done. Every action item is in one place, in the order it arrived.

The queue is strict about what earns a card, which is what keeps it a real to-do list. A thread resting only because its own sub-agents are working, or waiting on CI, a review or a timer, isn't waiting on you, so it stays out. Nothing shows up just to be dismissed.

**Threads are built to run without you.** A worker keeps going until it reaches something only you can settle — a product call, a fork where guessing wrong is expensive, an irreversible action — and then hands back an answerable question rather than a wall of text.

<p align="center">
  <img src="assets/question.png" alt="A question card asking whether the settings store should use SQLite or a JSON file, with option 1 marked recommended, a row for typing something else, and below it the prompt box." width="100%">
</p>

Options are numbered — press a number or click to pick, Enter to send — and a worker marks the one it recommends. There is always a row for writing something else, and a typed reply leaves the question open. When the answer isn't one thing, the card takes several: check any combination and add a note. When the agent needs you to *do* something it can't — sign in, press a button — the card lists the steps over one **Done** button.

<br/>

<h2 align="center">Projects</h2>

Each project's **board**, at `/project/<name>`, lists its threads under the five named bands, its cards beside them, and a prompt box that starts threads in it. A working thread's status shows when you point at it. `npx ntwine` in a project opens its board, and `http://127.0.0.1:9393/` opens whichever view you had last.

**All projects**, at `/all`, is the first choice in the switcher above the prompt box. It lists your projects with the threads in flight under each, and every waiting card beside them. Each row still says its band by its mark: a pin, a rest time, a spinner. A project's snoozed and done threads are counts on its row; click one to list them in place.

<p align="center">
  <img src="assets/projects.png" alt="The All projects page: billing-worker, marketing-site and acme-api each list their threads on the left, and the cards from every project are queued on the right." width="100%">
</p>

<br/>

<h2 align="center">GitHub, snooze, goals</h2>

Browse the repo's issues and pull requests from the composer, select any number, and each becomes its own thread. Workers read issues, diffs and CI on their own, but never comment, label, close or merge unless you ask.

<p align="center">
  <img src="assets/github.png" alt="The GitHub picker listing a repo's open issues with comment, reaction and linked-PR counts, three of them checked, and a Start 3 investigations button." width="100%">
</p>

**Snooze** parks a card for an hour, until tomorrow morning, or until a date you pick. Attach a follow-up prompt and the thread wakes up already working on it.

<p align="center">
  <img src="assets/snooze.png" alt="The snooze menu opened from the alarm clock in a queue card's header, offering 1h, tomorrow, 1d, 3d, 1w and a custom time." width="100%">
</p>

A **goal** is a prompt Ntwine sends every time the agent comes to rest, on a clock, or both. A clocked send reaches the agent mid-turn without cutting off its work, and a goal can stop itself after a number of sends or a span of time.

<p align="center">
  <img src="assets/goal.png" alt="The goal panel open above a queue card's prompt box: a goal saying to keep going until the test suite is green, sent at every rest and every 30 minutes." width="100%">
</p>

<br/>

<h2 align="center">Schedules and time limits</h2>

Write a recurring prompt the way you'd say it — "every Monday at 9am triage new issues", "first weekday of the month bump deps". The prompt box shows the rule it understood and when it next runs before you press Enter; × if you didn't mean a schedule. The next run waits in Snoozed, where you can skip it, move it or run it now. An agent can propose a schedule, and it never runs until you turn it on.

<p align="center">
  <img src="assets/schedule.png" alt="The prompt box reading 'every weekday at 9am triage new issues' as a schedule: the phrase highlighted, the send button turned into a repeat button, and a strip reading 'Every weekday at 9am · next Thu Oct 8, in 22h'." width="100%">
</p>

The stopwatch beside the model gives a thread a limit: `2h`, or a clock time like `15:30`. The card counts down, turns amber near the end and red once over, and its chip extends or removes the limit.

<p align="center">
  <img src="assets/time-limit.png" alt="A queue card whose header shows a 43m left countdown, with the time-limit panel open: +15m, +30m and +1h, a field for a new limit, and Remove time limit." width="100%">
</p>

<br/>

<h2 align="center">CLI</h2>

```text
npx ntwine [options]

  --no-app               print the URL without opening a browser
  --port <port>          request a fixed port for a new workspace server
  --sandbox              a disposable Ntwine to try things in: throwaway home and project, its
                         own port, deleted when this terminal closes; credentials are shared
  --link                 print a fresh single-use access link for the running board
  --sessions             list the devices signed in to the running board
  --sign-out <id|all>    sign one device out, or every one of them
  --status               report the board running for this project: address, pid, version
  --stop                 stop the board running for this project (running agents keep going)
  --debug                stream the full event feed to the terminal instead of the compact readout
```

In the terminal running Ntwine, **R** sets up remote access and **L** shows a fresh single-use sign-in link as a QR code.

<br/>

<h2 align="center">FAQ</h2>

<details>
<summary><b>Does Ntwine run its own agent or model?</b></summary>

> No. It drives Claude Code, Codex or an ACP agent under the account you are signed in to. Its own small jobs — naming a thread, its status line, choosing an effort for Auto, reading a schedule from a prompt — are short calls on that same Claude sign-in; `NTWINE_THREAD_NAMER=0` and `NTWINE_AUTO_EFFORT=0` turn them off, and each falls back to doing without. Ntwine runs its own pinned copy of each CLI; set `NTWINE_CLAUDE_BIN` or `NTWINE_CODEX_BIN` to point it at another.

</details>

<details>
<summary><b>Does anything leave my machine?</b></summary>

> Nothing from Ntwine. There's no account, no telemetry, and the server binds to `127.0.0.1`; reaching it from another device is something you switch on yourself. The agents talk to their providers and `gh` talks to GitHub, but Ntwine is a local process looking at local files.

</details>

<details>
<summary><b>What happens if I close the tab?</b></summary>

> Nothing. Each agent runs in its own detached process, independent of the browser *and* of Ntwine itself. Stop Ntwine and your agents keep working; relaunch, and it reconnects to the sessions still running.

</details>

<details>
<summary><b>Does it put junk in my repo?</b></summary>

> Barely. Starting a thread writes no file into your repo: the agent session *is* the thread. Ntwine adds a `.ntwine/` directory holding a scratch folder per thread (empty unless the agent writes something), a few small state files, and `.ntwine/worktrees` once an agent makes a git worktree. `.ntwine/` ignores itself with a `.gitignore` of its own, so it stays out of `git status`, and Ntwine never touches yours. Everything durable lives in your user directory (`~/.ntwine/` if you have one, else `~/Library/Application Support/Ntwine`, `$XDG_DATA_HOME/ntwine` or LocalAppData), so deleting `.ntwine/` loses no thread or setting.

</details>

<details>
<summary><b>Do I have to use worktrees?</b></summary>

> No. Ntwine doesn't own your git workflow and won't create branches or worktrees behind your back. Tell your agents what you want in `NTWINE.md`. If they put worktrees in `.ntwine/worktrees`, Ntwine removes one once it has been idle for 7d and is clean, keeping its branch and anything git can't restore, like a `.env`; **Settings → Remove idle worktrees after** changes the wait or turns it off. If you do run Ntwine inside a linked worktree, it isolates that worktree's state from its siblings automatically.

</details>

<details>
<summary><b>Can I reach it from my phone, or from anywhere?</b></summary>

> Yes. Press **R** in the terminal running Ntwine and pick a private frizz.sh name (unguessable, no account), a Cloudflare Tunnel, Tailscale, or a proxy of your own. Ntwine stays on `127.0.0.1` in every case, the first visit from each device needs a single-use sign-in link, and `npx ntwine --sessions` / `--sign-out` manage the devices. (Custom frizz.sh names are paused for now; a board that already holds one keeps it.) Every project added or removed, thread started, message sent and question answered is recorded in `logs/audit.jsonl` under Ntwine's data folder, with the device that did it. Remote access exposes every project on the server. See [Remote access](docs/remote-access.md); try it first with `npx ntwine --sandbox`.

</details>

<details>
<summary><b>How is this different from the other orchestrator apps?</b></summary>

> Those apps wrap your agents in their own workflow. Ntwine doesn't: it's a viewer and a queue over the CLIs you already run, with every piece of orchestration judgment in editable text instead of inside the binary.

</details>

<br/>

<h2 align="center">Glossary</h2>

| Term | What it means |
| --- | --- |
| **Project** | A folder you added, with its own board at `/project/<name>`. **All projects**, at `/all`, shows every one. |
| **Thread** | One effort, start to finish. The agent's session *is* the thread. |
| **Worker** | The agent driving a thread: a real Claude Code, Codex or ACP process, running as you. |
| **Sub-agent** | A helper a worker dispatches for one prong of its task, listed under its parent as `@parent.child`. |
| **Handle** | A thread's short name, `@port-the-parser`, used to mention, read and message it. |
| **Bands** | **Pinned** (your shelf), **Queue** (resting, needs you), **Running** (working now), **Snoozed** (parked until a time or an event), **Done**. |
| **Question** | An answerable choice an agent hands back, with numbered options and a recommendation. |
| **Goal** | A standing prompt a thread receives at every rest, on a clock, or both. |
| **Schedule** | A prompt plus a recurrence, in plain words. Each run starts a fresh thread. |
| **Time limit** | A deadline a thread plans around and its card counts down to. |
| **`NTWINE.md`** | An optional file at your repo root, injected into every thread. |

<br/>

<h2 align="center">Docs</h2>

- [frizz.sh/docs](https://frizz.sh/docs): every feature, remote access, the CLI and the FAQ.
- [`ARCHITECTURE.md`](ARCHITECTURE.md): the invariants, layout and design decisions. Read it before changing anything.
- [`NTWINE.md`](NTWINE.md): this repo's own worker norms, as a worked example.
- [The VS Code extension](packages/vscode/README.md).

<br/>

<h2 align="center">Contributing</h2>

Issues and pull requests are welcome. Fork the repo, branch off `main`, and open the PR against `main`; CI runs on every pull request. Keep **Allow edits by maintainers** checked (GitHub offers it only on forks in a personal account, not an organization), so a follow-up commit from the maintainer can land in your PR rather than separately on `main`. Three checks run there, and they need no install:

```sh
$ node --test board/*.test.mjs
$ node scripts/sync-portable-monitors.mjs --check
$ node --test monitors/*.test.mjs
```

Everything else runs locally: install with `pnpm install`, typecheck with `pnpm typecheck`, and run the full suite with `pnpm test`. That suite drives real agent CLIs and a real browser, which is why CI does not gate on it, so say in the PR what you ran. It needs current Node 22.x or ≥ 23.4; early 22.x point releases (22.15 measured) fail `receipt-bus.test.ts` on a since-fixed test-runner defect.

<br/>

<h2 align="center">License</h2>

MIT
