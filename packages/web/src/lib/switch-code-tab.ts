import {
  CODE_PANEL_CLASS,
  CODE_TAB_ACTIVE_CLASS,
  CODE_TAB_CLASS,
  CODE_TABLIST_CLASS,
  CODE_TABS_CLASS,
  rememberCodeTab,
} from "./codeTabs.ts"

// One delegated listener for every code-tab group in every sanitized markdown surface, for the reason
// lib/copy-code.ts is delegated: the group is injected as an HTML string (lib/codeTabs.ts), so there is
// no React element to hang a handler on, and the transcript rebuilds those nodes as it re-renders.
//
// The click moves the live DOM itself and records the choice (rememberCodeTab), which is what the next
// render of the same labels opens on. Nothing re-renders for it, so the reader's selection and scroll
// position are left alone.
export function installCodeTabInterceptor(): () => void {
  const tabOf = (target: EventTarget | null) =>
    target instanceof Element ? target.closest<HTMLElement>(`.${CODE_TAB_CLASS}`) : null

  const click = (event: MouseEvent) => {
    if (event.button !== 0 || event.defaultPrevented) return
    const tab = tabOf(event.target)
    if (!tab) return
    event.preventDefault()
    event.stopPropagation()
    openCodeTab(tab)
  }

  // The keys a tablist is expected to answer: arrows step and wrap, Home and End jump. Selection
  // follows focus, as it does on every tab strip whose panels are already in the page.
  const keydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return
    const tab = tabOf(event.target)
    if (!tab) return
    const tabs = tabsOf(tab)
    const at = tabs.indexOf(tab)
    const to = event.key === "ArrowRight" ? (at + 1) % tabs.length
      : event.key === "ArrowLeft" ? (at - 1 + tabs.length) % tabs.length
      : event.key === "Home" ? 0
      : event.key === "End" ? tabs.length - 1
      : -1
    if (to < 0 || to === at) return
    event.preventDefault()
    tabs[to].focus()
    openCodeTab(tabs[to])
  }

  document.addEventListener("click", click)
  document.addEventListener("keydown", keydown)
  return () => {
    document.removeEventListener("click", click)
    document.removeEventListener("keydown", keydown)
  }
}

function tabsOf(tab: HTMLElement): HTMLElement[] {
  return [...(tab.closest(`.${CODE_TABLIST_CLASS}`)?.querySelectorAll<HTMLElement>(`.${CODE_TAB_CLASS}`) ?? [])]
}

function openCodeTab(tab: HTMLElement) {
  const group = tab.closest(`.${CODE_TABS_CLASS}`)
  if (!group) return
  const tabs = tabsOf(tab)
  const panels = [...group.querySelectorAll<HTMLElement>(`:scope > .${CODE_PANEL_CLASS}`)]
  const index = tabs.indexOf(tab)
  // A group whose tabs and panels disagree is not one this file minted; leave it as it is.
  if (index < 0 || tabs.length !== panels.length) return
  for (const [i, each] of tabs.entries()) {
    each.classList.toggle(CODE_TAB_ACTIVE_CLASS, i === index)
    each.setAttribute("aria-selected", String(i === index))
  }
  for (const [i, panel] of panels.entries()) panel.classList.toggle(CODE_TAB_ACTIVE_CLASS, i === index)
  // A tab scrolled half out of an overflowing strip comes fully into it; `nearest` leaves the page still.
  tab.scrollIntoView({ block: "nearest", inline: "nearest" })
  rememberCodeTab(tabs.map((each) => each.textContent ?? ""), tab.textContent ?? "")
}
