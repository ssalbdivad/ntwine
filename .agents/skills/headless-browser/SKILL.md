---
name: headless-browser
description: Drive a local page in Chrome and capture it WITHOUT putting a window on the maintainer's screen — `scripts/shot.mjs` (isolated headless puppeteer, screenshot + in-page evaluate + page-error report) as the default, Chrome DevTools MCP when you must genuinely drive rather than photograph, plus the browser process hygiene that keeps concurrent agents from killing each other's runs, why a headless run stalls while the Mac's display sleeps (`Runtime.callFunctionOn timed out`, screenshots that never return), and the rules for embedding screenshots so Frizz actually renders them. Load this whenever you need to SEE a page — proving something renders, responsive/overflow checks, console and network inspection, capturing evidence for a handoff, or any change judged by eye. Popping a visible browser is the single most disruptive thing an agent does here and is never necessary. Pair with `frizz-stack` for something to point it at, and `visual-review` / `optical-spacing` for how to JUDGE the shot.
version: 0.1.0
metadata:
  internal: true
---

# headless-browser — take the shot, disturb nobody

## NEVER put a browser window on the maintainer's screen

You share this desktop with a human who is working. A verification run must be **invisible**: headless,
on a throwaway profile, leaving no window and no tab behind. Popping a visible Chrome is the single most
disruptive thing you can do here, and it is never necessary — `shot.mjs` does everything the gate
requires without ever drawing a pixel. If you catch yourself about to launch a headful browser, that is
the bug.

This is not a style note. It was a real, repeated complaint (maintainer 2026-07-28: *"it keeps opening
tabs in my actual real Chrome"*), and the cause was a skill file recommending the MCP first.

## NEVER the maintainer's real Chrome — one launcher, one browser

**Every browser you start comes from `launchHeadless()` in `scripts/lib/headless-browser.mjs`.** It launches puppeteer's own `chrome-headless-shell` on a temp profile: no window, no Dock tile, dark by default, and never the installed Google Chrome. `shot.mjs`, the `verify-*` scripts and the e2e tests all go through it. So does a driver you write yourself:

```js
import { launchHeadless } from "/abs/path/to/frizz/scripts/lib/headless-browser.mjs"

const browser = await launchHeadless() // or { protocolTimeout: 30_000, args: ["--disable-gpu"], colorScheme: "light" }
```

**Do not call `puppeteer.launch`, and do not name `/Applications/Google Chrome.app` in a command, a script or a prompt** — not headless, not on a throwaway profile. AGENTS.md § Agents never touch the maintainer's real Chrome has the reason (that binary is the one program that can silently unlock the real profile's cookies) and what enforces it. `headless: "new"` is also out: it runs the full "Google Chrome for Testing.app", which flickers the Dock on every launch (187 times in 40 minutes on 2026-10-11, from scratch drivers copying that one line).

**A raw command line carries `--use-mock-keychain`.** The launcher and the MCP pass it already. If you build a command around the headless shell yourself (`await puppeteer.executablePath({ headless: "shell" })` is its path), or write a prompt that tells a worker to, add the flag: without it, a Chromium under a temporary `HOME` (every sandbox) makes macOS put a modal "Keychain Not Found" dialog on the maintainer's screen. AGENTS.md § Never put a macOS keychain dialog on the maintainer's screen has the rest.

---

## 1. The default: `scripts/shot.mjs` (puppeteer)

`shot.mjs` launches its **own isolated headless shell** every run, through `launchHeadless()` — a fresh
`puppeteer_dev_chrome_profile-*` temp dir, no shared profile, no collision, no window, no Dock tile. It
works in the background unconditionally and cannot disturb the maintainer. The page sees a DARK system
(what the maintainer's eye sees); a light-mode shot sets the app's theme or emulates the scheme per page. It screenshots and runs an in-page
`evaluate` in one shot, and prints any page/console errors. This is the workhorse for "prove it renders",
responsive checks, and optical review.

```bash
# screenshot + assert page state (the eval's completion value prints as json)
# `/all` is All projects: every project's rows on the left ([data-xq-thread-row]), every queued card on the
# right ([data-xq-card]). A thread's drawer is /all/<slug>/thread/<t>; one project's board is /project/<slug>.
# A bare `/` redirects to the browser's last view — a project's board in a fresh profile — so name the view.
node scripts/shot.mjs "http://127.0.0.1:4930/all" .adhoc-shots/page-desktop.png \
  "({title: document.title, rows: document.querySelectorAll('[data-xq-thread-row]').length, cards: document.querySelectorAll('[data-xq-card]').length})" \
  --w=1440 --h=900 --wait=2500

# narrow viewport for responsive/overflow checks (below 800px the columns stack)
node scripts/shot.mjs "http://127.0.0.1:4930/" .adhoc-shots/page-narrow.png "" --w=420 --h=880

# a complex in-page routine (occlusion/alignment/optical-center) from a file
node scripts/shot.mjs "$URL" out.png @/tmp/routine.js
```

Always: capture **desktop + narrow** widths, read the screenshots back, and check the `PAGE ERRORS:` line
— a clean render with console errors is not a pass. Exercise the relevant active/idle/error/restart
states, not just first paint.

**Headless Chrome is a touch screen unless you say otherwise.** It has no pointing device, so it answers
`(hover: none)` and `(pointer: none)`: every Tailwind v4 `hover:` / `group-hover:` style is dead, and the
app's `(hover: none)` touch rules apply — ProjectList's row actions and the code-block copy button show at
rest. `--hover` implies `--mouse`, which launches Chrome as a desktop with a mouse
(`scripts/lib/mouse-pointer.mjs`; `ink-gaps.mjs` takes both flags too). Pass `--mouse` alone for a
desktop RESTING shot of anything hover-gated, and leave it off at phone widths, where touch is the truth.
Before it existed (2026-09-28), `--hover` on a pill came back with the pill's resting border and colour,
and a desktop shot showed controls the desktop hides.

---

## 2. Chrome DevTools MCP — richer, but only because this repo forces it headless

The MCP gives you a real a11y tree and interaction primitives (`new_page` → `navigate_page` →
`take_snapshot` / `take_screenshot` / `list_console_messages` / `list_network_requests` / `click` /
`fill` / `evaluate_script`). Reach for it when you genuinely need to *drive* the page rather than
photograph it.

> **Why it is second, and why it used to be a menace.** `chrome-devtools-mcp` ships two hostile defaults:
> `headless` defaults to **false** (`cli-options.js`) so it opens a **visible window on the maintainer's
> desktop**, and `isolated` defaults to **false** (`index.js`) so every agent shares one persistent
> profile at `~/.cache/chrome-devtools-mcp/chrome-profile`. Shared-profile collisions then fail every
> `new_page` with *"The browser is already running … Use --isolated"*.
>
> A third is worse than both: with no `--executablePath` it launches puppeteer's `chrome` channel, which is
> the **installed Google Chrome** — the maintainer's real browser binary (48 such launches in half an hour
> on 2026-10-11). `--autoConnect` and `--browserUrl` go further and attach to the one already running.
>
> This repo runs the server through `scripts/chrome-devtools-mcp.mjs` from both `.mcp.json` and
> `.codex/config.toml`. The wrapper pins the version, passes `--headless --isolated`, and hands the server
> puppeteer's `chrome-headless-shell`; with none in the cache it exits rather than fall back to the installed
> Chrome. `.claude/settings.json` disables the argument-less plugin build, because `enabledPlugins` accepts
> no flags and so can only ever run headful, on the real Chrome. **Do not re-enable that plugin, and do not
> launch `chrome-devtools-mcp` any other way than through the wrapper.** If the MCP is unavailable or
> collides anyway, fall straight to `shot.mjs` — don't fight it.
>
> **The `.mcp.json` is where the browser comes from — Frizz does not supply one.** Frizz mounted
> chrome-devtools into every worker it dispatched, on both backends, until 2026-08-26; it now injects only
> the `frizz` MCP server. So these tools are here because THIS repo configures them (`.mcp.json` +
> `enabledMcpjsonServers` in `.claude/settings.json`), and a worker dispatched in a repo that configures
> nothing has no browser at all. Anyone who wants one elsewhere adds it themselves — a project `.mcp.json`,
> or `claude mcp add --scope user chrome-devtools -- npx -y chrome-devtools-mcp@<version> --headless
> --isolated --executablePath=<a chrome-headless-shell>`. Without that last flag it is the installed Chrome.

**Removing an injected style: hold the handle.** `page.addStyleTag()` returns an ElementHandle — remove
THAT (`await tag.evaluate((el) => el.remove())`). Never sweep `querySelectorAll("style")` matching on
text content: in dev, Vite injects the entire app CSS as a `<style>`, so a predicate like "contains
`.frizz-todo-row` and `nowrap`" matches the whole stylesheet and deletes it. The page then renders
unstyled and every geometry assertion after it fails for a reason that has nothing to do with your change.

---

## 3. Process hygiene — you share this machine

Other agents run QA concurrently against the same machine. Everything you start, you own by exact
identity, and you clean up only YOUR identity.

- **One browser instance per task, not per screenshot.** Reuse a single uniquely named owned session /
  target / harness instance for every desktop and narrow check in the task.
- **Arrange cleanup before launch** — a `finally`, a shell `trap`, or equivalent — so an interrupted or
  failed QA pass still tears down. Verify the exact owned session/target and its helper-process tree are
  gone before you rest.
- **NEVER use a global close, and never a broad `pkill -f`.** `close_all_pages`, a bare `pkill -f chrome`,
  or killing by name will take out another agent's live QA and dev servers. Kill by the exact PID /
  session id you created.
- Never leave a Chrome DevTools MCP helper, `agent-browser` daemon, puppeteer browser, or
  Chrome/Chromium helper process running after the task that started it.

---

## 3b. A sleeping display stops every "new" headless frame

**This is a property of full Chrome's "new" headless, which nothing here launches any more.** `launchHeadless()` and the MCP wrapper both run `chrome-headless-shell`, which kept drawing with the display asleep (6 of 6 runs on 2026-10-05, measured through `PUPPETEER_EXECUTABLE_PATH` before it became the default). The shell has not been re-measured through a long display sleep since the switch on 2026-10-11, so the diagnosis below stays: if a run stalls on frames, check the display first.

**While the Mac's display is asleep, new-headless Chrome draws nothing, and nothing says so.** Script calls keep answering (`page.evaluate`, DOM queries, computed styles), so the page looks alive. Everything that waits for a FRAME waits forever: `requestAnimationFrame`, an `IntersectionObserver`'s first callback, `waitForSelector` with `visible: true` (puppeteer polls a visibility wait on animation frames), `page.click()` (puppeteer first scrolls the target into view through an IntersectionObserver), and every screenshot. Puppeteer then reports `Runtime.callFunctionOn timed out` or a bare `TimeoutError`, which reads like a hung page. It is the whole browser, not the page: a fresh tab on a blank `data:` page stalls too.

Measured 2026-10-05 on this machine (Apple M1 Max, Chrome compositing on ANGLE Metal with Skia Graphite). Six runs of a published-package e2e between 17:11 and 17:58 stalled, and every stall began inside a display-off window in `pmset -g log` (off at 17:05:56, on at 17:57:19). One stuck screenshot completed at 17:22:43, the exact second of a 16-second wake. The next two runs, with the display on, passed with GPU compositing on and with `--disable-gpu`; `--disable-gpu` has not been run with the display asleep. A new browser draws normally for its first one to three seconds, so a quick smoke test passes while a longer run stalls.

- **Check the display before you debug the page:** `pmset -g log | grep 'Display is turned' | tail -3`. If the last line says `off`, the stall is the display. Re-run once it is on.
- **Make a stall fail fast:** launch with a short `protocolTimeout` (30s rather than puppeteer's 180s default), so the stall surfaces in seconds rather than minutes.

---

## 4. Putting the shot in the handoff

Show the **decisive** screenshots (not bulk) in a **```lightbox fence** — one absolute path per line, a caption after each — which Frizz draws as a gallery the maintainer opens, zooms into and pages through. It is the ONLY way a picture reaches them: Frizz folds every tool call into a collapsed row, a screenshot you took or Read included, so a shot you only looked at is on nobody's screen (maintainer 2026-10-03: *"No images or screenshots are visible unless you make them visible to the user with the light box"*). A screen recording goes in the same fence — `.mp4`, `.webm` or `.mov` — and plays in the viewer. Markdown `![](…)` still renders, but it is no longer the way to do it; and never `SendUserFile`, which a dispatched worker does not have.

Frizz serves a local picture or video through its origin-gated `/local-image` route, and the route is deliberately path-unconfined (`packages/server/src/local-image.ts`): any absolute path that realpath-resolves to a regular `.png`/`.jpg`/`.jpeg`/`.gif`/`.webp`/`.mp4`/`.m4v`/`.webm`/`.mov` file renders — `.adhoc-shots/` included. The trap is **durability**, not authorization: `/tmp` and `os.tmpdir()` are emptied at boot, and a handoff card is read hours or days later. Three shots embedded from `/tmp` on 2026-08-29 had become gray path labels by the time the maintainer read them, because the machine rebooted in between (a picture that fails to load deliberately falls back to its plain path text). Show them from a path that outlives a reboot: `.adhoc-shots/` right where `shot.mjs` wrote it, or your thread's scratch directory. Keep a concise textual finding beside the fence; the handoff must still read when the pictures are unavailable.

If a check was skipped (MCP unavailable, a state you couldn't reach), say so plainly — don't imply
coverage you didn't have.

---

## Composes with

- **`frizz-stack`** — boot the thing you are pointing this at.
- **`visual-review`** — this skill gets you the shot; that one tells you how to JUDGE it. Load it for any
  UI change: it carries the ink-measurement routine for icon-beside-text alignment (every glyph is off by
  a different amount, so one shared nudge cannot fix a cluster) and the baseline-probe bug that inflates a
  real 1.2px error into a plausible 3.5px one.
- **`optical-spacing`** — the same law sideways, for the ink gaps in a row of controls.
