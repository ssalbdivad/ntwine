import { test } from "node:test"
import assert from "node:assert/strict"
import { isLightboxVideo, lightboxImageFor, lightboxLabel, parseLightboxBody, resolveLightboxPath } from "./lightbox.ts"

test("a lightbox body is one picture per non-blank line, in order", () => {
  assert.deepEqual(parseLightboxBody("/tmp/a.png\n\n  /tmp/b.jpg  \n/tmp/c.webp\n"), [
    { target: "/tmp/a.png", caption: undefined },
    { target: "/tmp/b.jpg", caption: undefined },
    { target: "/tmp/c.webp", caption: undefined },
  ])
})

test("text after the path is its caption, with any leading separator or quotes stripped", () => {
  const lines = [
    "/tmp/a.png Before the fix",
    "/tmp/a.png    Before the fix",
    "/tmp/a.png — Before the fix",
    "/tmp/a.png - Before the fix",
    "/tmp/a.png | Before the fix",
    "/tmp/a.png: Before the fix",
    "/tmp/a.png—Before the fix",
    '/tmp/a.png "Before the fix"',
  ]
  for (const line of lines) {
    assert.deepEqual(parseLightboxBody(line), [{ target: "/tmp/a.png", caption: "Before the fix" }], line)
  }
})

test("a path with spaces ends at its image extension, not at its first space", () => {
  assert.deepEqual(parseLightboxBody("/Users/me/Desktop/Screen Shot 2026-10-02 at 1.23.45 PM.png  The settings page"), [
    { target: "/Users/me/Desktop/Screen Shot 2026-10-02 at 1.23.45 PM.png", caption: "The settings page" },
  ])
  assert.deepEqual(parseLightboxBody("/Users/me/My Project/shot.JPEG"), [
    { target: "/Users/me/My Project/shot.JPEG", caption: undefined },
  ])
})

test("backticked paths, list items and Markdown images are all accepted", () => {
  assert.deepEqual(parseLightboxBody("`/tmp/a b.png` After"), [{ target: "/tmp/a b.png", caption: "After" }])
  assert.deepEqual(parseLightboxBody("- /tmp/a.png\n* /tmp/b.png\n1. /tmp/c.png Third\n2) /tmp/d.png"), [
    { target: "/tmp/a.png", caption: undefined },
    { target: "/tmp/b.png", caption: undefined },
    { target: "/tmp/c.png", caption: "Third" },
    { target: "/tmp/d.png", caption: undefined },
  ])
  assert.deepEqual(parseLightboxBody("![Before the fix](/tmp/a.png)"), [{ target: "/tmp/a.png", caption: "Before the fix" }])
  assert.deepEqual(parseLightboxBody("![](</tmp/with space.png>)"), [{ target: "/tmp/with space.png", caption: undefined }])
  assert.deepEqual(parseLightboxBody('[After](/tmp/b.png "hover title")'), [{ target: "/tmp/b.png", caption: "After" }])
  assert.deepEqual(parseLightboxBody(String.raw`C:\Users\me\shot.png Windows`), [{ target: String.raw`C:\Users\me\shot.png`, caption: "Windows" }])
})

test("a video is a line like a picture: its path ends at its extension, and a caption may follow", () => {
  assert.deepEqual(parseLightboxBody("/tmp/flow.webm  The whole flow\n/Users/me/Screen Recording 2026-10-03 at 1.02.03 PM.mov\n- /tmp/a.MP4: Mobile\n/tmp/b.m4v"), [
    { target: "/tmp/flow.webm", caption: "The whole flow" },
    { target: "/Users/me/Screen Recording 2026-10-03 at 1.02.03 PM.mov", caption: undefined },
    { target: "/tmp/a.MP4", caption: "Mobile" },
    { target: "/tmp/b.m4v", caption: undefined },
  ])
  const base = { dir: "/repo", home: "/Users/me" }
  assert.equal(resolveLightboxPath("shots/flow.webm", base), "/repo/shots/flow.webm")
  assert.equal(resolveLightboxPath("/tmp/a.MP4", base), "/tmp/a.MP4")
  // A format the browser cannot be counted on to play is not a video here; it stays a plain line.
  assert.equal(resolveLightboxPath("/tmp/a.avi", base), null)
  assert.equal(isLightboxVideo("/tmp/flow.webm"), true)
  assert.equal(isLightboxVideo("/tmp/a.MOV"), true)
  assert.equal(isLightboxVideo("/tmp/a.png"), false)
})

test("a line naming no image keeps the whole line, so the gallery can show what it could not draw", () => {
  assert.deepEqual(parseLightboxBody("/tmp/diagram.svg\nhttps://example.com/a.png?raw=1"), [
    { target: "/tmp/diagram.svg" },
    { target: "https://example.com/a.png?raw=1" },
  ])
})

test("a target resolves to the absolute path the image proxy serves, against the project and home", () => {
  const base = { dir: "/repo", home: "/Users/me" }
  assert.equal(resolveLightboxPath("/tmp/a.png", base), "/tmp/a.png")
  assert.equal(resolveLightboxPath(".ntwine/threads/t1/after.png", base), "/repo/.ntwine/threads/t1/after.png")
  assert.equal(resolveLightboxPath("~/Desktop/a.png", base), "/Users/me/Desktop/a.png")
  assert.equal(resolveLightboxPath("file:///tmp/a.png", base), "/tmp/a.png")
  assert.equal(resolveLightboxPath(String.raw`C:\shots\a.png`, base), String.raw`C:\shots\a.png`)
  // Before the board arrives there is no base, and a relative path names nothing yet.
  assert.equal(resolveLightboxPath("shots/a.png", { dir: "", home: "" }), null)
})

test("only a LOCAL raster image resolves — remote URLs and non-image files never reach the proxy", () => {
  const base = { dir: "/repo", home: "/Users/me" }
  for (const target of ["https://example.com/a.png", "//cdn.example/a.png", "/tmp/diagram.svg", "/tmp/notes.pdf", "data:image/png;base64,AAAA"]) {
    assert.equal(resolveLightboxPath(target, base), null, target)
  }
})

test("a picture is labelled by its caption, else by its file name", () => {
  assert.deepEqual(lightboxLabel({ target: "/tmp/a.png", caption: "Before" }, "/tmp/a.png"), { label: "Before", captioned: true })
  assert.deepEqual(lightboxLabel({ target: "/tmp/shots/after.png" }, "/tmp/shots/after.png"), { label: "after.png", captioned: false })
  assert.deepEqual(lightboxLabel({ target: "shots/gone.png" }, null), { label: "gone.png", captioned: false })
  // A delivered picture's file is a hash-named cache copy: its title names it, and a caption still wins.
  assert.deepEqual(lightboxLabel({ target: "/c/465ab1.png", title: "The two pages" }, "/c/465ab1.png"), { label: "The two pages", captioned: true })
  assert.deepEqual(lightboxLabel({ target: "/c/465ab1.png", caption: "Before", title: "The two pages" }, "/c/465ab1.png"), { label: "Before", captioned: true })
})

test("a picture drawn some other way is captioned by its alt text, unless the alt only names the file", () => {
  // `![The settings page](/tmp/s.png)`.
  assert.deepEqual(lightboxImageFor("/tmp/s.png", " The settings page "), { path: "/tmp/s.png", label: "The settings page", captioned: true })
  // A bare picture line: BlockImage's alt is the basename.
  assert.deepEqual(lightboxImageFor("/tmp/shots/s.png", "s.png"), { path: "/tmp/shots/s.png", label: "s.png", captioned: false })
  // `![](~/shots/s.png)`: the sanitizer fills an empty alt with the path as written.
  assert.deepEqual(lightboxImageFor("/Users/me/shots/s.png", "~/shots/s.png"), { path: "/Users/me/shots/s.png", label: "s.png", captioned: false })
  assert.deepEqual(lightboxImageFor("/tmp/s.png", ""), { path: "/tmp/s.png", label: "s.png", captioned: false })
  assert.deepEqual(lightboxImageFor("/tmp/s.png", null), { path: "/tmp/s.png", label: "s.png", captioned: false })
  // A tool's picture card: served from a hash-named cache copy, called by the file it was a copy of.
  assert.deepEqual(lightboxImageFor("/tmp/ntwine-tool-images-ab/9f2c.png", "Read: shots/board.png"), {
    path: "/tmp/ntwine-tool-images-ab/9f2c.png",
    label: "board.png",
    captioned: false,
  })
})
