import { useEffect, useRef } from "react"

// THE LISTENING GLYPH: four bars where the microphone was, each following the live level of one band
// of the microphone's spectrum, so they move when the operator speaks and settle when they stop. Drawn
// on Lucide's grid (24-unit viewBox, 2-unit round strokes) with the microphone's own ink width — x 4 to
// 20 — so swapping one for the other keeps the rail's measured spacing (lib/iconRhythm.ts).
//
// The bars are written straight to the DOM from an animation frame, never through React state: a
// re-render sixty times a second would re-render the whole composer with them.

// Each bar: its x, its full length, and the band (Hz) that drives it — fundamentals, then the vowel
// formants where most speech energy sits (on the tallest bar), then consonants.
const BARS: ReadonlyArray<{ x: number; y1: number; y2: number; band: readonly [number, number] }> = [
  { x: 5, y1: 7, y2: 17, band: [100, 300] },
  { x: 9.67, y1: 4, y2: 20, band: [300, 900] },
  { x: 14.33, y1: 6, y2: 18, band: [900, 2200] },
  { x: 19, y1: 8, y2: 16, band: [2200, 5000] },
]
// A silent bar keeps this share of its length, so the glyph never disappears.
const REST = 0.3

export function DictationLevel({ stream, size = 15 }: { stream: MediaStream; size?: number }) {
  const barsRef = useRef<Array<SVGLineElement | null>>([])
  useEffect(() => {
    const ctx = new AudioContext()
    const source = ctx.createMediaStreamSource(stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 1024
    analyser.smoothingTimeConstant = 0.75
    // Conversational speech into a laptop microphone sits roughly here; quieter is floor, louder is full.
    analyser.minDecibels = -85
    analyser.maxDecibels = -30
    source.connect(analyser)
    const bins = new Uint8Array(analyser.frequencyBinCount)
    const binHz = ctx.sampleRate / analyser.fftSize
    const ranges = BARS.map(({ band: [lo, hi] }) => [Math.max(1, Math.floor(lo / binHz)), Math.max(2, Math.ceil(hi / binHz))] as const)
    let frame = 0
    const tick = () => {
      analyser.getByteFrequencyData(bins)
      ranges.forEach(([from, to], i) => {
        let sum = 0
        for (let k = from; k < to; k++) sum += bins[k]
        const level = sum / (to - from) / 255
        barsRef.current[i]?.style.setProperty("transform", `scaleY(${REST + (1 - REST) * level})`)
      })
      frame = requestAnimationFrame(tick)
    }
    tick()
    return () => {
      cancelAnimationFrame(frame)
      source.disconnect()
      void ctx.close()
    }
  }, [stream])
  return (
    <svg
      data-dictation-level
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden
    >
      {BARS.map((bar, i) => (
        <line
          key={bar.x}
          ref={(el) => { barsRef.current[i] = el }}
          x1={bar.x}
          x2={bar.x}
          y1={bar.y1}
          y2={bar.y2}
          style={{ transformBox: "fill-box", transformOrigin: "center", transform: `scaleY(${REST})` }}
        />
      ))}
    </svg>
  )
}
