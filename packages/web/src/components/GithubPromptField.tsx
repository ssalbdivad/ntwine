import { useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { type Settings } from "@ntwine/shared"
import { rpc } from "../api/rpc.ts"
import { registerOpenSelect } from "../lib/selectOverlay.ts"
import { SETTINGS_HELP } from "../lib/settingsHelp.ts"
import { LabelWithHelp } from "./SettingsField.tsx"
import { Popover, PopoverContent, PopoverTrigger } from "./ui/Popover.tsx"
import { TextareaCodeFences } from "./TextareaCodeFences.tsx"

// The 6 substitution tokens the server fills in a GitHub batch-dispatch template, each with a one-word
// gloss of what it expands to. Kept in lockstep with PROMPT_TOKENS in server/github.ts (there is no
// shared const; this is a display hint only). Surfaced once, via the "Tokens" popover on the field.
const GH_PROMPT_TOKENS: { token: string; gloss: string }[] = [
  { token: "repo", gloss: "repository" },
  { token: "n", gloss: "number" },
  { token: "title", gloss: "title" },
  { token: "url", gloss: "link" },
  { token: "labels", gloss: "labels" },
  { token: "body", gloss: "description" },
]

// The GitHub-picker triage template's editor, rendered by the picker's own settings popover
// (GithubPromptPopover) — the one place the prompt is edited. It PREFILLS with the shipped default (fetched
// from the server, the single source of truth) so the user edits from the real prompt; a stored
// override supersedes it. Empty override = default.
//
// ONE editor, not two. Issue and PR had a box each until 2026-08-15; the two prompts said much the same
// thing, so "make triage more skeptical" meant the same edit twice and a pair that drifted apart.
export function GithubPromptEditor({
  draft,
  onChange,
  rows,
}: {
  draft: Settings
  onChange: (next: Settings, opts?: { debounce?: boolean }) => void
  rows?: number
}) {
  const defaults = useQuery({ queryKey: ["githubPromptDefaults"], queryFn: () => rpc.githubPromptDefaults() })
  if (!defaults.data) return <div className="text-[12px] text-muted">Loading defaults…</div>
  return (
    <GithubPromptField
      label="Issue and PR triage prompt"
      help={SETTINGS_HELP.githubPrompt}
      value={draft.githubPrompt}
      fallback={defaults.data.prompt}
      rows={rows}
      onChange={(v, opts) => onChange({ ...draft, githubPrompt: v }, opts)}
    />
  )
}

// A real click-popover (NOT a hover tooltip) listing the substitution tokens, built on the shared
// Radix Popover: opaque from the first frame, portaled above the drawer, and it flips/shifts to stay
// on-screen. Opens on click; dismisses on outside-click or Esc. While open it holds the shared
// open-select registry, so an Escape reaches it FIRST and closes only this panel — never the
// settings popover it was opened from. Prefers opening UPWARD: it sits on the prompt field's
// label row with the roomy textarea below it and space above.
//
// The trigger is a WORD, not a "?" circle. It was a HelpCircle while it lived on a row of its own; on
// the field's label row it would be the second identical question-mark glyph in ~800px — LabelWithHelp
// already puts one right after the label, and the two do different things (that one hovers prose, this
// one clicks open a list). "Tokens" also says what the panel holds, which the circle never did, and it
// matches the "Reset to default" text button it now sits beside.
function TokenHelpPopover() {
  const [open, setOpen] = useState(false)
  const unregister = useRef<(() => void) | undefined>(undefined)
  function setOpenRegistered(next: boolean) {
    unregister.current?.()
    unregister.current = undefined
    if (next) unregister.current = registerOpenSelect(() => setOpenRegistered(false))
    setOpen(next)
  }
  return (
    <Popover open={open} onOpenChange={setOpenRegistered}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`shrink-0 text-[11px] transition-colors ${open ? "text-accent" : "text-muted hover:text-accent"}`}
        >
          Tokens
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-56 p-3">
        <div className="mb-2 text-[11px] font-medium text-fg">Substitution tokens</div>
        <ul className="flex flex-col gap-1.5">
          {GH_PROMPT_TOKENS.map(({ token, gloss }) => (
            <li key={token} className="flex items-center justify-between gap-3 text-[11px]">
              <code className="font-mono-keep rounded border border-border bg-bg px-1 py-0.5 text-[10px] text-fg/80">
                {`{${token}}`}
              </code>
              <span className="text-muted-80">{gloss}</span>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

// One prompt editor. `value` is the stored override (undefined = "use default"); `fallback` is the
// shipped default shown when there is no override, so the box always renders the effective prompt.
// Typing sets a concrete override; "Reset to default" clears it back to undefined (server default).
// Typing is the one input that DEBOUNCES its write — a keystroke is not an intent, a pause is;
// "Reset to default" is a click, so it saves at once like every other control.
export function GithubPromptField({
  label,
  help,
  value,
  fallback,
  rows = 10,
  onChange,
}: {
  label: string
  help: string
  value: string | undefined
  fallback: string
  rows?: number
  onChange: (v: string | undefined, opts?: { debounce?: boolean }) => void
}) {
  const customized = value != null
  return (
    <div className="flex flex-col gap-2">
      {/* Actions stay at the far edge; the middot separates Reset from Tokens without moving either.
          System-ui measurements: 9.44/9.68px of ink on either side of the dot. */}
      <div className="flex items-center justify-between gap-2">
        <LabelWithHelp label={label} help={help} />
        <div className="flex shrink-0 items-center gap-2">
          {customized && (
            <>
              <button
                type="button"
                className="text-[11px] text-muted hover:text-accent transition-colors"
                onClick={() => onChange(undefined)}
              >
                Reset to default
              </button>
              <span aria-hidden className="text-[11px] text-muted-40">·</span>
            </>
          )}
          <TokenHelpPopover />
        </div>
      </div>
      <textarea
        data-1p-ignore
        value={value ?? fallback}
        // Emptying the box clears the override (→ undefined), so it snaps back to showing the default
        // and drops the "Reset" affordance — matching the server's blank-means-default semantics
        // instead of leaving a confusing empty box that still reads as "customized".
        onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value, { debounce: true })}
        rows={rows}
        className="input resize-none text-[12px] leading-relaxed font-mono-keep"
        spellCheck={false}
      />
      <TextareaCodeFences value={value ?? fallback} />
    </div>
  )
}
