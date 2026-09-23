import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

test("every rendered image sits in the one frame: border, inset mat, centered picture", () => {
  const source = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8")
  const frame = readFileSync(new URL("./ImageFrame.tsx", import.meta.url), "utf8")
  const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8")
  const blockImage = source.match(/export function BlockImage[\s\S]*?\n}\n/)?.[0]
  const imageFrame = frame.match(/export function ImageFrame[\s\S]*?\n}\n/)?.[0]
  const markdownImage = styles.match(/\.md-body img\[data-local-path\] \{[\s\S]*?\n\}/)?.[0]

  assert.ok(blockImage, "BlockImage source should remain discoverable")
  assert.match(blockImage, /data-local-image="true"/)
  // Prose paths, tool screenshots, deliveries and attachments all reach the picture through ONE element.
  assert.match(blockImage, /<ImageFrame\b/)
  assert.match(blockImage, /\bFRAMED_IMAGE\b/)

  assert.ok(imageFrame, "ImageFrame source should remain discoverable")
  // The frame's two boxes are CONSTANTS, not literals inlined in the JSX, because the Markdown path
  // builds the same frame out of them as an HTML string (see the next test). Assert the component
  // renders those constants rather than a second copy that could drift from the one Markdown uses.
  assert.match(imageFrame, /className=\{IMAGE_FRAME\}/)
  assert.match(imageFrame, /className=\{IMAGE_FRAME_MAT\}/)
  // The outer border + the tool-card typography, so a `frizz-bash-header` can ride inside the frame.
  assert.match(frame, /IMAGE_FRAME\s*=\s*"frizz-bash\b/)
  // The mat: a little inset padding, a step lighter than the card so a dark screenshot keeps an edge,
  // and the picture centered in it however narrow the picture is.
  assert.match(frame, /IMAGE_FRAME_MAT\s*=\s*"[^"]*\bjustify-center\b[^"]*\bbg-panel-2\b[^"]*\bp-1\.5\b/)
  // The picture never overflows the mat and never loses its aspect.
  assert.match(frame, /FRAMED_IMAGE\s*=\s*"[^"]*\bobject-contain\b/)
  assert.match(frame, /FRAMED_IMAGE\s*=\s*"[^"]*\bmax-w-full\b/)

  assert.ok(markdownImage, "Markdown screenshot styles should remain discoverable")
  assert.match(markdownImage, /display:\s*block/)
  assert.match(markdownImage, /margin-inline:\s*auto/)
})

// The half of "every rendered image" that lives outside React. A Markdown `![](…)` is sanitized into an
// HTML STRING, so it cannot render <ImageFrame> — it has to build the frame itself, and the only thing
// stopping the two from drifting is that it builds it from the SAME exported constants.
test("a Markdown image is framed from the same constants, in spans, only in block prose", () => {
  const markdown = readFileSync(new URL("../lib/markdown.ts", import.meta.url), "utf8")
  const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8")
  const frameImage = markdown.match(/function frameImage[\s\S]*?\n}\n/)?.[0]

  assert.ok(frameImage, "frameImage source should remain discoverable")
  assert.match(markdown, /import \{ FRAMED_IMAGE, IMAGE_FRAME, IMAGE_FRAME_MAT \} from "\.\.\/components\/ImageFrame\.tsx"/)
  assert.match(frameImage, /IMAGE_FRAME\b/, "the outer box comes from the component, not a copy")
  assert.match(frameImage, /IMAGE_FRAME_MAT\b/, "the mat comes from the component, not a copy")
  assert.match(frameImage, /FRAMED_IMAGE\b/, "the picture is sized by the component's own class")

  // SPANS. marked wraps every image in a `<p>`, and this HTML is re-parsed when a surface injects it —
  // a `<figure>` there is not phrasing content, so the parser would close the paragraph and split the
  // prose around the picture. Guard the element choice, since the failure is invisible in source review.
  assert.equal(frameImage.includes('createElement("figure")'), false, "a <figure> would split the paragraph")
  assert.equal(frameImage.includes('createElement("div")'), false, "a <div> would split the paragraph")
  assert.match(frameImage, /createElement\("span"\)[\s\S]*createElement\("span"\)/)
  // …which is why the frame needs a display the component's own classes never had to carry.
  assert.match(styles, /\.md-body \.md-image-frame \{[^}]*display:\s*block/)

  // Framing is BLOCK-prose only: the inline path drops its result into a one-line host (an answer chip,
  // a caption) that a block frame would burst.
  assert.match(markdown, /if \(block\) frameImage\(el\)/)
  // `parser` since the built-in `.md` reader added a second Marked instance (soft breaks for a FILE);
  // both go through this one call, so the block flag is still asserted on the single block path. The
  // parse is a thunk since a caller can name the GitHub repo to render as (`withGithubRepo`), so the
  // flag is asserted on mdToHtml's own sanitize rather than on one expression.
  const mdToHtml = markdown.match(/export function mdToHtml[\s\S]*?\n}\n/)?.[0]
  assert.ok(mdToHtml, "mdToHtml source should remain discoverable")
  assert.match(mdToHtml, /parser\.parse\(md, \{ async: false \}\) as string/)
  assert.match(mdToHtml, /sanitize\(html, \{ block: true[,}]/)
  assert.equal(/parseInline\([^)]*\)[^)]*\{[^}]*block: true/.test(markdown), false, "the inline path must not frame")
})

// A framed picture whose file is gone must not leave the frame behind advertising it.
test("a broken Markdown image takes its frame with it", () => {
  const links = readFileSync(new URL("../lib/local-file-links.ts", import.meta.url), "utf8")
  assert.match(links, /closest\("\.md-image-frame"\) \?\? img/)
})
