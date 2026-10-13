import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { useEffect } from "react"
import { useLocation } from "react-router"
import { rpc } from "../api/rpc.ts"

/**
 * The last answer the server gave, so the FIRST paint can be the right one.
 *
 * `projectRail` lives in server settings, which arrive an RPC round trip after React's first render.
 * Without a local copy the rail was absent for that render and then appeared, pushing every page
 * 57px to the right in front of the operator on every refresh (maintainer 2026-08-25: "This is
 * layout shift"). Same problem, same cure as the font: `index.html` reads `ntwine-font` from
 * localStorage before first paint, and `font.ts` writes it back whenever settings load. Wrong only on
 * the first load in a fresh browser profile — and wrong in the direction the server default is.
 */
const MIRROR_KEY = "ntwine-project-rail"

function readMirror(): boolean {
  try {
    return localStorage.getItem(MIRROR_KEY) === "shown"
  } catch {
    return false
  }
}

function writeMirror(shown: boolean) {
  try {
    localStorage.setItem(MIRROR_KEY, shown ? "shown" : "hidden")
  } catch {
    // storage unavailable — the next load falls back to hidden, the server default
  }
}

/**
 * Whether the permanent project rail is showing.
 *
 * ONE definition, because two surfaces depend on it and they must never both be absent: the rail
 * itself, and the status bar's home crumb, which exists precisely to be the way back when the rail
 * is not there. While the query is still in flight it answers with the localStorage mirror above,
 * which is the server's last answer in this browser; before the mirror existed it defaulted to
 * HIDDEN, and every refresh with the rail on shifted the whole page once the answer arrived.
 *
 * THE CACHE ENTRY IS PER PROJECT, AND THIS HOOK OUTLIVES A PROJECT. `["settingsGet"]` hashes under
 * the project the URL names at RENDER time (lib/queryKeyScope.ts), and the layout that calls this
 * hook is mounted once and never re-rendered by a navigation — so without the `useLocation()` below
 * it stayed bound to whichever project's entry it was cold-loaded on. The settings drawer writes its
 * save under the CURRENT project's entry. Cold-load `/`,
 * click into a project, flip "Project sidebar" to "Always shown": the select flipped and the rail
 * did not, until a reload happened to land on a board (maintainer 2026-08-24: "it literally only
 * shows up when I'm in the home page"). Reading the location re-renders this on every navigation,
 * so the key re-hashes under the project now on screen — the same entry the drawer writes.
 *
 * A navigation is not the only switch, though. On All projects the prompt box's picker moves the page to
 * another project at `/all` — no navigation, so no re-render here — and the hook stays on the entry it
 * was cold-loaded under. So a save also publishes its machine keys to EVERY project's entry
 * (hooks/useSettingsAutosave.tsx publishMachineSettings), and whichever entry this reads has the flip.
 * (The fork's own finding, 2026-09-28; it went with the fork's rail on 2026-09-30 and came back with
 * upstream's on 2026-10-06.)
 *
 * `keepPreviousData` is what keeps that re-hash from blinking: the new project's entry starts empty
 * and the rail would drop out for the round trip. `projectRail` is a MACHINE setting (server
 * settings.ts), so the previous project's answer is the right placeholder, not merely a tolerable one.
 */
export function useProjectRailVisible(): boolean {
  useLocation()
  const settings = useQuery({
    queryKey: ["settingsGet"],
    queryFn: () => rpc.settingsGet(),
    placeholderData: keepPreviousData,
  })
  const fromServer = settings.data?.projectRail
  // The drawer's save lands in this same cache entry (`setQueryData(["settingsGet"], saved)`), so
  // this re-runs on a flip as well as on a load — the mirror tracks every answer, not just the first.
  useEffect(() => {
    if (fromServer !== undefined) writeMirror(fromServer === true)
  }, [fromServer])
  return fromServer === undefined ? readMirror() : fromServer === true
}
