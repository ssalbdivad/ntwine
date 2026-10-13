// WHICH NTWINE PROJECT A FILE BELONGS TO. The server pushes every registered project with the folder its
// agents run in (`dir`); a file belongs to the project whose folder holds it — the LONGEST such folder,
// since projects nest (a repo checked out inside another's tree) — and to Home only when no registered
// project holds it, because Home's folder is the home directory and holds nearly everything. This is the
// server's own rule (router.ts `enclosingProject`).
//
// The file is compared by its REAL path as well as by the spelling the editor gave: a workspace opened
// through a symlink names files the server knows only by their canonical path. Both spellings are tried
// against both spellings of each project folder, and the spelling that matched is the one returned, so
// the relative path shown to the agent is the project-relative one.
//
// Windows compares without case and with either separator, as Windows itself does.

import { realpathSync } from "node:fs"
import type { EditorProject } from "@ntwine/shared/editor-protocol"

export interface MatchOptions {
  realpath?: (path: string) => string
  platform?: NodeJS.Platform
}

export interface ProjectMatch {
  project: EditorProject
  /** The file's spelling that sits under `project.dir` (its real path when that is what matched). */
  path: string
  /** `path` relative to the project folder, in the path's own separators; "" for the folder itself. */
  relative: string
}

function safeRealpath(realpath: (path: string) => string, path: string): string | undefined {
  try {
    return realpath(path)
  } catch {
    return undefined
  }
}

function comparable(path: string, platform: NodeJS.Platform): string {
  const trimmed = path.length > 1 ? path.replace(/[\\/]+$/u, "") || path : path
  return platform === "win32" ? trimmed.replaceAll("/", "\\").toLowerCase() : trimmed
}

/** `path` relative to `dir` when `dir` holds it (or is it), else undefined. */
export function relativeWithin(dir: string, path: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const sep = platform === "win32" ? "\\" : "/"
  const parent = comparable(dir, platform)
  const child = comparable(path, platform)
  if (child === parent) return ""
  const prefix = parent.endsWith(sep) ? parent : parent + sep
  if (!child.startsWith(prefix)) return undefined
  // Slice the ORIGINAL spelling so the remainder keeps its own case and separators.
  const trimmedChild = path.length > 1 ? path.replace(/[\\/]+$/u, "") || path : path
  return trimmedChild.slice(prefix.length)
}

function spellings(path: string, realpath: (path: string) => string): string[] {
  const real = safeRealpath(realpath, path)
  return real && real !== path ? [real, path] : [path]
}

/** The project a file (or folder) belongs to, or undefined when not even Home's folder holds it. */
export function projectForPath(path: string, projects: readonly EditorProject[], options: MatchOptions = {}): ProjectMatch | undefined {
  const realpath = options.realpath ?? realpathSync.native
  const platform = options.platform ?? process.platform
  const files = spellings(path, realpath)
  let best: (ProjectMatch & { depth: number }) | undefined
  let home: ProjectMatch | undefined
  for (const project of projects) {
    for (const dir of spellings(project.dir, realpath)) {
      for (const file of files) {
        const relative = relativeWithin(dir, file, platform)
        if (relative === undefined) continue
        if (project.home) {
          home ??= { project, path: file, relative }
          continue
        }
        const depth = comparable(dir, platform).length
        if (!best || depth > best.depth) best = { project, path: file, relative, depth }
      }
    }
  }
  if (best) return { project: best.project, path: best.path, relative: best.relative }
  return home
}

/**
 * The projects a window's workspace folders are about, for the status bar: every project whose folder a
 * workspace folder holds (a folder of several checkouts), else the project that holds the workspace
 * folder. Home counts only for a folder no registered project explains.
 */
export function workspaceProjects(folders: readonly string[], projects: readonly EditorProject[], options: MatchOptions = {}): EditorProject[] {
  const realpath = options.realpath ?? realpathSync.native
  const platform = options.platform ?? process.platform
  const out = new Map<string, EditorProject>()
  for (const folder of folders) {
    const inside = projects.filter((project) => !project.home && spellings(project.dir, realpath).some((dir) =>
      spellings(folder, realpath).some((root) => relativeWithin(root, dir, platform) !== undefined)))
    const found = inside.length ? inside : [projectForPath(folder, projects, options)?.project].filter((p): p is EditorProject => !!p)
    for (const project of found) out.set(project.id, project)
  }
  return [...out.values()]
}
