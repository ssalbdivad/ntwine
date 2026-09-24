# Desktop

Frizz as a desktop app: an Electron window onto the Frizz server on this machine, with its own Dock
or taskbar entry, and nothing else.

**It never runs the server.** The server loads `node-pty` built for the system Node, which Electron's
embedded Node cannot load, and the launcher already owns starting it — the machine-wide lease, port
allocation, self-update, crash recovery. So the app is a client of that launcher, the way a browser tab
is, and needs what `npx frizz` needs: Node 22.13 or newer on the PATH.

## What it does on launch

1. **Joins the running server.** The owner record the published launcher writes names its port; failing
   that, a Frizz answering `/_frizz/health` on a well-known port (9393, 19393, 9494, 19494) — which is
   how it finds a `frizz-dev` board, since that writes no record.
2. **Otherwise starts one.** `npx -y frizz --_frizz-print-launcher` resolves the launcher (installing it
   on first use), and `node <launcher> --no-app` runs from `$HOME`, **detached**, with its output in the
   app's log directory (`launcher.log`). Detached is load-bearing: the launcher supervises the server,
   and a launcher on the app's pipes would die with the app.
3. **Asks for a folder when there is nothing to show.** With no project registered yet, the launcher
   refuses to open `$HOME`; the app reads that refusal and offers a folder picker, then starts from there.

The server is started with an interactive login shell's environment, because an app launched from the
Dock gets launchd's bare PATH and the server hands its environment to every agent it dispatches.
`FRIZZ_DESKTOP_URL=http://127.0.0.1:<port>` skips all of this and shows that server.

**Quitting leaves the server running**, as closing a browser tab does: scheduled wakes and PR watchers
keep working, and the next launch joins it. Stop it with `frizz --stop` from a project directory.

## What it adds to a bare window

What a browser gives a tab for free: http(s) and mailto links open in the operator's own browser (a
worker-written link of any other scheme is dropped, never launched); the Edit menu macOS needs before
⌘C/⌘V work at all; back and forward; a context menu; and a window that reopens where it was. A
notification click raises the window through the preload's one bridge, because `window.focus()` does
not raise an Electron window.

## Running and packaging

```sh
nub run desktop        # build and open it from this checkout (downloads Electron on first run)
nub run desktop:dist   # package for this OS into packages/desktop/out/
```

`desktop:dist` fetches electron-builder on demand rather than installing it with the workspace. It builds
for the OS it runs on: a `.deb` and AppImage on Linux, a `.dmg` and zip on macOS (ad-hoc signed — not
notarized, so a downloaded build needs **Open Anyway** once), and an NSIS installer on Windows. macOS
builds need a Mac.

## Verifying it

```sh
nub run test packages/desktop/src/*.test.ts
# the real launcher and a real frizz-server, in a sandbox HOME (needs the network):
nub packages/desktop/scripts/verify-start.ts --keep
# the real window against that sandbox's server, on a private display:
nub packages/desktop/scripts/verify-window.ts --home=<sandbox from the line above> [--app=<packaged binary>]
# the start path end to end, where this machine's own board cannot answer:
unshare -rn sh -c 'ip link set lo up && exec nub packages/desktop/scripts/verify-window.ts --fake-start'
```
