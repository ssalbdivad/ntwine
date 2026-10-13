import assert from "node:assert/strict"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import {
  appendCrashRecord,
  createLogger,
  defaultLogRoot,
  formatFeedLine,
  latestLogPath,
  logEnvironment,
  openRunLogger,
  pruneRunLogs,
  runLogPath,
  setAmbientLogger,
  log,
} from "./logging.ts"
import { ntwinePaths } from "./ntwine-paths.ts"

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "ntwine-logging-"))
}

test("the run log lives beside the project's own state, wherever that project's state lives", () => {
  const stateDir = "/home/someone/.ntwine/projects/abcd"
  assert.equal(defaultLogRoot(stateDir), join(stateDir, "logs"))

  // No project yet — a failure before the workspace resolves — falls back to the machine-level STATE
  // root. This test used to assert `<home>/.ntwine/logs` unconditionally, under a rule that ntwine keeps
  // one dotdir on every platform; the root is now resolved by ntwine-paths.ts, so an install that HAS
  // `~/.ntwine` still gets exactly that path and a new machine gets the platform's own.
  const legacyHome = mkdtempSync(join(tmpdir(), "ntwine-logroot-legacy-"))
  try {
    mkdirSync(join(legacyHome, ".ntwine"))
    assert.equal(defaultLogRoot(undefined, legacyHome), join(legacyHome, ".ntwine", "logs"))
  } finally {
    rmSync(legacyHome, { recursive: true, force: true })
  }

  const freshHome = mkdtempSync(join(tmpdir(), "ntwine-logroot-fresh-"))
  try {
    assert.equal(defaultLogRoot(undefined, freshHome), join(ntwinePaths({ home: freshHome }).state, "logs"))
    assert.notEqual(defaultLogRoot(undefined, freshHome), join(freshHome, ".ntwine", "logs"))
  } finally {
    rmSync(freshHome, { recursive: true, force: true })
  }
})

test("a run log is named for its instant and pid so a crash points at one exact file", () => {
  const path = runLogPath("/state", new Date(2026, 6, 31, 16, 42, 11), 4242, "/home/x", {})
  assert.equal(path, join("/state", "logs", "ntwine-2026-07-31T16-42-11-4242.log"))
})

test("NTWINE_LOG_PATH accepts either a directory or an exact file", () => {
  const at = new Date(2026, 6, 31, 16, 42, 11)
  assert.equal(
    runLogPath("/state", at, 7, "/home/x", { NTWINE_LOG_PATH: "/tmp/logs" }),
    join("/tmp/logs", "ntwine-2026-07-31T16-42-11-7.log"),
  )
  assert.equal(
    runLogPath("/state", at, 7, "/home/x", { NTWINE_LOG_PATH: "/tmp/exact.log" }),
    "/tmp/exact.log",
  )
})

test("records land on disk in a human-readable, aligned form", () => {
  const dir = scratch()
  try {
    const file = join(dir, "run.log")
    const logger = createLogger({ file, now: () => Date.UTC(2026, 6, 31, 12, 0, 0) })
    logger.info("launcher", "workspace ntwine")
    logger.error("supervisor", "child exited")
    const written = readFileSync(file, "utf8").split("\n").filter(Boolean)
    assert.equal(written.length, 2)
    assert.match(written[0]!, /INFO {2}\s+launcher\s+workspace ntwine$/)
    assert.match(written[1]!, /ERROR\s+supervisor\s+child exited$/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the level threshold drops quieter records everywhere, including on disk", () => {
  const dir = scratch()
  try {
    const file = join(dir, "run.log")
    const logger = createLogger({ file, level: "warn" })
    const seen: string[] = []
    logger.onRecord((record) => seen.push(record.message))
    logger.debug("tailer", "a debug record")
    logger.info("tailer", "an info record")
    logger.warn("tailer", "a warning record")
    assert.deepEqual(seen, ["a warning record"])
    const written = readFileSync(file, "utf8")
    assert.equal(written.includes("a debug record"), false)
    assert.equal(written.includes("an info record"), false)
    assert.equal(written.includes("a warning record"), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// latest.log dangles whenever retention prunes the run it named (a launch after RETAINED_DAYS idle). On
// Node 25.0–25.3, rmSync looked through the link (nodejs/node#61040), found nothing, and `force` swallowed
// that: the link stayed, symlinkSync failed EEXIST, and the plain-file fallback wrote THROUGH the link —
// recreating the pruned log with this run's path in it while latest.log still named the old run.
test("an owner repoints a DANGLING latest.log, and never writes through it", () => {
  const dir = scratch()
  try {
    const logs = join(dir, "logs")
    mkdirSync(logs, { recursive: true })
    const pruned = join(logs, "ntwine-pruned.log")
    symlinkSync(pruned, latestLogPath(logs))
    assert.ok(lstatSync(latestLogPath(logs)).isSymbolicLink() && !existsSync(pruned), "the fixture link dangles")

    const run = join(logs, "ntwine-new.log")
    createLogger({ file: run }).info("launcher", "hello")
    assert.equal(existsSync(pruned), false, "the pruned run must not be recreated through the stale link")
    assert.equal(readlinkSync(latestLogPath(logs)), run, "latest.log names this run")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an owner sweeps retention and repoints latest.log; an adopting child does neither", () => {
  const dir = scratch()
  try {
    const logs = join(dir, "logs")
    mkdirSync(logs, { recursive: true })
    for (let index = 0; index < 25; index++) {
      const path = join(logs, `ntwine-old-${index}.log`)
      writeFileSync(path, "x")
      // Distinct mtimes so "newest N" is well defined.
      const when = new Date(2026, 0, 1 + index)
      utimesSync(path, when, when)
    }
    const owner = createLogger({ file: join(logs, "ntwine-new.log") })
    owner.info("launcher", "hello")
    const remaining = readdirSync(logs).filter((name) => name !== "latest.log")
    assert.equal(remaining.length <= 21, true, `expected retention to sweep, saw ${remaining.length}`)
    assert.equal(existsSync(latestLogPath(logs)), true, "the owner publishes a latest.log pointer")
    // The pointer resolves to this run's content.
    assert.equal(readFileSync(latestLogPath(logs), "utf8").includes("hello"), true)

    const before = readdirSync(logs).length
    const child = createLogger({ file: join(logs, "ntwine-new.log"), owner: false })
    child.info("dev-child", "adopted")
    assert.equal(readdirSync(logs).length, before, "an adopting child must not prune its parent's history")
    assert.equal(readFileSync(join(logs, "ntwine-new.log"), "utf8").includes("adopted"), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("retention drops anything past the count OR older than the age bound", () => {
  const dir = scratch()
  try {
    const fresh = join(dir, "ntwine-fresh.log")
    const ancient = join(dir, "ntwine-ancient.log")
    writeFileSync(fresh, "x")
    writeFileSync(ancient, "x")
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1_000)
    utimesSync(ancient, old, old)
    pruneRunLogs(dir, 20, 14)
    assert.equal(existsSync(fresh), true, "a recent log within the count survives")
    assert.equal(existsSync(ancient), false, "an old log is swept even though the count allows it")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a wedged subsystem cannot fill the disk", () => {
  const dir = scratch()
  try {
    const file = join(dir, "run.log")
    const logger = createLogger({ file, maxBytes: 400 })
    for (let index = 0; index < 200; index++) logger.info("tailer", `tick ${index}`)
    const written = readFileSync(file, "utf8")
    assert.equal(written.length < 600, true, `expected the cap to hold, saw ${written.length} bytes`)
    assert.match(written, /log truncated at 400 bytes/)
    assert.equal(logger.file, null, "a capped logger reports no usable file")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("two processes appending to one file interleave without losing a record", () => {
  const dir = scratch()
  try {
    const file = join(dir, "run.log")
    // Exactly the supervisor/child arrangement: separate loggers, same path, O_APPEND.
    const supervisor = createLogger({ file })
    const child = createLogger({ file, owner: false })
    for (let index = 0; index < 50; index++) {
      supervisor.info("supervisor", `s${index}`)
      child.info("dev-child", `c${index}`)
    }
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean)
    assert.equal(lines.length, 100, "every record from both writers survives")
    assert.equal(lines.filter((line) => line.includes("dev-child")).length, 50)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the child environment carries the parent's file so its records are never lost", () => {
  const dir = scratch()
  try {
    const file = join(dir, "run.log")
    const logger = createLogger({ file })
    assert.deepEqual(logEnvironment(logger, "info"), {
      NTWINE_LOG_FILE: file,
      NTWINE_LOG_LEVEL: "info",
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a crash record can be written without owning a logger", () => {
  const dir = scratch()
  try {
    const file = join(dir, "nested", "run.log")
    appendCrashRecord(file, "workspace resolution failed: not a git repository")
    assert.match(readFileSync(file, "utf8"), /ERROR\s+crash\s+workspace resolution failed/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("logging never throws when its directory is unusable", () => {
  const dir = scratch()
  try {
    // A path whose parent is a FILE cannot be created; the launch must still proceed.
    const blocker = join(dir, "blocker")
    writeFileSync(blocker, "not a directory")
    const logger = createLogger({ file: join(blocker, "run.log") })
    assert.equal(logger.file, null)
    assert.doesNotThrow(() => logger.error("launcher", "still alive"))
    assert.doesNotThrow(() => appendCrashRecord(join(blocker, "run.log"), "boom"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the terminal feed and the disk log agree, character for character", () => {
  const dir = scratch()
  try {
    // Asserted against the disk line rather than a literal clock, because both render LOCAL time and
    // a hard-coded string would only pass in the timezone it was written in. What matters is that the
    // two agree: they are the first two things compared when something goes wrong, and while the feed
    // used toISOString() they disagreed by the operator's whole UTC offset.
    const file = join(dir, "run.log")
    const record = { at: Date.now(), level: "warn" as const, scope: "tailer", message: "slow tick" }
    const logger = createLogger({ file, now: () => record.at })
    logger.warn(record.scope, record.message)
    assert.equal(formatFeedLine(record), readFileSync(file, "utf8").trimEnd())
    assert.match(formatFeedLine(record), /^\d\d:\d\d:\d\d\.\d\d\d {2}WARN {3}tailer {8}slow tick$/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an entry point that opens its run logger leaves a file behind — the dev entry once logged nowhere", () => {
  // packages/server/src/dev.ts installed no logger, and `ambientLogger()` deliberately invents no file
  // for an unconfigured process, so every record the dev board emitted was dropped. openRunLogger is
  // the one decision every entry point now shares: own a fresh run file beside the project's state.
  const stateDir = scratch()
  const restore = setAmbientLogger(createLogger({ file: null }))
  try {
    const logger = openRunLogger(stateDir, { env: {}, debug: false })
    log.warn("supervisor", "child exited before ready")
    const file = logger.file
    assert.ok(file, "the run logger must hold a file")
    assert.equal(join(file, ".."), join(stateDir, "logs"))
    assert.match(readFileSync(file, "utf8"), /WARN\s+supervisor\s+child exited before ready/)
    // It OWNS the directory: latest.log is repointed at this run, and its children are told the path.
    assert.match(readFileSync(latestLogPath(join(stateDir, "logs")), "utf8"), /child exited before ready/)
    assert.deepEqual(logEnvironment(logger, "info"), { NTWINE_LOG_FILE: file, NTWINE_LOG_LEVEL: "info" })
  } finally {
    setAmbientLogger(restore)
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test("a re-exec'd or forked entry ADOPTS its parent's run file and leaves the directory alone", () => {
  const stateDir = scratch()
  const parentDir = scratch()
  const restore = setAmbientLogger(createLogger({ file: null }))
  try {
    const parentFile = join(parentDir, "ntwine-parent.log")
    const logger = openRunLogger(stateDir, { env: { NTWINE_LOG_FILE: parentFile }, debug: false })
    assert.equal(logger.file, parentFile)
    log.info("server", "control plane listening")
    assert.match(readFileSync(parentFile, "utf8"), /INFO\s+server\s+control plane listening/)
    // No second file, no latest.log repointed away from the parent's run.
    assert.equal(existsSync(join(stateDir, "logs")), false)
    assert.equal(existsSync(latestLogPath(parentDir)), false)
  } finally {
    setAmbientLogger(restore)
    rmSync(stateDir, { recursive: true, force: true })
    rmSync(parentDir, { recursive: true, force: true })
  }
})
