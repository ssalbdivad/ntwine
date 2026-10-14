import { useQuery } from "@tanstack/react-query"
import { rpc } from "../api/rpc.ts"

// THE one query definition every gh-gated surface shares (App's sign-in hint today), so their options
// can't drift apart.
//
// It deliberately overrides the app-wide `refetchOnWindowFocus: false` (main.tsx). This is the one
// query whose answer changes OUTSIDE the app: the user leaves for a terminal, runs `gh auth login`,
// and comes back. Nothing else re-asks — App's observer stays mounted for the life of the page, so
// the cache entry never goes inactive — and with focus-refetch off the page kept its page-load answer
// FOREVER. Measured 2026-08-04 against a live stack: server flipped to authed:true, the composer's GitHub icon (since
// removed) stayed absent for 15s and through focus/visibility events, and only a reload brought it back.
// `staleTime` throttles the refetch so a burst of tab switches can't spawn a `gh` per switch.
// (Signing in from ntwine's OWN terminal never blurs the window — that one still needs a reload.)
export function useGithubStatus() {
  return useQuery({
    queryKey: ["githubStatus"],
    queryFn: () => rpc.githubStatus(),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    // A NO IS NEVER FINAL — re-ask on a slow interval until it turns yes, then stop.
    //
    // Focus-refetch above covers "the user left, ran `gh auth login`, came back". It does NOT cover the
    // answer going wrong on its own while the tab sits open, and every probe behind this query can do
    // exactly that: they are subprocesses, and `gh repo view` is a live call to api.github.com. On
    // 2026-08-11 the network to GitHub dropped for nine minutes, the answer flipped to inRepo:false, and
    // that icon stayed gone in an open tab long after the network came back — a stuck NO outlives its
    // cause, because nothing re-asks a question already answered. The server-side half of that outage
    // is fixed (gitGithubRemote in packages/server/src/github.ts); this is the half that makes any
    // future false negative — a `gh` that timed out on a loaded machine, a keychain that was briefly
    // locked — heal itself instead of needing a reload nobody knows to do.
    //
    // Only while the answer is NO, so the steady state costs nothing: a yes stops the interval, and the
    // answer being yes is the signal that it is right. 60s because it is a subprocess and the cost of
    // being wrong for another minute is one stale hint, not a broken app.
    refetchInterval: (query) => {
      const status = query.state.data
      return status?.inRepo && status.authed ? false : 60_000
    },
  })
}
