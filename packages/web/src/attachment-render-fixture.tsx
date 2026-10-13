import { createRoot } from "react-dom/client"
import "./styles.css"
import { splitProseAttachments } from "./lib/imagePaths.ts"
import { mdToHtml } from "./lib/markdown.ts"
import { BlockImage, BlockFile } from "./components/ChatView.tsx"
import { CodexDirectiveCard, MermaidDiagram } from "./components/CodexRichOutput.tsx"
import { LightboxGallery } from "./components/Lightbox.tsx"
import { installLocalFileLinkInterceptor } from "./lib/local-file-links.ts"

// Proves the transcript render half of the attachment feature end-to-end with the REAL components:
// a message whose body carries standalone absolute attachment paths splits (splitProseAttachments)
// into an inline <img> for the image and an openable file chip for each non-image doc — exactly the
// mapping ChatView performs. /local-image and /rpc/openLocalFile are stubbed so the fixture renders
// and the chip's click wiring (data-local-path → openLocalFile) can be asserted without a live stack.

// A 1x1 PNG for the /local-image route below.
//
// It does NOT make the pictures paint, and the comment here used to claim it did: an <img> load is not
// a `fetch`, so the stub underneath never sees it. Under plain Vite the route 404s, both images fail,
// and each falls back to its plain path — BlockImage through its own `broken` state, the Markdown one
// through the delegated handler in lib/local-file-links.ts. That is worth having (this page is where
// the two FALLBACKS are seen side by side, and it is how we know a broken Markdown image takes its
// frame down with it instead of leaving an empty bordered box). But it means the FRAMES themselves
// cannot be judged here — for that, drive a real stack, where /local-image serves real files.
const PNG_1x1 = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0))

const nativeFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.href)
  if (url.pathname === "/_ntwine/local-image") {
    return new Response(PNG_1x1, { headers: { "content-type": "image/png" } })
  }
  if (url.pathname === "/_ntwine/rpc/openLocalFile") {
    ;(window as Window & { __openedLocalPath?: string }).__openedLocalPath =
      JSON.parse((init?.body as string) ?? "{}").path
    return new Response(JSON.stringify({ result: { action: "opened", path: "opened" } }), {
      headers: { "content-type": "application/json", "x-ntwine-boot": "attach-fixture" },
    })
  }
  return nativeFetch(input, init)
}

// Covers: intro prose, an attached image (inline) + pdf + svg (chips), AND a fenced code block whose
// body contains standalone absolute paths — those must stay INSIDE the code block, never become chips.
//
// It also puts the two ways a worker can show a picture beside each other: the bare PATH, which
// ChatView renders as a <BlockImage>, and the MARKDOWN `![](…)`, which goes down the sanitizer's own
// path instead (lib/markdown.ts) and builds the same frame out of ImageFrame's exported class strings.
// A markdown image is NOT a standalone path, so splitProseAttachments leaves it in the prose. Here they
// are seen as their two FALLBACKS (see the PNG note above); the frames themselves need a real stack.
const message = [
  "Please review these attachments before we start.",
  "/tmp/ntwine-att/spec-notes.pdf",
  "/tmp/ntwine-att/diagram.png",
  "/tmp/ntwine-att/logo.svg",
  "And the same picture again, written as Markdown rather than as a bare path:",
  "![the same diagram, via markdown](/tmp/ntwine-att/diagram.png)",
  "Here is the file listing I ran:",
  "```",
  "/Users/foo/project/src/main.rs",
  "/Users/foo/project/README.md",
  "```",
  "That's everything.",
].join("\n")

installLocalFileLinkInterceptor()
createRoot(document.getElementById("root")!).render(
  <main className="mx-auto max-w-xl p-8">
    <p className="mb-4 text-sm text-muted">Attachment render fixture — image inline, docs as chips, code fences intact</p>
    <div className="flex flex-col gap-2">
      {splitProseAttachments(message).map((part, i) =>
        part.kind === "image" ? <BlockImage key={i} path={part.path} />
        : part.kind === "file" ? <BlockFile key={i} path={part.path} />
        : part.kind === "visualization" ? <code key={i}>{`::codex-inline-vis{file="${part.file}"}`}</code>
        : part.kind === "directive" ? <CodexDirectiveCard key={i} directive={part.directive} />
        : part.kind === "mermaid" ? <MermaidDiagram key={i} source={part.source} />
        : part.kind === "lightbox" ? <LightboxGallery key={i} entries={part.entries} />
        : <div key={i} className="md-body" dangerouslySetInnerHTML={{ __html: mdToHtml(part.text) }} />,
      )}
    </div>
  </main>,
)
