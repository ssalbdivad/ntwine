import { useEffect, useRef, useState } from "react"
import { useSnapshot } from "valtio"
import { Keyboard, RotateCcw } from "lucide-react"
import { store } from "../store.ts"
import { prefs } from "../lib/prefs.ts"
import {
  ACTIONS,
  FIXED_SHORTCUTS,
  actionDef,
  assignChord,
  chordFromEvent,
  chordKeycaps,
  chordProblem,
  detectPlatform,
  effectiveBindings,
  formatChord,
  isDefault,
  parseChord,
  type ActionId,
  type Chord,
} from "../lib/keybindings.ts"
import { useShortcutLabel, useShortcutListener, withShortcut } from "../lib/keyboardRuntime.ts"
import { STATUS_ROW_ACTION, STATUS_ROW_ICON } from "../lib/statusRow.ts"
import { Dialog } from "./ui/Dialog.tsx"

// THE KEYBOARD SHORTCUTS SHEET, and the one component every page shell mounts to make the keys work
// at all (<KeyboardLayer/>: the runtime's listener plus the sheet). The sheet is the whole keyboard on
// one card — the rebindable shortcuts and, below them, the prompt box's own fixed keys — and it is
// where they are changed: click a key, press the new one.
//
// REBINDING NEVER STRANDS AN ACTION. Pressing a key another action already holds SWAPS the two (see
// assignChord): both rows pop, and the line at the foot of the sheet says what moved where. A chord the
// browser or the text box owns is refused on the spot with the reason, and the row shakes rather than
// saving something that would never fire. Every change is saved as it is made — there is no Save.

const platform = detectPlatform()

export function KeyboardLayer() {
  useShortcutListener()
  const open = useSnapshot(store).showShortcuts
  return <KeyboardShortcutsDialog open={open} onOpenChange={(next) => { store.showShortcuts = next }} />
}

// The door in the status row, beside settings: the same 24px square and ink trim as its neighbours.
export function KeyboardShortcutsButton() {
  const label = withShortcut("Keyboard shortcuts", useShortcutLabel("app.shortcuts"))
  return (
    <button
      type="button"
      aria-label="Keyboard shortcuts"
      title={label}
      className={STATUS_ROW_ACTION}
      onClick={() => { store.showShortcuts = true }}
    >
      <Keyboard size={STATUS_ROW_ICON} aria-hidden="true" />
    </button>
  )
}

// ── keycaps ───────────────────────────────────────────────────────────────────────────────────────

// A keycap: a bordered cap with a 1px darker bottom lip, so a row of them reads as keys rather than
// as tags. Every cap is at least square; word caps (Ctrl, Enter) grow to fit.
const CAP_CLASS =
  // `font-[inherit]`: a bare <kbd> falls back to the browser's monospace, which drew "Ctrl" and "Enter"
  // in a different face from the label beside them.
  "font-[inherit] inline-flex h-[21px] min-w-[21px] items-center justify-center rounded-[5px] border border-border-strong bg-panel-2 px-[5px] text-[11px] font-medium leading-none shadow-[0_1px_0_0_var(--color-border-strong)]"

export function Keycaps({ chord, muted = false }: { chord: Chord; muted?: boolean }) {
  return (
    <span className="inline-flex items-center gap-[3px]" aria-label={formatChord(chord, platform)}>
      {chordKeycaps(chord, platform).map((cap, index) => (
        <kbd key={index} aria-hidden="true" className={`${CAP_CLASS} ${muted ? "text-fg/55" : "text-fg/85"}`}>{cap}</kbd>
      ))}
    </span>
  )
}

// ── the sheet ─────────────────────────────────────────────────────────────────────────────────────

type Held = { mod: boolean; alt: boolean; shift: boolean }
const NOTHING_HELD: Held = { mod: false, alt: false, shift: false }

function KeyboardShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const overrides = useSnapshot(prefs).keybindings as typeof prefs.keybindings
  const bindings = effectiveBindings(overrides)
  const [recording, setRecording] = useState<ActionId | null>(null)
  const [held, setHeld] = useState<Held>(NOTHING_HELD)
  const [problem, setProblem] = useState<{ id: ActionId; text: string; nonce: number } | null>(null)
  // Rows that just changed, and a nonce so pressing the same key twice still replays the pop.
  const [changed, setChanged] = useState<{ ids: ActionId[]; nonce: number }>({ ids: [], nonce: 0 })
  const [status, setStatus] = useState("")
  const nonce = useRef(0)
  const bumpNonce = () => ++nonce.current

  // A closed sheet forgets any half-finished recording, and opens on a clean slate next time.
  useEffect(() => {
    if (open) return
    setRecording(null)
    setProblem(null)
    setStatus("")
  }, [open])

  const keysOf = (id: ActionId, from = bindings) => {
    const chord = from[id]
    return chord ? formatChord(chord, platform) : null
  }

  function commit(id: ActionId, chord: Chord | null) {
    const { overrides: next, swappedWith } = assignChord(prefs.keybindings, id, chord)
    prefs.keybindings = next
    const after = effectiveBindings(next)
    setRecording(null)
    setHeld(NOTHING_HELD)
    setProblem(null)
    setChanged({ ids: swappedWith ? [id, swappedWith] : [id], nonce: bumpNonce() })
    const label = actionDef(id).label
    if (!chord) setStatus(`${label} has no key now`)
    else if (swappedWith) {
      const moved = keysOf(swappedWith, after)
      setStatus(`${label} is now ${keysOf(id, after)} — ${actionDef(swappedWith).label} ${moved ? `took ${moved}` : "has no key now"}`)
    } else setStatus(`${label} is now ${keysOf(id, after)}`)
  }

  function reset(id: ActionId) {
    commit(id, parseChord(actionDef(id).defaultChord))
    setStatus(`${actionDef(id).label} is back to ${formatChord(parseChord(actionDef(id).defaultChord)!, platform)}`)
  }

  function resetAll() {
    const moved = ACTIONS.filter((action) => !isDefault(prefs.keybindings, action.id)).map((action) => action.id)
    prefs.keybindings = {}
    setRecording(null)
    setProblem(null)
    setChanged({ ids: moved, nonce: bumpNonce() })
    setStatus("Every shortcut is back to its default")
  }

  // RECORDING owns the keyboard: window CAPTURE, ahead of the dialog's own Escape (Radix listens on the
  // document) and of the shortcut runtime (window bubble), so a key pressed to bind `?` or ⌘K binds it
  // instead of doing it. Tab is the one key let through — it leaves the row, which ends the recording.
  useEffect(() => {
    if (!recording) return
    const id = recording
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Tab") {
        setRecording(null)
        setHeld(NOTHING_HELD)
        return
      }
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      if (event.isComposing || event.repeat) return
      const modifiers = { mod: event.metaKey || event.ctrlKey, alt: event.altKey, shift: event.shiftKey }
      if (event.key === "Escape") {
        setRecording(null)
        setHeld(NOTHING_HELD)
        setProblem(null)
        return
      }
      if ((event.key === "Backspace" || event.key === "Delete") && !modifiers.mod && !modifiers.alt && !modifiers.shift) {
        commit(id, null)
        return
      }
      const chord = chordFromEvent(event)
      if (!chord) {
        setHeld(modifiers)
        return
      }
      const reason = chordProblem(chord, platform)
      if (reason) {
        setProblem({ id, text: reason, nonce: bumpNonce() })
        return
      }
      commit(id, chord)
    }
    function onKeyUp(event: KeyboardEvent) {
      setHeld({ mod: event.metaKey || event.ctrlKey, alt: event.altKey, shift: event.shiftKey })
    }
    window.addEventListener("keydown", onKeyDown, true)
    window.addEventListener("keyup", onKeyUp, true)
    return () => {
      window.removeEventListener("keydown", onKeyDown, true)
      window.removeEventListener("keyup", onKeyUp, true)
    }
    // commit reads the latest prefs itself; re-subscribing per render would drop a held modifier.
  }, [recording])

  const anyChanged = ACTIONS.some((action) => !isDefault(overrides, action.id))
  const groups = [
    { heading: "Queue", note: "On the card you're reading — or the thread drawer, when one is open.", actions: ACTIONS.filter((action) => action.group === "queue") },
    { heading: "Anywhere", note: null, actions: ACTIONS.filter((action) => action.group === "anywhere") },
  ]

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Keyboard shortcuts"
      className="w-[460px] max-w-[92vw] max-h-[86vh]"
      onOpenAutoFocus={(event) => {
        // Land on the sheet, not on its Close button: the first Tab then walks the keys.
        event.preventDefault()
        document.querySelector<HTMLElement>("[data-shortcut-list]")?.focus({ preventScroll: true })
      }}
      footer={
        <>
          <span aria-live="polite" data-shortcut-status className="mr-auto min-w-0 truncate text-[11.5px] text-muted-70">
            {status || "Click a key to change it"}
          </span>
          <button
            type="button"
            disabled={!anyChanged}
            onClick={resetAll}
            className="button-outline shrink-0 rounded-md px-3 py-1.5 text-[12px] text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg disabled:opacity-45 disabled:hover:bg-transparent disabled:hover:text-muted"
          >
            Restore defaults
          </button>
        </>
      }
    >
      <div data-shortcut-list tabIndex={-1} className="flex flex-col px-4 pb-2 pt-0.5 outline-none">
        {groups.map((group) => (
          <section key={group.heading} aria-label={group.heading} className="mt-3">
            <h3 className="text-[11px] font-medium uppercase tracking-wide text-fg/60">{group.heading}</h3>
            {group.note && <p className="mt-0.5 text-[11.5px] text-muted-65">{group.note}</p>}
            <ul className="mt-1.5 flex flex-col">
              {group.actions.map((action) => (
                <ShortcutRow
                  key={action.id}
                  id={action.id}
                  label={action.label}
                  chord={bindings[action.id]}
                  isDefault={isDefault(overrides, action.id)}
                  defaultLabel={formatChord(parseChord(action.defaultChord)!, platform)}
                  recording={recording === action.id}
                  held={held}
                  problem={problem?.id === action.id ? problem : null}
                  changedNonce={changed.ids.includes(action.id) ? changed.nonce : 0}
                  onRecord={() => {
                    setProblem(null)
                    setHeld(NOTHING_HELD)
                    setRecording((current) => (current === action.id ? null : action.id))
                  }}
                  onCancel={() => {
                    setRecording((current) => (current === action.id ? null : current))
                    setHeld(NOTHING_HELD)
                    setProblem(null)
                  }}
                  onReset={() => reset(action.id)}
                />
              ))}
            </ul>
          </section>
        ))}
        {FIXED_SHORTCUTS.map((group) => (
          <section key={group.heading} aria-label={group.heading} className="mt-3">
            <h3 className="text-[11px] font-medium uppercase tracking-wide text-fg/60">{group.heading}</h3>
            <ul className="mt-1.5 flex flex-col">
              {group.keys.map((fixed) => (
                <li key={fixed.label} className="flex min-h-7 items-center gap-3">
                  <span className="min-w-0 flex-1 text-[13px] text-fg/70">{fixed.label}</span>
                  {/* The same box a rebindable key sits in, minus the button — so the two columns of caps
                      share one right edge. */}
                  <span className="p-[3px]"><Keycaps chord={parseChord(fixed.chord)!} muted /></span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Dialog>
  )
}

function ShortcutRow({
  id,
  label,
  chord,
  isDefault,
  defaultLabel,
  recording,
  held,
  problem,
  changedNonce,
  onRecord,
  onCancel,
  onReset,
}: {
  id: ActionId
  label: string
  chord: Chord | null
  isDefault: boolean
  defaultLabel: string
  recording: boolean
  held: Held
  problem: { text: string; nonce: number } | null
  changedNonce: number
  onRecord: () => void
  onCancel: () => void
  onReset: () => void
}) {
  const heldCaps = recording ? chordKeycaps({ key: "", ...held }, platform).slice(0, -1) : []
  return (
    <li data-shortcut={id} className="relative -mx-2 flex min-h-7 items-center gap-3 rounded-md px-2">
      {/* The row's flash is its own layer, keyed on the change so a second change replays it — keying the
          row itself would remount the focused key button and drop the keyboard user's place. */}
      {changedNonce > 0 && <span key={changedNonce} aria-hidden="true" className="kbd-row-flash pointer-events-none absolute inset-0 rounded-md" />}
      <span className="shrink-0 text-[13px] text-fg/90">{label}</span>
      {/* What the row is waiting for, or why it refused a key — on the row's own line, right-aligned
          against the key it is about. A second line under the label would push every row below it down
          and back up again on each recording. */}
      <span className="flex min-w-0 flex-1 justify-end">
        {problem ? (
          <span role="alert" className="truncate text-[11px] text-danger-soft" title={problem.text}>{problem.text}</span>
        ) : recording ? (
          <span className="truncate text-[11px] text-muted-65">Esc to cancel, Backspace to clear</span>
        ) : null}
      </span>
      {/* The reset hangs off the key it resets: `-mr-1` pulls its 24px square to within a few px of ink
          of the cap rather than sitting a full row gap away from it. */}
      {!isDefault && !recording && (
        <button
          type="button"
          aria-label={`Reset ${label} to ${defaultLabel}`}
          title={`Reset to ${defaultLabel}`}
          onClick={onReset}
          className="-mr-2 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-60 outline-none transition-colors hover:bg-panel-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-border-strong"
        >
          <RotateCcw size={12} aria-hidden="true" />
        </button>
      )}
      <button
        type="button"
        aria-label={recording ? `Press the new key for ${label}` : `Change the key for ${label}${chord ? `, now ${formatChord(chord, platform)}` : ""}`}
        aria-pressed={recording}
        onClick={onRecord}
        onBlur={onCancel}
        className={`group shrink-0 rounded-[7px] p-[3px] outline-none transition-colors focus-visible:ring-1 focus-visible:ring-border-strong ${recording ? "" : "hover:bg-panel-2"}`}
      >
        {recording ? (
          <span
            key={problem?.nonce ?? 0}
            className={`kbd-listening inline-flex h-[21px] min-w-[84px] items-center justify-center gap-[3px] rounded-[5px] border border-accent/70 px-1.5 text-[11px] text-muted-70 ${problem ? "kbd-shake" : ""}`}
          >
            {/* Held modifiers preview as the chord's own spelling with the key still to come — "⌘…",
                "Ctrl+…" — in the pill's text rather than as caps, which would not fit inside its border. */}
            {heldCaps.length > 0
              ? <span className="font-medium text-fg/85">{heldCaps.join(platform === "mac" ? "" : "+")}{platform === "mac" ? "" : "+"}…</span>
              : "Press a key"}
          </span>
        ) : chord ? (
          <span key={changedNonce} className={`inline-flex ${changedNonce ? "kbd-pop" : ""}`}>
            <Keycaps chord={chord} />
          </span>
        ) : (
          <span className="inline-flex h-[21px] items-center rounded-[5px] border border-dashed border-border-strong px-2 text-[11px] text-muted-60">No key</span>
        )}
      </button>
    </li>
  )
}
