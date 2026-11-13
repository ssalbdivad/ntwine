// `pnpm run dev`: the source dev board (packages/server/src/dev.ts — Vite HMR, a supervisor that
// recycles the control plane on server edits) with remote access attached, so a phone can reach it
// exactly as it reaches `ntwine-dev` or a published `ntwine`: the saved setup is served at boot,
// Settings → Remote access works from this machine, and R / L work in this terminal.
//
// The wiring lives here, not in the server package, because the transports it drives (the ntwine.app
// relay, cloudflared) belong to the launcher package, which depends on the server and not the reverse.
import { DEFAULT_PORT } from "@ntwine/shared";
import { runDev } from "@ntwine/server/dev";
import { startAutosyncPoller } from "./autosync.ts";
import { choosePort } from "./launcher.ts";
import { wireRemote } from "./remote-wiring.ts";

// `pnpm run dev -- --port 9400` runs a second board beside the usual one, and fails if that port is taken.
const portFlag = process.argv.indexOf("--port");
const explicitPort = portFlag > 0 ? Number(process.argv[portFlag + 1]) : undefined;
if (explicitPort !== undefined && !(Number.isInteger(explicitPort) && explicitPort > 0 && explicitPort < 65_536)) throw new Error("--port needs a port number");

// Without --port, the well-known port when it binds, else the published launcher's fallback band
// (DEFAULT_PORT + 10000 and up), whose first port the desktop window also looks on (locateServer).
//
// Waiting the holder out or killing it is not an option, because on WSL there is often no holder. Under
// `networkingMode=mirrored` Linux shares Windows' port table, and a connection the Windows Electron window
// made to the board leaves a Windows-side TIME_WAIT on 127.0.0.1:9393 that fails a Linux bind with
// EADDRINUSE while `ss` and `/proc/net/tcp` show nothing on the port at all and `netstat.exe` shows only
// the TIME_WAITs (2026-11-12: the board would not start for minutes after a restart; the bind succeeded
// once they expired). Another of our own boards cannot be the holder either: runDev takes the project's
// launch lock before it binds, so a second board of ours stops there. Anything that does listen is
// someone else's, which ntwine has no business killing.
const port = await choosePort(explicitPort, undefined);
if (explicitPort === undefined && port !== DEFAULT_PORT)
  console.log(`[ntwine] port ${DEFAULT_PORT} is taken; using ${port}`);

await runDev({
  port,
  attach: async ({ supervisor, port, logger }) => {
    const wiring = await wireRemote({
      supervisor,
      port,
      log: logger,
      say: (message) => console.error(`[ntwine] ${message}`),
    });
    const origin = wiring.remote.origin();
    if (origin) console.log(`[ntwine] reachable at ${origin}${wiring.paneHost ? " — press L for a phone sign-in link" : ""}`);
    else if (wiring.paneHost) console.log("[ntwine] press R to reach this board from your phone");
    // Pull what the maintainer's other machine pushed, now and every 5m, in a clone that opted into
    // autosync (src/autosync.ts); anywhere else each run declines at once. A merge lands in the tree this
    // supervisor watches, so it restarts onto the update like any edit; a re-exec starts a fresh poller.
    const autosync = startAutosyncPoller({ say: (line) => console.log(`[ntwine] ${line}`) });
    return {
      onCodeConsumed: () => wiring.accessPane.markConsumed(),
      dispose: () => {
        autosync.stop();
        wiring.dispose();
      },
    };
  },
});
