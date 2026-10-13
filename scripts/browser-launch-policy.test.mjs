import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { isInstalledChrome, launchHeadless } from "./lib/headless-browser.mjs"

// Agents automate ONE browser here: puppeteer's chrome-headless-shell, through
// `scripts/lib/headless-browser.mjs`. This pins that as a SHAPE, because the rule had been broken by
// copy-paste for months with nothing on screen to say so: 114 call sites launched the full
// "Google Chrome for Testing.app" (a Dock flicker per launch — 187 in 40 minutes on 2026-10-11), four
// scripts launched the maintainer's installed Google Chrome outright, and both agent configs ran a
// chrome-devtools MCP whose default browser is that same installed Chrome.
//
// The scan reads the working tree, not `git ls-files`, so a new script fails here before it is committed.

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const HELPER = "scripts/lib/headless-browser.mjs"
const SELF = "scripts/browser-launch-policy.test.mjs"
const MCP_WRAPPER = "scripts/chrome-devtools-mcp.mjs"

const sources = fs
  .globSync(["scripts/**/*.{mjs,js,ts,mts}", "packages/*/src/**/*.{ts,tsx,mts,mjs}", "src/**/*.{ts,mts}", "board/**/*.{mjs,js}"], {
    cwd: root,
    exclude: (name) => name === "node_modules" || name === "dist",
  })
  .filter((file) => file !== SELF)
  .sort()
const read = (file) => fs.readFileSync(path.join(root, file), "utf8")
const offenders = (pattern, allowed = []) => sources.filter((file) => !allowed.includes(file) && pattern.test(read(file)))

test("the scan sees the tree it is meant to guard", () => {
  assert.ok(sources.length > 400, `only ${sources.length} source files matched — a glob has stopped matching`)
  assert.ok(sources.includes(HELPER) && sources.includes("scripts/shot.mjs"))
  assert.ok(sources.some((file) => file.endsWith(".e2e.test.ts")), "no e2e tests matched")
})

test("only the shared launcher holds puppeteer itself", () => {
  // The VALUE, however it is reached — `import puppeteer from`, `await import("puppeteer")`, or
  // `import("puppeteer").then((m) => m.default.launch(…))`, the one shape a search for `puppeteer.launch`
  // walks straight past. A type (`import("puppeteer").Page`, `import type`) is not a browser.
  // `ink-gaps.mjs` keeps it for `--browser=<ws endpoint>`, which re-attaches to a browser the same
  // task launched; the MCP wrapper only asks it where the headless shell is.
  const value = /^import\s+(?!type\b)[^;\n]*\bfrom\s+["']puppeteer(-core)?["']|await\s+import\(\s*["']puppeteer(-core)?["']\s*\)|import\(\s*["']puppeteer(-core)?["']\s*\)\s*\.then/m
  assert.deepEqual(offenders(value, [HELPER, MCP_WRAPPER, "scripts/ink-gaps.mjs"]), [], `launch through launchHeadless() from ${HELPER} instead`)
})

test("no second automation library arrives without the launcher's decisions", () => {
  const library = /\bfrom\s+["'](playwright(-core)?|@playwright\/test|selenium-webdriver|chrome-launcher|chrome-remote-interface)["']|import\(\s*["'](playwright(-core)?|@playwright\/test|selenium-webdriver|chrome-launcher|chrome-remote-interface)["']\s*\)/
  assert.deepEqual(offenders(library), [])
})

test("no automation names the installed Google Chrome", () => {
  // `src/browser.ts` is the PRODUCT opening the human's own browser for them, at their request
  // (`frizz --app`). It is not automation, and it is the only code here that may name that binary.
  const installed = /Google Chrome(?! for Testing)[^"'`\n]*\.app\b|\bCHROME_PATH\b|channel\s*:\s*["'`]chrome/
  assert.deepEqual(offenders(installed, ["src/browser.ts", "src/browser.test.ts", HELPER, MCP_WRAPPER]), [])
})

test("the launcher refuses a browser the caller names, and recognises an installed Chrome", async () => {
  await assert.rejects(launchHeadless({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" }), /executablePath/)
  await assert.rejects(launchHeadless({ channel: "chrome" }), /channel/)
  await assert.rejects(launchHeadless({ headless: false }), /headless/)
  await assert.rejects(launchHeadless({ colorScheme: "system" }), /colorScheme/)
  for (const installed of [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "/usr/bin/google-chrome-stable",
  ]) assert.ok(isInstalledChrome(installed), installed)
  for (const downloaded of [
    "/Users/x/.cache/puppeteer/chrome-headless-shell/mac_arm-150.0.7871.24/chrome-headless-shell-mac-arm64/chrome-headless-shell",
    "/Users/x/.cache/puppeteer/chrome/mac_arm-150.0.7871.24/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "/usr/bin/chromium",
  ]) assert.ok(!isInstalledChrome(downloaded), downloaded)
})

test("both agent configs run the chrome-devtools MCP through the wrapper that picks the browser", () => {
  // chrome-devtools-mcp with no --executablePath launches puppeteer's `chrome` channel: the installed Chrome.
  const claude = JSON.parse(read(".mcp.json")).mcpServers["chrome-devtools"]
  assert.deepEqual([claude.command, ...claude.args], ["node", MCP_WRAPPER])
  const codex = read(".codex/config.toml")
  assert.match(codex, /\[mcp_servers\.chrome-devtools\]\s*\ncommand = "node"\s*\nargs = \["scripts\/chrome-devtools-mcp\.mjs"\]/)
  for (const config of [read(".mcp.json"), codex]) assert.doesNotMatch(config, /npx|--autoConnect|--browserUrl|--wsEndpoint|--channel/)

  const wrapper = read(MCP_WRAPPER)
  for (const flag of ["--headless", "--isolated", "--executablePath="]) assert.ok(wrapper.includes(flag), `${MCP_WRAPPER} must pass ${flag}`)
  assert.match(wrapper, /executablePath\(\{ headless: "shell" \}\)/)
})
