// A thread had a fullscreen page at its drawer address plus `/full` until 2026-10-15, when the
// maintainer removed it ("the fullscreen view sucks"). Bookmarks, notifications and transcripts still
// carry those addresses, so each one opens the thread's drawer instead: main.tsx rewrites a cold load,
// routes.tsx an in-app navigation.
export const RETIRED_FULL_PAGE = /(\/thread\/[^/]+)\/full\/?$/u

/** `pathname` with a retired `/full` suffix dropped — the thread's drawer address. */
export function withoutFullPage(pathname: string): string {
  return pathname.replace(RETIRED_FULL_PAGE, "$1")
}
