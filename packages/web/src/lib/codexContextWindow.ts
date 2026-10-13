import type { CodexModel } from "@ntwine/shared"

// Codex accepts intermediate windows, not just the catalogue's default and maximum. Offer 472k and
// 672k between those endpoints. Unset still means the model's own default; a stored custom value stays
// visible. Labels put the value first, matching the Claude compaction picker.

export const CODEX_CONTEXT_WINDOW_DEFAULT = "default"

export interface CodexContextWindowOption {
  value: string
  label: string
}

// 272000 → "272k", 872000 → "872k", 1000000 → "1M", 1250000 → "1.25M". Whole thousands are what the
// catalogue carries; the decimal survives only when the value is not a round number of thousands.
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M`
  if (n >= 1_000) return `${trim(n / 1_000)}k`
  return String(n)
}

function trim(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")
}

// The catalogue as shipped in the fallback (or before the window fields existed) carries no numbers at
// all. Rather than a drawer with nothing to raise, offer the one maximum measured on 2026-09-11 so the
// control still works; the label says what it is.
const FALLBACK_LADDER: readonly { value: number; models: readonly string[] }[] = [{ value: 872_000, models: [] }]

export function codexContextWindowOptions(models: readonly CodexModel[] | undefined, stored: number | undefined): CodexContextWindowOption[] {
  const listed = models ?? []
  // The default model (index 0 = codex's own priority 1) names the number "Model default" runs at.
  const lead = listed.find((m) => m.contextWindow !== undefined)
  const stock = lead?.contextWindow ?? 272_000
  const defaultLabel = `${formatTokens(stock)} (default)`

  const raises = new Map<number, string[]>()
  for (const m of listed) {
    if (m.maxContextWindow === undefined || m.contextWindow === undefined) continue
    if (m.maxContextWindow <= m.contextWindow) continue
    raises.set(m.maxContextWindow, [...(raises.get(m.maxContextWindow) ?? []), m.displayName])
  }
  const ladder = raises.size
    ? [...raises.entries()].sort((a, b) => a[0] - b[0]).map(([value, names]) => ({ value, models: names }))
    : FALLBACK_LADDER

  const options: CodexContextWindowOption[] = [{ value: CODEX_CONTEXT_WINDOW_DEFAULT, label: defaultLabel }]
  for (const step of ladder) {
    // One raise shared by every raisable model is simply "the maximum"; several distinct maxima name
    // their models so the reader knows which one a given number applies to.
    const suffix = ladder.length === 1 || step.models.length === 0 ? "maximum" : `${step.models.join(", ")} maximum`
    options.push({ value: String(step.value), label: `${formatTokens(step.value)} (${suffix})` })
  }
  for (const value of [472_000, 672_000]) {
    if (value > stock && ladder.some((step) => step.value > value) && !options.some((o) => o.value === String(value))) {
      options.push({ value: String(value), label: formatTokens(value) })
    }
  }
  if (stored !== undefined && !options.some((o) => o.value === String(stored))) {
    options.push({ value: String(stored), label: formatTokens(stored) })
  }
  return [options[0]!, ...options.slice(1).sort((a, b) => Number(a.value) - Number(b.value))]
}
