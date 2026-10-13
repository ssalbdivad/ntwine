// DISCLOSURES: a `<details>` an author writes into Markdown is a collapsible section.
//
//   <details>
//   <summary>Full test output</summary>
//
//   …Markdown here…
//
//   </details>
//
// It is HTML's own element, and Markdown's own way to spell it: the same text collapses on GitHub and
// in every renderer that passes HTML through, and the browser does the opening and closing with no code
// here at all. What this file adds is the two things an HTML STRING cannot carry.
//
// WHETHER A SECTION IS OPEN is remembered per SUMMARY TEXT, for the life of the page. It has to live
// outside the DOM for the reason lib/codeTabs.ts gives for the open tab: a streaming message re-renders
// its whole block on every delta and the transcript unmounts rows as it virtualizes, and either would
// snap a section the reader opened shut again under them. The summary's text is the only identity a
// section has in an HTML string. An author's own `open` attribute is the default until the reader
// toggles.
//
// Read by the sanitizer's walk (lib/markdown.ts `restoreDisclosure`) and written by one delegated
// `toggle` listener (lib/toggle-disclosure.ts). No DOM is touched at module scope, so the memory is
// testable under `node --test`.

export const DISCLOSURE_LABEL_CLASS = "md-summary-label"

// Present on a `<details>` the sanitizer rendered OPEN, and it is how the listener tells the reader's
// toggle from the browser's own: inserting a `<details open>` into the page queues a `toggle` event
// exactly as a click does (the HTML spec fires it for the attribute appearing, however it appeared).
// Recorded as a choice, that echo would open every OTHER section sharing the summary on its next
// render, with the reader having touched nothing. `open` itself cannot carry this — it is the attribute
// the toggle rewrites.
export const DISCLOSURE_RENDERED_OPEN = "data-rendered-open"

const chosenOpen = new Map<string, boolean>()

export function rememberDisclosure(summary: string, open: boolean): void {
  chosenOpen.set(summary, open)
}

export function forgetDisclosures(): void {
  chosenOpen.clear()
}

/** The reader's choice for a section with this summary, or undefined while they have made none. */
export function chosenDisclosure(summary: string): boolean | undefined {
  return chosenOpen.get(summary)
}

function summaryOf(details: Element): Element | null {
  // The FIRST summary child is the one the browser treats as the section's label.
  for (const child of Array.from(details.children)) if (child.tagName.toLowerCase() === "summary") return child
  return null
}

/** A section's identity: its summary's text, whitespace collapsed. "" for a section with no summary. */
export function disclosureKey(details: Element): string {
  return (summaryOf(details)?.textContent ?? "").replace(/\s+/g, " ").trim()
}

/**
 * Finish a `<details>` the sanitizer has just walked: open it or close it, and wrap its label.
 *
 * Called AFTER the element's children are sanitized, so the summary text read here is the text the
 * listener will read off the live page.
 *
 * `open` is rewritten to the bare boolean form whatever the author wrote (`open="true"` is as open as
 * `open`), and the rendered-open mark is set here and nowhere else — after the allowlist loop has
 * already stripped any copy an author hand-wrote, which is the order that makes it trustworthy.
 *
 * THE LABEL IS WRAPPED so the summary can be a flex row of exactly two items, chevron and label
 * (styles.css `.md-body details > summary`). Unwrapped, every text run and inline element in a summary
 * would become a flex item of its own and `Full <code>test</code> output` would lose its spaces; the
 * alternative that needs no wrapper, a chevron hung in the line as an inline-block, leaves it stranded
 * on a line of its own when the label opens with a word wider than the column. The span is ours, minted
 * after the walk, so its class is not one an author can write: `span` is a class-filtered tag.
 */
export function restoreDisclosure(details: Element): void {
  const key = disclosureKey(details)
  const chosen = key ? chosenOpen.get(key) : undefined
  const open = chosen ?? details.hasAttribute("open")
  if (open) details.setAttribute("open", "")
  else details.removeAttribute("open")
  details.toggleAttribute(DISCLOSURE_RENDERED_OPEN, open)

  const summary = summaryOf(details)
  if (!summary) return
  const label = details.ownerDocument.createElement("span")
  label.className = DISCLOSURE_LABEL_CLASS
  while (summary.firstChild) label.append(summary.firstChild)
  summary.append(label)
}

/**
 * Record a `toggle` the page just saw on one of our sections. Returns whether it was the reader's.
 *
 * Ours means minted by `restoreDisclosure` — the app draws `<details>` of its own (the approval cards)
 * that this memory has no business in. The echo of an insertion is the one event dropped: the section
 * is in the state it was rendered in, and nobody has chosen anything for that summary yet.
 */
export function recordDisclosureToggle(details: HTMLDetailsElement): boolean {
  const summary = summaryOf(details)
  if (!summary?.querySelector(`:scope > .${DISCLOSURE_LABEL_CLASS}`)) return false
  const key = disclosureKey(details)
  if (!key) return false
  if (details.open === details.hasAttribute(DISCLOSURE_RENDERED_OPEN) && !chosenOpen.has(key)) return false
  chosenOpen.set(key, details.open)
  return true
}
