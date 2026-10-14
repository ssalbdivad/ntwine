import { useCallback, useEffect, useRef, useState } from "react"
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { MACHINE_SETTING_KEYS, type Settings } from "@ntwine/shared"
import { isRetryableRpcError, rpc } from "../api/rpc.ts"

// Every settings control WRITES AS YOU TOUCH IT — there is no Save button and no Cancel. A picker or a
// toggle persists on the click; a textarea persists this long after the last keystroke, so a long
// prompt is one write instead of one per character.
const SAVE_DEBOUNCE_MS = 500
// How long "Saved" lingers before the status goes quiet again.
const SAVED_LINGER_MS = 1600
// A REPLAYABLE failure — a mutation refused because Ntwine is mid-update — is worth waiting out rather
// than reporting. A promotion takes a few seconds; six tries covers it without becoming a poller.
const RETRY_DELAY_MS = 2000
const MAX_RETRIES = 6

export type SaveState = "idle" | "saving" | "saved" | "error"

// The mutation key every settings write carries. A surface that dispatches a worker off the settings
// (the new-thread composer, the GitHub picker) gates on `useIsMutating({ mutationKey: SETTINGS_WRITE_KEY })`
// so a save still in flight — a compaction window picked a moment ago, a prompt edit flushed by closing
// its popover — lands before the dispatch that would read it.
export const SETTINGS_WRITE_KEY = ["settingsSet"] as const

/**
 * A save's MACHINE settings, published to every project's cached `settingsGet` — not only the entry of
 * the project the save was made under.
 *
 * The cache keeps one `settingsGet` entry per project (lib/queryKeyScope.ts folds the page's project
 * into every hash but the machine-wide keys'), and that is right for the query as a whole: most of
 * `Settings` is a project's own, so it cannot join MACHINE_WIDE. But `notifications`, `localFileOpener`,
 * `fableFallback` and the rest of MACHINE_SETTING_KEYS are one value for the machine, and a reader that
 * is still bound to another project's entry has to see the new one too: a hook in the layout, which a
 * project switch on the one page does not re-render, stays on the entry it was cold-loaded under (the
 * opt-in project rail read one that way and missed a flip until a reload, 2026-09-28).
 *
 * Only the machine keys are written across, and nothing is refetched: a refetch runs under the CURRENT
 * page's project, so it would pour this project's own settings into every other project's entry.
 */
export function publishMachineSettings(queryClient: QueryClient, saved: Settings): void {
  const machine = Object.fromEntries(MACHINE_SETTING_KEYS.map((key) => [key, saved[key]])) as Partial<Settings>
  // On each Query itself, not through `setQueriesData`: that re-derives every match's HASH from its key,
  // and the hash is the CURRENT page's scope — so it wrote the one entry already written, N times.
  for (const query of queryClient.getQueryCache().findAll({ queryKey: ["settingsGet"] })) {
    const cached = query.state.data as Settings | undefined
    if (cached) query.setData({ ...cached, ...machine }, { manual: true })
  }
}

/**
 * Publish a write this surface made, and return the cache's copy of it exactly as a `useQuery` on
 * `settingsGet` will read it back. The cache stores its own structurally-shared copy, not `saved`, so
 * that copy is the identity a draft compares against to know the move was its own (ownPublish below).
 */
export function publishOwnSettings(queryClient: QueryClient, saved: Settings): Settings | undefined {
  // The server's validated copy, rather than racing queued writes with a refetch.
  queryClient.setQueryData(["settingsGet"], saved)
  publishMachineSettings(queryClient, saved)
  return queryClient.getQueryData<Settings>(["settingsGet"])
}

/**
 * A MACHINE setting another surface changed while a draft was open, adopted into that draft.
 *
 * A draft is seeded once and its every write carries the WHOLE object, so a value written elsewhere
 * meanwhile — the editor offer's "Use VS Code" toast (lib/editorBridge.ts), the project rail's toggle —
 * was put back by the draft's next save of anything at all: the toast said "Code files open in VS
 * Code", and the next toggle in the open Settings drawer wrote System back (review C6). Every such write
 * is published into the cache (publishMachineSettings), so `before` → `after` is the change the drawer
 * can see. A key is adopted only where it changed there AND the draft still holds the `before` value —
 * one the human has edited here is theirs, and their own save is the next thing the cache will say.
 * Only the machine keys: a project's own keys change in the cache when the PAGE's project does, and
 * pouring another project's values into a draft open on this one is not an adoption. Returns `draft`
 * itself when nothing is adopted, so a caller's state update is a no-op.
 *
 * `own` is this surface's last publish (publishOwnSettings). A move to it is this draft's own write
 * landing, never another surface's: adopting it put back a value the human had already changed again —
 * toggle on, toggle off before the first write lands, and the first write's landing turned it back on.
 */
export function adoptPublishedSettings(draft: Settings, before: Settings, after: Settings, own?: Settings): Settings {
  if (own !== undefined && after === own) return draft
  let adopted: Settings | null = null
  for (const key of MACHINE_SETTING_KEYS) {
    // Every machine key is a scalar, so `===` is the comparison.
    if (after[key] === before[key] || draft[key] !== before[key]) continue
    adopted = { ...(adopted ?? draft), [key]: after[key] }
  }
  return adopted ?? draft
}

// The write side of every settings surface — the drawer and the in-context popovers alike. Three
// invariants, all silent when broken:
//
//  - WRITES ARE SERIALIZED. Every payload is a WHOLE Settings object, so two overlapping requests that
//    land out of order leave the server holding the older snapshot. Chaining each write onto the
//    previous one's settled promise makes the last thing touched the last thing stored.
//  - A PENDING DEBOUNCE IS FLUSHED ON UNMOUNT. Otherwise the last half-second of typing dies with the
//    surface — precisely the keystrokes the Save button used to capture.
//  - A RETRYABLE FAILURE IS RETRIED. Removing the Save button also removed the operator's way to try
//    again, so the one failure the RPC layer certifies as side-effect-free — `isRetryableRpcError`,
//    which the composer already leans on during a control-plane restart — has to be replayed here.
//    Anything else is AMBIGUOUS (it may have landed) and must be reported, never re-sent.
//
// And one more, for a surface that re-reads the server while it is open (useSettingsDraft's refresh):
// a write HELD behind that read (`holdFor`) leaves `pending` in place until the read lands, so the
// snapshot it sends has adopted whatever the read brought in, rather than racing it.
export function useSettingsAutosave() {
  const [state, setState] = useState<SaveState>("idle")
  const pending = useRef<Settings | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const chain = useRef<Promise<unknown>>(Promise.resolve())
  const inflight = useRef(0)
  const linger = useRef<number | undefined>(undefined)
  const retries = useRef(0)
  // `flush` schedules its own retry, so it needs a handle to itself that doesn't make the callback
  // depend on its own identity. Assigned immediately below.
  const flushRef = useRef<() => void>(() => {})
  // A react-query mutation rather than a bare RPC so the write is visible to `useIsMutating` — and it
  // stays in the mutation cache after this surface unmounts, so a flush-on-close is still counted.
  const write = useMutation({ mutationKey: [...SETTINGS_WRITE_KEY], mutationFn: (next: Settings) => rpc.settingsSet(next) })
  const writeRef = useRef(write)
  writeRef.current = write
  const queryClient = useQueryClient()
  // The cache's copy of this surface's last landed write: a move to it is this surface's own.
  const ownPublish = useRef<Settings | undefined>(undefined)
  // A read of the server in flight that every write waits behind (holdFor).
  const gate = useRef<Promise<unknown> | null>(null)

  // `force` is the unmount's: nothing will be left to send a held write once the surface is gone, and a
  // write that might carry one stale key beats losing the human's last change outright.
  const flush = useCallback((force = false) => {
    if (timer.current !== undefined) window.clearTimeout(timer.current)
    timer.current = undefined
    if (gate.current && !force) return
    const next = pending.current
    if (!next) return
    pending.current = null
    inflight.current += 1
    setState("saving")
    chain.current = chain.current
      .then(() => writeRef.current.mutateAsync(next))
      .then((saved) => {
        ownPublish.current = publishOwnSettings(queryClient, saved)
        inflight.current -= 1
        retries.current = 0
        if (inflight.current > 0 || pending.current) return
        setState("saved")
        if (linger.current !== undefined) window.clearTimeout(linger.current)
        linger.current = window.setTimeout(() => setState("idle"), SAVED_LINGER_MS)
      })
      .catch((error: unknown) => {
        inflight.current -= 1
        setState("error")
        // A newer value is already queued behind this one — it supersedes this payload entirely, so
        // replaying the stale one would undo the newer edit.
        if (pending.current || !isRetryableRpcError(error) || retries.current >= MAX_RETRIES) return
        retries.current += 1
        pending.current = next
        timer.current = window.setTimeout(flushRef.current, RETRY_DELAY_MS)
      })
  }, [])
  flushRef.current = flush

  const queue = useCallback(
    (next: Settings, debounce = false) => {
      pending.current = next
      retries.current = 0
      if (timer.current !== undefined) window.clearTimeout(timer.current)
      timer.current = undefined
      if (!debounce) return flush()
      timer.current = window.setTimeout(flush, SAVE_DEBOUNCE_MS)
    },
    [flush],
  )

  // A write still waiting — debounced, or queued for a retry — is a whole snapshot taken before the
  // cache moved, and would put the old value back as surely as the draft would (adoptPublishedSettings).
  const adopt = useCallback((before: Settings, after: Settings) => {
    if (pending.current) pending.current = adoptPublishedSettings(pending.current, before, after, ownPublish.current)
  }, [])

  // Hold every write until `read` settles; `read` must have adopted what it brought into `pending` (adopt)
  // by then. A debounce still running when it settles is left to fire on its own.
  const holdFor = useCallback(
    (read: Promise<unknown>) => {
      gate.current = read
      const release = () => {
        if (gate.current !== read) return
        gate.current = null
        if (pending.current && timer.current === undefined) flush()
      }
      read.then(release, release)
    },
    [flush],
  )

  useEffect(
    () => () => {
      flush(true)
      if (linger.current !== undefined) window.clearTimeout(linger.current)
    },
    [flush],
  )

  return { state, queue, flush, adopt, ownPublish, holdFor }
}

// A settings surface's whole read/write loop: the server's copy seeds a local draft ONCE, and every
// change renders first and persists second through the autosave above. The draft is never re-seeded
// wholesale: every save publishes the stored value straight into the query cache, so a later fetch can
// only agree with what is here — except for a machine setting another surface wrote meanwhile, which
// is adopted key by key (adoptPublishedSettings). `debounce` is for the free-text fields alone — a
// picker or a toggle is a single discrete intent and writes on the spot.
//
// A surface left OPEN re-reads the server whenever it comes back into use — the window takes focus, or
// the page becomes visible again — and holds its writes until that read lands. No socket carries
// settings, so nothing else tells an open draft that another surface wrote meanwhile, and its next save
// of anything put the old value back: a sidebar's Settings, open beside the browser for hours, undid
// an Off set in the browser (Remove worktrees when done, a setting since removed) the moment Notifications was toggled in the sidebar (and
// two browser tabs did the same). Focus arrives on the pointer-DOWN that clicks into the frame, a hair
// before the click it carries, so the read alone loses that race (a scripted click into the sidebar,
// down and up in one tick, lost it 3 runs of 3, while the drawer went on to SHOW the adopted Off); the
// hold is what makes the click's write wait for it.
export function useSettingsDraft() {
  const settings = useQuery({ queryKey: ["settingsGet"], queryFn: () => rpc.settingsGet() })
  const [draft, setDraft] = useState<Settings | null>(() => settings.data ?? null)
  const { state, queue, flush, adopt, ownPublish, holdFor } = useSettingsAutosave()
  const queryClient = useQueryClient()
  const refetch = useRef(settings.refetch)
  refetch.current = settings.refetch

  useEffect(() => {
    if (settings.data && !draft) setDraft(settings.data)
  }, [settings.data, draft])

  const seen = useRef(settings.data)
  useEffect(() => {
    const before = seen.current
    const after = settings.data
    seen.current = after
    if (!before || !after || before === after) return
    const own = ownPublish.current
    setDraft((current) => current && adoptPublishedSettings(current, before, after, own))
    adopt(before, after)
  }, [settings.data, adopt, ownPublish])

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== "visible") return
      const before = queryClient.getQueryData<Settings>(["settingsGet"])
      // `cancelRefetch: false` joins a read already in flight (the mount's own) instead of restarting it.
      const read = refetch.current({ cancelRefetch: false }).then(({ data: after }) => {
        // Adopted HERE, not left to the effect above: that runs only once React has rendered the new
        // data, after this promise settles and releases the held write. Adopting twice is a no-op.
        if (!before || !after || before === after) return
        const own = ownPublish.current
        setDraft((current) => current && adoptPublishedSettings(current, before, after, own))
        adopt(before, after)
      })
      holdFor(read)
    }
    refresh()
    window.addEventListener("focus", refresh)
    document.addEventListener("visibilitychange", refresh)
    return () => {
      window.removeEventListener("focus", refresh)
      document.removeEventListener("visibilitychange", refresh)
    }
  }, [queryClient, adopt, ownPublish, holdFor])

  const update = useCallback(
    (next: Settings, opts?: { debounce?: boolean }) => {
      setDraft(next)
      queue(next, opts?.debounce)
    },
    [queue],
  )

  return { draft, update, saveState: state, flush }
}

// The whole account of persistence, now that no button carries it. Quiet by design: the form writes
// itself, so the only states worth a word are the write in flight, the moment it lands, and the one
// that matters — a write that did NOT land, in the accent that means "this wants you".
export function SaveStatus({ state }: { state: SaveState }) {
  if (state === "idle") return null
  if (state === "error") return <span className="text-[11px] font-normal text-accent">Couldn't save</span>
  return (
    <span className={`text-[11px] font-normal ${state === "saved" ? "text-muted-70" : "text-muted"}`}>
      {state === "saving" ? "Saving…" : "Saved"}
    </span>
  )
}
