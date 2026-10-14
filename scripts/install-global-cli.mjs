#!/usr/bin/env node
import {
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const MARKER = "# ntwine-dev-source-launcher:v5";
const args = new Set(process.argv.slice(2));
const knownArgs = new Set(["--uninstall", "--check", "--force", "--help"]);
for (const arg of process.argv.slice(2)) {
  if (!knownArgs.has(arg) && !arg.startsWith("--bin-dir=")) {
    console.error(`unknown option: ${arg}`);
    process.exit(1);
  }
}

const command = "ntwine-dev";
const windows = process.platform === "win32";
// WINDOWS RESOLVES A COMMAND BY EXTENSION, so the shim's NAME is part of the contract.
//
// cmd.exe and PowerShell find a bare `ntwine-dev` on PATH only if its extension is listed in
// %PATHEXT% (`.COM;.EXE;.BAT;.CMD;…`), and neither one honours a `#!` line. An extensionless
// `#!/bin/sh` file is therefore not a command on Windows — it is an unrunnable text file, and
// `ntwine-dev` simply did not exist there. `.cmd` is the shape npm's own bin shims use for the
// same reason. Only a Git Bash / MSYS shell would want the sh form; it can still call the
// launcher directly, and carrying two shims would double every ownership and atomicity rule below.
const shimName = windows ? `${command}.cmd` : command;

if (args.has("--help")) {
  console.log(
    "Usage: nub run ntwine-dev:install [-- --bin-dir=/path] [--force]\n" +
      "       nub run ntwine-dev:check [-- --bin-dir=/path]\n" +
      "       nub run ntwine-dev:uninstall [-- --bin-dir=/path]\n\n" +
      "Installs ntwine-dev, the source-checkout launcher."
  );
  process.exit(0);
}

const binDirArg = process.argv
  .find((arg) => arg.startsWith("--bin-dir="))
  ?.slice("--bin-dir=".length);
const binDir = binDirArg || process.env.NTWINE_BIN_DIR || join(homedir(), ".local", "bin");
const target = join(binDir, shimName);
const launcher = realpathSync(
  fileURLToPath(new URL("../src/index.ts", import.meta.url))
);
const quote = (value) => `'${value.replaceAll("'", `"'"'`)}'`;
// A batch file expands `%NAME%` in an argument even inside double quotes, and `%%` is its only
// escape for a literal one. Windows paths may legally contain `%`; they may not contain `"`.
const cmdQuote = (value) => `"${value.replaceAll("%", "%%")}"`;
// `--no-env-file` disables nub's automatic `.env*` discovery for the launcher process only. nub
// resolves those files from the CWD's project root, so launching a board from any repo carrying an
// ANTHROPIC_API_KEY in its .env put that key in the ntwine server env — and from there into every
// detached worker daemon it forks, each of which outlives the shell, where Claude Code blocks on
// "Detected a custom API key". v4 fixed this with `env -u` and was
// reverted (3f311e9) for being too invasive: it also stripped a key the developer had deliberately
// exported. This is the narrower cut — it drops only what nub read off DISK. A key exported in the
// shell still reaches the worker, so letting an API key supersede the subscription stays available.
//
// The batch translation of that one line, clause by clause, because none of it is guessable:
//   · `rem #` keeps the ownership MARKER byte-identical across platforms — `#` is not a comment in
//     batch, `rem` is, and the marker is matched as a substring.
//   · `setlocal` is `env VAR=…`: the variable exists for the child and dies with the shim, instead
//     of leaking into the calling console for the rest of its life.
//   · a batch file WAITS rather than exec-replacing, so the exit code has to be forwarded by hand.
//     `exit /b %ERRORLEVEL%` reads the value at the moment the line is parsed, which is after the
//     launcher returned; without it every failed launch reports success.
//   · CRLF, deliberately: cmd.exe's parser is documented against CRLF and mis-handles LF-only files
//     in ways that depend on the command (a split `goto`, a swallowed final line).
const body = windows
  ? `@echo off\r\nrem ${MARKER}\r\nsetlocal\r\nset "NTWINE_SOURCE_COMMAND=${command}"\r\nnub --no-env-file ${cmdQuote(launcher)} %*\r\nexit /b %ERRORLEVEL%\r\n`
  : `#!/bin/sh\n${MARKER}\nexec env NTWINE_SOURCE_COMMAND=${quote(command)} nub --no-env-file ${quote(launcher)} "$@"\n`;

/** Exactly the launcher this run would write — i.e. already current, nothing to do. */
function isOwned(path) {
  try {
    if (!lstatSync(path).isFile()) return false;
    return readFileSync(path, "utf8") === body;
  } catch {
    return false;
  }
}

/**
 * Written by THIS installer, whatever checkout it points at.
 *
 * A byte-for-byte comparison against `body` cannot tell "someone else's ntwine-dev" from "our own
 * launcher aimed at a path that moved" — and the second is routine: move or re-clone the checkout, or
 * relocate the CLI inside it, and the embedded path changes. Guarding replacement on the exact body
 * therefore refused to upgrade our own shim and said `is not the ntwine source launcher` about a file
 * whose first comment line is that very marker. Ownership is the marker; the body is only currency.
 */
function isOurs(path) {
  try {
    if (!lstatSync(path).isFile()) return false;
    return readFileSync(path, "utf8").includes(MARKER);
  } catch {
    return false;
  }
}

function targetExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function syncDirectory(path) {
  // A directory fsync makes the rename durable on filesystems that support it.
  // Some platforms/filesystems reject it, but the replacement itself is still atomic.
  let directory;
  try {
    directory = openSync(path, "r");
    fsyncSync(directory);
  } catch {
    // Best effort only: notably unsupported by some Windows/network filesystems.
  } finally {
    if (directory !== undefined) closeSync(directory);
  }
}

/**
 * Run one filesystem operation, waiting out the SHARING VIOLATIONS Windows reports transiently.
 *
 * POSIX `rename(2)` and `unlink(2)` are unconditional and succeed on the first pass, so this loop is
 * inert there. Windows publishes through `MoveFileEx`, which needs DELETE access on both names and
 * answers EPERM/EACCES/EBUSY the moment something else holds one — most often not another installer
 * at all but the machine's own real-time scanner or indexer, which opens every newly created
 * executable the instant it appears. That is the well-known reason git, npm and `rmSync`'s own
 * `maxRetries` all retry this exact call rather than trusting it once.
 *
 * (Concurrent READERS are not the cause: libuv opens with FILE_SHARE_READ|WRITE|DELETE precisely so
 * an open file stays deletable, so eight siblings reading the shim to decide ownership do not block
 * the replacement. The 8-way test's children exited 1 with `stdio: "ignore"` discarding the errno,
 * so the exact code is still unknown — the test now captures stderr to name it next time.)
 */
function retryTransient(operation) {
  for (let attempt = 0; ; attempt++) {
    try {
      return operation();
    } catch (error) {
      const code = error?.code;
      if (attempt >= 40 || (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY")) throw error;
      // Synchronous by necessity — the whole installer is, and what we wait on is a handle closing
      // in another process, not work of our own.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

function writeAtomic(path, contents) {
  const temp = join(
    binDir,
    `.${command}.${process.pid}.${crypto.randomUUID()}.tmp`
  );
  let descriptor;
  try {
    // Exclusive creation prevents one installer from ever writing another's temp file.
    descriptor = openSync(temp, "wx", 0o700);
    writeFileSync(descriptor, contents, "utf8");
    fchmodSync(descriptor, 0o755);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    // rename replaces a symlink itself, never the symlink's referent.
    retryTransient(() => renameSync(temp, path));
    syncDirectory(binDir);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      // Only reachable when the rename above never happened; a published temp is already gone.
      retryTransient(() => unlinkSync(temp));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

const label = "ntwine development source launcher";

if (args.has("--uninstall")) {
  if (existsSync(target) && isOurs(target)) {
    unlinkSync(target);
    console.log(`removed ${target}`);
  } else console.log(`no ${label} found at ${target}`);
  process.exit(0);
}

if (args.has("--check")) {
  if (existsSync(target) && isOwned(target)) {
    console.log(`installed ${label}: ${target}`);
    process.exit(0);
  }
  console.error(`${label} is not installed at ${target}`);
  process.exit(1);
}

mkdirSync(binDir, { recursive: true });
if (targetExists(target) && !isOurs(target) && !args.has("--force")) {
  console.error(
    `${target} already exists and is not the ntwine source launcher; rerun with --force to replace it`
  );
  process.exit(1);
}
writeAtomic(target, body);
console.log(`installed ${target}`);
console.log(`source: ${launcher}`);
if (!(process.env.PATH ?? "").split(delimiter).includes(binDir)) {
  // Deliberately NOT `setx` on Windows, which is the usual advice and a real footgun: it rewrites
  // the stored PATH and truncates it at 1024 characters. Show the session-local form and name where
  // the durable edit lives.
  console.log(
    windows
      ? `add this directory to PATH:\n  set PATH=${binDir};%PATH%\n  (to keep it, edit Path under System properties > Environment variables)`
      : `add this directory to PATH:\n  export PATH=${quote(binDir)}:"$PATH"`
  );
}
