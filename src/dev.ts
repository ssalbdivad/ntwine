// `pnpm run dev`: the source dev board (packages/server/src/dev.ts — Vite HMR, a supervisor that
// recycles the control plane on server edits) with remote access attached, so a phone can reach it
// exactly as it reaches `ntwine-dev` or a published `ntwine`: the saved setup is served at boot,
// Settings → Remote access works from this machine, and R / L work in this terminal.
//
// The wiring lives here, not in the server package, because the transports it drives (the ntwine.app
// relay, cloudflared) belong to the launcher package, which depends on the server and not the reverse.
import { runDev } from "@ntwine/server/dev";
import { wireRemote } from "./remote-wiring.ts";

// `pnpm run dev -- --port 9400` runs a second board beside the usual one.
const portFlag = process.argv.indexOf("--port");
const port = portFlag > 0 ? Number(process.argv[portFlag + 1]) : undefined;
if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65_536)) throw new Error("--port needs a port number");

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
    return {
      onCodeConsumed: () => wiring.accessPane.markConsumed(),
      dispose: () => wiring.dispose(),
    };
  },
});
