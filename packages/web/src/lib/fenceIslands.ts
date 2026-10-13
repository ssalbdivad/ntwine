import { useLayoutEffect, useRef, useState, type RefObject } from "react"

// One fence a surface draws as a component instead of code: the element standing where its code block
// stood, what the fence's body parsed to, and a key that stays with the host for as long as it lives.
export interface FenceIsland<T> {
  key: string
  host: HTMLElement
  body: string
  value: T
}

let nextIsland = 0

/**
 * The fences of ONE language inside a block of rendered Markdown, each swapped for an empty host element
 * a component can be portalled into — for every surface that renders a worker's Markdown as ONE string
 * of sanitized HTML rather than through the transcript's splitter: the done and awaiting cards, a
 * question's options, the `.md` readers. There a fence is only a highlighted code block that kept its
 * NAME as a class (`language-lightbox`, `language-mermaid` — lib/syntaxHighlight.ts renderHighlightedCode);
 * this finds each one after the HTML lands and replaces it. The sanitizer learns no new tag, and what is
 * drawn is the transcript's own component rather than a lookalike built from markup.
 *
 * The two callers are useLightboxIslands (components/Lightbox.tsx) and useMermaidIslands
 * (components/CodexRichOutput.tsx); each maps the returned islands to portals.
 *
 * A QUOTED fence never matches: nested inside a longer fence it is part of that block's text, and the
 * block carries the outer fence's name.
 *
 * Rescans whenever the markup OR the element changes: a host that remounts its element with the same
 * markup (the split viewer's Rendered/Source toggle) gets fresh, unscanned HTML from React. The markup
 * itself is only rewritten when it changes (lib/innerHtml.ts), which is what keeps the hosts in place
 * between scans.
 *
 * When the markup DOES change, a fence whose body did not keeps its host, and so its mounted component:
 * the old host is moved into the new markup rather than a new one made. A reader re-renders its whole
 * document on every save of the file (MarkdownDrawer and FileViewerPanel are live), and a diagram that
 * remounted each time would fall back to its placeholder and re-render, and a gallery would re-request
 * its pictures, for an edit three paragraphs away.
 */
export function useFenceIslands<T>(
  ref: RefObject<HTMLElement | null>,
  html: string,
  language: string,
  hostClass: string,
  parse: (body: string) => T,
): FenceIsland<T>[] {
  const [islands, setIslands] = useState<FenceIsland<T>[]>([])
  const scanned = useRef<{ root: HTMLElement | null; html: string } | null>(null)
  useLayoutEffect(() => {
    const root = ref.current
    if (scanned.current && scanned.current.root === root && scanned.current.html === html) return
    scanned.current = { root, html }
    const spare = [...islands]
    const found: FenceIsland<T>[] = []
    for (const code of root?.querySelectorAll<HTMLElement>(`pre > code.language-${language}`) ?? []) {
      const block = code.closest(".md-code") ?? code.parentElement!
      const body = code.textContent ?? ""
      const kept = spare.findIndex((island) => island.body === body)
      let island: FenceIsland<T>
      if (kept >= 0) {
        island = spare.splice(kept, 1)[0]
      } else {
        const host = document.createElement("div")
        host.className = hostClass
        island = { key: `${language}-${++nextIsland}`, host, body, value: parse(body) }
      }
      block.replaceWith(island.host)
      found.push(island)
    }
    setIslands((prev) => (prev.length === 0 && found.length === 0 ? prev : found))
  })
  return islands
}
