#!/usr/bin/env node
// Recover the reference's CENTRELINE and test whether the whole mark is one
// continuous stroke.
//
// Skeletonise the ink, find the free ends, then walk from one of them always
// taking the straightest continuation at every junction. If that walk covers
// the whole skeleton, the mark is a single unbroken spline and the "crossbar"
// is just its two tails. If it dead-ends early, it is two separate strokes.
// Either way the answer is measured rather than argued.

import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const fitDir = join(here, "fit")
mkdirSync(fitDir, { recursive: true })

const N = 512
const REF_SRC = "/Users/me/.ntwine/projects/029a30af-f126-40e3-b04c-d80e74e3e090/attachments/1786229519809-a8ae5c59-ef1bad9f-c28b-4a7a-9ede-0bf540f997b2.png"

const raw = execFileSync("magick", [REF_SRC, "-colorspace", "gray", "-resize", `${N}x${N}!`, "-depth", "8", "gray:-"], {
  maxBuffer: 1 << 28,
  encoding: "buffer",
})
let mask = new Uint8Array(N * N)
const THRESH = Number(process.env.THRESH ?? 90)
for (let i = 0; i < N * N; i += 1) mask[i] = raw[i] > THRESH ? 1 : 0

// ------------------------------------------------------------- Zhang-Suen thinning

const at = (m, x, y) => (x < 0 || y < 0 || x >= N || y >= N ? 0 : m[y * N + x])

function thin(src) {
  let m = Uint8Array.from(src)
  for (;;) {
    let removedAny = false
    for (const pass of [0, 1]) {
      const remove = []
      for (let y = 1; y < N - 1; y += 1) {
        for (let x = 1; x < N - 1; x += 1) {
          if (!at(m, x, y)) continue
          const p = [
            at(m, x, y - 1), at(m, x + 1, y - 1), at(m, x + 1, y), at(m, x + 1, y + 1),
            at(m, x, y + 1), at(m, x - 1, y + 1), at(m, x - 1, y), at(m, x - 1, y - 1),
          ]
          const b = p.reduce((a, v) => a + v, 0)
          if (b < 2 || b > 6) continue
          let a = 0
          for (let i = 0; i < 8; i += 1) if (p[i] === 0 && p[(i + 1) % 8] === 1) a += 1
          if (a !== 1) continue
          if (pass === 0) {
            if (p[0] * p[2] * p[4] !== 0) continue
            if (p[2] * p[4] * p[6] !== 0) continue
          } else {
            if (p[0] * p[2] * p[6] !== 0) continue
            if (p[0] * p[4] * p[6] !== 0) continue
          }
          remove.push(y * N + x)
        }
      }
      for (const i of remove) m[i] = 0
      if (remove.length) removedAny = true
    }
    if (!removedAny) break
  }
  return m
}

const skel = thin(mask)
const skelPixels = []
for (let i = 0; i < N * N; i += 1) if (skel[i]) skelPixels.push(i)

const NB = [
  [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
]
const neighbours = (i) => {
  const x = i % N
  const y = (i / N) | 0
  const out = []
  for (const [dx, dy] of NB) if (at(skel, x + dx, y + dy)) out.push((y + dy) * N + (x + dx))
  return out
}

const ends = skelPixels.filter((i) => neighbours(i).length === 1)
const junctions = skelPixels.filter((i) => neighbours(i).length >= 3)
console.log(`skeleton: ${skelPixels.length} px, ${ends.length} free ends, ${junctions.length} junction px`)
for (const e of ends) console.log(`  free end at (${e % N}, ${(e / N) | 0})`)

// -------------------------------------------------- walk, straightest-continuation

function walk(start) {
  const usedEdge = new Set()
  const edgeKey = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`)
  const path = [start]
  let prev = null
  let cur = start
  for (let step = 0; step < skelPixels.length * 4; step += 1) {
    const cx = cur % N
    const cy = (cur / N) | 0
    let dir = null
    if (prev !== null) {
      dir = [cx - (prev % N), cy - ((prev / N) | 0)]
      const n = Math.hypot(dir[0], dir[1]) || 1
      dir = [dir[0] / n, dir[1] / n]
    }
    const options = neighbours(cur).filter((n) => !usedEdge.has(edgeKey(cur, n)))
    if (!options.length) break
    let pick = options[0]
    if (dir) {
      let bestDot = -Infinity
      for (const o of options) {
        const ox = o % N
        const oy = (o / N) | 0
        const v = [ox - cx, oy - cy]
        const n = Math.hypot(v[0], v[1]) || 1
        const dot = (v[0] / n) * dir[0] + (v[1] / n) * dir[1]
        if (dot > bestDot) {
          bestDot = dot
          pick = o
        }
      }
    }
    usedEdge.add(edgeKey(cur, pick))
    path.push(pick)
    prev = cur
    cur = pick
  }
  return path
}

const path = walk(ends[0])
const covered = new Set(path)
const coverage = covered.size / skelPixels.length
const endX = path[path.length - 1] % N
const endY = (path[path.length - 1] / N) | 0
console.log(`\nwalk from (${ends[0] % N}, ${(ends[0] / N) | 0}):`)
console.log(`  ${path.length} steps, ends at (${endX}, ${endY})`)
console.log(`  covers ${covered.size}/${skelPixels.length} skeleton px = ${(coverage * 100).toFixed(1)}%`)
const finishedAtOtherEnd = ends.some((e) => e !== ends[0] && e === path[path.length - 1])
console.log(`  finished at the other free end: ${finishedAtOtherEnd}`)
console.log(
  coverage > 0.95 && finishedAtOtherEnd
    ? "\n=> ONE CONTINUOUS STROKE. The crossbar is this path's two tails."
    : "\n=> NOT a single stroke: the walk cannot cover the mark from one end to the other.",
)

// Resample the traced centreline to a manageable number of control points.
const pts = path.map((i) => [i % N, (i / N) | 0])
const K = Number(process.env.CONTROL_POINTS ?? 26)
const control = []
for (let k = 0; k < K; k += 1) control.push(pts[Math.round((k * (pts.length - 1)) / (K - 1))])
writeFileSync(join(fitDir, "traced-centreline.json"), JSON.stringify({ N, coverage, control, raw: pts }, null, 2))
console.log(`\nwrote fit/traced-centreline.json (${K} control points, ${pts.length} raw)`)
