// TWO COMMITS' CHANGES, FOR AN AGENT — what `ntwinectl editor-compare` opens in the human's editor: a pull
// request's changes, or any two commits'. The wire: @ntwine/shared editor-protocol.ts `compare`.
//
// The agent resolved the PR with `gh` and fetched both commits into its checkout (`dir`), so everything
// here is read-only git in that checkout. Two ways to show it:
//
//   · GitLens, when it is installed (or asked for): its own deep link, `<scheme>://eamodio.gitlens/link/
//     r/-/compare/<base>...<head>?url=<remote>`, which opens a comparison in its Search & Compare view
//     (the shape GitLens 19.6 generates for "Copy link to comparison"; `-` lets it find the repository by
//     the remote). Tried by hand on 2026-11-17 against slashfi/slash#24817: "Comparing 6401473 with
//     184f588", 23 ahead, 0 behind — base first is the right way round. `env.openExternal` with the
//     editor's own scheme is handled by the window that calls it, so it lands here, not in whichever
//     window the OS picks (which is what `open vscode://…` from a shell does).
//   · Otherwise VS Code's own multi-file diff (`vscode.changes`), as "Review changes" opens a thread's
//     (review-view.ts) — but BOTH sides read out of git through the `ntwine-base:` provider, since the head
//     is usually not what the checkout has on disk. The changes are head's since its merge base with base,
//     which is what a pull request shows.
//
// It can only SHOW a diff: no command is run on the agent's say-so, and nothing is checked out.
//
// Only `import type` from vscode, like app.ts.

import path from "node:path"
import type * as vscode from "vscode"
import type { EditorCompareTarget } from "@ntwine/shared/editor-protocol"
import { BASE_SCHEME, REVIEW_MAX_ENTRIES, baseQuery, parseBinary, parseNameStatus, runGit, type Git } from "./review.ts"

type Vscode = typeof vscode

export const GITLENS_ID = "eamodio.gitlens"

export interface CompareEntry {
  status: "modified" | "added" | "deleted" | "renamed"
  /** At the head, relative to the top level (`/`); a deleted file's path at the base. */
  rel: string
  /** At the merge base; absent for an added file. */
  baseRel?: string
}

export interface ComparePlan {
  top: string
  mergeBase: string
  entries: CompareEntry[]
  /** Changed binary files (relative), left out of the diff. */
  binary: string[]
  /** Changed files past REVIEW_MAX_ENTRIES, left out. */
  more: number
  /** The `origin` remote's URL (else the first remote's), which GitLens finds the repository by. */
  remote?: string
}

async function attempt(git: Git, args: readonly string[], cwd: string): Promise<string | undefined> {
  try {
    return (await git(args, cwd)).trim()
  } catch {
    return undefined
  }
}

/** What to show for `target`, or why it cannot be shown in words the agent reads back. */
export async function planCompare(target: Pick<EditorCompareTarget, "dir" | "base" | "head">, git: Git = runGit): Promise<ComparePlan | { error: string }> {
  const top = await attempt(git, ["rev-parse", "--show-toplevel"], target.dir)
  if (!top) return { error: `${target.dir} isn't a git repository the editor can read.` }
  for (const sha of [target.base, target.head]) {
    if ((await attempt(git, ["cat-file", "-e", `${sha}^{commit}`], top)) === undefined) {
      return { error: `Commit ${sha.slice(0, 7)} isn't in ${top}. Fetch it there first (\`git fetch origin ${sha}\`).` }
    }
  }
  const mergeBase = await attempt(git, ["merge-base", target.base, target.head], top)
  if (!mergeBase) return { error: `${target.base.slice(0, 7)} and ${target.head.slice(0, 7)} share no history.` }
  const all = parseNameStatus(await git(["diff", "--name-status", "-z", "-M", mergeBase, target.head], top))
  const binary = parseBinary(await git(["diff", "--numstat", "-z", "-M", mergeBase, target.head], top))
  const text = all.filter((entry) => !binary.has(entry.rel) && !(entry.baseRel && binary.has(entry.baseRel)))
  const remotes = ((await attempt(git, ["remote"], top)) ?? "").split("\n").filter(Boolean)
  const name = remotes.includes("origin") ? "origin" : remotes[0]
  const remote = name ? await attempt(git, ["remote", "get-url", name], top) : undefined
  return {
    top,
    mergeBase,
    entries: text.slice(0, REVIEW_MAX_ENTRIES),
    binary: [...binary],
    more: Math.max(0, text.length - REVIEW_MAX_ENTRIES),
    ...(remote ? { remote } : {}),
  }
}

/** GitLens's comparison link: `base...head`, the way round its own "Copy link to comparison" writes. */
export function gitLensCompareLink(scheme: string, base: string, head: string, remote: string | undefined): { scheme: string; authority: string; path: string; query: string } {
  return { scheme, authority: GITLENS_ID, path: `/link/r/-/compare/${base}...${head}`, query: remote ? `url=${remote}` : "" }
}

/** The last comparison this window opened, for the end-to-end suite. */
export interface CompareSnapshot {
  view: "gitlens" | "diff"
  title: string
  /** The GitLens link, or the diff's `[label, left, right]` URIs. */
  link?: string
  resources?: { label: string; original?: string; modified?: string }[]
}

export interface Compares {
  open(target: EditorCompareTarget): Promise<{ ok: boolean; error?: string }>
  last(): CompareSnapshot | undefined
}

/** Needs registerReviews' `ntwine-base:` content provider, which reads either side out of git. */
export function registerCompares(api: Vscode, log: { info(line: string): void; warn(line: string): void }): Compares {
  let last: CompareSnapshot | undefined

  async function open(target: EditorCompareTarget): Promise<{ ok: boolean; error?: string }> {
    const plan = await planCompare(target)
    if ("error" in plan) {
      log.warn(`Comparing ${target.title}: ${plan.error}`)
      return { ok: false, error: plan.error }
    }
    const gitLens = api.extensions.getExtension(GITLENS_ID) !== undefined
    if (target.view === "gitlens" && !gitLens) return { ok: false, error: "GitLens isn't installed in this editor." }
    if (target.view !== "diff" && gitLens) {
      const uri = api.Uri.from(gitLensCompareLink(api.env.uriScheme, target.base, target.head, plan.remote))
      if (!(await api.env.openExternal(uri))) return { ok: false, error: "GitLens didn't take the comparison link." }
      last = { view: "gitlens", title: target.title, link: uri.toString(true) }
      log.info(`Comparing ${target.title} in GitLens: ${target.base.slice(0, 7)}...${target.head.slice(0, 7)} in ${plan.top}.`)
      return { ok: true }
    }
    if (plan.entries.length === 0) {
      return { ok: false, error: plan.binary.length ? "Only binary files changed, and the diff shows text." : "Nothing changed between those commits." }
    }
    const side = (sha: string, rel: string) =>
      api.Uri.file(path.join(plan.top, ...rel.split("/"))).with({ scheme: BASE_SCHEME, query: baseQuery({ top: plan.top, base: sha, basePath: rel }) })
    const resources: [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined][] = plan.entries.map((entry) => [
      api.Uri.file(path.join(plan.top, ...entry.rel.split("/"))),
      entry.baseRel === undefined ? undefined : side(plan.mergeBase, entry.baseRel),
      entry.status === "deleted" ? undefined : side(target.head, entry.rel),
    ])
    await api.commands.executeCommand("vscode.changes", target.title, resources)
    last = {
      view: "diff",
      title: target.title,
      resources: resources.map(([label, original, modified]) => ({ label: label.toString(), ...(original ? { original: original.toString() } : {}), ...(modified ? { modified: modified.toString() } : {}) })),
    }
    const left = [plan.binary.length ? `${plan.binary.length} binary left out` : "", plan.more ? `${plan.more} more past the first ${plan.entries.length}` : ""].filter(Boolean).join(", ")
    log.info(`Comparing ${target.title}: ${plan.entries.length} file${plan.entries.length === 1 ? "" : "s"} in ${plan.top}, ${plan.mergeBase.slice(0, 7)}..${target.head.slice(0, 7)}${left ? ` (${left})` : ""}.`)
    return { ok: true }
  }

  return { open, last: () => last }
}
