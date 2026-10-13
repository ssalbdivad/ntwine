// DEV-ONLY render instrumentation, opt-in via `?scan=1`.
//
// NOTHING IN THE APP IMPORTS THIS FILE. It is loaded as its own `<script type="module">`, injected
// into the head ahead of main.tsx by the `ntwine:dev-render-scan` Vite plugin, which is `apply:
// "serve"` — so this module and everything it drags in (react-scan, react-grab, preact, bippy:
// 185,755 bytes of entry chunk, measured 2026-09-04) exist in dev and are absent from the production
// graph by construction rather than by tree-shaking. main.tsx imported it until 2026-09-04 and
// shipped all of that to every user, because the `import.meta.env.DEV` guard below sits inside the
// function while the import sat at the top.
//
// It is a separate script rather than a lazy import because react-scan side-effect-imports bippy,
// which installs `__REACT_DEVTOOLS_GLOBAL_HOOK__`, and react-dom reads that global once at its own
// module scope. `await import("react-scan")` therefore always loses the race — see the long note on
// the plugin in vite.config.ts.
//
// It answers one question we otherwise can only guess at: when opening a thread drawer, WHICH
// components render, how many times, and how much of that was avoidable? Results land on
// `window.__ntwineScan` for a CDP routine to read back.
import { scan } from "react-scan"

interface ScanRecord {
  count: number
  selfTimeMs: number
  unnecessary: number
  // How many of those renders react-scan actually JUDGED. `Render.unnecessary` is `null` — not `false` —
  // whenever `trackUnnecessaryRenders` is off, so counting only the truthy ones cannot tell "nothing was
  // avoidable" apart from "nothing was measured". Both report 0. Carry the denominator so a dump that
  // says `unnecessary: 0` can be trusted only when `judged` equals `count`.
  judged: number
}

declare global {
  interface Window {
    __ntwineScan?: {
      records: Map<string, ScanRecord>
      reset(): void
      dump(limit?: number): { name: string; count: number; selfTimeMs: number; unnecessary: number; judged: number }[]
      totals(): { components: number; renders: number; selfTimeMs: number; unnecessary: number; judged: number }
    }
  }
}

function installRenderScan(): void {
  if (!import.meta.env.DEV) return
  if (typeof window === "undefined") return
  if (!new URLSearchParams(window.location.search).has("scan")) return

  const records = new Map<string, ScanRecord>()
  window.__ntwineScan = {
    records,
    reset: () => records.clear(),
    dump: (limit = 40) =>
      [...records.entries()]
        .map(([name, r]) => ({ name, count: r.count, selfTimeMs: Math.round(r.selfTimeMs), unnecessary: r.unnecessary, judged: r.judged }))
        .sort((a, b) => b.count - a.count)
        .slice(0, limit),
    totals: () => {
      let renders = 0, selfTimeMs = 0, unnecessary = 0, judged = 0
      for (const r of records.values()) { renders += r.count; selfTimeMs += r.selfTimeMs; unnecessary += r.unnecessary; judged += r.judged }
      return { components: records.size, renders, selfTimeMs: Math.round(selfTimeMs), unnecessary, judged }
    },
  }

  scan({
    enabled: true,
    log: false,
    showToolbar: false,
    // ASKS FOR THE `unnecessary` COLUMN, AND AS OF react-scan 0.5.7 DOES NOT GET IT. The library emits
    // `unnecessary: TRACK_UNNECESSARY_RENDERS ? isRenderUnnecessary(fiber) : null`, and its shipped
    // bundle declares `var TRACK_UNNECESSARY_RENDERS = false` as a module constant that nothing ever
    // assigns from options — so this flag is inert and every render arrives judged `null`. 0.5.7 is the
    // newest published version (checked 2026-08-01), so there is nothing to upgrade to.
    //
    // The option stays because the intent is right and a future release may wire it up; `judged` is what
    // makes that safe. Read `judged`, not `unnecessary`: while it is 0 the avoidable-render question is
    // UNMEASURED, and a dump reporting `unnecessary: 0` says nothing at all.
    trackUnnecessaryRenders: true,
    onRender(fiber, renders) {
      const name = (fiber.type as { displayName?: string; name?: string } | null)?.displayName
        ?? (fiber.type as { name?: string } | null)?.name
        ?? "<anonymous>"
      let record = records.get(name)
      if (!record) { record = { count: 0, selfTimeMs: 0, unnecessary: 0, judged: 0 }; records.set(name, record) }
      for (const render of renders) {
        record.count += render.count ?? 1
        record.selfTimeMs += render.time ?? 0
        if (render.unnecessary === null) continue // not judged — see ScanRecord.judged
        record.judged += render.count ?? 1
        if (render.unnecessary) record.unnecessary += render.count ?? 1
      }
    },
  })
}

// Self-installing: this module IS the entry point, so there is no caller to do it.
installRenderScan()
