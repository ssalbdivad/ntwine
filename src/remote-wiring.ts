import type { DevSupervisor } from "@ntwine/server/dev-supervisor";
import { type AccessLink, type AccessPane, createAccessPane } from "./access-pane.ts";
import { type CloudConfig, establishCloudConfig } from "./cloud.ts";
import { installPaneHost, type PaneHost } from "./pane-host.ts";
import { createRemoteController, type RemoteController, type RemoteLog } from "./remote-controller.ts";
import { deviceCodeMessage, githubDeviceFlow } from "./github-device-flow.ts";
import { probeCloudflared, probeTailscale } from "./remote-detect.ts";
import { createRemotePane } from "./remote-pane.ts";
import { type ClaimSignIn, createRemoteControlHandler } from "./remote-setup.ts";

/**
 * Remote access on a running board, wired the same way by every launcher that owns one: `ntwine-dev`
 * (src/index.ts), the published `ntwine` (src/production.ts), and `nub run dev` (src/dev.ts).
 *
 * In one order, once the supervisor listens: serve the saved setup, offer it to Settings → Remote
 * access (the supervisor answers that over loopback only), and bind L and R in the terminal when there
 * is one. A saved setup that cannot come up never takes the board down: it keeps serving loopback and
 * both surfaces offer the setup again.
 */
export interface RemoteWiring {
  remote: RemoteController;
  /** L's pane: a fresh sign-in link as a QR. */
  accessPane: AccessPane;
  /** Null when stdin/stdout are not a terminal — no keys to bind. */
  paneHost: PaneHost | null;
  /** The first single-use sign-in link, when a saved setup came up. */
  firstLink: AccessLink | null;
  /** Restore the shell and stop the transport — shutdown. */
  dispose(): void;
}

export interface RemoteWiringOptions {
  supervisor: Pick<DevSupervisor, "setPublicOrigin" | "issueAccessLink" | "setRemoteControl">;
  port: number;
  log: RemoteLog;
  /** A line for the operator's terminal. */
  say: (message: string) => void;
  sandbox?: boolean;
}

export async function wireRemote(options: RemoteWiringOptions): Promise<RemoteWiring> {
  const { supervisor, port, log } = options;
  const remote = createRemoteController({ host: supervisor, port, log, say: options.say });
  try {
    await remote.serveSaved();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error("remote", message);
    options.say(`the saved remote setup could not start: ${message}`);
  }
  // Minted only now that the board can redeem it.
  const firstLink = remote.origin() ? supervisor.issueAccessLink() : null;

  // One setup, two surfaces: R in this terminal, and Settings → Remote access in a browser on this
  // machine. Wired whether or not stdout is a terminal, so a board with no terminal to press R in — a
  // backgrounded one — can still be set up.
  const setup = {
    port,
    current: () => remote.current(),
    apply: (next: CloudConfig | null, applyOptions?: { justClaimed?: boolean }) => remote.apply(next, applyOptions),
    // A custom name signs in through GitHub's zero-scope device flow; each surface shows its code (the R
    // pane on its own screen, Settings in the page, which also gets a terminal line via onDeviceCode).
    claim: (name: string, signIn: ClaimSignIn) =>
      establishCloudConfig(name, port, undefined, undefined, githubDeviceFlow({ onPrompt: signIn.onDeviceCode, signal: signIn.signal })),
    issueLink: () => supervisor.issueAccessLink(),
    probes: { cloudflared: probeCloudflared, tailscale: probeTailscale },
    onChanged: (config: CloudConfig | null) => log.info("remote", config ? `reached at https://${config.hostname}` : "loopback only"),
  };
  supervisor.setRemoteControl(createRemoteControlHandler({ ...setup, onDeviceCode: (prompt) => options.say(deviceCodeMessage(prompt)) }));
  const accessPane = createAccessPane({ issue: () => supervisor.issueAccessLink() });
  const remotePane = createRemotePane({ ...setup, sandbox: options.sandbox ?? false });
  const paneHost = installPaneHost({ bindings: { l: accessPane, L: accessPane, r: remotePane, R: remotePane } });

  return {
    remote,
    accessPane,
    paneHost,
    firstLink,
    dispose() {
      // The shell first, or the operator is left in raw mode echoing nothing.
      paneHost?.dispose();
      // Down with the board: a surviving cloudflared keeps the hostname resolving to a 530.
      remote.stop();
    },
  };
}
