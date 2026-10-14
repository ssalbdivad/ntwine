import { useState } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import { Composer } from "./components/Composer.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import "./styles.css"

// Browser QA for the dispatch composer's icon RAIL: paperclip (attach) + send. RPCs are stubbed empty so
// the composer mounts with no server behind it.
const params = new URLSearchParams(location.search)
// `?send=schedule` draws Send as it reads when Enter will create a schedule (the repeat glyph in place of the
// arrow, ScheduleComposer.tsx), and `?send=pending` as it reads while Enter is held for a schedule check.
const send = params.get("send")
const originalFetch = window.fetch
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : (input as Request).url ?? input.toString(), location.origin)
  if (url.pathname.startsWith("/_ntwine/rpc/")) return new Response(JSON.stringify({ result: {} }), { headers: { "content-type": "application/json" } })
  return originalFetch(input, init)
}

function Fixture() {
  const [value, setValue] = useState("A short task prompt to enable the send button.")
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
