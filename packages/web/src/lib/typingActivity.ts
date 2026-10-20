// WHEN THE HUMAN LAST TYPED, anywhere on the page. Background work that commits a large render — the drawer
// paging a long thread's history in behind the reader (ChatView EAGER HISTORY) — waits while this is recent,
// so a keystroke never lands behind one of its commits. Every text field counts, the prompt boxes above all,
// so one capture listener on the document answers for all of them rather than a hook in each.
let lastInputAt = Number.NEGATIVE_INFINITY

if (typeof document !== "undefined") {
  document.addEventListener("input", () => { lastInputAt = performance.now() }, { capture: true, passive: true })
}

/** Whether the human typed into any field on the page within the last `ms` milliseconds. */
export function typedWithin(ms: number): boolean {
  return performance.now() - lastInputAt < ms
}
