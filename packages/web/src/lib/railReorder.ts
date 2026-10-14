// THE ARITHMETIC OF DRAG-REORDERING A LIST, with no DOM in it.
//
// Pure and tested, so the project list (ProjectList.tsx) owns only the parts that genuinely need a
// browser: pointer capture, transforms, and the edge auto-scroll. It writes the machine's one order
// (`projectsReorder`). The list's groups are not uniform; see below.

/**
 * `list` with the item at `from` moved to `to`.
 *
 * Splice-out-then-splice-in, which is correct in both directions without a special case: removing
 * first renumbers everything after `from`, and `to` is expressed against the list the user is
 * LOOKING AT — which is the post-removal list, because the dragged square is not in its old slot.
 */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list]
  if (from < 0 || from >= next.length || to < 0 || to >= next.length || from === to) return next
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item!)
  return next
}

/**
 * How far square `index` must slide to make room, in px.
 *
 * Everything between the square's old slot and its new one shifts by exactly one step, towards the
 * gap the dragged square left behind. Squares outside that span do not move at all — which is what
 * makes a drag across a long list read as a local insertion rather than the whole list sliding.
 */
export function shiftFor(index: number, fromIndex: number, toIndex: number, step: number): number {
  if (index === fromIndex) return 0
  if (toIndex > fromIndex && index > fromIndex && index <= toIndex) return -step
  if (toIndex < fromIndex && index >= toIndex && index < fromIndex) return step
  return 0
}

/**
 * How fast to scroll the band when the pointer nears its edge, in px per frame.
 *
 * Without this a list is reorderable only within one screen of itself, which on a machine with
 * forty projects is not reorderable at all — the square you want to move to the top is usually not
 * on screen at the same time as the top. Ramps with depth into the zone so a small overshoot nudges
 * and a deliberate hold at the edge moves properly.
 */
export function edgeScrollVelocity(
  pointerY: number,
  bounds: { top: number; bottom: number },
  zone = 44,
  max = 14,
): number {
  const intoTop = bounds.top + zone - pointerY
  if (intoTop > 0) return -Math.min(max, (intoTop / zone) * max)
  const intoBottom = pointerY - (bounds.bottom - zone)
  if (intoBottom > 0) return Math.min(max, (intoBottom / zone) * max)
  return 0
}

// THE PROJECT LIST'S DRAG (ProjectList.tsx) — the same gesture over rows that are NOT uniform: a project
// row carries its threads under it, so one group is a single line and the next is twenty. The step
// arithmetic above cannot place those, so the list measures its groups once, when the drag starts, and
// hit-tests against that snapshot.

/** One group's box at the moment the drag started, in any consistent coordinate space. */
export interface ListBox {
  top: number
  height: number
}

/**
 * Which slot the held group is over, from its own displacement (rather than the pointer's, so the drop does not depend on where inside the group you grabbed it).
 *
 * By the held group's LEADING EDGE against each neighbour's midpoint — its bottom edge going down, its
 * top going up. Its centre would be the uniform rule, but a project with twenty threads under it would
 * then have to travel half its own height before it passed a one-line neighbour; the edge swaps the
 * moment it visibly covers half of the row it is passing, whatever either one's size.
 */
export function listDropIndex(boxes: readonly ListBox[], fromIndex: number, deltaY: number): number {
  const held = boxes[fromIndex]
  if (!held) return fromIndex
  const top = held.top + deltaY
  const bottom = top + held.height
  let to = fromIndex
  for (let index = fromIndex + 1; index < boxes.length; index++) {
    if (bottom > boxes[index]!.top + boxes[index]!.height / 2) to = index
  }
  for (let index = fromIndex - 1; index >= 0; index--) {
    if (top < boxes[index]!.top + boxes[index]!.height / 2) to = index
  }
  return to
}

/**
 * How far the held group's neighbours slide to make room: its own height plus the gap one group keeps
 * from the next — the space it leaves behind, which is the space the neighbours close. Read off the boxes
 * rather than assumed, so the list's spacing lives in its classes and nowhere else.
 */
export function listPitch(boxes: readonly ListBox[], fromIndex: number): number {
  const held = boxes[fromIndex]
  if (!held) return 0
  const next = boxes[fromIndex + 1]
  const previous = boxes[fromIndex - 1]
  const gap = next ? next.top - (held.top + held.height) : previous ? held.top - (previous.top + previous.height) : 0
  return held.height + Math.max(0, gap)
}

/**
 * The machine-wide order, with `id` moved to sit where the operator dropped it among `section` — the
 * run of projects they could SEE, which is only part of the whole (the list splits busy projects from
 * quiet ones, each run in the machine-wide order).
 *
 * Placed by NEIGHBOUR, not by index: the id lands just before the section project it was dropped above,
 * or just after the one it was dropped below when it went to the end. Every project outside the section
 * keeps its place relative to everything else, which is what an index into the full list could not say.
 */
export function placeAmong(order: readonly string[], section: readonly string[], fromIndex: number, toIndex: number): string[] {
  const id = section[fromIndex]
  if (id === undefined || fromIndex === toIndex || !order.includes(id)) return [...order]
  const moved = moveItem(section, fromIndex, toIndex)
  const rest = order.filter((candidate) => candidate !== id)
  const after = moved[toIndex + 1]
  const before = moved[toIndex - 1]
  const at = after !== undefined && rest.includes(after)
    ? rest.indexOf(after)
    : before !== undefined && rest.includes(before)
      ? rest.indexOf(before) + 1
      : -1
  if (at < 0) return [...order]
  rest.splice(at, 0, id)
  return rest
}
