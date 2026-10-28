# ntwine for VS Code

Talk to [ntwine](https://github.com/ssalbdivad/ntwine) from your editor, and land on ntwine's file links
in it. Works in VS Code, Cursor and Windsurf.

- **The ntwine sidebar** — the ntwine icon in the activity bar opens ntwine itself beside your code: the
  queue, threads, questions and prompt boxes, live, in your color theme's colors, on this window's
  project. It is the app you know, narrowed: the same cards, type sizes and shortcuts. File links in it
  open in this window, web links in your browser. Its badge counts the threads ready for you.
- **VS Code's title row holds the header's buttons**: **Back to queue** in a thread, **New thread**
  elsewhere, **Jump to a thread** (the app's ⌘K) and **Settings**. **Reload sidebar**, **Open in
  browser** and **Keyboard shortcuts** (the app's `?`) are under its `…`. Each is in the command palette
  too, and brings the sidebar back if it was hidden. The badge's tooltip reads the counts
  (`1 needs you · 3 ready`). While a thread shows, the `…` also holds **Open thread in editor tab**.
- **What you select goes with your message.** Over the sidebar's prompt boxes a bar names the file in
  front and what you have selected (`sample.ts:12-20`, `26 lines`), live, and whatever it names goes with
  the next message you send from that box: the selection with its text, or with nothing selected the
  file and your caret's line. So you can ask "why does this throw?" without pasting anything. A click on
  the bar adds it as a chip where your caret is instead, and the other open files are one more click away.
  A selection the thread already has is named, not sent again; text from files that may hold secrets
  (`.env`, keys, credentials) is never sent on its own — only which lines. To keep one selection out of
  your message, point at the bar: its file icon turns into a ×, and a click leaves that selection (or,
  with nothing selected, that file) out until you select something else. Sharing stays on.
- **ntwine's agents can see your editor.** An agent can also read what you have in front of you when it
  needs to — the file you are in, what you have selected and its text, your open tabs, and the editor's
  errors and warnings — from the window that has the thread's project open, even when you talk to it in
  your browser. There, the prompt box names what it would read (`VS Code: sample.ts:12-20`), and a click
  adds it as a chip.
- **One switch.** The eye on the bar turns all of it off and on: off, nothing of your editor goes to ntwine
  unless you add it. It is the `ntwine.shareEditorState` setting, so it holds in every window and across
  reloads.
- **`Ctrl+L`** (`⌘L` on macOS — Cursor's chord), in the editor: with text selected, the selection becomes
  a chip in the prompt box the sidebar shows, with the caret after it so you can type straight on — the
  reply box of the thread you are in, else the new-thread box. With nothing selected, it takes you to that
  prompt box. Pressed in the sidebar, it takes you back to the editor. `Ctrl+I` / `⌘I` with text selected
  adds it too. The sidebar opens if this window never had it. **Add to ntwine prompt** in the editor's
  right-click menu or the palette, without a selection, adds the line your caret is on. A selection you
  make shows `Ctrl+L to add to ntwine` at its end, faintly, once you let go — not in a diff, not for a
  select-all, and not in Cursor or Windsurf, which show their own. `ntwine.selectionHint` turns it off.
- **A thread in an editor tab.** **Open thread in editor tab** (the sidebar's `…` while a thread shows, or
  the palette) opens the thread beside your code at the editor's width — the same page, its reply box,
  links and context bar. One tab per thread: asking again brings it forward. It comes back after a window
  reload. While it is the ntwine you used last, `Ctrl+L` in the editor adds to its reply box instead of the
  sidebar's, and `Ctrl+L` in the tab takes you back to the code.
- **`Alt+K`** (`⌥K` on macOS — Claude Code's chord) — the selection as a chip, or with nothing selected,
  the whole file. Not when Claude Code's own extension is installed: it uses the same chord, so ntwine
  leaves it to Claude Code there.
- **More ways in**, each landing as a chip with the caret after it:
  - **Add file to ntwine prompt** on an editor tab's right-click menu, on files in the explorer (every
    file selected), and in the editor's ntwine menu — a reference to the whole file.
  - **Ask ntwine to fix** in a problem's quick fixes (the light bulb, `Ctrl+.`) — the problem's lines,
    and the problem itself written after the chip (`Fix: Cannot find name 'foo'. ts(2304)`), ready to
    send or to edit.
  - **Add to ntwine prompt** in the terminal's right-click menu — the selected terminal output, as an
    `@terminal` chip.
  - **`@` in a sidebar prompt box** offers this workspace's files after the threads, the way quick open
    lists them (what `.gitignore`, `files.exclude` and `search.exclude` leave out is left out). Enter
    writes the file as a reference, `` `src/a.ts` ``. An `@` with nothing after it offers your open tabs.
  - **Drag files from the explorer** onto a sidebar prompt box, holding `Shift` (VS Code lets a webview
    take a drop only then) — each lands as the same reference, at the caret.
  - **Add problems in this file** and **Add last terminal command**, behind the chevron on the prompt
    box's context bar and in the palette (the second also in the terminal's right-click menu) — the
    file's errors and warnings, each with its line, as an `@problems` chip; the command, the end of its
    output and its exit code, as an `@terminal` chip. VS Code 1.93 and later tell ntwine each command as
    it runs; on an older one, adding it borrows the clipboard for a moment, as the terminal's selection
    entry does.
- **Ask ntwine…** — select code (or right-click a file) and ask about it in the sidebar's new-thread
  box, which opens with the selection in it as the same chip the page's prompt box makes.
- **Send to ntwine thread…** — pick one of the project's open threads, ones waiting on you first; it
  opens in the sidebar with the selection in its reply box.
- **A window on a thread's worktree is that thread's.** Open a thread's worktree (`.ntwine/worktrees/…`)
  as a window's folder and the sidebar opens on that thread, which Send to ntwine thread also offers
  first. Links the thread's agent wrote open its worktree's copy, and the main checkout's once the
  worktree is gone. Done can remove the worktree, so ntwine won't mark the thread done while an editor
  has unsaved changes in it: save or close them first.
- **Review a thread's changes** — everything a thread changed, as VS Code's multi-file diff: from its ⋯
  menu in the sidebar (**Review changes**), from ntwine in your browser (**Review changes in VS Code**,
  which brings this window to the front), or **ntwine: Review a thread's changes…** in the palette. A
  thread that worked in a worktree shows its whole branch since it started, committed or not; one that
  worked in the project folder shows its own files' uncommitted changes. The left side is where it
  started; the right side is the file itself, to fix in place.
- **File links from ntwine** open here — in the window that has the file's folder open, at the line the
  link names, and that window comes to the front — when ntwine's Local file links setting is this editor
  (ntwine offers to switch it the first time a window connects).
- **The status bar** shows how many of this workspace's threads are ready for you. Click it to show
  the sidebar.

The commands are in the editor's right-click menu under **ntwine**, on files in the explorer, and in the
command palette.

## Shortcuts

| where | keys | does |
| --- | --- | --- |
| the editor, with text selected | `Ctrl+L` / `⌘L`, or `Ctrl+I` / `⌘I` | Add to ntwine prompt, caret in the sidebar (or the thread's tab you used last) |
| the editor, nothing selected | `Ctrl+L` / `⌘L` | to the sidebar's prompt box (or the thread's tab you used last) |
| the editor, without Claude Code's extension | `Alt+K` / `⌥K` | the selection, or with none the whole file, into the prompt |
| the sidebar, or a thread's tab | `Ctrl+L` / `⌘L` | back to the editor |
| the sidebar's prompt box | `Ctrl+I` / `⌘I` | the editor's selection (or its file) into this box |
| the sidebar | every shortcut the app's `?` sheet lists | what it does in the app |
| the sidebar | `Ctrl+Shift+P`, `Ctrl+P`, `Ctrl+B`, `Ctrl+J`, ``Ctrl+` ``, `Ctrl+1`, `Ctrl+Shift+E/F/G/D/X` (`⌘` on macOS) | VS Code's own: palette, quick open, side bar, panel, terminal, back to the editor, the built-in views |

## Where the sidebar differs from ntwine in your browser

- **`Ctrl+L` in the editor is ntwine's**, as it is Cursor's: VS Code's own `Ctrl+L` (select the caret's
  line, and again to grow it) is not there while the sidebar is on. `Shift+↓` grows a selection by lines;
  turn `ntwine.useSidebar` off and `Ctrl+L` with nothing selected selects the line again. `Ctrl+I` with
  text selected is ntwine's too; without a selection it stays VS Code's suggestions (also on `Ctrl+Space`)
  or its inline chat where chat is on, which is also in the palette (**Inline Chat**). In Cursor, whose
  chat and agent are on `Ctrl+L` and `Ctrl+I`, Cursor and ntwine bind the same chords; rebind either in
  **Keyboard Shortcuts** if the wrong one answers. ntwine's first binding, `Ctrl+Alt+P`, is gone.
- **`Alt+K` in the editor is ntwine's**, with or without a selection — unless Claude Code's extension is
  installed, which binds the same chord; then it is Claude Code's, and the `?` sheet stops listing it.
  On macOS `⌥K` types `˚` in other apps; in the editor it adds to ntwine, as Claude Code's does.
- **While the sidebar has focus, VS Code sees only the chords in the table above**; every other key goes
  to ntwine, as in the browser. Copy, cut, paste, undo and select all stay the text box's.
- **The terminal's right-click menu**: on Windows a right-click in the terminal copies or pastes by
  default (`terminal.integrated.rightClickBehavior`); Shift+right-click opens the menu. Adding from the
  terminal borrows the clipboard for a moment and puts your text back: a clipboard holding an image
  comes back empty, and a clipboard history records the selection.
- **A drop needs `Shift`.** VS Code hands a sidebar a drag only while `Shift` is held, so hold it to drop
  files from the explorer or from your desktop onto a prompt box. Pasting a screenshot attaches it, as in
  the browser.
- **No ntwine header, no browser notifications.** The title row's buttons stand in for the header, and
  it always reads "ntwine": VS Code re-cases a view's title, so thread and project names stay in the page,
  and it shows no view description in a sidebar of one view. ntwine's
  desktop notifications cannot fire inside an editor, and the badge and the status bar carry the count.
- **The theme is VS Code's**, for as long as the sidebar shows: light or dark, and its colors — the side
  bar's background, text, borders, focus and link colors — so the sidebar reads as part of the editor.
  ntwine's status colors (ready, needs you, errors) stay ntwine's. Turn off `ntwine.matchEditorTheme` to see
  ntwine's own colors; your ntwine theme setting is the browser's.

## Install

ntwine must be running on this machine (`npx ntwine`). The extension finds it on its own.

From an ntwine checkout: `pnpm run vscode:install` builds the `.vsix` and installs it — into the VS Code
Server when you are in WSL, since the extension runs where your files are. Or build it with
`pnpm run vscode:package` and install `packages/vscode/dist/ntwine-vscode-<version>.vsix` with
**Extensions: Install from VSIX…**.

## Settings

| setting | default | |
| --- | --- | --- |
| `ntwine.serverUrl` | empty | ntwine's address, such as `http://127.0.0.1:9393`. Empty finds the ntwine running on this machine. |
| `ntwine.openFileLinks` | on | Open file links from ntwine in this window. Turn it off for a window that should never take them. |
| `ntwine.shareEditorState` | on | Share what this window shows with ntwine: the file in front and your selection, with its text, go with what you send from the sidebar, and ntwine's agents can read them — with your open tabs and the errors and warnings — when they need to. Off, nothing of the editor goes unless you add it. The eye on the sidebar's prompt box is this setting. |
| `ntwine.selectionHint` | on | Show `Ctrl+L to add to ntwine` (`⌘L` on macOS) at the end of what you select, while ntwine is running. Not in diffs, and not for a select-all. |
| `ntwine.matchEditorTheme` | on | Show the sidebar, and a thread in an editor tab, in your color theme's colors. Off, it shows ntwine's own, still light or dark as VS Code is. |
| `ntwine.useSidebar` | on | Everything you add from the editor, and Ask and Send, go to the sidebar. Off, selections and files go to ntwine in your browser, Ask and Send take your message in an input box and send it, and the quick fix and the terminal's entry are not offered. |

**ntwine: Show log** shows which build of the extension this window runs (`0.1.0+1a2b3c4d`, the commit it
was built from; the status bar's tooltip says it too), how it found ntwine and every time the connection
changed; **ntwine: Reconnect** looks for ntwine again at once. When a new build is installed under an open
window, the window offers **Reload window** to use it. An ntwine older than the sidebar is said in the
sidebar at once, with what to do.
