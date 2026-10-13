// @ts-check
/**
 * ntwine-tools — every capability Ntwine hands its own WORKERS, as ONE registry: the definition of each
 * command (name, summary, description, input schema, how its arguments are spelled on a command line)
 * and the handler that performs it. Dependency-free, and transport-free: a front-end imports TOOLS and
 * HANDLERS and decides how a call arrives and how its answer leaves.
 *
 *   bin/ntwinectl      — the command line a worker runs from its own shell. THE worker surface.
 *   bin/ntwine-mcp.mjs — the same registry over MCP stdio, for a worker dispatched before the CLI.
 *
 * A new worker-facing capability joins the TOOLS registry below rather than growing a second surface.
 *
 * Every handler is a thin wrapper over one of Ntwine's own RPCs: it reads the running server's port from
 * a server.lock and POSTs `/_ntwine/<project>/rpc/<procedure>`. That surface has no token auth — only a
 * loopback-origin CSRF gate — so a headerless local POST with `sec-fetch-site: same-origin` (undici
 * sends no Origin) satisfies it.
 *
 * NOTHING HERE DEPENDS ON THE ENVIRONMENT STAYING TRUE. A worker lives inside a DETACHED daemon that
 * outlives Ntwine restart after restart, so anything frozen into it at spawn is a bug waiting for the
 * next "Update & Restart" to move the port. Both facts we need are therefore resolved PER CALL, from
 * files: the server's address (serverLockPort — the env hint, then the machine-wide
 * `<ntwine root>/server.lock`, then any live project lock, skipping any whose pid is gone) and our own
 * project (projectSegment — the stamp, else `.ntwine/.id` walked up from our cwd). The env is a hint
 * that saves a lookup; the filesystem is the truth.
 *
 * A handler NEVER takes the caller's thread from its arguments: threadSlug() reads it from the
 * environment the worker was started with, which is what stops one thread acting as another.
 */
import { readFileSync, readdirSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative } from "node:path"

// Comfortably above a codex dispatch's bounded rollout-discovery wait (~15s) PLUS the server's bounded
// wait for a spawned thread's name (router.ts SPAWNED_NAME_WAIT_MS, 10s), so a legitimate slow dispatch
// is never aborted client-side (which would make the worker think it failed and retry, double-spawning).
// The server completes regardless; this is only the client's patience.
const DISPATCH_TIMEOUT_MS = 45_000

const SPAWN_THREAD = {
  name: "spawn_thread",
  description:
    "LAST RESORT — try the two cheaper exits FIRST. Follow-up work you discovered is not a reason to spawn: " +
    "if you could DO it (dispatching an in-session sub-agent, whose result comes back to you, so the work " +
    "lands on YOUR card under one review), do that instead; if the user should choose, ASK instead. " +
    "Spawn a brand-new, separate top-level ntwine thread — its own board card, session, and scratchpad, " +
    "driving INDEPENDENTLY. This is FIRE-AND-FORGET: the new thread reports to the USER on the board via " +
    "its own final message, and its results come back to you, the caller, only if it sends them with " +
    "`ntwinectl message-thread` — which its prompt is told it can, and which you must ASK for in that prompt if you " +
    "need them. Its end never re-invokes you as a sub-agent's does. It is NOT an in-session " +
    "sub-agent. It returns the new thread's `@handle` — name it by that in your handoff, where the board " +
    "links it, exactly as you would name any other thread. " +
    "USE IT ONLY for a distinct, self-contained effort that belongs on the board in its own right and whose " +
    "output you do NOT need to read. Do NOT use it for a helper whose result you must COLLECT and fold into " +
    "your own work — a self-review, a verification pass, a research prong, a critic, any collect-back helper: " +
    "those are in-session sub-agents (Claude: the Agent tool with `run_in_background`; Codex: native " +
    "delegation), which return their findings to you. Spawning such a helper here STRANDS it — its work lands " +
    "on another card and never reaches you, so you gain nothing. " +
    "Because nothing it learns returns to you OR to its siblings unless somebody messages it across, a chain of " +
    "spawned threads re-derives the same facts in parallel and nobody notices — measured here: one thread " +
    "spawned four, three of those spawned more, and three descendants independently rediscovered the same " +
    "root cause over twenty hours. " +
    "Spawn only when the work genuinely cannot ride on your own card: a different repo, a different long-lived " +
    "runtime, an effort that must outlive yours. Never spawn merely to clear your own `done` fence. " +
    "You MUST deliberately choose `model` and `effort` to match the NEW thread's task complexity — they are " +
    "required, there is NO default. Do not reflexively pick the cheapest; a hard task on a weak model/effort " +
    "wastes the whole thread.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "The full task/prompt for the new thread's worker. Be self-contained — the new thread starts with empty context.",
      },
      model: {
        type: "string",
        description:
          "REQUIRED — pick by the NEW task's complexity; there is no default. For the `claude` backend: " +
          "`opus` (the TOP tier — hardest reasoning, architecture, subtle correctness/security, adversarial " +
          "review, the fix that must land), `sonnet` (ordinary substantive implementation/research), `haiku` " +
          "(simple, fully-specified mechanical work). Do NOT pick `fable`: Opus 5 is just as good and cheaper, " +
          "so a high-intensity task takes `opus` at a higher `effort`, not a different model — `fable` only " +
          "when the user explicitly asks for it. For " +
          "the `codex` backend use a codex model id instead (e.g. `gpt-5.6-sol`/`gpt-5.6-terra`/`gpt-5.6-luna`). " +
          "Match the model to the backend you choose. Bias toward Opus/a strong model when the task is " +
          "non-trivial or its outcome is load-bearing.",
      },
      effort: {
        type: "string",
        enum: ["low", "medium", "high", "xhigh", "max"],
        description:
          "REQUIRED — reasoning effort, pick by complexity; no default. `low` only for trivial tasks; " +
          "`medium` for routine work; `high` for ordinary substantive work; `xhigh` for hard coding/agentic " +
          "work; `max` for the single hardest problems. (Codex also accepts `ultra`.)",
      },
      backend: {
        type: "string",
        enum: ["claude", "codex"],
        description: "Optional agent backend (default `claude`). If `codex`, `model` must be a codex model id.",
      },
      project: {
        type: "string",
        description:
          "WHICH PROJECT the new thread starts in — the slug the board shows it under (`arktype`, `ntwine`, " +
          "`home`), its name, or its checkout path (`~/arktype`). Omitted ⇒ YOUR project. The thread runs in " +
          "that project's checkout and shows on that project's board, so set it whenever the work lives in a " +
          "different repo than yours — from the Home project above all, which holds no repo of its own. A " +
          "prompt that names another project's checkout by path (`~/arktype/…`) with no `project` is " +
          "refused, and the refusal lists every project.",
      },
      title: { type: "string", description: "Optional name for the new thread: one or two SHORT words naming its subject — its kebab-case handle (\"Shell budgets\" → @shell-budgets) at most 20 characters — distinct from the project's other open threads. A longer one is ignored and ntwine names the thread from the prompt instead." },
    },
    required: ["prompt", "model", "effort"],
  },
}

// The Goal's LIMITS, mirrored from @ntwine/shared (GOAL_MAX_RUNS, GOAL_MIN/MAX_FOR_SECONDS, and the
// `for:` grammar's regex) for the same reason the timer bounds are: this file cannot import them, and a
// wrong value should be refused HERE, with an explanation, rather than come back as an HTTP 400.
const GOAL_MAX_RUNS = 10_000
const GOAL_MIN_FOR_SECONDS = 60
const GOAL_MAX_FOR_SECONDS = 30 * 24 * 60 * 60
const GOAL_FOR_RE = /^(\d{1,5})(s|m|h|d)$/
const GOAL_FOR_UNIT_SECONDS = { s: 1, m: 60, h: 3_600, d: 86_400 }

const GOAL = {
  name: "goal",
  description:
    "Arm a GOAL on YOUR OWN thread: one piece of text that ntwine re-sends you, on any or all of three " +
    "triggers, for as long as it is armed. The board shows it as the thread's Goal. (This command was " +
    "the `recurring_prompt` tool until 2026-08-28 — a summary or note that says so means this one.)\n\n" +
    "  --stop-hook           — every time you come to REST. Use it to keep a long autonomous effort moving " +
    "without the user driving every step, and to rescue yourself from a wait that may never resolve.\n" +
    "  --heartbeat-seconds   — on a CLOCK, whatever you are doing. This one reaches you MID-TURN: it arrives as " +
    "a queued message you read at your next tool boundary rather than waiting for you to stop, and it " +
    "never aborts what you are running. Use it for something that must be revisited on a schedule no " +
    "matter what you happen to believe at the time.\n" +
    "  --post-compaction     — every time your CONTEXT IS COMPACTED, delivered into the emptied window. If " +
    "you keep notes in your scratch directory, a prompt that LINKS them comes back at the exact moment " +
    "you have lost everything else. Also mid-turn — a compaction happens while you are working.\n\n" +
    "Set at least one; any combination is fine.\n\n" +
    "MAKE IT A BOUNDED LOOP with `max_runs` and/or `for`. Either limit, once reached, DISARMS the goal " +
    "by itself — every trigger off, the text kept — and you get ONE message saying which limit ended it. " +
    "Without either it runs until you stop it, sign off, or the user switches it off. Every delivery " +
    "that actually reaches you counts as a run, whichever trigger sent it; `get` shows the count.\n\n" +
    "USE THIS RATHER THAN `CronCreate` or `ScheduleWakeup`. Those are Claude Code's own in-session " +
    "schedulers and they CANNOT fire in the runtime ntwine runs you in: their gate stays shut for as long " +
    "as ANY background task of yours is outstanding, so the moment you are parked behind a background " +
    "shell or a sub-agent — exactly when you most need waking — they go silent. This one is delivered by " +
    "ntwine itself and is unaffected.\n\n" +
    "READ IT BACK WITH `ntwinectl goal get` — and do that BEFORE any `start` that is not a fresh arming. A " +
    "thread has AT MOST ONE goal, so a `start` REPLACES whatever is there, triggers and all, " +
    "and the text you are about to destroy may not be yours: the USER can edit it in the thread footer, " +
    "and a compaction can take your own memory of arming it. `get` answers with the exact text currently " +
    "armed, which triggers are on, the cadence, and when each trigger last fired. Reach for it whenever " +
    "you are about to change one trigger and keep the rest, whenever you are unsure whether you are armed " +
    "at all, and after a compaction. (A `start` also reports what it replaced, so a blind overwrite is at " +
    "least a visible one.)\n\n" +
    "The text arrives VERBATIM as an ordinary user turn, so write it as an instruction to your future " +
    "self. At most one scheduled delivery is ever outstanding and its clock runs from the last one " +
    "DELIVERED, so you can never be handed a backlog at once.\n\n" +
    "STOP IT when the work it drives is done (`ntwinectl goal stop`) — one left armed on a finished thread " +
    "wakes it forever. The user sees it in the thread footer and can edit or switch it off there. " +
    "Signing off with a ```done fence stops it too, every trigger at once — but only when the work is " +
    "genuinely finished, because that files the thread away and a thread nobody is watching does not " +
    "restart itself.\n\n" +
    "You can only ever arm your OWN thread — there is no argument for anyone else's.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["start", "stop", "get"],
        description:
          "`start` arms (or replaces) this thread's goal; `stop` disarms it; `get` reads back " +
          "what is armed right now — the text, the triggers, the cadence and each trigger's last delivery " +
          "— without changing anything. `get` takes no other argument.",
      },
      prompt: {
        type: "string",
        description:
          "Required for `start`. The text delivered to you on every trigger, verbatim, as a user turn. " +
          "Make it self-contained and ACTIONABLE — say what to do and what would make it right to stop " +
          "— because you may receive it with none of the context you have right now.",
      },
      stop_hook: {
        type: "boolean",
        description:
          "Send it every time you come to rest. Defaults to true when neither `--heartbeat-seconds` nor " +
          "`--post-compaction` is given, so a `start` that names no mechanism still does the obvious thing.",
      },
      heartbeat_seconds: {
        type: "integer",
        description:
          "Also send it on this clock, in seconds (minimum 60, maximum 86400). Omit for no heartbeat. A " +
          "delivery is read at your next tool boundary, so a sub-minute cadence buys no promptness and " +
          "only talks over your own work.",
      },
      post_compaction: {
        type: "boolean",
        description:
          "Also send it every time your context is compacted, into the emptied window — useful when the " +
          "prompt links notes you keep in your scratch directory.",
      },
      max_runs: {
        type: "integer",
        description:
          `For \`start\`: stop after this many deliveries (1 to ${GOAL_MAX_RUNS}). The goal disarms itself ` +
          "once the last one has reached you, and you are told once. Omit for no cap.",
      },
      for: {
        type: "string",
        description:
          "For `start`: stop this long after arming — a duration in the same grammar as an ```awaiting " +
          "fence's `for:`, e.g. `30m`, `2h`, `3d` (at least `1m`, at most `30d`). The goal disarms itself " +
          "when it runs out, and you are told once. Omit for no time bound.",
      },
    },
    required: ["action"],
  },
}

// The ONE-OFF TIMER's bounds, mirrored from @ntwine/shared (this file is dependency-free by design and
// ships as a loose .mjs, so it cannot import them). The server validates the same numbers; these exist so
// a wrong delay is refused HERE, with an explanation, instead of coming back as an HTTP 400.
const TIMER_MIN_DELAY_SECONDS = 10
const TIMER_MAX_DELAY_SECONDS = 30 * 24 * 60 * 60

const TIMER = {
  name: "timer",
  description:
    "Set a ONE-OFF timer on YOUR OWN thread: a piece of text ntwine hands back to you at ONE instant, " +
    "ONCE. Your own alarm clock.\n\n" +
    "It is `goal`'s heartbeat with the repetition taken out, and it shares the property that " +
    "matters: the delivery reaches you MID-TURN — a queued message you read at your next tool boundary — " +
    "so it arrives when you asked for it whether or not you have stopped, and it never aborts what you " +
    "are running. Unlike a goal it fires exactly once and then is gone, so there is nothing " +
    "to switch off afterwards and nothing to sign off from.\n\n" +
    "You may have MANY armed at the same time, each with its own instant and its own text — they are " +
    "independent, unlike the single goal this thread can hold.\n\n" +
    "USE IT for anything you want to come back to at a specific time: re-check a deploy in ten minutes, " +
    "re-read a slow log at the top of the hour, revisit a decision after a build finishes. USE " +
    "`goal` instead when the thing must repeat, and remember that Claude Code's own " +
    "`CronCreate`/`ScheduleWakeup` cannot fire in the runtime ntwine runs you in.\n\n" +
    "IT IS NOT A WAY TO POLL SOMETHING YOU COULD WAIT ON. If a background shell, a sub-agent or a " +
    "monitor can tell you the moment a thing happens, use that — an alarm every N seconds asking \"is it " +
    "done yet\" is strictly worse than being woken when it is.\n\n" +
    "The text arrives VERBATIM as an ordinary user turn, so write it as an instruction to your future " +
    "self — self-contained and actionable, because you may receive it with none of the context you have " +
    "now. Give exactly one of `--in-seconds` or `--at`. You can only ever set a timer on your OWN thread.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["set", "cancel", "list"],
        description:
          "`set` arms a new one-off timer (it never replaces an existing one); `cancel` withdraws one by " +
          "`id`; `list` returns the timers currently armed on this thread. Every action answers with the " +
          "resulting armed list.",
      },
      prompt: {
        type: "string",
        description: "Required for `set`. The text delivered to you when it fires, verbatim, as a user turn.",
      },
      in_seconds: {
        type: "integer",
        description:
          `For \`set\`: fire this many seconds from now (minimum ${TIMER_MIN_DELAY_SECONDS}, maximum ` +
          `${TIMER_MAX_DELAY_SECONDS} — thirty days). Give this OR \`--at\`, not both. Sub-minute precision ` +
          "is not real: the delivery is read at your next tool boundary.",
      },
      at: {
        type: "string",
        description:
          "For `set`: fire at this exact instant, as an ISO-8601 timestamp (e.g. `2026-08-04T15:00:00Z`). " +
          "Give this OR `--in-seconds`, not both. Must be in the future and within thirty days.",
      },
      id: {
        type: "string",
        description: "Required for `cancel`. The timer id returned by `set` (or listed by `list`).",
      },
    },
    required: ["action"],
  },
}


const WATCH_PR = {
  name: "watch_pr",
  description:
    "REGISTER A PULL REQUEST and ntwine brings you back whenever something happens on it — CI turning " +
    "green or red, and every later review, approval or comment, from a user or a bot alike. Register " +
    "it, come to rest, and you are woken. Drop it when it stops mattering.\n\n" +
    "IT REPORTS REPEATEDLY, unlike a timer. One registration covers the whole life of the PR: CI goes " +
    "red, you push a fix, CI goes green, a reviewer comments — that is four wakes from one registration, and you " +
    "never have to re-register between them. It settles itself when the PR merges or closes, because " +
    "there is then nothing left to report.\n\n" +
    "REGISTER IT THE MOMENT YOU OPEN OR PUSH A PR. Nothing else watches for you: your runtime knows " +
    "nothing about GitHub, and an ```awaiting fence STATES what you are waiting on without creating any " +
    "wait at all. This command is the wait.\n\n" +
    "THE ```awaiting FENCE IS STILL WORTH WRITING, and it is a different job: it is how you come to REST " +
    "without ntwine asking you for a handoff, and how the user sees what you are waiting for. Register " +
    "the watcher with this command, then name the same PR in your fence's `prs:` list — and give the fence " +
    "the same long `for:` you gave the watcher, or the fence expires first and bumps you anyway.\n\n" +
    "GIVE AN EXTERNAL PR A LONG `--for` — MONTHS, up to a year. A pull request into a repo nobody here " +
    "controls moves on its maintainers' clock, not yours, and a short watcher on one expires against a " +
    "PR that has not changed: a wake with nothing in it, and a re-arm. Long costs nothing — real " +
    "activity still wakes you the instant it lands, and the user snoozes or archives the thread if " +
    "they want it off the board.\n\n" +
    "REGISTERING IS IDEMPOTENT per pull request: asking twice returns the SAME id and tells you it was " +
    "already armed, so re-registering after a compaction is safe and is the right instinct. Use " +
    "`ntwinectl watch-pr list` when you want to know what you are holding without changing anything — it " +
    "answers with each PR's current check state too.\n\n" +
    "You can only ever watch a PR on your OWN thread — there is no argument for anyone else's.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["add", "list", "drop"],
        description:
          "`add` registers a watcher (idempotent per PR); `drop` withdraws one by id; `list` reads back " +
          "everything armed on this thread, with each PR's latest check state, without changing " +
          "anything. Every action answers with the full armed set.",
      },
      target: {
        type: "string",
        description:
          "Required for `add`. The pull request, as `owner/repo#123` or a GitHub PR URL. A ref that " +
          "cannot be parsed, or a PR the server's own `gh` cannot read, is REFUSED rather than stored — " +
          "a watcher that can never fire is worse than no watcher, because you would come to rest " +
          "believing you were covered. A refusal names the reason; a transient one is worth one retry.",
      },
      for: {
        type: "string",
        description:
          "REQUIRED for `add`. How long to watch, as a DURATION — `2h`, `3d`, `180d` (max 365d). Never " +
          "an instant, and there is no default. The watcher settles itself when this runs out and tells " +
          "you, and you re-register if you still care.\n\n" +
          "MATCH IT TO WHOSE PR IT IS, and the two cases are far apart. Your own PR, waiting on CI or on " +
          "a review you expect today: hours. A PULL REQUEST IN A REPO NOBODY HERE CONTROLS — an upstream " +
          "project, someone else's maintainers — takes as long as it takes, so give it MONTHS (`90d`, " +
          "`180d`, `365d`). A short `--for` on one of those does not make it get reviewed sooner; it just " +
          "expires against a PR nothing has touched, wakes you for nothing, and costs a re-arm. That is " +
          "not hypothetical — a watcher on an external PR re-armed at the old 24h ceiling four days " +
          "running, with zero maintainer activity in between. Long is FREE here: real activity wakes you " +
          "the moment it happens either way, and the user can snooze or archive the thread whenever " +
          "they want it gone.",
      },
      id: {
        type: "string",
        description: "Required for `drop`. The watcher id returned by `add` (or listed by `list`).",
      },
    },
    required: ["action"],
  },
}

const WATCH_ISSUE = {
  name: "watch_issue",
  description:
    "REGISTER A GITHUB ISSUE and ntwine brings you back whenever something happens on it — every later " +
    "comment, from a user or a bot alike, a label added or removed, someone assigned, and the issue " +
    "closing. Register it, come to rest, and you are woken. Drop it when it stops mattering.\n\n" +
    "IT REPORTS REPEATEDLY, like `watch-pr` and unlike a timer: one registration covers the whole life " +
    "of the issue, and it settles itself when the issue closes, because there is then nothing left to " +
    "report. There is no CI and no merge on an issue, so those are the only things it can say.\n\n" +
    "USE IT WHEN THE NEXT STEP IS SOMEONE ELSE'S REPLY ON AN ISSUE — a reporter you asked for a " +
    "reproduction, a maintainer you asked to triage, a discussion you are waiting to see resolved. " +
    "Nothing else watches for you: your runtime knows nothing about GitHub, and an ```awaiting fence " +
    "STATES what you are waiting on without creating any wait at all. This command is the wait. A PULL " +
    "REQUEST is `ntwinectl watch-pr`, not this — `gh issue view` refuses a PR number, and so does this.\n\n" +
    "THE ```awaiting FENCE IS STILL WORTH WRITING, for the same reason it is beside `watch-pr`: it is " +
    "how you come to REST without ntwine asking for a handoff, and how the user sees what you wait for. " +
    "Register the watcher, then name the same issue in the fence's `issues:` list, with the same long " +
    "`for:`.\n\n" +
    "GIVE IT A LONG `--for` — an issue in someone else's repo moves on their clock, and a short watcher " +
    "expires against an issue nobody has touched: a wake with nothing in it. Months are free; real " +
    "activity wakes you the instant it lands either way.\n\n" +
    "REGISTERING IS IDEMPOTENT per issue: asking twice returns the SAME id and says so, so re-registering " +
    "after a compaction is safe. `ntwinectl watch-issue list` reads back the issues watched on this thread without changing " +
    "anything. You can only ever watch an issue on your OWN thread.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["add", "list", "drop"],
        description:
          "`add` registers a watcher (idempotent per issue); `drop` withdraws one by id; `list` reads " +
          "back every issue armed on this thread, with its latest state, without changing anything.",
      },
      target: {
        type: "string",
        description:
          "Required for `add`. The issue, as `owner/repo#123` or a GitHub issue URL. A ref that cannot " +
          "be parsed, a PR URL, or an issue the server's own `gh` cannot read, is REFUSED rather than " +
          "stored — a watcher that can never fire is worse than none. A refusal names the reason.",
      },
      for: {
        type: "string",
        description:
          "REQUIRED for `add`. How long to watch, as a DURATION — `2h`, `3d`, `180d` (max 365d). Never " +
          "an instant, and there is no default. The watcher settles itself when this runs out and tells " +
          "you. An issue you are waiting on someone else to answer deserves MONTHS.",
      },
      id: {
        type: "string",
        description: "Required for `drop`. The watcher id returned by `add` (or listed by `list`).",
      },
    },
    required: ["action"],
  },
}

// The registry that replaces a ```awaiting fence's `shells:` line: a wait the worker CREATES rather
// than one it restates at every rest. Two commands rather than one action-switch, because they are two
// verbs and a worker reaching for `unwatch` should find `unwatch`. See plans/rest-by-registration.md.
const WATCH = {
  name: "watch",
  description:
    "REGISTER A WAIT on something this thread already has running — a background shell, a sub-agent — " +
    "and ntwine brings you back when it finishes, or when `--for` runs out.\n\n" +
    "IT IS A ROW, NOT A SENTENCE. A ```awaiting fence has the lifetime of the message carrying it; this " +
    "survives your turn ending, a compaction and an ntwine restart.\n\n" +
    "IT DOES NOT REPLACE THE FENCE. Where the thread sits while you wait is an answer about each REST, " +
    "so every rest on running work still ends with a ```awaiting fence that names the work and answers " +
    "`status: working|watching|needs_input` — `working` and `watching` keep the thread out of the " +
    "user's queue, and a rest with no fence lands in it.\n\n" +
    "`--for` IS REQUIRED and it is a DURATION, never an instant. When it runs out the row is CANCELLED " +
    "and you are woken to re-decide — that is deliberate, and it is what stops a wait outliving the " +
    "reason you made it. Register again if you still mean it.\n\n" +
    "THE TARGET IS CHECKED AGAINST WHAT IS ACTUALLY RUNNING, not against its shape. A handle nothing " +
    "live answers to is REFUSED rather than stored, and so is a `kind` that disagrees with what ntwine " +
    "can see — a sub-agent registered as a shell is refused and told what it actually is. If you have " +
    "lost an id (a compaction, a long turn), run `ntwinectl activity` rather than guessing.\n\n" +
    "A SUB-AGENT NEEDS NO REGISTRATION — its return re-invokes you — so the case this exists for is a " +
    "background SHELL: ntwine cannot tell a build you are waiting on from a dev server you started and " +
    "moved on from, and only you know which it is.\n\n" +
    "NEVER WATCH SOMETHING YOU INTEND TO OUTLIVE. A dev server, a log tail, a file watcher — those are " +
    "things you started, not things you are waiting for, and registering one is a wait on work that " +
    "will never finish.\n\n" +
    "REGISTERING IS IDEMPOTENT per (kind, target): asking twice returns the SAME id, says it was " +
    "already armed, and leaves the original expiry alone — so re-registering after a compaction is safe " +
    "and is the right instinct. Use `ntwinectl unwatch <id>` to withdraw one. A PULL REQUEST is `ntwinectl watch-pr`, not this: " +
    "that one polls GitHub and reports repeatedly.\n\n" +
    "You can only ever watch work on your OWN thread.",
  inputSchema: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: ["shell", "agent"],
        description:
          "What the target IS. Checked against live telemetry, not taken on trust — the two kinds of " +
          "handle are both opaque runtime strings and look identical, so ntwine answers this exactly " +
          "rather than guessing, and refuses a mismatch by name.",
      },
      target: {
        type: "string",
        description:
          "The handle you were shown. For a shell that is the runtime's own background-task id " +
          "(\"Command running in background with ID: bzvtnt3ig\"); its launch tool_use id and its " +
          "command label are accepted too. For a sub-agent it is the dispatch id or its description. " +
          "`ntwinectl activity` prints all of them.",
      },
      for: {
        type: "string",
        description:
          "REQUIRED. How long to hold the wait, as a DURATION — `30m`, `2h`, `3d` (max 24h). Never an " +
          "instant, and there is no default: choose it for THIS wait. When it elapses the row is " +
          "cancelled and you are woken to re-decide, so an over-long guess costs a wait that outlives " +
          "its reason and a too-short one costs one extra turn. The ceiling is a DAY here, unlike " +
          "`watch-pr`'s year: a shell or a sub-agent dies with this session, so a wait on one that has " +
          "stood for a day is a wait on something already gone.",
      },
    },
    required: ["kind", "target", "for"],
  },
}

// A BACKGROUND SHELL'S RUNTIME BUDGET (2026-09-29). A shell carries one only when it was DECLARED — its
// Bash `timeout`, or this verb; there is no default (server shell-budget.ts) — and outliving it earns one
// warning and then a stop. This is both the "keep it" answer and the way to GIVE a budget to a shell
// launched without one. Its own verb rather than a `watch` option: a watch HOLDS the thread for a shell,
// this sets how long a shell may live, and a dev server the worker is not waiting on may need the second
// and must never get the first.
const EXTEND_SHELL = {
  name: "extend_shell",
  description:
    "SET OR EXTEND A BACKGROUND SHELL'S RUNTIME BUDGET — when ntwine may stop it.\n\n" +
    "A background shell has a budget only if one was declared: the Bash `timeout` you passed on the " +
    "`run_in_background` call, or this command. With none, ntwine never stops it — it runs until it exits or " +
    "you stop it, which is right for a dev server or watcher meant to keep running. Past a budget ntwine " +
    "wakes you once (mid-turn if you are busy) and, if you do nothing, stops the shell ten minutes later.\n\n" +
    "Run this (a) to GIVE a budget to a shell launched without one — a poller, build or check that should " +
    "not outlive its purpose (a codex exec can get one no other way); (b) to answer that warning when the " +
    "shell must keep running; (c) ahead of time for a budgeted shell you know will run long.\n\n" +
    "`--for` is counted from NOW, not from launch, so pass how much LONGER it may run. Max 24h each time; " +
    "run it again before it runs out if it needs more. A shell you no longer need should be stopped " +
    "instead (TaskStop), not extended. An armed `ntwinectl watch` on the shell already holds its budget to the " +
    "watch's own `--for`.\n\n" +
    "You can only extend a shell on your OWN thread. `ntwinectl activity` prints each shell's id and its budget, " +
    "or that it has none.",
  inputSchema: {
    type: "object",
    properties: {
      shell: {
        type: "string",
        description:
          "The shell's handle — the runtime background-task id you were shown (\"Command running in " +
          "background with ID: bzvtnt3ig\"); its launch tool_use id and its description are accepted too.",
      },
      for: {
        type: "string",
        description: "How much longer it may run, as a DURATION from now — `30m`, `2h` (max 24h).",
      },
    },
    required: ["shell", "for"],
  },
}

const UNWATCH = {
  name: "unwatch",
  description:
    "WITHDRAW A WATCH you registered with `ntwinectl watch`, by its id. It will not wake you any more.\n\n" +
    "Use it the moment a wait stops mattering — you decided not to wait for that build after all, or " +
    "you are about to end the thread. A watch you no longer care about still wakes you for nothing, and " +
    "it blocks `done` until it is withdrawn.\n\n" +
    "You do NOT need this when the work simply finishes: ntwine settles the row itself and wakes you. " +
    "`ntwinectl activity` prints the id of everything you hold. A `watch-pr` / `watch-issue` id (`prw_…` / " +
    "`isw_…`), a `timer` id (`tmr_…`) or a `watch-command` id (`cmw_…`) is withdrawn here too.",
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "The watch id `ntwinectl watch` printed (or that `ntwinectl activity` lists), or a PR, issue, timer or command-watch id. Only your own thread's.",
      },
    },
    required: ["id"],
  },
}

// ---- `ask` / `unask`: a question the human owes an answer to, as a ROW ------------------------------

// The question tree, generated rather than written three times over. MCP tool schemas are JSON Schema,
// and a `$ref` cycle is the natural way to express a recursive shape — but client support for one is
// uneven, and a schema a client silently drops is a tool a worker cannot call. ASK_MAX_DEPTH is 3, so
// the nesting is INLINED to exactly that depth: `followUps` simply does not exist on the deepest level,
// which makes the limit visible in the schema instead of being a refusal the worker meets at runtime.
const ASK_MAX_DEPTH = 3
/** @param {number} depth 1 = the root question. @returns {Record<string, unknown>} */
function questionSchema(depth) {
  const option = {
    type: "object",
    properties: {
      label: { type: "string", description: "The choice itself, short — this is what the answer hands back to you." },
      description: {
        type: "string",
        description:
          "The trade-off, or the evidence — and it renders INSIDE the option, always visible, so this " +
          "is where the user learns what they are choosing BEFORE they pick anything. ONE LINE is the " +
          "default and it is right most of the time: name the trade-off and stop. Earn more than that " +
          "and spend it on a shape they can SCAN — a short list, a table, a code block, the diff the " +
          "option would produce, the exact message that would be posted. Never on a RUN OF " +
          "ONE-SENTENCE PARAGRAPHS: four single sentences stacked with blank lines between them is the " +
          "shape that keeps arriving, and it is the least readable one in a card this narrow. An " +
          "option with no trade-off makes the user reconstruct your reasoning before they can choose; " +
          "an option with four paragraphs makes them read an essay to answer one question. WHEN THE " +
          "OPTION SENDS OR APPLIES SOMETHING YOU WROTE — a comment, an issue body, a diff — put ALL of " +
          "it here, never \"the draft above\": the user chooses from this card, and your message's " +
          "prose above it is clipped to its first few lines.",
      },
      recommended: {
        type: "boolean",
        description:
          "Mark the ONE option you would take, and put it first. At most one per pick-one question — a " +
          "recommendation on two of three choices says nothing. ON A `multi`, MARK EVERY OPTION YOU " +
          "WOULD TICK, or none: the user ticks several there, so one mark alone reads as \"pick only " +
          "this\". IF YOU CAN MARK ONE, ASK YOURSELF WHY " +
          "YOU ARE ASKING: you already know the answer, so implement it and say which way you went. " +
          "This is for the fork you genuinely cannot take yourself. Under `mayDefault` it is also the 10-minute default " +
          "(see the command's description).",
      },
      external: {
        type: "boolean",
        description:
          "Taking this option acts OUTSIDE this machine: it files an issue, posts a comment or review, " +
          "merges, pushes, publishes, sends a message or spends money — anything that goes out under " +
          "the user's name or that others see. MARK EVERY SUCH OPTION, recommended or not: the 10-minute " +
          "default never takes one, so put the least-blocking local choice right after an `external` recommendation.",
      },
      // `preview` (markdown revealed under the option once picked) is RETIRED from this schema
      // (2026-09-01): detail that decides a choice must be visible before the choice, so it belongs in
      // a rich `description` now. The server still ACCEPTS the field — an in-flight worker dispatched
      // against the old schema keeps working, and the card folds it into the same always-visible body.
      ...(depth < ASK_MAX_DEPTH
        ? {
            // No `maxItems` here either (four until 2026-09-03): the tree is bounded by its DEPTH, not
            // by how many branches hang off one option.
            followUps: {
              type: "array",
              description:
                "Questions that become live ONLY if the user picks this option — the conditional " +
                "branch. A branch nobody takes is never asked and never answered, so this is how you " +
                "ask \"and if so, which?\" without asking it of somebody who said no. A `multi` " +
                "question cannot carry these (several picked options would open several branches at " +
                "once) and neither can a free-text one (there is no answer to branch on).",
              items: questionSchema(depth + 1),
            },
          }
        : {}),
    },
    required: ["label"],
  }
  return {
    type: "object",
    properties: {
      question: {
        type: "string",
        description:
          "THE QUESTION, on one line, in the user's own vocabulary. They have their original prompt " +
          "and nothing else — not your plan, not your notes, not the names you coined while working. " +
          "Lead with the behaviour, not the identifier. NO \"I\" AND NO \"you\": clicking an option is " +
          "the USER speaking, so first and second person flip between writer and reader. Name the " +
          "actor outright instead.",
      },
      header: { type: "string", description: "A very short chip label for the card, 12 characters or so — \"Auth method\", \"Storage\"." },
      kind: {
        type: "string",
        enum: ["question", "multi"],
        description:
          "`question` = pick ONE. `multi` = pick SEVERAL, for choices that are not mutually exclusive. " +
          "A question with NO options at all is a free-text box, which is the right shape when you need " +
          "a name, a value or a sentence rather than a decision between things you have enumerated.",
      },
      danger: {
        type: "boolean",
        description:
          "The DESTRUCTIVE gate, and nothing softer: a force-push, a deletion, a history rewrite, a " +
          "production rollback. It changes two things — the card wears the risk tone, and the user's " +
          "x cannot dismiss it, because a generic close icon is not consent for something irreversible. " +
          "Declining must therefore be one of your own options.",
      },
      mayDefault: {
        type: "boolean",
        description:
          "Lets Ntwine answer this question with your recommendation if the user has not after 10 minutes. " +
          "Without it the question waits for the user, however long. Set it only on a call you would " +
          "make yourself without them — never on the architecture of a library or a major version, a " +
          "public API, a data model, or the design a plan commits to.",
      },
      // No `maxItems`: the count is the worker's to choose (maintainer 2026-09-03 — "allow arbitrary
      // numbers of options"). A `multi` over a long list is a real shape; the card numbers every row (1–9 are its keys).
      options: {
        type: "array",
        description:
          "As many as the choice actually has — a fork of two, or a `multi` over twenty findings. " +
          "Omit entirely for a free-text question.",
        items: option,
      },
    },
    required: ["question", "kind"],
  }
}

const ASK = {
  name: "ask",
  description:
    "ASK THE USER SOMETHING YOU CANNOT DECIDE, as a ROW they still owe an answer to. THIS IS THE ONLY " +
    "WAY TO ASK: the free-form ```question fence is retired (2026-09-11), and a fence with a question " +
    "written in its body is plain prose — no card, no answer, no sign-off. The row renders as an " +
    "answerable card on the board and in the thread, and it STAYS there: it survives your turn ending, " +
    "a compaction, a restart, and the transcript scrolling past. A fence has the lifetime of the " +
    "message carrying it, which is why a question written into one was unanswerable an hour later.\n\n" +
    "YOUR DEFAULT IS TO DECIDE, AND THIS COMMAND DOES NOT CHANGE THAT. A reversible call costs minutes to " +
    "redo; a round-trip to the user costs hours with the whole effort idle. Anything derivable from " +
    "the code, the conventions or ordinary engineering judgement is yours: make it, say which way you " +
    "went, and keep moving. THE TEST THAT CATCHES ALMOST EVERY BAD QUESTION: if you are about to mark " +
    "one option `recommended`, you already know the answer — so implement it instead of asking.\n\n" +
    "ASK WHEN A WRONG GUESS WOULD BE BOTH COSTLY AND HARD TO UNDO — something destructive or " +
    "irreversible, an external-facing commitment, a security posture with real exposure, product or UX " +
    "direction that is genuinely the user's taste to set. And ask when you KNOW the answer but cannot " +
    "ACT on it: a merge, a publish, a spend, a comment that goes out under their name. Then the " +
    "recommendation is the point, and it goes first.\n\n" +
    "ASK LAST, THEN REST. The card reaches the user's queue only when you come to REST, so a question " +
    "asked mid-work sits unseen while you keep going. Finish everything that does NOT " +
    "depend on the answer FIRST, then ask, then stop. If what is left is substantial work you would do " +
    "on your recommended option anyway, the call was yours: take it, say which way you went, and do not " +
    "ask at all.\n\n" +
    "AND WHEN YOU DO STOP, THE QUESTION IS THAT REST'S SIGN-OFF — rest normally. Ntwine draws its card " +
    "at the BOTTOM of that rest's handoff, below its last line, whether you mention it or not — so " +
    "nothing you write can hide one, and nothing you write comes after it. PUT EVERY WORD OF " +
    "EXPLANATION BEFORE IT: what you found, what the choice turns on, what each answer would set in " +
    "motion. Never write the question itself into your handoff (one question, one card). Write no " +
    "placement marker either: an empty ```question qst_… fence draws the card where it sits instead, " +
    "mid-handoff.\n\n" +
    "AT EVERY LATER REST IT IS NO LONGER YOUR SIGN-OFF, and ntwine does not redraw it under your newer " +
    "handoff — it stays where you asked it. Name it under `questions:` in an ```awaiting fence while you " +
    "still need the answer (its card is then drawn at that rest), or withdraw it with `ntwinectl unask <id>`. A rest " +
    "that does neither is bumped, and so is any ```awaiting fence that leaves an open question out.\n\n" +
    "A QUESTION MARKED `mayDefault` DOES NOT WAIT FOREVER. Ten minutes after you rest on it, Ntwine takes its " +
    "`recommended` option for the user and delivers that as the answer, noting it was the default — " +
    "UNLESS that option is `external` (it files, posts, merges, pushes or publishes): then the default " +
    "takes the first option that is not `external`, and you must not do the external act anyway. Any other question — unmarked, `danger`, `multi` or " +
    "free text, one with no recommendation, or one whose every option is `external`, waits " +
    "for the user.\n\n" +
    "A QUESTION STAYS OPEN UNTIL IT IS ANSWERED, THE USER DISMISSES IT, OR YOU `ntwinectl unask` IT. A message " +
    "the user types instead of answering changes nothing about it; the message comes with a note naming " +
    "the questions still open, and your next rest names each one you still need under `questions:` or " +
    "withdraws it, like any later rest. Never ask again a question the user dismissed, or one you " +
    "yourself withdrew after their newest message — `ntwinectl ask` refuses both.\n\n" +
    "SEVERAL AT ONCE IS ONE COMMAND — register them together, so they render as one stack. Each must stand " +
    "alone (a question that only makes sense after another's answer is that option's `followUps`), " +
    "because ANSWERS ARRIVE ONE AT A TIME: each card is sent the moment the user completes it, so you " +
    "hear the first while they are still reading the rest, and a later one may land while you are " +
    "working. Act on each as it lands; the unanswered rest stay open.\n\n" +
    "An answer comes back to you as its own wake, restating what was asked. Withdraw one you no longer " +
    "need with `ntwinectl unask <id>` — a question you have since answered yourself, still sitting on the user's " +
    "board, is worse than never having asked it.\n\n" +
    "ON AN AUTONOMOUS THREAD THIS REFUSES, and tells you the standing instruction you are working " +
    "under. A thread carrying a rest Goal has already been told to keep going and decide for itself, " +
    "so the refusal is that instruction arriving at the moment it matters. Decide, and say which way " +
    "you went in your write-up. If the call is genuinely the user's — destructive or irreversible — " +
    "put it in your FINAL MESSAGE instead of here; autonomous does not mean nobody is reading.\n\n" +
    "AN ACT IS NOT A QUESTION. When the user must PERFORM something you cannot — sign in, approve, " +
    "merge, press a button you may not — do not ask whether they will: list the steps under `steps:` " +
    "in your ```awaiting fence. That works on an autonomous thread too, and their reply wakes you.",
  inputSchema: {
    type: "object",
    properties: {
      // No `maxItems` (four until 2026-09-03): "several at once is one command" above, and a cap here told
      // a worker with six to batch them and then refused the batch.
      questions: {
        type: "array",
        minItems: 1,
        description: "The questions to register, together. Each becomes its own card and its own row.",
        items: questionSchema(1),
      },
    },
    required: ["questions"],
  },
}

const UNASK = {
  name: "unask",
  description:
    "WITHDRAW A QUESTION you registered with `ntwinectl ask`, by its id. Its card disappears and the user is " +
    "never asked.\n\n" +
    "Use it the moment the question stops mattering: you worked out the answer yourself, the code moved " +
    "and the fork is gone, the user's newest message made it moot, or you are about to finish. A stale " +
    "question on someone's board is worse than no question — they answer it, and the answer is about a " +
    "decision that no longer exists. Withdrawn after the user's newest message, it is a pivot you " +
    "declared, and `ask` will not take it back.\n\n" +
    "You do NOT need this for a question that gets answered; that settles itself and wakes you. " +
    "Withdrawing is YOUR move and is never reported back to you as news.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "The question id `ntwinectl ask` printed, or that `ntwinectl activity` lists. Only your own thread's." },
    },
    required: ["id"],
  },
}

const SECRET = {
  name: "secret",
  description:
    "ASK THE USER FOR A SECRET VALUE — a one-time 2FA code, an API token, a password — that a command " +
    "needs and you must never see. The user may be on a phone, far from this machine: this is how a " +
    "code reaches a command without anyone typing into a terminal here.\n\n" +
    "It registers a question like `ntwinectl ask`, drawn as a card with ONE MASKED BOX. What the user pastes is " +
    "held in Ntwine's memory — never on disk — and served through a private named pipe whose path this " +
    "command prints NOW. It never enters the transcript, the database or your context: the answer you are " +
    "woken with names the path, not the value.\n\n" +
    "THE PATH CAN BE READ ONCE, within 15 minutes of the answer; then it is gone. So read it INSIDE the " +
    "command that uses it: `npm publish --otp \"$(cat '<path>')\"`, `<cmd> < '<path>'`. A value several " +
    "commands need goes into a variable at the start of ONE Bash call: " +
    "`T=\"$(cat '<path>')\"; cmd1 --token \"$T\"; cmd2 --token \"$T\"`. Never `cat` it bare, echo it, " +
    "copy it into a file, or paste it into a message — any of those spends the one read and puts the " +
    "value in the transcript. To discard an unread value, `rm` the path.\n\n" +
    "A one-time code expires in about thirty seconds, so have the command ready BEFORE you rest: when the " +
    "answer wakes you, run it at once.\n\n" +
    "Like a question, it is your rest's sign-off and it gates `done` until answered; name it under " +
    "`questions:` at later rests, withdraw it with `ntwinectl unask <id>`. It is allowed on an autonomous thread — a " +
    "credential is not something you can decide.",
  inputSchema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description:
          "What to paste, said so the user can answer cold: which account or service, which kind of " +
          "value, and what it unlocks — \"The npm one-time code for the maintainer account, to publish " +
          "ntwine 0.16.0.\" NO \"I\" AND NO \"you\": name the actor outright.",
      },
      header: { type: "string", description: "A very short chip label for the card, 12 characters or so — \"npm OTP\", \"API token\"." },
    },
    required: ["question"],
  },
}

const DONE = {
  name: "done",
  description:
    "DECLARE THIS EFFORT FINISHED, with the write-up the user reads. Your thread cards as a checked " +
    "success in their queue and stays there until they archive it — marking done is not dismissal, and " +
    "it does not close, archive or hide anything.\n\n" +
    "NTWINE CAN REFUSE THIS, which is the whole reason it is a command rather than a fence. An OPEN " +
    "QUESTION or an ARMED REGISTRATION blocks it, and the refusal names each one by id: a question " +
    "nobody answered dies with the card, and a live wait means the thing you were waiting for has not " +
    "happened yet. Resolve them for real — answer it yourself and `unask`, or `unwatch` the wait you no " +
    "longer need — then run it again. There is no force flag and there will not be one.\n\n" +
    "IT ONLY COUNTS WHAT IS REGISTERED. A background shell or a sub-agent you never registered does " +
    "not block this, because ntwine cannot tell a build you are waiting on from a dev server you walked " +
    "away from. That judgement is yours, and registering it is how you make it.\n\n" +
    "DONE MEANS THE WORK LANDED, NOT THAT YOU STOPPED. Code committed to the project's mainline; a " +
    "plan, doc or commissioned report written INTO A FILE. An open pull request is not done — the " +
    "merge is. An investigation headed for a fix is not done — the fix is. And a verdict that ends in " +
    "SOMEBODY SHOULD NOW DO SOMETHING (merge it, post this, pick one of these) is not done either: " +
    "that is a `ntwinectl ask`, carrying your recommendation as the first option.\n\n" +
    "THE TEST IS NEVER \"HAVE I STOPPED WORKING\". It is: WHAT IS LOST IF NOBODY EVER OPENS THIS " +
    "THREAD AGAIN? Name one thing and you are not done. Uncertain is not done.",
  inputSchema: {
    type: "object",
    properties: {
      body: {
        type: "string",
        description:
          "THE CARD, as markdown, read at a glance — keep it SHORT. At most one sentence, then one " +
          "ONE-LINE bullet per deliverable (no sub-bullets), each opening with a bolded verb phrase naming what shipped and where. Backtick every path, identifier and " +
          "command, and make file references real links. It is a LEDGER, not a summary: reasoning, " +
          "caveats and anything the user must do belong in your final message instead, because a " +
          "sentence that would read the same in both places belongs in exactly one of them. A bullet " +
          "that names a result without giving it (\"Answered the question\") is not a ledger line: the " +
          "answer goes in your final message, in full. Nothing " +
          "here may point vaguely forward — no \"a follow-up could…\". Do it, ask about it, or drop it.",
      },
      quiet: {
        type: "boolean",
        description:
          "ONLY on a SCHEDULED RUN (your first message opened with a <scheduled-run> header), and only when you " +
          "found nothing that needs the user: the thread goes straight to Done instead of their queue, and the " +
          "body's FIRST LINE becomes this run's line in the schedule's history — so make it the finding " +
          "(\"Nothing new — no issues since Oct 5\"). Anything the user should see is not quiet. Refused on any " +
          "other thread.",
      },
    },
    required: ["body"],
  },
}

const TITLE = {
  name: "title",
  description:
    "NAME THIS THREAD on the user's board — only if it has no name yet. Ntwine names every thread at " +
    "dispatch, and that name is the thread's @handle: the user reads it on the board and types it to " +
    "point other threads at this one, so it NEVER changes once shown. Ntwine refuses this command on a " +
    "thread that already has a name and tells you the name; that is the normal answer, not a failure — " +
    "do not retry it. It only lands on a thread Ntwine could not name.\n\n" +
    "NAME THE SUBJECT, NOT THE ACTION: one or two words — \"Shell budgets\", \"Focus mode\", \"ArkType " +
    "perf\" — never \"Fix the shell budget default\". Its kebab-case handle (\"Shell budgets\" is typed " +
    "@shell-budgets) must be at most 20 characters, and no other open thread may carry the same name.",
  inputSchema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description:
          "The thread's name: ONE or TWO short words naming its subject (kebab-case handle at most 20 characters), SENTENCE case (capitalize only the " +
          "first word and proper nouns — \"Queue focus\", never \"Queue Focus\"), distinct from every " +
          "other open thread's name. No trailing period, no ticks, no issue-body quoting. Spell every " +
          "product, file and identifier the way the PROJECT spells it, not the way the prompt did.",
      },
    },
    required: ["title"],
  },
}

// THREAD-TO-THREAD, BY HANDLE. The board shows every thread under a kebab-case handle (`shell-budgets`), and
// the human points one thread at another with it: "ask @shell-budgets", "reconcile with @focus-mode". Two
// commands, one protocol: READ first (free, wakes nobody); MESSAGE when reading is not enough, with
// `--await-reply` when you need the answer before you can go on — that registers the wait, and the rest
// that follows names it under `threads:` in its awaiting fence, as every wait is named.
const READ_THREAD = {
  name: "read_thread",
  description:
    "READ ANOTHER THREAD by its handle — the kebab-case name the board shows it under (`shell-budgets`, " +
    "`focus-mode`), in this project or, when no thread here carries it, in another project Ntwine has open. " +
    "The user writes these as `@shell-budgets`: \"ask @shell-budgets about " +
    "this\", \"reconcile with @focus-mode\". Write them the same way: wherever you mention another thread " +
    "or a sub-agent, name it by its `@` address, which the board links. Prints that thread's original request, its status line, " +
    "whether it is running, resting or done, its last few messages (its approach, and its handoff when it " +
    "is resting) and the files it edited.\n\n" +
    "ALWAYS READ BEFORE YOU MESSAGE: this wakes nobody and costs the other thread nothing, and it usually " +
    "answers \"what is @x doing, how, and what did it change\" on its own. For the diff itself, read the " +
    "files it lists or `git log`. It reaches finished threads too. A handle that names nothing is answered " +
    "with the handles that exist.\n\n" +
    "A thread's SUB-AGENTS answer to its handle, a dot, then theirs: `port-the-parser.cache-keys`, and a " +
    "Workflow's agents one segment further (`port-the-parser.wave-2.impl-w3`). Reading one prints its own " +
    "request and its newest messages — its report, once it has returned. It reaches sub-agents that have " +
    "already returned too; a name used twice means the running one, else the latest.",
  inputSchema: {
    type: "object",
    properties: {
      handle: { type: "string", description: "The other thread's handle, or a sub-agent's `thread.subAgent` address — with or without the `@`, any casing." },
    },
    required: ["handle"],
  },
}

const MESSAGE_THREAD = {
  name: "message_thread",
  description:
    "SEND A MESSAGE TO ANOTHER OPEN THREAD by handle (`@shell-budgets`) — in this project, or another " +
    "project Ntwine has open when no thread here carries the handle — to ask it a " +
    "question, to tell it what you are doing and how, or to agree who changes what. It arrives in that " +
    "thread's conversation signed with THIS thread's handle, joining its current turn if it is working and " +
    "waking it if it is resting. Nothing reaches the user.\n\n" +
    "THE PROTOCOL:\n" +
    "- ASKING, and you need the answer before you can go on → `--await-reply`. That REGISTERS the " +
    "wait; it does not park you. Rest right after on an ```awaiting fence naming the thread — " +
    "`threads: [@handle]`, a `status:` and a `for:`, which is how long to wait before you go on without " +
    "it — exactly as for any other wait. Its answer arrives as a message of its own and ends the wait.\n" +
    "- ASKING, but you have other work → leave `--await-reply` off and keep working; the answer still " +
    "arrives as a message.\n" +
    "- TELLING (context, your approach, a heads-up that you are changing a shared file) → no " +
    "`--await-reply`. The other thread answers only if it has something to say.\n" +
    "- ANSWERING a message you received → message its sender back. When the sender is waiting on you, " +
    "its message says so; answer it promptly, even if only to say you cannot help.\n\n" +
    "A thread you spawned with `ntwinectl spawn-thread`, or the one that spawned you, is reachable the same way.\n\n" +
    "`ntwinectl read-thread` FIRST — often it already answers the question. Write each message to stand alone: " +
    "the other thread has none of your context. Never reply just to acknowledge. A finished thread cannot " +
    "be messaged (read it instead). A RUNNING sub-agent can, by its address (`@thread.child`, your own " +
    "children included): it reads the message after its next tool call, and answers only in its report to " +
    "its own thread, so `--await-reply` does not apply. Messages between two threads are capped per hour.",
  inputSchema: {
    type: "object",
    properties: {
      handle: { type: "string", description: "The other thread's handle, with or without the `@` — any casing." },
      message: { type: "string", description: "What to tell or ask it, self-contained." },
      await_reply: {
        type: "boolean",
        description: "Register a wait on that thread's answer. Use when you need the answer before you can go on, then rest on an ```awaiting fence naming it under `threads:`.",
      },
    },
    required: ["handle", "message"],
  },
}

// The schedule bounds, mirrored from @ntwine/shared for the same reason as the timer's: this file cannot
// import them. The server enforces all of them; these only shape the description.
const SCHEDULE_MIN_SPACING_MINUTES = 15

const SCHEDULE = {
  name: "schedule",
  description:
    "PROPOSE A RECURRING THREAD: a saved prompt Ntwine starts as a FRESH thread of its own on a calendar rule — " +
    "\"every Monday at 9am triage new issues\". Use it when the user asks for something to happen " +
    "regularly (\"do this every Monday\", \"check this daily\"). It is not `ntwinectl goal` (which repeats in THIS " +
    "thread) and not `ntwinectl timer` (one instant, this thread): each run starts with no memory of this conversation, " +
    "so the prompt must stand on its own.\n\n" +
    "A SCHEDULE YOU CREATE DOES NOT RUN UNTIL THE USER CLICKS TURN ON. It is a proposal; nothing you can " +
    "run activates it, and `ntwinectl ask` is not a way to get it turned on.\n\n" +
    "YOU WRITE THE RULE; NTWINE COMPUTES THE RUNS. Give an RFC 5545 `--rrule` (FREQ HOURLY/DAILY/WEEKLY/MONTHLY/" +
    "YEARLY with INTERVAL, COUNT, UNTIL, BYMONTH, BYMONTHDAY, BYDAY, BYHOUR, BYMINUTE, BYSETPOS, WKST — " +
    "nothing else), a LOCAL `--dtstart` (`YYYY-MM-DDTHH:MM`, wall clock, no zone) and optionally an IANA `--tz` " +
    "(default: the user's own zone). ALWAYS include BYHOUR and BYMINUTE. Weekdays = BYDAY=MO,TU,WE,TH,FR; the " +
    "last day of the month = BYMONTHDAY=-1 (never above 28); the first weekday of the month = " +
    "BYDAY=MO,TU,WE,TH,FR;BYSETPOS=1. Runs must be at least " + SCHEDULE_MIN_SPACING_MINUTES + "m apart. " +
    "Put the user's own words for when in `--when`. Anything a rule cannot say (\"unless it's a holiday\", " +
    "\"the day after each release\") goes in `--condition`, a short clause each run checks first.\n\n" +
    "EVERY ANSWER CARRIES AN ECHO built from the rule Ntwine will fire (\"Triage issues · every Monday at 9am\" " +
    "and the next runs). RELAY IT TO THE USER VERBATIM — it is how a mistranslated time gets caught before it " +
    "runs. Use `dry-run` first when you are unsure; it saves nothing.\n\n" +
    "`--model` and `--effort` are REQUIRED, chosen for what ONE RUN must do, exactly as for `ntwinectl spawn-thread` — every " +
    "run is a paid agent session.\n\n" +
    "On a schedule that is already on, you may only change ONE OCCURRENCE: `skip-next`, `move-next` (to a " +
    "local time before the run after it), or `pause` it. A scheduled run uses these when its own check says " +
    "the next run should not happen as planned. Only the user resumes, edits or deletes a schedule.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["create", "dry_run", "update", "list", "pause", "skip_next", "move_next"],
        description:
          "`create` proposes a schedule (it waits for the user's Turn on); `dry-run` validates and echoes " +
          "without saving; `update` changes a proposal YOU made that is not on yet; `list` shows this project's " +
          "schedules with their ids; `pause`, `skip-next` and `move-next` act on an active schedule by `--id`. " +
          "Hyphens and underscores are the same here (`dry-run` = `dry_run`).",
      },
      id: { type: "string", description: "The schedule's `sch_…` id (from `create` or `list`). For update, pause, skip-next, move-next." },
      title: { type: "string", description: "For create/dry-run (and update): one or two words naming the task's subject, sentence case — \"Triage issues\". Every run is named this." },
      prompt: { type: "string", description: "For create/dry-run (and update): what each run does, self-contained — a fresh thread with none of your context reads it." },
      when: { type: "string", description: "For create/dry-run (and update): the user's own words for when, as they said them — \"every Monday at 9am\"." },
      rrule: { type: "string", description: "For create/dry-run (and update): the RRULE value without the `RRULE:` prefix, e.g. `FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0`." },
      dtstart: { type: "string", description: "For create/dry-run (and update): the local start, `YYYY-MM-DDTHH:MM`, at the rule's first time of day. It anchors INTERVAL." },
      tz: { type: "string", description: "Optional IANA zone like `America/New_York`. Default: the zone the user's browser reports." },
      condition: { type: "string", description: "Optional: a short clause each run checks before working — \"unless it's a US public holiday\"." },
      model: { type: "string", description: "For create/dry-run: REQUIRED, picked for one run's task — `opus`, `sonnet` or `haiku` (claude), or a codex model id with `--backend codex`." },
      effort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"], description: "For create/dry-run: REQUIRED, picked for one run's task." },
      backend: { type: "string", enum: ["claude", "codex"], description: "Optional agent backend for the runs (default `claude`)." },
      reason: { type: "string", description: "For skip-next: why, in a few words — it is the run's line in the schedule's history (\"release freeze\")." },
      to: { type: "string", description: "For move-next: the new start, a local time in the schedule's zone (`2026-10-15T10:00`) or an ISO instant. Before the run after it." },
    },
    required: ["action"],
  },
}

// THE HUMAN'S EDITOR, ON DEMAND. The Ntwine extension (packages/vscode) reports what each VS Code / Cursor /
// Windsurf window shows over its editor socket, whole, on every change; this reads the window that has
// THIS project open (server: editor-bridge.ts `editorState`). It is the agent's half of what Claude Code's
// IDE integration gives its own agent (getCurrentSelection, getOpenEditors, getDiagnostics): without it a
// human in the Ntwine sidebar who asked "can you see the highlighted code?" was told no, because the only
// way a selection reached a worker was as a chip the human added by hand. The description is written to
// be REACHED FOR on the words humans actually use for code they have not pasted.
const EDITOR = {
  name: "editor",
  description:
    "WHAT THE USER HAS IN FRONT OF THEM in VS Code, Cursor or Windsurf right now: the file in front and the " +
    "lines they have SELECTED, with the selected text; where the caret is and which lines are on screen; " +
    "their other open tabs, unsaved ones marked; and the editor's errors and warnings (the Problems panel). " +
    "RUN IT WHENEVER THE USER POINTS AT CODE THEY HAVE NOT PASTED — \"this\", \"here\", \"this function\", " +
    "\"the selected code\", \"what I highlighted\", \"the error\", \"why is this red\", \"what I'm looking " +
    "at\" — and before asking them which file or lines they mean. The text it prints is what they SEE, " +
    "which differs from the file on disk when the file has unsaved changes. It reads the editor window " +
    "that has this project open (the one they used last, if several do), takes nothing and changes nothing; " +
    "run it again whenever you need the current picture, since the user keeps moving.",
  inputSchema: { type: "object", properties: {}, required: [] },
  annotations: { title: "Read the user's editor", readOnlyHint: true, openWorldHint: false },
}

// The registry: `ntwinectl` lists these and routes a command by name (and the legacy MCP front-end
// answers `tools/list` and `tools/call` from the same list). Adding a worker-facing capability = one
// entry here + one handler in `HANDLERS` + its spelling in `CLI` — never a second surface.
const MIN_INTERVAL_SECONDS = 60
const MAX_INTERVAL_SECONDS = 24 * 60 * 60

const ACTIVITY = {
  name: "activity",
  description:
    "EVERYTHING YOU CURRENTLY HAVE OUT, with the id each one is named by — your background shells, your " +
    "sub-agents, your armed timers, the pull requests you registered, the `wch_…` of every watch holding " +
    "one of them, every QUESTION still owed an answer, and saved links/files with their lnk_ ids.\n\n" +
    "WHY YOU NEED IT: an ```awaiting fence names what you are waiting on BY ID, and ntwine checks every " +
    "one against what is actually live. A name that matches nothing is not a park — you are bumped and " +
    "your thread queues. The same goes for the ids `unwatch` and `unask` take. So if you have lost one (a " +
    "compaction, a long turn, a wake you did not expect), run this rather than guessing. Guessing is " +
    "the failure this command exists to remove — and it is the only way to read your open questions " +
    "WITHOUT registering or withdrawing one.\n\n" +
    "It takes nothing and changes nothing. You can only ever read your OWN thread.",
  inputSchema: { type: "object", properties: {}, required: [] },
}

const LINK = {
  name: "link",
  description: "Register a labeled URL or local file underneath this thread's prompt, alongside agents and shells. " +
    "Use for dev servers, working documents, reports, and downloads the user will need again. " +
    "The same label updates its existing row without duplicating or reordering it. " +
    "HTTP(S) destinations render as Link; local files render as File and use Ntwine's existing file reader/opener. " +
    "Files must exist. Relative paths resolve from the project root; use absolute paths for worktrees. " +
    "Registration survives rests and restarts, but does not start, monitor, or verify a server. " +
    "It never blocks done or parks the thread. Read registrations with `ntwinectl activity`; remove one with `ntwinectl unlink <id>`.",
  inputSchema: {
    type: "object",
    properties: {
      label: { type: "string", description: "Short destination label, such as Open dev server or Working plan. Reuse it to update that row." },
      target: { type: "string", description: "An HTTP(S) URL, file:// URL, or existing local file path. No credentials in URLs." },
    },
    required: ["label", "target"],
    additionalProperties: false,
  },
}
const UNLINK = {
  name: "unlink",
  description: "Remove one saved link/file from this thread by its lnk_ id (printed by `ntwinectl link` or listed by `ntwinectl activity`). " +
    "Only removes the registration: it never deletes a file or stops a server.",
  inputSchema: {
    type: "object", properties: { id: { type: "string", description: "The lnk_ id of a registration on this thread." } },
    required: ["id"], additionalProperties: false,
  },
}

// THE THREAD'S TIME LIMIT (2026-10-06, ARCHITECTURE.md § Time limits). Read it, or set one on a thread that has
// none. Only the human may move or clear a deadline the human set — an agent moving its own goalposts
// defeats the point — so `extend` and `clear` work on a deadline the worker set itself, and the server
// (router `ownDeadline`) holds the same rule.
const DEADLINE = {
  name: "deadline",
  description:
    "READ OR SET THIS THREAD'S TIME LIMIT — the instant you owe your best deliverable by.\n\n" +
    "A thread may carry a deadline: the user sets it when dispatching or from the board, or you may set one on a " +
    "thread that has none. While one is set, ntwine checks in with you mid-turn at half-time, at 80%, shortly before " +
    "the deadline and at it, and every wake's clock line shows the time left. Nothing is ever stopped at the deadline: " +
    "the job is the best deliverable you can hand over by then, not the complete one eventually.\n\n" +
    "`read` prints the deadline (or that there is none). `set` gives a thread with NO deadline one — `--for` a duration " +
    "from now (`30m`, `2h`, `1h 30m`), or `--at` an ISO instant. `extend` moves a deadline YOU set to a later one; " +
    "`clear` removes a deadline you set. A deadline the USER set is theirs: you can read it, and only they can move " +
    "or remove it — `extend` and `clear` refuse it.\n\n" +
    "To give a SUB-AGENT a budget, do not run this: write `Time limit: 20m` on a line of its own in its prompt.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["read", "set", "extend", "clear"], description: "What to do. `read` takes no other argument." },
      for: { type: "string", description: "For `set` / `extend`: a duration from NOW — `30m`, `2h`, `1h 30m` (at least 1m, at most 7d)." },
      at: { type: "string", description: "For `set` / `extend`: an exact ISO-8601 instant instead of `--for` (e.g. `2026-10-06T15:30:00Z`)." },
    },
    required: ["action"],
    additionalProperties: false,
  },
}

// A wait on an OUTSIDE condition that a command can check, run by the SERVER (2026-10-11). It exists
// because the alternative was a polling loop in a background shell, which pins the thread's whole
// process tree: hibernation refuses a thread holding one. See packages/server/src/command-watch.ts.
const WATCH_COMMAND = {
  name: "watch_command",
  description:
    "WAIT ON AN OUTSIDE CONDITION WITHOUT HOLDING A PROCESS. Give Ntwine a shell command that exits 0 once " +
    "the thing you are waiting for is true — a package version npm serves, a release run that finished, a " +
    "URL that answers — and the SERVER runs it every `--every` until it does, then wakes you ONCE with " +
    "the command and the end of its output. Nothing of yours runs meanwhile, so your thread can be " +
    "hibernated while it rests. A polling loop in a background shell (`until …; do sleep 300; done`) pins " +
    "your whole process tree, ~250 MB, for as long as it loops; this is that loop without the cost.\n\n" +
    "THE CONDITION IS EXIT STATUS 0, and nothing else. Write the check so it FAILS until the condition " +
    "holds: `npm view ntwine@0.13.12 version` (non-zero while npm does not serve it), `gh run view 123 " +
    "--json conclusion -q .conclusion | grep -qx success`, `curl -fsS http://localhost:5173/health`.\n\n" +
    "IT RUNS ON THE SERVER, NOT IN YOUR SHELL: `/bin/sh -c` in the project root, with the server's " +
    "environment and PATH, stdin closed, killed after 2m. Nothing your session exported, no aliases, no " +
    "functions. A first check runs at registration: exit 0 means the condition already holds and nothing " +
    "is armed, and a command the server cannot run at all (`command not found`) is refused.\n\n" +
    "ONLY ON A THREAD WITH NO PERMISSION CHECKS. The server runs the command with no permission prompt and " +
    "outside any sandbox, so Ntwine refuses it unless this thread runs in `bypassPermissions` mode with " +
    "Claude Code's sandbox off, and refuses it on Codex. The refusal says why; wait in a background shell " +
    "then.\n\n" +
    "ONE-SHOT: the first passing check settles it. When `--for` runs out it is cancelled and you are woken " +
    "to re-decide. Name its id in your ```awaiting fence — `commands: [cmw_…]` with `status: watching`. " +
    "Registering is idempotent on the exact command text. `list` reads back what is armed, with each " +
    "watch's last check; `drop` withdraws one (so does `ntwinectl unwatch <id>`). Only ever your OWN thread's.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["add", "list", "drop"],
        description:
          "`add` registers a watch (idempotent per command); `drop` withdraws one by id; `list` reads back " +
          "every watch armed on this thread, with its last check, without changing anything.",
      },
      command: {
        type: "string",
        description:
          "Required for `add`. The check, as one shell command line run with `/bin/sh -c` in the project " +
          "root. Exit 0 means the condition holds. Use absolute paths for anything not on a plain PATH.",
      },
      every: {
        type: "string",
        description:
          "Required for `add`. How often to check, as a DURATION — `1m`, `5m`, `1h` (min 1m, max 24h). " +
          "Pick it for how soon you need to know: a release in npm's review is minutes to hours, so `5m`.",
      },
      for: {
        type: "string",
        description:
          "Required for `add`. How long to keep checking, as a DURATION — `2h`, `1d`, `7d` (max 7d). When it " +
          "runs out the watch is cancelled and you are woken to decide what the silence means.",
      },
      id: {
        type: "string",
        description: "Required for `drop`. The `cmw_…` id `add` printed (or that `list` and `ntwinectl activity` show).",
      },
    },
    required: ["action"],
  },
}

// WATCH_ISSUE rides at the END (2026-09-14): the tool list is read by position in ntwine-mcp.test.ts, and a
// worker's runtime reads it by name, so the order costs nothing and appending breaks nothing.
// EXTEND_SHELL is appended after it for the same reason (2026-09-29), EDITOR after MESSAGE_THREAD (2026-10-02),
// SCHEDULE after EDITOR (2026-10-05), DEADLINE after SCHEDULE (2026-10-06), upstream's SECRET after
// DEADLINE (2026-10-08), and upstream's WATCH_COMMAND after SECRET (2026-10-12). Upstream's STEER is not
// here: MESSAGE_THREAD is the fork's thread-to-thread command (plans/upstream-superset.md).
const TOOLS = [SPAWN_THREAD, GOAL, TIMER, WATCH_PR, WATCH, UNWATCH, ASK, UNASK, DONE, TITLE, ACTIVITY, LINK, UNLINK, WATCH_ISSUE, EXTEND_SHELL, READ_THREAD, MESSAGE_THREAD, EDITOR, SCHEDULE, DEADLINE, SECRET, WATCH_COMMAND]

// A COMMAND WHOSE FEATURE CAN BE ABSENT, and the capability the server reports for it (router
// `workerCapabilities`, the same predicate that gates the contract's sections, dispatch.ts). Of the
// fork's commands only `editor` has one: it reads the human's editor, and most humans never run the
// extension. The MCP front-end lists a gated tool only while its capability exists and follows it live
// (bin/ntwine-mcp.mjs), because a listed MCP tool is paid for on every turn; `ntwinectl` costs nothing per
// command, so it always answers one, and the command itself says when there is nothing to read.
const GATED_TOOLS = /** @type {Record<string, string>} */ ({ [EDITOR.name]: "editor" })

/** @type {Record<string, (args: Record<string, unknown>) => Promise<string>>} */
const HANDLERS = {
  [SPAWN_THREAD.name]: spawnThread,
  [GOAL.name]: goal,
  [TIMER.name]: timer,
  [WATCH_PR.name]: watchPr,
  [WATCH_ISSUE.name]: watchIssue,
  [WATCH.name]: watch,
  [ASK.name]: ask,
  [UNASK.name]: unask,
  [SECRET.name]: secret,
  [DONE.name]: done,
  [TITLE.name]: title,
  [UNWATCH.name]: unwatch,
  [ACTIVITY.name]: activity,
  [LINK.name]: link,
  [UNLINK.name]: unlink,
  [EXTEND_SHELL.name]: extendShell,
  [READ_THREAD.name]: readThread,
  [MESSAGE_THREAD.name]: messageThread,
  [EDITOR.name]: editor,
  [SCHEDULE.name]: schedule,
  [DEADLINE.name]: deadline,
  [WATCH_COMMAND.name]: watchCommand,
}

/** The `deadline` handler: read, set, extend or clear this thread's time limit.
 * @param {Record<string, unknown>} args @returns {Promise<string>} */
async function deadline(args) {
  const action = typeof args.action === "string" ? args.action.trim() : ""
  if (!["read", "set", "extend", "clear"].includes(action)) throw new Error("`action` must be one of read, set, extend, clear")
  const forValue = typeof args.for === "string" && args.for.trim() ? args.for.trim() : undefined
  const at = typeof args.at === "string" && args.at.trim() ? args.at.trim() : undefined
  if ((action === "set" || action === "extend") && !forValue && !at) {
    throw new Error("`" + action + "` needs `for` (a duration from now, like `30m` or `2h`) or `at` (an ISO instant)")
  }
  const result = (await callRpc("ownDeadline", {
    slug: threadSlug(),
    action,
    ...(forValue ? { for: forValue } : {}),
    ...(at ? { at } : {}),
  }))?.result
  const d = result?.deadline
  if (!d) return action === "clear" ? "This thread has no deadline now. Work to the best deliverable, not to a clock." : "This thread has no deadline."
  const leftMs = Date.parse(d.at) - Date.now()
  const left = leftMs > 0 ? `${budgetSpan(leftMs)} left` : `over by ${budgetSpan(-leftMs)}`
  const who = d.setBy === "human" ? "the user (only they can move or clear it)" : "you"
  return `Deadline: ${d.at} — ${left}. Set ${d.setAt} by ${who}. Ntwine checks in at half-time, at 80%, shortly before it and at it.`
}

/** A span in the house grammar (`42m`, `1h 12m`), for the deadline readout.
 * @param {number} ms @returns {string} */
function budgetSpan(ms) {
  if (ms < 60_000) return `${Math.max(0, Math.ceil(ms / 1000))}s`
  const minutes = Math.ceil(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`
}

/** The `read_thread` handler: another thread's request, status, approach and newest message, by handle.
 * @param {Record<string, unknown>} args @returns {Promise<string>} */
async function readThread(args) {
  // `to` is accepted too: it is the name a worker reaches for first (seen on a real worker, 2026-09-29).
  const handle = typeof args.handle === "string" ? args.handle.trim() : typeof args.to === "string" ? args.to.trim() : ""
  if (!handle) throw new Error("`handle` is required — the other thread's kebab-case name, e.g. `shell-budgets`")
  const r = (await callRpc("readThread", { slug: threadSlug(), handle }))?.result
  if (!r?.found && r?.subAgentOf) {
    return r.known?.length
      ? `@${r.subAgentOf} has no sub-agent called ${handle.replace(/^@/, "").split(".").slice(1).join(".")}.\n\nIts sub-agents: ${r.known.join(", ")}`
      : `@${r.subAgentOf} has not dispatched any sub-agent that can be named.`
  }
  if (!r?.found) return `No thread is called ${handle}.${knownLine(r?.known)}`
  // A sub-agent's state is its own: "done" once it has returned, with how it ended.
  const state = r.subAgentOf
    ? r.state === "done" ? `returned${r.outcome && r.outcome !== "completed" ? ` (${r.outcome})` : ""}` : r.state === "resting" ? "resting, with its own sub-agents still running" : "running"
    : r.state === "done" ? "done" : r.state === "resting" ? "resting (not working right now)" : "running (mid-turn)"
  return [
    `@${r.handle} — ${r.project ? `a thread in the ${r.project} project, ` : ""}${r.subAgentOf ? `a sub-agent of @${r.subAgentOf}, ` : ""}${state}${r.status ? `\nStatus: ${r.status}` : ""}`,
    r.request ? `\n## Its request\n\n${r.request}` : "",
    r.earlier?.length ? `\n## Its earlier messages, oldest first\n\n${r.earlier.join("\n\n---\n\n")}` : "",
    r.latest ? `\n## Its newest message${r.latestAt ? ` (${r.latestAt})` : ""}\n\n${r.latest}` : "\nIt has not said anything yet.",
    r.editedFiles?.length ? `\n## Files it edited\n\n${r.editedFiles.map((f) => `- ${f}`).join("\n")}` : "",
  ].filter(Boolean).join("\n")
}

/** The `message_thread` handler: deliver a message into another open thread's conversation, optionally
 * registering a wait on its answer.
 * @param {Record<string, unknown>} args @returns {Promise<string>} */
async function messageThread(args) {
  const handle = typeof args.handle === "string" ? args.handle.trim() : typeof args.to === "string" ? args.to.trim() : ""
  const message = typeof args.message === "string" ? args.message.trim() : ""
  if (!handle) throw new Error("`handle` is required — the other thread's kebab-case name, e.g. `shell-budgets`")
  if (!message) throw new Error("`message` is required")
  const awaitReply = args.await_reply === true || args.await_reply === "true"
  const body = { slug: threadSlug(), handle, message, ...(awaitReply ? { awaitReply: true } : {}) }
  const r = (await callRpc("messageThread", body))?.result
  if (!r?.sent) return `Not sent — ${r?.refusal ?? "Ntwine did not accept it."}${knownLine(r?.known)}`
  if (r.delivery === "mailbox") {
    return `Sent to the sub-agent @${r.handle}, signed @${r.from}. It reads it after its next tool call; its answer, if any, is in its report to its own thread.`
  }
  const where = r.project ? ` (in the ${r.project} project)` : ""
  const answered = r.answered ? ` It answers the message @${r.handle} was waiting on, so that thread is no longer parked on you.` : ""
  if (r.timerId) {
    return (
      `Sent to @${r.handle}${where}, signed @${r.from}, and your wait on its answer is registered (${r.timerId}).${answered} ` +
      "Rest now unless you have other work, ending your message with an ```awaiting fence that names it, with " +
      `\`for:\` set to how long to wait before you go on without it:\n\n\`\`\`awaiting\nthreads: [@${r.handle}]\nstatus: watching\nfor: 1h\n\`\`\`\n\n` +
      `The answer arrives as a message of its own and ends the wait. \`ntwinectl unwatch ${r.timerId}\` stops waiting.`
    )
  }
  return (
    `Sent to @${r.handle}${where}, signed @${r.from}.${answered} Any answer arrives as a message of its own — keep ` +
    "working. (If you need the answer before you can go on, send with `--await-reply` instead.)"
  )
}

/** @param {unknown} known @returns {string} */
function knownLine(known) {
  return Array.isArray(known) && known.length ? `\n\nThreads in this project: ${known.join(", ")}` : ""
}

/** The `extend_shell` handler: move one background shell's runtime budget to `for` from now.
 * @param {Record<string, unknown>} args @returns {Promise<string>} */
async function extendShell(args) {
  const shell = typeof args.shell === "string" ? args.shell.trim() : ""
  if (!shell) throw new Error("`shell` is required — the shell's id; `ntwinectl activity` prints them all")
  const forValue = typeof args.for === "string" ? args.for.trim() : ""
  if (!forValue) throw new Error("`for` is required — a DURATION from now like `30m` or `2h` (max 24h)")
  const result = (await callRpc("extendOwnShell", { slug: threadSlug(), shell, for: forValue }))?.result
  if (!result?.budgetEndsAt) throw new Error("Ntwine did not confirm the extension")
  // A clamp is news for the same reason it is on `watch`: a worker told nothing believes it holds time it does not.
  const clamped = result.clampedFrom ? ` Your \`for: ${result.clampedFrom}\` was CAPPED at 24h.` : ""
  return (
    `\`${result.shell}\` (${result.label}): its budget now ends at ${result.budgetEndsAt}.${clamped} ` +
    "Ntwine will not warn about or stop it before then. Extend again before then if it needs longer; stop it " +
    "when you no longer need it."
  )
}

/** @param {Record<string, unknown>} args @returns {Promise<string>} */
async function link(args) {
  const label = typeof args.label === "string" ? args.label.trim() : ""
  const target = typeof args.target === "string" ? args.target.trim() : ""
  if (!label || !target) throw new Error("`label` and `target` are required")
  const result = (await callRpc("upsertOwnLink", { slug: threadSlug(), label, target }))?.result
  const saved = result?.link
  if (!saved?.id) throw new Error("Ntwine did not return a saved link")
  return `Registered ${saved.kind} ${saved.id}: ${saved.label}\n${saved.target}\n\nThis reference stays underneath the prompt. It does not assert a server is running or block completion. Remove it with \`ntwinectl unlink ${saved.id}\`.`
}

/** @param {Record<string, unknown>} args @returns {Promise<string>} */
async function unlink(args) {
  const id = typeof args.id === "string" ? args.id.trim() : ""
  if (!id) throw new Error("`id` is required — take it from `ntwinectl link` or `ntwinectl activity`")
  const result = (await callRpc("dropOwnLink", { slug: threadSlug(), id }))?.result
  return result?.dropped ? `Removed registration ${id}. No file was deleted and no server was stopped.` : `No registration ${id} on this thread.`
}

/** The `title` handler: register this thread's considered name.
 * @param {Record<string, unknown>} args @returns {Promise<string>} */
async function title(args) {
  const slug = threadSlug()
  const wanted = typeof args.title === "string" ? args.title.trim() : ""
  if (!wanted) throw new Error("`title` is required — one or two words naming the subject, in sentence case")
  const result = (await callRpc("setOwnThreadTitle", { slug, title: wanted }))?.result
  if (result?.accepted) return `This thread is now named "${result.title}" on the board.`
  // A duplicate, an over-long name or a spent rename: the server says which, in words the worker can
  // act on (pick another subject, or leave the name alone).
  if (result?.refusal) return `Not renamed — ${result.refusal}`
  // The refusal is REPORTED, never thrown: a human who renamed the thread owns its name, and a worker
  // told "error" would retry a call that can only ever fail again.
  if (result?.lockedByHuman) {
    return (
      `Not renamed — the user has named this thread "${result.title}" themselves, and their name ` +
      "outranks yours. Leave it; do not run this again for this thread."
    )
  }
  return `Not renamed — ntwine did not accept the write. This thread still reads "${result?.title ?? slug}".`
}

/** Read out every background thing this thread has running, in the shape an awaiting fence names them.
 * @returns {Promise<string>} */
async function activity() {
  const result = (await callRpc("listOwnThreadActivity", { slug: threadSlug() }))?.result
  const items = Array.isArray(result?.activity) ? result.activity : []
  const questions = Array.isArray(result?.questions) ? result.questions : []
  const links = Array.isArray(result?.links) ? result.links : []
  // WHO THIS THREAD IS, first: the handle other threads and the human call it, and the head of every
  // sub-agent address below — the names to write in prose, where the board turns each into a link.
  const selfLine = typeof result?.handle === "string" && result.handle
    ? `This thread is @${result.handle}. Name it, other threads and every sub-agent by their @ address in anything the user reads — the board links each one.\n\n`
    : ""
  const linksBlock = links.length === 0 ? "" : "\n\nSaved links and files (not running work; remove with `ntwinectl unlink <id>`):\n" +
    links.map((link) => `  ${link.id}  ${link.kind}: ${link.label}\n    ${link.target}`).join("\n")
  // THE QUESTIONS GET THEIR OWN SECTION, because they are not running work: a question waits on a
  // person. Since 2026-10-05 a fence names the ones still needed under `questions:` (and must name every
  // open one), so the ready-to-paste fence below carries every open one too.
  const questionLine = (q) =>
    `  question: ${q.id}\n` +
    `    ${String(q?.spec?.question ?? "").replace(/\s+/g, " ").slice(0, 160)}`
  const askedBlock = questions.length === 0 ? "" : (
    `\n\n${questions.length} question${questions.length === 1 ? "" : "s"} still owed an answer:\n\n` +
    questions.map(questionLine).join("\n") +
    "\n\nEach one blocks `done` until it is answered, dismissed or withdrawn, and draws its own card at the " +
    "BOTTOM of the handoff of the rest that asked it — never write it into a handoff, and put the " +
    "explanation above it. Answers arrive one question at a time; act on each as it lands. `ntwinectl unask <id>` the " +
    "ones since decided. Any ```awaiting fence names EVERY open one under `questions:` or is refused, and " +
    "at a rest after the one that asked, a question you neither name nor withdraw gets you bumped. In a " +
    "fence: `questions: [" + questions.map((q) => q.id).join(", ") + "]`"
  )
  if (!items.length) {
    if (questions.length > 0) {
      return selfLine + (
        "Nothing is RUNNING on this thread — no background shells, no sub-agents, no armed timers, no " +
        "registered PRs. An ```awaiting fence can still wait on your open questions alone — " +
        "`questions:` names the user as the wait, so it needs no other name and no `for:`." +
        askedBlock + linksBlock
      )
    }
    return selfLine + (
      "Nothing is running on this thread — no background shells, no sub-agents, no armed timers, no " +
      "registered PRs, and no question still owed an answer.\n\nSo there is nothing to wait on: an ```awaiting fence " +
      "would have nothing to name, and a fence naming nothing is not a park. End with ```done, or " +
      "register a question with `ntwinectl ask` if you need the user." + linksBlock
    )
  }
  const lines = items.map((i) => {
    const when = i.until ? `  (fires ${i.until})` : i.since ? `  (since ${i.since})` : ""
    // A shell's runtime budget — when ntwine warns about it and, unextended, stops it (`extend_shell`). A
    // shell with NONE says so: it is the one that runs until somebody stops it, and the worker reading
    // this is the somebody.
    const budget = i.budgetEndsAt ? `  [${budgetLeft(i.budgetEndsAt)}]` : i.kind === "shell" ? "  [no budget: runs until it ends or you stop it]" : ""
    // The `wch_…` id of the watch holding this item, where one is armed — this readout exists to hand a
    // worker back the ids it lost, and that includes the one `unwatch` takes.
    const held = i.watchId ? `  [watched as ${i.watchId}]` : ""
    return `  ${i.kind}: ${i.id}${when}${held}${budget}\n    ${i.address ? `@${i.address} — ` : ""}${i.label}`
  })
  // A READY-TO-PASTE FENCE, not a description of one. The frontmatter is YAML since 2026-08-24 and its
  // keys are PLURAL sequences, so an id printed on its own line is no longer something a worker can copy
  // into a fence — it has to see the shape. This command is where the contract sends a worker that has lost
  // an id, so printing the retired one-line-per-item form would teach the very grammar ntwine refuses.
  const byKind = { shell: [], agent: [], timer: [], pr: [], issue: [], thread: [], command: [] }
  for (const i of items) if (byKind[i.kind] && i.id) byKind[i.kind].push(i.id)
  const block = Object.entries({ shells: byKind.shell, agents: byKind.agent, timers: byKind.timer, prs: byKind.pr, issues: byKind.issue, threads: byKind.thread, commands: byKind.command })
    .filter(([, ids]) => ids.length > 0)
    .map(([key, ids]) => `  ${key}: [${ids.join(", ")}]`)
  // Every open question rides the fence too: a fence that leaves one out is refused, and a fence on
  // questions always queues, so its `status:` answer is `needs_input` whatever else it names. Otherwise
  // the template guesses from the kinds — a shell or a sub-agent is usually work that finishes by itself,
  // a PR, an issue, a timer or another thread's reply a watch — and the prose tells the worker to correct
  // it.
  const questionIds = questions.map((q) => q.id).filter(Boolean)
  if (questionIds.length > 0) block.push(`  questions: [${questionIds.join(", ")}]`)
  const status = questionIds.length > 0 ? "needs_input" : byKind.shell.length + byKind.agent.length > 0 ? "working" : "watching"
  return selfLine + (
    `${items.length} thing${items.length === 1 ? "" : "s"} running on this thread:\n\n${lines.join("\n")}\n\n` +
    "Name the ones you are ACTUALLY waiting on in your ```awaiting fence. The frontmatter is YAML — one " +
    "PLURAL key per kind, taking a list — plus a required `for:` duration and a required `status:` " +
    "answer: `working` (the work finishes by itself; the thread shows as running), `watching` (the wait " +
    "is on something outside the thread; it is snoozed) or `needs_input` (the user can act on something " +
    "now; it goes in their queue, with what to look at BELOW a `---` line — there is no `reason:` key). " +
    "`working` and `watching` need no prose at all.\n\nEverything above, as a fence:\n\n" +
    "```awaiting\n" +
    `${block.join("\n")}\n  status: ${status}\n  for: 2h\n` +
    "```\n\nDrop the lines you are not actually waiting on — a dev server you left running is not a wait " +
    "— and change `status:` if it names the wrong place." +
    "\n\nA `ntwinectl watch` registration (marked `[watched as …]` above) keeps the WAKE across a compaction and a " +
    "restart, but it does not replace the fence: name the work in the fence all the same." +
    askedBlock + linksBlock
  )
}

// What `editor` says when it has nothing to show — each says WHY, because "no selection" and "no editor"
// and "the human switched it off" call for different next moves, and every one ends with the move that
// is always open: ask the human to paste it.
const EDITOR_FALLBACK = "Ask the user to paste the code, or to name the file and lines they mean."

/** The `editor` handler: the editor window that has this project open, as readable text.
 * @returns {Promise<string>} */
async function editor() {
  let result
  // This thread's own slug, when the spawn stamped one: the server answers with this thread's checkout
  // when it works somewhere other than the project root (a worktree), which changes what the human's
  // selection means to it. Never from the arguments — the command takes none.
  const slug = process.env.NTWINE_THREAD_SLUG || process.env.NTWINE_THREAD
  try {
    result = (await callRpc("editorState", slug ? { slug } : {}))?.result
  } catch (err) {
    // An Ntwine from before this command answers an unknown procedure with 404; a worker outlives
    // restarts, so it can hold this command while the server it talks to does not have it yet.
    if (/HTTP 404/.test(err instanceof Error ? err.message : String(err))) {
      return `The running Ntwine cannot read the editor yet: it predates this command. Restart Ntwine to enable this. Until then: ${EDITOR_FALLBACK}`
    }
    throw err
  }
  const windows = Array.isArray(result?.windows) ? result.windows : []
  const connected = typeof result?.connected === "number" ? result.connected : 0
  if (!windows.length) {
    if (!connected) {
      return (
        "No editor is connected to Ntwine, so there is nothing to read: the user is not running VS Code, " +
        `Cursor or Windsurf with the Ntwine extension. ${EDITOR_FALLBACK}`
      )
    }
    // Which folders those windows have open is not this worker's to read — they are other projects — so
    // Ntwine says only that they exist (editor-bridge.ts editorState).
    return (
      `${connected} editor window${connected === 1 ? " is" : "s are"} connected to Ntwine, but none has this project open, ` +
      `so what the user has in front of them is in another project. ${EDITOR_FALLBACK}`
    )
  }
  const [front, ...others] = windows
  const parts = [editorWindowReport(front, editorCheckout(result?.checkout))]
  if (others.length) {
    parts.push(
      `Also open in ${others.length} other window${others.length === 1 ? "" : "s"} (not read in full; the one above was used last):\n` +
      others.map((w) => `- ${editorWindowHead(w)}${w.editor?.active ? ` — ${editorActiveLine(w.editor.active)}` : ""}`).join("\n"),
    )
  }
  return parts.join("\n\n")
}

/** "VS Code, focused now, folder /repo" — which window this is. @param {any} w */
function editorWindowHead(w) {
  const focus = w.focused ? "focused now" : typeof w.focusedAgoMs === "number" ? `last focused ${agoLabel(w.focusedAgoMs)}` : "not focused since it connected"
  const folders = Array.isArray(w.folders) && w.folders.length ? `, ${w.folders.length === 1 ? "folder" : "folders"} ${w.folders.join(", ")}` : ""
  return `${w.app} (${focus}${folders})`
}

/** "/repo/src/a.ts (typescript, unsaved changes), lines 12-20 selected" @param {any} a */
function editorActiveLine(a) {
  const traits = [a.languageId, a.untitled ? "untitled, not saved to disk" : a.dirty ? "unsaved changes" : ""].filter(Boolean).join(", ")
  const sel = a.selection ? `, ${editorLines(a.selection)} selected` : `, caret on line ${a.cursorLine}`
  return `${a.path}${traits ? ` (${traits})` : ""}${sel}`
}

/** @param {{ startLine: number, endLine: number }} r */
function editorLines(r) {
  return r.startLine === r.endLine ? `line ${r.startLine}` : `lines ${r.startLine}-${r.endLine}`
}

/** "just now", "12s ago", "3m ago", "2h 5m ago" — the house grammar (durationLabel). @param {number} ms */
function agoLabel(ms) {
  return ms < 1_000 ? "just now" : `${durationLabel(Math.round(ms / 1_000))} ago`
}

// A THREAD IN A WORKTREE IS NOT LOOKING AT THE HUMAN'S COPY. About one thread in seven works in a worktree
// of its own (`.ntwine/worktrees/<slug>`), while the human's editor shows the project's main checkout — so
// the file they have selected is THEIR copy, its text may not be what the worker's copy holds, and an
// absolute path read off this report points the worker's Edit at the main checkout instead of its own
// work. The server says where the calling thread works (`checkout`, editorState); the report says once
// whose copy each path is, and names the worker's own copy of the file in front. Paths stay absolute:
// that is what Read and Edit take, and an absolute path can never be resolved against the wrong folder.

/** The answer's `checkout`, or undefined when it is absent or malformed. @param {any} raw
 *  @returns {{ dir: string, root: string, kind: string } | undefined} */
function editorCheckout(raw) {
  if (!raw || typeof raw.dir !== "string" || typeof raw.root !== "string" || !raw.dir || !raw.root) return undefined
  return { dir: raw.dir, root: raw.root, kind: raw.kind === "folder" ? "folder" : "worktree" }
}

/** Whether `path` is `dir` or lies under it. @param {string} path @param {string} dir */
function editorUnder(path, dir) {
  const rel = relative(dir, path)
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel))
}

/** The worker's own copy of a file the human's editor shows in the main checkout; undefined for a file
 *  already in the worker's checkout, or outside the project. @param {string} path
 *  @param {{ dir: string, root: string } | undefined} checkout */
function editorOwnCopy(path, checkout) {
  if (!checkout || !isAbsolute(path) || editorUnder(path, checkout.dir) || !editorUnder(path, checkout.root)) return undefined
  return join(checkout.dir, relative(checkout.root, path))
}

/** One window, in full: the file in front with its selection, the tabs, the problems. @param {any} w
 *  @param {{ dir: string, root: string, kind: string } | undefined} [checkout] the calling thread's own checkout */
function editorWindowReport(w, checkout) {
  const head = editorWindowHead(w)
  const e = w.editor
  if (!e) {
    return (
      `${head} has this project open, but it has not reported what it shows: its Ntwine extension predates ` +
      `this, or it connected a moment ago. Updating the extension (\`nub run vscode:install\` in an Ntwine ` +
      `checkout) enables it. ${EDITOR_FALLBACK}`
    )
  }
  if (!e.shared) {
    return (
      `${head} has this project open, but the user turned off sharing their editor with Ntwine ` +
      `(the eye over the sidebar's prompt box, the \`ntwine.shareEditorState\` setting), so nothing of it is read. ${EDITOR_FALLBACK}`
    )
  }
  // "Last changed", not "as of": the extension reports every change, so an old report is a quiet editor.
  const lines = [`${head}, last changed ${agoLabel(e.reportedAgoMs ?? 0)}.`]
  const a = e.active
  const open = Array.isArray(e.open) ? e.open : []
  const diagnostics = Array.isArray(e.diagnostics) ? e.diagnostics : []
  if (checkout) {
    const shown = [...(a && !a.untitled ? [a.path] : []), ...open.filter((f) => !f.untitled).map((f) => f.path), ...diagnostics.map((d) => d.path)]
    const where = checkout.kind === "folder" ? "your own checkout" : "your own worktree"
    if (shown.some((path) => editorOwnCopy(path, checkout))) {
      lines.push(
        "",
        `You are working in ${where}, ${checkout.dir}, but this window shows the project's main checkout, ${checkout.root}. ` +
        `A file below under ${checkout.root} is the user's copy, and what they selected is its text; the same relative ` +
        `path under ${checkout.dir} is your copy, which may differ. Read and edit yours.`,
      )
    } else if (shown.some((path) => typeof path === "string" && editorUnder(path, checkout.dir))) {
      lines.push("", `This window has ${where} open, ${checkout.dir}: the files below under it are your own copies.`)
    }
  }
  if (!a) {
    lines.push("", "No file is in front: the editor area is empty, or shows something that is not a file (a diff's old side, an output pane, a webview).")
  } else {
    const own = a.untitled ? undefined : editorOwnCopy(a.path, checkout)
    lines.push("", `In front: ${editorActiveLine(a)}.${own ? ` Your copy: ${own}.` : ""}`)
    if (a.selection) {
      const s = a.selection
      const count = s.endLine - s.startLine + 1
      if (s.withheld) {
        // The extension keeps the text of a file that may hold secrets (.env, a key) out of the frame; the
        // lines still say where the human is looking.
        lines.push(`Its text is not shared: the file may hold secrets. Read ${editorLines(s)} of the file yourself only if the task needs it.`)
      } else if (typeof s.text === "string") {
        lines.push(`Selected text (${count} line${count === 1 ? "" : "s"}${s.truncated ? `; ONLY THE START — the selection was too large to carry whole, so read the file for the rest` : ""}):`)
        // A whole-line drag ends at column 1 of the next line, so its text ends in a newline the fence
        // would show as a blank last line.
        lines.push(codeFence(s.text.replace(/\n$/, ""), a.languageId))
      } else {
        lines.push(`The selection was too large to carry its text; read ${editorLines(s)} of the file.`)
      }
    }
    lines.push(`Caret on line ${a.cursorLine}; lines ${a.visible.startLine}-${a.visible.endLine} on screen; ${a.lineCount} line${a.lineCount === 1 ? "" : "s"} in all.`)
  }
  if (open.length) {
    lines.push("", `Other open tabs, most recent first (${open.length}):`)
    for (const f of open) lines.push(`- ${f.path}${f.untitled ? " (untitled, not saved to disk)" : f.dirty ? " (unsaved changes)" : ""}`)
  }
  const errors = e.problems?.errors ?? 0
  const warnings = e.problems?.warnings ?? 0
  if (!errors && !warnings) {
    lines.push("", "Problems: no errors or warnings.")
  } else {
    const total = `${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}`
    const shown = diagnostics.length < errors + warnings ? ` (the first ${diagnostics.length}: the file in front first, errors before warnings)` : ""
    lines.push("", `Problems: ${total}${shown}.`)
    // Grouped by file, in the order they arrived — the file in front first — so a path is written once.
    /** @type {Map<string, any[]>} */
    const byFile = new Map()
    for (const d of diagnostics) {
      if (!byFile.has(d.path)) byFile.set(d.path, [])
      byFile.get(d.path).push(d)
    }
    for (const [path, ds] of byFile) {
      lines.push(path)
      for (const d of ds) {
        const tag = d.source || d.code ? ` [${[d.source, d.code].filter(Boolean).join(" ")}]` : ""
        lines.push(`  ${d.line}: ${d.severity}: ${String(d.message).replace(/\s+/g, " ")}${tag}`)
      }
    }
  }
  return lines.join("\n")
}

/** `text` in a Markdown fence longer than any backtick run inside it. @param {string} text @param {string} [lang] */
function codeFence(text, lang) {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length))
  const fence = "`".repeat(Math.max(3, longest + 1))
  return `${fence}${lang && /^[\w+#.-]+$/.test(lang) ? lang : ""}\n${text}\n${fence}`
}

/** "budget: 42m left (ends <iso>)" in the house duration grammar (`2h 35m`), or the overrun. The ISO
 *  instant rides along because the model has no clock of its own to read "42m" against later.
 * @param {string} endsAt @returns {string} */
function budgetLeft(endsAt) {
  const ms = Date.parse(endsAt) - Date.now()
  if (!Number.isFinite(ms)) return `budget ends ${endsAt}`
  if (ms <= 0) return `PAST its budget (ended ${endsAt}) — \`ntwinectl extend-shell\` or stop it`
  const m = Math.max(1, Math.round(ms / 60_000))
  const left = m < 60 ? `${m}m` : m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m / 60}h`
  return `budget: ${left} left, ends ${endsAt}`
}

/**
 * Whether a pid is running. EPERM means someone else's live process, which is still ALIVE.
 *
 * A lock with NO pid reads as alive: absence of evidence is not evidence of death, and discarding a
 * record written by an older or foreign publisher would turn a working server into "none found".
 */
function pidAlive(pid) {
  if (pid === undefined || pid === null) return true
  if (!Number.isInteger(pid)) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === "EPERM"
  }
}

/** A lock file's `{port, pid}`, or undefined if it is missing, malformed, or names a DEAD process. */
function liveLock(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"))
    if (!Number.isInteger(parsed?.port)) return undefined
    if (!pidAlive(parsed?.pid)) return undefined
    return { port: parsed.port, path }
  } catch {
    return undefined
  }
}

/** The caller's environment names no Ntwine at all — as opposed to naming one that is not answering. */
class NoNtwineState extends Error {}

/**
 * This project's state dir (`<ntwine root>/projects/<project id>`), from whichever stamp the caller has.
 *
 * NTWINE_STATE_DIR is the explicit one. NTWINE_PERM_DIR is `<state dir>/perm-requests` (project.ts
 * `permDir`) and has been in every Claude worker's environment since long before the command line
 * existed — so a shell inside a worker forked by an OLDER Ntwine, which was never handed the state dir,
 * still finds the server through it.
 */
function projectStateDir() {
  if (process.env.NTWINE_STATE_DIR) return process.env.NTWINE_STATE_DIR
  const perm = process.env.NTWINE_PERM_DIR
  return perm && basename(perm) === "perm-requests" ? dirname(perm) : undefined
}

/**
 * FIND THE RUNNING NTWINE — every call, never cached, never frozen at spawn.
 *
 * This process is spawned once, inside a DETACHED worker daemon that outlives restart after restart.
 * An address handed to it in its env is therefore true exactly until the next "Update & Restart", and
 * a worker whose only address was stale simply lost every ntwine tool it had — with no way back short of
 * restarting the worker itself, which is not what an update button should mean.
 *
 * So the env is a HINT and the file is the truth, in this order:
 *   1. NTWINE_SERVER_LOCK  — the lock this server published when it spawned us. Right almost always.
 *   2. `<ntwine root>/server.lock` — the MACHINE address (ntwine-paths.ts `serverAddressPath`), rewritten
 *      by every boot whatever project launched it. This is what makes a live worker survive an update.
 *   3. `<state dir>/server.lock` — our own project's, for a server that only ever serves one project.
 *   4. any live `<ntwine root>/projects/*​/server.lock` — last resort, since one machine runs one ntwine.
 *
 * A candidate whose PID IS DEAD IS SKIPPED, which is the difference between a legible failure and the
 * one that cost an afternoon: a stale lock from a long-dead per-project server sent every call at a port
 * nothing was listening on, and the tool reported only "fetch failed".
 *
 * The ntwine root is `../..` from the state dir rather than computed: this file is dependency-free and
 * the real root is platform-dependent (XDG, `~/Library/Application Support`, a legacy `~/.ntwine`).
 */
function serverLockPort() {
  const stateDir = projectStateDir()
  const root = stateDir ? dirname(dirname(stateDir)) : undefined
  const candidates = [
    process.env.NTWINE_SERVER_LOCK,
    root ? join(root, "server.lock") : undefined,
    stateDir ? join(stateDir, "server.lock") : undefined,
  ].filter(Boolean)
  for (const path of candidates) {
    const live = liveLock(path)
    if (live) return live.port
  }
  // Nothing we were told about is alive. One machine runs one ntwine, so any project's live lock names
  // it — and addressing by project id (rpcPath) means a server that does not serve us answers 404
  // rather than acting on the wrong board.
  if (root) {
    let entries = []
    try { entries = readdirSync(join(root, "projects")) } catch {}
    for (const entry of entries) {
      const live = liveLock(join(root, "projects", entry, "server.lock"))
      if (live) return live.port
    }
  }
  if (candidates.length === 0) {
    throw new NoNtwineState(
      "cannot locate the Ntwine server: this environment names no Ntwine state (NTWINE_STATE_DIR, " +
      "NTWINE_SERVER_LOCK and NTWINE_PERM_DIR are all unset). That is what a shell OUTSIDE an Ntwine worker " +
      "looks like; inside one it is an Ntwine bug. NOTHING WAS SAVED — this command had no effect.",
    )
  }
  // SAY THAT NOTHING WAS SAVED, and say to retry. A worker reads "is ntwine running?" as a fact about the
  // world rather than as a fact about ITS OWN call, and moves on — so whatever it was arming is silently
  // gone. Measured 2026-08-17: a worker's `recurring_prompt start` hit a restart window, got this error,
  // carried on, and its Goal — the thing keeping a long autonomous effort alive — never existed. The
  // window is ordinary (ntwine restarts, and this process outlives every one of them), so the recovery has
  // to be ordinary too: try again.
  throw new Error(
    `no running ntwine server found (looked at ${candidates.join(", ")} and every project lock under ` +
    `${root ? join(root, "projects") : "the ntwine root"}; each was missing, malformed, or written by a process that is gone). ` +
    `NOTHING WAS SAVED — this command had no effect. ntwine is probably mid-restart, which is ordinary and ` +
    `brief; RETRY this exact command before you do anything else, and do not come to rest assuming it took.`,
  )
}

/**
 * The RPC base for OUR project.
 *
 * One ntwine serves every project on the machine, and an unprefixed `/_ntwine/rpc/…` is the project it
 * was LAUNCHED from — so without the prefix a worker in any other project acted on the launcher's
 * board (spawn_thread put its new thread there; the thread-scoped tools looked for a slug that lives
 * in a different registry). NTWINE_PROJECT_ID is the immutable registry id rather than the slug,
 * because the value is handed over once at spawn and then held for the life of a detached daemon,
 * and a project can be renamed under it. Unset ⇒ unprefixed, which is what a server that only ever
 * serves one project passes, and what the launching project's own workers get.
 * @param {string} procedure
 */
function rpcPath(procedure) {
  const project = projectSegment()
  return `${project ? `/_ntwine/${encodeURIComponent(project)}` : "/_ntwine"}/rpc/${procedure}`
}

/**
 * WHICH PROJECT WE ACT ON — always the one this worker is actually running in.
 *
 * There is deliberately no tool parameter for it: the id comes from the server's stamp, or failing that
 * from the tree we are standing in (`<root>/.ntwine/.id`, the same file project-root.ts treats as
 * identity). `spawn_thread`'s `project` argument does not change it either — the call still goes to OUR
 * project, which routes the dispatch to the named one (router spawnTarget), so the choice is checked
 * against the projects Ntwine actually has open rather than trusted from a path.
 *
 * The walk-up is what makes this work for a worker spawned by a server that predates the stamp, and it
 * is the honest source anyway: a worker's project is wherever its cwd is, and that cannot go stale.
 */
function projectSegment() {
  const stamped = process.env.NTWINE_PROJECT_ID
  if (stamped) return stamped
  // The state dir IS `<ntwine root>/projects/<project id>` (ntwine-paths.ts `projectStateDir`), so a
  // caller that knows its state dir knows its project — which is the thread's own project even when
  // the worker has `cd`'d somewhere with no `.ntwine/` above it, or into another project's tree.
  const stateDir = projectStateDir()
  if (stateDir && basename(dirname(stateDir)) === "projects") return basename(stateDir)
  let dir = process.cwd()
  for (;;) {
    try {
      const id = readFileSync(join(dir, ".ntwine", ".id"), "utf8").trim()
      if (id) return id
    } catch {}
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** The `spawn_thread` handler: POST /_ntwine/rpc/dispatch, return the worker-facing result text.
 * @param {Record<string, unknown>} args @returns {Promise<string>} */
async function spawnThread(args) {
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : ""
  if (!prompt) throw new Error("`prompt` is required and must be a non-empty string")
  // model + effort are REQUIRED (no default) so the caller must choose by task complexity — a defaulted
  // model (e.g. the project's cheap default) is exactly the bug this guards. Enforced server-side too,
  // not only in the tool schema, so a lenient client can't skip the decision.
  const model = typeof args.model === "string" ? args.model.trim() : ""
  if (!model) throw new Error("`model` is required — choose one by the new task's complexity (claude: opus/sonnet/haiku, opus being the top tier; codex: a gpt-5.6 model id). There is no default.")
  const effort = typeof args.effort === "string" ? args.effort.trim() : ""
  if (!effort) throw new Error("`effort` is required — choose one by complexity (low/medium/high/xhigh/max). There is no default.")

  // THE WAY BACK. A spawned thread starts with nothing but this prompt, so without its spawner's slug it
  // could not `message_thread` anything back even when asked to — the footer names it, once, at the end.
  // The slug, because that is what this process knows; `message_thread` resolves a slug as it does a handle.
  const parent = process.env.NTWINE_THREAD_SLUG || process.env.NTWINE_THREAD
  const footer = parent
    ? `\n\n---\nSpawned by the Ntwine thread \`${parent}\`. If this prompt asks for results back, or you find ` +
      `something that thread must know, send it there with \`ntwinectl message-thread ${parent} --message-file <file|->\`.`
    : ""
  /** @type {Record<string, unknown>} */
  const body = { prompt: prompt + footer, model, effort }
  if (typeof args.title === "string" && args.title.trim()) body.title = args.title.trim()
  if (args.backend === "claude" || args.backend === "codex") body.backend = args.backend
  if (typeof args.project === "string" && args.project.trim()) body.project = args.project.trim()
  // The caller, from our own identity: it marks this as a WORKER's dispatch, whose prompt the server
  // checks for another project's checkout when no `project` was named (server spawn-project.ts).
  const caller = process.env.NTWINE_THREAD_SLUG || process.env.NTWINE_THREAD
  if (caller) body.spawnedFrom = caller

  // Ask for the new thread's `@handle` with the answer.
  body.awaitHandle = true

  const payload = await postToNtwine("dispatch", rpcPath("dispatch"), body)
  const slug = payload?.result?.slug
  if (typeof slug !== "string" || !slug) throw new Error(`dispatch response missing a slug: ${JSON.stringify(payload)?.slice(0, 300)}`)
  const spawned = `Spawned a new ntwine thread \`${slug}\`.`
  // Started in ANOTHER project (`project`): the server names it, so the result says whose board it is on.
  const project = typeof payload?.result?.project === "string" ? payload.result.project : undefined
  const intro =
    `${spawned} It is now on the ${project ? `\`${project}\` project's ` : ""}board driving independently — it reports ` +
    `to the user via its own final message, so do not wait on a result from it. It knows this thread: if its ` +
    `prompt asked for results back, they arrive as a message that wakes you.\n\n`
  // A thread names another by its `@handle`, which the board links. The server hands one back once the
  // new thread has a name; a thread still unnamed when its bounded wait ran out (or one nothing names,
  // with no model wired) has none to give, and the link to its slug is the only reference that opens it.
  const handle = payload?.result?.handle
  if (typeof handle === "string" && handle) {
    return `${intro}It is @${handle}: name it that way in anything the user reads, and the board links it.`
  }
  const label = typeof body.title === "string" ? body.title : slug
  // Another project's thread links with that project's prefix — a bare `/thread/…` resolves against this one.
  const href = project ? `/project/${encodeURIComponent(project)}/thread/${slug}` : `/thread/${slug}`
  return `${intro}It has no handle yet, so paste this link to let the user open it in the drawer:\n\n[${label}](${href})`
}

// HOW LONG A RESTART WINDOW IS ALLOWED TO BE INVISIBLE. ntwine replaces its own server routinely
// ("Update & Restart", a dev rebuild), and this process is deliberately still here across every one of
// them — so a call landing in that gap is ORDINARY, and failing it is the shim reporting ntwine's
// housekeeping as the worker's problem. Measured 2026-08-17: a `recurring_prompt start` landed in one,
// failed, and the Goal that was keeping a long autonomous effort alive silently never existed.
//
// Telling the model to retry (which the error also does) is strictly weaker than retrying, because it
// only works if the model complies. Bounded: a genuinely-down ntwine still fails, with the same message —
// this only covers the window where a new server is coming up.
//
// A MINUTE, not the six seconds this started at. A boot on a loaded machine is not seconds: on
// 2026-09-29 (arktype session 50d1f5b7, load average ~15) three `ask` calls in a row each spent the
// whole 6s window and failed, the outage outlasting all three (~27s), and the worker had to notice and
// re-ask by hand. Waiting longer costs only latency on a call that would otherwise have failed.
// NTWINE_LOCK_RETRY_MS shortens it for ntwinectl.test.ts, which would otherwise wait out the whole minute.
const LOCK_RETRY_MS = Number(process.env.NTWINE_LOCK_RETRY_MS) || 60_000
const LOCK_RETRY_INTERVAL_MS = 400

/** The port, waiting out a brief restart window rather than failing into one. Rethrows the real
 *  "no running ntwine server" error once the budget is spent, so an ntwine that is actually down still
 *  says so — and says it with the retry guidance attached.
 *  @param {number} deadline epoch ms; shared with postToNtwine's refused-connection retries, so the two
 *  waits together never exceed one window. */
async function serverLockPortWaiting(deadline = Date.now() + LOCK_RETRY_MS) {
  for (;;) {
    try {
      return serverLockPort()
    } catch (err) {
      // No lock to wait FOR is not a restart window: nothing in this environment names an Ntwine, and
      // six seconds of retrying would only delay saying so.
      if (err instanceof NoNtwineState || Date.now() >= deadline) throw err
      await new Promise((r) => setTimeout(r, LOCK_RETRY_INTERVAL_MS))
    }
  }
}

// A LIVE LOCK IS NOT A LISTENING PORT. The lock wait above only covers a lock that is missing or names a
// dead pid. Through the rest of a restart the lock names a pid that is still alive while its port is not
// answering — the old server between closing its listener and exiting, or a dev supervisor's child being
// replaced — and the call failed at once with a bare "fetch failed", the same non-answer the lock check
// was written to remove. Two shapes, and they need opposite advice:
//
// - REFUSED (`ECONNREFUSED`): nothing was listening, so the request never left this process. Nothing can
//   have been applied, so it is retried inside the same window, exactly as a dead lock is.
// - DROPPED after connecting (`UND_ERR_SOCKET` "other side closed", `ECONNRESET`), or no answer inside
//   DISPATCH_TIMEOUT_MS: the server had the request and may have acted on it. Retrying blindly could
//   register a question or spawn a thread twice, so the worker is told it MAY have landed and to check.
//
// Measured 2026-10-02 (session fe5967ef): a `done` spent 16s and failed with "markOwnDone request failed:
// fetch failed" during a server restart. The error carried no advice, the worker never repeated it, and
// the thread's handoff was never recorded.
/** @param {unknown} err */
function causeCode(err) {
  const cause = err && typeof err === "object" ? /** @type {{ cause?: { code?: unknown } }} */ (err).cause : undefined
  return typeof cause?.code === "string" ? cause.code : undefined
}

/**
 * A shell sandboxed off the network, which no wait or retry can get through.
 *
 * A codex thread narrowed to `workspace-write` or `read-only` cannot open a socket at all, loopback
 * included (measured on codex 0.161.0, `_live_codex_shell_identity.mts`: curl exit 7 against a TCP
 * listener and a unix socket alike), and codex says so in the shell's own environment. "fetch failed"
 * there reads as Ntwine being down, and a worker told that retries — forever, since nothing it can do
 * from inside changes it. Every thread Ntwine creates runs with full access, so this is a thread a human
 * narrowed on purpose.
 */
function sandboxedOffNetwork() {
  return process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1"
}

/** @param {string} what @param {unknown} err */
function transportFailure(what, err) {
  if (sandboxedOffNetwork()) {
    return new Error(
      `${what} could not reach Ntwine: this shell is sandboxed with network access off ` +
      "(CODEX_SANDBOX_NETWORK_DISABLED=1), and that includes the Ntwine server on this machine. NOTHING " +
      "WAS SAVED, and no Ntwine command can work from this thread while it stays sandboxed — do not " +
      "retry. Say what you needed in your final message, and say there that this thread needs full " +
      "access before an Ntwine command can run.",
    )
  }
  if (causeCode(err) === "ECONNREFUSED") {
    return new Error(
      `${what} could not reach ntwine: its server refused the connection for a whole minute. NOTHING WAS SAVED — ` +
      "this command had no effect. ntwine is probably mid-restart, which is ordinary; RETRY this exact command before " +
      "you do anything else, and do not come to rest assuming it took.",
    )
  }
  const aborted = err instanceof Error && err.name === "AbortError"
  const how = aborted
    ? `ntwine did not answer within ${DISPATCH_TIMEOUT_MS / 1000}s`
    : `the connection to ntwine dropped before it answered (${causeCode(err) ?? (err instanceof Error ? err.message : String(err))}) — it was probably restarting`
  return new Error(
    `${what}: ${how}. This command MAY OR MAY NOT have taken effect. Check before repeating it — \`ntwinectl activity\` ` +
    "lists what this thread has registered — and repeat it if it did not land. Do not come to rest assuming it took.",
  )
}

/** A refusal ntwine wrote for the worker, without the transport wrapped around it. Every handler that
 *  throws answers HTTP 500 `{"error": "…"}` (packages/rpc errorEnvelope) and an input the schema rejects
 *  answers 400 the same way, so `extend_shell` used to read "extendOwnShell returned HTTP 500:
 *  {"error":"no background shell running…"}" — an internal procedure name, a status that says "server
 *  bug", and JSON quoting around the one sentence that mattered. Any other status (a 404 from a server
 *  that predates a procedure, which `goal get` matches on) keeps the status line.
 *  @param {string} what @param {number} status @param {string} detail */
function httpFailure(what, status, detail) {
  if (status === 400 || status === 500) {
    try {
      const error = JSON.parse(detail)?.error
      if (typeof error === "string" && error.trim()) return new Error(error.trim())
    } catch {}
  }
  return new Error(`${what} returned HTTP ${status}${detail ? `: ${detail.slice(0, 500)}` : ""}`)
}

/** POST to ntwine's RPC surface at `path`, riding out a restart: waits for a live lock, and retries a
 *  refused connection, inside one LOCK_RETRY_MS window. Returns the parsed payload; throws the legible
 *  errors above.
 *  @param {string} what the procedure name, for messages @param {string} path @param {unknown} body */
async function postToNtwine(what, path, body) {
  const deadline = Date.now() + LOCK_RETRY_MS
  for (;;) {
    const port = await serverLockPortWaiting(deadline)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS)
    let res
    try {
      res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        // No Origin header (undici omits it for non-browser fetch); `sec-fetch-site: same-origin`
        // satisfies the server's loopback-origin gate (app.ts isTrustedLocalHttpRequest).
        headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (err) {
      if (!sandboxedOffNetwork() && causeCode(err) === "ECONNREFUSED" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, LOCK_RETRY_INTERVAL_MS))
        continue
      }
      throw transportFailure(what, err)
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) throw httpFailure(what, res.status, await res.text().catch(() => ""))
    return await res.json().catch(() => null)
  }
}

/** POST an ntwine RPC procedure and return its parsed payload. @param {string} procedure
 *  @param {Record<string, unknown>} body @returns {Promise<any>} */
async function callRpc(procedure, body) {
  return postToNtwine(procedure, rpcPath(procedure), body)
}

/** Which thread is calling. Read from the environment the worker was started with, because nothing
 * else names the caller: a command run from a worker's shell inherits that worker's environment, and
 * the MCP protocol carries no caller identity at all.
 * NTWINE_THREAD is what a Claude worker's broker daemon is tagged with, so a shell inside one has it.
 * NTWINE_THREAD_SLUG is the explicit stamp, and wins: the MCP mount's own env, and the whole identity of
 * a codex thread's shell and an ACP agent, which must never carry NTWINE_THREAD — that is the orphan
 * reaper's ownership tag, and neither has the live `claude`/`codex` root that keeps a tagged process
 * from being reaped (packages/server/src/backend/types.ts ntwineCliEnv).
 *
 * This is also the reason a model can never point `goal` at someone else's thread: the slug is
 * read from HERE, never from the arguments. */
function threadSlug() {
  const slug = process.env.NTWINE_THREAD_SLUG || process.env.NTWINE_THREAD
  if (!slug) {
    // Ten commands resolve their caller through here, so the message must not name one of them. It said
    // "so it cannot arm a goal for it" for every single one — which read as a bug in `goal` no matter
    // which one the worker had actually called, and sent at least one worker off debugging the wrong
    // thing after `title` failed on a codex thread.
    throw new Error(
      "Ntwine could not tell which thread is calling (neither NTWINE_THREAD_SLUG nor NTWINE_THREAD is in this environment), so it cannot " +
      "act on the caller's own thread. Inside an Ntwine worker this is an Ntwine bug — report it rather than " +
      "working around it. Outside one there is no thread to act on.",
    )
  }
  return slug
}

/** A handler's answer when it did its job by REFUSING: a gate that held, not a fault. A front-end
 *  prints `text` like any other answer; the command line also exits 2, so a script can branch on it. */
class Refused {
  /** @param {string} text */
  constructor(text) { this.text = text }
}

/** How a heartbeat cadence reads back to the worker. ONE formatter, because `start` and `get` describe
 * the same stored number and a worker that saw "every 15m" armed must not read "every 900s" back.
 *
 * The house duration grammar (`packages/web/src/lib/durationLabels.ts`), matching the trailer
 * `formatIntervalLabel` writes into the delivery itself — a worker reads both.
 * @param {number|undefined} seconds */
function cadenceLabel(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return undefined
  if (seconds % 60 !== 0) return `${seconds}s`
  const minutes = seconds / 60
  if (minutes < 60) return `${minutes}m`
  return minutes % 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${Math.floor(minutes / 60)}h`
}

/** Render an armed goal for the worker to read: which triggers are live, the cadence, when
 * each last fired, and the text VERBATIM (never truncated — reading back a summary of your own
 * instruction is exactly as blind as not reading it).
 * @param {{ prompt: string, stopHook: boolean, heartbeat: boolean, postCompaction: boolean,
 *           intervalSeconds?: number, armedAt: string, lastRestFiredAt?: string,
 *           lastScheduleFiredAt?: string, lastCompactFiredAt?: string, runs?: number, maxRuns?: number,
 *           forSeconds?: number, endsAt?: string, stopped?: { reason: string, at: string } }} rp */
function goalReport(rp) {
  const fired = (/** @type {string|undefined} */ at) => (at ? `last fired ${at}` : "never fired yet")
  const triggers = [
    rp.stopHook ? `  stop_hook — every time you come to rest (${fired(rp.lastRestFiredAt)})` : null,
    rp.heartbeat
      // The SAME cadence form `start` reports (cadenceLabel), or the two readings of one row disagree
      // about the number they are describing — "every 15 min" armed, "every 900s" read back.
      ? `  heartbeat — every ${cadenceLabel(rp.intervalSeconds) ?? "?"} (${fired(rp.lastScheduleFiredAt)})`
      : null,
    rp.postCompaction ? `  post_compaction — every compaction (${fired(rp.lastCompactFiredAt)})` : null,
  ].filter(Boolean)
  // EVERY trigger off is a real, reachable state — the human can switch them off in the footer without
  // clearing the words — and it is the one a worker would otherwise misread as "armed and running".
  const head = rp.stopped
    ? `STOPPED at its ${rp.stopped.reason === "runs" ? "run" : "time"} limit (${rp.stopped.at}). Every trigger is off; ` +
      "the text is kept, and nothing will fire until the goal is re-armed — which starts a fresh count."
    : triggers.length
    ? `Armed since ${rp.armedAt}, on:\n${triggers.join("\n")}`
    : `Text is parked (armed ${rp.armedAt}) but EVERY TRIGGER IS OFF — nothing will fire until one is switched back on.`
  return `${head}\n${goalRunsLine(rp)}\n\nThe text, verbatim:\n\n${rp.prompt}`
}

/** The run counter and the limits, one line — the same reading the thread footer shows.
 * @param {{ runs?: number, maxRuns?: number, forSeconds?: number, endsAt?: string }} rp */
function goalRunsLine(rp) {
  const runs = rp.runs ?? 0
  const count = rp.maxRuns ? `Run ${runs} of ${rp.maxRuns}` : `Run ${runs} (no run cap)`
  if (!rp.forSeconds) return `${count}; no time bound.`
  const leftMs = rp.endsAt ? Date.parse(rp.endsAt) - Date.now() : NaN
  const left = Number.isFinite(leftMs) && leftMs > 0 ? `, ${durationLabel(Math.round(leftMs / 1000))} left` : ""
  return `${count}; time bound ${goalForLabel(rp.forSeconds)}, ends ${rp.endsAt ?? "?"}${left}.`
}

/** A span in the house grammar, two units at most: `45s`, `12m`, `2h 5m`, `3d 4h`.
 * @param {number} seconds */
function durationLabel(seconds) {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`
}

/** A time bound as the `for:` grammar writes it — the largest unit that divides it exactly.
 * @param {number} seconds */
function goalForLabel(seconds) {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`
  if (seconds % 60 === 0) return `${seconds / 60}m`
  return `${seconds}s`
}

/** The `goal` handler: arm, disarm, or READ BACK this thread's re-prompt.
 * @param {Record<string, unknown>} args @returns {Promise<string>} */
async function goal(args) {
  const slug = threadSlug()
  const action = typeof args.action === "string" ? args.action.trim() : ""
  if (action !== "start" && action !== "stop" && action !== "get") {
    throw new Error("`action` must be one of \"start\", \"stop\" or \"get\"")
  }

  if (action === "get") {
    // An ntwine server older than this tool has no such procedure and answers 404. Say what that means,
    // rather than leaving a worker to read a bare HTTP status as "nothing is armed" — the two answers
    // could not be further apart.
    let payload
    try {
      payload = await callRpc("getOwnThreadRecurringPrompt", { slug })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (/HTTP 404/.test(message)) {
        throw new Error(
          "this ntwine server predates the read action, so it cannot tell you what is armed. Treat the " +
          "armed state as UNKNOWN — do not assume it is empty — and check the thread footer instead.",
        )
      }
      throw err
    }
    const rp = payload?.result?.recurringPrompt
    if (!rp) return "No goal is armed on this thread. Nothing will re-prompt you."
    return goalReport(rp)
  }

  if (action === "stop") {
    await callRpc("setOwnThreadRecurringPrompt", { slug, prompt: null, stopHook: false, heartbeat: false, postCompaction: false })
    return "Goal disarmed and cleared. No trigger will fire — not the stop hook, not the heartbeat, not the post-compaction one — and the text is gone from the thread footer."
  }

  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : ""
  if (!prompt) {
    throw new Error("`prompt` is required to start a goal — it is the text you will be sent on every trigger")
  }

  const hasHeartbeat = args.heartbeat_seconds !== undefined && args.heartbeat_seconds !== null
  let interval
  if (hasHeartbeat) {
    interval = typeof args.heartbeat_seconds === "number" ? Math.round(args.heartbeat_seconds) : NaN
    if (!Number.isFinite(interval)) throw new Error("`heartbeat_seconds` must be a number of seconds")
    if (interval < MIN_INTERVAL_SECONDS || interval > MAX_INTERVAL_SECONDS) {
      throw new Error(`\`heartbeat_seconds\` must be between ${MIN_INTERVAL_SECONDS} and ${MAX_INTERVAL_SECONDS}`)
    }
  }
  const postCompaction = args.post_compaction === true
  // DEFAULTED, not required: a `start` that names no trigger at all is a model asking to be re-prompted
  // and leaving the mechanism to us, and the rest trigger is the safe reading of that — it cannot talk
  // over a running turn, and it cannot fire on a thread that has stopped needing it.
  const stopHook = typeof args.stop_hook === "boolean" ? args.stop_hook : !hasHeartbeat && !postCompaction
  const heartbeat = hasHeartbeat
  if (!stopHook && !heartbeat && !postCompaction) {
    throw new Error("at least one is required: `--stop-hook`, `--heartbeat-seconds <n>`, `--post-compaction`, or any combination")
  }

  // THE LIMITS. Sent EXPLICITLY, null included: a `start` replaces the whole goal, so one that names no
  // limit means an unbounded goal, not "keep whatever cap was there".
  let maxRuns = null
  if (args.max_runs !== undefined && args.max_runs !== null) {
    maxRuns = typeof args.max_runs === "number" ? Math.round(args.max_runs) : NaN
    if (!Number.isFinite(maxRuns) || maxRuns < 1 || maxRuns > GOAL_MAX_RUNS) {
      throw new Error(`\`--max-runs\` must be a whole number from 1 to ${GOAL_MAX_RUNS}`)
    }
  }
  let forSeconds = null
  if (args.for !== undefined && args.for !== null && args.for !== "") {
    const m = typeof args.for === "string" ? GOAL_FOR_RE.exec(args.for.trim()) : null
    forSeconds = m ? Number(m[1]) * GOAL_FOR_UNIT_SECONDS[/** @type {"s"|"m"|"h"|"d"} */ (m[2])] : NaN
    if (!m) throw new Error("`--for` must be a duration like `30m`, `2h` or `3d` — a number glued to one of s, m, h, d")
    if (forSeconds < GOAL_MIN_FOR_SECONDS || forSeconds > GOAL_MAX_FOR_SECONDS) {
      throw new Error("`--for` must be between `1m` and `30d`")
    }
  }

  const written = await callRpc("setOwnThreadRecurringPrompt", {
    slug,
    prompt,
    stopHook,
    heartbeat,
    postCompaction,
    ...(heartbeat ? { intervalSeconds: interval } : {}),
    maxRuns,
    forSeconds,
  })
  // `replaced` is absent against a server that predates it, which is indistinguishable from "there was
  // nothing" — so the clause only ever appears when the row genuinely carried something.
  const replaced = written?.result?.replaced

  const every = heartbeat ? cadenceLabel(interval) : null
  // One clause per armed trigger, joined — with three of them the old nested ternary could no longer say
  // what was actually armed, and a worker that misreads which trigger it holds waits for a delivery that
  // is never coming.
  const clauses = [
    stopHook ? "every time you come to rest" : null,
    every ? `every ${every} (the heartbeat reaches you mid-turn)` : null,
    postCompaction ? "every time your context is compacted, delivered into the emptied window" : null,
  ].filter(Boolean)
  const when = clauses.length === 1
    ? clauses[0]
    : `${clauses.slice(0, -1).join(", ")} AND ${clauses[clauses.length - 1]}`
  // Spelled out in full, not summarized: if this overwrote the human's own edit, the words themselves
  // are the only way the worker can put them back.
  const superseded = replaced
    ? `\n\nIT REPLACED an existing goal — check that discarding it was intended, and restore ` +
      `it with another \`ntwinectl goal start\` if it was not:\n\n${goalReport(replaced)}\n`
    : ""
  // NO QUESTION HOLD ANY MORE (2026-08-16). Every trigger fires while you are waiting on the human, and
  // the at-rest one fires over your own unanswered registered question — the delivery says so, and expects
  // you to decide the question yourself rather than re-ask it. A ```done fence, and an ```awaiting on a
  // wait ntwine itself will deliver, still stop the at-rest trigger.
  const limits = [
    maxRuns ? `at most ${maxRuns} time${maxRuns === 1 ? "" : "s"}` : null,
    forSeconds ? `for ${goalForLabel(forSeconds)}` : null,
  ].filter(Boolean)
  const bound = limits.length
    ? ` It is a bounded loop: ${limits.join(", and ")} — whichever comes first disarms it, and you will be told once.`
    : ""
  return (
    `Goal armed — ntwine will send you this ${when}.${bound}${superseded}\n\n` +
    "Run `ntwinectl goal stop` once the work it drives is finished — one left armed on " +
    "a finished thread wakes it forever. The user can also edit or switch it off in the thread footer. " +
    "Signing off with a ```done fence stops it too, but only when there is genuinely nothing left: it " +
    "files the thread away until the user sends more work."
  )
}

/** How a timer reads back to the worker: its id, when it fires, and enough of its text to tell two apart.
 * @param {{ id: string, fireAt: string, prompt: string }} t */
function timerLine(t) {
  const words = t.prompt.replace(/\s+/g, " ").trim()
  return `  ${t.id} — ${t.fireAt} — ${words.length > 72 ? `${words.slice(0, 72)}…` : words}`
}

/** @param {{ timers?: { id: string, fireAt: string, prompt: string }[] }|null} payload */
function armedList(payload) {
  const timers = payload?.timers ?? []
  if (!timers.length) return "No timers are armed on this thread."
  return `Armed timers (${timers.length}):\n${timers.map(timerLine).join("\n")}`
}

/** The `timer` handler: set / cancel / list this thread's ONE-OFF timers.
 * @param {Record<string, unknown>} args @returns {Promise<string>} */
async function timer(args) {
  const slug = threadSlug()
  const action = typeof args.action === "string" ? args.action.trim() : ""
  if (action !== "set" && action !== "cancel" && action !== "list") {
    throw new Error("`action` must be one of \"set\", \"cancel\" or \"list\"")
  }

  if (action === "list") {
    return armedList((await callRpc("listOwnThreadTimers", { slug }))?.result)
  }

  if (action === "cancel") {
    const id = typeof args.id === "string" ? args.id.trim() : ""
    if (!id) throw new Error("`id` is required to cancel a timer — take it from `ntwinectl timer set`'s reply or from `ntwinectl timer list`")
    const result = (await callRpc("cancelOwnThreadTimer", { slug, id }))?.result
    const head = result?.cancelled
      ? `Timer ${id} cancelled — it will not fire.`
      : `No ARMED timer ${id} on this thread (it may have already fired, or already been cancelled).`
    return `${head}\n\n${armedList(result)}`
  }

  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : ""
  if (!prompt) throw new Error("`prompt` is required to set a timer — it is the text you will be sent when it fires")

  // Exactly one of the two ways to name the instant. Accepting both would mean silently preferring one,
  // and a worker that gave two different times meant something by each of them.
  const hasIn = args.in_seconds !== undefined && args.in_seconds !== null
  const hasAt = typeof args.at === "string" && args.at.trim() !== ""
  if (hasIn && hasAt) throw new Error("give `--in-seconds` OR `--at`, not both")
  if (!hasIn && !hasAt) throw new Error("give either `--in-seconds` (fire N seconds from now) or `--at` (an ISO-8601 instant)")

  const nowMs = Date.now()
  let fireMs
  if (hasIn) {
    const seconds = typeof args.in_seconds === "number" ? Math.round(args.in_seconds) : NaN
    if (!Number.isFinite(seconds)) throw new Error("`in_seconds` must be a number of seconds")
    if (seconds < TIMER_MIN_DELAY_SECONDS || seconds > TIMER_MAX_DELAY_SECONDS) {
      throw new Error(`\`in_seconds\` must be between ${TIMER_MIN_DELAY_SECONDS} and ${TIMER_MAX_DELAY_SECONDS} (thirty days)`)
    }
    fireMs = nowMs + seconds * 1000
  } else {
    fireMs = Date.parse(String(args.at))
    if (!Number.isFinite(fireMs)) throw new Error("`at` must be an ISO-8601 instant, e.g. `2026-08-04T15:00:00Z`")
    const delta = Math.round((fireMs - nowMs) / 1000)
    if (delta < TIMER_MIN_DELAY_SECONDS) {
      throw new Error(`\`at\` must be at least ${TIMER_MIN_DELAY_SECONDS}s in the future (it reads as ${delta}s from now)`)
    }
    if (delta > TIMER_MAX_DELAY_SECONDS) throw new Error("`at` must be within thirty days")
  }

  // ONE representation crosses the wire — the exact UTC instant — so the stored row, the trailer on the
  // delivered message and this reply all name the same string.
  const fireAt = new Date(fireMs).toISOString()
  const result = (await callRpc("setOwnThreadTimer", { slug, prompt, fireAt }))?.result
  const id = result?.id ?? "(unknown)"
  return (
    `Timer ${id} set for ${fireAt} (${Math.round((fireMs - nowMs) / 1000)}s from now). It fires ONCE and ` +
    "then is gone — it may reach you mid-turn, so receiving it does not mean you had stopped. Cancel it " +
    `with \`ntwinectl timer cancel ${id}\` if it stops being useful.\n\n${armedList(result)}`
  )
}


/** How the armed PR-watcher set reads back, on every action, so a worker never needs a second call.
 * @param {{ watches?: Array<{id: string, target: string, github?: {checks: string, running: number, passed: number, failed: number, failing: string[], merge: string, state: string}}> }|undefined} result */
function armedPrWatchList(result) {
  // Only the PULL REQUESTS: the registry holds issues too (`watch_issue`), and each command reads back its
  // own kind so a worker asking where its PRs stand is not told about an issue it registered elsewhere.
  const watches = (Array.isArray(result?.watches) ? result.watches : []).filter((w) => w.kind !== "issue")
  if (!watches.length) return "No pull requests are watched on this thread — nothing will wake you."
  const lines = watches.map((w) => {
    const g = w.github
    // The CHECK STATE rides the read-back because it is the reason a worker is listing at all: "where do
    // my PRs stand" is one call, not one per PR through `gh`.
    const state = !g
      ? "not polled yet"
      : g.state !== "open"
        ? g.state
        : g.checks === "passing" ? `checks green (${g.passed})`
        : g.checks === "failing" ? `checks FAILING${g.failing.length ? `: ${g.failing.join(", ")}` : ""}`
        : g.checks === "running" ? `checks running (${g.running} left)`
        : "no checks"
    return `  ${w.id}  ${w.target}  —  ${state}${g && g.state === "open" && g.merge === "mergeable" ? ", mergeable" : ""}`
  })
  return `Watched on this thread now:\n${lines.join("\n")}`
}

/** The issue twin of armedPrWatchList: the ISSUES watched on this thread, with each one's last-polled state.
 * @param {{ watches?: Array<{id: string, kind?: string, target: string, issue?: {state: string, stateReason?: string, title?: string, comments: number}}> }|undefined} result */
function armedIssueWatchList(result) {
  const watches = (Array.isArray(result?.watches) ? result.watches : []).filter((w) => w.kind === "issue")
  if (!watches.length) return "No issues are watched on this thread — nothing will wake you."
  const lines = watches.map((w) => {
    const i = w.issue
    const state = !i
      ? "not polled yet"
      : i.state === "closed"
        ? `closed${i.stateReason ? ` (${i.stateReason.replace(/_/g, " ")})` : ""}`
        : `open, ${i.comments} comment${i.comments === 1 ? "" : "s"}`
    return `  ${w.id}  ${w.target}${i?.title ? `  "${i.title}"` : ""}  —  ${state}`
  })
  return `Issues watched on this thread now:\n${lines.join("\n")}`
}

/** The armed watches on this thread, as the read-back prints them. */
function armedWatchList(result) {
  const watches = Array.isArray(result?.watches) ? result.watches : []
  if (!watches.length) return "No watches are armed on this thread — nothing here is holding it out of the queue."
  const lines = watches.map((w) => {
    const what = w.kind === "agent" ? "sub-agent" : "shell"
    // The LABEL is ntwine's live reading, not a copy stored at registration — so it names the work as it
    // stands, and its ABSENCE means the target no longer resolves to anything running.
    const name = w.label ? `${w.label} (${w.target})` : w.target
    return `  ${w.id}  ${what}: ${name}  —  expires ${w.expiresAt}`
  })
  return `Armed on this thread now:\n${lines.join("\n")}`
}

/** The `watch` handler: register a wait on this thread's own running work.
 * @param {Record<string, unknown>} args @returns {Promise<string>} */
async function watch(args) {
  const slug = threadSlug()
  const kind = typeof args.kind === "string" ? args.kind.trim() : ""
  if (kind !== "shell" && kind !== "agent") throw new Error("`kind` must be \"shell\" or \"agent\"")
  const target = typeof args.target === "string" ? args.target.trim() : ""
  if (!target) throw new Error("`target` is required — the handle you were shown; `ntwinectl activity` prints them all")
  const forValue = typeof args.for === "string" ? args.for.trim() : ""
  if (!forValue) throw new Error("`for` is required — a DURATION like `30m`, `2h` or `3d` (max 24h), never an instant")
  const result = (await callRpc("addOwnWatch", { slug, kind, target, for: forValue }))?.result
  const id = result?.id ?? "(unknown)"
  const head = result?.alreadyArmed
    ? `Already watching \`${target}\` as ${id} — nothing new was registered, and its original expiry stands.`
    : `Watching \`${target}\` as ${id}. Your thread is held out of the queue until it finishes, and the ` +
      "registration survives your turn ending, a compaction and an ntwine restart."
  // A clamp is news here for the same reason it is on `watch_pr` — see that handler.
  const clamped = result?.clampedFrom
    ? `\n\nYOUR \`--for ${result.clampedFrom}\` WAS CAPPED at the 24h ceiling for a shell or a sub-agent — ` +
      "the expiry listed below is what you actually hold."
    : ""
  return (
    `${head}${clamped}\n\nWHEN \`--for\` RUNS OUT the row is CANCELLED and you are woken to re-decide — register ` +
    `again if you still mean it.\n\nDROP IT the moment it stops mattering (\`ntwinectl unwatch ${id}\`); ` +
    `you do NOT need to when the work simply finishes.\n\n${armedWatchList(result)}`
  )
}

/** The `unwatch` handler: withdraw one registered watch by id.
 * @param {Record<string, unknown>} args @returns {Promise<string>} */
async function unwatch(args) {
  const slug = threadSlug()
  const id = typeof args.id === "string" ? args.id.trim() : ""
  if (!id) throw new Error("`id` is required — take it from `ntwinectl watch` or from `ntwinectl activity`")
  // A PR, issue or timer id is not a `watch` row, and dropOwnWatch would report it "already settled"
  // while it stayed armed. The id prefix names its kind, so the one verb a worker reaches for routes it
  // to the call that really withdraws it.
  if (id.startsWith("prw_") || id.startsWith("isw_")) {
    const dropped = (await callRpc("dropOwnPrWatch", { slug, id }))?.result
    const kind = id.startsWith("isw_") ? "issue" : "pull request"
    const head = dropped?.dropped
      ? `Watcher ${id} dropped. It will not wake you.`
      : `No ARMED ${kind} watcher ${id} on this thread — it was already settled, or the id is not one of yours.`
    return `${head}\n\n${id.startsWith("isw_") ? armedIssueWatchList(dropped) : armedPrWatchList(dropped)}`
  }
  if (id.startsWith("cmw_")) {
    const dropped = (await callRpc("dropOwnCommandWatch", { slug, id }))?.result
    const head = dropped?.dropped
      ? `Command watch ${id} dropped. Ntwine will not run it again, and it will not wake you.`
      : `No ARMED command watch ${id} on this thread — it already passed, expired or was cancelled, or the id is not one of yours.`
    return `${head}\n\n${armedCommandWatchList(dropped)}`
  }
  if (id.startsWith("tmr_")) {
    const cancelled = (await callRpc("cancelOwnThreadTimer", { slug, id }))?.result
    const head = cancelled?.cancelled
      ? `Timer ${id} cancelled — it will not fire.`
      : `No ARMED timer ${id} on this thread (it may have already fired, or already been cancelled).`
    return `${head}\n\n${armedList(cancelled)}`
  }
  const result = (await callRpc("dropOwnWatch", { slug, id }))?.result
  // A drop that matched nothing is reported rather than swallowed: the id was wrong, already settled, or
  // another thread's — and a worker that believes it withdrew a wait it still holds will rest on it.
  const head = result?.dropped
    ? `Watch ${id} dropped. It is no longer holding your thread, and it will not wake you.`
    : `No ARMED watch ${id} on this thread — it was already settled, or the id is not one of yours.`
  return `${head}\n\n${armedWatchList(result)}`
}

/** Read back what the human still owes an answer on, so a worker never needs a second call to find out.
 * @param {Record<string, unknown> | undefined} result @returns {string} */
function openQuestionList(result) {
  const open = Array.isArray(result?.open) ? result.open : []
  if (!open.length) return "Nothing else is open on this thread — the user owes you no answer."
  const lines = open.map((q) => `  ${q.id}  ${(q.spec?.question ?? "").split("\n")[0]}`)
  return `Open on this thread now:\n${lines.join("\n")}`
}

/** The `ask` handler: register one or more questions the human owes an answer to.
 * @param {Record<string, unknown>} args @returns {Promise<string>} */
async function ask(args) {
  const slug = threadSlug()
  const questions = Array.isArray(args.questions) ? args.questions : []
  if (!questions.length) throw new Error("`questions` is required — at least one question to register")
  const result = (await callRpc("ask", { slug, questions }))?.result
  const registered = Array.isArray(result?.registered) ? result.registered : []
  const lines = registered.map((q) => `  ${q.id}  ${(q.spec?.question ?? "").split("\n")[0]}`)
  const head = registered.length === 1
    ? "Registered 1 question. It stays open until the user answers it."
    : `Registered ${registered.length} questions. They stay open until answered — the card sends every ` +
      "answer as one batch."
  return (
    `${head}\n${lines.join("\n")}\n\n` +
    "NOW WRITE YOUR FINAL MESSAGE, THEN REST. The card holds only the choice; it renders under that " +
    "message, which must carry everything the user needs to make it — what you found, the evidence, " +
    "and the answer to anything they asked — written out in full. \"The decision is in the card below\" " +
    "is not a handoff: a worker once ended a PR review on exactly that line, and the review itself " +
    "existed only in its thinking, which the user never sees. The user is not prompted until you " +
    "rest: while your turn runs the thread spins in the Active band, not the queue, and the card waits " +
    "unseen — so do no further WORK that does not depend on the answer, but never shorten the write-up " +
    "to rest sooner. The open question is your sign-off. If you are about to keep " +
    "going for long on your own best guess, `ntwinectl unask <id>` it and decide instead. The answer arrives as its " +
    "own wake, restating what was asked.\n\n" +
    "WITHDRAW ONE THE MOMENT IT STOPS MATTERING (`ntwinectl unask <id>`), above all if you work the answer out " +
    `yourself.\n\n${openQuestionList(result)}`
  )
}

/** The `secret` handler: register ONE masked question, and hand back the pipe its value will be read from.
 *  It rides the `ask` RPC with `secret: true` — the card, the wake, the `done` gate and the `questions:`
 *  naming are all a question's — and the server is what keeps the value out of every one of them.
 * @param {Record<string, unknown>} args @returns {Promise<string>} */
async function secret(args) {
  const slug = threadSlug()
  const question = typeof args.question === "string" ? args.question.trim() : ""
  if (!question) throw new Error("`question` is required — say what the user should paste, and for what")
  const header = typeof args.header === "string" && args.header.trim() ? args.header.trim() : undefined
  const result = (await callRpc("ask", { slug, questions: [{ question, kind: "question", secret: true, ...(header ? { header } : {}) }] }))?.result
  const registered = Array.isArray(result?.registered) ? result.registered[0] : undefined
  const path = typeof registered?.secretPath === "string" ? registered.secretPath : ""
  if (!registered?.id || !path) throw new Error("Ntwine did not return the secret's file — this server predates `secret`; restart Ntwine and retry")
  // Quoted, because the macOS state dir is `~/Library/Application Support/…` and an unquoted path
  // splits at the space.
  const quoted = `'${path.replace(/'/g, `'\\''`)}'`
  return (
    `Registered secret request ${registered.id}. The user sees a masked box on the board.\n\n` +
    `Once answered, the value can be read ONCE, within 15 minutes, at:\n  ${path}\n\n` +
    `Read it INSIDE the command that uses it — \`--otp "$(cat ${quoted})"\` — and never cat, echo or copy ` +
    "it on its own: that spends the one read. Several commands share it through a variable set at the " +
    "start of ONE Bash call. Get the command ready now: the answer wakes you, and a one-time code expires " +
    "within a minute.\n\n" +
    `${openQuestionList(result)}`
  )
}

/** The `unask` handler: withdraw one registered question by id.
 * @param {Record<string, unknown>} args @returns {Promise<string>} */
async function unask(args) {
  const slug = threadSlug()
  const id = typeof args.id === "string" ? args.id.trim() : ""
  if (!id) throw new Error("`id` is required — take it from `ntwinectl ask` or `ntwinectl activity`")
  const result = (await callRpc("unask", { slug, id }))?.result
  // A withdrawal that matched nothing is reported rather than swallowed: the id was wrong, the human
  // already answered it, or it is another thread's — and a worker that believes it withdrew a question
  // the human is still looking at will get an answer it has stopped expecting.
  const head = result?.withdrawn
    ? `Question ${id} withdrawn. Its card is gone and the user will not be asked.`
    : `No OPEN question ${id} on this thread — it was already answered or dismissed, or the id is not one of yours.`
  return `${head}\n\n${openQuestionList(result)}`
}

/** The `schedule` handler: propose a recurring thread, or move one occurrence of an active one. The server
 *  builds the reply — the echo the worker relays verbatim — so this only shapes the request.
 * @param {Record<string, unknown>} args @returns {Promise<string>} */
async function schedule(args) {
  const slug = threadSlug()
  // `dry-run` is `dry_run`: a command line spells words with hyphens, and both arrive here.
  const action = typeof args.action === "string" ? args.action.trim().replace(/-/g, "_") : ""
  const actions = ["create", "dry_run", "update", "list", "pause", "skip_next", "move_next"]
  if (!actions.includes(action)) throw new Error(`\`action\` must be one of ${actions.map((a) => a.replace(/_/g, "-")).join(", ")}`)
  /** @param {string} key */
  const text = (key) => (typeof args[key] === "string" && args[key].trim() ? args[key].trim() : undefined)
  /** @type {Record<string, unknown>} */
  const body = { action, slug }
  if (action !== "list" && action !== "create" && action !== "dry_run") {
    const id = text("id")
    if (!id) throw new Error("`id` is required — take the `sch_…` id from `create`'s answer or from `ntwinectl schedule list`")
    body.id = id
  }
  if (action === "create" || action === "dry_run" || action === "update") {
    for (const key of ["title", "prompt", "when", "rrule", "dtstart", "tz", "condition", "model", "effort", "backend"]) {
      const value = text(key)
      if (value !== undefined) body[key] = value
    }
    if (action !== "update") {
      for (const key of ["title", "prompt", "when", "rrule", "dtstart"]) {
        if (body[key] === undefined) throw new Error(`\`${key}\` is required to ${action === "create" ? "create" : "dry-run"} a schedule`)
      }
      // Required with no default, like spawn_thread: every run is a paid agent session, and a defaulted
      // model is the cheap one picked by nobody.
      if (body.model === undefined) throw new Error("`model` is required — choose it for what ONE run must do (claude: opus/sonnet/haiku; codex: a model id with `--backend codex`). There is no default.")
      if (body.effort === undefined) throw new Error("`effort` is required — choose it for what one run must do (low/medium/high/xhigh/max). There is no default.")
    }
  }
  if (action === "skip_next") {
    const reason = text("reason")
    if (reason) body.reason = reason
  }
  if (action === "move_next") {
    const to = text("to")
    if (!to) throw new Error("`to` is required — the new start, as a local time in the schedule's zone (`2026-10-15T10:00`) or an ISO instant")
    body.to = to
  }
  const result = (await callRpc("ownSchedule", body))?.result
  if (typeof result?.text !== "string") throw new Error(`ownSchedule returned no reply: ${JSON.stringify(result)?.slice(0, 300)}`)
  return result.text
}

/** The `done` handler: declare the effort finished, or report exactly what refuses to let it.
 * @param {Record<string, unknown>} args @returns {Promise<string>} */
async function done(args) {
  const slug = threadSlug()
  const body = typeof args.body === "string" ? args.body.trim() : ""
  if (!body) throw new Error("`body` is required — the write-up the user reads on the card")
  const quiet = args.quiet === true
  const result = (await callRpc("markOwnDone", { slug, body, ...(quiet ? { quiet: true } : {}) }))?.result
  if (result?.done && quiet) {
    return (
      "Marked done QUIETLY. This run is filed under Done, out of the user's queue, and your body's first " +
      "line is its line in the schedule's history. End your turn now."
    )
  }
  if (result?.done) {
    return (
      "Marked done. Your thread cards as a checked success in the user's queue and stays there until " +
      "they archive it.\n\nNOTHING WAS CLOSED, HIDDEN OR ARCHIVED. The user reads your prose above this " +
      "card and nothing else — not your thinking, not your tool calls. If that prose does not already " +
      "hold the result in full (the answer itself, when they asked a question), write it now as your " +
      "final message. Never end on an acknowledgement like \"Signed off as done.\": on the card it is " +
      "the whole reply. If more work appears, keep going and run this again."
    )
  }
  // REFUSED, with everything that refuses it named by id, so the next move is a command and not a
  // guess. Reported as an ordinary result rather than thrown: this is a gate doing its job, not a fault.
  const questions = (result?.blockingQuestions ?? []).map((q) => `  ${q.id}  ${(q.question ?? "").split("\n")[0]}`)
  const watches = (result?.blockingWatches ?? []).map((w) => `  ${w.id}  ${w.what}`)
  const parts = ["NOT marked done. This thread still holds work open."]
  if (questions.length) {
    parts.push(
      `${questions.length} question${questions.length === 1 ? "" : "s"} the user has not answered:\n${questions.join("\n")}\n` +
      "Each one dies unread with a done card. Decide it yourself and withdraw it (`ntwinectl unask <id>`), or leave it " +
      "open and keep working until it is answered.",
    )
  }
  if (watches.length) {
    parts.push(
      `${watches.length} registration${watches.length === 1 ? "" : "s"} still armed:\n${watches.join("\n")}\n` +
      "A live wait means the thing you were waiting for has not happened. Wait for it, or drop the ones " +
      "that stopped mattering (`ntwinectl unwatch <id>` takes a watch, a PR or issue watcher, a timer, or a command watch).",
    )
  }
  parts.push("There is no force flag. Resolve them and run `ntwinectl done` again.")
  return new Refused(parts.join("\n\n"))
}

/** The `watch_pr` handler: register, withdraw, or read back this thread's PR watchers.
 * @param {Record<string, unknown>} args @returns {Promise<string>} */
async function watchPr(args) {
  const slug = threadSlug()
  const action = typeof args.action === "string" ? args.action.trim() : ""
  if (action !== "add" && action !== "list" && action !== "drop") {
    throw new Error("`action` must be one of \"add\", \"list\" or \"drop\"")
  }

  if (action === "list") {
    return armedPrWatchList((await callRpc("listOwnPrWatches", { slug }))?.result)
  }

  if (action === "drop") {
    const id = typeof args.id === "string" ? args.id.trim() : ""
    if (!id) throw new Error("`id` is required to drop a watcher — take it from `add` or from `list`")
    const result = (await callRpc("dropOwnPrWatch", { slug, id }))?.result
    // A drop that matched nothing is reported rather than swallowed: the id was wrong, already settled,
    // or another thread's — and a worker that believes it withdrew a wait it still holds will rest.
    const head = result?.dropped
      ? `Watcher ${id} dropped. It will not wake you.`
      : `No ARMED watcher ${id} on this thread — it was already settled, or the id is not one of yours.`
    return `${head}\n\n${armedPrWatchList(result)}`
  }

  const target = typeof args.target === "string" ? args.target.trim() : ""
  if (!target) throw new Error("`target` is required — the pull request, as `owner/repo#123` or a PR URL")
  const result = (await callRpc("addOwnPrWatch", { slug, target, for: typeof args.for === "string" ? args.for.trim() : "" }))?.result
  const id = result?.id ?? "(unknown)"
  const ref = result?.target ?? target
  const until = result?.expiresAt ? ` until ${result.expiresAt}` : ""
  const head = result?.alreadyArmed
    ? `Already watching ${ref} as ${id}${until} — nothing new was registered, its original expiry stands, and you will be woken once per event.`
    : `Watching ${ref} as ${id}${until}. Ntwine wakes you when CI passes or fails and on every later ` +
      "review or comment, and the registration survives your turn ending, a compaction and an ntwine restart."
  // A CLAMP IS NEWS. Silently handing back less coverage than was asked for is how a worker comes to
  // rest believing it is watched for a year when it is watched for one day.
  const clamped = result?.clampedFrom
    ? `\n\nYOUR \`--for ${result.clampedFrom}\` WAS CAPPED at the ceiling — the expiry above is what you ` +
      "actually hold. Nothing else about the watcher changed."
    : ""
  return (
    `${head}${clamped}\n\nNAME IT IN YOUR \`\`\`awaiting FENCE TOO (\`prs: [${ref}]\`) — the watcher does the ` +
    `waking, the fence is what lets you come to rest and shows the user what you are waiting for.\n\n` +
    `DROP IT when it stops mattering (\`ntwinectl watch-pr drop ${id}\`).\n\n${armedPrWatchList(result)}`
  )
}

/** The `watch_issue` handler: register, withdraw, or read back this thread's issue watchers. The same
 * three RPCs as `watchPr` — one registry — with `kind: "issue"` on the add.
 * @param {Record<string, unknown>} args @returns {Promise<string>} */
async function watchIssue(args) {
  const slug = threadSlug()
  const action = typeof args.action === "string" ? args.action.trim() : ""
  if (action !== "add" && action !== "list" && action !== "drop") {
    throw new Error("`action` must be one of \"add\", \"list\" or \"drop\"")
  }

  if (action === "list") {
    return armedIssueWatchList((await callRpc("listOwnPrWatches", { slug }))?.result)
  }

  if (action === "drop") {
    const id = typeof args.id === "string" ? args.id.trim() : ""
    if (!id) throw new Error("`id` is required to drop a watcher — take it from `add` or from `list`")
    const result = (await callRpc("dropOwnPrWatch", { slug, id }))?.result
    const head = result?.dropped
      ? `Watcher ${id} dropped. It will not wake you.`
      : `No ARMED watcher ${id} on this thread — it was already settled, or the id is not one of yours.`
    return `${head}\n\n${armedIssueWatchList(result)}`
  }

  const target = typeof args.target === "string" ? args.target.trim() : ""
  if (!target) throw new Error("`target` is required — the issue, as `owner/repo#123` or a GitHub issue URL")
  const forValue = typeof args.for === "string" ? args.for.trim() : ""
  if (!forValue) throw new Error("`for` is required — a DURATION like `3d`, `30d` or `180d` (max 365d), never an instant")
  const result = (await callRpc("addOwnPrWatch", { slug, target, for: forValue, kind: "issue" }))?.result
  const id = result?.id ?? "(unknown)"
  const ref = result?.target ?? target
  const until = result?.expiresAt ? ` until ${result.expiresAt}` : ""
  const head = result?.alreadyArmed
    ? `Already watching ${ref} as ${id}${until} — nothing new was registered, its original expiry stands, and you will be woken once per event.`
    : `Watching issue ${ref} as ${id}${until}. Ntwine wakes you on every later comment, on a label or ` +
      "assignee change, and when the issue closes; the registration survives your turn ending, a compaction and an ntwine restart."
  const clamped = result?.clampedFrom
    ? `\n\nYOUR \`--for ${result.clampedFrom}\` WAS CAPPED at the ceiling — the expiry above is what you ` +
      "actually hold. Nothing else about the watcher changed."
    : ""
  return (
    `${head}${clamped}\n\nNAME IT IN YOUR \`\`\`awaiting FENCE TOO (\`issues: [${ref}]\`) — the watcher does the ` +
    `waking, the fence is what lets you come to rest and shows the user what you are waiting for.\n\n` +
    `DROP IT when it stops mattering (\`ntwinectl watch-issue drop ${id}\`).\n\n${armedIssueWatchList(result)}`
  )
}

/** The command watches armed on this thread, as every `watch-command` action reads them back.
 * @param {{ watches?: Array<{id: string, command: string, every: string, expiresAt: string, runs: number, lastRun?: {outcome: string, exitCode: number|null}}> }|undefined} result */
function armedCommandWatchList(result) {
  const watches = Array.isArray(result?.watches) ? result.watches : []
  if (!watches.length) return "No command watches are armed on this thread — none will wake you."
  const lines = watches.map((w) => {
    const last = !w.lastRun
      ? "no check finished yet"
      : `last check ${commandRunClause(w.lastRun)}`
    return `  ${w.id}  every ${w.every}, until ${w.expiresAt} — ${w.runs} check${w.runs === 1 ? "" : "s"}, ${last}\n    $ ${w.command}`
  })
  return `Command watches on this thread now:\n${lines.join("\n")}`
}

/** "exited 1", "timed out", … — how one check ended. @param {{outcome: string, exitCode: number|null}} run */
function commandRunClause(run) {
  if (run.outcome === "exit") return `exited ${run.exitCode}`
  if (run.outcome === "timeout") return "timed out"
  if (run.outcome === "signal") return "was killed by a signal"
  return "could not start"
}

/** The end of a check's output, short enough to read inline. @param {string|undefined} output */
function outputTail(output) {
  const text = String(output ?? "").trim()
  if (!text) return "It printed nothing."
  const tail = text.length > 800 ? `…${text.slice(-800)}` : text
  return `Its output ended:\n${tail.split("\n").map((l) => `  ${l}`).join("\n")}`
}

/** The `watch_command` handler: register, withdraw, or read back this thread's command watches.
 * @param {Record<string, unknown>} args @returns {Promise<string|Refused>} */
async function watchCommand(args) {
  const slug = threadSlug()
  const action = typeof args.action === "string" ? args.action.trim() : ""
  if (action !== "add" && action !== "list" && action !== "drop") {
    throw new Error("`action` must be one of \"add\", \"list\" or \"drop\"")
  }

  if (action === "list") {
    return armedCommandWatchList((await callRpc("listOwnCommandWatches", { slug }))?.result)
  }

  if (action === "drop") {
    const id = typeof args.id === "string" ? args.id.trim() : ""
    if (!id) throw new Error("`id` is required to drop a command watch — take it from `add` or from `list`")
    const result = (await callRpc("dropOwnCommandWatch", { slug, id }))?.result
    const head = result?.dropped
      ? `Command watch ${id} dropped. Ntwine will not run it again, and it will not wake you.`
      : `No ARMED command watch ${id} on this thread — it already passed, expired or was cancelled, or the id is not one of yours.`
    return `${head}\n\n${armedCommandWatchList(result)}`
  }

  const command = typeof args.command === "string" ? args.command.trim() : ""
  if (!command) throw new Error("`command` is required — a shell command that exits 0 once the condition holds")
  const every = typeof args.every === "string" ? args.every.trim() : ""
  if (!every) throw new Error("`every` is required — how often to check, a DURATION like `5m` (min 1m, max 24h)")
  const forValue = typeof args.for === "string" ? args.for.trim() : ""
  if (!forValue) throw new Error("`for` is required — how long to keep checking, a DURATION like `6h` or `3d` (max 7d)")
  const result = (await callRpc("addOwnCommandWatch", { slug, command, every, for: forValue }))?.result
  // A REFUSAL is the gate doing its job, not a fault: exit 2, with the reason and the background-shell
  // fallback in the server's own words.
  if (result?.refused) {
    const ran = result.firstRun ? `\n\n${outputTail(result.firstRun.output)}` : ""
    return new Refused(`NOT registered. ${result.refused}${ran}`)
  }
  if (result?.passed) {
    return (
      "NOTHING WAS ARMED: your command exited 0 on its first check, so the condition already holds. Carry on " +
      `with whatever you were going to wait for.\n\n${outputTail(result.firstRun?.output)}`
    )
  }
  const id = result?.id ?? "(unknown)"
  if (result?.alreadyArmed) {
    return (
      `Already watching this command as ${id} (every ${result.every}, until ${result.expiresAt}) — nothing new was ` +
      `registered, and its original expiry stands.\n\n${armedCommandWatchList(result)}`
    )
  }
  const first = result?.firstRun
    ? result.firstRun.outcome === "timeout"
      ? "Its first check did not finish in time, so Ntwine runs it again now with the full 2m."
      : `Its first check ${commandRunClause(result.firstRun)}. ${outputTail(result.firstRun.output)}`
    : "Ntwine runs its first check within the next minute."
  // A CLAMP IS NEWS, as on every other `for` — a worker told nothing rests on coverage it does not have.
  const clamps = []
  if (result?.clamped?.every) clamps.push(`\`--every ${result.clamped.every}\` was clamped to ${result.every}`)
  if (result?.clamped?.for) clamps.push(`\`--for ${result.clamped.for}\` was capped at the 7d ceiling`)
  const clamped = clamps.length ? `\n\nYOUR ${clamps.join(", and ")} — what is listed below is what you hold.` : ""
  return (
    `Watching as ${id}: Ntwine runs it every ${result?.every} until it exits 0, or until ${result?.expiresAt}, and ` +
    `then wakes you once with its output. Nothing of yours runs meanwhile.\n\n${first}${clamped}\n\n` +
    `NAME IT IN YOUR \`\`\`awaiting FENCE (\`commands: [${id}]\`, \`status: watching\`) and come to rest. DROP IT ` +
    `when it stops mattering (\`ntwinectl watch-command drop ${id}\`).\n\n${armedCommandWatchList(result)}`
  )
}

/**
 * HOW EACH COMMAND IS SPELLED ON A COMMAND LINE. The schema above already says what a command takes;
 * this says the three things a schema cannot:
 *
 *   summary    — the one line `ntwinectl --help` lists it under. The description is the full reference
 *                and is printed only by `ntwinectl <command> --help`, so a worker reads the long text of
 *                the command it is about to run and of no other.
 *   positional — which arguments may be given bare, in order (`ntwinectl title "Fix queue focus"`).
 *                Every argument is ALSO a `--flag`, and the whole set a JSON object through `--input`.
 *   then       — further positionals that depend on the first one's value, for the commands that
 *                switch on an `action` (`ntwinectl timer cancel tmr_ab12`).
 *   wrap       — the one array argument a bare JSON array, or a single item, is taken to be
 *                (`ask` with one question object, or a list of them).
 *   examples   — real invocations, shown under the command's own help.
 *
 * `group` only orders the top-level listing.
 */
const CLI = {
  ask: {
    group: "Sign off",
    summary: "Ask the user a question; registers an answerable card",
    wrap: "questions",
    examples: [
      "ntwinectl ask --input - <<'JSON'\n" +
      '{"questions": [{\n' +
      '  "question": "Should the settings store use SQLite or a JSON file?",\n' +
      '  "kind": "question",\n' +
      '  "options": [\n' +
      '    {"label": "SQLite", "description": "transactional, matches how sessions are stored", "recommended": true},\n' +
      '    {"label": "JSON file", "description": "zero deps, human-editable, racy under concurrent writes"}\n' +
      "  ]\n" +
      "}]}\n" +
      "JSON",
      "ntwinectl ask --input questions.json",
    ],
  },
  unask: {
    group: "Sign off",
    summary: "Withdraw a question you asked",
    positional: ["id"],
    examples: ["ntwinectl unask qst_ab12cd34"],
  },
  secret: {
    group: "Sign off",
    summary: "Ask the user for a value only they hold (a token, a 2FA code)",
    positional: ["question"],
    examples: ['ntwinectl secret "The npm one-time code for publishing ntwine 0.14.0" --header "npm OTP"'],
  },
  done: {
    group: "Sign off",
    summary: "Declare the effort finished, with the write-up the user reads (exits 2 if refused)",
    examples: [
      "ntwinectl done --body-file - <<'EOF'\n" +
      "Fixed the cache collision in the resolver.\n\n" +
      "- **Fixed the lookup** in `src/resolver.ts` — it now keys on the normalized id.\n" +
      "- **Added a regression test**; `npm test` green.\n" +
      "EOF",
      "ntwinectl done --body-file handoff.md",
    ],
  },
  activity: {
    group: "Waiting",
    summary: "List everything this thread has out, with the id each one is named by",
    examples: ["ntwinectl activity"],
  },
  watch: {
    group: "Waiting",
    summary: "Register a wait on a background shell or a sub-agent",
    positional: ["kind", "target"],
    examples: ["ntwinectl watch shell bzvtnt3ig --for 2h", "ntwinectl watch agent a01b2d20b32feab11 --for 1h"],
  },
  unwatch: {
    group: "Waiting",
    summary: "Withdraw a registered wait",
    positional: ["id"],
    examples: ["ntwinectl unwatch wch_ab12cd34"],
  },
  extend_shell: {
    group: "Waiting",
    summary: "Give a background shell a runtime budget, or extend the one it has",
    positional: ["shell"],
    examples: ["ntwinectl extend-shell bzvtnt3ig --for 2h"],
  },
  watch_pr: {
    group: "Waiting",
    summary: "Wake on a pull request's CI, reviews, comments and labels",
    positional: ["action"],
    then: { add: ["target"], drop: ["id"] },
    examples: ["ntwinectl watch-pr add acme/app#391 --for 180d", "ntwinectl watch-pr list", "ntwinectl watch-pr drop prw_ab12cd34"],
  },
  watch_issue: {
    group: "Waiting",
    summary: "Wake on a GitHub issue's comments, labels, assignees and close",
    positional: ["action"],
    then: { add: ["target"], drop: ["id"] },
    examples: ["ntwinectl watch-issue add acme/app#482 --for 30d", "ntwinectl watch-issue list", "ntwinectl watch-issue drop isw_ab12cd34"],
  },
  watch_command: {
    group: "Waiting",
    summary: "Wake when a shell command the server re-runs exits 0 (a version published, a URL up)",
    positional: ["action"],
    then: { add: ["command"], drop: ["id"] },
    examples: [
      'ntwinectl watch-command add "npm view ntwine@0.13.12 version" --every 5m --for 6h',
      "ntwinectl watch-command list",
      "ntwinectl watch-command drop cmw_ab12cd34ef56",
    ],
  },
  timer: {
    group: "Waiting",
    summary: "Set, list or cancel one-off timed prompts to yourself",
    positional: ["action"],
    then: { cancel: ["id"] },
    examples: [
      'ntwinectl timer set --in-seconds 600 --prompt "Re-check the deploy and report its status"',
      "ntwinectl timer list",
      "ntwinectl timer cancel tmr_a1b2c3d4e5f6",
    ],
  },
  goal: {
    group: "Waiting",
    summary: "Arm, read back or stop the text Ntwine re-sends this thread",
    positional: ["action"],
    examples: [
      "ntwinectl goal get",
      "ntwinectl goal start --post-compaction --no-stop-hook --prompt-file resume-prompt.md",
      "ntwinectl goal stop",
    ],
  },
  title: {
    group: "This thread",
    summary: "Name this thread on the board, once you know what the work is",
    positional: ["title"],
    examples: ['ntwinectl title "Fix queue focus"'],
  },
  link: {
    group: "This thread",
    summary: "Save a link or a file under the prompt box",
    positional: ["label", "target"],
    examples: ['ntwinectl link "Dev server" http://localhost:5173', 'ntwinectl link "Audit report" /abs/path/report.md'],
  },
  unlink: {
    group: "This thread",
    summary: "Remove a saved link or file",
    positional: ["id"],
    examples: ["ntwinectl unlink lnk_ab12cd34"],
  },
  deadline: {
    group: "This thread",
    summary: "Read this thread's time limit, or set one on a thread that has none",
    positional: ["action"],
    examples: ["ntwinectl deadline read", "ntwinectl deadline set --for 2h"],
  },
  editor: {
    group: "This thread",
    summary: "Read what the user has in front of them in their editor: file, selection, tabs, errors",
    examples: ["ntwinectl editor"],
  },
  read_thread: {
    group: "Other threads",
    summary: "Read another thread, or a sub-agent, by its @handle (wakes nobody)",
    positional: ["handle"],
    examples: ["ntwinectl read-thread @shell-budgets", "ntwinectl read-thread port-the-parser.cache-keys"],
  },
  message_thread: {
    group: "Other threads",
    summary: "Send a message into another open thread, or a running sub-agent, by its @handle",
    positional: ["handle"],
    examples: [
      "ntwinectl message-thread @shell-budgets --await-reply --message-file - <<'EOF'\n" +
      "Is `budgetFor` still the one place a shell's default is chosen? I am about to change it in `src/shell-budget.ts`.\n" +
      "EOF",
      'ntwinectl message-thread @focus-mode --message "Landed the queue fix on main; your rebase should be clean now."',
    ],
  },
  spawn_thread: {
    group: "Other threads",
    summary: "Dispatch a new, separate top-level thread (the last resort)",
    examples: ['ntwinectl spawn-thread --model opus --effort high --title "Port the relay to Bun" --prompt-file prompt.md'],
  },
  schedule: {
    group: "Other threads",
    summary: "Propose a recurring thread on a calendar rule (it runs once the user turns it on)",
    positional: ["action"],
    then: { pause: ["id"], skip_next: ["id"], "skip-next": ["id"], move_next: ["id"], "move-next": ["id"], update: ["id"] },
    examples: [
      'ntwinectl schedule dry-run --title "Triage issues" --when "every Monday at 9am" --rrule "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0" --dtstart 2026-10-19T09:00 --model sonnet --effort medium --prompt-file prompt.md',
      "ntwinectl schedule list",
      'ntwinectl schedule skip-next sch_ab12cd34 --reason "release freeze"',
    ],
  },
}

export { TOOLS, HANDLERS, CLI, Refused, GATED_TOOLS, serverLockPort, rpcPath }
