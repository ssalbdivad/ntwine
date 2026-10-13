// MOCKUP SHEET, ROUND 2 — the caption under a SECRET question's password field: ONE line, a hanging lock.
//
// Not a test and not shipped UI: a design surface. Each row renders the secret card on the REAL card
// chrome and stylesheet, at a roomy and a narrow width, beside the phone answer sheet's reading of the
// same box.
//
//   nubx vite --port 5477 --strictPort      (from packages/web)
//   http://localhost:5477/secret-caption-mockups-fixture.html
//
// ROUND 1 (five treatments: hanging lock, indented, green lock, note strip, joined footer) is in this
// file's history at da0b2889. The maintainer's read (2026-10-12): "They're all so bad … shorten it onto
// one line and then go with something like option A with the hanging lock. That's the closest." The
// two-line wrap was most of what was wrong, so every row here is a SHORTER caption that holds one line
// down to the phone's 13px.
//
// THE LOCK SETTLED ON ROW 8: `text-muted`, `mt-2`, a 0.9em lock at stroke 2.25. It shipped as
// components/SecretCaption.tsx, which carries the measurements. The copy shipped as the maintainer
// wrote it, "Value stored only in memory. It will not show up in transcripts.", not as any row here.
//
// THE LOCK SITS ON THE CAP BAND, not on the box centre: it is 1em tall and `self-baseline` inside an
// `items-baseline` row, lifted by `0.5em − 0.5cap` — the browser's own cap height, so it holds at the
// card's size and the sheet's alike.
import { createRoot } from "react-dom/client"
import { Lock } from "lucide-react"
import { TranscriptCard } from "./components/TranscriptCard.tsx"
import { LinkedHtml } from "./components/LinkedHtml.tsx"
import { useMarkdownHtml } from "./lib/useMarkdown.ts"
import "./styles.css"

const CONTEXT =
  "A NEW OpenRouter management key for Pullfrog production: open https://openrouter.ai/settings/management-keys, click Create New Key, name it vercel-production-2026-10-09, and paste the key here."
const TODAY = "Held in memory on the machine running Frizz and handed to one command, once. The worker never sees it."

type Row = {
  id: string
  copy: string
  /** Card caption: type, tone, gap above the caption, lock stroke. */
  card: { type: string; tone: string; mt: string; stroke: number }
  /** Phone sheet caption, same knobs. */
  sheet: { type: string; tone: string; mt: string; stroke: number }
  lock?: boolean
  /** The lock's box, in em of the caption. */
  size?: number
}

const CARD_TODAY = { type: "text-[11px] leading-snug", tone: "text-muted-70", mt: "mt-1.5", stroke: 2 }
const SHEET_TODAY = { type: "text-[13px] leading-[18px]", tone: "text-muted", mt: "mt-2", stroke: 2 }

const ROWS: Row[] = [
  { id: "today", copy: TODAY, card: CARD_TODAY, sheet: SHEET_TODAY, lock: false },
  // Copy, at today's type.
  { id: "1", copy: "Used once. The worker never sees it.", card: CARD_TODAY, sheet: SHEET_TODAY },
  { id: "2", copy: "Kept in memory and used once. The worker never sees it.", card: CARD_TODAY, sheet: SHEET_TODAY },
  { id: "3", copy: "Handed to one command, once. The worker never sees it.", card: CARD_TODAY, sheet: SHEET_TODAY },
  // Tone and air, on the shortest copy.
  { id: "4", copy: "Used once. The worker never sees it.", card: { ...CARD_TODAY, tone: "text-muted", mt: "mt-2" }, sheet: SHEET_TODAY },
  { id: "5", copy: "Used once. The worker never sees it.", card: { ...CARD_TODAY, tone: "text-muted", mt: "mt-2", stroke: 2.25 }, sheet: { ...SHEET_TODAY, stroke: 2.25 } },
  { id: "6", copy: "Used once. The worker never sees it.", card: { type: "text-[11.5px] leading-snug", tone: "text-muted", mt: "mt-2", stroke: 2.25 }, sheet: { ...SHEET_TODAY, stroke: 2.25 } },
  { id: "7", copy: "Only used once — the worker never sees it.", card: { ...CARD_TODAY, tone: "text-muted", mt: "mt-2", stroke: 2.25 }, sheet: { ...SHEET_TODAY, stroke: 2.25 } },
  // The lock's size against the caption's cap height, on row 5.
  { id: "8", copy: "Used once. The worker never sees it.", card: { ...CARD_TODAY, tone: "text-muted", mt: "mt-2", stroke: 2.25 }, sheet: { ...SHEET_TODAY, stroke: 2.25 }, size: 0.9 },
  { id: "9", copy: "Used once. The worker never sees it.", card: { ...CARD_TODAY, tone: "text-muted", mt: "mt-2", stroke: 2.5 }, sheet: { ...SHEET_TODAY, stroke: 2.5 }, size: 0.85 },
]

function Caption({ copy, s, lock = true, size = 1 }: { copy: string; s: Row["card"]; lock?: boolean; size?: number }) {
  return (
    <div data-caption className={`flex items-baseline gap-[0.3em] ${s.type} ${s.tone} ${s.mt}`}>
      {lock && (
        // A box S tall on the baseline has its ink centre at baseline − S/2; the cap band's is baseline − cap/2.
        <Lock
          aria-hidden
          strokeWidth={s.stroke}
          className="shrink-0 self-baseline"
          style={{ width: `${size}em`, height: `${size}em`, translate: `0 calc(${size / 2}em - 0.5cap)` }}
        />
      )}
      <span className="min-w-0 flex-1 text-pretty">{copy}</span>
    </div>
  )
}

function Card({ r, width }: { r: Row; width: number }) {
  const html = useMarkdownHtml(CONTEXT)
  return (
    <div data-surface={`card-${width}`} className="card-md shrink-0" style={{ width }}>
      <TranscriptCard tone="neutral" surface="question" label="Secret">
        <div className="text-fg">
          <LinkedHtml className="md-body [overflow-wrap:anywhere]" html={html} />
        </div>
        <div className="mt-2">
          <input
            type="password"
            readOnly
            placeholder="Paste the value…"
            className="block w-full rounded-md border border-border bg-transparent py-1.5 pl-3 pr-3 text-[12px] leading-snug text-fg/90 outline-none placeholder:text-muted-80"
          />
          <Caption copy={r.copy} s={r.card} lock={r.lock} size={r.size} />
        </div>
      </TranscriptCard>
    </div>
  )
}

function Sheet({ r }: { r: Row }) {
  return (
    <div data-surface="sheet" className="w-[390px] shrink-0 overflow-hidden rounded-t-[14px] border-t border-border-strong bg-panel pb-5 pt-4">
      <div className="px-[18px] pb-3 text-[17px] font-semibold leading-[23px] text-fg">A NEW OpenRouter management key for Pullfrog production.</div>
      <div className="px-[18px]">
        <input
          type="password"
          readOnly
          placeholder="Paste the value…"
          className="block w-full rounded-[12px] border border-border-strong bg-bg px-3 py-[11px] text-[16px] leading-[22px] text-fg outline-none placeholder:text-faint"
        />
        <Caption copy={r.copy} s={r.sheet} lock={r.lock} size={r.size} />
      </div>
    </div>
  )
}

createRoot(document.getElementById("root")!).render(
  <div className="flex flex-col gap-8 p-8">
    {ROWS.map((r) => (
      <section key={r.id} data-variant={r.id} className="flex flex-col gap-3 border-t border-border pt-5">
        <div className="text-[13px] text-muted">
          <span className="font-semibold text-fg">{r.id === "today" ? "Today" : r.id}</span> · {r.copy}
        </div>
        <div className="flex items-start gap-6">
          <Card r={r} width={600} />
          <Card r={r} width={380} />
          <Sheet r={r} />
        </div>
      </section>
    ))}
  </div>,
)
