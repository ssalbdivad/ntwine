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

export interface MacApp {
  bundle: string
  start(dist: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess
}

export function prepareMacApp(electronBinary: string, electronVersion: string): MacApp {
  const bundle = join(homedir(), "Applications", "ntwine.app")
  const plist = join(bundle, "Contents", "Info.plist")
  const built = existsSync(plist) ? plistValue(plist, "CFBundleVersion") : undefined
  if (built !== electronVersion) {
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
      for (const file of ["main.mjs", "preload.cjs", "icon.png"]) copyFileSync(join(dist, file), join(appDir, file))
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
  for (const [key, value] of [["CFBundleName", "ntwine"], ["CFBundleDisplayName", "ntwine"], ["CFBundleIdentifier", BUNDLE_ID], ["CFBundleIconFile", "ntwine.icns"]]) {
    execFileSync("plutil", ["-replace", key, "-string", value!, plist])
  }
  writeIcns(join(import.meta.dirname, "..", "..", "web", "public", "icon-512.png"), join(partial, "Contents", "Resources", "ntwine.icns"))
  sign(partial, true)
  // Whole or not at all, as windows.ts unpacks: a build killed halfway must not pass the version check.
  rmSync(bundle, { recursive: true, force: true })
  renameSync(partial, bundle)
  // So Finder and the Dock read the new name and icon now rather than from a cached registration.
  execFileSync("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", ["-f", bundle])
}

/** The 512px PNG every other platform uses, as the icon set macOS wants (sips and iconutil ship with macOS). */
function writeIcns(png: string, icns: string): void {
  const work = mkdtempSync(join(tmpdir(), "ntwine-icns-"))
  try {
    const iconset = join(work, "ntwine.iconset")
    mkdirSync(iconset)
    for (const size of [16, 32, 128, 256, 512]) {
      execFileSync("sips", ["-z", String(size), String(size), png, "--out", join(iconset, `icon_${size}x${size}.png`)], { stdio: "ignore" })
      if (size <= 256) execFileSync("sips", ["-z", String(size * 2), String(size * 2), png, "--out", join(iconset, `icon_${size}x${size}@2x.png`)], { stdio: "ignore" })
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
    return execFileSync("plutil", ["-extract", key, "raw", plist], { encoding: "utf8" }).trim()
  } catch {
    return undefined
  }
}
