import assert from "node:assert/strict"
import { after, test } from "node:test"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import { defaultPluginStageRoot, defaultStablePluginRoot, ensureSymlink, pluginContentDigest, pluginFingerprint, stageStablePluginDir } from "./stable-plugin-path.ts"

// Every scratch dir is removed when the file finishes. Recursive rm unlinks the links inside it rather
// than following them, on every Node — only a non-recursive rm of a link hits nodejs/node#61040.
const scratch: string[] = []
after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }) })
const tmp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(dir)
  return dir
}

/** A minimal plugin tree: a hooks.json plus the script it names, so a half-staged copy is detectable. */
function plugin(root: string, marker: string): string {
  const dir = join(root, "cc-worker")
  mkdirSync(join(dir, "hooks"), { recursive: true })
  writeFileSync(join(dir, "hooks", "hooks.json"), JSON.stringify({ hooks: { Stop: marker } }))
  writeFileSync(join(dir, "hooks", "stop.mjs"), `// ${marker}\n`)
  return dir
}

// ---- ensureSymlink: the four cases, stated one at a time ----------------------------------------

test("ensureSymlink creates a missing link, and is a no-op when it is already correct", () => {
  const dir = tmp("frizz-symlink-")
  const target = join(dir, "target")
  mkdirSync(target)
  const link = join(dir, "nested", "current")

  assert.equal(ensureSymlink(link, target), "created", "a missing link is created, parents included")
  assert.equal(readlinkSync(link), target)
  assert.equal(ensureSymlink(link, target), "unchanged", "the same call again must not churn the link")
})

test("ensureSymlink repoints a link aimed elsewhere — the case the whole design rests on", () => {
  const dir = tmp("frizz-symlink-")
  const a = join(dir, "buildA")
  const b = join(dir, "buildB")
  mkdirSync(a); mkdirSync(b)
  const link = join(dir, "current")

  ensureSymlink(link, a)
  assert.equal(ensureSymlink(link, b), "repointed")
  assert.equal(readlinkSync(link), b, "a live worker following this path now sees buildB")
})

// The link outlives what it pointed at whenever an old build is cleaned away. Repointing must still
// work: Node 25's rmSync follows the link, finds nothing, and `force` swallows that — leaving the
// dangling link in place, so recreating it failed EEXIST.
test("ensureSymlink repoints a DANGLING link whose old target is gone", () => {
  const dir = tmp("frizz-symlink-")
  const gone = join(dir, "buildGone")
  const b = join(dir, "buildB")
  mkdirSync(gone); mkdirSync(b)
  const link = join(dir, "current")

  ensureSymlink(link, gone)
  rmSync(gone, { recursive: true })
  assert.ok(lstatSync(link).isSymbolicLink() && !existsSync(link), "the fixture link dangles")
  assert.equal(ensureSymlink(link, b), "repointed")
  assert.equal(readlinkSync(link), b)
})

// A RELATIVE existing link resolves against the link's own directory, never the process cwd. Compare
// them naively and every call looks stale, so the link is deleted and recreated forever.
test("ensureSymlink resolves an existing RELATIVE link against its own directory", () => {
  const dir = tmp("frizz-symlink-")
  const target = join(dir, "target")
  mkdirSync(target)
  const link = join(dir, "current")
  symlinkSync("./target", link)
  // Read it BACK rather than pinning the literal: Windows stores a reparse point in its own
  // separator, so the link created from "./target" reads as ".\target" there. Comparing against
  // what the link actually holds is what "left exactly as it was" means on either platform.
  const before = readlinkSync(link)
  assert.ok(!isAbsolute(before), "the fixture link is relative — that is the whole case under test")

  assert.equal(ensureSymlink(link, target), "unchanged", "./target IS this target — do not churn it")
  assert.equal(readlinkSync(link), before, "and the existing relative link is left exactly as it was")
})

// Silently deleting a real directory someone else put at the stable path is data loss, not recovery.
test("ensureSymlink refuses to replace a real file or directory", () => {
  const dir = tmp("frizz-symlink-")
  const target = join(dir, "target")
  mkdirSync(target)

  const asDir = join(dir, "occupied-dir")
  mkdirSync(asDir)
  assert.throws(() => ensureSymlink(asDir, target), /not a symlink/)
  assert.ok(lstatSync(asDir).isDirectory(), "the directory it refused to replace is still there")

  const asFile = join(dir, "occupied-file")
  writeFileSync(asFile, "mine")
  assert.throws(() => ensureSymlink(asFile, target), /not a symlink/)
  assert.equal(readFileSync(asFile, "utf8"), "mine")
})

// ---- staging -------------------------------------------------------------------------------------

test("stageStablePluginDir copies the plugin under its version and publishes the stable path", () => {
  const dir = tmp("frizz-stage-")
  const source = plugin(join(dir, "src"), "v1")
  const home = join(dir, "home")

  const result = stageStablePluginDir({ source, version: "0.1.1", home })

  assert.equal(result.stagedPath, join(defaultPluginStageRoot(home), "0.1.1", "cc-worker"))
  assert.equal(result.stablePath, join(defaultStablePluginRoot(home), "cc-worker"))
  assert.equal(result.outcome, "created")
  // The stable path must serve the plugin's CONTENT, since that is what a worker loads through it.
  assert.match(readFileSync(join(result.stablePath, "hooks", "hooks.json"), "utf8"), /v1/)
  assert.ok(existsSync(join(result.stablePath, "hooks", "stop.mjs")), "the script hooks.json names came too")
})

// The whole point: a worker launched against the stable path can be moved onto a DIFFERENT immutable
// build without touching either build, which is what makes a live reloadPlugins() meaningful.
test("staging a second version repoints the stable path without disturbing the first", () => {
  const dir = tmp("frizz-stage-")
  const home = join(dir, "home")
  const first = stageStablePluginDir({ source: plugin(join(dir, "a"), "old"), version: "0.1.1", home })
  const second = stageStablePluginDir({ source: plugin(join(dir, "b"), "new"), version: "0.1.2", home })

  assert.equal(second.outcome, "repointed")
  assert.equal(first.stablePath, second.stablePath, "the path a worker holds never changes")
  assert.match(readFileSync(join(second.stablePath, "hooks", "hooks.json"), "utf8"), /new/)
  assert.match(readFileSync(join(first.stagedPath, "hooks", "hooks.json"), "utf8"), /old/,
    "the previous version stays staged — a worker still on it keeps working")
})

test("re-staging the same version is idempotent and leaves the link alone", () => {
  const dir = tmp("frizz-stage-")
  const home = join(dir, "home")
  const source = plugin(join(dir, "src"), "v1")

  const once = stageStablePluginDir({ source, version: "0.1.1", home })
  const twice = stageStablePluginDir({ source, version: "0.1.1", home })
  assert.equal(once.outcome, "created")
  assert.equal(twice.outcome, "unchanged", "a boot-time call must not churn a path live workers follow")
})

// Staging leaves no temp directory behind, so a crashed stage cannot masquerade as a staged version.
test("staging leaves no pending scratch behind", () => {
  const dir = tmp("frizz-stage-")
  const home = join(dir, "home")
  stageStablePluginDir({ source: plugin(join(dir, "src"), "v1"), version: "0.1.1", home })
  assert.deepEqual(readdirSync(defaultPluginStageRoot(home)).sort(), ["0.1.1"], "only the version directory survives")
})

// The version becomes a directory name under the user's home; it is never allowed to escape it.
test("stageStablePluginDir rejects a version that could escape the stage root", () => {
  const dir = tmp("frizz-stage-")
  const source = plugin(join(dir, "src"), "v1")
  const home = join(dir, "home")
  for (const bad of ["../escape", "a/b", "", ".hidden", "x".repeat(200)]) {
    assert.throws(() => stageStablePluginDir({ source, version: bad, home }), /unsafe plugin version/, `accepted ${JSON.stringify(bad)}`)
  }
})

// A repoint swaps the link by rename, so a hook a live worker runs through it never finds it missing.
// The swap itself cannot be observed from here; what can is that it leaves nothing beside the link.
test("repointing leaves no scratch link beside the stable path", () => {
  const dir = tmp("frizz-symlink-")
  const a = join(dir, "buildA")
  const b = join(dir, "buildB")
  mkdirSync(a); mkdirSync(b)
  const links = join(dir, "current")
  ensureSymlink(join(links, "cc-worker"), a)
  ensureSymlink(join(links, "cc-worker"), b)
  assert.deepEqual(readdirSync(links), ["cc-worker"])
})

// ---- identity: what a version is staged under, and what a running worker compares ----------------

test("pluginContentDigest is the content's identity: same bytes, same digest, wherever they sit", () => {
  const dir = tmp("frizz-digest-")
  const one = plugin(join(dir, "one"), "v1")
  const two = plugin(join(dir, "two"), "v1")
  assert.equal(pluginContentDigest(one), pluginContentDigest(two))
  assert.match(pluginContentDigest(one), /^[0-9a-f]{16}$/, "and it is safe to use as a staged version directory")

  writeFileSync(join(two, "hooks", "stop.mjs"), "// v2\n")
  assert.notEqual(pluginContentDigest(one), pluginContentDigest(two), "an edited script is a different plugin")

  const renamed = plugin(join(dir, "three"), "v1")
  renameSync(join(renamed, "hooks", "stop.mjs"), join(renamed, "hooks", "halt.mjs"))
  assert.notEqual(pluginContentDigest(one), pluginContentDigest(renamed), "and so is the same bytes under another name")
})

// The two ways a running worker's plugin moves, and the fingerprint has to see both.
test("pluginFingerprint moves when the stable path is repointed, even at identical content", () => {
  const dir = tmp("frizz-fingerprint-")
  const home = join(dir, "home")
  const first = stageStablePluginDir({ source: plugin(join(dir, "a"), "same"), version: "one", home })
  const before = pluginFingerprint(first.stablePath)
  assert.ok(before)
  assert.equal(pluginFingerprint(first.stablePath), before, "asking twice changes nothing")

  stageStablePluginDir({ source: plugin(join(dir, "b"), "same"), version: "two", home })
  assert.notEqual(pluginFingerprint(first.stablePath), before)
})

test("pluginFingerprint moves when a checkout's plugin is edited in place", () => {
  const dir = tmp("frizz-fingerprint-")
  const checkout = plugin(dir, "v1")
  const before = pluginFingerprint(checkout)
  writeFileSync(join(checkout, "hooks", "stop.mjs"), "// edited, and a different length\n")
  assert.notEqual(pluginFingerprint(checkout), before, "an edited file")
  const edited = pluginFingerprint(checkout)
  mkdirSync(join(checkout, "skills", "new"), { recursive: true })
  writeFileSync(join(checkout, "skills", "new", "SKILL.md"), "---\nname: new\n---\n")
  assert.notEqual(pluginFingerprint(checkout), edited, "an added file")
})

test("pluginFingerprint is undefined for a plugin that cannot be read", () => {
  assert.equal(pluginFingerprint(join(tmp("frizz-fingerprint-"), "gone")), undefined)
})
