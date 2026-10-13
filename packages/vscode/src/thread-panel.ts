// A THREAD IN AN EDITOR TAB — Claude Code's "open in new tab": the same Ntwine page the sidebar frames,
// opened on one thread in a webview panel, so a long conversation gets the editor's width beside the code.
// The sidebar stays the primary surface; this is the door for when it is too narrow to read in.
//
// One tab per thread: asking again for a thread that a tab already shows brings that tab forward. "Shows"
// is what the tab's page says it shows (its `ntwine:route`), not what it was opened on — a link to another
// thread followed inside the tab makes it that thread's, and a tab whose page went back to the queue
// (its drawer closed) is nobody's, and reads "Ntwine".
//
// It is a full frame, not a picture: the relay and its checks are the sidebar's (sidebar-html.ts
// frameDocument), and every page message is answered the way the sidebar answers it (framed-page.ts
// actOnPage) — code links open in the editor, the `@` menu lists the workspace, the context bar reads the
// editor, and a reply carries the editor block — except where a tab means something else:
//  - Ctrl+L pressed in the tab goes back to the code (the sidebar's runs "focus the active editor group",
//    which in a tab is the tab itself);
//  - a click on the tab's context bar adds to the TAB's box (framed-page.ts PageHost.addContext `into`).
// And the editor's own Ctrl+L comes to the tab when the tab is the Ntwine the human used last (app.ts).
//
// In the editor's colours (ntwine.matchEditorTheme, sidebar-html.ts § The editor's colours) as the sidebar is,
// but on the EDITOR's surface: a tab sits among the code's tabs, so its page takes the editor's background,
// not the side bar's.
//
// Restored after a window reload: the relay keeps `{ thread, project }` as the webview's state, and the
// serializer frames that thread again (activation event `onWebviewPanel:ntwine.thread`).
//
// Only `import type` from vscode, like app.ts.

import type * as vscode from "vscode"
import type { EmbedComposeMessage, EmbedComposedMessage, EmbedHostMessage, EmbedPageMessage, EmbedRouteMessage } from "@ntwine/shared/embed-protocol"
import { embedTheme, embedUrl, frameTarget, isSlug, parsePageMessage, threadEmbedUrl, threadOfHref, threadPath, type ComposeSidebar } from "./embed.ts"
import { actOnPage, Composes, type FrameLink, type PageHost } from "./framed-page.ts"
import { MATCH_THEME_SETTING } from "./sidebar.ts"
import { frameDocument, HINT, messageDocument, nonce } from "./sidebar-html.ts"

type Vscode = typeof vscode

export const THREAD_PANEL = "ntwine.thread"

/** As long as the sidebar gives a page to say it is ready before it offers Reload (sidebar.ts READY_HINT_MS). */
const READY_HINT_MS = 20_000
const EVENTS_KEPT = 50
/** A tab whose page shows no thread (it went back to the queue) — the product's name, as the sidebar's row reads. */
const NO_THREAD_TITLE = "Ntwine"
/** A tab with no Ntwine to frame yet (restored before discovery answered): it frames the page once there is one. */

export interface ThreadPanelsHost extends PageHost {
  /** Where Ntwine is: the connected origin, else the last discovery's. */
  origin(): string | undefined
  /** Ctrl+L pressed in a tab: back to the code the human came from. */
  backToEditor(): Promise<void>
  /** Open a page of Ntwine in the browser (the hint bar's Open in browser). */
  openInBrowser(url: string): void
}

/** A thread to show: its slug and its project's, as the page's routes spell them, and its name for the tab until the page says it. */
export interface ThreadTarget {
  thread: string
  project: string
  title?: string
}

/** One tab, as the extension can drive it (embed.ts composeInSidebar takes it as it takes the sidebar). */
export interface ThreadTab extends ComposeSidebar {
  /** On screen in its editor group. */
  visible(): boolean
  /** Post to the tab's page if it is ready; false if it is not, or the post failed. */
  post(message: EmbedHostMessage): Promise<boolean>
}

/** What a tab shows and did, for the end-to-end suite. */
export interface ThreadPanelSnapshot {
  /** The thread it shows, by its page's last route (or what it was opened on, before the page said). */
  thread?: string
  project: string
  /** The tab's title. */
  title: string
  ready: boolean
  visible: boolean
  active: boolean
  /** The frame's address, while it shows the page. */
  url?: string
  /** The copy it shows instead of the page. */
  message?: string
  /** The page's view by its last route, "" before one. */
  view: string
  viewColumn?: number
  events: { type: string; outcome: string }[]
}

export interface ThreadPanels {
  /** Show `target` in a tab: the one already showing it, brought forward, else a new one beside the code. */
  open(target: ThreadTarget): Promise<void>
  /** Some tab's page is ready. */
  anyReady(): boolean
  /** Called with true when a tab's page becomes ready, and false when one that was ready is gone. */
  onReady(listener: (ready: boolean) => void): void
  /** Post to every ready tab's page; true if any took it. */
  post(message: EmbedHostMessage): Promise<boolean>
  /** The extension's state the pages show changed: tell every ready one. */
  pushState(): void
  /** Ntwine may have moved (a new origin) or come back: frame again what shows another origin or none. */
  refresh(): void
  /** Called when a tab's page takes the keyboard: the human is using that tab. */
  onFocus(listener: (tab: ThreadTab) => void): void
  snapshot(): ThreadPanelSnapshot[]
}

interface Tab extends ThreadTab {
  panel: vscode.WebviewPanel
  project: string
  /** The thread it shows; undefined once its page shows none. */
  thread: string | undefined
  title: string
  frameUrl?: string
  frameOrigin?: string
  message?: string
  ready: boolean
  waiters: ((ready: boolean) => void)[]
  composes: Composes
  view: string
  mac: boolean
  events: { type: string; outcome: string }[]
  readyTimer?: NodeJS.Timeout
  renders: number
}

/** The state a tab's relay keeps for a restore: names only. Undefined for anything that is not one. */
export function restoredTarget(state: unknown): ThreadTarget | undefined {
  if (!state || typeof state !== "object") return undefined
  const { thread, project } = state as { thread?: unknown; project?: unknown }
  return isSlug(thread) && isSlug(project) ? { thread, project } : undefined
}

export function registerThreadPanels(api: Vscode, context: vscode.ExtensionContext, host: ThreadPanelsHost): ThreadPanels {
  const tabs = new Set<Tab>()
  const readyListeners: ((ready: boolean) => void)[] = []
  const focusListeners: ((tab: ThreadTab) => void)[] = []
  const theme = () => embedTheme(api.window.activeColorTheme.kind)
  const matchTheme = () => api.workspace.getConfiguration("ntwine").get<boolean>(MATCH_THEME_SETTING, true) !== false
  const icon = api.Uri.joinPath(context.extensionUri, "dist", "icon.png")

  const record = (tab: Tab, type: string, outcome: string) => {
    tab.events.push({ type, outcome })
    if (tab.events.length > EVENTS_KEPT) tab.events.shift()
  }

  async function postTo(tab: Tab, data: EmbedHostMessage | { view: "hint"; show: boolean; text?: string } | { view: "match-theme"; on: boolean }): Promise<boolean> {
    if (!tabs.has(tab) || !tab.frameUrl) return false
    try {
      return await tab.panel.webview.postMessage(data)
    } catch {
      return false
    }
  }

  function setReady(tab: Tab, next: boolean): void {
    const changed = next !== tab.ready
    tab.ready = next
    clearTimeout(tab.readyTimer)
    tab.readyTimer = undefined
    if (!next) tab.composes.drop()
    if (changed) for (const listener of readyListeners) listener(next)
    if (next || !tabs.has(tab) || !tab.frameUrl) {
      const waiting = tab.waiters
      tab.waiters = []
      for (const waiter of waiting) waiter(next)
    }
  }

  function setTitle(tab: Tab, title: string): void {
    tab.title = title
    if (tabs.has(tab)) tab.panel.title = title
  }

  function showMessage(tab: Tab, text: string): void {
    tab.frameUrl = undefined
    tab.frameOrigin = undefined
    setReady(tab, false)
    if (tab.message === text) return
    tab.message = text
    tab.panel.webview.html = messageDocument({ nonce: nonce(), text, actions: text === LOOKING ? [] : [{ action: "reload", label: "Reload" }] })
  }

  async function render(tab: Tab): Promise<void> {
    const origin = host.origin()
    if (!origin) return showMessage(tab, LOOKING)
    // A tab whose page left every thread (and is framed again: Reload, Ntwine on a new port) shows the
    // project's queue, as its page last did.
    const wanted = tab.thread ? threadEmbedUrl(origin, theme(), tab.project, tab.thread) : embedUrl(origin, theme(), tab.project)
    const generation = ++tab.renders
    let external: string
    try {
      // The address as the WINDOW reaches it: identity locally; under a remote window, the forwarded one.
      external = (await api.env.asExternalUri(api.Uri.parse(wanted))).toString(true)
    } catch {
      external = wanted
    }
    if (generation !== tab.renders || !tabs.has(tab)) return
    const target = frameTarget(wanted, external)
    if (target.kind === "remapped") return showMessage(tab, "Ntwine can't load in this window. Open it in your browser instead.")
    setReady(tab, false)
    tab.message = undefined
    tab.frameUrl = target.url
    tab.frameOrigin = target.origin
    tab.view = ""
    host.log.info(`A tab shows ${target.url}.`)
    tab.panel.webview.html = frameDocument({ nonce: nonce(), url: target.url, origin: target.origin, match: matchTheme(), surface: "editor", state: { project: tab.project, ...(tab.thread ? { thread: tab.thread } : {}) } })
    tab.readyTimer = setTimeout(() => {
      host.log.warn(`A tab's page didn't say it was ready within ${READY_HINT_MS / 1000}s.`)
      void postTo(tab, { view: "hint", show: true, text: HINT.text })
      const waiting = tab.waiters
      tab.waiters = []
      for (const waiter of waiting) waiter(false)
    }, READY_HINT_MS)
  }

  /**
   * Where the tab's page is. A thread: the tab is that thread's, titled as the page names it (VS Code does
   * not re-case a tab's title, as it does the sidebar's row). Anything else: nobody's, and "Ntwine".
   */
  function applyRoute(tab: Tab, route: EmbedRouteMessage): void {
    tab.view = route.view
    if (route.view === "thread") {
      const shown = threadOfHref(route.href)
      if (shown) {
        tab.thread = shown.thread
        tab.project = shown.project
      }
      setTitle(tab, route.title || tab.title)
    } else if (route.view === "queue") {
      tab.thread = undefined
      setTitle(tab, NO_THREAD_TITLE)
    }
  }

  async function onPageMessage(tab: Tab, link: FrameLink, page: EmbedPageMessage): Promise<void> {
    switch (page.type) {
      case "ntwine:ready":
        setReady(tab, true)
        record(tab, page.type, "ready")
        void postTo(tab, { view: "hint", show: false })
        void postTo(tab, { type: "ntwine:theme", theme: theme() })
        void postTo(tab, { type: "ntwine:host-state", ...host.hostState() })
        return
      case "ntwine:composed":
        record(tab, page.type, tab.composes.answer(page) ? (page.ok ? "ok" : `refused: ${page.error ?? ""}`) : "unknown id")
        return
      case "ntwine:route":
        applyRoute(tab, page)
        record(tab, page.type, page.view)
        return
      default:
        record(tab, page.type, await actOnPage(api, page, host, link))
    }
  }

  /** Take a panel — new, or restored after a reload — and frame its thread in it. */
  function adopt(panel: vscode.WebviewPanel, target: ThreadTarget): Tab {
    panel.webview.options = { enableScripts: true, localResourceRoots: [] }
    panel.iconPath = icon
    const tab: Tab = {
      panel,
      project: target.project,
      thread: target.thread,
      title: target.title ?? target.thread,
      ready: false,
      waiters: [],
      composes: new Composes(),
      view: "",
      mac: process.platform === "darwin",
      events: [],
      renders: 0,
      visible: () => tabs.has(tab) && panel.visible,
      async reveal(preserveFocus) {
        if (tabs.has(tab)) panel.reveal(panel.viewColumn, preserveFocus)
      },
      waitReady(ms) {
        if (tab.ready) return Promise.resolve(true)
        if (!tabs.has(tab)) return Promise.resolve(false)
        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            tab.waiters = tab.waiters.filter((waiter) => waiter !== done)
            resolve(false)
          }, ms)
          const done = (value: boolean) => {
            clearTimeout(timer)
            resolve(value)
          }
          tab.waiters.push(done)
        })
      },
      compose(input: Omit<EmbedComposeMessage, "type" | "id">, ms: number): Promise<EmbedComposedMessage | undefined> {
        if (!tab.ready) return Promise.resolve(undefined)
        return tab.composes.send((message) => postTo(tab, message), input, ms)
      },
      async post(message) {
        return tab.ready && (await postTo(tab, message))
      },
    }
    setTitle(tab, tab.title)
    tabs.add(tab)
    const link: FrameLink = {
      post: (message) => postTo(tab, message),
      mac: () => tab.mac,
      // Ctrl+L / ⌘L in the page is "back to the editor" (embed.ts CHORDS). The sidebar runs it as "focus the
      // active editor group"; from a tab, that group is the tab's own, and the keyboard would stay put.
      runChord: async (command) => {
        if (command === "workbench.action.focusActiveEditorGroup") await host.backToEditor()
        else await api.commands.executeCommand(command)
      },
      composer: (input, ms) => tab.compose(input, ms),
    }
    const listeners: vscode.Disposable[] = [
      panel.webview.onDidReceiveMessage((raw: unknown) => {
        if (!raw || typeof raw !== "object") return
        const envelope = raw as { view?: unknown; mac?: unknown; page?: unknown }
        if (typeof envelope.view === "string") {
          if (envelope.view === "platform") tab.mac = envelope.mac === true
          else if (envelope.view === "reload" || envelope.view === "retry") void render(tab)
          else if (envelope.view === "browser") {
            const origin = host.origin()
            if (origin && tab.thread) host.openInBrowser(new URL(threadPath(tab.project, tab.thread), origin).toString())
          } else if (envelope.view === "focused") for (const listener of focusListeners) listener(tab)
          return
        }
        if (!("page" in envelope) || !tab.frameUrl) return
        const page = parsePageMessage(envelope.page, tab.frameOrigin)
        if (!page) {
          const type = (envelope.page as { type?: unknown } | null)?.type
          record(tab, typeof type === "string" ? type.slice(0, 64) : typeof envelope.page, "ignored")
          return
        }
        onPageMessage(tab, link, page).catch((error: unknown) => host.log.warn(`A tab couldn't act on ${page.type}: ${(error as Error).message}`))
      }),
    ]
    // Which Ntwine the human used last (app.ts frontTab). The relay's `focused` alone is not enough here: a
    // click inside the page fires the relay window's focus only when focus comes from OUTSIDE its chain, and
    // a tab opened with the keyboard has its relay in the chain before the relay's script listens — the human
    // who opened a tab and clicked straight into its reply box was never counted (e2e-sidebar c19, 1 of 1).
    // VS Code's own reading covers it: the tab becoming the active editor is the human in it.
    listeners.push(panel.onDidChangeViewState(() => {
      if (panel.active) for (const listener of focusListeners) listener(tab)
    }))
    listeners.push(panel.onDidDispose(() => {
      tabs.delete(tab)
      clearTimeout(tab.readyTimer)
      setReady(tab, false)
      for (const listener of listeners) listener.dispose()
    }))
    void render(tab)
    return tab
  }

  context.subscriptions.push(
    api.window.registerWebviewPanelSerializer(THREAD_PANEL, {
      async deserializeWebviewPanel(panel, state) {
        const target = restoredTarget(state)
        if (!target) {
          panel.dispose()
          return
        }
        adopt(panel, target)
      },
    }),
    api.window.onDidChangeActiveColorTheme(() => {
      for (const tab of tabs) if (tab.ready) void postTo(tab, { type: "ntwine:theme", theme: theme() })
    }),
    // To each tab's relay, which holds the colours (sidebar.ts does the same for the sidebar's).
    api.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration(`ntwine.${MATCH_THEME_SETTING}`)) return
      for (const tab of tabs) void postTo(tab, { view: "match-theme", on: matchTheme() })
    }),
    { dispose: () => {
      for (const tab of tabs) clearTimeout(tab.readyTimer)
    } },
  )

  return {
    async open(target) {
      for (const tab of tabs) {
        if (tab.thread === target.thread && tab.project === target.project) {
          tab.panel.reveal(tab.panel.viewColumn, false)
          for (const listener of focusListeners) listener(tab)
          return
        }
      }
      // Beside the code when there is code in front, so the conversation and the file it is about are both
      // in sight; in the active group otherwise (nothing to keep beside).
      const column = api.window.activeTextEditor ? api.ViewColumn.Beside : api.ViewColumn.Active
      const panel = api.window.createWebviewPanel(THREAD_PANEL, target.title ?? target.thread, { viewColumn: column, preserveFocus: false }, {
        enableScripts: true,
        // A conversation, its drafts and its scroll survive the tab being in the background, as the
        // sidebar's do; a hidden webview is otherwise torn down and reloaded on every return.
        retainContextWhenHidden: true,
        localResourceRoots: [],
      })
      const tab = adopt(panel, target)
      // Opened with the keyboard in it: this tab is now the Ntwine used last.
      for (const listener of focusListeners) listener(tab)
    },
    anyReady: () => [...tabs].some((tab) => tab.ready),
    onReady(listener) {
      readyListeners.push(listener)
    },
    async post(message) {
      const results = await Promise.all([...tabs].filter((tab) => tab.ready).map((tab) => postTo(tab, message)))
      return results.some(Boolean)
    },
    pushState() {
      for (const tab of tabs) if (tab.ready) void postTo(tab, { type: "ntwine:host-state", ...host.hostState() })
    },
    refresh() {
      const origin = host.origin()
      for (const tab of tabs) {
        if (!origin) continue
        if (tab.frameOrigin === undefined || new URL(origin).port !== new URL(tab.frameOrigin).port) void render(tab)
      }
    },
    onFocus(listener) {
      focusListeners.push(listener)
    },
    snapshot: () => [...tabs].map((tab) => ({
      ...(tab.thread ? { thread: tab.thread } : {}),
      project: tab.project,
      title: tab.panel.title,
      ready: tab.ready,
      visible: tab.panel.visible,
      active: tab.panel.active,
      ...(tab.frameUrl ? { url: tab.frameUrl } : {}),
      ...(tab.message ? { message: tab.message } : {}),
      view: tab.view,
      ...(tab.panel.viewColumn ? { viewColumn: tab.panel.viewColumn } : {}),
      events: [...tab.events],
    })),
  }
}

const LOOKING = "Looking for Ntwine…"
