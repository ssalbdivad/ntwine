import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react"
import { useSnapshot } from "valtio"
import { AlarmClock, AlarmClockOff, Loader2 } from "lucide-react"
import { SNOOZE_PROMPT_MAX, type ThreadView } from "@ntwine/shared"
import { useThreadApi } from "../api/threadApi.tsx"
import { futureSnoozedUntil } from "../groups.ts"
import {
  DEFAULT_SNOOZE_PRESET,
  SNOOZE_PRESETS,
  formatSnoozeConfirmation,
  formatSnoozeWake,
  localDateTimeInputValue,
  parseLocalSnooze,
  snoozePresetInstant,
} from "../lib/snooze.ts"
import { HEADER_ICON_CLASS } from "../lib/headerIcon.ts"
import { showToast, store } from "../store.ts"
import { shouldSubmitStagedEnter } from "../lib/composerKeyboard.ts"
import { useCommandHandler, useShortcutLabel, withShortcut } from "../lib/keyboardRuntime.ts"
import { Dialog } from "./ui/Dialog.tsx"
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "./ui/Menu.tsx"
import { TextareaCodeFences } from "./TextareaCodeFences.tsx"
import { Tooltip } from "./Tooltip.tsx"

// THE SNOOZE VERB: an alarm clock in the thread header's action strip whose click opens every preset.
//
// It was a split button in the lifecycle footer until 2026-10-05 — "Snooze 1d" plus a chevron — whose
// one-click half relabelled itself to whatever was picked last (`prefs.snoozePreset`), so the same
// click parked a thread for a different span depending on what you did on some other card yesterday
// (maintainer: "I don't really like the fact that the snooze duration right now is sticky and it just
// gets stuck to the most recently selected value"). The menu has no default to drift: every click
// lists every preset, each with the moment it would bring the thread back. The phone keeps its own
// "Snooze length" setting for its swipe, which this control no longer reads or writes.
//
// The clock is AMBER while a snooze is armed — the goal mark's "something is set" tone — so the verb is
// also the presence marker the footer's grey alarm glyph used to be: a thread opened with a bump armed
// for Friday says so in its header, and the menu then leads with when it wakes and Wake now.
//
// The fork's additions ride along from the split button they lived on: the `s` shortcut opens this
// menu, a snooze toasts where the thread went with an Undo, a cross-project card names its own project
// and calls through its own project's API (useThreadApi), and a parent waiting on its sub-agents offers
// EVENT snoozes above the wall-clock presets (`eventItems`).
export function SnoozeMenu({
  thread,
  projectName,
  onSnoozed,
  onUndone,
  eventItems,
}: {
  thread: ThreadView
  /** The project the thread waits under once snoozed, named in the toast. Defaults to the page's — the
   *  drawer's own project; a card of another project's queue names its own. */
  projectName?: string
  onSnoozed?: () => void
  /** The toast's Undo put the snooze back as it was: give back whatever `onSnoozed` took away. */
  onUndone?: () => void
  /** EVENT snoozes the surface can offer, above the wall-clock presets — a snooze whose wake is something
   *  the thread does rather than an instant. The queue card of a parent waiting on its sub-agents passes
   *  its two (AwaitingSubAgentsCard SubAgentWaitSnoozeItems), each ending in its own separator. */
  eventItems?: ReactNode
}) {
  const api = useThreadApi()
  // The board's NAME, read whether or not the caller named the project: a board read but not dereferenced
  // (the queue card passes `projectName`, so `board?.projectName` never ran) is tracked by valtio as used
  // WHOLE, and every board delta re-rendered every queue card's snooze menu — the last of a card's
  // subscriptions to the board (2026-10-02, queueCardVisibility.e2e.test.ts "a board delta re-renders no
  // card").
  const boardName = useSnapshot(store).board?.projectName
  const where = projectName ?? boardName
  const [open, setOpen] = useState(false)
  // Closing the menu hands focus back to the clock, and the tooltip opens on focus — where it then takes
  // the next Escape for itself, so on /full one Escape closed the menu and the second only closed a
  // tooltip nobody asked for, instead of leaving fullscreen. It stays quiet until focus or the pointer
  // leaves the clock; focus itself still returns, which is the menu's keyboard contract.
  const [tooltipQuiet, setTooltipQuiet] = useState(false)
  const [busy, setBusy] = useState(false)
  const [customOpen, setCustomOpen] = useState(false)
  const [customValue, setCustomValue] = useState("")
  const [promptValue, setPromptValue] = useState("")
  const [customError, setCustomError] = useState("")
  const customInputId = useId()
  const promptInputId = useId()
  const customFormId = useId()
  const snoozedUntil = futureSnoozedUntil(thread)
  const prompt = thread.snoozePrompt?.trim()
  const minCustom = useMemo(() => localDateTimeInputValue(new Date(Date.now() + 60_000)), [customOpen])
  // Recomputed when the menu opens, so each row's wake time is read off the clock at the moment it is
  // offered rather than when the header first rendered.
  const rows = useMemo(() => SNOOZE_PRESETS.map((preset) => {
    const wake = formatSnoozeWake(snoozePresetInstant(preset.value))
    return preset.value === "tomorrow"
      ? { value: preset.value, label: "Tomorrow", wake: wake.replace(/^Tomorrow at /, "") }
      : { value: preset.value, label: preset.label, wake }
  }), [open])
  // Two shapes: a plain park only re-surfaces the card, while an armed one resumes the agent with that
  // text — so naming the follow-up IS the detail.
  const state = snoozedUntil ? (prompt ? `Bumps ${formatSnoozeWake(snoozedUntil)}` : `Snoozed until ${formatSnoozeWake(snoozedUntil)}`) : null
  const snoozeKeys = useShortcutLabel("thread.snooze")
  const label = state ? (prompt ? `${state}\n${prompt}` : state) : withShortcut("Snooze", snoozeKeys)
  // THE `s` SHORTCUT OPENS THIS MENU (lib/keyboardRuntime.ts): how long to put a thread off is a choice,
  // and Superhuman's H and Linear's H, the snooze keys this one replaced, both open a picker too. A Radix
  // trigger opens on pointer-down and keys, not on the synthetic click a command press sends, so the
  // command is claimed here instead. ↑/↓ or a preset's first character picks one, and a second `s`
  // matches no item, so a double tap is harmless.
  const triggerRef = useRef<HTMLButtonElement>(null)
  const openedByKey = useRef(false)
  useCommandHandler(triggerRef, () => {
    if (busy) return
    openedByKey.current = true
    setOpen(true)
  })
  useEffect(() => {
    if (!open || !openedByKey.current) return
    openedByKey.current = false
    // One frame: Radix mounts the content on open; this puts focus on the first actionable row, so `s`
    // then Enter acts without a pointer. Only one menu can be open when a plain key fires (the runtime
    // ignores them while any menu is up), so the lookup cannot land in another card's menu.
    const frame = requestAnimationFrame(() => {
      document.querySelector<HTMLElement>('[role="menu"] [role="menuitem"]')?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [open])

  // `bump` is what upgrades a park into a scheduled BUMP: the server arms a durable wake that resumes
  // this thread with exactly that text at `until`. null keeps the historical reminder behavior.
  async function apply(until: string | null, bump: string | null = null): Promise<void> {
    // What this click replaces, for the toast's Undo: a thread that was already snoozed goes back to its
    // old deadline and follow-up, not to awake.
    const previous = { until: snoozedUntil ?? null, prompt: snoozedUntil ? thread.snoozePrompt ?? null : null }
    const sessionId = thread.sessionId ?? ""
    setBusy(true)
    try {
      await api.setThreadSnooze({ slug: thread.id, sessionId, until, prompt: until ? bump : null })
      if (until) {
        // UNDO, because a snooze takes the card off the page: the accident is cheap to make and was
        // expensive to find. It runs after this menu may be gone — the card fades out on `onSnoozed` —
        // so it touches no state of the menu's own.
        const undo = async () => {
          try {
            // A deadline that passed while the toast was up has nothing left to restore.
            const restore = previous.until !== null && Date.parse(previous.until) > Date.now() ? previous : { until: null, prompt: null }
            await api.setThreadSnooze({ slug: thread.id, sessionId, ...restore })
            showToast(restore.until ? "Snooze restored" : "Snooze undone")
            onUndone?.()
          } catch (error) {
            showToast((error instanceof Error ? error.message : "Undo failed").slice(0, 100))
          }
        }
        const { text, detail } = formatSnoozeConfirmation(until, bump, where)
        showToast(text, { detail, action: { label: "Undo", run: () => void undo() } })
        onSnoozed?.()
      } else {
        showToast("Snooze cleared")
      }
      setCustomOpen(false)
      setCustomError("")
    } catch (error) {
      const message = error instanceof Error ? error.message : "Snooze failed"
      showToast(message.slice(0, 100))
      setCustomError(message)
    } finally {
      setBusy(false)
    }
  }

  // An existing snooze re-opens as itself so editing the follow-up never silently moves the deadline;
  // otherwise the dialog starts a day out.
  function openCustom() {
    setCustomValue(localDateTimeInputValue(new Date(snoozedUntil ?? snoozePresetInstant(DEFAULT_SNOOZE_PRESET))))
    setPromptValue(thread.snoozePrompt ?? "")
    setCustomError("")
    setCustomOpen(true)
  }

  function submitCustom() {
    const parsed = parseLocalSnooze(customValue)
    if (!parsed.ok) {
      setCustomError(parsed.message)
      return
    }
    const bump = promptValue.trim()
    if (bump.length > SNOOZE_PROMPT_MAX) {
      setCustomError(`Prompt is too long (${bump.length}/${SNOOZE_PROMPT_MAX})`)
      return
    }
    void apply(parsed.until, bump || null)
  }

  return (
    <>
      <Menu
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) setTooltipQuiet(true)
        }}
      >
        {/* The tooltip stands down while the menu is open: the menu's own first line already says it. */}
        <Tooltip label={label} multiline={Boolean(prompt)} disabled={open || tooltipQuiet}>
          <MenuTrigger asChild>
            <button
              ref={triggerRef}
              type="button"
              disabled={busy}
              data-command="snooze"
              data-snooze-menu
              data-snoozed={snoozedUntil ? "true" : "false"}
              aria-label={state ?? "Snooze"}
              // The armed follow-up is the tooltip's second line; a screen reader hears it here, since the
              // name stays the short state that the menu's own first line repeats.
              aria-description={snoozedUntil && prompt ? prompt : undefined}
              // Focus must not leave the composer: same discipline as every other header verb.
              onMouseDown={(event) => event.preventDefault()}
              onBlur={() => setTooltipQuiet(false)}
              onPointerLeave={() => setTooltipQuiet(false)}
              className={`${snoozedUntil ? HEADER_ICON_CLASS.replace(/(^| )text-muted( |$)/, "$1text-attention-90$2") : HEADER_ICON_CLASS} ${open ? "bg-panel-2" : ""}`}
            >
              {busy ? <Loader2 size={14} strokeWidth={2} className="animate-spin" /> : <AlarmClock size={14} strokeWidth={2} />}
            </button>
          </MenuTrigger>
        </Tooltip>
        <MenuContent align="end">
          <div className="px-2.5 pb-1 pt-1.5 text-[11px] text-muted-60">{state ?? "Snooze"}</div>
          {snoozedUntil && (
            <>
              <MenuItem onSelect={() => void apply(null)} icon={<AlarmClockOff size={12} />}>Wake now</MenuItem>
              <MenuSeparator />
            </>
          )}
          {eventItems}
          {rows.map((row) => (
            <MenuItem key={row.value} value={row.value} onSelect={() => void apply(snoozePresetInstant(row.value))} icon={<AlarmClock size={12} />}>
              <span data-snooze-preset={row.value} className="flex min-w-0 flex-1 items-center justify-between gap-6">
                <span>{row.label}</span>
                <span className="text-[10.5px] text-muted-55">{row.wake}</span>
              </span>
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem onSelect={openCustom}>Custom time &amp; prompt…</MenuItem>
        </MenuContent>
      </Menu>

      <Dialog
        open={customOpen}
        onOpenChange={(next) => {
          if (!busy) setCustomOpen(next)
        }}
        title="Snooze thread"
        className="w-[360px] max-w-[92vw]"
        footer={
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => setCustomOpen(false)}
              className="button-outline rounded-md px-3 py-1.5 text-[12px] text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg disabled:opacity-45"
            >
              Cancel
            </button>
            <button
              type="submit"
              form={customFormId}
              disabled={busy}
              className="button-outline flex items-center gap-1.5 rounded-md bg-fg px-3 py-1.5 text-[12px] font-medium text-bg outline-none transition-opacity hover:opacity-90 disabled:opacity-45"
            >
              {busy && <Loader2 size={12} className="animate-spin" />}
              {promptValue.trim() ? "Snooze & bump" : "Snooze"}
            </button>
          </>
        }
      >
        <form
          id={customFormId}
          className="flex flex-col gap-2.5 p-4"
          onSubmit={(event) => {
            event.preventDefault()
            submitCustom()
          }}
        >
          <label htmlFor={customInputId} className="text-[11px] font-medium text-muted">
            Wake at this local time
          </label>
          <input
            id={customInputId}
            type="datetime-local"
            required
            min={minCustom}
            value={customValue}
            onChange={(event) => {
              setCustomValue(event.target.value)
              setCustomError("")
            }}
            className="w-full rounded-md border border-border bg-bg px-2.5 py-2 text-[13px] text-fg outline-none focus:border-accent"
          />
          <p className="text-[10.5px] text-muted-65">
            Stored as an exact instant; shown here in your browser’s local time zone.
          </p>
          <label htmlFor={promptInputId} className="mt-1 text-[11px] font-medium text-muted">
            Then send this prompt <span className="font-normal text-muted-55">(optional)</span>
          </label>
          {/* The prompt is the difference between a reminder and a scheduled bump, so the field is
              focused: the dialog exists to write one, and the time above already carries a sane default. */}
          <textarea
            id={promptInputId}
            data-1p-ignore
            autoFocus
            rows={3}
            maxLength={SNOOZE_PROMPT_MAX}
            placeholder="e.g. Check whether CI went green and land it if so."
            value={promptValue}
            onChange={(event) => {
              setPromptValue(event.target.value)
              setCustomError("")
            }}
            onKeyDown={(event) => {
              // Enter (or ⌘/Ctrl-Enter) submits from inside the textarea; Shift/Option-Enter make the
              // newline — the three Enter keys every box shares (2026-08-26).
              if (shouldSubmitStagedEnter({
                key: event.key,
                altKey: event.altKey,
                ctrlKey: event.ctrlKey,
                metaKey: event.metaKey,
                shiftKey: event.shiftKey,
                isComposing: event.nativeEvent.isComposing,
                keyCode: event.nativeEvent.keyCode,
              })) {
                event.preventDefault()
                submitCustom()
              }
            }}
            className="w-full resize-y rounded-md border border-border bg-bg px-2.5 py-2 text-[13px] leading-5 text-fg outline-none placeholder:text-muted-40 focus:border-accent"
          />
          <TextareaCodeFences value={promptValue} />
          <p className="min-h-4 text-[10.5px] text-muted-65">
            {promptValue.trim()
              ? "ntwine will resume this thread with the prompt at the wake time."
              : "Leave empty to just bring the card back to your queue."}
          </p>
          {customError && <p role="alert" className="text-[11px] text-danger">{customError}</p>}
        </form>
      </Dialog>
    </>
  )
}
