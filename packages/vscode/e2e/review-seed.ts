// A THREAD THAT WORKED IN A WORKTREE, seeded into a disposable ntwine (e2e/stack.ts) the ntwine-stack way —
// a session row and a JSONL transcript the REAL server reads, never a worker. Its agent moved into
// `.ntwine/worktrees/<branch>` and edited files there with its tools, so the server's whole chain is the
// thing under test: the transcript's edits read as the rail's edited files (which, before 11f327a0, came
// back EMPTY for a worktree, `.ntwine/` being ignored from the project root), the worktree as the thread's
// checkout, and the review pushed over the editor bridge to the window that has the project open.
//
// Runs in the harness (Node), never inside the editor.

import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { seedReviewRepo, type ReviewRepo } from "./review-repo.ts"

export interface SeededReview {
  slug: string
  title: string
  sessionId: string
  repo: ReviewRepo
}

const q = (value: string) => `'${value.replace(/'/gu, "''")}'`

export function seedReviewThread(options: { home: string; project: { id: string; dir: string }; log(line: string): void }): SeededReview {
  const { home, project } = options
  const repo = seedReviewRepo(project.dir)
  const seeded: SeededReview = { slug: "tidy-the-loop", title: "Tidy the loop", sessionId: "e2e7e71e-0000-4000-8000-00000000e71e", repo }

  // Claude Code files a session under the folder it STARTED in (the project), and stamps each record with
  // the folder it is in NOW — the worktree, once the agent has moved there.
  const transcripts = join(home, ".claude", "projects", project.dir.replace(/[/.]/gu, "-"))
  mkdirSync(transcripts, { recursive: true })
  const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
  const records: unknown[] = [
    { type: "user", sessionId: seeded.sessionId, cwd: project.dir, timestamp: at(30), message: { role: "user", content: [{ type: "text", text: "Tidy the loop, in a worktree of your own" }] } },
  ]
  // Oldest edit first, so the last one written is the newest — the order the rail lists them in reverse.
  for (const [i, file] of [...repo.edited].reverse().entries()) {
    const id = `toolu_e2e_edit_${i}`
    records.push(
      { type: "assistant", sessionId: seeded.sessionId, cwd: repo.worktree, timestamp: at(20 - i), message: { role: "assistant", id: `m-edit-${i}`, content: [{ type: "tool_use", id, name: "Write", input: { file_path: file, content: "…" } }], usage: { input_tokens: 2, output_tokens: 10 } } },
      { type: "user", sessionId: seeded.sessionId, cwd: repo.worktree, timestamp: at(20 - i), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: `The file ${file} has been updated successfully.` }] } },
    )
  }
  records.push({ type: "assistant", sessionId: seeded.sessionId, cwd: repo.worktree, timestamp: at(5), message: { role: "assistant", id: "m-done", stop_reason: "end_turn", content: [{ type: "text", text: "**Done** — the loop is a reduce now, on the `tidy-the-loop` branch." }], usage: { input_tokens: 2, output_tokens: 20 } } })
  writeFileSync(join(transcripts, `${seeded.sessionId}.jsonl`), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`)

  execFileSync("sqlite3", ["-cmd", ".timeout 10000", join(home, ".ntwine", "ui.db"),
    `INSERT OR REPLACE INTO session (project_id, slug, session_id, thread_name, spawned_at, title, title_auto, backend, claude_runtime, model, effort, permission_mode, state, unread, exited, archived, rested_at)
     VALUES (${q(project.id)}, ${q(seeded.slug)}, ${q(seeded.sessionId)}, ${q(`ntwine-${seeded.slug}`)}, ${q(at(31))}, ${q(seeded.title)}, 0, 'claude', 'broker', 'opus', 'high', 'default', 'open', 1, 1, 0, ${q(at(5))})`])
  options.log(`seeded ${seeded.slug}: a thread that edited ${repo.edited.length} files in ${repo.worktree}`)
  return seeded
}
