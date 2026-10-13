import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { BlockFile, BlockImage } from "./components/ChatView.tsx"
import { DrawerStack } from "./components/DrawerStack.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { initFont } from "./lib/font.ts"
import { installLocalFileLinkInterceptor } from "./lib/local-file-links.ts"
import { mdToHtml } from "./lib/markdown.ts"
import { openImageViewer, pushFileReader, store } from "./store.ts"
import "./styles.css"

// The picture viewer and the file reader on the REAL drawer stack, opened by real clicks through the
// real delegated interceptor — every way a worker puts a picture or a file in front of the reader: the
// bare path (BlockImage), Markdown `![](…)`, a Markdown LINK to a picture, and the chips for an SVG, a
// log and a PDF. Two cards, because a picture's gallery must stop at its own card, and a reader drawer
// whose document holds a picture, because Escape must close the viewer and leave that drawer standing.
//
// An <img> load is not a `fetch`, so the pictures themselves are served by the e2e test's request
// interception (real screenshots it takes first); the RPCs below are stubbed here.
initFont()
// Dark unless asked otherwise — the palette most sessions run in, and the one a dark screenshot has to
// keep its edges against.
const theme = new URLSearchParams(location.search).get("theme") === "light" ? "light" : "dark"
document.documentElement.dataset.theme = theme
document.documentElement.style.colorScheme = theme

// Dark strokes on NOTHING — the common shape of an agent's SVG, and the one a dark stage would swallow.
const SVG = [
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 120" width="240" height="120">`,
  `<rect x="10" y="10" width="90" height="40" rx="6" fill="none" stroke="#1f2328" stroke-width="2"/>`,
  `<text x="55" y="35" font-family="sans-serif" font-size="12" text-anchor="middle" fill="#1f2328">worker</text>`,
  `<rect x="140" y="70" width="90" height="40" rx="6" fill="none" stroke="#1f2328" stroke-width="2"/>`,
  `<text x="185" y="95" font-family="sans-serif" font-size="12" text-anchor="middle" fill="#1f2328">ntwine</text>`,
  `<path d="M100 30 C 130 30, 150 50, 185 70" fill="none" stroke="#1f2328" stroke-width="2"/>`,
  `<script>document.title = "svg script ran"</script>`,
  `</svg>`,
].join("")
// No width or height at all — Chrome calls this 300×150 whatever the viewBox says; it is a 64px square.
const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="26" fill="none" stroke="#1f2328" stroke-width="4"/></svg>`
const LOG = [
  "12:00:01.114 ntwine  booting server (pid 48213)",
  "12:00:01.402 ntwine  listening on http://127.0.0.1:4321",
  "12:00:02.018 worker dispatched thread image-viewer (claude-opus-5-5, xhigh)",
  '12:00:09.771 worker tool Read {"file_path":"/tmp/shot-wide.png"}',
  "12:00:10.003 worker rested — awaiting review",
].join("\n")
const DOC = "# Review notes\n\nThe shot the worker attached:\n\n![the attached shot](/fixture/in-doc.png)\n\nThat is all."

type Opened = { path: string; image?: boolean }
const opened: Opened[] = []
;(window as unknown as { __imageViewerFixture: unknown }).__imageViewerFixture = {
  opened,
  // For the measuring scripts (scripts/ink-gaps.mjs --before), which cannot serve the raster pictures:
  // an SVG opened among other paths still draws the whole header — name, readout, counter, Open, close.
  open: (path: string, gallery: string[]) => openImageViewer(path, gallery),
  viewer: () => (store.imageViewer ? { paths: [...store.imageViewer.paths], index: store.imageViewer.index } : null),
  drawers: () => store.drawers.map((d) => ({ kind: d.kind, path: d.path, closing: !!d.closing })),
}

const nativeFetch = window.fetch.bind(window)
const json = (result: unknown) => new Response(JSON.stringify({ result }), { headers: { "content-type": "application/json" } })
window.fetch = async (request, init) => {
  const url = new URL(typeof request === "string" ? request : request instanceof URL ? request.href : request.url, location.href)
  if (!url.pathname.startsWith("/_ntwine/rpc/")) return nativeFetch(request, init)
  const name = url.pathname.slice("/_ntwine/rpc/".length)
  const raw = url.searchParams.get("input") ?? (typeof init?.body === "string" ? init.body : "{}")
  const input = JSON.parse(raw) as { path?: string; image?: boolean }
  const path = input.path ?? ""
  if (name === "localFile" && path.endsWith("/icon.svg")) return json({ path, text: ICON, truncated: false })
  if (name === "localFile" && path.endsWith(".svg")) return json({ path, text: SVG, truncated: false })
  if (name === "localFile" && path.endsWith(".log")) return json({ path, text: LOG, truncated: false })
  if (name === "localMarkdown") return json({ path, markdown: DOC, truncated: false })
  if (name === "openLocalFile") {
    opened.push(input as Opened)
    return json({ action: "opened", path })
  }
  return json({})
}

const prose = (md: string) => <div className="md-body" dangerouslySetInnerHTML={{ __html: mdToHtml(md) }} />

installLocalFileLinkInterceptor()
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <TooltipProvider>
      <main className="mx-auto flex min-h-screen max-w-[720px] flex-col gap-6 bg-bg p-6 text-fg">
        <section data-queue-card="thread-a" className="flex flex-col gap-3.5 rounded-lg border border-border bg-panel p-4">
          {prose("The board before the fix, as the worker's screenshot tool returned it:")}
          <BlockImage path="/fixture/shot-wide.png" />
          <BlockImage path="/fixture/shot-small.png" />
          {prose("And after, written as Markdown:\n\n![after the fix](/fixture/md-shot.png)\n\nThe raw capture is [linked here](/fixture/linked.png).")}
          <BlockImage path="/fixture/shot-tall.png" />
          <BlockFile path="/fixture/diagram.svg" />
          <BlockFile path="/fixture/icon.svg" />
          <BlockFile path="/fixture/run.log" />
          <BlockFile path="/fixture/contract.pdf" />
        </section>
        <section data-queue-card="thread-b" className="flex flex-col gap-3.5 rounded-lg border border-border bg-panel p-4">
          {prose("A different thread's card:")}
          <BlockImage path="/fixture/other-card.png" />
          <button type="button" data-open-doc onClick={() => pushFileReader("/fixture/review.md")} className="self-start rounded-md border border-border px-2 py-1 text-[12px]">
            Open the review notes
          </button>
        </section>
      </main>
      <DrawerStack />
    </TooltipProvider>
  </QueryClientProvider>,
)
