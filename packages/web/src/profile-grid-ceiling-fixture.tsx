import { createRoot } from "react-dom/client"
import { useState } from "react"
import type { CodexModel } from "@ntwine/shared"
import { ProfileGridSelector } from "./components/ProfileGridSelector.tsx"
import { dispatchProfileGroups } from "./lib/dispatchPreferences.ts"
import "./styles.css"

// The profile matrix rendered with BOTH ladders loaded — the only state in which the ceiling column is
// contested: codex spells its top rung "ultra", Claude Code spells it "ultracode". Give them a column
// each and every Claude row ghosts a hole where codex's "ultra" sits, which floated ULTRACODE a full
// empty column clear of MAX. They are one rung and share one column.
//
// TWO FONTS: the prose/UI font is a user setting, so this fixture takes `?font=mono` and defaults to
// `sans` (index.html's own default). A fixture that leaves `data-font` unset silently renders mono.

const font = new URLSearchParams(location.search).get("font") === "mono" ? "mono" : "sans"
document.documentElement.dataset.font = font

// Real shapes: a full-ladder codex model that reaches "ultra", and a short one that stops early — the
// short row must still hold every column it does not fill.
const codexModels: CodexModel[] = [
  { slug: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", defaultEffort: "medium", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  { slug: "gpt-5.3-codex-spark", displayName: "GPT-5.3-Codex-Spark", defaultEffort: "low", efforts: ["low", "medium"] },
]

const groups = dispatchProfileGroups(codexModels)

function Fixture() {
  const [profile, setProfile] = useState({ provider: "claude", model: "opus", effort: "high" })
  return (
    <main className="flex min-h-screen items-start justify-center bg-bg p-6">
      <section className="w-[min(560px,100%)] rounded-lg border border-border bg-panel p-5 shadow-xl">
        <p className="mb-2 text-[11px] text-muted">Both ladders loaded — {font}</p>
        <h1 className="mb-4 text-[15px] font-semibold text-fg">Ultra and ultracode share the ceiling column</h1>
        <ProfileGridSelector
          groups={groups}
          value={profile}
          onValueChange={setProfile}
          ariaLabel="Thread model and effort"
          menuAriaLabel="Choose model and effort"
          className="w-full"
        />
      </section>
    </main>
  )
}

createRoot(document.getElementById("root")!).render(<Fixture />)
