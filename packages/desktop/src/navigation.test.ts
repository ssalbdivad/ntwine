import { test } from "node:test"
import assert from "node:assert/strict"
import { appPath, classifyNavigation, startAddress } from "./navigation.ts"

const origin = "http://127.0.0.1:9393"

test("the board's own origin stays in the app; the web goes to the OS browser", () => {
  assert.equal(classifyNavigation(`${origin}/project/frizz/thread/fix/full`, origin), "app")
  assert.equal(classifyNavigation("https://github.com/colinhacks/frizz/pull/36", origin), "external")
  assert.equal(classifyNavigation("mailto:someone@example.com", origin), "external")
  // Another local server is somebody else's page — a dev server a worker linked — not the board.
  assert.equal(classifyNavigation("http://127.0.0.1:5173/", origin), "external")
  assert.equal(classifyNavigation("http://localhost:9393/", origin), "external")
})

test("worker-written links with any other scheme are dropped, not launched", () => {
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", "vscode://file/tmp/x", "data:text/html,hi", "not a url"]) {
    assert.equal(classifyNavigation(url, origin), "blocked", url)
  }
})

test("before a server is found nothing is in-app, but external links still route", () => {
  assert.equal(classifyNavigation(`${origin}/`, undefined), "external")
  assert.equal(classifyNavigation("file:///tmp", undefined), "blocked")
})

test("only an in-app path is remembered, without its origin", () => {
  assert.equal(appPath(`${origin}/project/zod?unknown=x#top`, origin), "/project/zod?unknown=x#top")
  assert.equal(appPath("https://github.com/", origin), undefined)
  assert.equal(appPath("data:text/html,x", origin), undefined)
})

test("a remembered path reopens on this launch's server, never on another host", () => {
  assert.equal(startAddress("/project/zod", "http://127.0.0.1:19393"), "http://127.0.0.1:19393/project/zod")
  assert.equal(startAddress(undefined, origin), `${origin}/`)
  assert.equal(startAddress("//evil.example/steal", origin), `${origin}/`)
  assert.equal(startAddress("https://evil.example/", origin), `${origin}/`)
})
