// THE WORKSPACE'S FILES, FOR THE SIDEBAR'S PROMPT — the glue between VS Code and file-picks.ts.
//
// The page asks (`ntwine:pick-context`) in two ways and this answers both with `ntwine:context-picks`:
//
//  - `@` typed in a prompt box: `query` is what follows it. An empty one is answered with the files open
//    in tabs (the active one first), which is what an `@` with nothing after it most often means; a query
//    is ranked over the index below (file-picks.ts rankFiles), open files first within a rank.
//  - files dragged in from the explorer (with Shift held — VS Code lets a webview have a drop only then,
//    as Claude Code's extension tells its users): `uris` as the drag carried them, each resolved to a file
//    or folder on disk. A `vscode-remote:` URI is the window's own resource seen from the renderer (WSL,
//    SSH, a dev container); the extension host runs on that side, so its path is a path here.
//
// THE INDEX. Built on first ask, per workspace folder: git's list where the folder is in a repository
// (tracked, plus untracked that are not ignored), findFiles anywhere else; then `files.exclude` and
// `search.exclude` from that folder's settings (file-picks.ts says why each). Kept until a file is created
// or deleted, an exclude setting changes, or a folder comes or goes — and then rebuilt on the next ask
// rather than on the event, since a build writing a thousand files would otherwise list the workspace a
// thousand times; and not more often than REBUILD_MS while files keep changing, the last list answering
// meanwhile. Capped at MAX_FILES a folder: a workspace past that is answered from the first MAX_FILES.
//
// Every answered file is spelled the way the projects spell it (projects.ts projectForPath), so the
// reference the page writes is the path an agent in that project reads.
//
// Only `import type` from vscode, like app.ts.

import { execFile } from "node:child_process"
import { stat } from "node:fs/promises"
import { relative, sep } from "node:path"
import type * as vscode from "vscode"
import type { EditorProject } from "@ntwine/shared/editor-protocol"
import { EMBED_MAX_PICKS, type EmbedPickContextMessage, type EmbedPickedFile } from "@ntwine/shared/embed-protocol"
import { fileLabel } from "./editor-context.ts"
import { enabledPatterns, globMatcher, normalizeQuery, rankFiles, type IndexedFile } from "./file-picks.ts"
import { projectForPath } from "./projects.ts"

type Vscode = typeof vscode

/** Files one workspace folder contributes at most. */
const MAX_FILES = 200_000
/** The least time between two builds of the index while files keep changing. */
const REBUILD_MS = 3_000
const GIT_TIMEOUT_MS = 15_000

export interface WorkspaceFiles {
  /** The answer to a `ntwine:pick-context`: the files a query names, or the dropped resources on disk. */
  pick(message: EmbedPickContextMessage): Promise<EmbedPickedFile[]>
}

function gitFiles(root: string): Promise<string[] | undefined> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { encoding: "utf8", maxBuffer: 512 * 1024 * 1024, timeout: GIT_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => resolve(error ? undefined : stdout.split("\0").filter(Boolean)),
    )
  })
}

export function registerWorkspaceFiles(api: Vscode, context: vscode.ExtensionContext, host: { projects(): readonly EditorProject[] }): WorkspaceFiles {
  let files: IndexedFile[] | undefined
  let building: Promise<IndexedFile[]> | undefined
  let builtAt = 0
  let stale = true

  const multiRoot = () => (api.workspace.workspaceFolders?.length ?? 0) > 1
  const labelOf = (fsPath: string) => fileLabel(fsPath, api.workspace.asRelativePath(api.Uri.file(fsPath), multiRoot()))

  async function listFolder(folder: vscode.WorkspaceFolder): Promise<IndexedFile[]> {
    const root = folder.uri.fsPath
    const excluded = globMatcher([
      ...enabledPatterns(api.workspace.getConfiguration("files", folder.uri).get("exclude")),
      ...enabledPatterns(api.workspace.getConfiguration("search", folder.uri).get("exclude")),
    ])
    let relatives = await gitFiles(root)
    if (!relatives) {
      // `undefined` exclude: findFiles applies files.exclude itself; search.exclude is applied below.
      const found = await api.workspace.findFiles(new api.RelativePattern(folder, "**/*"), undefined, MAX_FILES)
      relatives = found.map((uri) => relative(root, uri.fsPath).split(sep).join("/"))
    }
    const prefix = multiRoot() ? `${folder.name}/` : ""
    const out: IndexedFile[] = []
    const seen = new Set<string>()
    for (const rel of relatives) {
      // git lists a path twice while it has a merge conflict (one per stage).
      if (seen.has(rel) || excluded(rel)) continue
      seen.add(rel)
      out.push({ path: root + sep + rel.split("/").join(sep), label: prefix + rel })
      if (out.length >= MAX_FILES) break
    }
    return out
  }

  function index(): Promise<IndexedFile[]> {
    if (building) return building
    if (files && (!stale || Date.now() - builtAt < REBUILD_MS)) return Promise.resolve(files)
    stale = false
    const folders = (api.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === "file")
    building = Promise.all(folders.map((folder) => listFolder(folder).catch(() => [] as IndexedFile[])))
      .then((lists) => {
        files = lists.flat()
        builtAt = Date.now()
        return files
      })
      .finally(() => {
        building = undefined
      })
    return building
  }

  const invalidate = () => {
    stale = true
  }
  const watcher = api.workspace.createFileSystemWatcher("**/*", false, true, false)
  context.subscriptions.push(
    watcher,
    watcher.onDidCreate(invalidate),
    watcher.onDidDelete(invalidate),
    api.workspace.onDidChangeWorkspaceFolders(invalidate),
    api.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("files.exclude") || event.affectsConfiguration("search.exclude")) invalidate()
    }),
  )

  /** The files open in tabs: the active group's active tab first, then the rest in tab order. */
  function openTabs(): string[] {
    const groups = api.window.tabGroups
    const ordered = [groups.activeTabGroup, ...groups.all.filter((group) => group !== groups.activeTabGroup)]
    const paths: string[] = []
    for (const group of ordered) {
      const tabs = group.activeTab ? [group.activeTab, ...group.tabs.filter((tab) => tab !== group.activeTab)] : group.tabs
      for (const tab of tabs) {
        const input = tab.input
        if (!(input instanceof api.TabInputText) || input.uri.scheme !== "file") continue
        if (!paths.includes(input.uri.fsPath)) paths.push(input.uri.fsPath)
      }
    }
    return paths
  }

  function picked(fsPath: string, label: string, folder = false): EmbedPickedFile {
    const match = projectForPath(fsPath, host.projects())
    return { path: match?.path ?? fsPath, label, ...(match ? { projectId: match.project.id } : {}), ...(folder ? { folder: true as const } : {}) }
  }

  /** A dropped resource as a path on this side, or undefined for one that is not on disk (an untitled buffer, a git: view). */
  function dropped(raw: string): string | undefined {
    let uri: vscode.Uri
    try {
      uri = api.Uri.parse(raw, true)
    } catch {
      return undefined
    }
    if (uri.scheme === "file") return uri.fsPath
    if (uri.scheme === "vscode-remote" && api.env.remoteName) return api.Uri.file(uri.path).fsPath
    return undefined
  }

  return {
    async pick(message) {
      if (message.uris) {
        const out: EmbedPickedFile[] = []
        for (const raw of message.uris) {
          const fsPath = dropped(raw)
          if (!fsPath) continue
          try {
            const info = await stat(fsPath)
            if (info.isFile() || info.isDirectory()) out.push(picked(fsPath, labelOf(fsPath), info.isDirectory()))
          } catch {
            // Gone since the drag began: nothing to name.
          }
        }
        return out
      }
      const query = message.query ?? ""
      const tabs = openTabs()
      if (!normalizeQuery(query)) return tabs.slice(0, EMBED_MAX_PICKS).map((fsPath) => picked(fsPath, labelOf(fsPath)))
      const ranked = rankFiles(await index(), query, new Set(tabs), EMBED_MAX_PICKS)
      return ranked.map((file) => picked(file.path, file.label))
    },
  }
}
