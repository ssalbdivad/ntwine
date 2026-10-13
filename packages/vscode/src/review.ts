// A THREAD'S CHANGES, AS GIT TELLS THEM — what "Review changes" opens as VS Code's multi-file diff, the
// pure half (no `vscode`; review-view.ts is the glue and the content provider). Ntwine names WHICH
// checkouts the thread changed (server review-target.ts, `EditorReviewCheckout`); this asks git, in each,
// what to compare against and which files differ. Design: ARCHITECTURE.md § VS Code
// extension.
//
// THE BASE. Ntwine records nothing about where a thread started, so it is read off git:
//
//   "files" — the project folder, which several agents and the human share. Its review is the thread's
//     own files against HEAD: their uncommitted changes. Nothing else changed in that tree is the
//     thread's to show, and a commit there carries other people's work as readily as this thread's.
//   "branch" — a worktree, the thread's own. Its review is everything since its branch LEFT the branch it
//     came from, committed or not. Candidates, each turned into a merge-base with HEAD:
//       · where the branch was created — the oldest entry of its reflog, "branch: Created from X", which
//         `git worktree add -b <slug> <path> [start]` writes. It survives the branch being merged back,
//         after which every tip below already holds HEAD and can say nothing;
//       · X itself when X names a branch (`… main`), at its CURRENT tip: a thread that merged X in since
//         has a newer merge-base with it, and the files X brought are not the thread's;
//       · the branch the project folder (the main worktree) is on, for a branch made from a bare commit
//         or one whose reflog is gone.
//     A tip that already contains HEAD (the thread's branch merged into it) is skipped, and of the rest
//     the base with the FEWEST commits to HEAD wins: the nearest point the thread's own work starts from.
//     None at all (a detached worktree made from a commit, no main branch): HEAD, its uncommitted changes.
//
// THE FILES. `git diff <base>` compares the base with the WORKING TREE, so committed, staged and unsaved-
// to-git edits all show, with renames paired (branch scope); untracked files the checkout does not ignore
// join them as added. Binary files are listed apart: the diff editor shows text, and a PNG as text is
// noise. Every git call is read-only and takes no optional lock (GIT_OPTIONAL_LOCKS=0), since the tree it
// reads is often one other agents are writing in.

import { execFile } from "node:child_process"
import { open, realpath } from "node:fs/promises"
import path from "node:path"
import type { EditorReviewCheckout } from "@ntwine/shared/editor-protocol"

export type Git = (args: readonly string[], cwd: string) => Promise<string>

export const runGit: Git = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile("git", [...args], { cwd, encoding: "utf8", maxBuffer: 64 << 20, env: { ...process.env, LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" } }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })

/** At most this many files in one checkout's review; the rest are counted, not shown. */
export const REVIEW_MAX_ENTRIES = 500

export interface ReviewEntry {
  /** Where the file is — or, deleted, was — in the working tree: absolute. The diff's label and right side. */
  path: string
  status: "modified" | "added" | "deleted" | "renamed"
  /** Its path at the base, relative to the checkout's top level with `/` separators; absent for an added file. */
  basePath?: string
}

export interface CheckoutReview {
  /** The checkout's top level, as git spells it. */
  top: string
  scope: EditorReviewCheckout["scope"]
  /** The commit the left side shows. */
  base: string
  /** Where the base came from, in words for the log: "where tidy started", "where it left main", "the last commit". */
  baseNote: string
  entries: ReviewEntry[]
  /** Changed binary files (absolute), left out of the diff. */
  binary: string[]
  /** Changed files past REVIEW_MAX_ENTRIES, left out. */
  more: number
}

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u

async function attempt(git: Git, args: readonly string[], cwd: string): Promise<string | undefined> {
  try {
    return (await git(args, cwd)).trim()
  } catch {
    return undefined
  }
}

/** `file` relative to `top` in git's own terms (`/`), through real paths; undefined when it is not inside. */
async function relativeTo(top: string, file: string): Promise<string | undefined> {
  let real = file
  try {
    real = await realpath(file)
  } catch {
    // Deleted: its folder's real path, or as written.
    try {
      real = path.join(await realpath(path.dirname(file)), path.basename(file))
    } catch {}
  }
  const rel = path.relative(top, real)
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return undefined
  return rel.split(path.sep).join("/")
}

/** The branch the main worktree (the project folder) has checked out, from `git worktree list --porcelain`. */
export function mainWorktreeBranch(porcelain: string): string | undefined {
  const first = porcelain.split(/\n\n/u)[0] ?? ""
  return /^branch refs\/heads\/(.+)$/mu.exec(first)?.[1]
}

/** The oldest reflog entry of a branch, when it records the branch's creation: where, and from what. */
export function creationOf(reflog: string): { sha: string; from: string } | undefined {
  const oldest = reflog.trim().split("\n").at(-1) ?? ""
  const match = /^([0-9a-f]+)\tbranch: Created from (.+)$/u.exec(oldest)
  return match && SHA.test(match[1]!) ? { sha: match[1]!, from: match[2]!.trim() } : undefined
}

/** See the header: the nearest point a worktree branch's own work starts from. */
export async function branchBase(top: string, head: string, git: Git = runGit): Promise<{ base: string; note: string }> {
  type Candidate = { sha?: string; ref?: string; note: string }
  const candidates: Candidate[] = []
  const branch = await attempt(git, ["symbolic-ref", "-q", "--short", "HEAD"], top)
  if (branch) {
    const created = creationOf((await attempt(git, ["reflog", "show", "--format=%H%x09%gs", `refs/heads/${branch}`, "--"], top)) ?? "")
    if (created) {
      candidates.push({ sha: created.sha, note: `where ${branch} started` })
      if (created.from !== "HEAD" && !/^[0-9a-f]{7,64}$/u.test(created.from)) candidates.push({ ref: created.from, note: `where it left ${created.from}` })
    }
  }
  const main = mainWorktreeBranch((await attempt(git, ["worktree", "list", "--porcelain"], top)) ?? "")
  if (main && main !== branch) candidates.push({ ref: main, note: `where it left ${main}` })

  let best: { base: string; note: string; count: number } | undefined
  for (const candidate of candidates) {
    const sha = candidate.sha ?? (candidate.ref ? await attempt(git, ["rev-parse", "--verify", "-q", `${candidate.ref}^{commit}`], top) : undefined)
    if (!sha) continue
    // A branch that already holds HEAD — the thread's work merged into it — says nothing about where that
    // work started: its merge-base with HEAD is HEAD.
    if (candidate.ref && (await attempt(git, ["merge-base", "--is-ancestor", head, sha], top)) !== undefined) continue
    const base = await attempt(git, ["merge-base", head, sha], top)
    if (!base) continue
    const count = Number(await attempt(git, ["rev-list", "--count", `${base}..${head}`], top))
    if (!Number.isFinite(count)) continue
    if (!best || count < best.count) best = { base, note: candidate.note, count }
  }
  return best ? { base: best.base, note: best.note } : { base: head, note: "the last commit" }
}

/** `git diff --name-status -z` → entries, relative paths. */
export function parseNameStatus(out: string): { status: ReviewEntry["status"]; rel: string; baseRel?: string }[] {
  const tokens = out.split("\0")
  const entries: { status: ReviewEntry["status"]; rel: string; baseRel?: string }[] = []
  for (let i = 0; i < tokens.length; ) {
    const code = tokens[i++]
    if (!code) continue
    const letter = code[0]
    if (letter === "R" || letter === "C") {
      const from = tokens[i++]!
      const to = tokens[i++]!
      // A copy leaves its source where it was: the new file, shown against what it was copied from.
      entries.push({ status: letter === "R" ? "renamed" : "added", rel: to, baseRel: from })
      continue
    }
    const rel = tokens[i++]!
    if (letter === "A") entries.push({ status: "added", rel })
    else if (letter === "D") entries.push({ status: "deleted", rel, baseRel: rel })
    else entries.push({ status: "modified", rel, baseRel: rel })
  }
  return entries
}

/** `git diff --numstat -z` → the relative paths it calls binary (`-\t-`). */
export function parseBinary(out: string): Set<string> {
  const binary = new Set<string>()
  const tokens = out.split("\0")
  for (let i = 0; i < tokens.length; ) {
    const token = tokens[i++]!
    if (!token) continue
    const [added, removed, rel] = token.split("\t")
    // A rename's record is `a\td\t` followed by the two paths as tokens of their own.
    const paths = rel === "" ? [tokens[i++]!, tokens[i++]!] : [rel!]
    if (added === "-" && removed === "-") for (const p of paths) binary.add(p)
  }
  return binary
}

/** Git's own test for a binary file: a NUL in its first 8000 bytes. */
async function looksBinary(file: string): Promise<boolean> {
  let handle
  try {
    handle = await open(file, "r")
    const buffer = Buffer.alloc(8000)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead).includes(0)
  } catch {
    return false
  } finally {
    await handle?.close()
  }
}

/**
 * One checkout's review, or why there is none in words a toast can show. An empty `entries` is a real
 * answer — nothing changed — which the caller words for the whole review.
 */
export async function reviewCheckout(checkout: EditorReviewCheckout, git: Git = runGit): Promise<CheckoutReview | { error: string }> {
  const top = await attempt(git, ["rev-parse", "--show-toplevel"], checkout.dir)
  if (!top) return { error: `${checkout.dir} isn't a git repository, so there is nothing to compare it with.` }
  const head = await attempt(git, ["rev-parse", "--verify", "-q", "HEAD^{commit}"], top)
  if (!head) return { error: `${path.basename(top)} has no commits yet, so there is nothing to compare it with.` }

  let pathspec: string[] = []
  if (checkout.scope === "files") {
    const rels = new Set<string>()
    for (const file of checkout.files) {
      const rel = await relativeTo(top, file)
      if (rel) rels.add(rel)
    }
    if (rels.size === 0) return { top, scope: checkout.scope, base: head, baseNote: "the last commit", entries: [], binary: [], more: 0 }
    // Literal pathspecs: a file named `*.ts` or `:(top)` is that file, not a pattern.
    pathspec = ["--", ...[...rels].map((rel) => `:(literal)${rel}`)]
  }
  const { base, note } = checkout.scope === "branch" ? await branchBase(top, head, git) : { base: head, note: "the last commit" }

  // Renames are paired only for a whole branch: against a list of files, git would pair one of them with
  // a file outside the list.
  const renames = checkout.scope === "branch" ? ["-M"] : ["--no-renames"]
  let changed: ReturnType<typeof parseNameStatus>
  let binaryRels: Set<string>
  let untracked: string[]
  try {
    changed = parseNameStatus(await git(["diff", "--name-status", "-z", ...renames, base, ...pathspec], top))
    binaryRels = parseBinary(await git(["diff", "--numstat", "-z", ...renames, base, ...pathspec], top))
    untracked = (await git(["ls-files", "--others", "--exclude-standard", "-z", ...pathspec], top)).split("\0").filter(Boolean)
  } catch (error) {
    return { error: `Git couldn't list the changes in ${path.basename(top)}: ${firstLine(error)}` }
  }
  const absolute = (rel: string) => path.join(top, ...rel.split("/"))
  const all = [
    ...changed.map((entry) => ({ ...entry, binary: binaryRels.has(entry.rel) })),
    ...(await Promise.all(untracked.map(async (rel) => ({ status: "added" as const, rel, baseRel: undefined, binary: await looksBinary(absolute(rel)) })))),
  ].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))

  const entries: ReviewEntry[] = []
  const binary: string[] = []
  let more = 0
  for (const entry of all) {
    if (entry.binary) {
      binary.push(absolute(entry.rel))
      continue
    }
    if (entries.length >= REVIEW_MAX_ENTRIES) {
      more++
      continue
    }
    entries.push({ path: absolute(entry.rel), status: entry.status, ...(entry.baseRel === undefined ? {} : { basePath: entry.baseRel }) })
  }
  return { top, scope: checkout.scope, base, baseNote: note, entries, binary, more }
}

function firstLine(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr
  const text = typeof stderr === "string" && stderr.trim() ? stderr : (error as Error).message ?? String(error)
  return text.trim().split("\n")[0]!.slice(0, 300)
}

/** The base side's text: the file as the base commit has it. */
export async function baseText(top: string, base: string, basePath: string, git: Git = runGit): Promise<string> {
  return git(["cat-file", "blob", `${base}:${basePath}`], top)
}

// ── the base side's address ──────────────────────────────────────────────────────────────────────────
//
// `ntwine-base:<the file's absolute path>?<repo, commit, path at the base>`. The URI's path is the file's,
// so the editor names the tab and picks the language by it; the query is what the content provider reads.

export const BASE_SCHEME = "ntwine-base"

export interface BaseRef {
  top: string
  base: string
  basePath: string
}

export function baseQuery(ref: BaseRef): string {
  return new URLSearchParams({ repo: ref.top, ref: ref.base, path: ref.basePath }).toString()
}

export function parseBaseQuery(query: string): BaseRef | undefined {
  const params = new URLSearchParams(query)
  const top = params.get("repo")
  const base = params.get("ref")
  const basePath = params.get("path")
  if (!top || !path.isAbsolute(top) || !base || !SHA.test(base) || !basePath || basePath.startsWith("/") || basePath.split("/").includes("..")) return undefined
  return { top, base, basePath }
}

/**
 * What the human reads when there is nothing to show — every checkout reviewed and none changed. Said for
 * the scope: a project-folder review is uncommitted changes to the thread's files, and committed ones are
 * exactly what it does not show.
 */
export function nothingToReview(reviews: readonly CheckoutReview[]): string {
  if (reviews.length > 0 && reviews.every((review) => review.scope === "files")) return "The files this thread edited have no uncommitted changes."
  if (reviews.length === 1) return `Nothing has changed in ${path.basename(reviews[0]!.top)} yet.`
  return "Nothing this thread changed is left to compare."
}
