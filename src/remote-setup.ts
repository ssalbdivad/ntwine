import { isAnonymousClaimName } from "@ntwine/shared";
import { renderQrSvg } from "@ntwine/server/qr";
import type { RemoteControlHandler, RemoteControlReply } from "@ntwine/server/restart-supervisor";
import { type CloudConfig, isClaimedConfig, isExternalConfig, normalizeHostname } from "./cloud.ts";
import type { DeviceCodePrompt } from "./github-device-flow.ts";
import type { CloudflaredProbe, TailscaleProbe } from "./remote-detect.ts";

/**
 * Remote access as a set of CHOICES, shared by the two places an operator makes one: the R pane in
 * the launcher's terminal (remote-pane.ts) and Settings → Remote access in the browser, which reaches
 * the launcher through the supervisor's loopback-only `/_ntwine/control/remote` (restart-supervisor.ts).
 *
 * Both turn a choice into the same CloudConfig here, so a setup made in one reads as the same setup in
 * the other, and both apply it through the one RemoteController — which is what keeps a switch from one
 * setup to another leaving no tunnel behind, whichever surface asked for it.
 */

export type RemoteKind = "private" | "ntwine" | "cloudflare" | "tailscale" | "other" | "off";

/** What an operator asked for, in the fields each setup actually takes. */
export type RemoteChoice =
  | { kind: "off" }
  | { kind: "private" }
  | { kind: "ntwine"; name: string }
  | { kind: "cloudflare"; hostname: string; tunnel: string }
  | { kind: "tailscale" | "other"; origin: string };

export function kindOf(config: CloudConfig | null): RemoteKind {
  if (!config) return "off";
  if (isClaimedConfig(config)) return isAnonymousClaimName(config.claim!) ? "private" : "ntwine";
  if (isExternalConfig(config)) return config.provider === "tailscale" ? "tailscale" : "other";
  return "cloudflare";
}

/** How a custom-name claim shows its GitHub device code, and how the person backs out of it. A private
 *  name has no GitHub step, so neither is ever used for one. */
export interface ClaimSignIn {
  onDeviceCode: (prompt: DeviceCodePrompt) => void;
  signal: AbortSignal;
}

export interface RemoteSetupDeps {
  /** Switch the running board to `next`, or to loopback-only with null. Rejects with a message. */
  apply: (next: CloudConfig | null, options?: { justClaimed?: boolean }) => Promise<void>;
  /**
   * Claim `<name>.ntwine.app`; an empty name mints a private one. A word claims that word for a GitHub
   * account, confirmed through a zero-scope device flow whose code `signIn.onDeviceCode` shows (cloud.ts,
   * github-device-flow.ts). Rejects with a message, and on `signIn.signal`.
   */
  claim: (name: string, signIn: ClaimSignIn) => Promise<CloudConfig>;
  /** Told before each slow step, so a caller with a screen can say what is happening. */
  progress?: (message: string) => void;
  /** Where a custom-name claim shows its device code. Absent ⇒ the code goes nowhere and the claim waits
   *  out GitHub's own expiry, so every caller that can claim a word passes one. */
  signIn?: ClaimSignIn;
}

/**
 * Turn a choice into a config and serve it. Resolves to what is now in force (null = loopback only).
 *
 * Validation happens BEFORE anything is stopped: a typo in a hostname must not take down the setup
 * that was working.
 */
export async function applyRemoteChoice(choice: RemoteChoice, deps: RemoteSetupDeps): Promise<CloudConfig | null> {
  if (choice.kind === "off") {
    deps.progress?.("back to loopback only…");
    await deps.apply(null);
    return null;
  }
  let next: CloudConfig;
  let justClaimed = false;
  if (choice.kind === "private" || choice.kind === "ntwine") {
    const name = choice.kind === "ntwine" ? choice.name.trim() : "";
    if (choice.kind === "ntwine" && !name) throw new Error("a name is needed");
    deps.progress?.(name ? `claiming ${name}.ntwine.app…` : "claiming a private name on ntwine.app…");
    next = await deps.claim(name, deps.signIn ?? { signal: new AbortController().signal, onDeviceCode: () => {} });
    justClaimed = true;
  } else if (choice.kind === "cloudflare") {
    const hostname = normalizeHostname(choice.hostname);
    const tunnel = choice.tunnel.trim();
    if (!tunnel) throw new Error("the tunnel's name is needed");
    next = { hostname, tunnel };
  } else {
    next = { hostname: normalizeHostname(choice.origin), serve: "external", provider: choice.kind };
  }
  deps.progress?.(`serving ${next.hostname}…`);
  await deps.apply(next, { justClaimed });
  return next;
}

/** Read a request body as a RemoteChoice, or say what is wrong with it. */
export function parseRemoteChoice(body: unknown): RemoteChoice | string {
  if (!body || typeof body !== "object") return "expected a JSON object";
  const value = body as Record<string, unknown>;
  const text = (key: string) => (typeof value[key] === "string" ? (value[key] as string) : "");
  switch (value.kind) {
    case "off":
    case "private":
      return { kind: value.kind };
    case "ntwine":
      return { kind: "ntwine", name: text("name") };
    case "cloudflare":
      return { kind: "cloudflare", hostname: text("hostname"), tunnel: text("tunnel") };
    case "tailscale":
    case "other":
      return { kind: value.kind, origin: text("origin") };
    default:
      return "kind must be one of off, private, ntwine, cloudflare, tailscale, other";
  }
}

/** How the browser sees the setup in force. Mirrored in packages/web/src/api/remoteAccess.ts. */
export interface RemoteSetupView {
  kind: RemoteKind;
  /** `https://<hostname>`, absent while loopback only. */
  origin?: string;
  /** The claimed ntwine.app label, for a custom name. */
  name?: string;
  /** The cloudflared tunnel name, for a Cloudflare Tunnel. */
  tunnel?: string;
}

export function viewOf(config: CloudConfig | null): RemoteSetupView {
  const kind = kindOf(config);
  if (!config) return { kind };
  return {
    kind,
    origin: `https://${config.hostname}`,
    ...(kind === "ntwine" && config.claim ? { name: config.claim } : {}),
    ...(config.tunnel ? { tunnel: config.tunnel } : {}),
  };
}

export interface RemoteControlOptions extends Omit<RemoteSetupDeps, "progress" | "signIn"> {
  current: () => CloudConfig | null;
  port: number;
  /** A fresh single-use sign-in link for the origin in force. */
  issueLink: () => { url: string; expiresAt: number } | null;
  probes: {
    cloudflared: () => Promise<CloudflaredProbe>;
    tailscale: () => Promise<TailscaleProbe>;
  };
  onChanged?: (config: CloudConfig | null) => void;
  /** Also told a browser claim's device code — the launcher's terminal line, for an operator there. */
  onDeviceCode?: (prompt: DeviceCodePrompt) => void;
}

/**
 * The launcher's half of Settings → Remote access. The supervisor has already refused anything that
 * did not arrive over loopback before this runs — changing who can reach the board needs presence on
 * the machine, the same rule minting a sign-in link and signing devices out already follow.
 */
export function createRemoteControlHandler(options: RemoteControlOptions): RemoteControlHandler {
  // One browser change at a time: two overlapping applies would each stop the other's transport
  // half-started. (The R pane is modal on its own terminal and an operator drives one surface at once.)
  let applying = false;
  // A custom-name claim started from the browser: the GitHub code it is waiting on, read back by GET so
  // the page can show it while its POST is still pending, and the switch `{ cancel: true }` throws.
  let pendingSignIn: { prompt: DeviceCodePrompt | null; abort: AbortController } | null = null;
  const reply = (status: number, body: unknown): RemoteControlReply => ({ status, body });

  // A sign-in link with its QR drawn here, where the encoder already ships, so the browser needs no
  // QR library of its own.
  const link = () => {
    const issued = options.issueLink();
    return issued ? { url: issued.url, expiresAt: issued.expiresAt, qrSvg: renderQrSvg(issued.url) } : null;
  };

  return {
    async get() {
      const [cloudflared, tailscale] = await Promise.all([
        options.probes.cloudflared(),
        options.probes.tailscale(),
      ]);
      return reply(200, {
        protocol: 1,
        current: viewOf(options.current()),
        port: options.port,
        applying,
        signIn: pendingSignIn?.prompt ? { verificationUri: pendingSignIn.prompt.verificationUri, userCode: pendingSignIn.prompt.userCode } : null,
        probes: { cloudflared, tailscale },
      });
    },
    async post(body) {
      // `{ link: true }` mints a fresh sign-in link for the setup in force, changing nothing else.
      if (body && typeof body === "object" && (body as { link?: unknown }).link === true) {
        const issued = link();
        return issued
          ? reply(200, { protocol: 1, current: viewOf(options.current()), link: issued })
          : reply(409, { protocol: 1, error: "remote access is off, so there is nothing to sign in to" });
      }
      // `{ cancel: true }` abandons a custom-name claim still waiting on its GitHub code.
      if (body && typeof body === "object" && (body as { cancel?: unknown }).cancel === true) {
        pendingSignIn?.abort.abort();
        return reply(200, { protocol: 1, current: viewOf(options.current()), cancelled: pendingSignIn !== null });
      }
      const choice = parseRemoteChoice(body);
      if (typeof choice === "string") return reply(400, { protocol: 1, error: choice });
      if (applying) return reply(409, { protocol: 1, error: "another remote-access change is still being applied" });
      applying = true;
      const signIn = { prompt: null as DeviceCodePrompt | null, abort: new AbortController() };
      pendingSignIn = signIn;
      try {
        const next = await applyRemoteChoice(choice, {
          apply: options.apply,
          claim: options.claim,
          signIn: {
            signal: signIn.abort.signal,
            onDeviceCode: (prompt) => {
              signIn.prompt = prompt;
              options.onDeviceCode?.(prompt);
            },
          },
        });
        options.onChanged?.(next);
        return reply(200, { protocol: 1, current: viewOf(next), link: next ? link() : null });
      } catch (error) {
        // The controller has already dropped the origin for a setup that failed to start, so what is in
        // force now is whatever it says — report that alongside the error.
        return reply(422, {
          protocol: 1,
          error: error instanceof Error ? error.message : String(error),
          current: viewOf(options.current()),
        });
      } finally {
        applying = false;
        pendingSignIn = null;
      }
    },
  };
}
