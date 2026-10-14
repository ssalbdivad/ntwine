import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import {
  ntwinePaths,
  ntwinePathsNow,
  ntwineRoots,
  isPromptAttachmentPath,
  legacyNtwineRoot,
  projectStateDir,
  resetNtwineRoots,
  ROOTS_PIN_ENV,
  serverAddressPathForStateDir,
  withRootsPin,
} from "./ntwine-paths.ts"

const never = () => false
// The REAL disk, read afresh on every call. The cases below reshape one temp home between resolutions
// to pin what a freshly started process would conclude; without an injected `exists`, the per-process
// memo (ntwine-paths.ts) would — correctly — keep answering with the first resolution.
const disk = { exists: existsSync }

// The property the whole module exists to protect: an installed ntwine never moves. This tree reaches
// gigabytes, detached daemons hold descriptors into it, and the threads have no second copy.
test("an existing ~/.ntwine keeps every root, on every platform, whatever XDG says", () => {
  const base = mkdtempSync(join(tmpdir(), "ntwine-paths-legacy-"))
  try {
    mkdirSync(legacyNtwineRoot(base))
    // What makes it an install: every launch writes one (and see the debris case below).
    writeFileSync(join(legacyNtwineRoot(base), "registry.json"), "{}")
    for (const platform of ["darwin", "linux", "win32"] as const) {
      const paths = ntwinePaths({
        home: base,
        platform,
        env: { XDG_DATA_HOME: "/xdg", XDG_CACHE_HOME: "/xdg", LOCALAPPDATA: "C:\\Local" },
      })
      assert.equal(paths.legacy, true, platform)
      assert.equal(paths.data, join(base, ".ntwine"), platform)
      assert.equal(paths.state, join(base, ".ntwine"), platform)
      assert.equal(paths.cache, join(base, ".ntwine"), platform)
    }
    assert.equal(projectStateDir("p1", base), join(base, ".ntwine", "projects", "p1"))
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

// `~/.ntwine` is also the name the home folder's own BOARD would have. A Home-workspace worker writing
// the conventional relative `.ntwine/threads/<id>/` from its cwd must not flip an XDG install onto an
// empty legacy root at the next boot — every project gone from the page.
test("a ~/.ntwine holding only a project board is passed over, not taken as the data root", () => {
  const linux = { home: "/home/x", platform: "linux" as const, env: {} }
  const root = legacyNtwineRoot("/home/x")
  const only = (...names: string[]) => {
    const present = new Set([root, ...names.map((name) => join(root, name))])
    return (path: string) => present.has(path)
  }
  for (const board of ["threads", ".id", ".session-state", ".gitignore", ".agent-bindings.jsonl"]) {
    const paths = ntwinePaths({ ...linux, exists: only(board) })
    assert.equal(paths.legacy, false, board)
    assert.equal(paths.data, join("/home/x", ".local", "share", "ntwine"), board)
  }
  // Any data-root entry makes it a real install, whatever board-shaped debris sits beside it.
  for (const data of ["projects", "registry.json", "config.json", "ui.db", "server.lock", "settings.json", "logs"]) {
    assert.equal(ntwinePaths({ ...linux, exists: only(data) }).legacy, true, data)
    assert.equal(ntwinePaths({ ...linux, exists: only("threads", data) }).legacy, true, `threads + ${data}`)
  }
  // Something unrecognised is not a board, so it stays legacy — the rule only ever passes over a board.
  assert.equal(ntwinePaths({ ...linux, exists: only("whatever") }).legacy, true)
})

test("the stray-board rule holds on a real directory, and a real install beside it wins", () => {
  const base = mkdtempSync(join(tmpdir(), "ntwine-paths-stray-"))
  try {
    mkdirSync(join(legacyNtwineRoot(base), "threads", "sid-1"), { recursive: true })
    assert.equal(ntwinePaths({ home: base, platform: "linux", env: {}, ...disk }).legacy, false)
    writeFileSync(join(legacyNtwineRoot(base), "registry.json"), "{}")
    assert.equal(ntwinePaths({ home: base, platform: "linux", env: {}, ...disk }).legacy, true)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

// 2026-09-28: a script provisioned runtimes into `~/.ntwine/runtimes` by name, the next boot took that
// directory for a legacy install, and every project vanished from an established XDG machine.
test("a ~/.ntwine with no registry never takes over an install whose platform root has one", () => {
  const base = mkdtempSync(join(tmpdir(), "ntwine-paths-superseded-"))
  try {
    const linux = { home: base, platform: "linux" as const, env: {}, ...disk }
    const platformData = join(base, ".local", "share", "ntwine")
    mkdirSync(platformData, { recursive: true })
    writeFileSync(join(platformData, "registry.json"), "{}")
    // What the stray writer left, and what the flipped boot then added before anyone noticed.
    mkdirSync(join(legacyNtwineRoot(base), "runtimes", "claude"), { recursive: true })
    mkdirSync(join(legacyNtwineRoot(base), "projects", "p1"), { recursive: true })
    const paths = ntwinePaths(linux)
    assert.equal(paths.legacy, false)
    assert.equal(paths.data, platformData)
    // A ~/.ntwine with a registry of its own is a real install, and it keeps winning.
    writeFileSync(join(legacyNtwineRoot(base), "registry.json"), "{}")
    assert.equal(ntwinePaths(linux).legacy, true)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

// 2026-10-02: a harness isolated a test board with XDG_* pointed at a fresh temp dir. `~/.ntwine` held
// only agent scratch debris, the legacy rule handed the harness that real directory anyway, and the
// registry it wrote there flipped the LIVE board onto it.
test("a ~/.ntwine with no registry never outranks an XDG_DATA_HOME somebody set", () => {
  const base = mkdtempSync(join(tmpdir(), "ntwine-paths-explicit-"))
  try {
    const isolated = join(base, "isolated-xdg")
    const env = { XDG_DATA_HOME: join(isolated, "data"), XDG_STATE_HOME: join(isolated, "state"), XDG_CACHE_HOME: join(isolated, "cache") }
    mkdirSync(join(legacyNtwineRoot(base), "scratch", "thread-1"), { recursive: true })
    mkdirSync(join(legacyNtwineRoot(base), "projects", "p1"), { recursive: true })
    const paths = ntwinePaths({ home: base, platform: "linux", env, ...disk })
    assert.equal(paths.legacy, false)
    assert.equal(paths.data, join(isolated, "data", "ntwine"))
    assert.equal(paths.cache, join(isolated, "cache", "ntwine"))
    // Unset, the same debris is still honored on a machine with no other install — that rule is unchanged.
    assert.equal(ntwinePaths({ home: base, platform: "linux", env: {}, ...disk }).legacy, true)
    // And a ~/.ntwine with a registry is an install, which keeps winning over a set XDG variable.
    writeFileSync(join(legacyNtwineRoot(base), "registry.json"), "{}")
    assert.equal(ntwinePaths({ home: base, platform: "linux", env, ...disk }).legacy, true)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

// A RUNNING PROCESS KEEPS THE ROOTS IT RESOLVED. 2026-10-02: a harness wrote `registry.json` into a
// debris `~/.ntwine`; the live server re-resolved on its next registry lookup, took that file for a
// legacy install, and answered 404 to every worker's `/_ntwine/<project>/rpc/…` call. The stray write
// below is the same one, and the fresh resolution after it is the control: it proves the file DOES
// flip the rule, so the memoised answer holding still is the memo working, not a write that missed.
test("after first resolution, a registry dropped into ~/.ntwine does not move this process's roots", () => {
  const base = mkdtempSync(join(tmpdir(), "ntwine-paths-stable-"))
  try {
    const linux = { home: base, platform: "linux" as const, env: {} }
    const platformData = join(base, ".local", "share", "ntwine")
    mkdirSync(platformData, { recursive: true })
    writeFileSync(join(platformData, "registry.json"), "{}")
    mkdirSync(join(legacyNtwineRoot(base), "scratch", "thread-1"), { recursive: true })
    const before = ntwinePaths(linux)
    assert.equal(before.data, platformData)
    assert.equal(before.legacy, false)
    // The production form: process.env and process.platform, whatever this host's are. Its value is
    // host-dependent (macOS, a set XDG_DATA_HOME), so the assertion is that it HOLDS STILL, not where.
    const helperBefore = projectStateDir("p1", base)

    writeFileSync(join(legacyNtwineRoot(base), "registry.json"), JSON.stringify({ projects: [] }))
    assert.equal(ntwinePaths({ ...linux, ...disk }).legacy, true, "control: a fresh resolution now takes ~/.ntwine")
    assert.equal(ntwinePathsNow(linux).legacy, true, "and so does a discovery reader, which never memoises")
    const after = ntwinePaths(linux)
    assert.deepEqual(after, before, "the running process stays on the root it resolved")
    assert.equal(projectStateDir("p1", base), helperBefore, "home-taking helpers hold still too")
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

// The first-launch question the memo could get wrong: a fresh machine resolves BEFORE anything exists,
// then the launch creates the platform root. Caching "no install yet" must hold exactly the root the
// launch creates, and must agree with what the NEXT process resolves once the install exists — even if
// debris `~/.ntwine` appears in between. (A guard: it passes on the unmemoised code too, by design.)
test("caching 'no install yet' points at the root a first launch creates, and the next process agrees", () => {
  const base = mkdtempSync(join(tmpdir(), "ntwine-paths-first-"))
  try {
    const linux = { home: base, platform: "linux" as const, env: {} }
    const first = ntwinePaths(linux)
    assert.equal(first.legacy, false)
    assert.equal(first.data, join(base, ".local", "share", "ntwine"))
    // The launch establishes the install where this process said it would.
    mkdirSync(first.data, { recursive: true })
    writeFileSync(join(first.data, "registry.json"), "{}")
    assert.deepEqual(ntwinePaths({ ...linux, ...disk }), first, "a later process resolves the same root")
    // Debris lands by name; neither this process nor the next one moves for it.
    mkdirSync(join(legacyNtwineRoot(base), "runtimes"), { recursive: true })
    assert.deepEqual(ntwinePaths(linux), first)
    assert.deepEqual(ntwinePaths({ ...linux, ...disk }), first)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

// The memo is keyed, not one slot: a sandbox swaps $HOME before first use (prepareSandbox) and still
// resolves the operator's real roots, and every test hands in its own temp home. Each must get its own
// answer. The $HOME case drives `ntwineRoots()`, the no-argument form production uses, which until this
// change kept the FIRST home's answer for the life of the process whatever $HOME said next.
test("a different home, XDG root or $HOME gets its own answer, not the first one memoised", () => {
  const legacyHome = mkdtempSync(join(tmpdir(), "ntwine-paths-key-legacy-"))
  const freshHome = mkdtempSync(join(tmpdir(), "ntwine-paths-key-fresh-"))
  const savedHome = process.env.HOME
  try {
    mkdirSync(legacyNtwineRoot(legacyHome))
    writeFileSync(join(legacyNtwineRoot(legacyHome), "registry.json"), "{}")
    const legacy = ntwinePaths({ home: legacyHome, platform: "linux", env: {} })
    const fresh = ntwinePaths({ home: freshHome, platform: "linux", env: {} })
    assert.equal(legacy.data, legacyNtwineRoot(legacyHome))
    assert.equal(fresh.data, join(freshHome, ".local", "share", "ntwine"))

    const env = { XDG_DATA_HOME: join(freshHome, "xdg-data") }
    assert.equal(ntwinePaths({ home: freshHome, platform: "linux", env }).data, join(freshHome, "xdg-data", "ntwine"))
    assert.equal(ntwinePaths({ home: freshHome, platform: "darwin", env: {} }).data, join(freshHome, "Library", "Application Support", "ntwine"))

    process.env.HOME = legacyHome
    const a = ntwineRoots().data
    process.env.HOME = freshHome
    const b = ntwineRoots().data
    // Only meaningful where homedir() reads $HOME (POSIX); win32 reads USERPROFILE.
    if (process.platform !== "win32") {
      assert.equal(a, legacyNtwineRoot(legacyHome))
      assert.notEqual(b, a, "a swapped $HOME is a different home")
    }
  } finally {
    process.env.HOME = savedHome
    rmSync(legacyHome, { recursive: true, force: true })
    rmSync(freshHome, { recursive: true, force: true })
  }
})

// The memo's KEY is the decision's inputs and nothing else. Each case below shapes a home so that two
// values of one input DESERVE different decisions; a key missing that input would hand the second
// value the first one's decision. XDG_STATE_HOME / XDG_CACHE_HOME are the opposite case: they never
// change the decision, so they share it — and the roots they move still follow the caller's env.
test("the memo splits on XDG_DATA_HOME and win32 %LOCALAPPDATA%, and state/cache roots follow the env", () => {
  const base = mkdtempSync(join(tmpdir(), "ntwine-paths-keyparts-"))
  try {
    // Debris ~/.ntwine, no registry anywhere: legacy by default, but it yields to a SET XDG_DATA_HOME.
    mkdirSync(legacyNtwineRoot(base))
    const unset = ntwinePaths({ home: base, platform: "linux", env: {} })
    assert.equal(unset.legacy, true)
    const set = ntwinePaths({ home: base, platform: "linux", env: { XDG_DATA_HOME: join(base, "d") } })
    assert.equal(set.legacy, false, "a set XDG_DATA_HOME is its own decision")
    assert.equal(set.data, join(base, "d", "ntwine"))

    // win32: %LOCALAPPDATA% decides where the platform data root is, and so whether it already holds
    // an install that outranks the registry-less ~/.ntwine (supersededByInstall).
    const localA = join(base, "A")
    mkdirSync(join(localA, "ntwine", "Data"), { recursive: true })
    writeFileSync(join(localA, "ntwine", "Data", "registry.json"), "{}")
    const a = ntwinePaths({ home: base, platform: "win32", env: { LOCALAPPDATA: localA } })
    assert.equal(a.legacy, false)
    assert.equal(a.data, join(localA, "ntwine", "Data"))
    const b = ntwinePaths({ home: base, platform: "win32", env: { LOCALAPPDATA: join(base, "B") } })
    assert.equal(b.legacy, true, "another %LOCALAPPDATA% with no install is its own decision")

    // Not a decision input: the roots move, the decision is shared.
    const freshHome = join(base, "fresh")
    mkdirSync(freshHome)
    const plain = ntwinePaths({ home: freshHome, platform: "linux", env: {} })
    const moved = ntwinePaths({ home: freshHome, platform: "linux", env: { XDG_STATE_HOME: join(base, "s"), XDG_CACHE_HOME: join(base, "c") } })
    assert.equal(moved.data, plain.data)
    assert.equal(moved.state, join(base, "s", "ntwine"))
    assert.equal(moved.cache, join(base, "c", "ntwine"))
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

// One directory, several spellings. Production asks under the raw home (`registryPath(homedir())`)
// AND its realpath (project-identity.ts `canonicalHome`), and a spelling first asked AFTER a stray
// write must not get a fresh — flipped — decision. The roots keep each caller's own spelling.
test("a symlinked or trailing-slash spelling of a home shares that home's decision", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-paths-spelling-")))
  try {
    const real = join(base, "real")
    const link = join(base, "link")
    mkdirSync(join(real, ".local", "share", "ntwine"), { recursive: true })
    writeFileSync(join(real, ".local", "share", "ntwine", "registry.json"), "{}")
    mkdirSync(legacyNtwineRoot(real))
    symlinkSync(real, link)
    const linux = { platform: "linux" as const, env: {} }
    assert.equal(ntwinePaths({ ...linux, home: link }).legacy, false)

    writeFileSync(join(legacyNtwineRoot(real), "registry.json"), "{}")
    assert.equal(ntwinePaths({ ...linux, home: real, ...disk }).legacy, true, "control: the write flips a fresh resolution")
    const canonical = ntwinePaths({ ...linux, home: real })
    assert.equal(canonical.legacy, false, "the realpath spelling shares the link's decision")
    assert.equal(canonical.data, join(real, ".local", "share", "ntwine"), "and keeps its own spelling")
    assert.equal(ntwinePaths({ ...linux, home: `${link}/` }).legacy, false, "so does a trailing slash")
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

// THE PIN: what carries a decision across a SERVER restart. The dev supervisor forks a fresh child on
// every source edit and crash; without it that child resolved again at boot and took the stray
// `~/.ntwine` (reproduced 2026-10-02 against a real `src/dev.ts`: 404 on 10/10 reads after a restart).
// `resetNtwineRoots()` below stands in for the fresh child process: no memo, only the inherited env.
test("a child handed the supervisor's pin keeps its roots after a stray write; a mismatched pin is ignored", () => {
  const base = mkdtempSync(join(tmpdir(), "ntwine-paths-pin-"))
  try {
    // withRootsPin pins for THIS host's platform, so the install sits wherever this host puts it.
    const parentEnv: NodeJS.ProcessEnv = { HOME: base, USERPROFILE: base }
    const platformData = ntwinePaths({ env: parentEnv, home: base, exists: never }).data
    mkdirSync(platformData, { recursive: true })
    writeFileSync(join(platformData, "registry.json"), "{}")
    mkdirSync(legacyNtwineRoot(base))
    const childEnv = withRootsPin(parentEnv)
    assert.ok(childEnv[ROOTS_PIN_ENV], "the pin rides in the child's environment")
    assert.equal(parentEnv[ROOTS_PIN_ENV], undefined, "the caller's env object is not mutated")

    writeFileSync(join(legacyNtwineRoot(base), "registry.json"), "{}")
    resetNtwineRoots()
    const child = ntwinePaths({ env: childEnv, home: base })
    assert.equal(child.legacy, false, "the restarted child stays on the root the supervisor booted on")
    assert.equal(child.data, platformData)

    resetNtwineRoots()
    assert.equal(ntwinePaths({ env: parentEnv, home: base }).legacy, true, "control: without the pin a fresh process flips")

    // A pin is for ONE key. A harness that isolates itself by another home or data root resolves on
    // its own, and garbage is ignored rather than trusted.
    resetNtwineRoots()
    const other = mkdtempSync(join(tmpdir(), "ntwine-paths-pin-other-"))
    try {
      mkdirSync(legacyNtwineRoot(other))
      writeFileSync(join(legacyNtwineRoot(other), "registry.json"), "{}")
      assert.equal(ntwinePaths({ env: { ...childEnv, HOME: other, USERPROFILE: other }, home: other }).legacy, true, "another home ignores the pin")
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
    resetNtwineRoots()
    // (~/.ntwine now has a registry, which outranks a set XDG_DATA_HOME — so honoring the pin here
    // would have said legacy: false.)
    assert.equal(ntwinePaths({ env: { ...childEnv, XDG_DATA_HOME: join(base, "x") }, home: base }).legacy, true, "another data root ignores the pin")
    resetNtwineRoots()
    assert.equal(ntwinePaths({ env: { ...parentEnv, [ROOTS_PIN_ENV]: "{not json" }, home: base }).legacy, true, "a malformed pin is ignored")
  } finally {
    resetNtwineRoots()
    rmSync(base, { recursive: true, force: true })
  }
})

// An injected `exists` describes an imaginary disk. Its answer must never be served for the real one —
// and a memoised real answer must never be served for it — in either order.
test("an injected exists bypasses the memo in both directions", () => {
  const base = mkdtempSync(join(tmpdir(), "ntwine-paths-inject-"))
  try {
    const linux = { home: base, platform: "linux" as const, env: {} }
    const everything = () => true
    assert.equal(ntwinePaths({ ...linux, exists: everything }).legacy, true, "imaginary disk first")
    assert.equal(ntwinePaths(linux).legacy, false, "the real (empty) home was not answered from the imaginary one")
    assert.equal(ntwinePaths({ ...linux, exists: everything }).legacy, true, "nor the imaginary one from the real memo")
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

// Every expectation below is SPELLED WITH join(), never with a literal "/a/b/c". These cases pin the
// platform BRANCH, which is injected, while the separator is the HOST's — so a POSIX literal is a
// second, accidental assertion that the suite is running on POSIX, and on Windows the same correct
// branch answers `\home\x\.local\share\ntwine`. join() states the branch and nothing else.
test("a machine that has never run ntwine gets the platform's own locations", () => {
  const linux = ntwinePaths({ home: "/home/x", platform: "linux", env: {}, exists: never })
  assert.deepEqual(
    { data: linux.data, state: linux.state, cache: linux.cache, legacy: linux.legacy },
    {
      data: join("/home/x", ".local", "share", "ntwine"),
      state: join("/home/x", ".local", "state", "ntwine"),
      cache: join("/home/x", ".cache", "ntwine"),
      legacy: false,
    },
  )

  const mac = ntwinePaths({ home: "/Users/x", platform: "darwin", env: {}, exists: never })
  assert.equal(mac.data, join("/Users/x", "Library", "Application Support", "ntwine"))
  assert.equal(mac.cache, join("/Users/x", "Library", "Caches", "ntwine"))
})

test("a set XDG variable wins on every platform, and each one moves only its own root", () => {
  const partial = ntwinePaths({
    home: "/Users/x",
    platform: "darwin",
    env: { XDG_CACHE_HOME: "/c" },
    exists: never,
  })
  assert.equal(partial.cache, join("/c", "ntwine"), "the variable that was set moves")
  assert.equal(partial.data, join("/Users/x", "Library", "Application Support", "ntwine"), "the others do not")

  const all = ntwinePaths({
    home: "/home/x",
    platform: "linux",
    env: { XDG_DATA_HOME: "/d", XDG_STATE_HOME: "/s", XDG_CACHE_HOME: "/c" },
    exists: never,
  })
  assert.deepEqual([all.data, all.state, all.cache], [join("/d", "ntwine"), join("/s", "ntwine"), join("/c", "ntwine")])
})

// The spec says a relative XDG value is invalid and must be ignored, which matters here because a
// relative root would resolve against whatever cwd a daemon happened to inherit.
test("a relative or empty XDG value is ignored rather than resolved against the cwd", () => {
  for (const value of ["relative/share", "", "   "]) {
    const paths = ntwinePaths({ home: "/home/x", platform: "linux", env: { XDG_DATA_HOME: value }, exists: never })
    assert.equal(paths.data, join("/home/x", ".local", "share", "ntwine"), JSON.stringify(value))
  }
})

test("Windows uses Local, never Roaming — a multi-gigabyte cache must not follow the user", () => {
  const paths = ntwinePaths({
    home: "C:\\Users\\x",
    platform: "win32",
    env: { LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local", APPDATA: "C:\\Users\\x\\AppData\\Roaming" },
    exists: never,
  })
  for (const root of [paths.data, paths.state, paths.cache]) {
    assert.match(root, /AppData[\\/]Local[\\/]ntwine/)
    assert.doesNotMatch(root, /Roaming/)
  }

  // A stripped environment still has to land somewhere sane rather than at the filesystem root.
  const bare = ntwinePaths({
    home: "C:\\Users\\x",
    platform: "win32",
    env: { USERPROFILE: "C:\\Users\\x" },
    exists: never,
  })
  assert.match(bare.data, /Users[\\/]x[\\/]AppData[\\/]Local[\\/]ntwine/)
})

// A SANDBOX HAS TO STAY SANDBOXED ON WIN32 TOO, and %LOCALAPPDATA% is what used to break that:
// `ntwinePaths({ home })` is the ONE mechanism every sandbox here has (projectStateDir, registryPath,
// machineConfigPath, serverAddressPath, stablePluginPath), and on Windows all of them collapsed onto
// the live account's single `%LOCALAPPDATA%\ntwine` tree whatever home they were handed — a suite run
// rewrote the operator's own settings.json and registry (first Windows suite run, 2026-08-24). The
// variable describes the PROCESS's home, so it is honored only when it sits under the home in hand.
test("on win32 the home in hand outranks a %LOCALAPPDATA% belonging to another tree", () => {
  const inherited = { LOCALAPPDATA: "C:\\Users\\nub\\AppData\\Local", USERPROFILE: "C:\\Users\\nub" }
  const sandbox = (home: string) => ntwinePaths({ home, platform: "win32", env: inherited, exists: never })
  const a = sandbox("C:\\tmp\\a\\home")
  const b = sandbox("C:\\tmp\\b\\home")
  for (const [label, paths, home] of [["a", a, "a"], ["b", b, "b"]] as const) {
    for (const root of [paths.data, paths.state, paths.cache]) {
      assert.match(root, new RegExp(`^C:[\\\\/]tmp[\\\\/]${home}[\\\\/]home[\\\\/]AppData[\\\\/]Local[\\\\/]ntwine`), label)
    }
  }
  assert.notEqual(a.data, b.data, "two sandboxes are two trees, not one shared one")

  // The converse, and the reason the test is containment rather than "was a home passed": a real
  // account's %LOCALAPPDATA% is still used VERBATIM, matched the way Windows itself matches a path —
  // without case. The value below differs from `join(home, "AppData", "Local")` only in case, so an
  // answer spelled like the home would prove the variable had been thrown away.
  const real = ntwinePaths({
    home: "C:\\Users\\x",
    platform: "win32",
    env: { LOCALAPPDATA: "c:\\users\\x\\AppData\\Local" },
    exists: never,
  })
  assert.equal(real.data, join("c:\\users\\x\\AppData\\Local", "ntwine", "Data"))
})

// THE ADDRESS AND THE STATE DIR MUST AGREE, and the agreement is `../..` — the exact derivation the
// worker shim performs on NTWINE_STATE_DIR (cc-worker/bin/ntwine-mcp.mjs). If these two ever disagree, a
// worker looks for the machine address somewhere the server never writes it, and the failure is a tool
// that silently cannot find its server.
//
// The second assertion is the one with teeth: deriving the address from `homedir()` instead let a TEST
// RUN publish and then retire the real machine's `~/.ntwine/server.lock`, out from under a live server
// (2026-08-08). Anything sandboxed must stay sandboxed.
test("the machine server address is ../.. from a project state dir, in whatever root that is", () => {
  // Asserted as a RELATIONSHIP, not a spelling: the root differs by platform and by whether a legacy
  // `~/.ntwine` exists, and what must hold everywhere is that the address sits beside `projects/`.
  for (const base of ["/home/x", "/tmp/sandbox-home"]) {
    const stateDir = projectStateDir("p1", base)
    assert.equal(serverAddressPathForStateDir(stateDir), join(dirname(dirname(stateDir)), "server.lock"))
    assert.equal(dirname(dirname(stateDir)), dirname(dirname(projectStateDir("p2", base))), "one root, whatever the project")
  }
  // And the sandbox one must never resolve into the real machine's root — the leak that let a test run
  // retire `~/.ntwine/server.lock` out from under a live server (2026-08-08).
  // join() with one argument is just normalization, and that is the point: on win32 the sandbox home
  // spells itself `\tmp\sandbox-home`, so a literal prefix would fail an address that never escaped.
  const sandboxed = serverAddressPathForStateDir(projectStateDir("p1", "/tmp/sandbox-home"))
  assert.ok(sandboxed.startsWith(join("/tmp/sandbox-home")), `sandboxed address escaped: ${sandboxed}`)
})

// The transcript keeps a picture OFF a Read of the human's own prompt attachment (their bubble shows it
// already) and ON every other image read — so the predicate has to be exact about the tree shape.
test("isPromptAttachmentPath matches only <data>/projects/<id>/attachments/…", () => {
  const home = mkdtempSync(join(tmpdir(), "ntwine-attach-"))
  const data = ntwinePaths({ home }).data
  const attachments = join(data, "projects", "029a30af-f126-40e3-b04c-d80e74e3e090", "attachments")
  assert.equal(isPromptAttachmentPath(join(attachments, "1787867365865-f12df6c2-Screenshot-2026-08-27-at-14-49-15.png"), home), true)
  assert.equal(isPromptAttachmentPath(join(attachments, "nested", "shot.png"), home), true)
  // A screenshot the worker took, a file elsewhere in the tree, the attachments dir itself, and a
  // path that only ESCAPES into the tree via `..` all stay ordinary image reads.
  assert.equal(isPromptAttachmentPath("/tmp/ntwine-shots/out.png", home), false)
  assert.equal(isPromptAttachmentPath(join(data, "projects", "p", "threads", "x.png"), home), false)
  assert.equal(isPromptAttachmentPath(attachments, home), false)
  assert.equal(isPromptAttachmentPath(join(data, "projects", "p", "attachments"), home), false)
  assert.equal(isPromptAttachmentPath(join(data, "projects", "..", "projects", "p", "attachments", "a.png"), home), true)
  assert.equal(isPromptAttachmentPath(join(data, "attachments", "a.png"), home), false)
  rmSync(home, { recursive: true, force: true })
})
