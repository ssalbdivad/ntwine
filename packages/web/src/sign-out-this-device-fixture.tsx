import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import "./styles.css"

// The "Sign out this device" row on its own, against a stubbed supervisor. The row is not mounted in
// the app yet (the phone Settings drawer mounts it), so this is where it can be seen and driven.
//   ?loopback   the supervisor reports no remote session — the row must render NOTHING
//   ?legacy     the sign-out answers cookie-cleared (a pre-id session)
//   ?fail       the sign-out endpoint is missing (an older supervisor) — the dialog shows the error
// Every sign-out request is logged to sessionStorage["signOutFixtureCalls"] so a driver can read what
// was actually sent after the page has navigated away.
const params = new URLSearchParams(window.location.search)
document.documentElement.dataset.font = params.get("font") === "mono" ? "mono" : "sans"
if (params.get("theme") === "light") document.documentElement.dataset.theme = "light"

const nativeFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  const url = new URL(requestUrl, window.location.href)
  if (url.pathname === "/_ntwine/control/status") {
    return new Response(JSON.stringify({ protocol: 1, state: "ready", ...(params.has("loopback") ? {} : { remoteSession: true }) }), {
      headers: { "content-type": "application/json" },
    })
  }
  if (url.pathname === "/_ntwine/control/sign-out") {
    const calls = JSON.parse(window.sessionStorage.getItem("signOutFixtureCalls") ?? "[]") as unknown[]
    calls.push({ method: init?.method ?? "GET", body: init?.body ?? null })
    window.sessionStorage.setItem("signOutFixtureCalls", JSON.stringify(calls))
    await new Promise((resolve) => window.setTimeout(resolve, 600))
    if (params.has("fail")) return new Response("<!doctype html>", { status: 404, headers: { "content-type": "text/html" } })
    const body = params.has("legacy") ? { protocol: 1, result: "cookie-cleared" } : { protocol: 1, result: "signed-out", id: "fixture1" }
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
  }
  return nativeFetch(input, init)
}

const { SignOutThisDeviceRow } = await import("./components/SignOutThisDeviceRow.tsx")
const queryClient = new QueryClient()

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <main className="min-h-screen bg-bg text-fg">
      {/* Scaffolding in the mockup's shape (v2.html, Settings frame): a section label, then the row. */}
      <div className="px-[18px] pt-[18px] pb-[6px] text-[12.5px] font-semibold text-muted">This device</div>
      <SignOutThisDeviceRow />
      <div className="px-[18px] py-[14px] text-[12.5px] text-muted-60">Ntwine 0.14.3</div>
    </main>
  </QueryClientProvider>,
)
