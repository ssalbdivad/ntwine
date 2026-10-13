import { useContext, useMemo, useRef, type MouseEvent as ReactMouseEvent, type Ref } from "react"
import { useQuery } from "@tanstack/react-query"
import { ExternalLink } from "lucide-react"
import { projectRpc, rpc } from "../api/rpc.ts"
import { useLiveLocalFile } from "../hooks.ts"
import { useInnerHtml } from "../lib/innerHtml.ts"
import { openInHostEditor, openLocalPath, settleLocalFileOpen } from "../lib/local-file-links.ts"
import { embedded } from "../lib/embed.ts"
import { baseName, runExternalOpen } from "../lib/externalOpen.ts"
import { LOCAL_FILE_POLL_MS, highlightedSource, localFileQuery } from "../lib/localFileQuery.ts"
import { useLocalFileCodeLinks } from "../lib/localFileCode.ts"
import { MarkdownScopeContext, useMarkdownHtml, type MarkdownScope } from "../lib/useMarkdown.ts"
import { splitFrontmatter } from "../lib/frontmatter.ts"
import { isLocalMarkdownFile, localFileDir } from "../lib/markdownTargets.ts"
import { useIsMobile } from "../lib/mobile.ts"
import { CodeBody } from "./CodeBody.tsx"
import { useMermaidIslands } from "./CodexRichOutput.tsx"
import { useLightboxIslands } from "./Lightbox.tsx"
import { Sheet } from "./ui/Sheet.tsx"
import { SheetHeader } from "./ui/SheetHeader.tsx"

// The BUILT-IN FILE READER: a right side sheet (the same slide/backdrop family as the plan and
// ntwine-document drawers) showing a file that lives on disk — a `.md` rendered, anything else as
// highlighted source. Every link to one lands here instead of launching the desktop opener — a worker
// citing `AGENTS.md`, a backticked path that resolved to a file, an attached log — because throwing
// the user out of Ntwine into an editor to read two paragraphs is the wrong answer to "what does that
// file say?". It was Markdown-only until 2026-09-28, when every file the page can show at all came
// in-app (lib/localViewer.ts decides which).
//
// A Markdown file's own directory is passed as the render base, so its RELATIVE links
// (`./ARCHITECTURE.md`, `docs/x.md`, an image beside it) resolve to real paths — a doc that
// cross-references its neighbours is browsable, each link stacking another reader over this one.
// Content is a file on disk written by whoever wrote it, so it goes through the same allowlist
// sanitizer as every other prose surface.

export const FOOTER_STYLE = { paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }

// The desktop-opener escape hatch. Reading is the default now, but a file you want to EDIT still
// belongs in the editor, and this is the only affordance left that gets it there. It honours the
// `localFileOpener` setting, exactly as a click on the link used to — except for a picture (`image`),
// which goes to the OS's own viewer, as an image click always did: an editor is no place to look at a
// screenshot. Exported because the /full page's split FileViewerPanel and the picture viewer are the
// same escape in different frames and must not fork this. `onOpen` runs first — the picture viewer
// closes itself there, since the answer can be a toast and a toast sits below every modal layer.
// `project` opens through that project rather than the page's, for a file cited on its card.
//
// IN AN EDITOR'S SIDEBAR (lib/embed.ts) everything opens in that editor's window, a picture too, and the
// button's title says so. The OS's viewer is on the machine running Ntwine, which under Remote-SSH has no
// display at all — while VS Code previews PNG, JPG, GIF, WebP and SVG itself — and a Markdown file opens
// there as much as source, since Open is how a file gets EDITED.
export function OpenAction({ path, image, project, onOpen, className = "" }: { path: string; image?: boolean; project?: string; onOpen?: () => void; className?: string }) {
  const inEditor = embedded()
  const open = () => {
    onOpen?.()
    if (inEditor) {
      openInHostEditor(path)
      return
    }
    void runExternalOpen(
      `file:${path}`,
      `Opening ${baseName(path)}…`,
      () => (project ? projectRpc(project) : rpc).openLocalFile({ path, ...(image ? { image: true } : {}) }),
      settleLocalFileOpen,
      (message) => `Could not open local file: ${message}`,
    )
  }
  return (
    <button
      type="button"
      onClick={open}
      onMouseDown={(e) => e.preventDefault()}
      className={`flex items-center gap-1.5 rounded-md border border-border-strong bg-panel-2/60 px-2.5 py-1 text-[12px] font-medium text-fg/80 outline-none transition-colors hover:bg-panel-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60 ${className}`}
      title={inEditor ? `Open ${path} in this window` : `Open ${path} outside Ntwine`}
      aria-label="Open"
    >
      <ExternalLink size={12} aria-hidden="true" /> Open
    </button>
  )
}

// The document's frontmatter is YAML, so render it through the same grammar and token palette as a
// `.yaml` source file. CodeBody keeps the text byte-for-byte while the pre preserves nesting/indentation;
// the former hand-rolled "text before the first colon is a key" treatment flattened both.
export function Frontmatter({ source }: { source: string }) {
  return (
    <CodeBody
      text={source}
      language="yaml"
      className="mb-4 whitespace-pre-wrap break-words rounded-md border border-border/60 bg-panel-2/40 px-3 py-2 font-mono-keep text-[12px] leading-5 text-muted"
    />
  )
}

// A file's text, verbatim and highlighted — the reader's view of anything that is not Markdown, and the
// /full viewer's Source view of everything. Highlighted through the same hljs pipeline as every
// transcript code body (lib/codeBody), the grammar picked from the filename and memoised across mounts
// (highlightedSource). The invariant codeBody.test pins — highlighted markup carries the SAME TEXT — is
// what keeps the /full viewer's ⌘I char-offset walk exact over the added spans, which is why `ref`
// reaches the <pre>. `hljs` on the element is what the palette hangs off (styles.css).
export function SourceView({ path, raw, ref }: { path: string; raw: string; ref?: Ref<HTMLPreElement> }) {
  const html = useInnerHtml(useMemo(() => highlightedSource(path, raw), [path, raw]))
  return (
    <pre
      ref={ref}
      className="hljs whitespace-pre-wrap break-words bg-transparent font-mono-keep text-[12px] leading-5 text-fg/90"
      style={{ tabSize: 2 }}
      dangerouslySetInnerHTML={html}
    />
  )
}

// `openable` is false where there is no Open to point at (the reader on a phone, below).
export function TruncatedNote({ openable = true }: { openable?: boolean }) {
  return (
    <p className="mt-4 border-t border-border/60 pt-3 text-[12px] text-muted">
      This file is too long to render in full — everything above the cut is shown.{openable ? " Open it to read the rest." : ""}
    </p>
  )
}

type ReaderProps = { id: number; path: string; title: string; depth: number; widthDepth: number }

// `scope` is set when the file was cited on ANOTHER project's card on the everything page
// (pushFileReader): the reader then renders and reads as that project's, exactly as the card did — its
// repo for `#123`, its gate for the read, which admits its own checkout wherever that lives.
export function FileReaderDrawer({ scope, ...props }: ReaderProps & { scope?: MarkdownScope }) {
  const outer = useContext(MarkdownScopeContext)
  return (
    <MarkdownScopeContext.Provider value={scope ?? outer}>
      <FileReader {...props} />
    </MarkdownScopeContext.Provider>
  )
}

function FileReader({ id, path, title, depth, widthDepth }: ReaderProps) {
  const scope = useContext(MarkdownScopeContext)
  // ON A PHONE THERE IS NO OPEN (upstream db0e7568, "the reader's Open footer is not shown on the phone").
  // Its Open launches the file on the machine Ntwine runs on — the desktop opener, or the Local file links app —
  // which from a phone is somewhere else entirely: the tap did nothing anyone holding the phone could
  // see. The phone routes every file here for exactly that reason (lib/local-file-links.ts openLocalPath),
  // so the reader is the end of the line there, and a button that leads off it is a dead end.
  const phone = useIsMobile()
  const project = scope?.projectId
  // The same read (and key) as the /full split viewer, and LIVE the same way: the server watches the
  // file while this drawer is open and the socket invalidates the query on each save; the poll covers
  // a socket that is not up (useLiveLocalFile) — and another project's file, which the page's socket
  // may not be allowed to watch.
  const live = useLiveLocalFile(path)
  const body = useQuery({ ...localFileQuery(path, project), refetchInterval: live && !project ? false : LOCAL_FILE_POLL_MS })
  const markdown = isLocalMarkdownFile(path)
  // Base the relative links on the CANONICAL path the server resolved, not the one that was clicked:
  // a link through a symlinked directory would otherwise rebase its neighbours onto a directory the
  // gate never admitted, and every one of them would 404.
  const resolved = body.data?.path ?? path
  const raw = body.data?.markdown ?? ""
  // Frontmatter is shown as metadata, not rendered as prose — see lib/frontmatter.ts for the heading
  // it became otherwise. It opens every MDX blog post and every skill file, so this is the common case.
  // Only a Markdown file is parsed at all: running a `.ts` file through the Markdown pipeline to throw
  // the result away would be the drawer's single most expensive step.
  const { front, body: source } = splitFrontmatter(markdown ? raw : "")
  const baseDir = localFileDir(resolved)
  const html = useMarkdownHtml(source, { baseDir, asDocument: true })
  const inner = useInnerHtml(html)
  const ref = useRef<HTMLDivElement>(null)
  useLocalFileCodeLinks(ref, html)
  // A report's ```lightbox fence is a gallery here too, its relative paths resolved against the
  // document's own directory like its links.
  const galleries = useLightboxIslands(ref, html, baseDir)
  // And its ```mermaid fence a diagram (upstream 9ba8a364).
  const diagrams = useMermaidIslands(ref, html)
  // A link inside another project's document is that project's too: follow it with the same scope,
  // before the page-wide interceptor (lib/local-file-links.ts) reads it as the page's.
  const followScoped = scope
    ? (event: ReactMouseEvent<HTMLDivElement>) => {
        if (event.button !== 0) return
        const link = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-local-path]") : null
        const target = link?.dataset.localPath
        if (!link || !target) return
        event.preventDefault()
        event.stopPropagation()
        openLocalPath(target, link, scope)
      }
    : undefined

  return (
    <Sheet id={id} depth={depth} widthDepth={widthDepth}>
      {(close) => (
        <>
          {/* No leading icon, like every other SUBTITLED sheet here (plan, ntwine-doc). SheetHeader centers
              an icon on the whole title+subtitle block, so beside a two-line header a 14px glyph measured
              7.00px below the title's cap band and read as floating between the lines. The basename is the
              title and the path is the subtitle; neither needs a glyph to say "file". */}
          <SheetHeader title={title} subtitle={resolved} onClose={close} />
          <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4" onClickCapture={followScoped}>
            {body.isLoading ? (
              <div className="text-[13px] text-muted">Loading…</div>
            ) : body.error ? (
              // The gate's own words — "outside Ntwine's trusted roots", "is not a text file" — say more
              // than a generic failure would, and (off a phone) the footer still offers the desktop opener.
              <div className="text-[13px] text-danger-90">Couldn’t read this file: {(body.error as Error).message}</div>
            ) : markdown && html ? (
              <>
                {front && <Frontmatter source={front} />}
                <div ref={ref} className="md-body" dangerouslySetInnerHTML={inner} />
                {galleries}
                {diagrams}
                {body.data?.truncated && <TruncatedNote openable={!phone} />}
              </>
            ) : !markdown && raw ? (
              <>
                <SourceView path={resolved} raw={raw} />
                {body.data?.truncated && <TruncatedNote openable={!phone} />}
              </>
            ) : (
              <div className="text-[13px] text-muted">This file is empty.</div>
            )}
          </div>
          {/* The safe-area pad the footer carried stays when the footer goes, so on a phone the last line
              still clears the home indicator. */}
          {phone ? (
            <div aria-hidden className="shrink-0" style={{ height: "env(safe-area-inset-bottom)" }} />
          ) : (
            <div
              data-file-reader-footer
              className="shrink-0 flex items-center justify-end gap-1.5 border-t border-border/60 bg-panel px-5 pt-3"
              style={FOOTER_STYLE}
            >
              <OpenAction path={resolved} project={project} />
            </div>
          )}
        </>
      )}
    </Sheet>
  )
}
