import { useState } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import { HistoryView, type HistoryEntry } from "./components/HistoryView.tsx"
import "./styles.css"

// Browser QA for HISTORY (components/HistoryView.tsx) against a REAL server. A stack serves only its own
// page, so this module mounts OVER it: open any page of an adhoc stack and import this from the page
// (scripts/shot.mjs's --before), and it draws History full-screen on that stack's `projectsDone` and
// `threadsSearch` — seed Done threads first. A click names the entry it would open; the page decides
// what opening means.
//
//   node scripts/adhoc-stack.mjs --port=N …
//   node scripts/shot.mjs http://127.0.0.1:N/all out.png --before="import('/src/history-fixture.tsx')"
//   `window.__historyLens = ["<project id>"]` before the import sets the lens.

document.documentElement.dataset.font = "sans"
const lens = (window as { __historyLens?: string[] }).__historyLens

function Fixture() {
  const [opened, setOpened] = useState<HistoryEntry | null>(null)
  return (
    <div className="mx-auto max-w-[720px] p-4 text-sm text-fg">
      <div data-opened className="mb-2 text-[12px] text-muted-60">{opened ? `Opened ${opened.projectSlug}/${opened.thread.id}` : "Nothing opened"}</div>
      <HistoryView projectIds={lens} onOpen={setOpened} />
    </div>
  )
}

// Once per page, however many times it is imported.
const host = document.querySelector<HTMLElement>("[data-history-fixture]") ?? document.createElement("div")
const fresh = !host.isConnected
host.dataset.historyFixture = ""
host.style.cssText = "position:fixed;inset:0;z-index:2147483000;overflow:auto"
if (fresh) document.body.append(host)
if (fresh) createRoot(host).render(
  <QueryClientProvider client={new QueryClient()}>
    <div className="min-h-full bg-bg"><Fixture /></div>
  </QueryClientProvider>,
)
