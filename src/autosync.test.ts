// Real git, real hooks: a throwaway bare repo stands in for origin and two clones for the two machines.
// NTWINE_AUTOSYNC_ANY_ORIGIN lets the gate accept a local path as origin; nothing here talks to GitHub.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { autosyncGate, isAutosyncOrigin, runSync } from "./autosync.ts";

const HOOKS = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts/githooks");

function sandbox(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-autosync-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const globalConfig = join(dir, "gitconfig");
  writeFileSync(globalConfig, "[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    NTWINE_AUTOSYNC_ANY_ORIGIN: "1",
    NTWINE_AUTOSYNC: "1",
  };
  delete env.NTWINE_AUTOSYNC_RUNNING;
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const origin = join(dir, "origin.git");
  git(dir, "init", "--quiet", "--bare", origin);
  const seed = join(dir, "seed");
  git(dir, "clone", "--quiet", origin, seed);
  for (const name of ["shared.txt", "a.txt", "b.txt"]) writeFileSync(join(seed, name), `${name}\n`);
  git(seed, "add", ".");
  git(seed, "commit", "--quiet", "-m", "seed");
  git(seed, "push", "--quiet", "origin", "main");

  /** One machine's checkout. `hooks` wires scripts/githooks the way `autosync:on` does. */
  const machine = (name: string, { hooks = false } = {}) => {
    const path = join(dir, name);
    git(dir, "clone", "--quiet", origin, path);
    git(path, "config", "--bool", "ntwine.autosync", "true");
    if (hooks) git(path, "config", "core.hooksPath", HOOKS);
    const commit = (file: string, text: string, message = `${name}: ${file}`) => {
      writeFileSync(join(path, file), text);
      git(path, "add", file);
      git(path, "commit", "--quiet", "-m", message);
    };
    return { path, commit, sync: () => runSync({ cwd: path, env, reason: "test" }), git: (...args: string[]) => git(path, ...args) };
  };
  const originMain = () => git(dir, "--git-dir", origin, "rev-parse", "main");
  return { dir, env, git, origin, originMain, machine };
}

/** Wait on origin for a background sync. Gives up early when a log already says it failed. */
async function until(condition: () => boolean, logFile: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (condition()) return;
    const log = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
    if (/can't|failed/.test(log)) assert.fail(`sync failed:\n${log}`);
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.fail(`timed out; log:\n${existsSync(logFile) ? readFileSync(logFile, "utf8") : "(none)"}`);
}

test("pushes main's own commits when origin has not moved", (t) => {
  const { machine, originMain } = sandbox(t);
  const mac = machine("mac");
  mac.commit("a.txt", "mac\n");
  assert.deepEqual(mac.sync(), { state: "synced", message: "pushed 1 commit to origin/main", pulled: 0, pushed: 1 });
  assert.equal(originMain(), mac.git("rev-parse", "main"));
});

test("fast-forwards onto origin without a merge commit", (t) => {
  const { machine } = sandbox(t);
  const mac = machine("mac");
  const wsl = machine("wsl");
  mac.commit("a.txt", "mac\n");
  mac.sync();
  assert.deepEqual(wsl.sync(), { state: "synced", message: "pulled 1 commit from origin/main", pulled: 1, pushed: 0 });
  assert.equal(wsl.git("rev-parse", "main"), mac.git("rev-parse", "main"));
});

test("merges diverged histories and pushes the merge, leaving unrelated dirty edits alone", (t) => {
  const { machine, originMain } = sandbox(t);
  const mac = machine("mac");
  const wsl = machine("wsl");
  mac.commit("a.txt", "mac\n");
  mac.sync();
  wsl.commit("b.txt", "wsl\n");
  writeFileSync(join(wsl.path, "shared.txt"), "another agent, mid-edit\n");
  writeFileSync(join(wsl.path, "untracked.txt"), "scratch\n");

  assert.deepEqual(wsl.sync(), { state: "synced", message: "pulled 1 commit from origin/main, pushed 2 commits to origin/main", pulled: 1, pushed: 2 });
  assert.equal(originMain(), wsl.git("rev-parse", "main"));
  assert.equal(wsl.git("rev-list", "--parents", "-n1", "main").split(" ").length, 3);
  assert.equal(readFileSync(join(wsl.path, "a.txt"), "utf8"), "mac\n");
  assert.equal(wsl.git("status", "--porcelain"), "M shared.txt\n?? untracked.txt");
  assert.equal(readFileSync(join(wsl.path, "shared.txt"), "utf8"), "another agent, mid-edit\n");
});

test("a dirty file in the way blocks the pull and is left byte-for-byte", (t) => {
  const { machine, originMain } = sandbox(t);
  const mac = machine("mac");
  const wsl = machine("wsl");
  mac.commit("shared.txt", "mac\n");
  mac.sync();
  wsl.commit("b.txt", "wsl\n");
  const before = wsl.git("rev-parse", "main");
  writeFileSync(join(wsl.path, "shared.txt"), "another agent, mid-edit\n");

  const outcome = wsl.sync();
  assert.equal(outcome.state, "blocked");
  assert.match(outcome.message, /^can't pull origin\/main: .*shared\.txt/);
  assert.equal(readFileSync(join(wsl.path, "shared.txt"), "utf8"), "another agent, mid-edit\n");
  assert.equal(wsl.git("rev-parse", "main"), before);
  assert.equal(existsSync(join(wsl.path, ".git/MERGE_HEAD")), false);
  assert.equal(originMain(), mac.git("rev-parse", "main"));

  // Once the agent commits its edit, the clash is a committed conflict instead, and still never lands
  // in the tree; a non-overlapping commit would have gone through on this same run.
  wsl.git("commit", "--quiet", "-am", "the agent's edit");
  const conflicted = wsl.sync();
  assert.deepEqual([conflicted.state, conflicted.message], ["blocked", "can't pull origin/main: it conflicts with local main in shared.txt"]);
});

test("committed edits that conflict block the pull before the tree is touched", (t) => {
  const { machine } = sandbox(t);
  const mac = machine("mac");
  const wsl = machine("wsl");
  mac.commit("shared.txt", "mac\n");
  mac.sync();
  wsl.commit("shared.txt", "wsl\n");
  writeFileSync(join(wsl.path, "a.txt"), "dirty\n");

  assert.equal(wsl.sync().message, "can't pull origin/main: it conflicts with local main in shared.txt");
  assert.equal(readFileSync(join(wsl.path, "shared.txt"), "utf8"), "wsl\n");
  assert.equal(existsSync(join(wsl.path, ".git/MERGE_HEAD")), false);
  assert.equal(wsl.git("status", "--porcelain"), "M a.txt");
});

test("declines without opt-in, off main, or with a foreign origin", (t) => {
  const { machine, env } = sandbox(t);
  const wsl = machine("wsl");
  const reason = () => {
    const gate = autosyncGate(wsl.path, env);
    return gate.ok ? "ok" : gate.reason;
  };
  assert.equal(reason(), "ok");
  wsl.git("switch", "--quiet", "-c", "feature");
  assert.equal(reason(), "HEAD is feature, not main");
  wsl.git("switch", "--quiet", "main");
  assert.equal(autosyncGate(wsl.path, { ...env, NTWINE_AUTOSYNC_ANY_ORIGIN: undefined }).ok, false);
  assert.equal(autosyncGate(wsl.path, { ...env, NTWINE_AUTOSYNC: "0" }).ok, false);
  wsl.git("config", "--bool", "ntwine.autosync", "false");
  assert.equal(reason(), "autosync is off in this clone (pnpm run autosync:on)");

  assert.equal(isAutosyncOrigin("https://github.com/ssalbdivad/ntwine.git"), true);
  assert.equal(isAutosyncOrigin("git@github.com:ssalbdivad/ntwine.git"), true);
  assert.equal(isAutosyncOrigin("https://github.com/ssalbdivad/ntwine"), true);
  assert.equal(isAutosyncOrigin("https://github.com/someone/ntwine.git"), false);
  assert.equal(isAutosyncOrigin("https://github.com/ssalbdivad/ntwine-fork.git"), false);
  assert.equal(isAutosyncOrigin("https://evil.example/github.com/ssalbdivad/ntwine.git"), false);
});

test("a commit through the hooks syncs in the background without holding up the commit", async (t) => {
  const { machine, originMain } = sandbox(t);
  const mac = machine("mac");
  const wsl = machine("wsl", { hooks: true });
  mac.commit("a.txt", "mac\n");
  mac.sync();

  // The house way to commit out of the shared tree, and a merge to make: origin moved meanwhile.
  writeFileSync(join(wsl.path, "b.txt"), "wsl\n");
  // A slow origin, so a sync run in the commit's foreground would show in its duration.
  wsl.git("config", "remote.origin.uploadpack", "sleep 2; git-upload-pack");
  const started = Date.now();
  wsl.git("commit", "--quiet", "-m", "wsl: b", "--", "b.txt");
  assert.ok(Date.now() - started < 1_500, `the commit waited ${Date.now() - started}ms on the sync`);
  await until(() => wsl.git("rev-parse", "main") === originMain() && wsl.git("rev-list", "--count", "main").trim() === "4", join(wsl.path, ".git/ntwine-sync.log"));

  assert.equal(wsl.git("status", "--porcelain"), "");
  assert.equal(readFileSync(join(wsl.path, "a.txt"), "utf8"), "mac\n");
});

test("concurrent commits from many agents on both machines all reach origin", async (t) => {
  const { machine, env, git, dir, origin, originMain } = sandbox(t);
  const mac = machine("mac", { hooks: true });
  const wsl = machine("wsl", { hooks: true });
  const files = Array.from({ length: 6 }, (_, i) => `agent-${i}.txt`);
  for (const file of files) writeFileSync(join(wsl.path, file), "");
  wsl.git("add", ".");
  wsl.git("commit", "--quiet", "-m", "agent files");
  await until(() => wsl.git("rev-parse", "main") === originMain(), join(wsl.path, ".git/ntwine-sync.log"));
  mac.sync();

  // Six agents commit at once in one checkout (retrying on index.lock, as a real one would), while the
  // other machine commits and pushes too.
  const agents = files.map((file) => new Promise<void>((done, fail) => {
    const script = `echo work > ${file}; until git commit --quiet -m "${file}" -- ${file} 2>/dev/null; do sleep 0.05; done`;
    spawn("bash", ["-c", script], { cwd: wsl.path, env, stdio: "ignore" }).on("exit", (code) => code === 0 ? done() : fail(new Error(`${file}: ${code}`)));
  }));
  mac.commit("a.txt", "mac\n");
  await Promise.all(agents);

  const logFile = join(wsl.path, ".git/ntwine-sync.log");
  const landed = () => {
    const log = git(dir, "--git-dir", origin, "log", "--format=%s", "main");
    return files.every((file) => log.includes(file)) && log.includes("mac: a.txt");
  };
  await until(landed, logFile);
  // Settle both machines, as their next commit or poll would, and they agree with origin exactly.
  await until(() => {
    for (const side of [wsl, mac]) side.sync();
    return [wsl, mac].every((side) => side.git("rev-parse", "main") === originMain() && !existsSync(join(side.path, ".git/ntwine-sync.lock")));
  }, logFile);
  assert.equal(wsl.git("status", "--porcelain"), "");
});
