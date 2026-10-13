// Loaded with --import into every process node's test runner starts; see scripts/run-tests.mjs.
// Everything here runs in the per-file CHILD process (the parent leaves NODE_TEST_CONTEXT unset).
//
// Why this exists: under `--test-force-exit` the child calls process.exit() as soon as its tests
// finish, and process.exit() throws away whatever is still queued on an ASYNC pipe. The child's
// verdicts travel to the parent over exactly such a pipe, so the tail of a file's results is lost —
// the parent counts only what arrived, reports `fail 0` / `cancelled 0`, and exits 0. Measured here
// 2026-08-16: one run of four dropped the last 31 of delivery-ledger.test.ts's 70 tests and still
// looked green. Upstream is nodejs/node#64833, still open.
//
// Two jobs, belt and braces:
//
//  1. Put the report pipe in BLOCKING mode, so those writes complete before the process exits. This
//     is the same remedy as the upstream fix; we apply it from here because upstream has not landed.
//  2. Tally the verdicts this child EMITS and write that tally synchronously from an `exit` handler,
//     which survives the same process.exit() that truncates the pipe. run-tests.mjs reconciles the
//     tally against what the parent actually received, so a drop from any cause — this one or the
//     next one — fails the run loudly instead of passing quietly.

import fs from "node:fs";

const ledgerPath = process.env.NTWINE_TEST_LEDGER;
const entry = process.argv[1] ?? "";

// Only ever act in a test-runner child running one of our own test files. NODE_TEST_CONTEXT is
// inherited by anything a test spawns, so the entry-file check keeps a test's own subprocess from
// writing a bogus ledger line if it ever loads this module.
if (process.env.NODE_TEST_CONTEXT && ledgerPath && /\.test\.(mjs|ts)$/.test(entry)) {
  // `capable` says the remedy is available at all — setBlocking is private API, so a future node
  // could take it away, and run-tests.mjs turns that into a loud failure rather than a quiet return
  // to dropped tests. NTWINE_TEST_GUARD_NO_BLOCKING=1 leaves it capable but unapplied, which is the
  // negative control: it truncates on purpose so the reconciliation can be shown to go red.
  const handle = process.stdout._handle;
  const capable = typeof handle?.setBlocking === "function";
  const applied = capable && process.env.NTWINE_TEST_GUARD_NO_BLOCKING !== "1";
  if (applied) handle.setBlocking(true);

  // A verdict crosses the pipe as a v8-serialized event whose `type` is the string "test:pass" or
  // "test:fail". Match the serializer's one-byte-string tag (0x22) and length (9) as well as the
  // text, so a test NAME that happens to contain "test:pass" cannot inflate the count — its own
  // length prefix differs. Both patterns are 11 bytes.
  const PASS = Buffer.concat([Buffer.from([0x22, 0x09]), Buffer.from("test:pass")]);
  const FAIL = Buffer.concat([Buffer.from([0x22, 0x09]), Buffer.from("test:fail")]);

  let pass = 0;
  let fail = 0;
  // A pattern can straddle two writes, so re-scan the previous chunk's last 10 bytes with the next
  // one. 10 < 11 means no whole pattern fits inside the carry alone, so nothing is counted twice.
  let carry = Buffer.alloc(0);

  const occurrences = (haystack, needle) => {
    let n = 0;
    for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) n++;
    return n;
  };

  const scan = (chunk, encoding) => {
    const buf = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(String(chunk), typeof encoding === "string" ? encoding : "utf8");
    const hay = carry.length ? Buffer.concat([carry, buf]) : buf;
    pass += occurrences(hay, PASS);
    fail += occurrences(hay, FAIL);
    carry = Buffer.from(hay.subarray(Math.max(0, hay.length - (PASS.length - 1))));
  };

  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, encoding, callback) => {
    try {
      scan(chunk, encoding);
    } catch {
      // Counting must never be the thing that breaks a test run; a miscount surfaces as a loud
      // reconciliation failure, which is the safe direction.
    }
    return write(chunk, encoding, callback);
  };

  process.on("exit", () => {
    try {
      fs.appendFileSync(ledgerPath, `${JSON.stringify({ file: entry, pass, fail, capable })}\n`);
    } catch {
      // A missing line reads as a missing file to run-tests.mjs, which fails the run.
    }
  });
}
