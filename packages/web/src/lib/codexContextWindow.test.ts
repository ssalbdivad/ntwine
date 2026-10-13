import assert from "node:assert/strict"
import test from "node:test"
import type { CodexModel } from "@ntwine/shared"
import { CODEX_CONTEXT_WINDOW_DEFAULT, codexContextWindowOptions, formatTokens } from "./codexContextWindow.ts"

const model = (slug: string, displayName: string, contextWindow?: number, maxContextWindow?: number): CodexModel => ({
  slug, displayName, defaultEffort: "medium", efforts: ["medium"],
  ...(contextWindow === undefined ? {} : { contextWindow }),
  ...(maxContextWindow === undefined ? {} : { maxContextWindow }),
})

// The catalogue on 2026-09-11 (codex-cli 0.153.2), in codex's own priority order.
const CATALOGUE: CodexModel[] = [
  model("gpt-6-astra", "GPT-6-Astra", 272_000, 872_000),
  model("gpt-5.6-sol", "GPT-5.6-Sol", 272_000, 872_000),
  model("gpt-5.6-terra", "GPT-5.6-Terra", 272_000, 872_000),
  model("gpt-5.6-luna", "GPT-5.6-Luna", 272_000, 872_000),
  model("gpt-5.5", "GPT-5.5", 272_000, 272_000),
  model("gpt-5.3-codex-spark", "GPT-5.3-Codex-Spark", 128_000, 128_000),
]

test("value-first presets include intermediate windows between the catalogue endpoints", () => {
  assert.deepEqual(codexContextWindowOptions(CATALOGUE, undefined), [
    { value: CODEX_CONTEXT_WINDOW_DEFAULT, label: "272k (default)" },
    { value: "472000", label: "472k" },
    { value: "672000", label: "672k" },
    { value: "872000", label: "872k (maximum)" },
  ])
  assert.ok(!codexContextWindowOptions(CATALOGUE, undefined).some((o) => /800k|1M/.test(o.label)))
})

test("a model whose maximum equals its stock window contributes no preset — a raise would change nothing for it", () => {
  const opts = codexContextWindowOptions([model("gpt-5.5", "GPT-5.5", 272_000, 272_000), model("spark", "Spark", 128_000, 128_000)], undefined)
  // Nothing raisable ⇒ the measured 872k fallback keeps the control usable, labelled as the maximum.
  assert.deepEqual(opts.map((o) => o.value), [CODEX_CONTEXT_WINDOW_DEFAULT, "472000", "672000", "872000"])
  assert.equal(opts[0]!.label, "272k (default)")
})

test("several distinct maxima each name the models they apply to", () => {
  const opts = codexContextWindowOptions([
    model("a", "Alpha", 272_000, 872_000),
    model("b", "Beta", 272_000, 1_000_000),
    model("c", "Gamma", 272_000, 872_000),
  ], undefined)
  assert.deepEqual(opts.slice(1), [
    { value: "472000", label: "472k" },
    { value: "672000", label: "672k" },
    { value: "872000", label: "872k (Alpha, Gamma maximum)" },
    { value: "1000000", label: "1M (Beta maximum)" },
  ])
})

test("no catalogue numbers at all (the fallback model, or an old cache) still offers the default and the measured maximum", () => {
  assert.deepEqual(codexContextWindowOptions([model("gpt-5.5", "GPT-5.5")], undefined), [
    { value: CODEX_CONTEXT_WINDOW_DEFAULT, label: "272k (default)" },
    { value: "472000", label: "472k" },
    { value: "672000", label: "672k" },
    { value: "872000", label: "872k (maximum)" },
  ])
  assert.deepEqual(codexContextWindowOptions(undefined, undefined).map((o) => o.value), [CODEX_CONTEXT_WINDOW_DEFAULT, "472000", "672000", "872000"])
})

test("a stored custom value stays visible and sorted without duplicating presets", () => {
  const opts = codexContextWindowOptions(CATALOGUE, 500_000)
  assert.deepEqual(opts[2], { value: "500000", label: "500k" })
  // …but a stored value that IS a preset is not duplicated.
  assert.equal(codexContextWindowOptions(CATALOGUE, 872_000).length, 4)
  assert.equal(codexContextWindowOptions(CATALOGUE, 672_000).length, 4)
})

test("intermediate presets respect changed catalogue endpoints and never duplicate a maximum", () => {
  assert.deepEqual(codexContextWindowOptions([model("a", "Alpha", 500_000, 672_000)], undefined), [
    { value: CODEX_CONTEXT_WINDOW_DEFAULT, label: "500k (default)" },
    { value: "672000", label: "672k (maximum)" },
  ])
})

test("formatTokens spells the catalogue's numbers the way the dial does", () => {
  assert.equal(formatTokens(272_000), "272k")
  assert.equal(formatTokens(872_000), "872k")
  assert.equal(formatTokens(1_000_000), "1M")
  assert.equal(formatTokens(1_250_000), "1.25M")
  assert.equal(formatTokens(258_400), "258.4k")
  assert.equal(formatTokens(950), "950")
})
