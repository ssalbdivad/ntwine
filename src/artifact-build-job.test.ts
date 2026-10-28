import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { spawnArtifactBuild } from "./artifact-build-job.ts";

const JOB_MODULE = join(import.meta.dirname, "artifact-build-job.ts");

function fixture(source: string): { entry: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-build-job-"));
  const entry = join(dir, "entry.ts");
  writeFileSync(entry, source);
  return { entry, dir };
}

const job = { stateDir: "/nonexistent/state", sourceDir: "/nonexistent/source", root: "/nonexistent/root" };

test("the real job entry reports a failed build as a rejection carrying the build's own message", async () => {
  // The REAL child half: runArtifactBuildJob, promoteCurrentSourceArtifact and all. A source directory
  // that does not exist fails the build at its first step, without minutes of typecheck.
  const { entry, dir } = fixture(
    `import { runArtifactBuildJob } from ${JSON.stringify(JOB_MODULE)};\n` +
      `if (!runArtifactBuildJob()) { console.log("not a job"); process.exit(3); }\n`
  );
  try {
    const progress: string[] = [];
    await assert.rejects(
      spawnArtifactBuild({ ...job, entry, onProgress: (line) => progress.push(line) }).result,
      (error: Error) => !/without a result/.test(error.message) && error.message.length > 0
    );
    assert.ok(progress.length > 0, "progress lines from the child reach onProgress");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a job that dies before reporting rejects with its stderr tail", async () => {
  const { entry, dir } = fixture(`process.stderr.write("boom from the build\\n"); process.exit(7);\n`);
  try {
    await assert.rejects(
      spawnArtifactBuild({ ...job, entry }).result,
      /exited with code 7 without a result\nboom from the build/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a synchronous build in the job leaves the parent's event loop free, and resolves with its digests", async () => {
  // Stands in for execFileSync(typecheck): blocks the CHILD's loop for 1.5s, then reports.
  const { entry, dir } = fixture(
    `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);\n` +
      `process.stdout.write("ntwine-artifact-build-result " + JSON.stringify({ ok: true, candidate: "a".repeat(64), previous: "b".repeat(64) }) + "\\n");\n`
  );
  try {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 50);
    const result = await spawnArtifactBuild({ ...job, entry }).result;
    clearInterval(timer);
    assert.deepEqual(result, { candidate: "a".repeat(64), previous: "b".repeat(64) });
    // Inline, the parent would have ticked zero times during the build.
    assert.ok(ticks >= 15, `parent ticked ${ticks} times while the job built`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cancel kills the job and the build tools it started", { skip: process.platform === "win32" }, async () => {
  const pidFile = join(tmpdir(), `ntwine-build-job-grandchild-${process.pid}`);
  // The grandchild stands in for `tsc` under a script runner that starts the script in a process
  // group of its OWN and forwards signals to it (nub did), so a signal to the job's group reaches the tool only
  // through that forwarding. Mirror both halves.
  const { entry, dir } = fixture(
    `import { spawn } from "node:child_process";\nimport { writeFileSync } from "node:fs";\n` +
      `const sleeper = spawn("sleep", ["60"], { stdio: "ignore", detached: true });\n` +
      `process.on("SIGTERM", () => { process.kill(-sleeper.pid!, "SIGTERM"); process.exit(143); });\n` +
      `writeFileSync(${JSON.stringify(pidFile)}, String(sleeper.pid));\n` +
      `setInterval(() => {}, 1000);\n`
  );
  try {
    const handle = spawnArtifactBuild({ ...job, entry });
    const { readFileSync, existsSync } = await import("node:fs");
    const deadline = Date.now() + 10_000;
    while (!existsSync(pidFile) || !readFileSync(pidFile, "utf8")) {
      assert.ok(Date.now() < deadline, "the job never started its grandchild");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const grandchild = Number(readFileSync(pidFile, "utf8"));
    handle.cancel();
    await assert.rejects(handle.result, /exited with code 143 without a result/);
    const alive = () => {
      try {
        process.kill(grandchild, 0);
        return true;
      } catch {
        return false;
      }
    };
    const gone = Date.now() + 5_000;
    while (alive() && Date.now() < gone) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(alive(), false, "the grandchild outlived cancel()");
  } finally {
    rmSync(pidFile, { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
