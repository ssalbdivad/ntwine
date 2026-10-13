import { useState } from "react"
import { createRoot } from "react-dom/client"
import { SnoozeCard, showsSnoozeCard } from "./components/SnoozeCard.tsx"
import "./styles.css"

// Browser QA for the transcript's snooze COUNTDOWN card (SnoozeCard): a wall-clock-snoozed thread
// states its park at the bottom of the transcript — remaining time as a live-ticking headline, the
// wake sentence under it, and Wake now as the one verb. Until this card the snooze was legible only on
// hover (maintainer 2026-08-24: "it doesn't say that it's been snoozed. It doesn't say when the snooze
// expires").
//
// Query params, composable:
//   ?in=<seconds>   — remaining time (default 2d 3h 30m, which renders the ladder's "2d 3h" shape and
//                     holds it through the whole QA session — the 30m keeps the floored hour from
//                     dipping mid-look); use small values (`?in=95`) to watch the seconds digit tick.
//   ?prompt=1       — the scheduled-BUMP shape: the wake resumes the agent with the follow-up text, and
//                     the sentence names it instead of promising a queue card.
//   ?foreign=1      — a read-only external session: the card states the park and offers no verb.
//   ?font=sans|mono — THIS APP RENDERS IN TWO FONTS; a fixture that sets neither silently takes the
//                     MONO default. Applied before first paint exactly as index.html does it.
const params = new URLSearchParams(location.search)
document.documentElement.dataset.font = params.get("font") === "sans" ? "sans" : "mono"

const inSeconds = Number(params.get("in") ?? String(2 * 24 * 3600 + 3 * 3600 + 30 * 60))
const wantPrompt = params.get("prompt") === "1"
const foreign = params.get("foreign") === "1"

// setThreadSnooze is mocked so nothing real is hit; the Wake now click clears the fixture's own state,
// which is the same unmount the board delta produces on a live thread.
const originalFetch = window.fetch
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : (input as Request).url ?? input.toString(), location.origin)
  if (url.pathname === "/_ntwine/rpc/setThreadSnooze") {
    window.dispatchEvent(new CustomEvent("fixture-rpc", { detail: { rpc: "setThreadSnooze", body: JSON.parse(String(init?.body ?? "{}")) } }))
    return new Response(JSON.stringify({ result: null }), { headers: { "content-type": "application/json" } })
  }
  if (url.pathname.startsWith("/_ntwine/rpc/")) {
    return new Response(JSON.stringify({ result: null }), { headers: { "content-type": "application/json" } })
  }
  return originalFetch(input, init)
}

function Fixture() {
  const [snoozedUntil, setSnoozedUntil] = useState<string | undefined>(
    new Date(Date.now() + inSeconds * 1_000).toISOString(),
  )
  const thread = {
    id: "snooze-card-demo",
    sessionId: "aaaaaaaa-bbbb-cccc-dddd-000000000001",
    foreign,
    snoozedUntil,
    snoozePrompt: wantPrompt ? "Re-check the deploy and re-run the smoke suite before continuing." : undefined,
  }
  return (
    <div
      className="mx-auto w-[min(680px,calc(100%-32px))] py-8"
      onClickCapture={(event) => {
        // The real card unmounts when the board delta clears snoozedUntil; mirror that by clearing the
        // fixture's own state right after the (mocked) RPC fires.
        if ((event.target as HTMLElement).closest("[data-snooze-wake-now]")) {
          setTimeout(() => setSnoozedUntil(undefined), 50)
        }
      }}
    >
      {showsSnoozeCard(thread) ? <SnoozeCard thread={thread} /> : (
        <p data-snooze-cleared className="text-[13px] text-muted">
          Awake — the card unmounted when the snooze cleared.
        </p>
      )}
    </div>
  )
}

createRoot(document.getElementById("root")!).render(<Fixture />)
