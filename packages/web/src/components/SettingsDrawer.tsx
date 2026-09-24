import { useEffect, useMemo, useState, useSyncExternalStore } from "react"
import { useSnapshot } from "valtio"
import { Check, Copy } from "lucide-react"
import { type Settings } from "@frizz/shared"
import { store } from "../store.ts"
import { copyTextToClipboard } from "../lib/clipboard.ts"
import { prefs } from "../lib/prefs.ts"
import { getThemeSnapshot, setThemePreference, subscribeTheme, type ThemePreference } from "../lib/theme.ts"
import { registerSettingsClose } from "../lib/overlays.ts"
import { SETTINGS_HELP } from "../lib/settingsHelp.ts"
import { SHEET_CLOSE_MS, SHEET_PANEL_CLASS, SHEET_SCRIM_CLASS, prefersReducedMotion } from "../lib/sheet.ts"
import { SaveStatus, useSettingsDraft } from "../hooks/useSettingsAutosave.tsx"
import { SheetHeader } from "./ui/SheetHeader.tsx"
import { Select } from "./ui/Select.tsx"
import { SettingsField } from "./SettingsField.tsx"

type NotifPerm = "default" | "granted" | "denied" | "unsupported"
function currentPerm(): NotifPerm {
  if (typeof Notification === "undefined") return "unsupported"
  return Notification.permission as NotifPerm
}

// The drawer holds ONLY what belongs to the machine and this browser — appearance, the rail, how local
// links open, density, queue order, notifications. Everything that belongs to a project or to one
// runtime is edited where it applies: a runtime's launch settings behind the gear on its band in the
// model picker (AgentSettingsPopover), the GitHub triage prompt behind the gear in the GitHub picker's
// header (GithubPromptPopover). A "Project settings" tab stood here for a few hours on 2026-09-19
// carrying that prompt a second time; the maintainer's call was that moving a setting to its context
// means it no longer lives here at all, so the tab strip went with it.
export function SettingsDrawer() {
  const { draft, update, saveState, flush } = useSettingsDraft()
  const [perm, setPerm] = useState<NotifPerm>(currentPerm())

  // Enter/exit animation. `shown` drives the slide (mount → next frame flips it true → slides in;
  // close flips it false → slides out). App renders <SettingsDrawer> only while showSettings is true,
  // so we keep ourselves mounted through the exit by delaying the store write until the slide ends.
  const [shown, setShown] = useState(false)
  const [closing, setClosing] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(id)
  }, [])

  // Let App's window-level Esc handler trigger THIS animated close (slide-out) rather than flipping the
  // store flag and unmounting instantly. `close` is a hoisted declaration, so referencing it here is safe.
  useEffect(() => {
    registerSettingsClose(close)
    return () => registerSettingsClose(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function close() {
    if (closing) return
    // Send whatever is still sitting in the debounce before the drawer goes away.
    flush()
    setClosing(true)
    setShown(false)
    window.setTimeout(() => (store.showSettings = false), prefersReducedMotion() ? 0 : SHEET_CLOSE_MS)
  }

  // Turning notifications on requests browser permission if not yet decided; we keep the toggle
  // truthful about the OS-level grant so a green checkbox can't imply notifications that won't fire.
  async function toggleNotifications(on: boolean) {
    if (!draft) return
    if (on && typeof Notification !== "undefined" && Notification.permission === "default") {
      const result = (await Notification.requestPermission()) as NotifPerm
      setPerm(result)
    }
    update({ ...draft, notifications: on })
  }

  return (
    <div
      className={`${SHEET_SCRIM_CLASS} z-50 flex justify-end ${shown ? "opacity-100" : "opacity-0"}`}
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <div
        className={`${SHEET_PANEL_CLASS} w-[560px] max-w-[94vw] ${shown ? "translate-x-0" : "translate-x-full"}`}
      >
        <SheetHeader title="Settings" actions={<SaveStatus state={saveState} />} onClose={close} />

        <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-6">
          {/* Browser appearance remains usable even while server settings are unavailable. */}
          <SettingsField label="Appearance" help={SETTINGS_HELP.appearance}>
            <AppearanceControl />
          </SettingsField>
          {!draft ? (
            <div className="text-[13px] text-muted">Loading server settings…</div>
          ) : (
            <>
            <SettingsField label="Project sidebar" help={SETTINGS_HELP.projectRail}>
              <OnOffToggle value={draft.projectRail} onChange={(projectRail) => update({ ...draft, projectRail })} />
            </SettingsField>

            {/* A client-only VIEW preference (localStorage, not server Settings): it never travels to
                the server at all, so it's wired straight to the prefs proxy rather than the draft. */}
            <SettingsField label="Density" help={SETTINGS_HELP.density}>
              <DensityToggle />
            </SettingsField>

            {/* Client-only VIEW preference (localStorage): applies immediately, wired to prefs. */}
            <SettingsField label="Queue order" help={SETTINGS_HELP.queueOrder}>
              <QueueOrderControl />
            </SettingsField>

            {/* Same segmented Off/On control as every other row (the old bare checkbox matched
                nothing else in the form). Off left, On right — switch convention. */}
            <SettingsField label="Desktop notifications" help={SETTINGS_HELP.notifications}>
              <OnOffToggle value={draft.notifications} onChange={toggleNotifications} />
              {draft.notifications && <PermHint perm={perm} />}
            </SettingsField>

            {/* LAST, on purpose: which editor a vetted local path opens in is the one power-user
                knob in the drawer, so it sits below everything an ordinary operator adjusts. */}
            <SettingsField label="Local file links" help={SETTINGS_HELP.localFileOpener}>
              <Select
                variant="bordered"
                value={draft.localFileOpener ?? "system"}
                onValueChange={(v) => update({ ...draft, localFileOpener: v as Settings["localFileOpener"] })}
                options={[
                  { value: "system", label: "System default" },
                  { value: "cursor", label: "Cursor" },
                  { value: "vscode", label: "VS Code" },
                  { value: "finder", label: "Reveal in Finder" },
                  { value: "copy", label: "Copy path" },
                ]}
                indicatorPosition="right"
                ariaLabel="Local file link opener"
              />
            </SettingsField>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function AppearanceControl() {
  const theme = useSyncExternalStore(subscribeTheme, getThemeSnapshot, getThemeSnapshot)
  return (
    <Select
      variant="bordered"
      value={theme.preference}
      onValueChange={(value) => setThemePreference(value as ThemePreference)}
      options={[{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]}
      indicatorPosition="right"
      ariaLabel="Appearance"
    />
  )
}

// The ONE boolean control shape for the whole form: a segmented Off|On pair, Off always on the LEFT
// (switch convention — right = on). Active segments use the primary button treatment.
function OnOffToggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  const opts: { v: boolean; label: string }[] = [
    { v: false, label: "Off" },
    { v: true, label: "On" },
  ]
  return (
    <div className="inline-flex w-fit rounded-md border border-border bg-bg p-0.5">
      {opts.map((o) => (
        <button
          key={o.label}
          onClick={() => onChange(o.v)}
          aria-pressed={value === o.v}
          className={`rounded px-3 py-1 text-[12px] transition-colors ${
            value === o.v ? "bg-fg text-bg" : "text-muted hover:text-fg"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// Diff density: client-only (localStorage prefs proxy), applies live — diff blocks across the app
// collapse/expand the instant it flips, with no server round-trip at all. The pair is named for what
// each one FEELS like rather than Off/On, in the Comfortable|Compact vocabulary Gmail and Trello settled
// (a boolean called "compact mode" told you what Off was not). Left to right is increasing density,
// so Compact — the default — holds the right-hand slot, where On sits on the boolean pairs.
function DensityToggle() {
  const { compactDiffs } = useSnapshot(prefs)
  const opts: { v: boolean; label: string }[] = [
    { v: false, label: "Comfortable" },
    { v: true, label: "Compact" },
  ]
  return (
    <div className="inline-flex w-fit rounded-md border border-border bg-bg p-0.5">
      {opts.map((o) => (
        <button
          key={o.label}
          onClick={() => (prefs.compactDiffs = o.v)}
          aria-pressed={compactDiffs === o.v}
          className={`rounded px-3 py-1 text-[12px] transition-colors ${
            compactDiffs === o.v ? "bg-fg text-bg" : "text-muted hover:text-fg"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// Queue/rested-band direction: client-only (localStorage prefs proxy), applies live to the Needs-you
// queue and the sidebar's rested rows the instant it flips. FIFO by default (longest in the queue first).
function QueueOrderControl() {
  const { queueOrder } = useSnapshot(prefs)
  const opts: { v: "fifo" | "lifo"; label: string }[] = [
    { v: "fifo", label: "Oldest first" },
    { v: "lifo", label: "Newest first" },
  ]
  return (
    <div className="inline-flex w-fit rounded-md border border-border bg-bg p-0.5">
      {opts.map((o) => (
        <button
          key={o.v}
          onClick={() => (prefs.queueOrder = o.v)}
          aria-pressed={queueOrder === o.v}
          className={`rounded px-3 py-1 text-[12px] transition-colors ${
            queueOrder === o.v ? "bg-fg text-bg" : "text-muted hover:text-fg"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// Quiet, small permission-state line under the notifications toggle. Everything is muted (the old
// loud-red denied line read as an error); the denied state additionally offers a recovery assist,
// since a page can't re-prompt once denied.
function PermHint({ perm }: { perm: NotifPerm }) {
  if (perm === "denied") return <NotifDeniedHelp />
  const text: Record<Exclude<NotifPerm, "denied">, string> = {
    granted: "Browser permission granted — notifications fire when the window is hidden.",
    default: "Browser permission not yet granted — notifications won't fire until you allow them.",
    unsupported: "This browser does not support desktop notifications.",
  }
  return <span className="text-[11px] text-muted-70">{text[perm]}</span>
}

type Browser = "chrome" | "edge" | "safari" | "firefox" | "other"
function detectBrowser(): Browser {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : ""
  if (/Firefox\//.test(ua)) return "firefox"
  if (/Edg\//.test(ua)) return "edge"
  if (/OPR\/|Brave\//.test(ua)) return "other"
  if (/Chrome\//.test(ua)) return "chrome"
  if (/Safari\//.test(ua)) return "safari"
  return "other"
}

// Once a site's notification permission is DENIED, the page can no longer meaningfully re-invoke
// requestPermission, and chrome://about: URLs can't be opened from a web page — so no real deep link
// exists. Best UX: browser-specific one-line instructions, plus (Chromium) the exact site-settings
// address as selectable + copyable mono text. Muted + small; only shown in the denied state.
function NotifDeniedHelp() {
  const browser = useMemo(detectBrowser, [])
  const origin = typeof location !== "undefined" ? location.origin : ""
  const chromiumUrl = `${browser === "edge" ? "edge" : "chrome"}://settings/content/siteDetails?site=${encodeURIComponent(origin)}`

  return (
    <div className="flex flex-col gap-1 text-[11px] text-muted-70">
      <span>Notifications are blocked for this site. Re-enable them in your browser, then reload.</span>
      {browser === "chrome" || browser === "edge" ? (
        <CopyableAddress url={chromiumUrl} hint="Paste this into a new tab, set Notifications → Allow:" />
      ) : browser === "safari" ? (
        <span>Safari → Settings → Websites → Notifications → allow {hostOf(origin)}, then reload.</span>
      ) : browser === "firefox" ? (
        <span>Firefox → Settings → Privacy &amp; Security → Permissions → Notifications → Settings → allow this site.</span>
      ) : (
        <span>Open this site's notification permission in your browser's settings and set it to Allow.</span>
      )}
    </div>
  )
}

function hostOf(origin: string) {
  try {
    return new URL(origin).host
  } catch {
    return origin
  }
}

function CopyableAddress({ url, hint }: { url: string; hint: string }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await copyTextToClipboard(url)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard blocked — the address is still selectable inline */
    }
  }
  return (
    <span className="flex w-full flex-col gap-1">
      <span>{hint}</span>
      <span className="flex min-w-0 items-center gap-1.5">
        <code className="min-w-0 flex-1 font-mono-keep select-all rounded border border-border bg-bg px-1.5 py-0.5 text-[10.5px] text-fg/90 break-all">
          {url}
        </code>
        <button
          type="button"
          onClick={copy}
          aria-label="Copy address"
          className="shrink-0 rounded border border-border p-1 text-muted hover:bg-panel-2 hover:text-fg transition-colors"
        >
          {copied ? <Check size={11} className="text-live" /> : <Copy size={11} />}
        </button>
      </span>
    </span>
  )
}
