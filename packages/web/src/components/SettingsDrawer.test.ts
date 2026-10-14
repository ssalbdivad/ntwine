import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(new URL("./SettingsDrawer.tsx", import.meta.url), "utf8")
const helpSource = readFileSync(new URL("../lib/settingsHelp.ts", import.meta.url), "utf8")
const autosaveSource = readFileSync(new URL("../hooks/useSettingsAutosave.tsx", import.meta.url), "utf8")
const fieldSource = readFileSync(new URL("./SettingsField.tsx", import.meta.url), "utf8")
const agentSource = readFileSync(new URL("./AgentSettingsPopover.tsx", import.meta.url), "utf8")
const tooltipSource = readFileSync(new URL("./Tooltip.tsx", import.meta.url), "utf8")

test("settings maps each contextual explanation to a help control", () => {
  // `subagentInstructions` is gone: the settings preamble was retired in favour of NTWINE.md, so there
  // is exactly one operator-authored surface for project conventions.
  for (const key of ["permissionMode", "promptCacheTtl", "appearance", "density", "notifications"]) {
    assert.match(helpSource, new RegExp(`\\b${key}:`), `missing settings help mapping: ${key}`)
  }
  assert.match(source, /label="Density" help=\{SETTINGS_HELP\.density\}/)
  assert.match(source, /label="Desktop notifications" help=\{SETTINGS_HELP\.notifications\}/)
  assert.match(source, /label="Always show status lines" help=\{SETTINGS_HELP\.alwaysShowStatusLines\}/)
  // The runtime fields read the same table from their own surface.
  assert.match(agentSource, /label="Permissions" help=\{SETTINGS_HELP\.permissionMode\}/)
  assert.match(agentSource, /label="Prompt cache tier" help=\{SETTINGS_HELP\.promptCacheTtl\}/)
})

// The BEHAVIOUR of the autosave — one write per click, one write per typing burst, and a flush on
// close — is pinned in a real browser by settingsAutosave.e2e.test.ts. This test guards the shape it
// depends on: nothing here may reintroduce a button that the operator has to press.
test("settings save themselves — no Save button, no Cancel, no unsaved marker", () => {
  assert.doesNotMatch(source, />\s*Save\s*</)
  assert.doesNotMatch(source, />\s*Cancel\s*</)
  assert.doesNotMatch(source, /● unsaved/)
  // The footer those two buttons lived in went with them; the sheet is header + scroll body.
  assert.doesNotMatch(source, /<footer/)
  // Every control routes through the one updater.
  assert.match(source, /const \{ draft, update, saveState, flush \} = useSettingsDraft\(\)/)
  // Closing must not strand a write still waiting on a read or a retry.
  const close = source.slice(source.indexOf("function close()"), source.indexOf("async function toggleNotifications"))
  assert.match(close, /flush\(\)/)
  // Writes are serialized: a whole-object payload delivered out of order silently reverts settings.
  // And every write is a react-query mutation under one key, so a dispatch surface can wait on it.
  assert.match(autosaveSource, /chain\.current = chain\.current\s*\n\s*\.then\(\(\) => writeRef\.current\.mutateAsync\(next\)\)/)
  assert.match(autosaveSource, /export const SETTINGS_WRITE_KEY = \["settingsSet"\] as const/)
  assert.match(autosaveSource, /mutationKey: \[\.\.\.SETTINGS_WRITE_KEY\], mutationFn: \(next: Settings\) => rpc\.settingsSet\(next\)/)
})

test("the drawer no longer duplicates the composer's controls or offers vestigial toggles", () => {
  // Model and effort are chosen per-dispatch in the prompt box (DispatchPreferences), so a second,
  // divergent copy of them here was only ever a way to confuse which one applied.
  assert.doesNotMatch(source, /label="Model"/)
  assert.doesNotMatch(source, /label="Effort"/)
  // The Runtime QA gate setting is gone entirely — browser-QA policy is a project's own NTWINE.md
  // concern, not a global Ntwine switch.
  assert.doesNotMatch(source, /Runtime QA gate/)
  assert.doesNotMatch(source, /runtimeGate/)
  // Auto-resume after a usage limit is unconditional now: nothing to turn off.
  assert.doesNotMatch(source, /autoResumeOnLimit/)
  assert.doesNotMatch(source, /Auto-resume after usage limits/)
})

// The drawer holds only machine and browser preferences. A setting that belongs to a project or to
// one runtime is edited where it applies, and nowhere else: the runtime fields behind the gear on
// their band in the model picker (maintainer 2026-09-19: "the whole point of moving these settings to other places is that we don't
// need to have them in the drawer anymore, so yeah, you can drop the tab switcher").
test("the drawer is one untabbed list of interface preferences, with no project or runtime settings", () => {
  // (The note above the component NAMES the retired tab in prose; what must be gone is the markup.)
  assert.doesNotMatch(source, /role="tab(?:list)?"|SettingsTabs|label: "(?:Project|Ntwine) settings"/)
  const fields = [...source.matchAll(/<SettingsField label="([^"]+)"/g)].map((m) => m[1])
  assert.deepEqual(fields, ["Appearance", "Density", "Queue order", "Desktop notifications", "Always show status lines", "Show recent threads", "Remove idle worktrees after", "Delete done threads", "Local file links"])
  assert.doesNotMatch(source, /<textarea/)
  // Nothing Claude- or Codex-specific is left in the drawer.
  assert.doesNotMatch(source, /ClaudeSection|CodexSection|DividerLabel|permissionMode|promptCacheTtl|autoCompactWindow|codexContextWindow/)
  assert.doesNotMatch(source, /label="(?:Permissions|Prompt cache tier|Compaction|Context window)"/)
})

// The in-context runtime panel opens off THE APP'S settings gear — lucide `Settings`, the glyph the status
// row and the mobile board use — never a second "settings" glyph (a sliders icon stood here briefly;
// maintainer 2026-09-19: "it should be a gear icon for settings. That's the one we use everywhere else").
test("every settings affordance wears the same gear", () => {
  for (const src of [agentSource, readFileSync(new URL("./StatusRow.tsx", import.meta.url), "utf8")]) {
    assert.match(src, /Settings as SettingsIcon[^\n]*from "lucide-react"/)
    assert.match(src, /<SettingsIcon\b/)
    assert.doesNotMatch(src, /Settings2|SlidersHorizontal/)
  }
})

// The runtime settings live on the model picker's band header, behind a gear, in a MODAL popover.
// Its predecessor (a non-modal context dropdown) closed the moment the pointer left its trigger,
// because Radix Menu focuses its own content on item leave and a non-modal popover reads that as a
// focus-outside. The modal flag is what makes that structurally impossible; this pins it.
test("the agent settings panel is modal, keyboard-reachable, and holds exactly the runtime's fields", () => {
  assert.match(agentSource, /<Popover modal open=\{open\} onOpenChange=\{onOpenChange\}>/)
  assert.match(agentSource, /<RadixMenu\.Item asChild onSelect=\{\(event\) => event\.preventDefault\(\)\}>/)
  assert.match(agentSource, /useEscapeToClose\(open, \(\) => onOpenChange\(false\)\)/)
  assert.match(agentSource, /onKeyDown=\{\(event\) => event\.stopPropagation\(\)\}/)
  // The Claude panel offers only the two headless-safe modes, and an out-of-range stored value
  // displays as the "auto" floor the server would actually dispatch with.
  assert.match(agentSource, /options=\{CLAUDE_DISPATCH_PERMISSION_OPTIONS\}/)
  assert.match(agentSource, /value=\{draft\.permissionMode === "bypassPermissions" \? "bypassPermissions" : "auto"\}/)
  assert.match(agentSource, /ariaLabel="Claude Code compaction window"/)
  assert.match(agentSource, /ariaLabel="Codex context window"/)
  // Every Select inside the panel portals ABOVE the panel, never at its own tier.
  const selects = agentSource.match(/<Select\b/g) ?? []
  const raised = agentSource.match(/menuZClass=\{OPAQUE_PORTAL_SURFACE_ABOVE_POPOVER_Z\}/g) ?? []
  assert.equal(raised.length, selects.length)
  // The dispatch surface carries the gear; a live thread's own picker does not.
  const newThread = readFileSync(new URL("NewThreadModal.tsx", import.meta.url), "utf8")
  assert.match(newThread, /agentSettings/)
  // …and waits for a settings write still in flight before it dispatches.
  assert.match(newThread, /useIsMutating\(\{ mutationKey: \[\.\.\.SETTINGS_WRITE_KEY\] \}\)/)
  assert.doesNotMatch(readFileSync(new URL("../hooks/useThreadComposerControls.tsx", import.meta.url), "utf8"), /agentSettings|contextWindows/)
  // The retired control and its patch RPC are gone for good.
  assert.doesNotMatch(readFileSync(new URL("./ProfileGridSelector.tsx", import.meta.url), "utf8"), /ContextWindowControl|contextWindows|data-context-window-menu/)
  assert.doesNotMatch(readFileSync(new URL("../api/contract.ts", import.meta.url), "utf8"), /contextWindowSet/)
})

test("notification recovery aligns with its control and keeps recovery instructions visible", () => {
  const denied = source.slice(source.indexOf("function NotifDeniedHelp"), source.indexOf("function hostOf"))
  assert.match(denied, /className="flex flex-col gap-1 text-\[11px\] text-muted-70"/)
  assert.doesNotMatch(denied, /pl-6/)
  assert.match(denied, /Notifications are blocked for this site/)
  assert.match(denied, /Paste this into a new tab, set Notifications/)
})

// "Compact mode" Off|On told the operator what Off was NOT. A density pair names both states.
test("diff density is a Comfortable|Compact pair, densest on the right, compact by default", () => {
  const toggle = source.slice(source.indexOf("function DensityToggle"), source.indexOf("function QueueOrderControl"))
  assert.match(toggle, /\{ v: false, label: "Comfortable" \},\s*\{ v: true, label: "Compact" \}/)
  assert.match(toggle, /prefs\.compactDiffs = o\.v/)
  assert.doesNotMatch(source, /label="Compact mode"/)
  assert.doesNotMatch(source, /function CompactToggle/)
})

test("help tooltip uses custom accessible, touch-capable paragraph layout", () => {
  // `&& !disabled` is drag suppression: the pointer is necessarily inside the trigger it is
  // dragging, so a delayDuration-0 tooltip would open on grab and chase it. It forces the tooltip SHUT without unmounting the trigger, which mid-drag would destroy
  // the element holding pointer capture. Hover behaviour is unchanged whenever nothing is dragging.
  // A tooltip may also carry its own open delay (a board row's status waits 350ms, so the tip does not flash
  // as the pointer crosses the list); the drag suppression is the part this pins.
  assert.match(tooltipSource, /<RT\.Root open=\{open && !disabled\} onOpenChange=\{setOpen\}(?: delayDuration=\{delay\})?>/)
  assert.match(tooltipSource, /clickable = false/)
  assert.match(tooltipSource, /cloneElement\(clickableChild, \{ "aria-describedby": contentId \}\)/)
  assert.match(tooltipSource, /onClick=\{\(\) => setOpen\(\(wasOpen\) => !wasOpen\)\}/)
  assert.match(tooltipSource, /onKeyDown=\{onKeyDown\}/)
  assert.match(tooltipSource, /createPortal\(/)
  assert.match(tooltipSource, /collisionPadding=\{12\}/)
  assert.match(tooltipSource, /max-w-\[min\(22rem,calc\(100vw-1\.5rem\)\)\]/)
  assert.match(tooltipSource, /leading-relaxed/)
  // Wrapping and whitespace behavior are composed independently, so keep this
  // contract resilient to Tailwind class ordering and the computed mode value.
  assert.match(tooltipSource, /\bbreak-words\b/)
  assert.match(tooltipSource, /\$\{whitespace\}/)
  assert.match(tooltipSource, /\bwhitespace-normal\b/)
  assert.match(tooltipSource, /\bwhitespace-pre-line\b/)
  assert.doesNotMatch(tooltipSource, /title=/)
  assert.match(fieldSource, /<Tooltip label=\{help\} side="right" clickable>/)
  assert.match(fieldSource, /inline-flex size-4 items-center justify-center/)
  assert.doesNotMatch(source.slice(source.indexOf("function CopyableAddress")), /title="Copy address"/)
})
