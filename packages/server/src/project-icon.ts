import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, extname, join, relative, sep } from "node:path"
import { imageDimensions, MEASURABLE_IMAGE_EXTENSIONS, svgDeclaresColour, type ImageDimensions } from "./image-header.ts"
import { projectStateDir } from "./frizz-paths.ts"
import { readRegistry, resolveProjectIcon } from "./project-registry.ts"

// FINDING A PROJECT'S OWN ICON, in the project.
//
// The rail draws one square per project, and a machine with forty of them is unreadable as forty
// identical monograms. Almost every project already ships the picture it wants to be known by — a
// favicon, an apple-touch-icon, a logo in `public/` — so the icon is nearly always THERE, sitting in
// a handful of conventional places, and the only reason it isn't on screen is that nobody looked.
//
// NOTHING ON NPM DOES THIS. Searched 2026-08-06: every "favicon" package is one of two other things —
// a fetcher that takes a URL and hits the live site (`favicon-fetch`, `get-website-favicon`,
// `parse-favicon`) or a generator that takes one source image and produces an icon set (`favicons`).
// Neither knows a thing about where a checkout keeps its logo, which is the entire question here.
//
// TWO PROPERTIES SHAPE THE WHOLE FILE, and both come from the scale:
//
//   · It must be CHEAP. Forty projects × a recursive walk is not a thing to do while someone waits,
//     so this never recurses. It reads a fixed table of directories one level deep (plus one level of
//     monorepo expansion) and stops after a bounded number of files. A repo with 200k files under
//     `node_modules` costs exactly as much as an empty one.
//   · It must PREFER THE BIG SQUARE ONE. `favicon.ico` is usually 16px and looks like mud at 32; the
//     512px `apple-touch-icon.png` sitting beside it is the icon a person would have picked. So the
//     favicon is a WAYFINDER rather than the answer — finding one marks its directory as this
//     project's icon home and lifts everything in it, which is how the larger sibling wins.
//
// The output is a path. Serving it, caching it, and letting the operator override it belong to
// project-registry.ts and the `/_frizz/project-icon` route.

/** Bounded work: a pathological tree must not turn a rail render into a filesystem crawl. */
const MAX_CANDIDATES = 400

/**
 * Directories that may CONTAIN a web app, and therefore its icons.
 *
 * The gap this closes was real and common: a tool's marketing or docs site lives in a subdirectory
 * with its OWN `public/`, so the icons sit at `site/public/icon.svg`. The old table listed `site` and
 * `public` separately but never their combination, so a repo whose only icons were in `site/public/`
 * scanned clean — measured on nub, which has a complete icon set there (2026-08-06).
 *
 * Crossed with ASSET_DIRECTORIES below rather than hand-listing every pair, because hand-listing is
 * exactly how `site/public` came to be missing while `docs/public` was present.
 */
const HOST_DIRECTORIES = [
  "site", "sites", "website", "web", "www", "docs", "doc", "documentation",
  "frontend", "client", "ui", "app", "src", "landing", "marketing", "homepage",
  "extension", "electron", "desktop", "mobile", "www-root", "public-site",
]

/**
 * A project's BRAND KIT: the directory it keeps its logo in, cut every way it needs it.
 *
 * Only a bare `brand/` was searched until 2026-10-11, and the miss was Pullfrog. Its `public/logos/`
 * holds the frog as a 600px square, a circle, a bordered square and a wordmark, each in two
 * colourways, and none of it was looked at — so the rail wore `app/apple-icon.png`, a 180px disc,
 * which draws as a circle inside a square tile.
 *
 * Named apart from the other asset directories because the name is EVIDENCE, not just a place: see
 * `squareCut` in the scoring.
 */
const BRAND_KIT_DIRECTORIES = ["logos", "logo", "brand", "branding"]

/**
 * Where icons sit INSIDE a host, including the one nested level real toolchains use.
 *
 * `static/img` is Docusaurus, `public/icons` is most PWA generators — nesting one level is what
 * catches those without walking the tree.
 */
const ASSET_DIRECTORIES = [
  "",
  "public", "static", "assets", "resources", "images", "img", "icons", "media", "design",
  "public/images", "public/img", "public/icons", "public/assets", "public/static",
  "static/img", "static/images", "static/icons",
  "assets/images", "assets/img", "assets/icons",
  "resources/icons", "src/app", "src/assets",
  ...["", "public/", "static/", "assets/"].flatMap((parent) => BRAND_KIT_DIRECTORIES.map((kit) => parent + kit)),
]

/** Places that are not "a host with assets" and so cannot come out of the cross product. */
const EXTRA_DIRECTORIES = [".github", "build", "build/icons", "extension/icons"]

/** Monorepo containers. One level of children each, then the usual asset dirs inside them. */
const WORKSPACE_CONTAINERS = ["apps", "packages", "sites", "services", "libs", "workspaces"]

/** Web app manifests, whose `icons[]` is a project stating its icons outright. */
const MANIFEST_NAMES = ["manifest.json", "site.webmanifest", "manifest.webmanifest", "manifest.json5"]

/**
 * Name → how much it looks like an app icon.
 *
 * `favicon` scores LOW on purpose. It is the most reliable signal that a directory holds icons and
 * the least reliable icon itself — the 16px one browsers ask for — so it earns its keep through the
 * directory bonus below, not by winning outright.
 */
const NAME_SCORES: [RegExp, number, string][] = [
  // `icon-square` reaches here as `icon` (the shape is stripped and scored on its own); only the
  // unseparated `iconsquare` still needs naming.
  [/^logomark$|^logo-?mark$|^app-?icon$|^iconsquare$/u, 20, "an app icon"],
  [/^logo$|^icon$|^mark$|^brand$|^symbol$/u, 18, "the project logo"],
  [/^apple-?touch-?icon$|^apple-?icon$|^maskable(-?icon)?$/u, 16, "the touch icon"],
  [/^android-?chrome$|^mstile$|^ms-?icon$|^web-?app-?icon$|^pwa-?icon$/u, 14, "the web app icon"],
  // Qualified rather than bare, and the qualifier is usually somebody ELSE's name: a personal site's
  // `public/` holds `trpc-logo.svg` and `zod-logo.svg` next to its own `icon.png`, and scoring these
  // level with a bare `logo` handed that site a logo it does not own. Low enough that any unqualified
  // icon in the same directory beats it.
  [/^logo-|^icon-|-logo$|-icon$/u, 6, "a logo file"],
  [/^favicon$/u, 6, "the favicon"],
]

/**
 * How far a colourless SVG falls.
 *
 * Enough that ANY coloured sibling beats it outright, and not so far that a project whose only icon is
 * a glyph loses it altogether — a dark silhouette on the tile still identifies a project, where the
 * monogram fallback would not. bun is the measured case: `site/public/icon.svg` (a Simple Icons glyph
 * with no fill, so solid black through an `<img>`) and `logo.svg` (six brand colours) both scored 76,
 * and the tie went alphabetically to the black one.
 */
const COLOURLESS_SVG_PENALTY = 26

/** Build output. The same icon is in the source tree, and that copy is the one that survives a clean. */
const GENERATED_DIRECTORIES = new Set(["build", "dist", "out", ".next", ".output", "coverage", "target"])

/**
 * Names that are images a project ships but never its icon.
 *
 * A social card is the trap worth naming: `og-image.png` is 1200×630, lives in `public/` beside the
 * favicon, and is the largest image in most repos — so without this it would beat the real icon on
 * size alone in a very large number of projects. The aspect gate catches most of them; this catches
 * the square ones and saves measuring the rest.
 */
const NEVER_AN_ICON = /^(og|twitter|social|banner|hero|cover|preview|screenshot|sprite|placeholder|avatar-default|background|bg)([-_.]|$)/u

/** A wordmark is not a square. Anything outside this band is a banner, not an icon. */
const MIN_ASPECT = 0.8
const MAX_ASPECT = 1.25
/** Below this the image cannot survive being drawn at 32px, whatever else it has going for it. */
const MIN_EDGE = 24

export interface ProjectIconCandidate {
  /** Absolute path to the image. */
  path: string
  score: number
  dimensions: ImageDimensions
  /** Plain-language account of why this one, shown to the operator so the scan is not a black box. */
  reason: string
}

/** Theme and weight suffixes. Stripping them is what lets `mark-light` be recognised as a mark. */
const VARIANT_SUFFIX = /[-_](light|dark|white|black|inverse|inverted|mono|color|colour|full|solid|outline|small|large|sm|lg|md)$/u

/** The one SHAPE a filename states that matters here: the rail's tile is a square. */
const SQUARE_SUFFIX = /[-_]square$/u

/**
 * The comparable form of a filename stem, whether it was a VARIANT of one, and whether it says it is
 * the SQUARE cut.
 *
 * Three kinds of suffix get stripped, for the same reason — they describe a rendition, not a
 * different picture. Sizes (`icon-192x192`, `logo@2x`, `mstile-150`) are how every icon toolchain
 * writes its output, themes (`mark-light`) are how a project ships one mark twice, and `-square` is
 * how a brand kit tells its square cut from its circle and its wordmark. Without stripping them none
 * of those names matches anything and a project's entire icon set scores zero.
 *
 * The variant flag exists because stripping alone would then TIE `mark-light.svg` with `mark.svg`,
 * and alphabetical order handed the rail the light-background mark — the wrong one against dark
 * chrome. Where a project ships both, the unqualified file is the one it means.
 *
 * A theme can sit on either side of the shape (`logo-square-dark`, `frog-white-square`), so it is
 * looked for again once the shape comes off — and only then, so a name with no shape in it normalises
 * exactly as it always did. That second look is what ranks Pullfrog's `frog-green-square` above its
 * `frog-white-square`: `white` is a rendition, the brand colour is not.
 */
function normalizeStem(stem: string): { normalized: string; variant: boolean; square: boolean } {
  const sized = stem
    .toLowerCase()
    .replace(/[@-]\d+(\.\d+)?x(\d+)?$/u, "")
    .replace(/[-_]\d{2,4}$/u, "")
  const themed = sized.replace(VARIANT_SUFFIX, "")
  const unshaped = themed.replace(SQUARE_SUFFIX, "")
  const square = unshaped !== themed
  const normalized = square && themed === sized ? unshaped.replace(VARIANT_SUFFIX, "") : unshaped
  return { normalized, variant: themed !== sized || normalized !== unshaped, square }
}

function nameScore(normalized: string): { score: number; reason: string } | undefined {
  for (const [pattern, score, reason] of NAME_SCORES) {
    if (pattern.test(normalized)) return { score, reason }
  }
  return undefined
}

/**
 * Size, on a log scale, saturating at 512.
 *
 * Linear would make a 1024px PNG twice the icon a 512px one is, which is not how any of this reads on
 * a 32px square — past a couple of hundred pixels the extra resolution is invisible and what matters
 * is that it is not the 16px favicon. Doubling from 24px is worth 8 points each time until it stops
 * mattering: 24→0, 48→8, 96→16, 192→24, 384→32, 512+→40.
 */
function sizeScore(dimensions: ImageDimensions): number {
  // A scalable mark is worth the top of the scale at any nominal box: it is sharp at every size the
  // rail could ever draw it, which is the property the whole scale is a proxy for.
  if (dimensions.scalable) return 40
  const edge = Math.max(dimensions.width, dimensions.height)
  return Math.max(0, Math.min(40, Math.round((Math.log2(edge / 24)) * 8)))
}

const FORMAT_SCORES: Record<string, number> = {
  ".svg": 12, // scales, and is what a designer handed the project
  ".png": 10, // transparency, universally decodable
  ".webp": 8,
  ".ico": 4, // a container of small images, and the only one browsers demand
  ".gif": 2,
  ".jpg": 1, // no transparency: a square photo on the rail's background
  ".jpeg": 1,
}

/** `~/code/nub` + `public` → `~/code/nub/public`, with `""` meaning the root itself. */
function under(root: string, relativeDirectory: string): string {
  return relativeDirectory ? join(root, relativeDirectory) : root
}

function listFiles(directory: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() || entry.isSymbolicLink())
      .map((entry) => entry.name)
  } catch {
    return [] // absent, unreadable, or not a directory — all mean "no icons here"
  }
}

/**
 * The directories to look in: the repo root and every host that actually exists, each crossed with
 * the asset directories, plus one level inside each monorepo container.
 *
 * PRUNED BEFORE CROSSING. The root is read once and only hosts that are really there are expanded,
 * so the cross product costs a handful of stats on a typical repo rather than several hundred — and
 * a repo with no `site/` never pays for the `site/*` half of the table at all.
 *
 * The expansion is what makes this work on the repos it is most needed for. A monorepo's web app
 * keeps its favicon in `apps/web/public/`, which no fixed table can name in advance because the
 * package is called whatever it is called.
 */
export function iconDirectories(root: string): string[] {
  let children: Set<string>
  try {
    children = new Set(
      readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name),
    )
  } catch {
    return [root] // unreadable root — the root itself is still worth a look
  }

  const directories: string[] = []
  // The repo root itself, and its own asset directories.
  for (const asset of ASSET_DIRECTORIES) directories.push(under(root, asset))
  // Each host that is really present, crossed with the same asset directories.
  for (const host of HOST_DIRECTORIES) {
    if (!children.has(host)) continue
    for (const asset of ASSET_DIRECTORIES) directories.push(under(join(root, host), asset))
  }
  for (const extra of EXTRA_DIRECTORIES) directories.push(under(root, extra))

  for (const container of WORKSPACE_CONTAINERS) {
    if (!children.has(container)) continue
    let members: string[]
    try {
      members = readdirSync(join(root, container), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => entry.name)
    } catch {
      continue
    }
    for (const member of members) {
      for (const asset of ASSET_DIRECTORIES) directories.push(under(join(root, container, member), asset))
    }
  }
  return [...new Set(directories)]
}

/** `icons[]` out of a web app manifest, as absolute paths. Bad JSON is simply no icons. */
function manifestIcons(manifestPath: string): string[] {
  let parsed: { icons?: { src?: unknown }[] }
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as typeof parsed
  } catch {
    return []
  }
  if (!Array.isArray(parsed?.icons)) return []
  const directory = dirname(manifestPath)
  return parsed.icons
    .map((icon) => (typeof icon?.src === "string" ? icon.src : undefined))
    .filter((src): src is string => !!src && !/^(https?:)?\/\//u.test(src) && !src.startsWith("data:"))
    // A manifest's src is relative to the manifest, and a leading `/` means the site root — which for
    // a static site is the directory the manifest itself sits in. Strip any query or fragment first:
    // cache-busted srcs like `/icon-192.png?v=5` are ordinary, and joining one verbatim yields a path
    // that cannot exist, so the project silently loses every icon its manifest declares.
    .map((src) => join(directory, src.replace(/[?#].*$/u, "").replace(/^\//u, "")))
}

/**
 * Every icon this project might be represented by, best first.
 *
 * Exported for the test and for the "why did it pick that" affordance; callers who just want the
 * answer use `detectProjectIcon`.
 */
export function projectIconCandidates(root: string): ProjectIconCandidate[] {
  const projectStem = normalizeStem(basename(root)).normalized
  const candidates: ProjectIconCandidate[] = []
  const seen = new Set<string>()
  /** Directories that hold a favicon: this project's icon home, per the wayfinder rule up top. */
  const iconHomes = new Set<string>()
  const measured = new Map<string, ImageDimensions | undefined>()
  const measure = (path: string) => {
    if (!measured.has(path)) measured.set(path, imageDimensions(path))
    return measured.get(path)
  }

  const files: { path: string; directory: string }[] = []
  const fromManifest = new Set<string>()

  for (const directory of iconDirectories(root)) {
    if (files.length >= MAX_CANDIDATES) break
    for (const name of listFiles(directory)) {
      const extension = extname(name).toLowerCase()
      if (MANIFEST_NAMES.includes(name.toLowerCase())) {
        for (const icon of manifestIcons(join(directory, name))) {
          if (MEASURABLE_IMAGE_EXTENSIONS.has(extname(icon).toLowerCase())) {
            fromManifest.add(icon)
            files.push({ path: icon, directory: dirname(icon) })
          }
        }
        continue
      }
      if (!MEASURABLE_IMAGE_EXTENSIONS.has(extension)) continue
      const stem = name.slice(0, name.length - extension.length)
      if (normalizeStem(stem).normalized === "favicon") iconHomes.add(directory)
      files.push({ path: join(directory, name), directory })
      if (files.length >= MAX_CANDIDATES) break
    }
  }

  for (const { path, directory } of files) {
    if (seen.has(path)) continue
    seen.add(path)
    const extension = extname(path).toLowerCase()
    const { normalized, variant, square } = normalizeStem(basename(path, extname(path)))
    if (NEVER_AN_ICON.test(normalized)) continue

    const named = nameScore(normalized)
    const isProjectNamed = normalized === projectStem && projectStem.length > 1
    const viaManifest = fromManifest.has(path)
    // In a brand kit the DIRECTORY says the file is a logo, so all its name has left to say is which
    // cut — and `-square` is the cut the tile wants. Both halves are needed: `frog-green-square.png`
    // is unrecognisable by name alone, and outside a kit `-square` is how any image at all gets
    // cropped (`public/team-square.png`).
    const squareCut = square && BRAND_KIT_DIRECTORIES.includes(basename(directory))
    // Something has to vouch for the file: its name, the project's name, a manifest listing it, or a
    // brand kit holding it as the square cut. Without this, `public/team-photo.png` is a candidate in
    // every repo that has one.
    if (!named && !isProjectNamed && !viaManifest && !squareCut) continue

    const dimensions = measure(path)
    if (!dimensions) continue
    const edge = Math.max(dimensions.width, dimensions.height)
    if (edge < MIN_EDGE) continue
    const aspect = dimensions.width / dimensions.height
    if (aspect < MIN_ASPECT || aspect > MAX_ASPECT) continue

    const home = iconHomes.has(directory)
    const segments = directory === root ? [] : relative(root, directory).split(sep)
    const generated = segments.some((segment) => GENERATED_DIRECTORIES.has(segment))
    const score =
      sizeScore(dimensions)
      + (FORMAT_SCORES[extension] ?? 0)
      + (named?.score ?? 0)
      // A name that vouches for itself and ALSO says square is worth a little more than the same
      // name without it (`icon-square` over `icon`). A kit's square cut has no other name score, so
      // it gets an app icon's — which is what it is.
      + (!square ? 0 : named || isProjectNamed ? 2 : squareCut ? 20 : 0)
      + (isProjectNamed ? 16 : 0)
      + (viaManifest ? 8 : 0)
      // The wayfinder payoff: everything sharing a directory with a favicon is lifted, so the big
      // sibling beats the favicon itself while both still beat an icon from some unrelated folder.
      + (home ? 10 : 0)
      // A `logo.svg` sitting in the project root is the most deliberate identity statement a repo
      // makes — it is there for the README, which is to say for people. Without this, zod's root
      // `logo.svg` lost to an `android-chrome-512x512.png` three levels down in a docs site, which is
      // a build artifact of the logo rather than the logo.
      + (segments.length === 0 ? 8 : 0)
      // A GLYPH is not a logo. `svgDeclaresColour` returns undefined for rasters and unreadable files,
      // so only a definite "this SVG paints no colour of its own" is penalised.
      + (svgDeclaresColour(path) === false ? -COLOURLESS_SVG_PENALTY : 0)
      - (variant ? 3 : 0)
      - (generated ? 6 : 0)
      - Math.min(8, segments.length * 2)

    const where = directory === root ? "the project root" : relative(root, directory)
    const size = dimensions.scalable
      ? "scalable"
      : `${Math.round(dimensions.width)}×${Math.round(dimensions.height)}`
    const why = isProjectNamed && !named
      ? "named after the project"
      : named?.reason ?? (squareCut ? "the square logo" : "listed in the web manifest")
    const colourless = svgDeclaresColour(path) === false ? ", no colour of its own" : ""
    candidates.push({ path, score, dimensions, reason: `${size}, ${why}${colourless}, in ${where}` })
  }

  // Ties break towards the SHORTER path, which in practice means the less qualified filename: where
  // `.github/` holds both `logo.webp` and `logo-original.png` at the same score, `logo` is the one the
  // project maintains and `logo-original` is the artwork it was cut from.
  return candidates.sort(
    (a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path),
  )
}

/** The one icon to represent this project, or undefined if it does not ship anything usable. */
export function detectProjectIcon(root: string): ProjectIconCandidate | undefined {
  return projectIconCandidates(root)[0]
}

const MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
}

/** The content type to serve a detected or uploaded icon as, or undefined if we would not serve it. */
export function iconMediaType(path: string): string | undefined {
  return MEDIA_TYPES[extname(path).toLowerCase()]
}

export type ProjectIconResult =
  | { status: 400 | 404 }
  | { status: 200; contentType: string; body: Buffer }

/**
 * Serve a project's icon by project id — the whole of what `/_frizz/project-icon` does.
 *
 * SVG IS SERVED HERE AND REFUSED BY `/local-image`, which is worth being explicit about because it
 * looks like an inconsistency. The two routes trust different inputs. `/local-image` takes an
 * arbitrary absolute path out of agent-authored markdown, so an SVG there is a script the agent chose
 * the contents of. This route takes a project id and answers with a file inside that project — and
 * the rail renders it through `<img src>`, where every browser disables scripting outright. The
 * `default-src 'none'` CSP applied at the route is the belt to that braces. Refusing SVG here instead
 * would throw away the single best icon format, and the one a favicon scan finds most often.
 *
 * CONFINED to the project's own tree or its state dir. `/local-image` is deliberately unconfined and
 * says so; this one has no reason to be, since it only ever answers with a file it found itself.
 */
export function resolveProjectIconResponse(
  id: string | undefined,
  options: { home?: string } = {},
): ProjectIconResult {
  if (!id) return { status: 400 }
  const home = options.home ?? homedir()
  const entry = readRegistry(home).projects.find((project) => project.id === id)
  if (!entry) return { status: 404 }

  const path = resolveProjectIcon(id, (root) => detectProjectIcon(root)?.path, { home })
  if (!path) return { status: 404 }
  const contentType = iconMediaType(path)
  if (!contentType) return { status: 404 }

  let real: string
  try {
    real = realpathSync(path)
    if (!statSync(real).isFile()) return { status: 404 }
  } catch {
    return { status: 404 }
  }
  const roots = [entry.path, projectStateDir(id, home)].map((root) => {
    try {
      return realpathSync(root)
    } catch {
      return root
    }
  })
  if (!roots.some((root) => real === root || real.startsWith(root + sep))) return { status: 404 }

  try {
    return { status: 200, contentType, body: readFileSync(real) }
  } catch {
    return { status: 404 }
  }
}
