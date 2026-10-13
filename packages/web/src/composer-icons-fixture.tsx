import { useState } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import { Composer } from "./components/Composer.tsx"
import { GithubTrigger, useGithubTriggerVisible } from "./components/GithubTrigger.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import "./styles.css"

// Browser QA for the dispatch composer's icon RAIL: paperclip (attach) + GitHub (investigate) + send.
// The GitHub icon only renders when gh is authed in a repo, which the isolated adhoc stack can't satisfy
// (it changes HOME), so stub githubStatus here — `?unauthed` stubs the signed-out answer instead.
// Verifies: (1) the paperclip brightness matches the GitHub icon (both text-muted), (2) the
// paperclip↔GitHub gap reads even with the GitHub↔send gap, and (3) when unauthed the GitHub slot
// disappears entirely and the paperclip sits directly beside send — no reserved empty hole.
// `?heals` is the OUTAGE replay: the first answer is the one a dead network to api.github.com produces
// (inRepo:false — `gh repo view` is a live API call), every answer after it is healthy. It exists to pin
// that the trigger comes back on its own, with no reload, because on 2026-08-11 it did not: a nine-minute
// outage flipped the answer, the tab kept it, and nothing ever re-asked.
const params = new URLSearchParams(location.search)
const authed = !params.has("unauthed")
const heals = params.has("heals")
// `?send=schedule` draws Send as it reads when Enter will create a schedule (the repeat glyph in place of the
// arrow, ScheduleComposer.tsx), and `?send=pending` as it reads while Enter is held for a schedule check.
const send = params.get("send")
let githubStatusCalls = 0
const originalFetch = window.fetch
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : (input as Request).url ?? input.toString(), location.origin)
  if (url.pathname === "/_ntwine/rpc/githubStatus") {
    const outage = heals && githubStatusCalls++ === 0
    const result = outage ? { inRepo: false, authed: true } : { inRepo: true, authed }
    return new Response(JSON.stringify({ result }), { headers: { "content-type": "application/json" } })
  }
  if (url.pathname.startsWith("/_ntwine/rpc/")) return new Response(JSON.stringify({ result: {} }), { headers: { "content-type": "application/json" } })
  return originalFetch(input, init)
}

function Fixture() {
  const [value, setValue] = useState("A short task prompt to enable the send button.")
  // Same conditional slot pattern as DispatchForm: no trigger → no leftAction prop at all.
  const githubTriggerVisible = useGithubTriggerVisible()
  return (
    <div className="min-h-screen bg-bg text-fg flex items-center justify-center p-10">
      <div className="w-[520px]">
        <Composer
          surface="newComposer"
          value={value}
          onChange={setValue}
          onSubmit={() => {}}
          {...(send === "schedule" ? { sendGlyph: "schedule" as const } : {})}
          {...(send === "pending" ? { sendPending: true } : {})}
          placeholder="Describe the task…"
          minHeight={96}
          maxHeight={340}
          footer={<span className="text-[11px] text-muted">gpt-5.6 · default</span>}
          leftAction={githubTriggerVisible ? <GithubTrigger /> : undefined}
        />
      </div>
    </div>
  )
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    <TooltipProvider>
      <Fixture />
    </TooltipProvider>
  </QueryClientProvider>,
)
