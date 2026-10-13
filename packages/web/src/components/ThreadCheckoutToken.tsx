import type { ReactNode } from "react"
import { Folder, FolderGit2 } from "lucide-react"
import type { WorkCheckout } from "@ntwine/shared"
import { abbreviateHome } from "../lib/paths.ts"

// WHERE THE AGENT IS WORKING, WHEN THAT IS NOT THE PROJECT ROOT — one quiet token on a thread's meta line
// (David 2026-09-29: the agent's cwd should be "subtle but visible so its clear where the terminal
// will open and when the agent chooses to use a worktree instead of main").
//
// It renders NOTHING in the ordinary case. `thread.checkout` is absent while the agent works in the
// project's own checkout (the server's liftCheckout, thread-cwd.ts), so a token on every thread would be
// noise that says the same thing everywhere; it appears the moment the agent moves into a linked worktree
// or out of the project, and goes when it comes back. No colour, no badge, no warning: a worktree is a
// choice the agent is allowed to make, and the token only makes it visible.
//
// GEOMETRY. The wrapper is its own `items-baseline` row, so the glyph has a baseline to sit on whichever
// line holds it — the drawer header's `items-center` line or the queue card's `items-baseline` one. On it,
// `self-baseline` + `translate-y-[calc(0.5em_-_0.5cap)]` puts a symmetric 1em glyph's centre on the text's
// cap band in any font at any size (the same browser-computed correction as ThreadTerminals' DONE_ICON), so
// there is no per-font constant here to re-measure. `-mt-[1em]` stops that 1em box, standing on the
// baseline, from rising above the text's own line box: without it the token was taller than the time
// beside it, and the drawer header's `items-center` line then set its baseline 0.5px under the time's.
// Measured on the live stack (sans, 11px, dsf 2 geometry): glyph box centre 0.04px from the text's cap
// band, ink centre 0.27px low (FolderGit2's ink sits a hair low in its viewBox; sub-pixel, left alone).

/** The token's text: the checkout's own folder name, the part that tells two worktrees apart. */
export function checkoutName(dir: string): string {
  const trimmed = dir.replace(/[\\/]+$/, "")
  return trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1) || trimmed
}

/** What the token means, in the words a human acts on: where, and that a new terminal starts there. */
export function checkoutTitle(checkout: WorkCheckout, homeDir: string | undefined): string {
  // Not "outside the project": a `folder` checkout can sit inside the root (a nested clone, or `~/ntwine`
  // in the Home workspace, whose root is the home folder). The path on the next line says which.
  const head = checkout.kind === "worktree" ? "Agent is working in a worktree" : "Agent is working in another folder"
  return `${head}\n${abbreviateHome(checkout.dir, homeDir)}\nNew terminals open here`
}

export function ThreadCheckoutToken({ checkout, homeDir, lead }: { checkout: WorkCheckout | null | undefined; homeDir: string | undefined; lead?: ReactNode }) {
  if (!checkout) return null
  const Glyph = checkout.kind === "worktree" ? FolderGit2 : Folder
  return (
    <>
      {lead}
      <span
        data-thread-checkout={checkout.kind}
        title={checkoutTitle(checkout, homeDir)}
        className="inline-flex shrink-0 items-baseline gap-[0.25em] text-muted-60"
      >
        <Glyph aria-hidden className="-mt-[1em] h-[1em] w-[1em] shrink-0 self-baseline translate-y-[calc(0.5em_-_0.5cap)]" />
        <span className="max-w-[16ch] truncate">{checkoutName(checkout.dir)}</span>
      </span>
    </>
  )
}
