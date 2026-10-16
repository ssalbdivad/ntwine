import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { UserCommandName, type UserCommand } from "@ntwine/shared"
import { rpc } from "../api/rpc.ts"
import { SETTINGS_HELP } from "../lib/settingsHelp.ts"
import { invalidateUserCommands, useUserCommands } from "../hooks/useUserCommands.ts"
import { SettingsField } from "./SettingsField.tsx"

// Settings → Slash commands: every user command the prompt box offers (UserCommand in @ntwine/shared),
// and an editor for the ones written here. Only ntwine's own folder is written. A project's or the
// machine-wide `~/.agents/commands` one opens as a COPY — saving it writes an ntwine command of the same
// name, which then wins over the original — so nothing here ever edits a file another tool owns. Delete
// is the one exception: it removes the file from the folder the command was listed from, and for a
// project's or the machine-wide command it asks once more, since every tool reading that folder loses it.
//
// Saved explicitly, not as-you-type like the project instructions: a command's NAME is its file name,
// and a half-typed rename would leave a trail of files behind it.

type Draft = { name: string; description: string; body: string; previousName?: string; copiedFrom?: UserCommand }

const SOURCE_LABEL: Record<UserCommand["source"], string> = { ntwine: "ntwine", project: "project", global: "global" }

export function SlashCommandsField() {
  const queryClient = useQueryClient()
  const loaded = useUserCommands()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const commands = loaded.data?.commands ?? []

  const open = (command?: UserCommand) => {
    setError(null)
    if (!command) return setDraft({ name: "", description: "", body: "" })
    // A file with no description is listed under its prompt's first line (user-commands.ts); the field
    // starts empty then, or saving would write that line back as a description nobody wrote.
    const description = command.description === command.body.split("\n").find((l) => l.trim())?.trim() ? "" : command.description
    if (command.source === "ntwine") setDraft({ name: command.name, description, body: command.body, previousName: command.name })
    else setDraft({ name: command.name, description, body: command.body, copiedFrom: command })
  }

  async function save() {
    if (!draft) return
    const name = draft.name.trim().replace(/^\//, "")
    const parsed = UserCommandName.safeParse(name)
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? "Invalid name")
    if (!draft.body.trim()) return setError("Write the prompt the command sends")
    const clash = commands.find((c) => c.source === "ntwine" && c.name === name && c.name !== draft.previousName)
    if (clash) return setError(`/${name} already exists`)
    setSaving(true)
    try {
      await rpc.saveUserCommand({
        name,
        description: draft.description.trim(),
        body: draft.body,
        ...(draft.previousName && draft.previousName !== name ? { previousName: draft.previousName } : {}),
      })
      await invalidateUserCommands(queryClient)
      setDraft(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the command")
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    const target = draft?.copiedFrom ?? (draft?.previousName ? { name: draft.previousName, source: "ntwine" as const } : undefined)
    if (!target) return
    setSaving(true)
    try {
      await rpc.deleteUserCommand({ name: target.name, source: target.source })
      await invalidateUserCommands(queryClient)
      setDraft(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't delete the command")
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsField label="Slash commands" help={SETTINGS_HELP.slashCommands}>
      {loaded.isError ? (
        <div className="text-[12px] text-muted">Couldn't read the commands</div>
      ) : (
        <div data-slash-commands className="flex flex-col gap-2">
          {commands.length > 0 && (
            <div className="flex max-h-60 flex-col overflow-y-auto rounded-md border border-border py-1">
              {commands.map((command) => (
                <button
                  key={`${command.source}:${command.name}`}
                  type="button"
                  data-command-row={command.name}
                  onClick={() => open(command)}
                  title={command.path}
                  className={`flex w-full items-baseline gap-2 px-2.5 py-1 text-left transition-colors hover:bg-panel-2 ${draft?.previousName === command.name || draft?.copiedFrom === command ? "bg-panel-2" : ""}`}
                >
                  <span className="shrink-0 font-mono-keep text-[12px] text-command">/{command.name}</span>
                  <span className="min-w-0 truncate text-[11px] text-muted">{command.description}</span>
                  <span className="petite-caps ml-auto shrink-0 text-[10px] text-muted-70">{SOURCE_LABEL[command.source]}</span>
                </button>
              ))}
            </div>
          )}
          {draft ? (
            <CommandEditor
              key={draft.copiedFrom?.path ?? draft.previousName ?? "new"}
              draft={draft}
              onChange={(next) => {
                setDraft(next)
                setError(null)
              }}
              dir={loaded.data?.ntwineDir ?? ""}
              error={error}
              saving={saving}
              onSave={() => void save()}
              onCancel={() => setDraft(null)}
              onDelete={draft.previousName || draft.copiedFrom ? () => void remove() : undefined}
            />
          ) : (
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11px] text-muted-70">
                {commands.length === 0 ? "None yet. Type / in a prompt box to use one." : "Click one to edit or delete it."}
              </span>
              <button
                type="button"
                onClick={() => open()}
                className="button-outline shrink-0 rounded-md border border-border px-3 py-1 text-[12px] text-fg outline-none transition-colors hover:bg-panel-2"
              >
                New command
              </button>
            </div>
          )}
        </div>
      )}
    </SettingsField>
  )
}

function CommandEditor({
  draft,
  onChange,
  dir,
  error,
  saving,
  onSave,
  onCancel,
  onDelete,
}: {
  draft: Draft
  onChange: (next: Draft) => void
  dir: string
  error: string | null
  saving: boolean
  onSave: () => void
  onCancel: () => void
  onDelete?: () => void
}) {
  const name = draft.name.trim().replace(/^\//, "")
  // Deleting another folder's command takes a second click, with the file it removes named in between.
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const deleteNow = () => (draft.copiedFrom && !confirmingDelete ? setConfirmingDelete(true) : onDelete?.())
  return (
    <div data-command-editor className="flex flex-col gap-2 rounded-md border border-border p-2.5">
      {draft.copiedFrom && (
        <p className="text-[11px] text-muted-70">
          A copy of the {SOURCE_LABEL[draft.copiedFrom.source]} command. Saving it here makes this version the one that runs.
        </p>
      )}
      <label className="flex items-center rounded-md border border-border bg-bg px-2 focus-within:ring-1 focus-within:ring-focus-ink-60">
        <span className="font-mono-keep text-[12px] text-muted-70">/</span>
        <input
          aria-label="Command name"
          autoFocus
          value={draft.name}
          onChange={(e) => onChange({ ...draft, name: e.target.value })}
          onKeyDown={(e) => e.key === "Enter" && onSave()}
          placeholder="name"
          spellCheck={false}
          autoComplete="off"
          className="w-full bg-transparent py-1 font-mono-keep text-[12px] text-fg outline-none placeholder:text-muted-50"
        />
      </label>
      <input
        aria-label="Command description"
        value={draft.description}
        onChange={(e) => onChange({ ...draft, description: e.target.value })}
        onKeyDown={(e) => e.key === "Enter" && onSave()}
        placeholder="What it does, shown in the / menu"
        autoComplete="off"
        className="w-full rounded-md border border-border bg-bg px-2 py-1 text-[12px] text-fg outline-none placeholder:text-muted-50 focus-visible:ring-1 focus-visible:ring-focus-ink-60"
      />
      <textarea
        data-1p-ignore
        aria-label="Command prompt"
        value={draft.body}
        onChange={(e) => onChange({ ...draft, body: e.target.value })}
        onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && onSave()}
        rows={8}
        placeholder="The prompt it sends. $ARGUMENTS stands for whatever is typed after the name."
        spellCheck={false}
        className="input resize-y text-[12px] leading-relaxed font-mono-keep"
      />
      {confirmingDelete && draft.copiedFrom && (
        <p className="text-[11px] text-danger">
          Deletes <code className="font-mono-keep">{draft.copiedFrom.path}</code> for every tool that reads it.
        </p>
      )}
      {error && <p role="alert" className="text-[11px] text-danger">{error}</p>}
      <div className="flex items-center gap-2">
        <span className="min-w-0 truncate text-[11px] text-muted-70" title={dir}>
          Saved as <code className="font-mono-keep">{name || "name"}.md</code> in ntwine's commands folder
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {onDelete && (
            <button
              type="button"
              onClick={deleteNow}
              disabled={saving}
              className="button-outline rounded-md px-3 py-1 text-[12px] text-danger outline-none transition-colors hover:bg-danger-fill/10 disabled:opacity-60"
            >
              {confirmingDelete ? "Delete the file" : "Delete"}
            </button>
          )}
          <button
            type="button"
            onClick={onCancel}
            className="button-outline rounded-md px-3 py-1 text-[12px] text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={saving}
            className="button-outline rounded-md border border-border px-3 py-1 text-[12px] text-fg outline-none transition-colors hover:bg-panel-2 disabled:opacity-60"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </span>
      </div>
    </div>
  )
}
