import { Fragment, useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query"
import { RotateCw } from "lucide-react"
import type { AuthSnapshot, ProviderAuth, ProviderQuota, QuotaProvider, QuotaSnapshot, QuotaWindow, Settings } from "@ntwine/shared"
import { rpc } from "../api/rpc.ts"
import { ProviderMark } from "./ProviderMark.tsx"
import { Popover, PopoverContent, PopoverTrigger } from "./ui/Popover.tsx"
import { PROVIDER_LABEL } from "../lib/signIn.ts"
import { SETTINGS_WRITE_KEY, publishMachineSettings, publishOwnSettings } from "../hooks/useSettingsAutosave.tsx"

// THE QUOTA CHIPS — the readouts at the left of the StatusRow above the prompt box, one compact chip
// per backend showing REMAINING subscription quota. Click a chip for the full per-window breakdown.
//
// THREE PROVIDERS: Claude, Codex and Gemini (the Antigravity CLI's account, read from `agy -p /usage` —
// server/backend/gemini-quota.ts). WHICH chips show is the human's (maintainer 2026-11-20: "be able to
// check which you want to see in menu"): every chip with a reading by default, and each popover carries a
// "Show" checklist that hides the others. The choice is the machine setting `hiddenQuotaChips` — a list
// of what is HIDDEN, so a provider that starts reporting later shows up on its own. The default is every
// reading rather than "the default model's provider" because the default model is per project and the
// row is global, and because that is what the row already did for Claude and Codex.
//
// A chip renders ONLY when it has a percentage to show (see hasReading). It used to be the provider
// AUTH surface too — a signed-out account drew an em dash whose popover offered Sign in — and that is
// gone with the dash: the sign-in door is the composer's dispatch gate (submitting a thread on a
// signed-out backend opens the same modal) and the `/login` alias.
//
// These are back above the sidebar's dispatch box, where they briefly floated on their own before a
// spell in a fixed corner bar. Quota is ACCOUNT-global — it was never a property of the composer it
// sits over — which is why it rides a GLOBAL status row rather than being composer decoration.
// The chips carry no wrapper padding or justification of their own: StatusRow owns the layout, and a
// chip that brought its own box would break the single-line rhythm.
//
// The live connection state is NOT repeated here: it is the dot at the far right of the same row,
// pinned to the project name.
//
// Quota is polled (rpc.quota) rather than pushed on the board: it is ACCOUNT-global, not per-thread.
// The server keeps Claude's reading warm on its own heartbeat (refreshClaudeQuotaInBackground) and
// holds Codex's for a minute (readCodexQuota), so this poll reads those caches — a cheap local RPC
// that starts a provider round-trip only when one of them has expired — and a 30s cadence keeps the
// chip tracking them within half a minute instead of drifting minutes stale during a fast burn. An
// UNAVAILABLE read re-polls at 15s (a blip should self-heal in seconds) — but only for a provider that
// is signed in: a signed-out one has no reading to recover, and counting it as a blip put every
// one-provider account on the fast cadence for good. Opening a chip's popover re-reads those caches and
// auth; its refresh button is the LIVE recheck (`force`, naming that provider), the only read that
// reaches past the freshness window — for Claude that runs the `claude -p /usage` CLI, ~8s, which is
// why opening the popover alone does not.

// Every quota/auth request carries an abort deadline. Without one, a single response the server never
// finishes (a dev-server restart severing an in-flight request) leaves the fetch pending FOREVER:
// react-query stays "fetching" and never retries, the recheck latch never clears, and the chip freezes
// into an em dash with a dead click target — the exact reported failure. The deadline turns that into
// an ordinary error the next poll recovers from, while `data` keeps the last good reading.
const POLL_TIMEOUT_MS = 30_000
// A forced recheck legitimately runs Claude Code's `/usage` CLI behind a cross-process lock (~27s
// worst case), so it gets a longer leash.
const RECHECK_TIMEOUT_MS = 45_000

function deadline(ms: number, signal?: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms)
}

// THE READING IS SMALL ON PURPOSE (maintainer 2026-08-19: "I wish we'd make the percentages a lot
// smaller. The actual text of the percentage numbers should be small"). 9px, down from 11px, against
// the row's 12px identity — the smallest type anywhere in this app, deliberately. The chips are
// ambient background information, not something to read on every glance, and at 11px two of them
// carried nearly the same weight as the project name they sit opposite. It stops at 9 because tabular
// digits below that stop being legible at a glance, which would trade one problem for another.
//
// It applies to the WRAPPER, so every branch inherits it: the percentage, the em dash a signed-out or
// unavailable provider shows, and the "··" first-fetch placeholder. Those three occupy the same slot
// and a size that only reached one of them would make the chip resize as its state changed.
//
// The PROVIDER MARKS do not shrink with it. They are fixed px in PROVIDER_MARK_GEOMETRY (11px Claude,
// 10px Codex — optically matched to each other, not to any font size), so the mark stays put and only
// the number drops. That is the intended reading: the mark identifies the provider, the small number
// is its current level.
const QUOTA_READING = "text-[9px]"

// THE PROVIDER MARK IS AN ICON IN THIS ROW, and carries an icon's size and weight (maintainer
// 2026-08-19: "logos should be the same brightness and size as the other icons. The text should just
// be small"). `text-fg/75` is exactly STATUS_ROW_ACTION's tone, so the two marks sit at the same
// brightness as the home, settings and reload glyphs beside them rather than reading as dimmer
// metadata.
//
// SIZE IS OPTICAL, NOT NOMINAL — and it is two numbers, not one, because these two marks do not fill
// their viewBoxes alike. PROVIDER_MARK_GEOMETRY's 11px/10px pairing already encodes that (the OpenAI
// knot is denser than the Claude asterisk), and the job here is to keep that relationship while
// landing both on the ~12px of ink a 14px lucide glyph paints. Measured with scripts/ink-gaps.mjs at
// --dsf=4 --pad=0 against the settings gear, and re-measure rather than re-guess if either changes.
//
// `!` on both because ProviderMark composes its own `text-muted-65` and `size-*` ahead of this
// className, and Tailwind resolves a same-property collision by CSS SOURCE order, not class order —
// without it these silently lose to the defaults.
const PROVIDER_MARK_AS_ICON: Record<QuotaProvider, string> = {
  claude: "text-fg/75! size-[14px]! translate-y-0!",
  codex: "text-fg/75! size-[12.75px]! translate-y-0!",
  // The Gemini sparkle paints only 26% of its box (Claude's asterisk 48%, the OpenAI knot 49%, measured
  // with ink-gaps.mjs at dsf 4, 2026-11-20), all of it in four thin points, so at the 12px of ink the
  // gear paints it read a size smaller than the marks beside it. 14px — the asterisk's box, the other
  // radial mark — matches them. Its ink is symmetric in the box, so `items-center` leaves it 0.08px off
  // the digits' centre, the same residual as the other two.
  gemini: "text-fg/75! size-[14px]! translate-y-0!",
}

/** Every provider the row can draw, in the order it draws them. */
const QUOTA_PROVIDERS = ["claude", "codex", "gemini"] as const satisfies readonly QuotaProvider[]

const QUOTA_LABEL: Record<QuotaProvider, string> = { ...PROVIDER_LABEL, gemini: "Gemini" }

/** Gemini has no ProviderMark backend of its own: it runs as the Antigravity agent, which wears the Gemini glyph. */
function QuotaMark({ provider, className }: { provider: QuotaProvider; className?: string }) {
  return provider === "gemini"
    ? <ProviderMark backend="acp" model="acp:antigravity" className={className} />
    : <ProviderMark backend={provider} className={className} />
}

/** Gemini has no sign-in surface in ntwine, so no auth verdict: its reading alone decides. */
function authOf(auth: AuthSnapshot | undefined, provider: QuotaProvider): ProviderAuth | undefined {
  return provider === "gemini" ? undefined : auth?.[provider]
}

function quotaOf(snapshot: QuotaSnapshot | undefined, provider: QuotaProvider): ProviderQuota | undefined {
  return snapshot?.[provider]
}

/** The providers that have a reading, and of those the ones the human has not hidden. */
function chipSets(quota: QuotaSnapshot | undefined, auth: AuthSnapshot | undefined, loading: boolean, hidden: readonly QuotaProvider[]) {
  const reading = QUOTA_PROVIDERS.filter((p) => hasReading(quotaOf(quota, p), authOf(auth, p), loading))
  return { reading, shown: reading.filter((p) => !hidden.includes(p)) }
}

function useHiddenQuotaChips(): readonly QuotaProvider[] {
  const settings = useQuery({ queryKey: ["settingsGet"], queryFn: () => rpc.settingsGet() })
  return settings.data?.hiddenQuotaChips ?? []
}

/**
 * Whether the chips have ANYTHING to draw. StatusRow owns the divider that separates the actions from
 * these readouts, so it has to know whether the group behind that divider is empty — otherwise a board
 * with neither provider reporting draws a hairline with nothing after it.
 *
 * Same query keys as QuotaChips, so react-query serves both from ONE fetch rather than doubling the
 * poll.
 */
export function useQuotaChipsVisible(): boolean {
  const quota = useQuery({ queryKey: ["quota"], queryFn: () => rpc.quota(), staleTime: 10_000 })
  const auth = useQuery({ queryKey: ["authStatus"], queryFn: () => rpc.authStatus(), staleTime: 30_000 })
  const hidden = useHiddenQuotaChips()
  return chipSets(quota.data, auth.data, quota.isLoading, hidden).shown.length > 0
}

/**
 * Is there a percentage to show for this provider? Anything else — the first fetch, a signed-out
 * account, an unreachable usage endpoint — is NO DATA, and a chip with no data renders nothing at all
 * (maintainer 2026-08-19: "if there's no data available for a given agent, then it should just be
 * entirely hidden instead of showing an em dash"). An em dash occupied a readout's worth of space to
 * say a readout was missing, which is the noisiest way to say nothing.
 *
 * A signed-out provider counts as no data: a signed-out account HAS no quota. That does remove the
 * chip's Sign in popover, which is why the composer's dispatch gate and the `/login` alias remain the
 * ways in — submitting a thread on a signed-out backend still opens the same modal.
 */
function hasReading(quota: ProviderQuota | undefined, auth: ProviderAuth | undefined, loading: boolean): boolean {
  if (auth === "signed-out") return false
  if (!quota && loading) return false
  return !!quota && quota.status === "ok" && quota.windows.length > 0
}

export function QuotaChips() {
  const queryClient = useQueryClient()
  const recheckInFlight = useRef<Promise<void> | null>(null)
  const [rechecking, setRechecking] = useState(false)
  // Keep the last value through refetches so the bar never flickers to empty. The query never
  // rejects meaningfully (the server degrades each provider to "unavailable").
  const quota = useQuery({
    queryKey: ["quota"],
    queryFn: ({ signal }) => rpc.quota(undefined, { signal: deadline(POLL_TIMEOUT_MS, signal) }),
    refetchInterval: (query) => {
      const d = query.state.data
      const signedIn = queryClient.getQueryData<AuthSnapshot>(["authStatus"])
      // Gemini is left out: its reading is held a minute server-side, so a faster poll would only re-read
      // that, and a machine whose `agy` is signed out would sit on the fast cadence for good.
      const degraded = !d || (["claude", "codex"] as const).some((b) => d[b].status !== "ok" && signedIn?.[b] !== "signed-out")
      return degraded ? 15_000 : 30_000
    },
    staleTime: 10_000,
    refetchOnWindowFocus: true,
  })
  // The credential surface. Same cache key as the dispatch gate, so a sign-in from either place
  // updates both. Polled slowly; the popover-open refetch is the responsive path.
  const auth = useQuery({
    queryKey: ["authStatus"],
    queryFn: ({ signal }) => rpc.authStatus(undefined, { signal: deadline(POLL_TIMEOUT_MS, signal) }),
    refetchInterval: 120_000,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  })

  const hidden = useHiddenQuotaChips()
  const { reading, shown } = chipSets(quota.data, auth.data, quota.isLoading, hidden)
  const visibility = useMutation({
    mutationKey: SETTINGS_WRITE_KEY,
    mutationFn: (next: QuotaProvider[]) => saveHiddenQuotaChips(queryClient, next),
  })
  const setShown = (provider: QuotaProvider, show: boolean) => {
    const next = show ? hidden.filter((p) => p !== provider) : [...new Set([...hidden, provider])]
    visibility.mutate(next)
  }

  const recheck = (backend: QuotaProvider, force: boolean) => {
    if (recheckInFlight.current) return
    setRechecking(true)
    const request = Promise.all([
      rpc.quota(force ? { force: backend } : undefined, { signal: deadline(force ? RECHECK_TIMEOUT_MS : POLL_TIMEOUT_MS) })
        .then((snapshot) => queryClient.setQueryData(["quota"], snapshot)),
      queryClient.refetchQueries({ queryKey: ["authStatus"] }),
    ]).then(() => {}).catch(() => {})
      .finally(() => {
        recheckInFlight.current = null
        setRechecking(false)
      })
    recheckInFlight.current = request
  }

  return (
    // `gap-3` is the STATUS ROW's one optical distance, not a value of this component's own: these two
    // chips sit in that row, and a chip-to-chip gap that differs from the row's is exactly the
    // inconsistency the trims in lib/statusRow.ts were cut to remove. Both provider marks reach their
    // own box edge, so this gap needs no trim to mean 12px of ink (measured 12.25). The 6px INSIDE a
    // chip (mark → percentage) is deliberately half of it — that is what keeps each mark reading as
    // one pill rather than four loose glyphs.
    <div data-quota-bar className={`flex shrink-0 items-center gap-3 ${QUOTA_READING}`}>
      {shown.map((provider) => (
        <QuotaChip
          key={provider}
          backend={provider}
          quota={quotaOf(quota.data, provider)}
          auth={authOf(auth.data, provider)}
          email={provider === "gemini" ? undefined : auth.data?.emails?.[provider]}
          loading={quota.isLoading}
          fetching={quota.isFetching || rechecking}
          onRecheck={(force) => recheck(provider, force)}
          visibility={reading.length > 1 ? { reading, shown, onChange: setShown } : undefined}
        />
      ))}
    </div>
  )
}

// One provider's chip: the provider mark + the 5-HOUR window's remaining quota, as a percentage. Clicking
// opens a Popover with the full per-window breakdown (both windows + reset times + plan), the account the
// credential belongs to — and forces a fresh quota+auth read, so the chip doubles as the recheck control.
//
// NO READING, NO CHIP — see hasReading. The first fetch, a signed-out account and an unreachable usage
// endpoint all render nothing rather than the em dash and the "··" placeholder they used to. The
// popover's own branches for signed-out and unavailable are therefore unreachable from this row and
// have been removed with them; the sign-in door is the composer's dispatch gate and `/login`.
type ChipVisibilityProps = {
  /** Providers with a reading — the only ones a checkbox can mean anything for. */
  reading: readonly QuotaProvider[]
  shown: readonly QuotaProvider[]
  onChange: (provider: QuotaProvider, show: boolean) => void
}

type QuotaChipProps = {
  backend: QuotaProvider
  quota: ProviderQuota | undefined
  auth: ProviderAuth | undefined
  email: string | undefined
  loading: boolean
  fetching: boolean
  onRecheck: (force: boolean) => void
  /** Absent when only one provider has a reading: there is nothing to choose between. */
  visibility?: ChipVisibilityProps
}

// The write behind the checklist. Optimistic: every cached settings entry takes the new list at once, so
// the chip goes on the click, then the server's copy replaces it. The write carries the WHOLE object on a
// fresh read, as every settings write here does (lib/editorBridge.ts sendCodeFilesTo); a failed one puts
// the cache back to what the server holds.
async function saveHiddenQuotaChips(queryClient: QueryClient, next: QuotaProvider[]): Promise<void> {
  for (const query of queryClient.getQueryCache().findAll({ queryKey: ["settingsGet"] })) {
    const cached = query.state.data as Settings | undefined
    if (cached) query.setData({ ...cached, hiddenQuotaChips: next }, { manual: true })
  }
  try {
    const current = await rpc.settingsGet()
    publishOwnSettings(queryClient, await rpc.settingsSet({ ...current, hiddenQuotaChips: next }))
  } catch {
    const fresh = await rpc.settingsGet().catch(() => undefined)
    if (fresh) publishMachineSettings(queryClient, fresh)
  }
}

// THE "SHOW" CHECKLIST at the foot of every chip's popover: one row per provider with a reading. The last
// chip still showing cannot be unticked — with no chip left there would be no popover to tick one back
// from.
function ChipVisibility({ reading, shown, onChange }: ChipVisibilityProps) {
  return (
    <div data-quota-visibility className="mt-2.5 border-t border-border pt-2">
      <div className="mb-1 text-muted-55">Show</div>
      <ul className="flex flex-col gap-0.5">
        {reading.map((provider) => {
          const on = shown.includes(provider)
          const locked = on && shown.length === 1
          return (
            <li key={provider}>
              <button
                type="button"
                role="checkbox"
                aria-checked={on}
                disabled={locked}
                title={locked ? "One chip always shows" : undefined}
                onClick={() => onChange(provider, !on)}
                className="-mx-1 flex w-[calc(100%+0.5rem)] items-center gap-2 rounded px-1 py-0.5 text-left text-muted-80 outline-none transition-colors hover:bg-elevated hover:text-fg focus-visible:ring-1 focus-visible:ring-border-strong disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-muted-80"
              >
                <span aria-hidden className={`flex size-3 shrink-0 items-center justify-center rounded-[3px] border ${on ? "border-accent bg-accent" : "border-control-border"}`}>
                  {on && <svg viewBox="0 0 10 10" className="size-2.5 text-bg"><path d="M2 5.2 4.1 7.3 8 3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                </span>
                <QuotaMark provider={provider} />
                <span>{QUOTA_LABEL[provider]}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function QuotaChip({
  backend,
  quota,
  auth,
  email,
  loading,
  fetching,
  onRecheck,
  visibility,
}: QuotaChipProps) {
  const providerLabel = QUOTA_LABEL[backend]

  // A positive signed-out outranks any quota reading: a signed-out account HAS no usable quota, and
  // "Usage endpoint unreachable" would be a misdiagnosis. Fails open — unknown/loading render quota.
  if (!hasReading(quota, auth, loading)) return null

  // The headline is ALWAYS the 5-hour window — "how much can I do right now" is the number that matters
  // day-to-day, and it is the only reading the chip ever shows. The weekly / Opus wall is one click away
  // in the popover. Falls back to the tightest window only when there is no 5h window at all.
  const headline = pickHeadline(quota!.windows)
  const remaining = clampPct(100 - headline.usedPercent)

  return (
    <>
      <Popover
        onOpenChange={(open) => {
          // Opening re-reads the server's warm cache; the refresh button below is the live recheck.
          if (open) onRecheck(false)
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`${providerLabel} quota: ${remaining}% remaining`}
            className="flex items-center gap-1.5 min-w-0 rounded outline-none transition-opacity hover:opacity-80 focus-visible:ring-1 focus-visible:ring-border-strong"
          >
            {/* The mark carries an ICON's size and weight; only the number is small. */}
            <QuotaMark provider={backend} className={PROVIDER_MARK_AS_ICON[backend]} />
            {/* "left" says which way the number runs: a bare "72%" beside a model mark read as usage
                (or even as a context-window fill), when it is the quota REMAINING. Same word as the
                popover's rows, so the chip and its breakdown speak one vocabulary. The word takes the
                number's tone so an amber/red chip warns as one unit. */}
            <span className={`tabular-nums ${toneText(remaining)}`}>{remaining}% left</span>
          </button>
        </PopoverTrigger>
        {/* Drops DOWN from the row, which sits at the top of the sidebar column. */}
        <PopoverContent side="bottom" align="start" onOpenAutoFocus={(event) => event.preventDefault()} className="w-[min(15rem,calc(100vw-1.5rem))] p-3 text-[11px] leading-relaxed text-fg">
          {/* The IDENTITY block: who this provider is, which plan, and which account — one unit, held
              together by its own tight internal leading and separated from the numbers below by mb-2.
              Measured cap-band gaps: 10.9px inside the block vs 18.9px to the first window row, so the
              email reads as part of the header rather than as a homeless row between two blocks. At the
              original mt-0.5/mb-1.5 those gaps were 12.9 and 16.9 — too close to call either way. */}
          <div className="mb-2">
            <div className="flex items-center gap-1.5 font-medium">
              <QuotaMark provider={backend} />
              <span>{providerLabel}</span>
              {quota?.planType && <span className="text-muted-70">· {cap(quota.planType)} plan</span>}
              {/* THE MANUAL REFRESH: a true server-side cache bypass, which for Claude reaches past the
                  usage endpoint's rate-limit window through the CLI. The mark spins while ANY read is in
                  flight, so it doubles as the old loading spinner. `-my-1` keeps the 20px hover square
                  from growing the 11px header line. */}
              <button
                type="button"
                aria-label={`Refresh ${providerLabel} quota`}
                aria-busy={fetching}
                title="Refresh"
                onClick={() => onRecheck(true)}
                className="-my-1 -mr-1 ml-auto flex size-5 shrink-0 items-center justify-center rounded text-muted-60 outline-none transition-colors hover:bg-elevated hover:text-fg focus-visible:ring-1 focus-visible:ring-border-strong"
              >
                <RotateCw size={11} className={fetching ? "animate-spin" : undefined} />
              </button>
            </div>
            {/* WHICH account this is. Sits above the window breakdown because it is an AUTH fact, not a
                quota one — "am I on the right account?" is asked while reading the numbers, not after.
                Tone matches the
                plan label beside it (both are identity metadata, so the block reads as one). Selectable
                and title-carrying, so a long address stays copyable past the 15rem truncation. */}
            {email && (
              <div data-quota-account className="truncate text-muted-70 select-text" title={email}>
                {email}
              </div>
            )}
          </div>
          {/* No signed-out or unavailable branch: this popover only exists on a chip that HAS a
              reading, and a chip without one no longer renders. */}
          <ul className="flex flex-col gap-1">
            {quota!.windows.map((w, i) => {
              const left = clampPct(100 - w.usedPercent)
              const reset = resetText(w)
              // A second budget on the same account (Antigravity's Claude and GPT models) gets its name
              // over its own rows, so each row keeps the bare "5h" / "Weekly" the first budget reads in.
              const group = w.group && w.group !== quota!.windows[i - 1]?.group ? w.group : undefined
              return (
                <Fragment key={w.key}>
                  {group && <li className="pt-1.5 text-muted-55">{group}</li>}
                  <li className="flex items-center justify-between gap-3">
                    <span className="text-muted-80">{w.label}</span>
                    <span className="flex items-center gap-2 tabular-nums">
                      <span className={toneText(left)}>{left}% left</span>
                      {reset && <span className="text-muted-55">resets {reset}</span>}
                    </span>
                  </li>
                </Fragment>
              )
            })}
            {quota!.detail && <li className="pt-1 text-muted-55">{quota!.detail}</li>}
          </ul>
          {visibility && <ChipVisibility {...visibility} />}
        </PopoverContent>
      </Popover>
    </>
  )
}

/**
 * THE PHONE'S QUOTA READING — every window of every provider that has one, as a labelled meter.
 *
 * The phone has no status row to hang the chips on, and no hover to open their popover, so its Settings
 * page leads with the whole breakdown instead (phone design 2026-09-30, § 6): one row per backend
 * window, a bar and a number. The number is REMAINING quota, like the chip's — a phone that read 38%
 * where the desktop chip reads 62% for the same window would be two answers to one question — and the
 * bar fills with what is left. Same query keys and the same no-reading rule as the chips, so it renders
 * nothing for a provider the chips would hide, and one fetch serves both.
 *
 * The tone spends colour only where the chip does, minus the amber: on a phone screen the accent is the
 * ask colour and nothing else, so a low window reads in the foreground and only a nearly empty one in
 * the danger colour.
 */
export function QuotaMeters() {
  const quota = useQuery({
    queryKey: ["quota"],
    queryFn: ({ signal }) => rpc.quota(undefined, { signal: deadline(POLL_TIMEOUT_MS, signal) }),
    refetchInterval: 30_000,
    staleTime: 10_000,
  })
  const auth = useQuery({
    queryKey: ["authStatus"],
    queryFn: ({ signal }) => rpc.authStatus(undefined, { signal: deadline(POLL_TIMEOUT_MS, signal) }),
    staleTime: 30_000,
  })
  const rows = QUOTA_PROVIDERS.flatMap((backend) => {
    const q = quotaOf(quota.data, backend)
    if (!hasReading(q, authOf(auth.data, backend), quota.isLoading)) return []
    return q!.windows.map((w) => ({ key: `${backend}-${w.key}`, label: `${QUOTA_LABEL[backend]} · ${w.group ? `${w.group} ` : ""}${w.label}`, left: clampPct(100 - w.usedPercent) }))
  })
  if (rows.length === 0) return null
  return (
    <ul data-quota-meters className="m-0 flex list-none flex-col gap-[9px] p-0">
      {rows.map((row) => (
        <li key={row.key} className="flex items-center gap-2.5 text-[13.5px] leading-[19px]">
          <span className="w-[108px] shrink-0 truncate text-muted">{row.label}</span>
          <span className="h-[5px] min-w-0 flex-1 overflow-hidden rounded-full bg-border" aria-hidden>
            <span className={`block h-full rounded-full ${row.left <= 8 ? "bg-danger" : "bg-fg/75"}`} style={{ width: `${row.left}%` }} />
          </span>
          <span className={`w-[64px] shrink-0 text-right tabular-nums ${row.left <= 8 ? "text-danger" : "text-fg"}`}>{row.left}% left</span>
        </li>
      ))}
    </ul>
  )
}

function clampPct(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)))
}

// The remaining % at/below which a window is no longer "a good amount of quota" — it enters the warn
// zone, where the tone drops the calm neutral for the amber alarm.
const HEALTHY_MIN = 25

// Which window's number leads the chip: ALWAYS the 5-hour one — the immediate runway, the number that
// matters day-to-day. The chip is a FIXED-MEANING readout, not a "whichever limit is tightest" indicator:
// it used to swap to the weekly / Opus wall once anything dropped into the warn zone, which made the same
// glyph mean different things at different times — you had to open the popover just to learn which window
// the number described. The other windows are still in that popover, one click away. The tightest-window
// fallback survives only for a provider that reports no 5h window at all.
function pickHeadline(windows: QuotaWindow[]): QuotaWindow {
  return windows.find((w) => w.key === "5h") ?? windows.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a))
}

// Severity by REMAINING: healthy (neutral light gray — no alarm), low (amber), critical (red). Color is
// spent only on states that want attention; a healthy quota is just information, so it reads as a calm
// neutral light gray rather than any hue (green, in any shade, fought the muted dark palette).
function toneText(remaining: number): string {
  if (remaining <= 8) return "text-danger"
  if (remaining <= HEALTHY_MIN) return "text-accent"
  return "text-fg/70"
}

function cap(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s
}

// A short reset label from a unix-seconds instant: "3:40pm" if within a day, else a weekday ("Thu").
// A reset in the PAST (stale data past its rollover) is suppressed rather than shown as a misleading
// already-elapsed clock time.
function resetText(w: QuotaWindow): string | null {
  if (!w.resetsAt) return null
  const ms = w.resetsAt * 1000
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return null
  const delta = ms - Date.now()
  if (delta <= 0) return null
  const withinDay = delta < 24 * 3600_000
  if (withinDay) {
    let h = d.getHours()
    const m = d.getMinutes()
    const ap = h >= 12 ? "pm" : "am"
    h = h % 12 || 12
    return m === 0 ? `${h}${ap}` : `${h}:${String(m).padStart(2, "0")}${ap}`
  }
  return d.toLocaleDateString(undefined, { weekday: "short" })
}
