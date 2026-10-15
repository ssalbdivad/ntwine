import { useQuery } from "@tanstack/react-query"
import { useThreadApi, useThreadProjectId } from "../api/threadApi.tsx"
import { Select } from "./ui/Select.tsx"

// WHERE A TOP-LEVEL TERMINAL STARTS (plans/terminal-threads.md § Worktrees): the prompt box's pill while its
// line is a `$` command, in the model picker's place. The project root, then every `.ntwine/worktrees/*`
// checkout by name — ntwine chooses no worktree for anyone, it only lists where one already is. Value
// undefined is the root, which is where a terminal starts unless the human picks otherwise.
export function TerminalFolderPicker({ value, onValueChange }: { value: string | undefined; onValueChange: (dir: string | undefined) => void }) {
  const api = useThreadApi()
  const projectId = useThreadProjectId()
  const folders = useQuery({
    queryKey: projectId ? ["terminalFolders", { project: projectId }] : ["terminalFolders"],
    queryFn: () => api.terminalFolders(),
    staleTime: 10_000,
  })
  const list = folders.data ?? []
  const root = list.find((folder) => folder.kind === "root")
  const options = list.map((folder) => ({
    value: folder.kind === "root" ? "" : folder.dir,
    label: folder.kind === "root" ? "Project root" : folder.label,
    title: folder.dir,
  }))
  // A pick from a list that no longer has it (the worktree was removed) reads as the root.
  const current = value && list.some((folder) => folder.dir === value) ? value : ""
  return (
    <Select
      variant="readout"
      value={current}
      onValueChange={(dir) => onValueChange(dir || undefined)}
      options={options.length ? options : [{ value: "", label: "Project root" }]}
      ariaLabel="Folder to run in"
      title={current || root?.dir ? `Runs in ${current || root?.dir}` : "Runs in the project root"}
      className="max-w-[min(16rem,60vw)] px-2 py-1"
    />
  )
}
