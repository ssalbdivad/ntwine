// The one-line explanations behind every settings "?" — shared by the Settings drawer and by the
// popovers that carry a setting into the place it applies (the model picker's agent settings). One
// table, so a setting reads the same wherever it is surfaced.
export const SETTINGS_HELP = {
  permissionMode: "The permission mode new Claude Code threads launch with. Auto runs safe actions and asks you to approve the risky ones in the thread. Bypass launches the worker with --dangerously-skip-permissions: it never asks, so nothing waits on you and nothing is checked either. Takes effect on the next thread you dispatch; to change a thread that already exists, use the picker beside its model in the prompt box. Codex threads always run with full workspace access and are unaffected.",
  promptCacheTtl: "Which prompt-cache tier a new Claude thread writes to. A 1-hour entry costs twice the input price to write, a 5-minute entry 1.25 times; the hour only pays off when the thread's cache actually survives that long. Measured 2026-09-03: cache writes were half of a day's spend and the entries were lost every 15 to 30 minutes regardless, so 5 minutes was the cheaper tier. Automatic leaves the choice to Claude Code, which picks 1 hour on a subscription. Takes effect on the next thread you dispatch and on a thread that resumes after its worker exited.",
  appearance: "Applies to this browser across all projects. System follows the device appearance.",
  localFileOpener: "The app a local file opens in outside Ntwine: a PDF, a spreadsheet or an archive, and any file's Open button in the reader. Markdown and pictures open in Ntwine, and a picture's Open goes to the OS default viewer. Code files open in the reader, or in VS Code or Cursor when it is chosen here and its Ntwine extension has a window connected — the window with the file's folder open, at the line the link names. $EDITOR runs the editor your shell names in $VISUAL or $EDITOR, a GUI one such as code, zed or subl.",
  density: "How much of a diff shows before you ask for it, in this browser. Compact collapses every diff to its header row (click one to open it); Comfortable shows them in full. Applies immediately.",
  slashCommands: "Prompts you invoke by name: type /name at the start of a message, in any project and on any agent, and Ntwine sends the prompt instead. Text after the name fills in $ARGUMENTS, or is added at the end. Commands written here are Ntwine's own; ones in ~/.agents/commands and a project's .agents/commands are listed too, and opening one makes an editable copy.",
  notifications: "Shows a desktop notification when work needs attention while this window is hidden.",
  alwaysShowStatusLines: "Shows what each working thread is doing after its name in the thread list. Off, point at the thread to see it. Applies immediately in this browser.",
  showRecentThreads: "Keeps threads you opened in the last 30m under the Snoozed and Done headers while those are folded. Applies immediately in this browser.",
  removeIdleWorktreesDays: "Removes worktrees in a project's .ntwine/worktrees folder once nothing in them has changed for this long; checked daily, in every project. A worktree with uncommitted changes, ignored files like .env, or a thread still working in it is kept. Branches are never deleted.",
  deleteDoneThreadsUntouchedDays: "Deletes done threads you have not opened, replied to or acted on for this long, in every open project; checked hourly. What the agent did since does not count. Pinned threads are kept. A deleted thread's name is free for a new thread. Its history in Ntwine cannot be recovered.",
  fableFallback: "Uses Fable's own weekly budget when the rest of your Claude usage is nearly out. While the 5-hour or weekly limit is 90% used and Fable's limit still has room, new Claude threads start on Fable, and a thread paused by the 5-hour or weekly limit restarts on Fable instead of waiting for the reset. Threads stay on Fable afterwards; switch one back in the prompt box. Applies to every project.",
  projectInstructions: "Instructions every agent in this project follows, Claude Code and Codex alike. They are the project's NTWINE.md: saved to the repo root, where they can be committed and reviewed, and injected into each worker's system prompt. Takes effect on the next thread you dispatch and on any thread when it next resumes.",
  remoteAccess: "How a phone or another machine reaches this Ntwine. Every choice keeps Ntwine on 127.0.0.1 and puts something in front of it, and the first visit from each device needs a single-use sign-in link. Applies at once and is remembered for later launches. The same setup as pressing R in the terminal running Ntwine, and changeable only from this machine.",
} as const

// The few that read differently in an editor's sidebar (lib/embed.ts), where the row itself says what
// differs. The frame's preferences are its own — the editor's theme for the session, and a separate
// localStorage the browser never sees (ARCHITECTURE.md § VS Code extension) — so a help text that
// says "this browser" would contradict the row above it.
export const SETTINGS_HELP_IN_EDITOR = {
  appearance: "Follows VS Code's color theme. Your browser keeps its own.",
} as const
