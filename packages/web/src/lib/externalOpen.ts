import { showToast, store } from "../store.ts"

// FEEDBACK FOR A SLOW OPEN OUTSIDE NTWINE — an editor on a thread's folder, a file in the Local file links app.
// The window can take seconds to appear (VS Code over WSL routinely does), and until 2026-09-30 nothing
// on the page moved in between: a press looked like a miss, so it got pressed again, and every press
// opened another window.
//
// So each open shows an "Opening …" spinner the moment it is asked for, and it KEEPS spinning until the
// RPC answers — which the server holds until the opener's launcher has handed the path off and exited
// (local-file.ts awaitOpenerHandoff), i.e. until the window is up. Then the spinner simply goes: the
// window is the confirmation. A failure replaces it with the reason. A repeat of the SAME open (same
// key) while it runs, or within OPEN_COOLDOWN_MS of its answer, re-shows the spinner instead of
// spawning a second opener; a different key opens at once.
const OPEN_COOLDOWN_MS = 1_000
const busy = new Map<string, number>() // key → when it may run again (Infinity while in flight)

export async function runExternalOpen<T>(
  key: string,
  pending: string,
  open: () => Promise<T>,
  settled: (result: T) => void | Promise<void>,
  failure: (message: string) => string,
): Promise<void> {
  const until = busy.get(key)
  if (until !== undefined && Date.now() < until) {
    if (until === Infinity) showToast(pending, { spinner: true, sticky: true })
    return
  }
  busy.set(key, Infinity)
  showToast(pending, { spinner: true, sticky: true })
  try {
    const result = await open()
    // Only OUR spinner is taken down: another toast raised in the meantime stays.
    if (store.toast?.text === pending && store.toast.spinner) store.toast = null
    await settled(result)
  } catch (error) {
    showToast(failure((error instanceof Error ? error.message : String(error)).slice(0, 100)))
    busy.delete(key) // a failed open is retried at once — the cooldown guards only against a second window
    return
  }
  busy.set(key, Date.now() + OPEN_COOLDOWN_MS)
}

/** The last segment of a path, for a toast that names what was opened. */
export function baseName(path: string): string {
  return path.replace(/[\\/]+$/u, "").split(/[\\/]/u).pop() || path
}

/** Test seam: the cooldowns are module state. */
export function resetExternalOpens(): void {
  busy.clear()
}
