import { useRef } from "react"
import { createRoot } from "react-dom/client"
import "./styles.css"
import { CodexDirectiveCard } from "./components/CodexRichOutput.tsx"
import { DiffBlock } from "./components/DiffBlock.tsx"
import type { EditorWindowSummary, LocalFileOpener } from "@ntwine/shared"
import { resetExternalOpens } from "./lib/externalOpen.ts"
import { mdToHtml } from "./lib/markdown.ts"
import { installLocalFileLinkInterceptor } from "./lib/local-file-links.ts"
import { useLocalFileCodeLinks } from "./lib/localFileCode.ts"
import { useInnerHtml } from "./lib/innerHtml.ts"
import { store } from "./store.ts"

// Every destination a local-file link can have, on one page. A file Ntwine can show opens in Ntwine: a
// `.md` or any other text file in its reader (the interceptor pushes a `file` drawer and never calls
// the RPC), a picture in the picture viewer. A format the page cannot draw — the PDF here — is handed
// to the desktop opener through `openLocalFile`. The readouts below are what the e2e test asserts, so
// a regression in ANY direction — a Markdown or JSON link that launches an editor, a screenshot that
// opens a browser tab, a PDF that opens a reader that cannot render it — fails loudly rather than
// looking fine in the markup.
//
// The page also carries the two destinations a worker WRITES rather than spells out: a project-relative
// path and a home-anchored one. Both used to stay relative hrefs, which the browser resolved against
// the thread page — clicking a handoff link navigated to `/thread/<slug>/.ntwine/threads/<id>/HANDOFF.md`
// and out of the app. `baseDir`/`homeDir` are what useMarkdownHtml hands the renderer off the board.
const BASE_DIR = "/fixture"
const HOME_DIR = "/fixture/home"
type OpenBody = { path?: string; line?: number; column?: number; endLine?: number }
type FixtureWindow = Window & {
  __localFileFixtureOpened?: string[]
  // Every `openLocalFile` body whole — the line, column and range a link carried to the RPC.
  __localFileFixtureOpenBodies?: OpenBody[]
  // What a code file's click is settled by (lib/editorWindows.ts codeFilesDestination): the connected
  // editor windows, the Local file links value `settingsGet` answers, and whether the supervisor calls
  // this a remote session. The page reads the last two over the wire, so they are answered below.
  __localFileFixtureEditor?: (state: { windows?: EditorWindowSummary[]; opener?: LocalFileOpener; remote?: boolean }) => void
  __localFileFixtureResetOpens?: () => void
  // openOrRaiseDrawer RAISES a reader already open on the path, so a second click into the same file
  // adds no drawer; a step that reads "did the reader open" starts from none.
  __localFileFixtureCloseDrawers?: () => void
  __localFileFixtureDrawers?: () => { kind: string; path?: string }[]
  __localFileFixtureViewer?: () => { paths: string[]; index: number } | null
}

let fixtureOpener: LocalFileOpener = "system"
let fixtureRemote = false
const nativeFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.href)
  if (url.pathname === "/_ntwine/rpc/settingsGet") {
    return new Response(JSON.stringify({ result: { localFileOpener: fixtureOpener } }), { headers: { "content-type": "application/json" } })
  }
  if (url.pathname === "/_ntwine/control/status") {
    return new Response(JSON.stringify({ protocol: 1, state: "ready", remoteSession: fixtureRemote }), { headers: { "content-type": "application/json" } })
  }
  if (url.pathname === "/_ntwine/rpc/openLocalFile") {
    const body = JSON.parse(String(init?.body ?? "{}")) as OpenBody
    const w = window as FixtureWindow
    w.__localFileFixtureOpened = [...(w.__localFileFixtureOpened ?? []), body.path ?? ""]
    w.__localFileFixtureOpenBodies = [...(w.__localFileFixtureOpenBodies ?? []), body]
    return new Response(JSON.stringify({ result: { action: "copy", path: body.path } }), {
      headers: { "content-type": "application/json", "x-ntwine-boot": "local-file-fixture" },
    })
  }
  // Inline code resolves against the project directory server-side; here every candidate under `src/`
  // or named `App.tsx` is a file at the fixture root. The server is only ever asked for the BARE path —
  // a candidate arriving with its `:42` still on is answered "not a file", so a regression that stops
  // splitting it leaves the code inert and the e2e fails rather than passing on a lenient stub.
  if (url.pathname === "/_ntwine/rpc/resolveLocalPaths") {
    const { paths } = JSON.parse(url.searchParams.get("input") ?? "{}") as { paths: string[] }
    const resolved = paths.map((input) => ({ input, path: /^(?:src\/[\w.-]+\.ts|App\.tsx)$/.test(input) ? `/fixture/${input}` : null }))
    return new Response(JSON.stringify({ result: { resolved } }), { headers: { "content-type": "application/json" } })
  }
  return nativeFetch(input, init)
}

;(window as FixtureWindow).__localFileFixtureEditor = ({ windows, opener, remote }) => {
  if (windows) store.editorWindows = windows
  if (opener) fixtureOpener = opener
  if (remote !== undefined) fixtureRemote = remote
}
;(window as FixtureWindow).__localFileFixtureResetOpens = resetExternalOpens
;(window as FixtureWindow).__localFileFixtureCloseDrawers = () => { store.drawers.splice(0) }

// Prose whose inline code is decorated the way every transcript surface decorates it — rendered through
// the same hook, so the line a backticked `a.ts:12` names is stamped by the real code path.
function PositionedProse({ html }: { html: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const inner = useInnerHtml(html)
  useLocalFileCodeLinks(ref, html)
  return <div ref={ref} data-positioned className="md-body mt-6" dangerouslySetInnerHTML={inner} />
}

;(window as FixtureWindow).__localFileFixtureDrawers = () =>
  store.drawers.map((d) => ({ kind: d.kind, path: d.path }))
;(window as FixtureWindow).__localFileFixtureViewer = () =>
  store.imageViewer ? { paths: [...store.imageViewer.paths], index: store.imageViewer.index } : null

installLocalFileLinkInterceptor()
createRoot(document.getElementById("root")!).render(
  <main className="mx-auto max-w-xl p-8">
    <p className="mb-4 text-sm text-muted">Local artifact link fixture</p>
    <div
      className="md-body"
      dangerouslySetInnerHTML={{
        __html: mdToHtml([
          "Read the [review report](/fixture/report.md).",
          "",
          "Open the [signed contract](/fixture/contract.pdf).",
          "",
          "![descriptive alt](/fixture/shot.png)",
          "",
          "The write-up is in [`HANDOFF.md`](.ntwine/threads/6d56ea2f/HANDOFF.md).",
          "",
          "The rules are in [`CLAUDE.md`](~/.claude/CLAUDE.md).",
          "",
          // The THIRD destination a worker writes: an editor deep link (`cursor://file/…`), the shape
          // user-level "link every file" instructions prescribe for terminal rendering. It used to
          // survive as a raw anchor the OS resolved — always Cursor, whatever the opener setting said.
          // One `.md` and one not, so BOTH routes are asserted for the scheme form too.
          "The plan survives in [`plan.md`](cursor://file/fixture/plan.md).",
          "",
          "The raw capture is [`trace.json`](vscode://file//fixture/trace.json).",
          "",
          // Both drive separators, a file URL pathname, and an inline Windows screenshot.
          "The Windows write-up is in [`win-report.md`](D:/fixture/win-report.md).",
          "",
          "The Windows capture is [`win-trace.json`](D:%5Cfixture%5Cwin-trace.json).",
          "",
          "The Windows plan is [`win-plan.md`](file:///D:/fixture/win-plan.md).",
          "",
          "![windows alt](D:/fixture/win-shot.png)",
          "",
          // A Windows path through a dot-directory, in the destination AND in prose. CommonMark reads
          // `\.` as an escaped dot, so `fixture\.ntwine` used to fuse into `fixture.ntwine` in both — a
          // label the reader could not trust and a path the opener could not find (lib/windowsPathEscapes.ts).
          "The scratch note is [`build-gap.md`](D:\\fixture\\.ntwine\\threads\\8e51437e\\build-gap.md).",
          "",
          "It also lives at D:\\fixture\\.ntwine\\threads\\8e51437e\\build-gap.md in prose.",
        ].join("\n"), { baseDir: BASE_DIR, homeDir: HOME_DIR }),
      }}
    />
    {/* A PLACE IN A FILE, in every spelling a link, a deep link, a relative path, a file URL or inline
        code uses (shared file-position.ts), plus a raw-HTML button an author wrote by hand. Each one's
        path is bare on the element and its line beside it; with code files sent to the external app the
        line reaches `openLocalFile`, and in Ntwine's reader the bare path does. */}
    <PositionedProse
      html={mdToHtml([
        "At [`a.ts`](/fixture/src/a.ts#L5-L9) and [again](/fixture/src/a.ts:30), [`b.ts`](vscode://file/fixture/src/b.ts:3:2), [`c.ts`](src/c.ts:12), [`d.ts`](src/d.ts#L7) and [`e.ts`](file:///fixture/src/e.ts#L4).",
        "",
        "Inline: `src/f.ts:21`, `App.tsx:42` and `src/g.ts#L12-L14`.",
        "",
        "The guide is [`guide.md`](vscode://file/fixture/guide.md:8).",
        "",
        '<button data-local-path="/fixture/src/raw.ts" data-local-line="8" data-local-col="nope" data-bogus="x">raw.ts</button>',
      ].join("\n"), { baseDir: BASE_DIR, homeDir: HOME_DIR })}
    />
    <div className="mt-4" data-codex-finding>
      <CodexDirectiveCard directive={{ name: "code-comment", attrs: { title: "Off by one", file: "/fixture/src/h.ts", start: 30, end: 34 } }} />
    </div>
    {/* The OTHER producer of a local-file link: a tool card's header path (PathLink), here in its diff
        form. It used to be an `<a href="cursor://file/…">` the OS resolved, so it ignored the opener
        setting entirely and always landed in Cursor. It now takes the same route as everything above —
        a source file and a `.md` both into Ntwine's reader — so both are asserted for it too. The header
        is also a disclosure control, so the click must open the file WITHOUT toggling the block. */}
    <div className="mt-6">
      <DiffBlock edits={[{ file: "/fixture/src/app.ts", old: "a\n", new: "b\n" }]} />
    </div>
    <div className="mt-4">
      <DiffBlock edits={[{ file: "/fixture/notes.md", old: "a\n", new: "b\n" }]} />
    </div>
  </main>,
)
