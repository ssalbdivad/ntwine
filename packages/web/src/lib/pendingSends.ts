// ── follow-ups that were still on the wire when the page went away ───────────────────────────────
// A reply is optimistic: the composer clears and the bubble paints before the request settles (see
// eagerComposerSubmission.ts). A FAILED send hands its text back to the draft, and drafts persist to
// sessionStorage, so that half survives a reload. An IN-FLIGHT one did not: a reload aborts the fetch,
// the bubble is client-only, and the draft was already cleared — so the text was simply gone, with
// nothing on screen to say so. Hit 2026-09-24: a reply sent into a dev-supervisor restart window, then
// a hard reload, and the thread came back as if nothing had been typed.
//
// So every send is recorded here for exactly as long as it is in flight, and the next page load in
// this tab replays whatever is left under its ORIGINAL deliveryId. That id is what makes the replay
// safe: the server records every delivered id on the session row (delivery-ledger.ts `hasDelivery`)
// and answers a repeat with a no-op, so a send that actually landed before the reload is not pasted
// twice. Session-scoped for the same reason drafts are — it never escapes the tab that typed it.
export const PENDING_SENDS_STORAGE_KEY = "frizz-pending-sends:v1"
// Past this a replay would land as a surprise rather than a continuation of what the operator was
// doing, so an older entry goes back into the composer instead of onto the wire.
export const PENDING_SEND_MAX_AGE_MS = 15 * 60_000

export type PendingSend = {
  deliveryId: string
  /** The `/_frizz/<project>` API base the send went to — the All queues page sends across projects. */
  apiBase: string
  /** For the draft key a send that cannot be replayed is restored under. */
  projectDir?: string
  slug: string
  sessionId: string
  message: string
  freshProcess?: boolean
  interrupt?: boolean
  at: number
}

function isPendingSend(value: unknown): value is PendingSend {
  const v = value as Partial<PendingSend> | null
  return !!v && typeof v.deliveryId === "string" && typeof v.apiBase === "string" && typeof v.slug === "string" &&
    typeof v.sessionId === "string" && typeof v.message === "string" && typeof v.at === "number" && Number.isFinite(v.at)
}

export class PendingSendStore {
  private readonly storage: Pick<Storage, "getItem" | "setItem"> | undefined
  constructor(storage: Pick<Storage, "getItem" | "setItem"> | undefined = typeof sessionStorage === "undefined" ? undefined : sessionStorage) {
    this.storage = storage
  }
  list(): PendingSend[] {
    try {
      const parsed: unknown = JSON.parse(this.storage?.getItem(PENDING_SENDS_STORAGE_KEY) ?? "[]")
      return Array.isArray(parsed) ? parsed.filter(isPendingSend) : []
    } catch { return [] }
  }
  add(send: PendingSend): void { this.write([...this.list().filter((s) => s.deliveryId !== send.deliveryId), send]) }
  remove(deliveryId: string): void {
    const sends = this.list()
    if (sends.some((s) => s.deliveryId === deliveryId)) this.write(sends.filter((s) => s.deliveryId !== deliveryId))
  }
  private write(sends: PendingSend[]): void {
    try { this.storage?.setItem(PENDING_SENDS_STORAGE_KEY, JSON.stringify(sends)) } catch {}
  }
}

export const pendingSends = new PendingSendStore()

// A reload aborts every fetch still open, and Chrome can deliver that rejection to the DYING page
// before it is torn down. Handled like any failure, it deleted the entry above and put the text back
// in the draft — for a send the server may well have delivered, so the replay never ran and the
// reloaded composer showed a message that had already gone. Measured in a real browser 2026-09-24.
// While the page is going away a failure proves nothing, so the failure paths leave everything alone
// and the next page's replay decides. `beforeunload` can be cancelled by another listener, hence the
// reset: a page still alive seconds later did not navigate.
let unloading = false
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("beforeunload", () => {
    unloading = true
    setTimeout(() => { unloading = false }, 3_000)
  })
  window.addEventListener("pagehide", () => { unloading = true })
  window.addEventListener("pageshow", () => { unloading = false })
}
export function pageUnloading(): boolean { return unloading }
