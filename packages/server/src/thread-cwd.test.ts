import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import type { TranscriptMessage } from "@ntwine/shared"
import { checkoutOf, liftCheckout, liftWorkingDir, newestToolWorkdir, newestTranscriptCwd, resetCheckoutMemo, resolveThreadWorkingDir, subAgentFolders, terminalFolder } from "./thread-cwd.ts"

// WHERE A TERMINAL OPENED ON A THREAD STARTS. Real folders and real JSONL files: the reading is the
// newest `cwd` a Claude transcript records (checked against real transcripts — see thread-cwd.ts), lifted
// to the checkout it lies in.

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-cwd-")))
  const project = join(root, "repo")
  mkdirSync(join(project, ".git"), { recursive: true })
  mkdirSync(join(project, "packages", "web", "src"), { recursive: true })
  // A linked worktree: its `.git` is a FILE pointing back at the main checkout's.
  const worktree = join(project, ".ntwine", "worktrees", "fix-auth")
  mkdirSync(join(worktree, "packages", "server"), { recursive: true })
  writeFileSync(join(worktree, ".git"), `gitdir: ${join(project, ".git", "worktrees", "fix-auth")}\n`)
  return { root, project, worktree, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

const record = (over: Record<string, unknown>) => JSON.stringify({ type: "assistant", sessionId: "s", ...over })

test("the newest record with a cwd wins, past bookkeeping records and a sub-agent's", () => {
  const { root, project, worktree, cleanup } = fixture()
  try {
    const path = join(root, "t.jsonl")
    writeFileSync(path, [
      record({ type: "user", cwd: project }),
      record({ cwd: join(worktree, "packages", "server") }),
      // A sub-agent working elsewhere is not where the THREAD is.
      record({ cwd: "/somewhere/else", isSidechain: true }),
      // A relative reading is no reading.
      record({ cwd: "packages/web" }),
      // The trailing bookkeeping record Claude Code writes carries none.
      JSON.stringify({ type: "cost-state", total: 1 }),
      "",
    ].join("\n"))
    assert.equal(newestTranscriptCwd(path), join(worktree, "packages", "server"))
    assert.equal(newestTranscriptCwd(join(root, "missing.jsonl")), undefined)
  } finally {
    cleanup()
  }
})

test("a record straddling the reader's 64 KiB chunks, multi-byte text and all, still reads", () => {
  const { root, project, worktree, cleanup } = fixture()
  try {
    const path = join(root, "t.jsonl")
    // The newest cwd-bearing record is ~100 KiB of mostly 3-byte characters, so a chunk boundary lands
    // mid-record and very likely mid-character; a decoder fed half a character would corrupt the JSON.
    const big = record({ cwd: worktree, message: { content: "→".repeat(34_000) } })
    writeFileSync(path, [record({ cwd: project }), big, JSON.stringify({ type: "cost-state" }), ""].join("\n"))
    assert.equal(newestTranscriptCwd(path), worktree)
    // The scan is bounded: a window smaller than the record cannot see its start, and falls back to
    // nothing rather than a fragment.
    assert.equal(newestTranscriptCwd(path, 1_000), undefined)
  } finally {
    cleanup()
  }
})

test("a folder is lifted to its checkout: the worktree, or the project root — never above it", () => {
  const { root, project, worktree, cleanup } = fixture()
  try {
    assert.equal(checkoutOf(join(project, "packages", "web", "src"), project), project)
    assert.equal(checkoutOf(join(worktree, "packages", "server"), project), worktree)
    assert.equal(checkoutOf(worktree, project), worktree)
    assert.equal(checkoutOf(project, project), project)
    // A project that is itself a folder inside a larger repository stays the project.
    const outerRepo = join(root, "outer")
    const nested = join(outerRepo, "apps", "site")
    mkdirSync(join(outerRepo, ".git"), { recursive: true })
    mkdirSync(join(nested, "src"), { recursive: true })
    assert.equal(checkoutOf(join(nested, "src"), nested), nested)
    // Outside the project, the nearest checkout; no checkout at all, the folder itself.
    assert.equal(checkoutOf(join(outerRepo, "apps"), project), outerRepo)
    const loose = join(root, "loose", "dir")
    mkdirSync(loose, { recursive: true })
    assert.equal(checkoutOf(loose, project), loose)
  } finally {
    cleanup()
  }
})

test("Claude: the thread's own latest folder, lifted; a vanished or missing reading falls back to the project", () => {
  const { root, project, worktree, cleanup } = fixture()
  try {
    const path = join(root, "t.jsonl")
    writeFileSync(path, [record({ cwd: project }), record({ cwd: join(worktree, "packages", "server") }), ""].join("\n"))
    assert.deepEqual(resolveThreadWorkingDir({ projectDir: project, backend: "claude", transcriptPath: path }), { dir: worktree, source: "transcript" })

    // The agent removed its worktree since: the reading names a folder that is gone.
    writeFileSync(path, record({ cwd: join(project, ".ntwine", "worktrees", "gone") }) + "\n")
    assert.deepEqual(resolveThreadWorkingDir({ projectDir: project, backend: "claude", transcriptPath: path }), { dir: project, source: "project" })
    assert.deepEqual(resolveThreadWorkingDir({ projectDir: project, backend: "claude" }), { dir: project, source: "project" })
    // An ACP agent has no reading Ntwine knows how to take.
    assert.deepEqual(resolveThreadWorkingDir({ projectDir: project, backend: "acp", transcriptPath: path }), { dir: project, source: "project" })
  } finally {
    cleanup()
  }
})

test("Codex: the newest tool call's workdir, else the session's folder", () => {
  const { project, worktree, cleanup } = fixture()
  try {
    const messages = [
      { tools: [{ cwd: project }] },
      { tools: [{ cwd: "packages/server" }, { cwd: "" }] },
      { tools: [] },
    ] as unknown as TranscriptMessage[]
    // The relative workdir resolves against the session's own folder.
    assert.equal(newestToolWorkdir(messages, worktree), join(worktree, "packages", "server"))
    assert.deepEqual(
      resolveThreadWorkingDir({ projectDir: project, backend: "codex", codexMessages: () => messages, sessionCwd: worktree }),
      { dir: worktree, source: "transcript" },
    )
    // No tool call yet: where the session was started.
    assert.deepEqual(
      resolveThreadWorkingDir({ projectDir: project, backend: "codex", codexMessages: () => [], sessionCwd: worktree }),
      { dir: worktree, source: "session" },
    )
    // An unreadable rollout is no reading, not an error.
    assert.deepEqual(
      resolveThreadWorkingDir({ projectDir: project, backend: "codex", codexMessages: () => { throw new Error("EACCES") } }),
      { dir: project, source: "project" },
    )
  } finally {
    cleanup()
  }
})

test("the folder a human types is checked: ~ expands, relative and missing folders are refused", () => {
  const { project, cleanup } = fixture()
  try {
    assert.equal(terminalFolder(`  ${project}  `), project)
    assert.equal(terminalFolder("~"), homedir())
    assert.throws(() => terminalFolder("repo/packages"), /must be an absolute path: repo\/packages/)
    assert.throws(() => terminalFolder(join(project, "nope")), /No such folder/)
    // A file is not a folder.
    writeFileSync(join(project, "README.md"), "x")
    assert.throws(() => terminalFolder(join(project, "README.md")), /No such folder/)
  } finally {
    cleanup()
  }
})

// THE ONE CHECKOUT READING every surface shares — the header token, the card, a shell row's folder hint
// and the terminal dialog all classify a folder through this, so none can disagree.
test("liftCheckout: absent for the project root, a worktree when .git is a FILE, a folder otherwise", () => {
  const { root, project, worktree, cleanup } = fixture()
  resetCheckoutMemo()
  try {
    // The root — and anywhere inside it — is the root: nothing to show.
    assert.equal(liftCheckout(project, project), undefined)
    assert.equal(liftCheckout(join(project, "packages", "web", "src"), project), undefined)
    assert.deepEqual(liftWorkingDir(join(project, "packages", "web"), project), { dir: project })
    // A linked worktree, from its root or from deep inside it.
    assert.deepEqual(liftCheckout(worktree, project), { dir: worktree, kind: "worktree" })
    assert.deepEqual(liftCheckout(join(worktree, "packages", "server"), project), { dir: worktree, kind: "worktree" })
    // A nested CLONE inside the project (its own `.git` DIRECTORY) is another checkout, but no worktree.
    const clone = join(project, "vendor", "lib")
    mkdirSync(join(clone, ".git"), { recursive: true })
    assert.deepEqual(liftCheckout(join(clone), project), { dir: clone, kind: "folder" })
    // Outside the project: the nearest checkout, or the folder itself.
    const elsewhere = join(root, "other")
    mkdirSync(join(elsewhere, ".git"), { recursive: true })
    mkdirSync(join(elsewhere, "src"))
    assert.deepEqual(liftCheckout(join(elsewhere, "src"), project), { dir: elsewhere, kind: "folder" })
    // A folder that is gone is NO reading — never a stale name.
    assert.equal(liftCheckout(join(project, ".ntwine", "worktrees", "removed"), project), undefined)
    assert.equal(liftWorkingDir(join(project, ".ntwine", "worktrees", "removed"), project), undefined)
    // And with nothing to compare against there is nothing to say.
    assert.equal(liftCheckout(worktree, undefined), undefined)
    assert.equal(liftCheckout("relative/path", project), undefined)
  } finally {
    resetCheckoutMemo()
    cleanup()
  }
})

// ONE SPELLING PER CHECKOUT. The thread's folder comes off the transcript and a running shell's off the OS,
// which always resolves links — and the strip compares the two as strings, so a worktree reached through a
// symlink showed its own name as a hint under a header that already said it.
test("a checkout reached through a symlink lifts to the same checkout as its real path", () => {
  const { root, project, worktree, cleanup } = fixture()
  resetCheckoutMemo()
  try {
    const link = join(root, "probe-link")
    symlinkSync(worktree, link)
    assert.deepEqual(liftCheckout(join(link, "packages", "server"), project), { dir: worktree, kind: "worktree" })
    assert.deepEqual(liftCheckout(join(link, "packages", "server"), project), liftCheckout(join(worktree, "packages", "server"), project))
    // A project reached through a link is still the project, and keeps the spelling it was registered by.
    const projectLink = join(root, "repo-link")
    symlinkSync(project, projectLink)
    assert.deepEqual(liftWorkingDir(join(project, "packages", "web"), projectLink), { dir: projectLink })
    assert.deepEqual(liftWorkingDir(join(projectLink, "packages", "web"), project), { dir: project })
  } finally {
    resetCheckoutMemo()
    cleanup()
  }
})

test("liftCheckout is memoized for a minute, then re-reads — a removed worktree stops reading as present", () => {
  const { project, worktree, cleanup } = fixture()
  resetCheckoutMemo()
  try {
    assert.deepEqual(liftCheckout(worktree, project, 1_000), { dir: worktree, kind: "worktree" })
    rmSync(worktree, { recursive: true, force: true })
    assert.deepEqual(liftCheckout(worktree, project, 30_000), { dir: worktree, kind: "worktree" }, "inside the TTL: the memo answers")
    assert.equal(liftCheckout(worktree, project, 62_000), undefined, "past it: the folder is gone, so no reading")
  } finally {
    resetCheckoutMemo()
    cleanup()
  }
})

test("sub-agents: the checkouts their newest edits and cd's work in, a sibling worktree of the same repo included", () => {
  const { root, project, worktree, cleanup } = fixture()
  try {
    resetCheckoutMemo()
    // A sibling worktree OUTSIDE the project, of the project's own repository — where an orchestrator's
    // agents build while the thread itself never leaves the root.
    const sibling = join(root, "elsewhere", "featherduster")
    mkdirSync(join(sibling, "ark", "type"), { recursive: true })
    const gitdir = join(project, ".git", "worktrees", "featherduster")
    mkdirSync(gitdir, { recursive: true })
    writeFileSync(join(gitdir, "commondir"), "../..\n")
    writeFileSync(join(sibling, ".git"), `gitdir: ${gitdir}\n`)
    // An unrelated repository: an agent editing it is not somewhere this thread works.
    const other = join(root, "other-repo")
    mkdirSync(join(other, ".git"), { recursive: true })

    const transcript = join(root, "session.jsonl")
    writeFileSync(transcript, "")
    const agents = join(root, "session", "subagents")
    mkdirSync(join(agents, "workflows", "wf_1"), { recursive: true })
    const tool = (name: string, input: Record<string, unknown>) =>
      record({ cwd: project, isSidechain: true, message: { content: [{ type: "tool_use", id: "t", name, input }] } })
    const agent = (path: string, lines: string[], description?: string) => {
      writeFileSync(path, lines.join("\n") + "\n")
      if (description) writeFileSync(path.replace(/\.jsonl$/u, ".meta.json"), JSON.stringify({ description }))
    }
    agent(join(agents, "workflows", "wf_1", "agent-a.jsonl"), [tool("Edit", { file_path: join(sibling, "ark", "type", "x.ts") })], "impl:T")
    // The NEWEST folder-naming call wins: a later Read names no folder, an earlier edit elsewhere is stale.
    agent(join(agents, "workflows", "wf_1", "agent-b.jsonl"), [
      tool("Edit", { file_path: join(project, "packages", "web", "src", "a.ts") }),
      tool("Bash", { command: `cd ${sibling} && pnpm test` }),
      tool("Read", { file_path: join(project, "README.md") }),
    ], "fix:T")
    agent(join(agents, "agent-c.jsonl"), [tool("Write", { file_path: join(worktree, "packages", "server", "new.ts") })])
    agent(join(agents, "agent-d.jsonl"), [tool("Edit", { file_path: join(project, "packages", "web", "src", "b.ts") })])
    agent(join(agents, "agent-e.jsonl"), [tool("Edit", { file_path: join(other, "x.ts") })])
    agent(join(agents, "agent-f.jsonl"), [tool("Read", { file_path: join(sibling, "x.ts") })])

    const byDir = new Map(subAgentFolders(transcript, project).map((f) => [f.dir, f]))
    assert.deepEqual([...byDir.keys()].sort(), [project, sibling, worktree].sort())
    assert.equal(byDir.get(sibling)?.agents, 2)
    assert.ok(["impl:T", "fix:T"].includes(byDir.get(sibling)?.newest ?? ""))
    assert.equal(byDir.get(worktree)?.agents, 1)
    assert.equal(byDir.get(project)?.agents, 1)

    // Long-idle sub-agents are not offered.
    assert.deepEqual(subAgentFolders(transcript, project, Date.now() + 2 * 24 * 60 * 60 * 1000), [])
  } finally {
    cleanup()
  }
})
