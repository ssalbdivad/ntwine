// The macOS half of `pnpm run desktop`: an ntwine.app in ~/Applications that the Dock can keep.
//
// A Dock pin is a pin on an app BUNDLE, and the dev loop otherwise runs the bare Electron.app inside
// node_modules: pinning that window pins Electron, which opened from the Dock shows Electron's default
// app, under Electron's name and icon, from a path the next electron bump deletes. So, as the Windows
// build keeps its copy under %LOCALAPPDATA% for the taskbar (windows.ts), this keeps one here:
// - The bundle: a copy of the pinned Electron.app, renamed ntwine in its Info.plist, carrying ntwine's
//   icon and the app ID main.ts uses on Windows, and signed ad hoc again since the edit breaks
//   Electron's own signature. It is rebuilt only when the electron version changes, so a pin survives
//   every other rebuild.
// - The app: dist/ is copied into Contents/Resources/app, which Electron loads in place of its default
//   app, refreshed before every launch. Its server.json is how a window opened from the Dock, with
//   launchd's bare PATH, starts the dev board when none is running (src/launch.ts).
// - The launch: the dev loop runs THIS bundle, so its window and the Dock pin are one app with one icon.
//
// ~/Applications is the per-user Applications folder macOS already indexes; nothing outside it is written.
import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"

/** main.ts's APP_ID: the bundle identifier, so macOS keeps the Dock pin, notifications and permissions on it. */
const BUNDLE_ID = "dev.ntwine.window"
/**
 * What this script puts in the bundle beyond Electron, as a number in its Info.plist: raise it when that
 * changes (the icon, the plist), so a bundle already in the Dock is rebuilt without waiting for an electron bump.
 */
const BUNDLE_REVISION = "2"

export interface MacApp {
  bundle: string
  start(dist: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess
}

export function prepareMacApp(electronBinary: string, electronVersion: string): MacApp {
  const bundle = join(homedir(), "Applications", "ntwine.app")
  const plist = join(bundle, "Contents", "Info.plist")
  const current = existsSync(plist) && plistValue(plist, "CFBundleVersion") === electronVersion && plistValue(plist, "NtwineBundleRevision") === BUNDLE_REVISION
  if (!current) {
    console.log(`[desktop] building ${bundle} on Electron ${electronVersion}`)
    buildBundle(resolve(electronBinary, "..", "..", ".."), bundle)
  }
  const appDir = join(bundle, "Contents", "Resources", "app")
  const exe = join(bundle, "Contents", "MacOS", "Electron")
  return {
    bundle,
    start(dist, args, env) {
      mkdirSync(appDir, { recursive: true })
      writeFileSync(join(appDir, "package.json"), JSON.stringify({ name: "ntwine-desktop-dev", productName: "ntwine", main: "main.mjs" }))
      for (const file of ["main.mjs", "preload.cjs"]) copyFileSync(join(dist, file), join(appDir, file))
      // No icon.png: main.ts hands one beside it to app.dock.setIcon, which would swap the bundle's inset
      // icon for the full-bleed PNG whenever the app runs. The bundle carries the Dock icon here.
      rmSync(join(appDir, "icon.png"), { force: true })
      // Kept rather than deleted when this run wrote none: the Dock opens this folder too, and without the
      // record its window cannot start the board (windows.ts has the 2026-10-22 incident behind this).
      if (existsSync(join(dist, "server.json"))) copyFileSync(join(dist, "server.json"), join(appDir, "server.json"))
      // The copy changed sealed resources; re-seal so the bundle stays valid for the next Dock launch.
      sign(bundle, false)
      return spawn(exe, args, { env, stdio: "inherit" })
    },
  }
}

function buildBundle(electronApp: string, bundle: string): void {
  const partial = `${bundle}.partial`
  rmSync(partial, { recursive: true, force: true })
  mkdirSync(resolve(bundle, ".."), { recursive: true })
  // ditto, not cp: the frameworks are symlink trees that a plain copy flattens or breaks.
  execFileSync("ditto", [electronApp, partial])
  const plist = join(partial, "Contents", "Info.plist")
  for (const [key, value] of [["CFBundleName", "ntwine"], ["CFBundleDisplayName", "ntwine"], ["CFBundleIdentifier", BUNDLE_ID], ["CFBundleIconFile", "ntwine.icns"], ["NtwineBundleRevision", BUNDLE_REVISION]]) {
    execFileSync("plutil", ["-replace", key, "-string", value!, plist])
  }
  writeIcns(join(import.meta.dirname, "..", "..", "web", "public", "icon-512.png"), join(partial, "Contents", "Resources", "ntwine.icns"))
  // The app the last launch put here goes with it: until the next one, the Dock opens THIS bundle, and an
  // empty Resources/app is Electron's default app under ntwine's name.
  const app = join(bundle, "Contents", "Resources", "app")
  if (existsSync(app)) {
    execFileSync("ditto", [app, join(partial, "Contents", "Resources", "app")])
    rmSync(join(partial, "Contents", "Resources", "app", "icon.png"), { force: true })
  }
  sign(partial, true)
  // Whole or not at all, as windows.ts unpacks: a build killed halfway must not pass the version check.
  rmSync(bundle, { recursive: true, force: true })
  renameSync(partial, bundle)
  // So Finder and the Dock read the new name and icon now rather than from a cached registration.
  execFileSync("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", ["-f", bundle])
}

/**
 * The 512px PNG every other platform uses, as the icon set macOS wants (sips and iconutil ship with macOS).
 *
 * Inset first: that PNG's rounded square fills its canvas edge to edge, as a web icon's does, while a macOS
 * icon draws its shape at 824 of 1024px and leaves the rest transparent (Apple's app icon grid). Unpadded,
 * ntwine stood a fifth taller than every other app in the Dock.
 */
function writeIcns(png: string, icns: string): void {
  const work = mkdtempSync(join(tmpdir(), "ntwine-icns-"))
  try {
    const inset = join(work, "inset.png")
    const master = join(work, "master.png")
    execFileSync("sips", ["-z", "824", "824", png, "--out", inset], { stdio: "ignore" })
    execFileSync("sips", ["--padToHeightWidth", "1024", "1024", inset, "--out", master], { stdio: "ignore" })
    const iconset = join(work, "ntwine.iconset")
    mkdirSync(iconset)
    for (const size of [16, 32, 128, 256, 512]) {
      execFileSync("sips", ["-z", String(size), String(size), master, "--out", join(iconset, `icon_${size}x${size}.png`)], { stdio: "ignore" })
      execFileSync("sips", ["-z", String(size * 2), String(size * 2), master, "--out", join(iconset, `icon_${size}x${size}@2x.png`)], { stdio: "ignore" })
    }
    execFileSync("iconutil", ["-c", "icns", iconset, "-o", icns])
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/** Ad hoc: the bundle never leaves this machine. `deep` once on a build, for the helpers and frameworks. */
function sign(bundle: string, deep: boolean): void {
  execFileSync("codesign", ["--force", ...(deep ? ["--deep"] : []), "--sign", "-", bundle], { stdio: "ignore" })
}

function plistValue(plist: string, key: string): string | undefined {
  try {
    return execFileSync("plutil", ["-extract", key, "raw", plist], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
  } catch {
    return undefined
  }
}
