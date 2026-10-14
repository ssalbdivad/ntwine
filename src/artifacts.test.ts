import assert from "node:assert/strict";
import { execFileSync, spawnSync, spawn as spawnChild } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { basename, dirname, join, resolve } from "node:path";
import { createServer } from "node:net";
import { test } from "node:test";
import {
  buildNtwineArtifact,
  captureNtwineSourceSnapshot,
  assertArtifactHostCompatible,
  currentArtifactHost,
  ensureStableNtwineArtifact,
  findReusableNtwineArtifact,
  promoteCurrentSourceArtifact,
  promoteNtwineArtifact,
  publishNtwineArtifactStaging,
  readNtwineArtifact,
  readStableArtifact,
  relevantSourceFingerprint,
} from "./artifacts.ts";
// The closure list is IMPORTED, never re-typed: three fixtures each carried their own hand-copy, which
// is precisely the drift worker-plugin-closure.ts warns about — they agreed only between the first edit
// and the last.
import { WORKER_PLUGIN_REQUIRED_FILES } from "./worker-plugin-closure.ts";
import {
  acquireProjectLaunchOwner,
  projectLaunchEnvironment,
} from "../packages/server/src/project-launch.ts";
import {
  DETACHED_DAEMON_ENTRIES,
  detachedDaemonOutputName,
} from "../packages/server/src/detached-daemons.ts";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

function fixtureDigest(manifest: Record<string, unknown>): string {
  const files = (value: unknown) => Object.fromEntries(Object.entries(value as Record<string, string>).sort(([a], [b]) => a.localeCompare(b)));
  return hash(JSON.stringify({
    source: (() => { try { return realpathSync(manifest.sourceDir as string); } catch { return resolve(manifest.sourceDir as string); } })(),
    sourceRevision: manifest.sourceRevision,
    sourceFingerprint: manifest.sourceFingerprint,
    nodeVersion: manifest.nodeVersion,
    host: manifest.host,
    webFiles: files(manifest.webFiles),
    runtimeFiles: files(manifest.runtimeFiles),
  }));
}

function legacyFixtureDigest(manifest: Record<string, unknown>): string {
  return hash(JSON.stringify({
    // `basename`, exactly as legacyArtifactDigest computes it — NOT `resolve().split("/")`, which
    // agrees on POSIX and then silently returns the WHOLE path on Windows, where `resolve` answers
    // in backslashes and the split finds no separator at all.
    source: manifest.sourceDir && basename(manifest.sourceDir as string),
    sourceRevision: manifest.sourceRevision,
    sourceFingerprint: manifest.sourceFingerprint,
    nodeVersion: manifest.nodeVersion,
    host: manifest.host,
    webFiles: manifest.webFiles,
    runtimeFiles: manifest.runtimeFiles,
  }));
}

/**
 * `omit` models an artifact built from source that NARROWED the worker-plugin closure: the file is
 * absent from the tree AND from the manifest, and the digest is computed over what remains, exactly as
 * a build from that source would produce. Nothing is tampered with — this artifact is internally
 * perfect and merely younger than the list THIS test process holds.
 */
function fixture(root: string, content: string, omit: readonly string[] = []): string {
  const digest = "0".repeat(64);
  const dir = join(root, digest);
  mkdirSync(join(dir, "web", "assets"), { recursive: true });
  mkdirSync(join(dir, "runtime", "src"), { recursive: true });
  mkdirSync(join(dir, "runtime", "cc-worker", ".claude-plugin"), { recursive: true });
  mkdirSync(join(dir, "runtime", "cc-worker", "hooks"), { recursive: true });
  mkdirSync(join(dir, "runtime", "cc-worker", "bin"), { recursive: true });
  mkdirSync(join(dir, "runtime", "board"), { recursive: true });
  mkdirSync(join(dir, "runtime", "prompts"), { recursive: true });
  writeFileSync(join(dir, "web", "index.html"), content);
  writeFileSync(join(dir, "web", "assets", "app.js"), "console.log('ok')");
  writeFileSync(
    join(dir, "runtime", "src", "index.js"),
    "console.log('runtime')"
  );
  writeFileSync(
    join(dir, "runtime", "cc-worker", ".claude-plugin", "plugin.json"),
    '{"name":"ntwine"}'
  );
  writeFileSync(join(dir, "runtime", "cc-worker", "hooks", "session-seed.mjs"), "seed");
  writeFileSync(join(dir, "runtime", "cc-worker", "hooks", "agent-bind.mjs"), "bind");
  mkdirSync(join(dir, "runtime", "cc-worker", "scripts", "ntwine"), { recursive: true });
  writeFileSync(join(dir, "runtime", "cc-worker", "bin", "ntwine"), "board");
  writeFileSync(join(dir, "runtime", "cc-worker", "bin", "ntwine-update"), "update");
  mkdirSync(join(dir, "runtime", "cc-worker", "lib"), { recursive: true });
  writeFileSync(join(dir, "runtime", "cc-worker", "bin", "ntwinectl"), "launcher");
  writeFileSync(join(dir, "runtime", "cc-worker", "bin", "ntwinectl.mjs"), "cli");
  writeFileSync(join(dir, "runtime", "cc-worker", "lib", "ntwine-tools.mjs"), "tools");
  writeFileSync(join(dir, "runtime", "board", "config.mjs"), "config");
  writeFileSync(join(dir, "runtime", "board", "agent-bindings.mjs"), "bindings");
  writeFileSync(join(dir, "runtime", "board", "index.mjs"), "index");
  writeFileSync(join(dir, "runtime", "board", "thread-update.mjs"), "update");
  const manifest = {
      version: 1,
      digest: "",
      createdAt: "2026-07-14T00:00:00.000Z",
      sourceDir: "/immutable/source",
      sourceRevision: "fixture",
      nodeVersion: process.version,
      host: currentArtifactHost(),
      webFiles: {
        "index.html": hash(content),
        "assets/app.js": hash("console.log('ok')"),
      },
      runtimeFiles: {
        "src/index.js": hash("console.log('runtime')"),
        "cc-worker/.claude-plugin/plugin.json": hash('{"name":"ntwine"}'),
        "cc-worker/hooks/session-seed.mjs": hash("seed"),
        "cc-worker/hooks/agent-bind.mjs": hash("bind"),
        "cc-worker/bin/ntwine": hash("board"),
        "cc-worker/bin/ntwine-update": hash("update"),
        "cc-worker/bin/ntwinectl": hash("launcher"),
        "cc-worker/bin/ntwinectl.mjs": hash("cli"),
        "cc-worker/lib/ntwine-tools.mjs": hash("tools"),
        "board/config.mjs": hash("config"),
        "board/agent-bindings.mjs": hash("bindings"),
        "board/index.mjs": hash("index"),
        "board/thread-update.mjs": hash("update"),
      },
    };
  for (const file of omit) {
    rmSync(join(dir, "runtime", file));
    delete (manifest.runtimeFiles as Record<string, string>)[file];
  }
  manifest.digest = fixtureDigest(manifest);
  const finalDir = join(root, manifest.digest);
  renameSync(dir, finalDir);
  writeFileSync(join(finalDir, "manifest.json"), JSON.stringify(manifest));
  return manifest.digest;
}

test("artifact host compatibility accepts the host that built it", () => {
  const host = currentArtifactHost();
  assert.doesNotThrow(() =>
    assertArtifactHostCompatible({ digest: "a".repeat(64), manifest: { host } } as any, host)
  );
});

test("artifact host compatibility fails closed for a pre-portability manifest", () => {
  assert.throws(
    () => assertArtifactHostCompatible({ digest: "a".repeat(64), manifest: {} } as any),
    /does not record host compatibility; stop Ntwine and rerun ntwine-dev/
  );
});

for (const field of ["platform", "arch", "nodeMajor", "nodeModules"] as const) {
  test(`artifact host compatibility rejects a ${field} mismatch before launch`, () => {
    const host = currentArtifactHost();
    const artifactHost = { ...host, [field]: `${host[field]}-other` };
    assert.throws(
      () => assertArtifactHostCompatible({ digest: "a".repeat(64), manifest: { host: artifactHost } } as any, host),
      /incompatible with this host.*stop Ntwine and rerun ntwine-dev/
    );
  });
}

function gitRevision(source: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: source,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function markReusableArtifact(
  root: string,
  digest: string,
  source: string
): string {
  const path = join(root, digest, "manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.sourceDir = source;
  manifest.sourceRevision = existsSync(join(source, ".git"))
    ? (() => {
        try {
          return gitRevision(source);
        } catch {
          return "unknown";
        }
      })()
    : "unknown";
  manifest.sourceFingerprint = relevantSourceFingerprint(source);
  manifest.digest = fixtureDigest(manifest);
  writeFileSync(path, JSON.stringify(manifest));
  if (manifest.digest !== digest) renameSync(join(root, digest), join(root, manifest.digest));
  return manifest.digest;
}

function rewriteFixtureManifest(
  root: string,
  digest: string,
  change: (manifest: any) => void
): string {
  const path = join(root, digest, "manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  change(manifest);
  manifest.digest = fixtureDigest(manifest);
  writeFileSync(path, JSON.stringify(manifest));
  if (manifest.digest !== digest) renameSync(join(root, digest), join(root, manifest.digest));
  return manifest.digest;
}

function sourceFixture(root: string): string {
  const source = join(root, "source");
  mkdirSync(join(source, "packages", "server", "src"), { recursive: true });
  mkdirSync(join(source, "packages", "web", "src"), { recursive: true });
  writeFileSync(
    join(source, "packages", "server", "src", "entry.ts"),
    "export const version = 1\n"
  );
  writeFileSync(join(source, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  execFileSync("git", ["init", "-q"], { cwd: source });
  execFileSync("git", ["add", "."], { cwd: source });
  execFileSync(
    "git",
    [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=test",
      "commit",
      "-qm",
      "initial",
    ],
    { cwd: source }
  );
  return source;
}

test("verified artifacts are selected atomically with a retained rollback digest", () => {
  const root = mkdtempSync(join(tmpdir(), "ntwine-artifacts-"));
  const state = join(root, "state");
  const first = fixture(root, "first");
  const second = fixture(root, "second");
  assert.equal(
    readNtwineArtifact(first, root).runtimeDir,
    join(root, first, "runtime")
  );
  assert.equal(promoteNtwineArtifact(state, first, root).current, first);
  const promoted = promoteNtwineArtifact(state, second, root);
  assert.equal(promoted.current, second);
  assert.equal(promoted.previous, first);
  assert.equal(readStableArtifact(state, root)?.digest, second);
  assert.equal(
    JSON.parse(readFileSync(join(state, "stable.json"), "utf8")).current,
    second
  );
});

test("artifact verification rejects modified web or runtime files before a stable pointer can select them", () => {
  const root = mkdtempSync(join(tmpdir(), "ntwine-artifacts-corrupt-"));
  const webDigest = fixture(root, "known-good");
  writeFileSync(join(root, webDigest, "web", "index.html"), "tampered");
  assert.throws(() => readNtwineArtifact(webDigest, root), /changed or missing/);
  assert.throws(
    () => promoteNtwineArtifact(join(root, "state"), webDigest, root),
    /changed or missing/
  );

  const runtimeDigest = fixture(root, "other-known-good");
  writeFileSync(
    join(root, runtimeDigest, "runtime", "src", "index.js"),
    "tampered"
  );
  assert.throws(
    () => readNtwineArtifact(runtimeDigest, root),
    /changed or missing/
  );
  assert.throws(
    () => promoteNtwineArtifact(join(root, "state"), runtimeDigest, root),
    /changed or missing/
  );
});

test("artifact verification rejects a worker closure omitted from the runtime manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "ntwine-artifacts-worker-manifest-"));
  const digest = fixture(root, "known-good");
  const manifestPath = join(root, digest, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  delete manifest.runtimeFiles["board/index.mjs"];
  writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => readNtwineArtifact(digest, root), /failed manifest validation/);
});

test("reuse skips a host-incompatible candidate and rebuilds it", () => {
  const root = mkdtempSync(join(tmpdir(), "ntwine-artifacts-host-reuse-"));
  const source = sourceFixture(root);
  let stale = fixture(root, "shared");
  stale = markReusableArtifact(root, stale, source);
  stale = rewriteFixtureManifest(root, stale, (manifest) => {
    manifest.host.arch = `${manifest.host.arch}-other`;
  });
  let builds = 0;
  const selected = ensureStableNtwineArtifact(join(root, "state"), source, root, {
    build: () => {
      builds++;
      let fresh = fixture(root, "fresh");
      fresh = markReusableArtifact(root, fresh, source);
      return readNtwineArtifact(fresh, root);
    },
  });
  assert.equal(builds, 1);
  assert.notEqual(selected.digest, stale);
});

test("canonical checkout identity prevents same-content artifact collisions", () => {
  const root = mkdtempSync(join(tmpdir(), "ntwine-artifacts-source-identity-"));
  const firstSource = sourceFixture(root);
  const secondSource = join(root, "second-source");
  cpSync(firstSource, secondSource, { recursive: true });
  let first = fixture(root, "shared");
  first = markReusableArtifact(root, first, firstSource);
  let second = fixture(root, "shared");
  second = markReusableArtifact(root, second, secondSource);
  assert.notEqual(first, second);
  assert.equal(findReusableNtwineArtifact(firstSource, root)?.digest, first);
  assert.equal(findReusableNtwineArtifact(secondSource, root)?.digest, second);
});

test("manifest paths and root identity are validated before an artifact is selected", () => {
  const root = mkdtempSync(join(tmpdir(), "ntwine-artifacts-manifest-schema-"));
  let traversal = fixture(root, "traversal");
  traversal = rewriteFixtureManifest(root, traversal, (manifest) => {
    manifest.webFiles["../outside"] = manifest.webFiles["index.html"];
  });
  assert.throws(() => readNtwineArtifact(traversal, root), /failed manifest validation/);

  const rootTamper = fixture(root, "root-tamper");
  const path = join(root, rootTamper, "manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.sourceRevision = "changed-without-changing-directory";
  writeFileSync(path, JSON.stringify(manifest));
  assert.throws(() => readNtwineArtifact(rootTamper, root), /failed root digest validation/);
});

test("an EEXIST publish race re-reads the verified winner", () => {
  const root = mkdtempSync(join(tmpdir(), "ntwine-artifacts-publish-race-"));
  const winner = fixture(root, "winner");
  const staging = join(root, ".staging-race");
  mkdirSync(staging);
  const selected = publishNtwineArtifactStaging(staging, winner, root);
  assert.equal(selected.digest, winner);
  assert.equal(existsSync(staging), false);
});

test("a first workspace launch reuses and promotes a verified canonical-source artifact", () => {
  const root = mkdtempSync(join(tmpdir(), "ntwine-artifacts-first-launch-"));
  const state = join(root, "project-state");
  const source = join(root, "source");
  mkdirSync(join(source, ".git"), { recursive: true });
  let digest = fixture(root, "shared");
  digest = markReusableArtifact(root, digest, source);

  let built = false;
  const progress: string[] = [];
  const selected = ensureStableNtwineArtifact(state, source, root, {
    onProgress: (message) => progress.push(message),
    build: () => {
      built = true;
      throw new Error("should reuse");
    },
  });
  assert.equal(selected.digest, digest);
  assert.equal(readStableArtifact(state, root)?.digest, digest);
  assert.equal(built, false);
  assert.deepEqual(progress, [
    "Checking current workspace artifact",
    "Checking verified artifact cache",
    "Reusing cached immutable artifact",
    "Promoting verified immutable artifact",
  ]);
  assert.equal(findReusableNtwineArtifact(source, root)?.digest, digest);
});

test("a same-HEAD tracked source edit does not reuse a stale artifact", () => {
  const root = mkdtempSync(join(tmpdir(), "ntwine-artifacts-dirty-tracked-"));
  const source = sourceFixture(root);
  let digest = fixture(root, "shared");
  digest = markReusableArtifact(root, digest, source);
  assert.equal(findReusableNtwineArtifact(source, root)?.digest, digest);
  writeFileSync(
    join(source, "packages", "server", "src", "entry.ts"),
    "export const version = 2\n"
  );
  assert.equal(findReusableNtwineArtifact(source, root), null);
});

test("a stopped workspace refreshes its stable pointer to the current source fingerprint", () => {
  const root = mkdtempSync(join(tmpdir(), "ntwine-artifacts-refresh-stopped-"));
  const state = join(root, "project-state");
  const source = sourceFixture(root);
  let stale = fixture(root, "stale");
  let current: string;
  stale = markReusableArtifact(root, stale, source);
  promoteNtwineArtifact(state, stale, root);

  writeFileSync(
    join(source, "packages", "server", "src", "entry.ts"),
    "export const version = 2\n"
  );
  current = fixture(root, "current");
  current = markReusableArtifact(root, current, source);

  let built = false;
  const selected = ensureStableNtwineArtifact(state, source, root, {
    build: () => {
      built = true;
      throw new Error("the current verified artifact should be reused");
    },
  });
  assert.equal(selected.digest, current);
  assert.equal(readStableArtifact(state, root)?.digest, current);
  assert.equal(built, false);
});

test("Update & Restart promotes even when the artifact it replaces no longer verifies", () => {
  const root = mkdtempSync(join(tmpdir(), "ntwine-artifacts-update-unverifiable-"));
  const state = join(root, "state");
  const source = sourceFixture(root);
  const stale = fixture(root, "stale");
  promoteNtwineArtifact(state, stale, root);

  // Exactly how a live instance goes stale: source tightened WORKER_PLUGIN_REQUIRED_FILES after this
  // artifact was built, so its manifest no longer lists a now-required board closure entry. The
  // digest field and every file stay put — only validation moved — and its child keeps serving.
  const manifestPath = join(root, stale, "manifest.json");
  const staleManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  delete staleManifest.runtimeFiles["board/index.mjs"];
  writeFileSync(manifestPath, JSON.stringify(staleManifest));
  assert.equal(readStableArtifact(state, root), null);

  const built = fixture(root, "candidate");
  const { candidate, previous } = promoteCurrentSourceArtifact(state, source, root, {
    build: () => readNtwineArtifact(built, root),
  });

  // No rollback target survives an unverifiable predecessor, but the update itself must land — it is
  // the only control that moves this instance onto an artifact the current source can verify.
  assert.equal(candidate.digest, built);
  assert.equal(previous, undefined);
  assert.equal(readStableArtifact(state, root)?.digest, built);
});

/**
 * THE DEADLOCK, from the other direction. artifacts.test.ts already pins what happens when source
 * WIDENS the closure — the artifact it replaces stops verifying and the update lands anyway. Narrowing
 * had no such escape, and on 2026-08-26 it cost the maintainer their update: `dafe4309` deleted
 * cc-worker/bin/browser-mcp.mjs together with the closure entry requiring it, correctly and in one
 * commit, and every instance built before that refused to update — "Ntwine worker plugin closure is
 * missing cc-worker/bin/browser-mcp.mjs", naming a file the new source is right not to have.
 *
 * The building process is ALWAYS the older one during Update & Restart, so its list can only ever be
 * a stale opinion about the checkout it is staging. Nothing on that path may be gated on it.
 */
test("an artifact built from source that NARROWED the closure still publishes and reads back", () => {
  const root = mkdtempSync(join(tmpdir(), "ntwine-artifacts-narrowed-closure-"));
  // The new source dropped this file and the entry that required it. THIS process has not caught up.
  const dropped = "cc-worker/hooks/agent-bind.mjs";
  assert.ok(WORKER_PLUGIN_REQUIRED_FILES.includes(dropped as (typeof WORKER_PLUGIN_REQUIRED_FILES)[number]));
  const digest = fixture(root, "narrowed", [dropped]);

  // The BOOT path is unchanged and still refuses it: there the launcher is choosing something to serve
  // from, and this build's list is a fact about the worker this build dispatches.
  assert.throws(() => readNtwineArtifact(digest, root), /failed manifest validation/);

  // The BUILD path reads the same artifact back without complaint. Its closure was already asserted by
  // the only list entitled to judge it — the snapshot's, through the source-owned script.
  const read = readNtwineArtifact(digest, root, { workerPluginClosure: false });
  assert.equal(read.digest, digest);
  assert.equal(existsSync(join(read.runtimeDir, dropped)), false);
});

test("publishing a narrowed-closure staging tree is not gated on the publisher's own list", () => {
  const root = mkdtempSync(join(tmpdir(), "ntwine-artifacts-narrowed-publish-"));
  const dropped = "board/thread-update.mjs";
  const digest = fixture(root, "narrowed-publish", [dropped]);
  // Back to a staging directory, so this is the real publish path buildNtwineArtifact ends on.
  const staging = join(root, ".staging-narrowed");
  renameSync(join(root, digest), staging);

  const published = publishNtwineArtifactStaging(staging, digest, root);
  assert.equal(published.digest, digest);
  assert.equal(existsSync(join(published.runtimeDir, dropped)), false);
  // …and the same artifact is still rejected by a boot-path read, which is what forces the rebuild.
  assert.throws(() => readNtwineArtifact(digest, root), /failed manifest validation/);
});

test("capturing a snapshot never judges the checkout's worker plugin by THIS build's list", () => {
  const root = mkdtempSync(join(tmpdir(), "ntwine-artifacts-narrowed-capture-"));
  const source = sourceFixture(root);
  mkdirSync(join(source, "node_modules"));
  // A checkout that narrowed the closure looks EXACTLY like this to a build that has not caught up:
  // every listed file present but one. Capture used to assert here and refuse the whole update.
  for (const file of WORKER_PLUGIN_REQUIRED_FILES.slice(1)) {
    mkdirSync(dirname(join(source, file)), { recursive: true });
    writeFileSync(join(source, file), "snapshot fixture\n");
  }
  const snapshot = captureNtwineSourceSnapshot(source, root);
  try {
    assert.equal(existsSync(join(snapshot.sourceDir, WORKER_PLUGIN_REQUIRED_FILES[0]!)), false);
    assert.ok(existsSync(join(snapshot.sourceDir, WORKER_PLUGIN_REQUIRED_FILES[1]!)));
  } finally {
    rmSync(snapshot.dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("Update & Restart hands back the verified artifact it replaced as the rollback target", () => {
  const root = mkdtempSync(join(tmpdir(), "ntwine-artifacts-update-rollback-"));
  const state = join(root, "state");
  const source = sourceFixture(root);
  const current = fixture(root, "current");
  promoteNtwineArtifact(state, current, root);

  const built = fixture(root, "candidate");
  const { candidate, previous } = promoteCurrentSourceArtifact(state, source, root, {
    build: () => readNtwineArtifact(built, root),
  });

  assert.equal(candidate.digest, built);
  assert.equal(previous?.digest, current);
  assert.equal(readStableArtifact(state, root)?.digest, built);
});

test("a relevant untracked source file does not reuse a stale artifact", () => {
  const root = mkdtempSync(join(tmpdir(), "ntwine-artifacts-dirty-untracked-"));
  const source = sourceFixture(root);
  let digest = fixture(root, "shared");
  digest = markReusableArtifact(root, digest, source);
  writeFileSync(
    join(source, "packages", "server", "src", "local-untracked.ts"),
    "export const local = true\n"
  );
  assert.equal(findReusableNtwineArtifact(source, root), null);
});

test("an unchanged dirty source reuses the same verified artifact", () => {
  const root = mkdtempSync(join(tmpdir(), "ntwine-artifacts-dirty-reuse-"));
  const source = sourceFixture(root);
  writeFileSync(
    join(source, "packages", "server", "src", "local-untracked.ts"),
    "export const local = true\n"
  );
  let digest = fixture(root, "shared");
  digest = markReusableArtifact(root, digest, source);
  assert.equal(findReusableNtwineArtifact(source, root)?.digest, digest);
});

test("generated outputs and artifact evidence do not invalidate a reusable dirty-source artifact", () => {
  const root = mkdtempSync(
    join(tmpdir(), "ntwine-artifacts-fingerprint-ignore-")
  );
  const source = sourceFixture(root);
  let digest = fixture(root, "shared");
  digest = markReusableArtifact(root, digest, source);
  const before = relevantSourceFingerprint(source);
  mkdirSync(join(source, "packages", "web", "dist"), { recursive: true });
  mkdirSync(join(source, "artifacts", "evidence"), { recursive: true });
  writeFileSync(
    join(source, "packages", "web", "dist", "generated.js"),
    "generated"
  );
  writeFileSync(
    join(source, "artifacts", "evidence", "report.json"),
    "generated"
  );
  assert.equal(relevantSourceFingerprint(source), before);
  assert.equal(findReusableNtwineArtifact(source, root)?.digest, digest);
});

test("a captured source snapshot remains usable after the checkout changes", () => {
  const root = mkdtempSync(join(tmpdir(), "ntwine-artifacts-snapshot-mutation-"));
  const source = sourceFixture(root);
  mkdirSync(join(source, "node_modules"));
  for (const file of WORKER_PLUGIN_REQUIRED_FILES) {
    // The worker-plugin closure lives INSIDE the source root: the workspace is the repo root now, so
    // cc-worker/ and cc/ are siblings of packages/ rather than a reach-back above the source.
    mkdirSync(dirname(join(source, file)), { recursive: true });
    writeFileSync(join(source, file), "snapshot fixture\n");
  }
  const snapshot = captureNtwineSourceSnapshot(source, root);
  try {
    const entry = join(source, "packages", "server", "src", "entry.ts");
    writeFileSync(entry, "export const version = 2\n");
    assert.equal(readFileSync(join(snapshot.sourceDir, "packages", "server", "src", "entry.ts"), "utf8"), "export const version = 1\n");
  } finally {
    rmSync(snapshot.dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

// The artifact root lives under `~/.ntwine`, which carries a `.gitignore` of `*` so the scratch tree
// stays out of any repo inited above it. Tailwind's scanner honours ancestor ignore files, so
// without a repository boundary of its own the snapshot's `.tsx` is invisible to it and the web
// build emits a stylesheet with zero utility classes — Vite exits 0 and the whole UI ships unstyled.
// Measured on Tailwind 4.3.2: 114,660 bytes of CSS at a neutral path, 28,849 under `~/.ntwine`.
test("a captured source snapshot is its own scan root, so an ancestor .gitignore cannot starve the web build", () => {
  const root = mkdtempSync(join(tmpdir(), "ntwine-artifacts-snapshot-scan-root-"));
  // Reproduce the real ancestry: the artifact root sits inside a tree that ignores everything.
  writeFileSync(join(root, ".gitignore"), "*\n");
  const source = sourceFixture(root);
  mkdirSync(join(source, "node_modules"));
  for (const file of WORKER_PLUGIN_REQUIRED_FILES) {
    mkdirSync(dirname(join(source, file)), { recursive: true });
    writeFileSync(join(source, file), "snapshot fixture\n");
  }
  const snapshot = captureNtwineSourceSnapshot(source, root);
  try {
    const marker = join(snapshot.sourceDir, ".git");
    assert.ok(existsSync(marker), "the snapshot must carry a .git marker to root the class scan");
    // Empty on purpose. A directory holding `.git` is a repository root to the scanner, but without
    // HEAD git's own discovery walks straight past it — so no build step can read a revision here.
    assert.deepEqual(readdirSync(marker), []);
    // .git is fingerprint-ignored, so the marker cannot fork the digest off the checkout's.
    assert.equal(relevantSourceFingerprint(snapshot.sourceDir), snapshot.sourceFingerprint);
  } finally {
    rmSync(snapshot.dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Two claims, and the first is the one that keeps an instance able to update itself.
 *
 * The worker-plugin closure is asserted by a SCRIPT RUN OUT OF THE SNAPSHOT, never by this build's
 * imported list — during Update & Restart the running build is older than the checkout it is staging,
 * so its own list is a stale opinion and can only produce a false failure. When source NARROWS the
 * closure that false failure is total: on 2026-08-26 every instance built before `dafe4309` refused
 * its own update, naming a file that commit had deliberately deleted. Both arguments are the
 * snapshot, never the caller's `sourceDir` — the list and the tree have to come from one place.
 *
 * Then the typecheck, before either slow build, so an intermediate edit with a missing import can
 * never become a valid immutable artifact and fail later as a browser global.
 */
test("artifact creation checks the snapshot's own worker-plugin closure, then typechecks it, before either build", () => {
  const root = mkdtempSync(join(tmpdir(), "ntwine-artifacts-typecheck-order-"));
  const source = resolve(import.meta.dirname, "..");
  const calls: Array<{ args: string[]; source: string }> = [];
  const failOn = (step: number) =>
    assert.throws(
      () =>
        buildNtwineArtifact(source, root, {
          runCommand: (args, snapshotSource) => {
            calls.push({ args, source: snapshotSource });
            if (calls.length >= step) throw new Error("build sentinel");
          },
        }),
      /build sentinel/
    );

  failOn(1);
  assert.deepEqual(calls.map((call) => call.args[0]), ["scripts/assert-worker-plugin-closure.mjs"]);
  // The tree it is handed is the snapshot too, not the mutable checkout the caller named.
  assert.equal(calls[0]!.args[1], calls[0]!.source);

  calls.length = 0;
  failOn(2);
  // The typecheck tries the checkout first and, when that fails, the snapshot itself (see the tests
  // below); the closure check only ever runs on the snapshot.
  assert.deepEqual(calls.map((call) => call.args), [
    ["scripts/assert-worker-plugin-closure.mjs", calls[0]!.source],
    ["run", "typecheck"],
    ["run", "typecheck"],
  ]);
  assert.match(calls[0]!.source, /\.source-snapshot-/);
  assert.equal(calls[1]!.source, realpathSync(source));
  assert.equal(calls[2]!.source, calls[0]!.source);
  assert.deepEqual(
    readdirSync(root).filter(
      (entry) =>
        entry.startsWith(".staging-") ||
        entry.startsWith(".source-snapshot-")
    ),
    []
  );
});

/**
 * The typecheck's cheap path. The snapshot's fresh path makes `tsc -b` there a cold check (555s of a
 * 623s build); the checkout holds the same bytes plus warm build info. Its result counts ONLY while
 * the checkout's fingerprint still equals the snapshot's — anything else falls back to the snapshot.
 */
function typecheckCalls(onCheckoutTypecheck: (checkout: string) => void): Array<{ args: string[]; source: string }> {
  const root = mkdtempSync(join(tmpdir(), "ntwine-artifacts-checkout-typecheck-"));
  const source = realpathSync(resolve(import.meta.dirname, ".."));
  const calls: Array<{ args: string[]; source: string }> = [];
  try {
    assert.throws(
      () =>
        buildNtwineArtifact(source, root, {
          runCommand: (args, cwd) => {
            calls.push({ args, source: cwd });
            if (args[0] === "run" && args[1] === "typecheck" && cwd === source) onCheckoutTypecheck(cwd);
            // Stop at the first step past the typecheck: the web build.
            if (args.includes("@ntwine/web")) throw new Error("build sentinel");
          },
        }),
      /build sentinel/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return calls.filter((call) => call.args[0] === "run" && call.args[1] === "typecheck");
}

test("a checkout typecheck over the snapshot's exact bytes stands in for the cold snapshot check", () => {
  const checks = typecheckCalls(() => {});
  assert.equal(checks.length, 1);
  assert.doesNotMatch(checks[0]!.source, /\.source-snapshot-/);
});

test("a failed checkout typecheck falls back to typechecking the snapshot itself", () => {
  const checks = typecheckCalls(() => {
    throw new Error("checkout typecheck failed");
  });
  assert.equal(checks.length, 2);
  assert.match(checks[1]!.source, /\.source-snapshot-/);
});

test("an edit to the checkout while its typecheck runs voids it", () => {
  let probe: string | undefined;
  try {
    const checks = typecheckCalls((checkout) => {
      // Untracked and uncommitted still counts: the fingerprint covers what the build would read.
      probe = join(checkout, "src", `.typecheck-race-probe-${process.pid}.ts`);
      writeFileSync(probe, "export const edited = true;\n");
    });
    assert.equal(checks.length, 2);
    assert.match(checks[1]!.source, /\.source-snapshot-/);
  } finally {
    if (probe) rmSync(probe, { force: true });
  }
});

async function availableLoopbackPort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const listener = createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      listener.close((error) =>
        error
          ? reject(error)
          : resolvePort(typeof address === "object" && address ? address.port : 0)
      );
    });
  });
}

// An absolute path is not an ESM specifier on Windows. `import "C:\\…"` is read as the scheme `c:`
// and the loader refuses it with ERR_UNSUPPORTED_ESM_URL_SCHEME; a `file://` URL is the only spelling
// that works there, and it works on POSIX too, so there is one form rather than a branch.
function moduleSpecifier(path: string): string {
  return pathToFileURL(path).href;
}

async function waitForArtifactHealth(
  port: number,
  child: ReturnType<typeof spawnChild>,
  projectId: string,
  output: () => string
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`bundled runtime exited before serving /health:\n${output()}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/_ntwine/health`);
      const health = (await response.json()) as {
        ok?: unknown;
        projectId?: unknown;
      };
      if (response.ok && health.ok === true && health.projectId === projectId)
        return;
    } catch {
      // The disposable child is still loading its control plane.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(
    `bundled runtime did not serve its WebSocket-capable control plane:\n${output()}`
  );
}

async function stopArtifactChild(
  child: ReturnType<typeof spawnChild>
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
    new Promise<void>((_, reject) =>
      setTimeout(
        () => reject(new Error("bundled runtime did not exit after SIGTERM")),
        15_000
      )
    ),
  ]);
}

test("a real Nub/esbuild artifact boots its WebSocket-capable server and loads its immutable native cell", async () => {
  const root = mkdtempSync(join(tmpdir(), "ntwine-artifacts-real-bundle-"));
  const source = resolve(import.meta.dirname, "..");
  let child: ReturnType<typeof spawnChild> | undefined;
  let releaseOwner: (() => boolean) | undefined;
  try {
    const artifact = buildNtwineArtifact(source, root);
    assert.match(
      // Under a throwaway HOME: a test never starts a launcher entry against the real install.
      execFileSync(process.execPath, [join(artifact.runtimeDir, "src", "index.js"), "--help"], { encoding: "utf8", env: { ...process.env, HOME: join(root, "home") } }),
      /Ntwine source launcher/
    );
    assert.ok(artifact.manifest.dependencyCell, "runtime binds an immutable dependency cell");
    const modules = join(artifact.runtimeDir, "node_modules");
    assert.equal(resolve(dirname(modules), readlinkSync(modules)), join(root, "cells", artifact.manifest.dependencyCell!, "node_modules"));
    // Detached entries are spawned as their OWN node process, so reachability through the bundle is
    // not enough — node must be able to LOAD each one from the artifact. Run with no config env, each
    // must reach ITS OWN guard and refuse; MODULE_NOT_FOUND means it was never emitted, which is
    // precisely what silently killed every Codex turn on 2026-07-23.
    //
    // The guards differ (the daemons want their NTWINE_* config, dev-bootstrap wants a live project
    // launch owner), so assert the SHAPE rather than one message: it must fail from inside the emitted
    // file itself. A wrong-but-plausible message would otherwise pass a laxer check.
    for (const entry of DETACHED_DAEMON_ENTRIES) {
      const name = detachedDaemonOutputName(entry);
      const emitted = join(artifact.runtimeDir, "src", name);
      assert.ok(existsSync(emitted), `artifact ships ${name} beside index.js`);
      const started = spawnSync(process.execPath, [emitted], { encoding: "utf8" });
      assert.doesNotMatch(started.stderr, /Cannot find module|ERR_MODULE_NOT_FOUND/, `${name} is loadable from the artifact`);
      assert.notEqual(started.status, 0, `${name} refuses to run without its configuration`);
      assert.match(started.stderr, new RegExp(`${name}:\\d+`), `${name} threw from inside itself, i.e. node really executed it`);
    }
    const projectId = randomUUID();
    const canonicalRoot = realpathSync(root);
    const target = {
      projectId,
      projectDir: canonicalRoot,
      stateDir: join(canonicalRoot, "server-state"),
    };
    const owner = acquireProjectLaunchOwner(target, "launcher");
    releaseOwner = owner.release;
    const port = await availableLoopbackPort();
    let output = "";
    child = spawnChild(process.execPath, [join(artifact.runtimeDir, "src", "index.js")], {
      cwd: root,
      env: projectLaunchEnvironment(
        {
          ...process.env,
          HOME: join(root, "home"),
          NTWINE_DEV_CHILD: "1",
          NTWINE_DEV_PORT: String(port),
          NTWINE_STABLE_ARTIFACT: artifact.digest,
          NTWINE_STABLE_WEB_DIST: artifact.webDir,
          NTWINE_SCRIPTS_DIR: join(artifact.runtimeDir, "board"),
          NTWINE_WORKER_PLUGIN_DIR: join(artifact.runtimeDir, "cc-worker"),
        },
        target,
        owner.token
      ),
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      output += chunk;
    });
    await waitForArtifactHealth(port, child, projectId, () => output);
    const nativeSmoke = `
      // SQLite comes from the RUNTIME now, not from a staged native cell: the database moved to
      // node:sqlite precisely so no prebuild has to be copied into the artifact and matched to the
      // host's Node-API version. It is still smoked here, because "the artifact can open a database"
      // is the property this test is for — only the thing that provides it changed.
      import { DatabaseSync } from "node:sqlite";
      import watcher from ${JSON.stringify(moduleSpecifier(join(artifact.runtimeDir, "node_modules", "@parcel", "watcher", "index.js")))};
      import { mkdtempSync, rmSync } from "node:fs";
      import { tmpdir } from "node:os";
      import { join } from "node:path";
      const db = new DatabaseSync(":memory:"); db.exec("create table t(x); insert into t values (1)"); if (db.prepare("select x from t").get().x !== 1) throw new Error("sqlite"); db.close();
      const dir = mkdtempSync(join(tmpdir(), "ntwine-watch-")); const sub = await watcher.subscribe(dir, () => {}); await sub.unsubscribe(); rmSync(dir, { recursive: true, force: true });
      // EXIT EXPLICITLY. On Windows node-pty used to leave live handles behind (4 of them, measured on
      // Windows Server 2022 / node 26.7.0), so the script never returned to the shell on its own and
      // wedged the suite; the pty is gone, and the explicit exit stays so no native handle can do that
      // again. The script's job is "the artifact can LOAD and USE these natives", not "node exits cleanly".
      process.exit(0);
    `;
    // Timed, because a hang here is not a hang worth waiting out: without this the run above stalled
    // the suite indefinitely instead of reporting a failure anyone could read.
    execFileSync(process.execPath, ["--input-type=module", "-e", nativeSmoke], { encoding: "utf8", timeout: 60_000 });
  } finally {
    if (child) await stopArtifactChild(child);
    releaseOwner?.();
    // The just-stopped server may still be flushing files under `root` when we remove it (a detached
    // helper, a late fs handle), so a bare rmSync throws ENOTEMPTY under load and fails a test whose
    // assertions already passed. maxRetries is node's native backoff for exactly EBUSY/ENOTEMPTY/EPERM.
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test.skip("legacy deploy snapshot harness is superseded by the real bundled-artifact smoke", () => {
  const root = mkdtempSync(join(tmpdir(), "ntwine-artifacts-source-snapshot-"));
  const source = join(root, "ui");
  const versionFile = join(source, "packages", "web", "src", "version.txt");
  const bin = join(root, "bin");
  mkdirSync(dirname(versionFile), { recursive: true });
  mkdirSync(join(source, "src"), { recursive: true });
  mkdirSync(join(source, "packages", "shared"), { recursive: true });
  mkdirSync(join(source, "node_modules"), { recursive: true });
  mkdirSync(join(source, "packages", "web", "node_modules", "@ntwine"), {
    recursive: true,
  });
  symlinkSync(
    "../../../shared",
    join(source, "packages", "web", "node_modules", "@ntwine", "shared")
  );
  writeFileSync(versionFile, "before\n");
  writeFileSync(join(source, "packages", "shared", "version.txt"), "snapshot workspace\n");
  for (const file of WORKER_PLUGIN_REQUIRED_FILES) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), `${file}\n`);
  }
  mkdirSync(bin);
  const pnpm = join(bin, "pnpm");
  writeFileSync(
    pnpm,
    `#!/bin/sh
if [ "$5" = "build" ]; then
  test -L "$2/packages/web/node_modules/@ntwine/shared" || exit 21
  test "$(cat "$2/packages/web/node_modules/@ntwine/shared/version.txt")" = "snapshot workspace" || exit 22
  version=$(cat "$2/packages/web/src/version.txt")
  if [ "$NTWINE_TEST_MUTATE_LIVE" = "1" ]; then
    printf 'after\\n' > "$NTWINE_TEST_LIVE_SOURCE/packages/web/src/version.txt"
    sleep 1
  fi
  mkdir -p "$2/packages/web/dist"
  printf '%s\\n' "$version" > "$2/packages/web/dist/index.html"
  exit 0
fi
mkdir -p "$6/src" "$6/node_modules/.pnpm/node_modules"
printf 'export const artifact = true\\n' > "$6/src/index.ts"
ln -s "$2/packages/cli" "$6/node_modules/.pnpm/node_modules/ntwine"
`
  );
  chmodSync(pnpm, 0o755);
  const oldPath = process.env.PATH;
  const oldMutate = process.env.NTWINE_TEST_MUTATE_LIVE;
  const oldLiveSource = process.env.NTWINE_TEST_LIVE_SOURCE;
  process.env.PATH = `${bin}:${oldPath ?? ""}`;
  process.env.NTWINE_TEST_MUTATE_LIVE = "1";
  process.env.NTWINE_TEST_LIVE_SOURCE = source;
  const beforeFingerprint = relevantSourceFingerprint(source);
  try {
    const first = buildNtwineArtifact(source, root);
    assert.equal(readFileSync(join(first.webDir, "index.html"), "utf8"), "before\n");
    assert.equal(readFileSync(versionFile, "utf8"), "after\n");
    assert.equal(first.manifest.sourceFingerprint, beforeFingerprint);
    const selfLink = join(first.runtimeDir, "node_modules", ".pnpm", "node_modules", "ntwine");
    assert.equal(
      resolve(dirname(selfLink), readlinkSync(selfLink)),
      first.runtimeDir,
      "the deploy self-link is sealed inside the immutable artifact"
    );
    process.env.NTWINE_TEST_MUTATE_LIVE = "0";
    const second = buildNtwineArtifact(source, root);
    assert.notEqual(second.digest, first.digest);
    assert.equal(readFileSync(join(second.webDir, "index.html"), "utf8"), "after\n");
    assert.equal(second.manifest.sourceFingerprint, relevantSourceFingerprint(source));
    assert.deepEqual(
      readdirSync(root).filter((entry) => entry.startsWith(".source-snapshot-")),
      []
    );
  } finally {
    process.env.PATH = oldPath;
    if (oldMutate === undefined) delete process.env.NTWINE_TEST_MUTATE_LIVE;
    else process.env.NTWINE_TEST_MUTATE_LIVE = oldMutate;
    if (oldLiveSource === undefined) delete process.env.NTWINE_TEST_LIVE_SOURCE;
    else process.env.NTWINE_TEST_LIVE_SOURCE = oldLiveSource;
  }
});

test("an older verified manifest without a source fingerprint fails closed for new workspace reuse", () => {
  const root = mkdtempSync(join(tmpdir(), "ntwine-artifacts-old-manifest-"));
  const source = sourceFixture(root);
  const digest = fixture(root, "shared");
  const path = join(root, digest, "manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  const legacy = legacyFixtureDigest(manifest);
  manifest.digest = legacy;
  writeFileSync(path, JSON.stringify(manifest));
  renameSync(join(root, digest), join(root, legacy));
  assert.equal(readNtwineArtifact(legacy, root).digest, legacy);
  assert.equal(findReusableNtwineArtifact(source, root), null);
});

test("a zero-artifact first launch builds then promotes only a complete verified candidate", () => {
  const root = mkdtempSync(join(tmpdir(), "ntwine-artifacts-zero-launch-"));
  const state = join(root, "project-state");
  const source = join(root, "source");
  mkdirSync(source);
  let digest = "";
  let builds = 0;
  const progress: string[] = [];
  const selected = ensureStableNtwineArtifact(state, source, root, {
    onProgress: (message) => progress.push(message),
    build: () => {
      builds++;
      digest = fixture(root, "built");
      return readNtwineArtifact(digest, root);
    },
  });
  assert.equal(builds, 1);
  assert.deepEqual(progress, [
    "Checking current workspace artifact",
    "Checking verified artifact cache",
    "No matching artifact found; building immutable artifact",
    "Promoting verified immutable artifact",
  ]);
  assert.equal(selected.digest, digest);
  assert.equal(readStableArtifact(state, root)?.digest, digest);
});

test("a stale source pointer reports an actual immutable rebuild before promotion", () => {
  const root = mkdtempSync(join(tmpdir(), "ntwine-artifacts-stale-progress-"));
  const state = join(root, "project-state");
  const source = sourceFixture(root);
  let stale = fixture(root, "stale");
  let rebuilt = "";
  stale = markReusableArtifact(root, stale, source);
  promoteNtwineArtifact(state, stale, root);
  writeFileSync(join(source, "packages", "server", "src", "entry.ts"), "export const version = 2\n");
  const progress: string[] = [];
  const selected = ensureStableNtwineArtifact(state, source, root, {
    onProgress: (message) => progress.push(message),
    build: () => {
      rebuilt = fixture(root, "rebuilt");
      rebuilt = markReusableArtifact(root, rebuilt, source);
      return readNtwineArtifact(rebuilt, root);
    },
  });
  assert.equal(selected.digest, rebuilt);
  assert.deepEqual(progress, [
    "Checking current workspace artifact",
    "Checking verified artifact cache",
    "No matching artifact found; building immutable artifact",
    "Promoting verified immutable artifact",
  ]);
});

test("a failed first-launch build never writes a partial candidate to workspace selection", () => {
  const root = mkdtempSync(join(tmpdir(), "ntwine-artifacts-build-rollback-"));
  const state = join(root, "project-state");
  const source = join(root, "source");
  mkdirSync(source);
  assert.throws(
    () =>
      ensureStableNtwineArtifact(state, source, root, {
        build: () => {
          throw new Error("build failed");
        },
      }),
    /build failed/
  );
  assert.equal(readStableArtifact(state, root), null);
  assert.equal(existsSync(join(state, "stable.json")), false);
});

test.skip("legacy deploy cleanup harness is superseded by the bundled-artifact smoke", () => {
  const root = mkdtempSync(join(tmpdir(), "ntwine-artifacts-build-cleanup-"));
  const source = join(root, "source");
  const plugin = join(root, "cc-worker");
  const bin = join(root, "bin");
  mkdirSync(source);
  mkdirSync(join(source, "node_modules"));
  mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
  writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), "{}\n");
  for (const file of [
    "hooks/session-seed.mjs",
    "hooks/agent-bind.mjs",
    "bin/ntwine",
    "bin/ntwine-update",
  ]) {
    mkdirSync(dirname(join(plugin, file)), { recursive: true });
    writeFileSync(join(plugin, file), "export {}\n");
  }
  for (const file of ["config.mjs", "agent-bindings.mjs", "index.mjs", "thread-update.mjs"]) {
    mkdirSync(join(root, "board"), { recursive: true });
    writeFileSync(join(root, "board", file), "export {}\n");
  }
  mkdirSync(bin);
  const pnpm = join(bin, "pnpm");
  writeFileSync(
    pnpm,
    `#!/bin/sh
if [ "$5" = "build" ]; then
  mkdir -p "$2/packages/web/dist"
  printf '<!doctype html>' > "$2/packages/web/dist/index.html"
  exit 0
fi
mkdir -p "$6/runtime"
exit 12
`
  );
  chmodSync(pnpm, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath ?? ""}`;
  try {
    assert.throws(() => buildNtwineArtifact(source, root), /Command failed/);
  } finally {
    process.env.PATH = oldPath;
  }
  assert.deepEqual(
    readdirSync(root).filter(
      (entry) =>
        entry.startsWith(".staging-") ||
        entry.startsWith(".source-snapshot-")
    ),
    []
  );
});

test.skip("legacy deploy worker harness is superseded by the bundled-artifact smoke", () => {
  const root = mkdtempSync(join(tmpdir(), "ntwine-artifacts-worker-plugin-"));
  const source = join(root, "ui");
  const plugin = join(root, "cc-worker");
  const bin = join(root, "bin");
  mkdirSync(join(source, "packages", "web", "src"), { recursive: true });
  mkdirSync(join(source, "node_modules"));
  mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
  mkdirSync(join(plugin, "skills", "worker"), { recursive: true });
  mkdirSync(join(plugin, "skills", "gh", "scripts"), { recursive: true });
  mkdirSync(join(plugin, "hooks"), { recursive: true });
  mkdirSync(join(plugin, "bin"), { recursive: true });
  mkdirSync(join(plugin, "scripts", "ntwine"), { recursive: true });
  mkdirSync(join(root, "board"), { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), '{"name":"ntwine"}\n');
  writeFileSync(join(plugin, "skills", "worker", "SKILL.md"), "worker\n");
  writeFileSync(join(plugin, "skills", "gh", "SKILL.md"), "gh\n");
  writeFileSync(join(plugin, "skills", "gh", "scripts", "ci-watch.mjs"), "watch\n");
  writeFileSync(
    join(plugin, "hooks", "session-seed.mjs"),
    `import { readFileSync } from "node:fs";
import { currentSessionId, setSessionOverride } from "../scripts/ntwine/config.mjs";
const input = JSON.parse(readFileSync(0, "utf8"));
const sessionId = currentSessionId(input.session_id);
setSessionOverride(process.env.CLAUDE_PROJECT_DIR, sessionId, "off");
process.stdout.write(JSON.stringify({ scratch: ".ntwine/threads/" + sessionId + "/scratch.md" }));
`
  );
  writeFileSync(join(plugin, "hooks", "agent-bind.mjs"), "bind\n");
  writeFileSync(join(plugin, "scripts", "ntwine", "config.mjs"), `export * from "../../../board/config.mjs";\n`);
  writeFileSync(join(plugin, "scripts", "ntwine", "agent-bindings.mjs"), `export * from "../../../board/agent-bindings.mjs";\n`);
  writeFileSync(join(plugin, "bin", "ntwine"), `await import(new URL("../../board/index.mjs", import.meta.url));\n`);
  writeFileSync(join(plugin, "bin", "ntwine-update"), `await import(new URL("../../board/thread-update.mjs", import.meta.url));\n`);
  writeFileSync(
    join(root, "board", "config.mjs"),
    `import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export const currentSessionId = (explicit) => explicit || process.env.CLAUDE_CODE_SESSION_ID || null;
export const setSessionOverride = (project, sessionId, state) => {
  const dir = join(project, ".ntwine", ".session-state");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, sessionId), state + "\\n");
};
`
  );
  writeFileSync(join(root, "board", "agent-bindings.mjs"), "export const recordBinding = () => true; export const threadFromPrompt = () => null;\n");
  writeFileSync(join(root, "board", "index.mjs"), "process.stdout.write(\"portable-board\\n\");\n");
  writeFileSync(join(root, "board", "thread-update.mjs"), "process.stdout.write(\"portable-update\\n\");\n");
  const pnpm = join(bin, "pnpm");
  writeFileSync(
    pnpm,
    `#!/bin/sh
if [ "$5" = "build" ]; then
  mkdir -p "$2/packages/web/dist"
  printf '<!doctype html>' > "$2/packages/web/dist/index.html"
  exit 0
fi
mkdir -p "$6/src" "$6/node_modules/@ntwine/server/src"
printf 'export const artifact = true\\n' > "$6/src/index.ts"
printf 'export const dispatch = true\\n' > "$6/node_modules/@ntwine/server/src/dispatch.ts"
`
  );
  chmodSync(pnpm, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath ?? ""}`;
  try {
    const artifact = buildNtwineArtifact(source, root);
    const bundled = join(artifact.runtimeDir, "cc-worker");
    assert.equal(existsSync(join(bundled, ".claude-plugin", "plugin.json")), true);
    assert.equal(existsSync(join(bundled, "skills", "worker", "SKILL.md")), true);
    assert.equal(existsSync(join(bundled, "skills", "gh", "scripts", "ci-watch.mjs")), true);
    assert.equal(existsSync(join(bundled, "hooks", "session-seed.mjs")), true);
    assert.equal(existsSync(join(artifact.runtimeDir, "board", "config.mjs")), true);
    assert.equal(
      resolve(dirname(join(artifact.runtimeDir, "node_modules", "@ntwine", "server", "src", "dispatch.js")), "../../../../cc-worker"),
      bundled,
      "the deployed workerPluginDir() resolver reaches the bundled plugin"
    );
    assert.equal(
      artifact.manifest.runtimeFiles["cc-worker/.claude-plugin/plugin.json"] !== undefined,
      true,
      "plugin files are manifest-verified runtime inputs"
    );
    assert.equal(
      artifact.manifest.runtimeFiles["board/index.mjs"] !== undefined,
      true,
      "the board script closure is manifest-verified alongside the worker plugin"
    );
    const cleanHome = join(root, "clean-home")
    const project = join(root, "project")
    mkdirSync(join(project, ".ntwine", "threads", "portable-session"), { recursive: true })
    writeFileSync(join(project, ".ntwine", "threads", "portable-session", "scratch.md"), "# scratch\n")
    // Erase the checkout closure before invoking the copied artifact. The hook and both executable
    // shims must resolve only runtime/{cc-worker,board}, with no global Ntwine config/plugin to help.
    rmSync(source, { recursive: true, force: true })
    rmSync(plugin, { recursive: true, force: true })
    rmSync(join(root, "board"), { recursive: true, force: true })
    const cleanEnv = {
      PATH: process.env.PATH ?? "",
      HOME: cleanHome,
      NTWINE_THREAD: "portable-thread",
      CLAUDE_PROJECT_DIR: project,
      CLAUDE_CODE_SESSION_ID: "portable-session",
      CLAUDE_CODE_SUBAGENT_MODEL: "foreign-model",
      CLAUDE_CODE_EFFORT_LEVEL: "low",
    }
    const hook = execFileSync(process.execPath, [join(bundled, "hooks", "session-seed.mjs")], {
      cwd: project,
      env: cleanEnv,
      input: JSON.stringify({ session_id: "portable-session" }),
      encoding: "utf8",
    })
    assert.deepEqual(JSON.parse(hook), { scratch: ".ntwine/threads/portable-session/scratch.md" })
    assert.equal(readFileSync(join(project, ".ntwine", ".session-state", "portable-session"), "utf8"), "off\n")
    assert.equal(execFileSync(process.execPath, [join(bundled, "bin", "ntwine")], { cwd: project, env: cleanEnv, encoding: "utf8" }), "portable-board\n")
    assert.equal(execFileSync(process.execPath, [join(bundled, "bin", "ntwine-update")], { cwd: project, env: cleanEnv, encoding: "utf8" }), "portable-update\n")
  } finally {
    process.env.PATH = oldPath;
  }
});
