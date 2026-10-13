import { Lock } from "lucide-react"

// The line under a SECRET question's password field, on the desktop card (QuestionBlockCard) and the
// phone answer sheet (RegisteredAnswerSheet) alike: a lock, then what happens to the value. Each caller
// passes only its own type size, tone and margin; the lock and the copy live here.
//
// THE COPY IS THE MAINTAINER'S, verbatim (2026-10-12). It replaced "Held in memory on the machine
// running Frizz and handed to one command, once. The worker never sees it.", which wrapped to two lines
// on every surface. Of five treatments of that long copy, the maintainer said: "They're all so bad …
// shorten it onto one line and then go with something like option A with the hanging lock." Round 2,
// which settled the lock, is the mockup sheet `secret-caption-mockups-fixture.tsx`. "Only in memory"
// is the FIFO in packages/server/src/secret-files.ts, which never writes the value to disk. Windows has
// no FIFOs, so there the value sits in a short-lived 0600 file. Measured in sans: one line on a desktop
// card 456px wide or wider. A 356px card and the phone's 390pt sheet wrap once, and `text-pretty` keeps
// the second line from being a lone word ("…show up / in transcripts.").
//
// THE LOCK SITS ON THE CAP BAND. Its box is 0.9em square and `self-baseline` in an `items-baseline` row.
// A box S tall standing on the baseline has its ink centre at baseline − S/2, and the cap band's centre
// is baseline − 0.5cap, so the lift is S/2 − 0.5cap. `1cap` is the resolved font's own cap height, so
// the lift holds at the card's 11px and the sheet's 13px with nothing to re-measure. Measured in sans
// (round 2, 2026-10-12): lock ink 8.24px against a 7.75px cap at 11px and 9.74px against 9.16px at 13px,
// centred to 0.01px, so the shackle overshoots the caps by half a pixel the way a round letter does.
// At 1em the lock stood 1.4px taller than the caps and read as oversized. The 2.25 stroke brings it to
// ~0.9px, the weight of the regular text beside it. The ink gap to the text is 5.5px on the card and
// 6.5px on the sheet.
export function SecretCaption({ className }: { className: string }) {
  return (
    <div className={`flex items-baseline gap-[0.3em] ${className}`}>
      <Lock aria-hidden strokeWidth={2.25} className="size-[0.9em] shrink-0 self-baseline translate-y-[calc(0.45em_-_0.5cap)]" />
      <span className="min-w-0 flex-1 text-pretty">Value stored only in memory. It will not show up in transcripts.</span>
    </div>
  )
}
