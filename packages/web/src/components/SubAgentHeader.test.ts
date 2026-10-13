import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { SheetHeader } from "./ui/SheetHeader.tsx"

// SubAgentHeader was folded into the shared <SheetHeader> (SubAgentSheet now renders
// `<SheetHeader title={label} onClose={…} />`). This retargeted regression keeps the original
// contract: the sub-agent drawer header names the WORK only — no model/effort profile, no runtime
// state (those live on the dispatch row that opens the drawer).
test("the sub-agent drawer header names the work without repeating profile or runtime state", () => {
  const html = renderToStaticMarkup(createElement(SheetHeader, {
    title: "Complete GVS fix differential repro",
    onClose: () => undefined,
  }))

  assert.match(html, /Complete GVS fix differential repro/)
  assert.match(html, /aria-label="Close"/)
  assert.doesNotMatch(html, /ntwine:opus-xhigh/)
  assert.doesNotMatch(html, /running|stale|finished|unavailable/)
})
