import { useEffect, useRef } from "react"
import { useSnapshot } from "valtio"
import { useQuery } from "@tanstack/react-query"
import { store } from "../store.ts"
import { rpc } from "../api/rpc.ts"
import { useInnerHtml } from "../lib/innerHtml.ts"
import { stripFrontmatter } from "../lib/markdown.ts"
import { useMarkdownHtml } from "../lib/useMarkdown.ts"
import { useMermaidIslands } from "./CodexRichOutput.tsx"
import { Sheet } from "./ui/Sheet.tsx"
import { SheetHeader } from "./ui/SheetHeader.tsx"

// The ntwine-document drawer: a RIGHT side sheet (same slide/backdrop family as settings and the
// Open-thread sheet — nothing renders as a centered dialog) showing the thread's .ntwine/<slug>.md body
// — the Goal / Status / Decisions / Next-step contract — as markdown. Content is agent-written and
// thus only semi-trusted — rendered through the shared allowlist sanitizer (lib/markdown.ts). Read-only:
// a session-less thread (runtime "none") opens here because its doc IS the substance. (A composer pinned
// under the doc started a worker on the file — cold adoption, removed 2026-10-14.)
export function ThreadDrawer({ id, slug, title, depth, widthDepth }: { id: number; slug: string; title: string; depth: number; widthDepth: number }) {
  const body = useQuery({
    queryKey: ["threadBody", slug],
    queryFn: () => rpc.threadBody({ slug }),
  })

  // The thread file changes underneath us as the agent works; every board push (SSE) is a cheap
  // signal to re-read it while the drawer is open.
  const snap = useSnapshot(store)
  useEffect(() => {
    body.refetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.board])

  const html = useMarkdownHtml(stripFrontmatter(body.data?.markdown ?? ""))
  const inner = useInnerHtml(html)
  // A ```mermaid fence in the thread's document is a diagram, as in every other reader.
  const docRef = useRef<HTMLDivElement>(null)
  const diagrams = useMermaidIslands(docRef, html)

  return (
    // A3 fix: the doc is a "flip" surface of the CHAT drawer for the SAME thread, not a genuine extra
    // stack layer — so it must not read as a narrower stacked overlay (the bug: opened over the chat
    // drawer it landed at depth+1 → 692px vs the chat's 720px). `widthOffset={1}` renders it at the
    // width of the drawer BENEATH it (depth-1) so it matches the chat drawer exactly; at depth 0 (a
    // runtime-none thread opened straight to its doc, nothing beneath) it's the base 720px. Preferred
    // long-term fix per the audit was a real Chat|Terminal tab strip, deferred this pass: the thread
    // header carries no tabs at all since 2026-08-06 (see ChatView.ThreadView) and the runtime-none entry
    // path — a design call left for the maintainer.
    <Sheet id={id} depth={depth} widthDepth={widthDepth} widthOffset={1} subagentParent={slug}>
      {(close) => (
        <>
          <SheetHeader title={title} subtitle={`${slug}.md`} onClose={close} />
          <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
            {body.isLoading ? (
              <div className="text-[13px] text-muted">Loading…</div>
            ) : html ? (
              <>
                <div ref={docRef} className="md-body" dangerouslySetInnerHTML={inner} />
                {diagrams}
              </>
            ) : (
              <div className="text-[13px] text-muted">No thread file found.</div>
            )}
          </div>
        </>
      )}
    </Sheet>
  )
}

// (The local marked/sanitize/stripFrontmatter copies were deleted — lib/markdown.ts is the one
// sanitizer pipeline; a review pass flagged the ~45-line duplication.)
