// THE NTWINE SIDEBAR — a view in its own activity-bar container that IS the ntwine page: one iframe of the
// discovered origin, `?embed=vscode&theme=…&project=…`, relayed to the extension by a script in the
// webview document (sidebar-html.ts). The queue, the threads and the composers are the app's own, live
// over its own socket; what this file adds is what a frame cannot do for itself — keys VS Code would
// otherwise never see, files and links opened in the editor, VS Code's theme, the Ready badge, the
// editor commands' selections put straight into a composer, and the HEADER: the page draws none in the
// sidebar, so VS Code's own title row above the frame carries the header's doors (`ntwine:command`), shown
// by the page's view (`ntwine:route` → the `ntwine.sidebarView` context key), and the badge's tooltip carries
// its counts. Design: ARCHITECTURE.md § VS Code extension; the wire:
// packages/shared/src/embed-protocol.ts; the pure rules: embed.ts.
//
// Only `import type` from vscode, like app.ts.

import type * as vscode from "vscode"
import type {
  EmbedCommandMessage,
  EmbedComposeMessage,
  EmbedComposedMessage,
  EmbedEditorContextMessage,
  EmbedEditorExtrasMessage,
  EmbedHostMessage,
  EmbedNavigateMessage,
  EmbedPageMessage,
  EmbedRouteMessage,
} from "@ntwine/shared/embed-protocol"
import { embedTheme, embedUrl, frameTarget, parsePageMessage } from "./embed.ts"
import { actOnPage, Composes, type FrameLink, type PageHost } from "./framed-page.ts"
import { frameDocument, HINT, HINT_OLD_NTWINE, messageDocument, nonce, type ViewAction } from "./sidebar-html.ts"

type Vscode = typeof vscode

export const SIDEBAR_VIEW = "ntwine.sidebar"
/** The command VS Code generates for every view: reveal it, open it if it never was, and focus it. */
export const SIDEBAR_FOCUS = `${SIDEBAR_VIEW}.focus`
/**
 * The context key the title row's buttons show by: the page's view ("queue", "thread", "settings",
 * "other"), or "" while no page has said where it is — a loading or missing page, whose buttons could
 * do nothing.
 */
export const SIDEBAR_VIEW_KEY = "ntwine.sidebarView"

/**
 * How long a page gets to say `ntwine:ready` before the view offers Reload. An installed ntwine boots its
 * page in a second or two; an ntwine run from source serves ~250 unbundled modules through Vite, which took
 * 13s and 42s to load on a busy machine (scripts/e2e-sidebar.ts, 2026-10-01) — and offered Reload under
 * a page that was only slow. An older ntwine, which has no embed mode, never says it, and its page still
 * shows under the bar.
 */
/** `ntwine.matchEditorTheme` (package.json): the page in the editor's colours rather than ntwine's palette. */
export const MATCH_THEME_SETTING = "matchEditorTheme"
const READY_HINT_MS = 20_000
/** Status and project pushes arrive a frame apart after a connect; one render for the pair. */
const REFRESH_DEBOUNCE_MS = 200
const OLD_NTWINE_LOG = "The ntwine this window reached is older than the sidebar: its page shows, but can't take the editor's selections or open files here. Update ntwine."
const EVENTS_KEPT = 50

/** The sidebar's host: what every framed page may ask (framed-page.ts), and where its page comes from. */
export interface SidebarHost extends PageHost {
  /** Where ntwine is: the connected origin, else the last discovery's. */
  origin(): string | undefined
  /** The project this window's folders map to, if any. */
  projectSlug(): string | undefined
  /** What to say when there is no ntwine to frame — the connection's own words, or undefined while it is still looking. */
  notFound(): string | undefined
  /**
   * Whether the ntwine at that origin serves a page that can live in the sidebar: "no" when its editor
   * connection says it predates the sidebar, "unknown" while nothing has said. "no" shows the bar over the
   * frame at once, saying to update ntwine, instead of waiting out READY_HINT_MS to say it is loading.
   */
  pageSupport(): "yes" | "no" | "unknown"
  openInBrowser(): void
  reconnect(): void
}

/** What the view shows and did, for the end-to-end suite (NtwineExtensionApi.sidebar). */
export interface SidebarSnapshot {
  opened: boolean
  visible: boolean
  ready: boolean
  /** The "hasn't finished loading" bar is showing over the frame. */
  hinted: boolean
  /** What that bar says. */
  hint?: string
  /** The frame's address, after asExternalUri, when it shows the page. */
  url?: string
  /** The copy it shows instead of the page. */
  message?: string
  badge?: number
  /** The badge's tooltip: the page's counts when it said them, else the Ready count. */
  badgeTooltip?: string
  /** What `ntwine.sidebarView` was set to, "" for none. */
  view: string
  /** The page's address for what it shows, from its last `ntwine:route`. */
  href?: string
  /** Page messages as handled: the type, and what came of it (a command run, "ignored", "opened", "missing"…). */
  events: { type: string; outcome: string }[]
}

export interface Sidebar {
  /** The view has been opened in this window and not closed since. */
  opened(): boolean
  /** The view is in sight: opened, and its container showing. */
  visible(): boolean
  /** The page in the frame said `ntwine:ready` and is still the page there. */
  ready(): boolean
  /** Re-read where ntwine is and this window's project, and re-frame only when either changed. */
  refresh(): void
  /** Frame the page afresh. */
  reload(): void
  setBadge(ready: number): void
  /** Bring the view into sight; `preserveFocus` leaves the caret where it is (in the editor). */
  reveal(preserveFocus: boolean): Promise<void>
  /** Resolves true once the page is ready, false when it will not be (no page to frame) or after `ms`. */
  waitReady(ms: number): Promise<boolean>
  /** Post a compose to the page and wait for its answer; undefined when it was not ready or did not answer within `ms`. */
  compose(input: Omit<EmbedComposeMessage, "type" | "id">, ms: number): Promise<EmbedComposedMessage | undefined>
  navigate(to: EmbedNavigateMessage["to"]): Promise<boolean>
  /** The page's address for what the view shows (its last `ntwine:route`), while it is in sight; else undefined. */
  href(): string | undefined
  /** Post to the page if it is ready; false if it is not, or the post failed. */
  post(message: EmbedEditorContextMessage | EmbedCommandMessage | EmbedEditorExtrasMessage): Promise<boolean>
  /** The extension's state the page shows changed (sharing, the chords): tell a ready page. */
  pushState(): void
  /** Called with true when the page in the frame says it is ready, and false when that page is gone. */
  onReady(listener: (ready: boolean) => void): void
  /** Whether the window's UI runs on a Mac, once the relay (which runs in the UI) has said; undefined before. */
  mac(): boolean | undefined
  /** Called when the page in the view takes the keyboard: the human is using the sidebar. */
  onFocus(listener: () => void): void
  snapshot(): SidebarSnapshot
}

export function registerSidebar(api: Vscode, context: vscode.ExtensionContext, host: SidebarHost): Sidebar {
  let view: vscode.WebviewView | undefined
  /** `origin project` of the page in the frame; a change to either is a different page. */
  let framedKey: string | undefined
  let frameUrl: string | undefined
  /** The origin of the page in the frame — the only one a route's address may be on. */
  let frameOrigin: string | undefined
  /** The page's address for what it shows, from its last route (⋯ Open in browser opens it). */
  let routeHref: string | undefined
  let routeCounts: string | undefined
  let message: string | undefined
  let ready = false
  let hinted = false
  let hintText: string | undefined
  let renders = 0
  let readyTimer: NodeJS.Timeout | undefined
  let refreshTimer: NodeJS.Timeout | undefined
  /** Documents the frame has loaded since it was framed: past the first, the page loaded one itself. */
  let loads = 0
  /**
   * The page reloaded itself and has not said it is ready since. ntwine's page reloads on a server restart
   * (a new build, Vite's dev client), and a reload that lands while the server is down — the supervisor
   * restarts it twice in a second when commits land together — leaves the browser's error page in the
   * frame: blank in VS Code, and silent, so the view showed nothing until the window was reloaded
   * (2026-10-07). Such a frame is framed afresh: when its ready timer runs out with ntwine reachable, and
   * when the connection comes back.
   */
  let reloaded = false
  let badge = 0
  /** The relay reports the platform of the UI it runs in, which under a remote window is not the extension host's. */
  let mac = process.platform === "darwin"
  let macReported: boolean | undefined
  const events: SidebarSnapshot["events"] = []
  const composes = new Composes()
  const focusListeners: (() => void)[] = []
  let waiters: ((ready: boolean) => void)[] = []
  const readyListeners: ((ready: boolean) => void)[] = []
  /** The value `ntwine.sidebarView` has, so it is set only on a change. */
  let routeView = ""

  const theme = () => embedTheme(api.window.activeColorTheme.kind)
  /** `ntwine.matchEditorTheme`: the page wears the editor's colours (the relay reads them; sidebar-html.ts). */
  const matchTheme = () => api.workspace.getConfiguration("ntwine").get<boolean>(MATCH_THEME_SETTING, true) !== false
  const record = (type: string, outcome: string) => {
    events.push({ type, outcome })
    if (events.length > EVENTS_KEPT) events.shift()
  }
  const settle = (value: boolean) => {
    const settled = waiters
    waiters = []
    for (const waiter of settled) waiter(value)
  }

  const post = async (data: EmbedHostMessage | { view: "hint"; show: boolean; text?: string } | { view: "match-theme"; on: boolean }): Promise<boolean> => {
    if (!view || !frameUrl) return false
    try {
      return await view.webview.postMessage(data)
    } catch {
      return false
    }
  }

  function setReady(next: boolean): void {
    const changed = next !== ready
    ready = next
    hinted = false
    hintText = undefined
    clearTimeout(readyTimer)
    readyTimer = undefined
    if (!next) {
      // A page that is gone answers nothing: what waited on it falls back now, not at its timeout.
      composes.drop()
      // The page that said where it was is gone; the title row stops claiming it.
      applyRoute(undefined)
    }
    if (changed) for (const listener of readyListeners) listener(next)
  }

  /**
   * What the page's `ntwine:route` says to VS Code: the context key the title row's buttons show by, and the
   * counts, which ride the badge's tooltip. Undefined resets them, for a page that is gone or not yet ready.
   *
   * NOT the view's `title` or `description`, though the route carries both. A single-view container's
   * row reads "<container>: <view title>", and VS Code re-cases it — capitalize on 1.140, uppercase on
   * 1.90 — so a thread's handle came out "ntwine: Tidy-The-Sample-Loop", and it drops the description
   * there altogether (scripts/e2e-sidebar.ts, 2026-10-01). The row says "ntwine"; the page names the
   * thread it shows in its own drawer header, and the list names its scope.
   */
  function applyRoute(route: EmbedRouteMessage | undefined): void {
    const counts = route?.description || undefined
    if (counts !== routeCounts) {
      routeCounts = counts
      applyBadge()
    }
    routeHref = route?.href
    const next = route?.view ?? ""
    if (next === routeView) return
    routeView = next
    void api.commands.executeCommand("setContext", SIDEBAR_VIEW_KEY, next)
  }

  function showMessage(text: string, actions: readonly ViewAction[]): void {
    framedKey = undefined
    frameUrl = undefined
    frameOrigin = undefined
    setReady(false)
    settle(false)
    if (!view || text === message) return
    message = text
    view.webview.html = messageDocument({ nonce: nonce(), text, actions })
  }

  async function render(force: boolean): Promise<void> {
    if (!view) return
    const origin = host.origin()
    if (!origin) {
      // A page already showing stays: it says it is offline itself, keeps its drafts on screen, and
      // reconnects on its own when ntwine is back on the same port. A new port re-frames it (below).
      if (frameUrl && !force) return
      const reason = host.notFound()
      // Still looking: say so and offer nothing; looked and found nothing: say why, and offer to look again.
      showMessage(reason ?? "Looking for ntwine…", reason ? [{ action: "retry", label: "Try again" }] : [])
      return
    }
    const slug = host.projectSlug()
    const key = `${origin} ${slug ?? ""}`
    if (!force && key === framedKey) return
    framedKey = key
    const generation = ++renders
    const wanted = embedUrl(origin, theme(), slug)
    let external: string
    try {
      // The address as the WINDOW reaches it: identity locally; under a remote window, the forwarded one.
      external = (await api.env.asExternalUri(api.Uri.parse(wanted))).toString(true)
    } catch (error) {
      host.log.warn(`The sidebar couldn't resolve ${wanted}: ${(error as Error).message}`)
      external = wanted
    }
    if (generation !== renders || !view) return
    const target = frameTarget(wanted, external)
    if (target.kind === "remapped") {
      host.log.warn(`The sidebar can't show ntwine: this window reaches it on port ${target.external}, and ntwine only answers on port ${target.port}.`)
      showMessage("ntwine can't load in this window's sidebar. Open it in your browser instead.", [{ action: "browser", label: "Open in browser" }])
      framedKey = key
      return
    }
    host.log.info(`The sidebar shows ${target.url}.`)
    setReady(false)
    message = undefined
    frameUrl = target.url
    frameOrigin = target.origin
    // An ntwine known to predate the sidebar says so from the first paint: its page will never be ready.
    const old = host.pageSupport() === "no"
    if (old) {
      host.log.warn(OLD_NTWINE_LOG)
      hinted = true
      hintText = HINT_OLD_NTWINE
    }
    loads = 0
    reloaded = false
    view.webview.html = frameDocument({ nonce: nonce(), url: target.url, origin: target.origin, match: matchTheme(), ...(old ? { hint: HINT_OLD_NTWINE } : {}) })
    armReadyTimer()
  }

  /** Bound the wait for the page in the frame to say it is ready: past it, the bar — or, for a page that reloaded itself, a fresh frame. */
  function armReadyTimer(): void {
    clearTimeout(readyTimer)
    readyTimer = setTimeout(() => {
      readyTimer = undefined
      if (reloaded && host.origin()) {
        host.log.warn(`The sidebar's page reloaded and didn't say it was ready within ${READY_HINT_MS / 1000}s; framing it again.`)
        void render(true)
        return
      }
      host.log.warn(`The sidebar's page didn't say it was ready within ${READY_HINT_MS / 1000}s.`)
      showHint()
      settle(false)
    }, READY_HINT_MS)
  }

  /** A document loaded in the frame. Past the first, the page reloaded itself: until it says it is ready again, it is not. */
  function onFrameLoaded(): void {
    if (++loads === 1) return
    reloaded = true
    record("loaded", ready ? "reloaded" : "reloaded before ready")
    setReady(false)
    armReadyTimer()
  }

  /** The bar over a page that is not ready, in the words that fit what is known about the ntwine behind it. */
  function showHint(): void {
    const text = host.pageSupport() === "no" ? HINT_OLD_NTWINE : HINT.text
    if (hinted && text === hintText) return
    if (text === HINT_OLD_NTWINE) host.log.warn(OLD_NTWINE_LOG)
    hinted = true
    hintText = text
    void post({ view: "hint", show: true, text })
  }

  /** This frame, as the page-message handling every frame shares sees it (framed-page.ts actOnPage). */
  const link: FrameLink = {
    post: (message) => post(message),
    mac: () => mac,
    runChord: async (command) => {
      await api.commands.executeCommand(command)
    },
  }

  async function onPageMessage(page: EmbedPageMessage): Promise<void> {
    switch (page.type) {
      case "ntwine:ready": {
        reloaded = false
        setReady(true)
        record(page.type, "ready")
        void post({ view: "hint", show: false })
        // The page read its theme from the URL when the frame was made; VS Code's may have changed since.
        void post({ type: "ntwine:theme", theme: theme() })
        void post({ type: "ntwine:host-state", ...host.hostState() })
        settle(true)
        return
      }
      case "ntwine:composed":
        record(page.type, composes.answer(page) ? (page.ok ? "ok" : `refused: ${page.error ?? ""}`) : "unknown id")
        return
      case "ntwine:route":
        applyRoute(page)
        record(page.type, page.view)
        return
      default:
        record(page.type, await actOnPage(api, page, host, link))
    }
  }

  function onMessage(raw: unknown): void {
    if (!raw || typeof raw !== "object") return
    const envelope = raw as { view?: unknown; mac?: unknown; page?: unknown }
    if (typeof envelope.view === "string") {
      switch (envelope.view) {
        case "platform":
          mac = envelope.mac === true
          macReported = mac
          return
        case "retry":
          host.reconnect()
          return
        case "reload":
          reload()
          return
        case "browser":
          host.openInBrowser()
          return
        case "focused":
          for (const listener of focusListeners) listener()
          return
        case "loaded":
          if (frameUrl) onFrameLoaded()
          return
      }
      return
    }
    if (!("page" in envelope) || !frameUrl) return
    const page = parsePageMessage(envelope.page, frameOrigin)
    if (!page) {
      const type = (envelope.page as { type?: unknown } | null)?.type
      record(typeof type === "string" ? type.slice(0, 64) : typeof envelope.page, "ignored")
      return
    }
    onPageMessage(page).catch((error: unknown) => host.log.warn(`The sidebar couldn't act on ${page.type}: ${(error as Error).message}`))
  }

  function applyBadge(): void {
    if (view) view.badge = badge > 0 ? { value: badge, tooltip: routeCounts ?? `${badge} ready` } : undefined
  }

  function reload(): void {
    if (!host.origin()) host.reconnect()
    void render(true)
  }

  context.subscriptions.push(
    api.window.registerWebviewViewProvider(SIDEBAR_VIEW, {
      resolveWebviewView(resolved) {
        view = resolved
        message = undefined
        resolved.webview.options = { enableScripts: true, localResourceRoots: [] }
        resolved.webview.onDidReceiveMessage(onMessage)
        resolved.onDidDispose(() => {
          if (view !== resolved) return
          view = undefined
          framedKey = undefined
          frameUrl = undefined
          frameOrigin = undefined
          message = undefined
          setReady(false)
          settle(false)
        })
        applyBadge()
        void render(true)
      },
    }, { webviewOptions: { retainContextWhenHidden: true } }),
    api.window.onDidChangeActiveColorTheme(() => {
      if (ready) void post({ type: "ntwine:theme", theme: theme() })
    }),
    // To the relay, which holds the colours: it answers with a theme message with them, or without.
    api.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`ntwine.${MATCH_THEME_SETTING}`)) void post({ view: "match-theme", on: matchTheme() })
    }),
    { dispose: () => {
      clearTimeout(readyTimer)
      clearTimeout(refreshTimer)
    } },
  )

  return {
    opened: () => view !== undefined,
    visible: () => view?.visible ?? false,
    ready: () => ready,
    refresh() {
      clearTimeout(refreshTimer)
      refreshTimer = setTimeout(() => {
        // A page that reloaded into an ntwine that was down is the browser's error page: the connection
        // coming back is the moment to frame it again.
        void render(frameUrl !== undefined && reloaded && !ready)
        // The connection may have just learned what the framed ntwine is (a welcome, a 404): a page that
        // never got ready and now is known never to be says why, without waiting out the timer.
        if (frameUrl && !ready && host.pageSupport() === "no") showHint()
      }, REFRESH_DEBOUNCE_MS)
    },
    reload,
    setBadge(next) {
      badge = next
      applyBadge()
    },
    async reveal(preserveFocus) {
      if (view) view.show(preserveFocus)
      else await api.commands.executeCommand(SIDEBAR_FOCUS)
    },
    waitReady(ms) {
      if (ready) return Promise.resolve(true)
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          waiters = waiters.filter((waiter) => waiter !== done)
          resolve(false)
        }, ms)
        const done = (value: boolean) => {
          clearTimeout(timer)
          resolve(value)
        }
        waiters.push(done)
      })
    },
    compose(input, ms) {
      if (!ready) return Promise.resolve(undefined)
      return composes.send(post, input, ms)
    },
    async navigate(to) {
      return ready && (await post({ type: "ntwine:navigate", to }))
    },
    href: () => (ready && view?.visible ? routeHref : undefined),
    async post(message) {
      return ready && (await post(message))
    },
    pushState() {
      if (ready) void post({ type: "ntwine:host-state", ...host.hostState() })
    },
    onReady(listener) {
      readyListeners.push(listener)
    },
    mac: () => macReported,
    onFocus(listener) {
      focusListeners.push(listener)
    },
    snapshot: () => ({
      opened: view !== undefined,
      visible: view?.visible ?? false,
      ready,
      hinted,
      ...(hinted && hintText ? { hint: hintText } : {}),
      ...(frameUrl ? { url: frameUrl } : {}),
      ...(message ? { message } : {}),
      ...(view?.badge ? { badge: view.badge.value } : {}),
      ...(view?.badge ? { badgeTooltip: view.badge.tooltip } : {}),
      view: routeView,
      ...(routeHref ? { href: routeHref } : {}),
      events: [...events],
    }),
  }
}
