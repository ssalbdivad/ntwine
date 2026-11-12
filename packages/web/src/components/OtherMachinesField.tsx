import { useEffect, useRef, useState, type FormEvent } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Check, Copy } from "lucide-react"
import type { PeerPairCode, PeersState, PeerView } from "@ntwine/shared"
import { rpc } from "../api/rpc.ts"
import { errorText, invalidatePeers, usePeersState } from "../api/peers.ts"
import { copyTextToClipboard } from "../lib/clipboard.ts"
import { relativeAge } from "../lib/activityTime.ts"
import { formatCountdown } from "../lib/durationLabels.ts"
import { useNowMs } from "../lib/liveClock.ts"
import { SETTINGS_HELP } from "../lib/settingsHelp.ts"
import { showToast } from "../store.ts"
import { SettingsField } from "./SettingsField.tsx"
import { OnOffToggle } from "./ui/OnOffToggle.tsx"

// SETTINGS → OTHER MACHINES (plans/thread-handoff.md § 6): pair this machine with another once, so a
// resting thread can move between them from its ⋯ menu (ThreadMove.tsx). Two fields, in the drawer's own
// one-control-per-field rhythm — the machines and pairing, then the network listener — styled as
// RemoteAccessField is, the drawer's other machine-level form.
//
// PAIRING IS TWO SCREENS. Machine R shows a single-use code ("Pair a machine"); a person at machine I types
// R's address and that code ("Enter a code"). I's call returns the new peer; R learns of it only when I's
// request lands, so R's panel polls the reading while the code is up and closes itself, with a toast, the
// moment a machine it did not have appears. Both halves are refused through the public origin — the server
// answers why, and the field shows that answer rather than explaining it in advance.
//
// THE FINGERPRINT is the only check a person can make that the two machines paired with each other and not
// with something in between: this machine's is in the first line, and the other machine's row for this one
// must read the same.

const FIELD =
  "min-w-0 rounded-md border border-border bg-bg px-2 py-1 font-mono text-[12px] text-fg outline-none placeholder:text-muted-50 focus-visible:ring-1 focus-visible:ring-focus-ink-60"
const INPUT = `${FIELD} w-full`
const BUTTON =
  "button-outline w-fit rounded-md px-3 py-1 text-[12px] text-fg outline-none transition-colors hover:bg-panel-2 disabled:opacity-50"
// The row verbs (Check, Unpair): the same outline at the row's smaller type, so two of them beside a name
// do not outweigh it.
const ROW_BUTTON =
  "button-outline shrink-0 rounded-md px-2 py-0.5 text-[11.5px] text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg disabled:opacity-50"
const HINT = "text-[11px] leading-relaxed text-muted-70"
const ERROR = "text-[11px] leading-relaxed text-danger"

export function OtherMachinesField() {
  const [pairing, setPairing] = useState<"code" | "join" | null>(null)
  // While a code is on screen, the other machine typing it is what changes this reading.
  const reading = usePeersState({ fresh: true, pollMs: pairing === "code" ? 2_000 : undefined })
  // An older server answers no such procedure, and a page through the public origin may be refused: in
  // either case there is nothing here to act on, so the drawer reads as it did before.
  if (!reading.data) return null
  return (
    <>
      <SettingsField label="Other machines" help={SETTINGS_HELP.otherMachines}>
        <Machines state={reading.data} pairing={pairing} setPairing={setPairing} />
      </SettingsField>
      <SettingsField label="Reachable on your network" help={SETTINGS_HELP.peerListener}>
        <Listener state={reading.data} />
      </SettingsField>
    </>
  )
}

function Machines({ state, pairing, setPairing }: { state: PeersState; pairing: "code" | "join" | null; setPairing: (next: "code" | "join" | null) => void }) {
  const { self, peers } = state
  return (
    <div className="flex flex-col gap-2.5" data-other-machines>
      <p className={HINT} data-peer-self>
        This machine is <span className="text-fg">{self.name}</span>, fingerprint{" "}
        <span className="font-mono text-fg">{self.fingerprint}</span>.
      </p>
      {peers.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-2 p-0" data-peer-list>
          {peers.map((peer) => (
            <PeerRow key={peer.id} peer={peer} />
          ))}
        </ul>
      ) : null}
      <div className="flex items-center gap-2">
        <button type="button" className={BUTTON} aria-pressed={pairing === "code"} onClick={() => setPairing(pairing === "code" ? null : "code")} data-peer-pair>
          Pair a machine
        </button>
        <button type="button" className={BUTTON} aria-pressed={pairing === "join"} onClick={() => setPairing(pairing === "join" ? null : "join")} data-peer-join>
          Enter a code
        </button>
      </div>
      {pairing === "code" ? <PairCodePanel known={peers} onPaired={() => setPairing(null)} /> : null}
      {pairing === "join" ? <JoinForm onDone={() => setPairing(null)} /> : null}
    </div>
  )
}

function PeerRow({ peer }: { peer: PeerView }) {
  const queryClient = useQueryClient()
  const now = useNowMs()
  const [address, setAddress] = useState(peer.url)
  const [confirming, setConfirming] = useState(false)
  useEffect(() => setAddress(peer.url), [peer.url])

  const ping = useMutation({
    mutationFn: () => rpc.peerPing({ id: peer.id }),
    onSuccess: (result) => showToast(`${result.name} answered in ${Math.round(result.ms)}ms`),
    onError: (error) => showToast(`Couldn't reach ${peer.name}`, { detail: errorText(error).slice(0, 160) }),
    // Either way the row's last-seen and last-error moved.
    onSettled: () => void invalidatePeers(queryClient),
  })
  const save = useMutation({
    mutationFn: (url: string) => rpc.peerSetAddress({ id: peer.id, url }),
    onSuccess: () => void invalidatePeers(queryClient),
    onError: (error) => {
      setAddress(peer.url)
      showToast(`Couldn't save the address for ${peer.name}`, { detail: errorText(error).slice(0, 160) })
    },
  })
  const unpair = useMutation({
    mutationFn: () => rpc.peerUnpair({ id: peer.id }),
    onSuccess: () => {
      showToast(`Unpaired ${peer.name}`)
      void invalidatePeers(queryClient)
    },
    onError: (error) => showToast(`Couldn't unpair ${peer.name}`, { detail: errorText(error).slice(0, 160) }),
  })

  const commitAddress = () => {
    const next = address.trim()
    if (!next || next === peer.url) {
      setAddress(peer.url)
      return
    }
    save.mutate(next)
  }
  const seen = relativeAge(peer.lastSeenAt, now)
  const paired = relativeAge(peer.pairedAt, now)

  return (
    <li className="flex flex-col gap-1.5 rounded-md border border-border px-3 py-2" data-peer={peer.id}>
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="min-w-0 truncate text-[12.5px] font-medium text-fg">{peer.name}</span>
        <span className="shrink-0 font-mono text-[11px] text-muted" title="Its fingerprint. The same machine shows this as its own.">
          {peer.fingerprint}
        </span>
        <span className="ml-auto flex shrink-0 items-baseline gap-1.5">
          <button
            type="button"
            className={ROW_BUTTON}
            disabled={ping.isPending || !peer.url}
            title={peer.url ? undefined : "Add its address to check it"}
            onClick={() => ping.mutate()}
            data-peer-check
          >
            {ping.isPending ? "Checking…" : "Check"}
          </button>
          <button type="button" className={ROW_BUTTON} disabled={unpair.isPending} onClick={() => setConfirming(true)} data-peer-unpair>
            Unpair
          </button>
        </span>
      </div>
      <input
        aria-label={`Address of ${peer.name}`}
        className={INPUT}
        value={address}
        placeholder="Add its address, like http://desktop.local:9394"
        onChange={(event) => setAddress(event.target.value)}
        onBlur={commitAddress}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur()
          if (event.key === "Escape" && address !== peer.url) {
            // Escape undoes the edit; it does not also close the drawer.
            event.stopPropagation()
            setAddress(peer.url)
          }
        }}
        spellCheck={false}
        autoComplete="off"
        disabled={save.isPending}
      />
      <span className={HINT} data-peer-seen>
        {seen ? `Last seen ${seen}` : paired ? `Paired ${paired}` : null}
      </span>
      {peer.lastError ? <p className={`m-0 ${ERROR}`} data-peer-error>{peer.lastError}</p> : null}
      {confirming ? (
        <div className="flex flex-col gap-2 border-t border-border pt-2" data-peer-unpair-confirm>
          <p className={`m-0 ${HINT}`}>
            Unpair {peer.name}? Neither machine can move a thread to the other until you pair them again.
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="button-outline rounded-md bg-danger-button/90 px-3 py-1 text-[12px] font-medium text-white outline-none transition-opacity hover:opacity-90 disabled:opacity-60"
              disabled={unpair.isPending}
              onClick={() => unpair.mutate()}
            >
              Unpair
            </button>
            <button type="button" className={BUTTON} onClick={() => setConfirming(false)}>
              Keep
            </button>
          </div>
        </div>
      ) : null}
    </li>
  )
}

/** The code this machine shows, its countdown, and where the other machine can reach this one. */
function PairCodePanel({ known, onPaired }: { known: readonly PeerView[]; onPaired: () => void }) {
  const queryClient = useQueryClient()
  // The machines paired when the code went up: a row outside this set is the one that just used it.
  const before = useRef(new Set(known.map((peer) => peer.id)))
  const mint = useMutation({ mutationFn: () => rpc.peerPairCode({}) })
  const { mutate } = mint
  // Once per panel: a second mint (a StrictMode re-run of the effect) would leave a live code nobody sees.
  const minted = useRef(false)
  useEffect(() => {
    if (minted.current) return
    minted.current = true
    mutate()
  }, [mutate])

  useEffect(() => {
    const fresh = known.find((peer) => !before.current.has(peer.id))
    if (!fresh) return
    showToast(`Paired with ${fresh.name}`)
    onPaired()
  }, [known, onPaired])

  if (mint.error) return <p className={`m-0 ${ERROR}`} data-peer-code-error>{errorText(mint.error)}</p>
  if (!mint.data) return <p className={`m-0 ${HINT}`}>Making a code…</p>
  return <CodeCard code={mint.data} onRenew={() => { void invalidatePeers(queryClient); mutate() }} />
}

function CodeCard({ code, onRenew }: { code: PeerPairCode; onRenew: () => void }) {
  // Its own one-second clock: a countdown ticks (durationLabels formatCountdown), and the app's shared clock
  // moves every 30s.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(id)
  }, [])
  const left = Date.parse(code.expiresAt) - now
  const expired = !(left > 0)
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-panel-2 px-3 py-2.5" data-peer-code>
      {/* OPTICAL CORRECTIONS on this row, measured in sans at the sizes it ships (20px code, 13px icon,
          11px expiry; 2026-11-12). The copy glyph's ink centre sat 0.57px below the code's cap band and
          its ink began ~12.6px after the code's (gap-2 + the button's p-1 + the glyph's own margin, read off
          a dsf-6 crop — canvas metrics ignore the code's letter-spacing): the button takes -ml-1 (→ ~9.7px)
          and the glyph -0.5px (residual 0.07px). Centred on the line, the expiry's cap band
          rode 0.84px below the code's: -1px (residual 0.16px). Re-measure if a size here changes. */}
      <div className="flex min-w-0 items-center gap-2">
        <code className={`select-all font-mono-keep text-[20px] font-medium tracking-[0.06em] ${expired ? "text-muted line-through" : "text-fg"}`} data-peer-code-value>
          {code.code}
        </code>
        {expired ? null : <CopyButton text={code.code} label="Copy code" className="-ml-1" glyphClassName="-translate-y-[0.5px]" />}
        <span className="ml-auto shrink-0 -translate-y-px text-[11px] tabular-nums text-muted" data-peer-code-expiry>
          {expired ? "Expired" : `Expires in ${formatCountdown(left)}`}
        </span>
      </div>
      {expired ? (
        <button type="button" className={BUTTON} onClick={onRenew}>
          New code
        </button>
      ) : code.addresses.length > 0 ? (
        <>
          <p className={`m-0 ${HINT}`}>On the other machine, choose Enter a code and type this code with one of these addresses:</p>
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0" data-peer-code-addresses>
            {code.addresses.map((address) => (
              <li key={address} className="select-all break-all font-mono text-[11.5px] text-fg">
                {address}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className={`m-0 ${HINT}`}>
          On the other machine, choose Enter a code and type this code with this machine's remote access address. For an
          address on your network, turn on Reachable on your network below.
        </p>
      )}
    </div>
  )
}

/** The other half: this machine joins one that is showing a code. */
function JoinForm({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient()
  const [url, setUrl] = useState("")
  const [code, setCode] = useState("")
  const first = useRef<HTMLInputElement>(null)
  useEffect(() => first.current?.focus(), [])
  const join = useMutation({
    mutationFn: () => rpc.peerPairJoin({ url: url.trim(), code: code.trim() }),
    onSuccess: (peer) => {
      showToast(`Paired with ${peer.name}`)
      void invalidatePeers(queryClient)
      onDone()
    },
  })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (url.trim() && code.trim()) join.mutate()
  }
  return (
    <form className="flex flex-col gap-2" onSubmit={submit} data-peer-join-form>
      <p className={`m-0 ${HINT}`}>Type what the other machine shows under Pair a machine.</p>
      <input
        ref={first}
        aria-label="The other machine's address"
        className={INPUT}
        value={url}
        placeholder="http://desktop.local:9394"
        onChange={(event) => setUrl(event.target.value)}
        spellCheck={false}
        autoComplete="off"
      />
      <input
        aria-label="Code"
        className={`${INPUT} uppercase`}
        value={code}
        placeholder="XXXX-XXXX-XXXX"
        onChange={(event) => setCode(event.target.value)}
        spellCheck={false}
        autoComplete="off"
      />
      <div className="flex items-center gap-2">
        <button type="submit" className={BUTTON} disabled={join.isPending || !url.trim() || !code.trim()}>
          {join.isPending ? "Pairing…" : "Pair"}
        </button>
        <button type="button" className={BUTTON} onClick={onDone} disabled={join.isPending}>
          Cancel
        </button>
      </div>
      {join.error ? <p className={`m-0 ${ERROR}`} data-peer-join-error>{errorText(join.error)}</p> : null}
    </form>
  )
}

function Listener({ state }: { state: PeersState }) {
  const queryClient = useQueryClient()
  const { listener, self } = state
  const [port, setPort] = useState(String(listener.port))
  useEffect(() => setPort(String(listener.port)), [listener.port])
  const set = useMutation({
    mutationFn: (input: { enabled: boolean; port?: number }) => rpc.peerSetListener(input),
    onSettled: () => void invalidatePeers(queryClient),
  })
  const parsedPort = Number(port)
  const portValid = Number.isInteger(parsedPort) && parsedPort >= 1024 && parsedPort <= 65535
  const commitPort = () => {
    if (!portValid) {
      setPort(String(listener.port))
      return
    }
    if (parsedPort !== listener.port) set.mutate({ enabled: listener.enabled, port: parsedPort })
  }
  const error = set.error ? errorText(set.error) : listener.error
  return (
    <div className="flex flex-col gap-1.5" data-peer-listener>
      <div className="flex items-center gap-3">
        <OnOffToggle value={listener.enabled} onChange={(on) => set.mutate({ enabled: on, ...(portValid ? { port: parsedPort } : {}) })} />
        <label className="flex items-center gap-1.5 text-[12px] text-muted">
          Port
          <input
            aria-label="Port"
            inputMode="numeric"
            className={`${FIELD} w-[72px] tabular-nums`}
            value={port}
            onChange={(event) => setPort(event.target.value.replace(/[^0-9]/g, "").slice(0, 5))}
            onBlur={commitPort}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur()
            }}
            disabled={set.isPending}
          />
        </label>
      </div>
      {error ? <p className={`m-0 ${ERROR}`} data-peer-listener-error>{error}</p> : null}
      {listener.enabled && !error && self.addresses.length > 0 ? (
        <p className={`m-0 ${HINT}`} data-peer-addresses>
          Reached at{" "}
          {self.addresses.map((address, index) => (
            <span key={address}>
              {index > 0 ? ", " : null}
              <span className="select-all font-mono text-fg">{address}</span>
            </span>
          ))}
        </p>
      ) : null}
    </div>
  )
}

function CopyButton({ text, label, className = "", glyphClassName = "" }: { text: string; label: string; className?: string; glyphClassName?: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await copyTextToClipboard(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard blocked — the code is still selectable */
    }
  }
  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={label}
      title={label}
      className={`shrink-0 rounded-md p-1 text-muted outline-none transition-colors hover:bg-panel hover:text-fg ${className}`}
    >
      {copied ? <Check size={13} className={`text-live ${glyphClassName}`} aria-hidden /> : <Copy size={13} className={glyphClassName} aria-hidden />}
    </button>
  )
}
