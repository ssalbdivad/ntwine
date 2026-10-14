---
name: real-subsystem-harness
description: Verify backend behavior a browser cannot reach — the broker socket, spawn/exec paths, resume and wake, SQLite migrations, the scheduler, a detached daemon's environment — by writing a small `nub` script that spins the REAL resource and asserts the REAL function, with a negative control that proves the harness can fail. Load this when the thing you changed has no UI, when a unit test would only prove your mock matches your belief, or when a feature SPANS processes and the seam between them is where the bug lives. Also carries the polling discipline (early exit on the failure signal, not just success) that keeps a verification run from burning its whole timeout, and the rule that a green harness over a stubbed seam is worse than honest incompleteness. Pair with `ntwine-stack` when the real resource is a running ntwine.
version: 0.1.0
metadata:
  internal: true
---

# real-subsystem-harness — spin the real thing, assert the real function

Browser QA can't reach the broker socket, the resume/wake path, SQLite migrations, or the
scheduler. For those, write a small `nub` harness that spins the **real** resource and asserts the
**real** function — a mock proves only that your mock matches your belief.

Worked examples in this repo: `scripts/verify-relay-gate.mjs` (a relayed socket against the real
relay supervisor's access gate, with a negative control), `scripts/win-claude-resolve-probe.mjs` (the real binary resolver, with a
differential control that proves the tool under test is actually installed), and
`scripts/verify-orphan-reaper.mjs`.

```js
import { execFileSync } from "node:child_process"
import { theFixedFunction } from "../packages/server/src/<module>.ts"
// 1. create the real precondition (a real socket, a real sqlite db, a real server…)
// 2. call the real function
// 3. PASS/FAIL each assertion to stdout; process.exit(1) on any failure
// 4. tear the real resource down in finally
```

---

## The rules that make a harness worth running

**Include a NEGATIVE CONTROL.** Not just the happy path — an identity-mismatch case that must still be
rejected. That is what proves a widened code path didn't weaken a safety check. And it is what proves the
harness itself can fail: a suite that has never gone red is not evidence. When an experiment confirms
what you expected, get suspicious rather than relieved — check that you varied exactly one thing, that the
command actually ran, and that you are not testing a stale build.

**Replicate production faithfully.** A legacy-wake verifier (since deleted) caught a trailing-quote boundary bug in a
matcher on its first run *because* it used the production argv form instead of a hand-quoted string. A
hand-driven proxy — invoking a CLI yourself with the flags the server *would* have passed — proves the
parts, not the whole. If a feature spawns, injects, or renders something, drive the REAL spawned thing.

**Test the whole, not the parts.** A passing unit test, a mock, or a typecheck proves the pieces. The
seam between the pieces is exactly where the bug lives. "I verified the components" is how a broken
feature ships.

**Poll with an EARLY EXIT — and always one for the failure case.** A loop that only breaks on success
burns its entire budget every time the answer is "no". A 150×2s wait cost five minutes of dead clock on a
control run that was *supposed* to fail. Break on the negative signal too (the worker rested, the process
exited, the thread went idle), not only the positive one, and log what you are waiting for.

**Never read an exit code through a pipe.** `cmd | head` then `echo $?` gives head's status. Redirect,
capture on its own line, then inspect: `cmd > /tmp/out.log 2>&1; echo "EXIT=$?"`. Two related traps:
`| head -N` can SIGPIPE-kill the producer mid-run, and a background task's completion notification
reports the PIPELINE's exit — so a failing run can arrive labelled "exit code 0".

**Clean up by exact PID.** Anything you spawn that outlives the harness — a detached daemon above all —
is yours to kill, by the exact pid you started, never a broad `pkill -f`. Other agents share this machine.
Verify the survivors afterward; an empty variable in a grep pattern matches EVERYTHING.

**Say what you could not verify.** If genuine end-to-end testing is infeasible, that does not lower the
bar — it raises it: attack your own assumptions, enumerate how the change could fail in the real runtime,
and trace the whole path yourself. Then state plainly what you exercised and what you did not. "It should
work" is not "it works".

---

## Composes with

- **`ntwine-stack`** — when the real resource is a running ntwine (a real server, real tenants, a real
  dispatched worker), boot it there rather than hand-rolling one.
- **`ntwine-artifact-e2e`** — when the behavior could differ between dev source and the promoted artifact.
- **`headless-browser`** — for the half of the system a harness cannot see.
