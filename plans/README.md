# plans/ is an archive, not documentation

Every file here is a design or investigation document written at a point in time. They are kept as a record of what was decided and why — not as a description of how ntwine works now. Several describe designs that were built and later replaced, and a few describe designs that were never built at all.

**Do not read a statement here as current.** `ARCHITECTURE.md` and `AGENTS.md` are the documents that describe the system as it stands; where they and a plan disagree, they win, and the plan is simply older.

The trap this file exists for: **tmux**. ntwine ran its agents in tmux panes once, and these documents are full of that design — a tmux layer, `tmux.ts`, panes, sockets, `capture-pane`, `send-keys`. None of it has run since 2026-08-02, and the last of the vocabulary was swept out of the codebase on 2026-08-19. A Claude thread's worker now lives in a detached broker daemon and a Codex thread's in the app-server daemon; neither has a pane. `grep tmux` will still hit this directory, and every one of those hits is history.
