// ── Settings → Remote access ────────────────────────────────────────────────────────────────────────────
// How the board is reached from a phone or another machine — the same setup as pressing R in the
// launcher's terminal, which owns the transport (src/remote-setup.ts). The supervisor answers this route
// only over loopback: choosing who can reach the board needs presence on the machine, like minting a
// sign-in link. Through the public origin it is 403, and a launch with no transport to drive (`pnpm dev`)
// answers 404.

export const REMOTE_ACCESS_PATH = "/_ntwine/control/remote"

/** Mirrors RemoteKind in src/remote-setup.ts. */
export type RemoteKind = "private" | "ntwine" | "cloudflare" | "tailscale" | "other" | "off"

/** Mirrors RemoteSetupView in src/remote-setup.ts. */
export interface RemoteSetupView {
  kind: RemoteKind
  origin?: string
  name?: string
  tunnel?: string
}

export interface RemoteSignInLink {
  url: string
  expiresAt: number
  /** A standalone SVG of the QR code, drawn by the launcher. */
  qrSvg: string
}

export interface RemoteAccessState {
  current: RemoteSetupView
  /** The board's loopback port, for the commands a proxy or `tailscale serve` needs. */
  port: number
  /** The GitHub device code a custom-name claim from this page is waiting on, while its change is pending. */
  signIn?: { verificationUri: string; userCode: string } | null
  probes: {
    cloudflared: { version: string | null }
    tailscale: { installed: boolean; dnsName: string | null }
  }
}

/** What the drawer can show: the setup, a launch that cannot change it, or nothing at all. */
export type RemoteAccessReading =
  | { kind: "ready"; state: RemoteAccessState }
  | { kind: "unsupported" }
  | { kind: "hidden" }

export type RemoteChoice =
  | { kind: "off" }
  | { kind: "private" }
  | { kind: "ntwine"; name: string }
  | { kind: "cloudflare"; hostname: string; tunnel: string }
  | { kind: "tailscale" | "other"; origin: string }

export async function readRemoteAccess(fetcher: typeof fetch = fetch): Promise<RemoteAccessReading> {
  let response: Response
  try {
    response = await fetcher(REMOTE_ACCESS_PATH, { headers: { "cache-control": "no-store" } })
  } catch {
    return { kind: "hidden" }
  }
  // 404 is a supervisor that knows the route and has no setup to offer. An older supervisor, or a bare
  // control plane, answers the SPA's HTML or a non-JSON 404 instead — nothing to say about either.
  const json = response.headers.get("content-type")?.includes("application/json") ?? false
  if (response.status === 404 && json) return { kind: "unsupported" }
  if (!response.ok || !json) return { kind: "hidden" }
  const body = await response.json() as Partial<RemoteAccessState> & { protocol?: number }
  if (body.protocol !== 1 || !body.current || !body.probes || typeof body.port !== "number") return { kind: "hidden" }
  return { kind: "ready", state: body as RemoteAccessState }
}

export interface RemoteAccessChange {
  current: RemoteSetupView
  link: RemoteSignInLink | null
}

async function post(body: unknown, fetcher: typeof fetch): Promise<RemoteAccessChange> {
  const response = await fetcher(REMOTE_ACCESS_PATH, {
    method: "POST",
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify(body),
  })
  let reply: { protocol?: number; error?: string; current?: RemoteSetupView; link?: RemoteSignInLink | null } | undefined
  try {
    reply = await response.json()
  } catch {
    // Fall through to the generic message.
  }
  if (!response.ok || reply?.protocol !== 1 || !reply.current) {
    throw new Error(reply?.error ?? `Remote access could not be changed (${response.status})`)
  }
  return { current: reply.current, link: reply.link ?? null }
}

/** Switch the board to `choice`. Resolves with the setup now in force and, unless it is off, a sign-in link. */
export function applyRemoteChoice(choice: RemoteChoice, fetcher: typeof fetch = fetch): Promise<RemoteAccessChange> {
  return post(choice, fetcher)
}

/** Abandon a custom-name claim still waiting on its GitHub code; the pending change then fails. */
export function cancelRemoteClaim(fetcher: typeof fetch = fetch): Promise<RemoteAccessChange> {
  return post({ cancel: true }, fetcher)
}

/** A fresh single-use sign-in link for the setup in force. */
export function newRemoteSignInLink(fetcher: typeof fetch = fetch): Promise<RemoteAccessChange> {
  return post({ link: true }, fetcher)
}
