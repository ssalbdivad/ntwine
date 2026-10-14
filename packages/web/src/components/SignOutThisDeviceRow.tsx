import { useMutation } from "@tanstack/react-query"
import { useState } from "react"
import { useSupervisorStatus } from "../api/supervisorStatus.ts"
import { isRemoteSession, leaveAfterSignOut, signOutThisDevice } from "../api/signOut.ts"
import { Dialog } from "./ui/Dialog.tsx"

// The phone Settings row that ends THIS browser's remote-access session (approved in the 2026-09-30
// phone redesign, "This device" section). It signs out only the browser that taps it: the supervisor
// takes the id from this request's own cookie. Signing out OTHER devices stays `ntwine --sign-out` on the
// host, loopback only, so a stolen phone cannot evict the laptop.
//
// Renders nothing unless the supervisor says this page holds a remote session — the operator's own
// loopback tab has nothing to sign out, and the page cannot tell on its own (the cookie is HttpOnly).
export function SignOutThisDeviceRow({ className = "" }: { className?: string }) {
  const status = useSupervisorStatus()
  const [confirmOpen, setConfirmOpen] = useState(false)
  const signOut = useMutation({
    mutationFn: async () => {
      const outcome = await signOutThisDevice()
      // Only reachable if the row was shown on a tab the server then judged loopback: say so, rather
      // than navigate a board that is still signed in to a page it will never see.
      if (!outcome.signedOut) throw new Error("This browser has no remote session to sign out")
      return outcome
    },
    onSuccess: () => leaveAfterSignOut(),
  })
  if (!isRemoteSession(status.data)) return null
  const error = signOut.error instanceof Error ? signOut.error.message : signOut.error ? String(signOut.error) : null
  // Pending covers the navigation too: once signed out, the page is on its way to the sign-in page and
  // must not offer the button again.
  const busy = signOut.isPending || signOut.isSuccess

  return (
    <>
      <button
        type="button"
        data-sign-out-this-device
        onClick={() => setConfirmOpen(true)}
        className={`flex min-h-[52px] w-full items-center border-y border-border px-[18px] text-left text-[15.5px] text-danger outline-none active:bg-danger-fill/10 ${className}`}
      >
        Sign out this device
      </button>
      <Dialog
        open={confirmOpen}
        onOpenChange={(open) => { if (!busy) setConfirmOpen(open) }}
        title="Sign out this device?"
        className="w-[390px] max-w-[92vw]"
        footer={
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirmOpen(false)}
              className="button-outline rounded-md px-3 py-1.5 text-[12px] text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg disabled:opacity-45"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => signOut.mutate()}
              className="button-outline rounded-md bg-danger-button/90 px-3 py-1.5 text-[12.5px] font-medium text-white outline-none transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {/* Words rather than a spinner: nothing in the phone's chrome animates. */}
              {busy ? "Signing out…" : "Sign out"}
            </button>
          </>
        }
      >
        <div className="flex flex-col gap-2 p-4 text-[12.5px] leading-relaxed text-muted">
          <p>This browser will need a new access link to open ntwine again. Your other devices stay signed in.</p>
          {error ? <p className="text-[11.5px] text-danger">{error}</p> : null}
        </div>
      </Dialog>
    </>
  )
}
