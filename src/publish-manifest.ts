/**
 * Manifest surgery for `npm publish`.
 *
 * `ntwine` is published straight out of a pnpm workspace, so its build-time dependencies on the
 * sibling packages are declared with pnpm's `workspace:` protocol. pnpm rewrites those to real
 * versions when IT publishes; npm does not — it is not an npm workspace, so `npm publish` would ship
 * `"@ntwine/server": "workspace:*"` verbatim to the registry, a specifier no registry consumer can
 * ever resolve. The sibling packages are private and intentionally unpublished, and nothing in the
 * shipped bundle needs them at run time (esbuild absorbs them), so the published manifest simply
 * drops them.
 *
 * Only `workspace:` specifiers are removed — a real registry devDependency like esbuild stays, so the
 * published manifest keeps describing how the package is built.
 */

export interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  [key: string]: unknown;
}

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

export interface StripResult {
  manifest: Manifest;
  /** `field/name` for every specifier removed, in manifest order — what the caller reports. */
  stripped: string[];
}

/**
 * Return a copy of `manifest` with every `workspace:`-protocol specifier removed. A dependency field
 * left empty is deleted outright rather than published as `{}`. Pure: the input is never mutated.
 */
export function stripWorkspaceDependencies(manifest: Manifest): StripResult {
  const next: Manifest = { ...manifest };
  const stripped: string[] = [];
  for (const field of DEPENDENCY_FIELDS) {
    const specs = manifest[field];
    if (!specs) continue;
    const kept: Record<string, string> = {};
    let removed = 0;
    for (const [name, spec] of Object.entries(specs)) {
      if (typeof spec === "string" && spec.startsWith("workspace:")) {
        stripped.push(`${field}/${name}`);
        removed += 1;
      } else kept[name] = spec;
    }
    if (removed === 0) continue;
    if (Object.keys(kept).length === 0) delete next[field];
    else next[field] = kept;
  }
  return { manifest: next, stripped };
}
