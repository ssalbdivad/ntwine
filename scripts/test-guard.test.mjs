// The suite's own completeness guard — scripts/run-tests.mjs and friends. It is the thing that makes
// a green run mean something, so it gets tested at both levels: the reconciliation rules on their
// own, and one real end-to-end run proving a file's own tally and the parent's reporter agree.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { reconcile } from "./lib/test-guard-reconcile.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);

const file = (name, pass, extra = {}) => ({ file: name, pass, fail: 0, capable: true, ...extra });

test("a run whose tallies agree raises nothing", () => {
  const problems = reconcile({
    emitted: [file("a.test.ts", 12), file("b.test.ts", 30)],
    received: [
      ["a.test.ts", 12],
      ["b.test.ts", 30],
    ],
    runnerSaidGreen: true,
  });
  assert.deepEqual(problems, []);
});

test("a file whose verdicts did not all reach the reporter is named, with the shortfall", () => {
  const problems = reconcile({
    emitted: [file("a.test.ts", 12), file("delivery-ledger.test.ts", 70)],
    received: [
      ["a.test.ts", 12],
      ["delivery-ledger.test.ts", 39],
    ],
    runnerSaidGreen: true,
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /delivery-ledger\.test\.ts: ran 70 tests but only 39 reached the reporter — 31 lost/);
});

test("a file that reported results without recording its own tally is caught", () => {
  const problems = reconcile({
    emitted: [file("a.test.ts", 12)],
    received: [
      ["a.test.ts", 12],
      ["b.test.ts", 4],
    ],
    runnerSaidGreen: true,
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /b\.test\.ts: reported results but never recorded its own tally/);
});

test("losing the whole ledger fails the run rather than passing it quietly", () => {
  const problems = reconcile({ emitted: [], received: [["a.test.ts", 12]], runnerSaidGreen: true });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /did not load, so nothing about this run is verified/);
});

test("a child that cannot make its report pipe blocking says so", () => {
  const problems = reconcile({
    emitted: [file("a.test.ts", 12, { capable: false })],
    received: [["a.test.ts", 12]],
    runnerSaidGreen: true,
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /cannot put the report pipe in blocking mode/);
});

test("an already-red run is not also accused of being unverifiable", () => {
  // The runner's own failure is the headline; a second complaint about bookkeeping would bury it.
  const problems = reconcile({ emitted: [], received: [["a.test.ts", 12]], runnerSaidGreen: false });
  assert.deepEqual(problems, ["a.test.ts: reported results but never recorded its own tally"]);
});

test("the same file under two path spellings is one file, not two", () => {
  const problems = reconcile({
    emitted: [file("/private/tmp/a.test.mjs", 3)],
    received: [["/private/tmp/a.test.mjs", 3]],
    runnerSaidGreen: true,
  });
  assert.deepEqual(problems, []);
});

test("end to end, a real run's own tally matches what the parent received", () => {
  // The unit tests above pin the rules; this pins the two INSTRUMENTS that feed them — the preload's
  // count of verdicts a child emits, and the reporter's count of what arrived. A test name holding
  // the literal event type is in there on purpose: the preload matches the serializer's
  // length-prefixed form, so the name must not inflate the count.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ntwine-test-guard-selftest-"));
  try {
    const fixture = path.join(scratch, "fixture.test.mjs");
    fs.writeFileSync(
      fixture,
      [
        'import test from "node:test";',
        'test("plain", () => {});',
        'test("a name that says test:pass in it", () => {});',
        'test("with a subtest", async (t) => { await t.test("nested", () => {}); });',
      ].join("\n"),
    );

    // NODE_TEST_CONTEXT and NTWINE_TEST_LEDGER are set on us because we are ourselves a test-runner
    // child; leaving them set would make the inner runner think it too was a child and emit
    // serialized frames instead of the spec output this asserts on.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.NTWINE_TEST_LEDGER;
    delete env.NTWINE_TEST_GUARD_NO_BLOCKING;

    const result = spawnSync(process.execPath, [path.join(here, "run-tests.mjs"), fixture], {
      cwd: root,
      encoding: "utf8",
      env,
    });

    assert.equal(result.status, 0, `guarded run should pass:\n${result.stdout}\n${result.stderr}`);
    assert.doesNotMatch(result.stderr, /INCOMPLETE TEST RUN/);
    // 3 top-level + 1 nested, all of which must reach the parent.
    assert.match(result.stdout, /ℹ tests 4\b/);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
