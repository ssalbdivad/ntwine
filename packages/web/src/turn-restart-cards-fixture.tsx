import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ThreadView } from "@ntwine/shared"
import { ProviderFaultCard, LimitPauseCard } from "./components/ChatView.tsx"
import { Toaster } from "./components/Toaster.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import "./styles.css"

// The two in-drawer cards that RESTART A TURN on an at-rest thread — a provider sign-in fault and a
// usage-limit pause. Both used to call rpc.followUp directly, so alone with the sidebar Retry they
// skipped the eager path: no optimistic bubble, no rail reorder, no delivery-ledger deliveryId. This
// fixture renders BOTH real cards with a /rpc/followUp stub that records every send, so a driver can
// click each button and prove the body now carries a deliveryId (i.e. it went through sendEagerFollowUp).

const nativeFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  const url = new URL(requestUrl, window.location.href)
  if (url.pathname === "/_ntwine/rpc/followUp") {
    const body = JSON.parse(String(init?.body ?? "{}"))
    const log = JSON.parse(window.sessionStorage.getItem("followUpCalls") ?? "[]")
    log.push(body)
    window.sessionStorage.setItem("followUpCalls", JSON.stringify(log))
    return new Response(JSON.stringify({ result: null }), { headers: { "content-type": "application/json" } })
  }
  // markRead rides along on every eager send; stub it so the card's click path stays self-contained.
  if (url.pathname === "/_ntwine/rpc/markRead") {
    return new Response(JSON.stringify({ result: null }), { headers: { "content-type": "application/json" } })
  }
  return nativeFetch(input, init)
}

const fault = { backend: "claude", category: "auth" } as unknown as NonNullable<ThreadView["providerFault"]>
const pause = { backend: "claude", window: "session", autoResume: true, resumesAt: 0 } as unknown as NonNullable<ThreadView["limitPause"]>

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <TooltipProvider>
      <main className="min-h-screen bg-bg px-10 py-10 text-fg flex flex-col gap-4 w-[640px]">
        <ProviderFaultCard slug="auth-faulted" sessionId="sid-auth" fault={fault} retryText="fix the flaky test" />
        <LimitPauseCard slug="limit-paused" sessionId="sid-limit" pause={pause} />
        <Toaster />
      </main>
    </TooltipProvider>
  </QueryClientProvider>,
)
