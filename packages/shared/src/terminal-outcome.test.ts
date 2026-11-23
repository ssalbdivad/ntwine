import { test } from "node:test"
import assert from "node:assert/strict"
import { terminalCommandCore, terminalOutcome, type ThreadTerminal } from "./index.ts"

// The exit classification decides a terminal thread's band, and a wrong reading either buries a crash in Done
// or queues a card whose only answer is to dismiss it. The real-pty paths are in thread-terminals.test.ts;
// these are the readings a pty cannot be made to produce on demand (a kernel kill, an exit nobody recorded).
const exited = (over: Partial<ThreadTerminal>): ThreadTerminal =>
  ({ id: "t", command: "npm run dev", cwd: "/repo", state: "exited", runId: 1, startedAt: "2026-10-15T10:00:00.000Z", ...over })

test("a signal someone sends ends the run; one nobody sent is a failure", () => {
  // SIGHUP (a closed window), SIGINT, SIGTERM: a person or a supervisor ended it.
  for (const signal of [1, 2, 15]) assert.equal(terminalOutcome(exited({ exitCode: 0, signal })), "finished", `signal ${signal}`)
  // SIGKILL from the OOM killer, a segfault, an abort: the process did not choose to stop.
  for (const signal of [9, 11, 6]) assert.equal(terminalOutcome(exited({ exitCode: 0, signal })), "failed", `signal ${signal}`)
})

test("an exit code reads as its shell reports it, and a bare shell's last word is the human's", () => {
  assert.equal(terminalOutcome(exited({ exitCode: 0 })), "finished")
  assert.equal(terminalOutcome(exited({ exitCode: 130 })), "finished", "Ctrl-C")
  assert.equal(terminalOutcome(exited({ exitCode: 143 })), "finished", "SIGTERM reported by the shell")
  assert.equal(terminalOutcome(exited({ exitCode: 1 })), "failed")
  // `exit 1` typed into an interactive shell is the human leaving it, not the shell crashing.
  assert.equal(terminalOutcome(exited({ exitCode: 1, shell: true })), "finished")
  // Stop wins over whatever code the dying process left.
  assert.equal(terminalOutcome(exited({ exitCode: 137, stopped: true })), "finished")
})

test("a run with no recorded exit was interrupted, and a live one reads its prompt", () => {
  assert.equal(terminalOutcome(exited({})), "interrupted")
  assert.equal(terminalOutcome(exited({ shell: true })), "interrupted", "a shell cut off by a restart did not end by its own exit either")
  assert.equal(terminalOutcome(exited({ state: "running" })), "running")
  assert.equal(terminalOutcome(exited({ state: "running", awaitingInput: true })), "prompt")
})

test("a terminal command's leading cds are set aside to the last directory's name", () => {
  assert.deepEqual(terminalCommandCore("cd /a/ark/docs/ && cd sub; pnpm dev"), { command: "pnpm dev", dir: "sub" })
  assert.deepEqual(terminalCommandCore("nub run dev"), { command: "nub run dev" })
  // Only a cd: nothing to set aside.
  assert.deepEqual(terminalCommandCore("cd /a/b"), { command: "cd /a/b" })
  // Quoted paths in leading cd steps are set aside too (unquoted basename).
  assert.deepEqual(terminalCommandCore("cd '/a b' && ls"), { command: "ls", dir: "a b" })
  assert.deepEqual(terminalCommandCore('cd "/Users/me/worktrees/wt/web-app2/" && pnpm dev'), { command: "pnpm dev", dir: "web-app2" })
})

test("shell setup steps before the command are set aside with the cds", () => {
  assert.deepEqual(terminalCommandCore("source ~/.nvm/nvm.sh && nvm use 22 && VGS_DISABLED=1 yarn dev"), { command: "VGS_DISABLED=1 yarn dev" })
  assert.deepEqual(terminalCommandCore(". .env; cd web && export PORT=3001 && pnpm dev"), { command: "pnpm dev", dir: "web" })
  // Quoted cd + quoted multi-var export (real slash dev command) strips down to the actual program.
  assert.deepEqual(
    terminalCommandCore(`cd '/Users/ssalb/slash/.ntwine/worktrees/arktype-3/packages/fe-apps/web-app2' && export PATH="$HOME/.nvm/versions/node/v22.23.5/bin:$PATH" VGS_DISABLED=1 NODE_OPTIONS='--openssl-legacy-provider --max-old-space-size=4096' && doppler run -p web-app -c dev -- ./node_modules/.bin/next dev -p 3000`),
    { command: "doppler run -p web-app -c dev -- ./node_modules/.bin/next dev -p 3000", dir: "web-app2" },
  )
  // An `&&` inside quotes in export stays inside that segment.
  assert.deepEqual(terminalCommandCore(`export FLAG="a && b" && pnpm dev`), { command: "pnpm dev" })
  // A real command ahead of the setup is the command: only LEADING setup goes.
  assert.deepEqual(terminalCommandCore("pnpm build && nvm use 22 && pnpm start"), { command: "pnpm build && nvm use 22 && pnpm start" })
  assert.deepEqual(terminalCommandCore("echo 'cd /x && ls' && pnpm dev"), { command: "echo 'cd /x && ls' && pnpm dev" })
  // Setup alone runs nothing else, so it stays whole.
  assert.deepEqual(terminalCommandCore("nvm use 22"), { command: "nvm use 22" })
})
