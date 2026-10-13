import { createRoot } from "react-dom/client"
import "./styles.css"
import { mdToHtml, mdInlineToHtml } from "./lib/markdown.ts"

// Drives the REAL render path (mdToHtml/mdInlineToHtml → marked → the DOM sanitizer, which unit tests
// can't reach) over the tilde shapes agent prose actually contains. Only `~~…~~` may produce a <del>;
// the approximation tilde ("~2.7s") and the home prefix ("~/.claude") must render as plain text.
const CASES: { id: string; md: string }[] = [
  { id: "approx", md: "Backend returns in ~2.7s; the shared cache `~/.ntwine/quota-cache` is healthy." },
  { id: "paths", md: "SYSTEM ~/.claude/settings.json and the global hook (~/.orca/claude-hook.sh) on UserPromptSubmit." },
  { id: "budget", md: "Poll injection, timeout per poll. ~1 file. **~0.5-1 day.**" },
  { id: "single", md: "~one tilde~" },
  { id: "double", md: "~~genuinely struck~~ and ~~a **bold** strike~~" },
  { id: "mixed", md: "~~first~~ then ~single~ then ~~second~~" },
]

createRoot(document.getElementById("root")!).render(
  <main className="mx-auto max-w-2xl p-8">
    <p className="mb-4 text-sm text-muted">Markdown strikethrough fixture — only `~~two tildes~~` strike</p>
    <div className="flex flex-col gap-4">
      {CASES.map(({ id, md }) => (
        <section key={id} data-case={id} className="flex flex-col gap-1">
          <code className="text-xs text-muted">{md}</code>
          <div className="md-body" data-block dangerouslySetInnerHTML={{ __html: mdToHtml(md) }} />
          <div className="md-body" data-inline dangerouslySetInnerHTML={{ __html: mdInlineToHtml(md) }} />
        </section>
      ))}
    </div>
  </main>,
)
