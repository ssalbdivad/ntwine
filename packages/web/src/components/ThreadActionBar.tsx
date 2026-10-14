import { type ReactNode } from "react"
import { useSnapshot } from "valtio"
import { store } from "../store.ts"
import { ThreadComposerBox } from "./ThreadComposerBox.tsx"
import type { PhoneBarApi } from "./Composer.tsx"

// The bar under the drawer's transcript is JUST the follow-up composer — the thread's verbs live in its
// header (ChatView's ThreadHeader, HeaderActions). `above` (the live ops' one line of counts,
// QueueOpsSummary) renders INSIDE the padded box, over the prompt, the way the queue card's does. The
// rows hung under the prompt until 2026-10-09; they are one hover away now.
//
// This is now a THIN wrapper around <ThreadComposerBox> — the same block the queue card renders.
// Everything the two surfaces must agree on (the draft key, the `/login`/`/logout` intercept, the
// model/effort footer, the status line) lives in that component.
// `phoneBarOverride` passes straight through to the phone bar's answer seam (ThreadComposerBox).
export function ThreadActionBar({ slug, above, phoneBarOverride, phoneChrome }: { slug: string; above?: ReactNode; phoneBarOverride?: (api: PhoneBarApi) => ReactNode; phoneChrome?: boolean }) {
  const snap = useSnapshot(store)
  const thread = snap.board?.threads.find((t) => t.id === slug)

  // An EXTERNAL session (one Ntwine did not start) is read only: it has no row, so there is nothing to
  // send into, and ChatView draws no footer for it either. Steering one used to promote it into an
  // ordinary thread; removed 2026-10-14.
  if (!thread || thread.foreign === true) return null

  return (
    <ThreadComposerBox
      slug={slug}
      surface="chatComposer"
      id="followup-input"
      // PADDING ONLY — no border, no background. The separator + panel fill belong to the
      // [data-thread-chat-footer] wrapper in ChatView that hosts this bar; carrying them here too
      // stacked a second hairline directly under the first, so the line above the prompt box read
      // as a 2px rule instead of the queue card's single hairline. The queue card's own docked box
      // (AllQueuesCard) pads the same 12px top and bottom, as does drawer-composer-footer-fixture.
      className="shrink-0 px-3 py-3"
      above={above}
      phoneBarOverride={phoneBarOverride}
      phoneChrome={phoneChrome}
    />
  )
}

// The old ⋯ overflow menu is gone: the ntwine-document, retry, and done actions all live as direct
// icons in the shared <HeaderActions> (Kill and Dismiss were dropped entirely — an exited session
// is retried from the header, or cleared through the header's check).
