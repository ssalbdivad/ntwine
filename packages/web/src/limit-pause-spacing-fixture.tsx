import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import type { LimitPause } from "@ntwine/shared"
import { LimitPauseCard } from "./components/ChatView.tsx"
import "./styles.css"

// Browser QA for the usage-limit pause card's layout: the REAL card at a wide and a narrow width,
// across all three copy variants (a clock, no clock, auto-resume off). The reported "garbage spacing"
// was a button hanging below the sentence inside the card's padding; the card now wears the shared
// transcript-card chrome (a gutter glyph + title row, then the sentence, then a left-justified CardActions row),
// so the check here is that the Continue button stays anchored to the right edge and the sentence
// wraps above it at every width rather than colliding with it.

const SLUG = "limit-pause-spacing"

// 8:00 PM today → the exact "continuing automatically at 8:00 PM." wording from the report.
const eightPm = new Date()
eightPm.setHours(20, 0, 0, 0)
const sessionPause: LimitPause = {
  backend: "claude",
  window: "session",
  at: new Date().toISOString(),
  resumesAt: Math.round(eightPm.getTime() / 1000),
  autoResume: true,
}

function Row({ label, width, children }: { label: string; width: number; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 text-[11px] text-muted">{label} · {width}px</p>
      <div style={{ width }} className="min-w-0">{children}</div>
    </div>
  )
}

function Fixture() {
  return (
    <main className="min-h-screen bg-bg p-8 text-fg">
      <div className="mx-auto max-w-[820px] space-y-8">
        <section className="space-y-3">
          <h2 className="text-[13px] font-semibold text-amber-300/90">Shared card chrome — header, sentence, left-justified action</h2>
          <Row label="wide (single line)" width={720}><LimitPauseCard slug={SLUG} sessionId="s1" pause={sessionPause} /></Row>
          <Row label="narrow (sentence wraps above the button)" width={360}><LimitPauseCard slug={SLUG} sessionId="s1" pause={sessionPause} /></Row>
          <Row label="wide · no clock (once the window resets)" width={720}>
            <LimitPauseCard slug={SLUG} sessionId="s1" pause={{ ...sessionPause, resumesAt: undefined }} />
          </Row>
          <Row label="wide · manual (auto-resume off)" width={720}>
            <LimitPauseCard slug={SLUG} sessionId="s1" pause={{ ...sessionPause, autoResume: false }} />
          </Row>
        </section>
      </div>
    </main>
  )
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    <Fixture />
  </QueryClientProvider>,
)
