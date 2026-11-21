import { createRoot } from "react-dom/client"
import { MemoryRouter } from "react-router"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import "./styles.css"

// STATUS-ROW FIXTURE — the row above the prompt box in its FULLY POPULATED state, which no sandboxed
// stack can produce: an adhoc stack has no restart-capable supervisor (so the reload button renders
// null) and no provider credentials under its temp HOME (so both quota chips sit on the loading
// placeholder forever). Stubbing the reads the row depends on is the only way to actually LOOK at the
// finished thing: the page's door + settings + reload + two live quota percentages + its name on one line.
//
// It renders over a stand-in prompt box, because the row's two ends are supposed to land on that box's
// border and a row measured in a void cannot show that.
//
// Query params drive the states worth eyeballing:
//   ?state=low        — Claude in the amber warn zone, Codex critical
//   ?state=weeklywall — a HEALTHY 5h window behind a nearly-spent weekly one. The chip must still read
//                       the 5h number; this is the state where the old "swap to the tightest window"
//                       headline used to hijack it and show the weekly figure instead.
//   ?state=signedout  — Codex signed out, which now renders NO Codex chip at all
//   ?state=longemail  — an account address past the popover's width, to check the truncation
//   ?state=gemini     — Claude and Gemini reporting, Codex not (the maintainer's machine)
//   ?state=three      — all three providers reporting
//   ?hidden=codex,…   — the stored `hiddenQuotaChips`; the popover's Show checklist writes it back here
//   ?width=272                     — the column's width. 489 is the column at a 1440px viewport; 272 is
//                                    its floor in the tablet band.
//   ?font=mono                     — this app renders in TWO type families (html[data-font], applied
//                                    before first paint); a fixture that leaves it unset silently
//                                    renders mono and hides half the answer.

const params = new URLSearchParams(window.location.search)
const state = params.get("state") ?? "healthy"
const nowSeconds = Math.floor(Date.now() / 1000)

function windows(fiveHourUsed: number, weeklyUsed: number) {
  return [
    { key: "5h", label: "5h", usedPercent: fiveHourUsed, resetsAt: nowSeconds + 2 * 3600 },
    { key: "weekly", label: "Weekly", usedPercent: weeklyUsed, resetsAt: nowSeconds + 3 * 86400 },
  ]
}

const geminiWindows = [
  { key: "5h", label: "5h", usedPercent: 11, resetsAt: nowSeconds + 3600 + 1800 },
  { key: "weekly", label: "Weekly", usedPercent: 18, resetsAt: nowSeconds + 6 * 86400 },
  { key: "3p-5h", label: "5h", group: "Claude/GPT", usedPercent: 0, resetsAt: nowSeconds + 5 * 3600 },
  { key: "3p-weekly", label: "Weekly", group: "Claude/GPT", usedPercent: 88, resetsAt: nowSeconds + 6 * 86400 },
]

const quota =
  state === "gemini"
    ? {
        claude: { status: "ok", planType: "max", windows: windows(4, 38) },
        codex: { status: "unavailable", windows: [] },
        gemini: { status: "ok", windows: geminiWindows },
      }
    : state === "three"
    ? {
        claude: { status: "ok", planType: "max", windows: windows(17, 38) },
        codex: { status: "ok", planType: "pro", windows: windows(41, 29) },
        gemini: { status: "ok", windows: geminiWindows },
      }
    : state === "low"
    ? {
        claude: { status: "ok", planType: "max", windows: windows(82, 64) },
        codex: { status: "ok", planType: "pro", windows: windows(95, 71) },
      }
    : state === "weeklywall"
      ? {
          claude: { status: "ok", planType: "max", windows: windows(18, 93) },
          codex: { status: "ok", planType: "pro", windows: windows(24, 88) },
        }
      : {
          claude: { status: "ok", planType: "max", windows: windows(17, 38) },
          codex: { status: "ok", planType: "pro", windows: windows(41, 29) },
        }

// `emails` is the account each credential belongs to — the popover's "signed in as who?" line. A
// signed-out provider carries none (the server omits it rather than leave a stale label under an em
// dash), and ?state=longemail pins the truncation at the popover's 15rem cap.
const emails =
  state === "signedout"
    ? { claude: "dana@example.com" }
    : state === "longemail"
      ? { claude: "dana.mcallister.with.a.long.name@some-long-company-domain.example.com", codex: "me@gmail.com" }
      : { claude: "dana@example.com", codex: "me@gmail.com" }

const auth =
  state === "signedout"
    ? { claude: "authed", codex: "signed-out", emails }
    : { claude: "authed", codex: "authed", emails }

let settings: Record<string, unknown> = { hiddenQuotaChips: (params.get("hidden") ?? "").split(",").filter(Boolean) }

const nativeFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  const url = new URL(requestUrl, window.location.href)
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
  if (url.pathname === "/_ntwine/control/status") return json({ protocol: 1, state: "ready", updateRestart: true })
  // Every RPC response is the {result} envelope, never the payload bare.
  if (url.pathname === "/_ntwine/rpc/quota") return json({ result: quota })
  if (url.pathname === "/_ntwine/rpc/authStatus") return json({ result: auth })
  if (url.pathname === "/_ntwine/rpc/settingsGet") return json({ result: settings })
  if (url.pathname === "/_ntwine/rpc/settingsSet") {
    settings = JSON.parse(String(init?.body ?? "{}"))
    return json({ result: settings })
  }
  return nativeFetch(input, init)
}

document.documentElement.dataset.font = params.get("font") === "mono" ? "mono" : "sans"

const { StatusRow } = await import("./components/StatusRow.tsx")
const width = Number(params.get("width") ?? 489)

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    {/* The row's home crumb is a router Link (it hard-loaded the document until 2026-09-04), and a Link
        outside a router context throws on render. In the app the row always sits under RouterProvider;
        a MemoryRouter gives the fixture the same context without touching the address bar. */}
    <MemoryRouter>
      <main className="min-h-screen bg-bg p-6 text-fg">
        {/* The sidebar column's real width at a 1440px viewport by default, so the row's split reads at the
            measure it actually ships at; `?width=272` is the column's floor. */}
        <div style={{ width }}>
          <StatusRow />
          <div className="rounded-xl border border-border bg-panel px-3 py-6 text-[13px] text-muted">
            A stand-in prompt box. The row's two ends land on THIS border.
          </div>
        </div>
      </main>
    </MemoryRouter>
  </QueryClientProvider>,
)
