import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { test, type TestContext } from "node:test"
import { detectProjectIcon, iconMediaType, projectIconCandidates } from "./project-icon.ts"

// EVERY RULE HERE WAS DERIVED FROM REAL REPOSITORIES, not invented. The scan was run across 116 git
// checkouts on the author's machine (2026-08-06) and each of these tests pins a case it got WRONG on
// that pass — which repository, and what it picked instead, is named in the test. That is the only
// reason to believe the scoring means anything: nothing here is a rule the implementation and the
// test agreed on between themselves.

function png(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(33)
  buffer.writeUInt32BE(0x89504e47, 0)
  buffer.writeUInt32BE(0x0d0a1a0a, 4)
  buffer.writeUInt32BE(13, 8)
  buffer.write("IHDR", 12, "ascii")
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  return buffer
}

/**
 * A COLOURED svg — which is what a real logo is, and therefore the right default for these fixtures.
 * The fill matters: a colourless SVG is deliberately demoted (it is a tint-me glyph, not a logo), so a
 * helper that emitted no colour would quietly make every fixture below test the glyph path instead.
 */
const svg = (width: number, height = width) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"><path fill="#e8b923" d="M0 0z"/></svg>`

/** The Simple-Icons shape: no fill anywhere, so it inherits — and through an `<img>` paints black. */
const glyph = (width: number, height = width) =>
  `<svg role="img" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"><path d="M0 0z"/></svg>`

/** Build a throwaway project tree. Values are file contents; a Buffer is written as bytes. */
function project(t: TestContext, name: string, files: Record<string, Buffer | string>): string {
  const root = join(mkdtempSync(join(tmpdir(), "frizz-icon-")), name)
  t.after(() => rmSync(dirname(root), { recursive: true, force: true }))
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, contents)
  }
  return root
}

/** The winner's path, relative to the project root — what the assertions read most clearly. */
function picked(root: string): string | undefined {
  const best = detectProjectIcon(root)
  return best && relative(root, best.path)
}

test("the larger square sibling beats the favicon that led us to its directory", (t) => {
  // The whole premise: a favicon marks the directory, and the icon a person would have chosen is the
  // big one sitting beside it.
  const root = project(t, "app", {
    "public/favicon.ico": png(32, 32),
    "public/apple-touch-icon.png": png(180, 180),
  })
  assert.equal(picked(root), join("public", "apple-touch-icon.png"))
})

test("a favicon's directory lifts its neighbours over an icon from an unrelated folder", (t) => {
  const root = project(t, "app", {
    "public/favicon.ico": png(48, 48),
    "public/icon.png": png(192, 192),
    "docs/assets/icon.png": png(192, 192),
  })
  assert.equal(picked(root), join("public", "icon.png"))
})

test("a root logo.svg beats a bigger icon buried in a docs site (zod)", (t) => {
  // Measured wrong: zod's root `logo.svg` lost to `packages/docs-v3/static/android-chrome-512x512.png`
  // by one point. The root file is the logo; the deep PNG is a build artifact of it.
  const root = project(t, "zod", {
    "logo.svg": svg(200),
    "packages/docs-v3/static/favicon.ico": png(48, 48),
    "packages/docs-v3/static/android-chrome-512x512.png": png(512, 512),
  })
  assert.equal(picked(root), "logo.svg")
})

test("a project's own icon beats another project's logo sitting in the same folder (colinhacks)", (t) => {
  // Measured wrong: a personal site's `public/` holds `trpc-logo.svg` and `zod-logo.svg` beside its
  // own `icon.png`, and the scan handed the site trpc's logo.
  const root = project(t, "colinhacks", {
    "public/icon.png": png(387, 387),
    "public/trpc-logo.svg": svg(200),
    "public/zod-logo.svg": svg(200),
  })
  assert.equal(picked(root), join("public", "icon.png"))
})

test("the unqualified mark beats its light variant (opencode)", (t) => {
  // Measured wrong: `mark-light.svg` and `mark.svg` tied and alphabetical order handed the rail the
  // light-background mark, against dark chrome.
  const root = project(t, "opencode", {
    "packages/identity/mark.svg": svg(64),
    "packages/identity/mark-light.svg": svg(64),
    "packages/identity/mark-dark.svg": svg(64),
  })
  assert.equal(picked(root), join("packages", "identity", "mark.svg"))
})

test("the source copy beats the identical one in build output (dpclytics)", (t) => {
  const root = project(t, "site", {
    "public/favicon.ico": png(256, 256),
    "build/favicon.ico": png(256, 256),
  })
  assert.equal(picked(root), join("public", "favicon.ico"))
})

test("a file named after the project counts as its icon", (t) => {
  const root = project(t, "boron", { "assets/boron.png": png(256, 256) })
  assert.equal(picked(root), join("assets", "boron.png"))
})

test("a web manifest's icons[] are candidates, resolved against the manifest (virgil)", (t) => {
  // The only route by which `logo512.png` — a name no pattern matches — is found at all.
  const root = project(t, "virgil", {
    "packages/app/public/manifest.json": JSON.stringify({
      icons: [
        { src: "logo192.png", sizes: "192x192" },
        { src: "/logo512.png", sizes: "512x512" },
        { src: "https://cdn.example.com/remote.png" },
      ],
    }),
    "packages/app/public/logo192.png": png(192, 192),
    "packages/app/public/logo512.png": png(512, 512),
  })
  assert.equal(picked(root), join("packages", "app", "public", "logo512.png"))
})

test("a cache-busted manifest src still resolves (frizz's own manifest carries ?v=)", (t) => {
  // `/logo512.png?v=5` joined verbatim is a path that cannot exist, which would
  // drop every icon the manifest declares and leave the project with none.
  const root = project(t, "busted", {
    "public/manifest.webmanifest": JSON.stringify({
      icons: [
        { src: "/logo512.png?v=5", sizes: "512x512" },
        { src: "/logo192.png#hash", sizes: "192x192" },
      ],
    }),
    "public/logo512.png": png(512, 512),
    "public/logo192.png": png(192, 192),
  })
  assert.equal(picked(root), join("public", "logo512.png"))
})

test("a monorepo's web package is reached, though no fixed table could name it", (t) => {
  const root = project(t, "mono", { "apps/whatever-we-called-it/public/icon.png": png(512, 512) })
  assert.equal(picked(root), join("apps", "whatever-we-called-it", "public", "icon.png"))
})

test("a wordmark and a social card are not icons, however large", (t) => {
  const root = project(t, "app", {
    // 1200×630 in `public/` beside the favicon: the largest image in a great many repos.
    "public/og-image.png": png(1200, 630),
    "public/logo.svg": svg(320, 64), // a wide wordmark
    "public/favicon.ico": png(64, 64),
  })
  assert.equal(picked(root), join("public", "favicon.ico"))
})

test("a square og-image is refused by name, not left to the aspect gate", (t) => {
  const root = project(t, "app", { "public/og-image.png": png(1024, 1024) })
  assert.equal(picked(root), undefined)
})

test("an image too small to survive being drawn at 32px is not offered", (t) => {
  const root = project(t, "app", { "favicon.ico": png(16, 16) })
  assert.equal(picked(root), undefined)
})

test("a photo nobody named like an icon is not a candidate", (t) => {
  // Without the "something must vouch for this file" rule, every repo with a square image in
  // `public/` gets it as its icon.
  const root = project(t, "app", { "public/team-photo.png": png(600, 600) })
  assert.equal(picked(root), undefined)
})

test("a library that ships no images at all resolves to nothing, not to a guess", (t) => {
  const root = project(t, "nub", { "README.md": "# nub", "src/index.ts": "export {}" })
  assert.equal(detectProjectIcon(root), undefined)
})

test("node_modules is never walked, however many icons are in it", (t) => {
  const root = project(t, "app", {
    "node_modules/some-dep/public/icon.png": png(512, 512),
    "public/icon.png": png(64, 64),
  })
  assert.equal(picked(root), join("public", "icon.png"))
})

test("the reason names the size, the evidence and the place", (t) => {
  const root = project(t, "app", { "public/favicon.ico": png(48, 48), "public/logo.svg": svg(64) })
  const best = detectProjectIcon(root)
  assert.equal(best?.reason, "scalable, the project logo, in public")
  assert.match(projectIconCandidates(root)[1]!.reason, /^48×48, the favicon, in public$/u)
})

test("a malformed manifest and an unreadable image are skipped, not thrown", (t) => {
  const root = project(t, "app", {
    "public/manifest.json": "{ this is not json",
    "public/icon.png": Buffer.from("not really a png"),
    "public/logo.svg": svg(64),
  })
  assert.equal(picked(root), join("public", "logo.svg"))
})

test("only formats a browser will render in an <img> are servable", () => {
  assert.equal(iconMediaType("/x/icon.svg"), "image/svg+xml")
  assert.equal(iconMediaType("/x/FAVICON.ICO"), "image/x-icon")
  assert.equal(iconMediaType("/x/icon.png"), "image/png")
  assert.equal(iconMediaType("/x/icon.bmp"), undefined)
  assert.equal(iconMediaType("/x/icon.pdf"), undefined)
})

test("a site in a SUBDIRECTORY is looked in — site/public, not just site (nub)", (t) => {
  // The real miss, and the reason the directory table became a cross product. nub keeps a complete
  // icon set at `site/public/`; the old table listed `site` and `public` separately but never their
  // combination, so the scan came back empty on a repo that plainly has a logo.
  const root = project(t, "nub", {
    "site/public/icon.svg": svg(512),
    "site/public/favicon.ico": png(48, 48),
    "site/public/icon-512.png": png(512, 512),
  })
  assert.equal(picked(root), join("site", "public", "icon.svg"))
})

test("every host directory gets its own asset directories", (t) => {
  // One case per family, so a future edit to HOST_DIRECTORIES cannot silently drop one.
  for (const [host, asset] of [
    ["web", "public"],
    ["www", "static/img"],
    ["docs", "public"],
    ["frontend", "assets"],
    ["client", "public"],
    ["website", "static"],
  ] as const) {
    const root = project(t, `host-${host}`, { [`${host}/${asset}/icon.png`]: png(512, 512) })
    assert.equal(picked(root), join(host, ...asset.split("/"), "icon.png"), `${host}/${asset}`)
  }
})

test("a host that does not exist costs nothing and finds nothing", (t) => {
  const root = project(t, "plain", { "README.md": "# plain", "src/index.ts": "export {}" })
  assert.equal(detectProjectIcon(root), undefined)
})

test("a colourless glyph loses to the coloured logo beside it (bun)", (t) => {
  // Measured: bun's `site/public/icon.svg` is a Simple Icons glyph with no fill — solid black through
  // an <img> — and `logo.svg` next to it carries the six brand colours. Both scored 76 and the tie
  // went alphabetically to the black one, so the rail wore a black tile for bun.
  const root = project(t, "bun", {
    "site/public/icon.svg": glyph(24),
    "site/public/logo.svg": `<svg viewBox="0 0 80 70"><path style="fill:#fbf0df" d="M0 0z"/><path style="fill:#f6dece" d="M1 1z"/></svg>`,
  })
  assert.equal(picked(root), join("site", "public", "logo.svg"))
})

test("...and the reason says why it lost", (t) => {
  const root = project(t, "bun", {
    "public/icon.svg": glyph(24),
  })
  assert.match(detectProjectIcon(root)?.reason ?? "", /no colour of its own/u)
})

test("a colourless glyph is still better than nothing when it is all there is", (t) => {
  // A dark silhouette on the tile identifies a project; the monogram fallback does not. The penalty
  // orders candidates, it does not disqualify one.
  const root = project(t, "glyphy", {
    "public/icon.svg": glyph(24),
  })
  assert.equal(picked(root), join("public", "icon.svg"))
})

test("a brand kit's square cut beats the small touch icon the app ships (pullfrog)", (t) => {
  // Measured wrong: Pullfrog keeps its logo in `public/logos/`, which was never searched, under names
  // nothing recognised — so the rail wore `app/apple-icon.png`, a 180px disc inside a square tile,
  // while a 600px square of the same frog sat unread. The sizes and names are the real ones.
  const root = project(t, "app", {
    "app/favicon.ico": png(48, 48),
    "app/apple-icon.png": png(180, 180),
    "public/favicon.ico": png(48, 48),
    "public/favicon-96x96.png": png(96, 96),
    "public/logos/frog-green-square.png": png(600, 600),
    "public/logos/frog-white-square.png": png(600, 600),
    "public/logos/frog-green-square-border.png": png(600, 600),
    "public/logos/frog-green-circle.png": png(600, 600),
    "public/logos/green-wordmark.png": png(937, 219),
  })
  const candidates = projectIconCandidates(root).map((candidate) => relative(root, candidate.path))
  // The brand colour ahead of its white rendition, and neither the circle nor the bordered square
  // offered at all: the kit vouches for a file only where its name says which cut it is.
  assert.deepEqual(candidates.slice(0, 3), [
    join("public", "logos", "frog-green-square.png"),
    join("public", "logos", "frog-white-square.png"),
    join("app", "apple-icon.png"),
  ])
  assert.ok(!candidates.some((path) => /circle|border|wordmark/u.test(path)))
  assert.equal(detectProjectIcon(root)?.reason, "600×600, the square logo, in public/logos")
})

test("-square outside a brand kit is a crop, not a logo", (t) => {
  // The directory is half the evidence. `public/` holds any image a site serves, and plenty of them
  // are cut square.
  const root = project(t, "app", { "public/team-square.png": png(600, 600) })
  assert.equal(picked(root), undefined)
})

test("a name that already vouches for itself keeps its meaning when it says square", (t) => {
  // `logo-square` used to read as a QUALIFIED logo — the rule for `zod-logo`, somebody else's — and
  // lost to the favicon's 96px sibling.
  const root = project(t, "app", {
    "public/favicon.ico": png(48, 48),
    "public/favicon-96x96.png": png(96, 96),
    "assets/logo-square.png": png(96, 96),
    "assets/logo-square-dark.png": png(96, 96),
  })
  assert.equal(picked(root), join("assets", "logo-square.png"))
  assert.match(detectProjectIcon(root)?.reason ?? "", /the project logo/u)
})

test("a raster is never penalised for colour, because we cannot read it from the header", (t) => {
  const root = project(t, "app", { "public/icon.png": png(512, 512), "public/logo.svg": svg(24) })
  // Both are legitimate; the SVG wins on format as it always did, and the PNG is not demoted.
  assert.equal(picked(root), join("public", "logo.svg"))
  assert.ok(projectIconCandidates(root).some((c) => c.path.endsWith("icon.png")))
})
