import { createElement, useRef } from "react"
import { useInnerHtml } from "../lib/innerHtml.ts"
import { useLocalFileCodeLinks } from "../lib/localFileCode.ts"
import { useMermaidIslands } from "./CodexRichOutput.tsx"
import { useLightboxIslands } from "./Lightbox.tsx"

// Sanitized markdown dropped into its element, PLUS the post-render pass that tags an inline-code file
// reference the server confirms is real (lib/localFileCode.ts) — the decoration the transcript's own
// prose gets (ChatView's ProseHtml). Every card that shows a worker's prose goes through it: the
// question card (its context, a group heading, each option, the footnote and the recommendation
// caption), the done fence, the awaiting fence and the resting card's own body. A file a worker names
// in a handoff — `it's in \`cloudflare-ask.md\`` — is exactly the file the human is being asked to
// read; the question card was the last surface to get this (2026-08-25), and the done card the one
// after it, where the same reference sat as plain code beside a Mark-as-done button.
//
// A ```lightbox fence in that prose is drawn as the transcript draws it, as a gallery (useLightboxIslands),
// and a ```mermaid fence as its diagram (useMermaidIslands).
export function LinkedHtml({ as = "div", className, html }: { as?: "div" | "span"; className: string; html: string }) {
  const inner = useInnerHtml(html)
  const ref = useRef<HTMLElement>(null)
  useLocalFileCodeLinks(ref, html)
  const galleries = useLightboxIslands(ref, html)
  const diagrams = useMermaidIslands(ref, html)
  return (
    <>
      {createElement(as, { ref, className, dangerouslySetInnerHTML: inner })}
      {galleries}
      {diagrams}
    </>
  )
}
