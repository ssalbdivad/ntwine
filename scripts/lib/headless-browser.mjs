// THE ONE PLACE THIS REPO LAUNCHES A BROWSER TO AUTOMATE. Every script and every e2e test calls
// `launchHeadless()`; nothing else calls `puppeteer.launch`, and `scripts/browser-launch-policy.test.mjs`
// fails the suite if something does. Three decisions live here so that no call site can get them wrong.
//
// 1. THE BROWSER IS PUPPETEER'S `chrome-headless-shell`, NEVER THE INSTALLED GOOGLE CHROME.
//    An agent must not run the maintainer's real browser binary, on any profile (AGENTS.md § Agents
//    never touch the maintainer's real Chrome). The signed Google Chrome is the one program macOS lets
//    read the "Chrome Safe Storage" keychain item without asking, so that binary pointed at a COPY of
//    the real profile, with a debugging pipe attached, is a logged-in session nobody consented to.
//    `executablePath` and `channel` are therefore refused here rather than forwarded, and a
//    `PUPPETEER_EXECUTABLE_PATH` that names an installed Chrome is refused after launch.
//
// 2. IT IS THE HEADLESS SHELL RATHER THAN "NEW" HEADLESS, for two measured reasons.
//    · No Dock. `headless: "new"` (and `true`, the same thing since puppeteer 22) runs the full
//      "Google Chrome for Testing.app", which macOS registers as a foreground app before Chrome
//      demotes itself a few milliseconds later: the Dock opens a gap for a tile and closes it again.
//      Measured 2026-10-11 with `lsappinfo listen +all forever`: 187 of those in 40 minutes, 25 a
//      minute at the peak, from a dozen agents taking screenshots (maintainer: "something was
//      constantly trying to open an item in the dock and failing"). The shell is a bare executable
//      and registers as background-only from birth.
//    · It keeps drawing while the display sleeps. New headless stops producing frames then, and every
//      screenshot and rAF-polled wait hangs (headless-browser skill § 3b); the shell drew 6 of 6 in
//      the same test on 2026-10-05.
//    Same Chromium build either way — puppeteer downloads both — but NOT byte-identical pixels,
//    because the two composite differently. Measured 2026-10-11 against new headless: on
//    `composer-icons-fixture.html` at dsf 4, every element's box, colour and font matched exactly and
//    0.0065% of pixels differed by more than 8/255 (antialiased edges); a synthetic gradient +
//    backdrop-blur page differed that much in about 1%. The whole e2e suite agrees between the two.
//
// 3. THE PAGE SEES A DARK SYSTEM UNLESS TOLD OTHERWISE. Full Chrome followed macOS, which is Dark on
//    the maintainer's machine, so every shot and colour assertion here was written against dark. The
//    shell has no system appearance to follow and reports `prefers-color-scheme: light`, which turned
//    `agentRowIndicators.e2e.test.ts`'s failure red from (229, 83, 75) into the light theme's
//    (207, 34, 46). Pinning it makes a result independent of the machine that produced it. Pass
//    `colorScheme: "light"` for the other, or emulate per page with `page.emulateMediaFeatures`.
//
// `args` are ADDED to the base set, so a call site names only what is special about it:
//
//   const browser = await launchHeadless()
//   const browser = await launchHeadless({ protocolTimeout: 30_000, args: ["--disable-gpu"] })
//
// Puppeteer itself passes `--use-mock-keychain` (AGENTS.md § Never put a macOS keychain dialog on the
// maintainer's screen), a fresh temp profile per launch, and tears the profile down on close.
import puppeteer from "puppeteer"
import { MOUSE_POINTER_SETTINGS } from "./mouse-pointer.mjs"

const BASE_ARGS = ["--no-sandbox", "--force-color-profile=srgb"]
// Blink's PreferredColorScheme enum: 0 is dark, 1 is light. `--force-dark-mode` does nothing to the shell.
const COLOR_SCHEME_SETTING = { dark: "preferredColorScheme=0", light: "preferredColorScheme=1" }
const REFUSED = {
  executablePath: "the browser is puppeteer's chrome-headless-shell, never one you name",
  channel: "a channel is an INSTALLED Chrome",
  headless: "this launcher is headless-only; a window on the maintainer's screen is never necessary",
}

/** True for a Google Chrome installed on the machine, as opposed to a browser puppeteer downloaded. */
export function isInstalledChrome(executable) {
  return (
    /\/Google Chrome( Beta| Dev| Canary)?\.app\//.test(executable) ||
    /[\\/]Google[\\/]Chrome[^\\/]*[\\/]Application[\\/]chrome\.exe$/i.test(executable) ||
    /\/google-chrome[^/]*$/.test(executable)
  )
}

/**
 * `mouse` makes the page a desktop with a mouse rather than headless Chrome's touch screen
 * (lib/mouse-pointer.mjs). It is an option and not an `args` entry because both it and the colour scheme
 * are `--blink-settings`, and Chrome keeps only the LAST of a repeated switch: passed as two flags, the
 * pointer settings silently dropped the dark scheme (measured 2026-10-12 on the shell: `prefers-color-scheme:
 * dark` false with both flags, true with one). So they are joined into one switch here, and a
 * `--blink-settings` in `args` is refused rather than allowed to clobber them.
 *
 * @param {Omit<import("puppeteer").LaunchOptions, "executablePath" | "channel" | "headless"> & { colorScheme?: "dark" | "light"; mouse?: boolean }} [options]
 */
export async function launchHeadless({ args = [], colorScheme = "dark", mouse = false, ...options } = {}) {
  for (const [key, why] of Object.entries(REFUSED)) {
    if (key in options) throw new Error(`launchHeadless: \`${key}\` is not accepted — ${why}. See scripts/lib/headless-browser.mjs.`)
  }
  if (!(colorScheme in COLOR_SCHEME_SETTING)) throw new Error(`launchHeadless: colorScheme must be "dark" or "light", not ${JSON.stringify(colorScheme)}`)
  if (args.some((arg) => arg.startsWith("--blink-settings"))) throw new Error("launchHeadless: pass `colorScheme` or `mouse`, not `--blink-settings` — Chrome keeps only the last one")
  const blink = [COLOR_SCHEME_SETTING[colorScheme], ...(mouse ? [MOUSE_POINTER_SETTINGS] : [])].join(",")
  const browser = await puppeteer.launch({ ...options, headless: "shell", args: [...BASE_ARGS, `--blink-settings=${blink}`, ...args] })
  const executable = browser.process()?.spawnfile ?? ""
  if (isInstalledChrome(executable)) {
    await browser.close()
    throw new Error(`launchHeadless: refusing to drive the installed Chrome at ${executable} — unset PUPPETEER_EXECUTABLE_PATH. See scripts/lib/headless-browser.mjs.`)
  }
  return browser
}
