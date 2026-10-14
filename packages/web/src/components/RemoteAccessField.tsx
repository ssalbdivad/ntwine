import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  applyRemoteChoice,
  cancelRemoteClaim,
  newRemoteSignInLink,
  readRemoteAccess,
  type RemoteAccessState,
  type RemoteChoice,
  type RemoteKind,
  type RemoteSetupView,
  type RemoteSignInLink,
} from "../api/remoteAccess.ts"
import { useInnerHtml } from "../lib/innerHtml.ts"
import { SETTINGS_HELP } from "../lib/settingsHelp.ts"
import { SettingsField } from "./SettingsField.tsx"
import { Select } from "./ui/Select.tsx"

// Settings → Remote access: the R pane's walkthrough (src/remote-pane.ts) as a form, for the operator at
// the machine. The supervisor refuses this route through the public origin, so a phone never sees the
// field at all — choosing who can reach the board needs presence on the machine.

const KINDS: { value: RemoteKind; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "private", label: "Private ntwine.app name" },
  { value: "ntwine", label: "Custom ntwine.app name" },
  { value: "cloudflare", label: "Cloudflare Tunnel" },
  { value: "tailscale", label: "Tailscale" },
  { value: "other", label: "Something else" },
]

const REMOTE_ACCESS_KEY = ["remoteAccess"] as const

/** The setup in force, as the form's fields — so re-saving it, or changing one value, starts from what is there. */
function fieldsOf(current: RemoteSetupView): Record<string, string> {
  if (current.kind === "ntwine") return { name: current.name ?? "" }
  if (current.kind === "cloudflare") return { hostname: current.origin?.replace(/^https:\/\//, "") ?? "", tunnel: current.tunnel ?? "" }
  if (current.kind === "tailscale" || current.kind === "other") return { origin: current.origin ?? "" }
  return {}
}

const INPUT =
  "w-full rounded-md border border-border bg-bg px-2 py-1 font-mono text-[12px] text-fg outline-none placeholder:text-muted-50 focus-visible:ring-1 focus-visible:ring-focus-ink-60"
const BUTTON =
  "button-outline w-fit rounded-md px-3 py-1 text-[12px] text-fg outline-none transition-colors hover:bg-panel-2 disabled:opacity-50"
const HINT = "text-[11px] leading-relaxed text-muted-70"

export function RemoteAccessField() {
  const reading = useQuery({ queryKey: REMOTE_ACCESS_KEY, queryFn: () => readRemoteAccess(), staleTime: 30_000 })
  if (!reading.data || reading.data.kind === "hidden") return null
  if (reading.data.kind === "unsupported") {
    return (
      <SettingsField label="Remote access" help={SETTINGS_HELP.remoteAccess}>
        <p className={HINT}>
          This launch serves this machine only. Start ntwine with <code>npx ntwine</code> (or <code>ntwine-dev</code> from a
          checkout) to set up remote access.
        </p>
      </SettingsField>
    )
  }
  return (
    <SettingsField label="Remote access" help={SETTINGS_HELP.remoteAccess}>
      <RemoteAccessForm state={reading.data.state} />
    </SettingsField>
  )
}

function RemoteAccessForm({ state }: { state: RemoteAccessState }) {
  const queryClient = useQueryClient()
  const current = state.current
  const [kind, setKind] = useState<RemoteKind>(current.kind)
  const [link, setLink] = useState<RemoteSignInLink | null>(null)
  const [fields, setFields] = useState<Record<string, string>>(() => fieldsOf(current))
  useEffect(() => {
    setKind(current.kind)
    setFields(fieldsOf(current))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-seed only when the setup in force changes
  }, [current.kind, current.origin, current.name, current.tunnel])

  const change = useMutation({
    mutationFn: (choice: RemoteChoice) => applyRemoteChoice(choice),
    onSuccess: (result) => {
      setLink(result.link)
      void queryClient.invalidateQueries({ queryKey: REMOTE_ACCESS_KEY })
    },
  })
  const fresh = useMutation({ mutationFn: () => newRemoteSignInLink(), onSuccess: (result) => setLink(result.link) })

  const field = (key: string) => fields[key] ?? ""
  const setField = (key: string, value: string) => setFields((prev) => ({ ...prev, [key]: value }))
  const tailscaleOrigin = state.probes.tailscale.dnsName ? `https://${state.probes.tailscale.dnsName}` : ""

  const choice = (): RemoteChoice => {
    if (kind === "off" || kind === "private") return { kind }
    if (kind === "ntwine") return { kind, name: field("name") }
    if (kind === "cloudflare") return { kind, hostname: field("hostname"), tunnel: field("tunnel") }
    return { kind, origin: field("origin") || (kind === "tailscale" ? tailscaleOrigin : "") }
  }

  const unchanged = kind === current.kind && kind !== "ntwine" && kind !== "cloudflare" && kind !== "tailscale" && kind !== "other"
  const busy = change.isPending
  // A custom-name claim waits on a GitHub device code while its POST is pending; the launcher reports the
  // code through the same reading, so poll it for as long as that wait can last.
  const live = useQuery({
    queryKey: REMOTE_ACCESS_KEY,
    queryFn: () => readRemoteAccess(),
    enabled: busy && kind === "ntwine",
    refetchInterval: busy && kind === "ntwine" ? 1_500 : false,
  })
  const signIn = busy && kind === "ntwine" && live.data?.kind === "ready" ? live.data.state.signIn ?? null : null
  const error = change.error instanceof Error ? change.error.message : fresh.error instanceof Error ? fresh.error.message : null
  const applyLabel = busy ? "Applying…" : kind === "off" ? "Turn off" : kind === "private" ? "Get a private name" : kind === "ntwine" ? "Claim" : "Save"

  return (
    <div className="flex flex-col gap-2.5" data-remote-access>
      <p className={HINT} data-remote-current>
        {current.origin ? <>Reached at <span className="font-mono text-fg">{current.origin}</span></> : "This machine only."}
      </p>

      <Select
        variant="bordered"
        value={kind}
        onValueChange={(value) => {
          setKind(value as RemoteKind)
          setFields(value === current.kind ? fieldsOf(current) : {})
          change.reset()
        }}
        options={KINDS}
        indicatorPosition="right"
        ariaLabel="Remote access"
      />

      <KindDetails kind={kind} state={state} field={field} setField={setField} tailscaleOrigin={tailscaleOrigin} />

      <div className="flex items-center gap-2">
        {/* Re-applying the setup in force is a no-op for the kinds with nothing to type, so the button
            only appears once there is something to change. */}
        {!unchanged ? (
          <button type="button" className={BUTTON} disabled={busy} onClick={() => change.mutate(choice())} data-remote-apply>
            {applyLabel}
          </button>
        ) : null}
        {current.kind !== "off" && kind === current.kind ? (
          <button type="button" className={BUTTON} disabled={fresh.isPending} onClick={() => fresh.mutate()} data-remote-link>
            {link ? "New sign-in link" : "Show sign-in link"}
          </button>
        ) : null}
      </div>

      {signIn ? (
        <div className="flex flex-col gap-1.5" data-remote-device-code>
          <p className={HINT}>
            Open{" "}
            <a className="text-fg underline" href={signIn.verificationUri} target="_blank" rel="noreferrer">
              {signIn.verificationUri.replace(/^https:\/\//, "")}
            </a>{" "}
            on any device and enter <span className="font-mono text-fg">{signIn.userCode}</span>.
          </p>
          <button type="button" className={BUTTON} onClick={() => void cancelRemoteClaim().catch(() => undefined)}>
            Cancel
          </button>
        </div>
      ) : null}
      {error ? <p className="text-[11px] text-danger">{error}</p> : null}
      {link && current.kind !== "off" ? <SignInLink link={link} /> : null}
    </div>
  )
}

function KindDetails({
  kind,
  state,
  field,
  setField,
  tailscaleOrigin,
}: {
  kind: RemoteKind
  state: RemoteAccessState
  field: (key: string) => string
  setField: (key: string, value: string) => void
  tailscaleOrigin: string
}) {
  const { probes, port } = state
  if (kind === "off") return null
  if (kind === "private") {
    return <p className={HINT}>An unguessable name on ntwine.app. No account, nothing to install.</p>
  }
  if (kind === "ntwine") {
    return (
      <>
        <p className={HINT}>Claiming asks you to confirm a GitHub account with a one-time code. ntwine gets no GitHub permissions. One name per account.</p>
        <input
          aria-label="Name"
          className={INPUT}
          value={field("name")}
          placeholder="name"
          onChange={(event) => setField("name", event.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
      </>
    )
  }
  if (kind === "cloudflare") {
    return (
      <>
        <p className={HINT}>
          {probes.cloudflared.version ? `cloudflared ${probes.cloudflared.version} found. ` : "Needs cloudflared on this machine. "}
          Create the tunnel and its DNS record once, in a terminal:
        </p>
        <Commands
          lines={[
            "cloudflared tunnel login",
            "cloudflared tunnel create my-board",
            "cloudflared tunnel route dns my-board board.example.com",
          ]}
        />
        <input aria-label="Hostname" className={INPUT} value={field("hostname")} placeholder="board.example.com" onChange={(event) => setField("hostname", event.target.value)} spellCheck={false} autoComplete="off" />
        <input aria-label="Tunnel" className={INPUT} value={field("tunnel")} placeholder="my-board" onChange={(event) => setField("tunnel", event.target.value)} spellCheck={false} autoComplete="off" />
      </>
    )
  }
  if (kind === "tailscale") {
    return (
      <>
        <p className={HINT}>
          {!probes.tailscale.installed
            ? "Needs Tailscale on this machine. "
            : probes.tailscale.dnsName
              ? ""
              : "Tailscale did not answer. Is it signed in? "}
          Only devices on your tailnet can reach it. Run once, in a terminal:
        </p>
        <Commands lines={[`tailscale serve --bg ${port}`]} />
        <input aria-label="Origin" className={INPUT} value={field("origin")} placeholder={tailscaleOrigin || "https://machine.your-tailnet.ts.net"} onChange={(event) => setField("origin", event.target.value)} spellCheck={false} autoComplete="off" />
      </>
    )
  }
  return (
    <>
      <p className={HINT}>
        Terminate TLS wherever you like, proxy to <span className="font-mono">http://127.0.0.1:{port}</span>, and enter the
        address a browser will show.
      </p>
      <input aria-label="Origin" className={INPUT} value={field("origin")} placeholder="https://board.example.com" onChange={(event) => setField("origin", event.target.value)} spellCheck={false} autoComplete="off" />
    </>
  )
}

function Commands({ lines }: { lines: string[] }) {
  return (
    <pre className="m-0 overflow-x-auto rounded-md border border-border bg-panel-2 px-2 py-1.5 font-mono text-[11.5px] leading-relaxed text-fg">
      {lines.join("\n")}
    </pre>
  )
}

function SignInLink({ link }: { link: RemoteSignInLink }) {
  // Through useInnerHtml, never an inline `{ __html }`: the pane re-renders while the operator edits the
  // fields above, and a fresh literal would rebuild the QR's SVG each time (lib/innerHtml.ts).
  const qr = useInnerHtml(link.qrSvg)
  return (
    <div className="flex items-start gap-3" data-remote-sign-in>
      {/* The launcher draws the SVG (packages/server/src/qr.ts renderQrSvg): fixed markup from an encoder,
          with no text from the request in it. */}
      <div className="size-[168px] shrink-0 overflow-hidden rounded-md border border-border [&>svg]:block [&>svg]:size-full" dangerouslySetInnerHTML={qr} />
      <div className="flex min-w-0 flex-col gap-1.5">
        <p className={HINT}>Scan to sign in on a phone. Works once and expires in 5 minutes.</p>
        <p className="break-all font-mono text-[11px] text-muted">{link.url}</p>
      </div>
    </div>
  )
}
