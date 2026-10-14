import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  nativeTheme,
  screen,
  shell,
  type BrowserWindowConstructorOptions,
  type IpcMainEvent,
  type MenuItemConstructorOptions,
  type Rectangle,
  type WebContents,
} from "electron"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { appPath, classifyNavigation, startAddress } from "./navigation.ts"
import { errorPage, loadingPage, waitingPage } from "./pages.ts"
import { locateServer } from "./server.ts"

/**
 * Ntwine in an Electron window, for the dev loop: a Chromium window onto the board `nub run dev` serves,
 * and as little else as possible.
 *
 * It never starts or runs a server. It joins the one that is up (server.ts), and when none is it waits
 * for one, so the window can be opened before the board and survive the board restarting under it.
 * Because the page is the board's own, Vite HMR reaches it exactly as it reaches a browser tab, and the
 * dev supervisor's control-plane recycles look like any other dropped connection.
 *
 * What this file adds is what a browser gives a tab for free and a bare BrowserWindow does not: links
 * that open in the operator's real browser, the Edit menu macOS needs before copy and paste work at all,
 * back and forward, a context menu, and a window that remembers where it was.
 *
 * `NTWINE_DESKTOP_URL=http://127.0.0.1:<port>` skips the search and shows that origin — a second dev
 * board, or a disposable stack.
 */

const APP_ID = "dev.ntwine.desktop"
const here = dirname(fileURLToPath(import.meta.url))
const isMac = process.platform === "darwin"

app.setName("Ntwine")
// NOT Electron's default for an app named Ntwine: on macOS that is ~/Library/Application Support/Ntwine,
// which is Ntwine's own data root (ntwine-paths.ts), and Chromium would fill it with a browser profile.
// setPath throws for a directory that does not exist yet, which on a first launch this one does not.
const userData = join(app.getPath("appData"), "Ntwine Desktop")
mkdirSync(userData, { recursive: true })
app.setPath("userData", userData)
if (process.platform === "win32") app.setAppUserModelId(APP_ID)

/** The server this app is showing — the one origin its windows may navigate within. */
let origin: string | undefined
let mainWindow: BrowserWindow | undefined
/** One search at a time, shared by every window that is waiting on it. */
let pending: Promise<string> | undefined

const statePath = () => join(app.getPath("userData"), "window-state.json")

interface WindowState {
  bounds?: Rectangle
  maximized?: boolean
  /** The in-app path last shown, restored on the next launch against whatever server that finds. */
  path?: string
}

function readWindowState(): WindowState {
  try {
    return JSON.parse(readFileSync(statePath(), "utf8")) as WindowState
  } catch {
    return {}
  }
}

function saveWindowState(win: BrowserWindow): void {
  const url = win.webContents.getURL()
  const state: WindowState = {
    ...readWindowState(),
    bounds: win.getNormalBounds(),
    maximized: win.isMaximized(),
  }
  const path = origin ? appPath(url, origin) : undefined
  if (path) state.path = path
  try {
    mkdirSync(dirname(statePath()), { recursive: true })
    writeFileSync(statePath(), JSON.stringify(state))
  } catch {
    // Losing the window position is not worth failing a quit over.
  }
}

/** Saved bounds, unless the display they were on is gone — then only the size survives. */
function restorableBounds(bounds: Rectangle | undefined): Partial<Rectangle> {
  if (!bounds) return { width: 1400, height: 900 }
  const visible = screen.getAllDisplays().some(({ workArea: area }) =>
    bounds.x < area.x + area.width && bounds.x + bounds.width > area.x &&
    bounds.y < area.y + area.height && bounds.y + bounds.height > area.y)
  return visible ? bounds : { width: bounds.width, height: bounds.height }
}

function windowOptions(): BrowserWindowConstructorOptions {
  const icon = join(here, "icon.png")
  return {
    minWidth: 420,
    minHeight: 360,
    show: false,
    // The board's own first-paint colours, so a document load never flashes white between pages.
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0d0e10" : "#f7f7f7",
    autoHideMenuBar: true,
    title: "Ntwine",
    ...(process.platform === "linux" && existsSync(icon) ? { icon } : {}),
    webPreferences: {
      preload: join(here, "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  }
}

function createMainWindow(): BrowserWindow {
  const state = readWindowState()
  const win = new BrowserWindow({ ...windowOptions(), ...restorableBounds(state.bounds) })
  if (state.maximized) win.maximize()
  win.once("ready-to-show", () => win.show())
  win.on("close", () => saveWindowState(win))
  win.on("closed", () => { if (mainWindow === win) mainWindow = undefined })
  mainWindow = win
  void connect(win)
  return win
}

/** Whatever window should answer "bring Ntwine to the front". */
function focusApp(): void {
  const win = mainWindow ?? BrowserWindow.getAllWindows()[0]
  if (!win) {
    createMainWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/** Every window still showing one of this app's own pages. */
function ownPages(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter((win) => win.webContents.getURL().startsWith("data:"))
}

/**
 * The board's origin, once one answers. Polls every second for as long as it takes: the window is
 * opened beside `nub run dev`, often before the board is up, and a dev board that died comes back.
 */
async function resolveServer(): Promise<string> {
  if (process.env.NTWINE_DESKTOP_URL) {
    const url = new URL(process.env.NTWINE_DESKTOP_URL)
    for (;;) {
      if (await fetch(new URL("/_ntwine/health", url), { signal: AbortSignal.timeout(1_500) }).then((r) => r.ok, () => false)) return url.origin
      showWaiting()
      await delay(1_000)
    }
  }
  for (;;) {
    const found = await locateServer()
    if (found) return found
    showWaiting()
    await delay(1_000)
  }
}

/** Every window on one of this app's own pages shows the waiting one — each poll, so a window that
 * started connecting since (a second failed load, a new window) gets it too. */
function showWaiting(): void {
  const waiting = waitingPage(process.env.NTWINE_DESKTOP_URL)
  for (const win of ownPages()) {
    if (win.webContents.getURL() !== waiting) void win.loadURL(waiting).catch(() => {})
  }
}

/**
 * Point `win` at the board, at `path` if given and otherwise where the last session ended. Every window
 * shows its own loading screen but shares the one search in flight.
 */
async function connect(win: BrowserWindow, options: { path?: string } = {}): Promise<void> {
  const show = async (url: string) => {
    if (!win.isDestroyed()) await win.loadURL(url).catch(() => {})
  }
  await show(loadingPage())
  pending ??= resolveServer().finally(() => { pending = undefined })
  const found = await pending
  if (win.isDestroyed()) return
  origin = found
  await show(startAddress(options.path ?? readWindowState().path, found))
  // The loading screen was this app's, not a page anybody visited: Back must not return to it.
  if (!win.isDestroyed()) win.webContents.navigationHistory.clear()
}

function goBack(win: BrowserWindow | null | undefined): void {
  if (win?.webContents.navigationHistory.canGoBack()) win.webContents.navigationHistory.goBack()
}

function goForward(win: BrowserWindow | null | undefined): void {
  if (win?.webContents.navigationHistory.canGoForward()) win.webContents.navigationHistory.goForward()
}

function openInNewWindow(url: string): void {
  const win = new BrowserWindow({ ...windowOptions(), width: 1100, height: 800 })
  win.once("ready-to-show", () => win.show())
  void win.loadURL(url)
}

const lastCrash = new WeakMap<WebContents, number>()

/** Records now, and answers whether the previous record is under 30 seconds old. */
function tooSoon(log: WeakMap<WebContents, number>, contents: WebContents): boolean {
  const previous = log.get(contents)
  log.set(contents, Date.now())
  return previous !== undefined && Date.now() - previous < 30_000
}

/** Everything a page could ask to open, routed by where it belongs (see navigation.ts). */
function guardNavigation(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    const target = classifyNavigation(url, origin)
    // The board's own pages open as windows of this app — ⌘-click on a thread opens its full page.
    // Such a window is the operator's, not its opener's: closing the board must not close it too.
    if (target === "app") {
      return { action: "allow", outlivesOpener: true, overrideBrowserWindowOptions: { ...windowOptions(), show: true, width: 1100, height: 800 } }
    }
    if (target === "external") void shell.openExternal(url)
    return { action: "deny" }
  })
  contents.on("will-navigate", (event, url) => {
    // The loading and waiting pages are data: URLs this app loads itself (loadURL is not a
    // page-initiated navigation, so it never reaches here); a page may only move within the board.
    const target = classifyNavigation(url, origin)
    if (target === "app") return
    event.preventDefault()
    if (target === "external") void shell.openExternal(url)
  })
  contents.on("did-fail-load", (_event, code, _description, url, isMainFrame) => {
    // -3 is ERR_ABORTED: another navigation replaced this one, which is not a failure.
    if (!isMainFrame || code === -3 || !origin || classifyNavigation(url, origin) !== "app") return
    const win = BrowserWindow.fromWebContents(contents)
    // The board went away mid-navigation (a reload while `nub run dev` restarts): wait for it, and
    // come back to the page that failed.
    if (win) void connect(win, { path: appPath(url, origin) })
  })
  contents.on("render-process-gone", (_event, details) => {
    if (details.reason === "clean-exit") return
    // A reload cures a one-off crash. A page that crashes as it loads would reload forever, and a
    // launch or integrity failure is not the page's fault at all, so those show the error instead.
    if (tooSoon(lastCrash, contents) || details.reason === "launch-failed" || details.reason === "integrity-failure") {
      void contents.loadURL(errorPage({ title: "The page crashed", message: `Chromium reported: ${details.reason}.` }))
      return
    }
    contents.reload()
  })
  contents.on("context-menu", (_event, params) => {
    const items: MenuItemConstructorOptions[] = []
    if (params.linkURL) {
      const target = classifyNavigation(params.linkURL, origin)
      if (target === "app") items.push({ label: "Open link in new window", click: () => openInNewWindow(params.linkURL) })
      if (target === "external") items.push({ label: "Open link in browser", click: () => void shell.openExternal(params.linkURL) })
      items.push({ label: "Copy link address", click: () => clipboard.writeText(params.linkURL) })
    }
    if (params.mediaType === "image" && params.srcURL) {
      items.push({ label: "Copy image", click: () => contents.copyImageAt(params.x, params.y) })
    }
    if (params.isEditable) {
      if (items.length) items.push({ type: "separator" })
      for (const suggestion of params.dictionarySuggestions) {
        items.push({ label: suggestion, click: () => contents.replaceMisspelling(suggestion) })
      }
      if (params.dictionarySuggestions.length) items.push({ type: "separator" })
      items.push({ role: "cut" }, { role: "copy" }, { role: "paste" }, { type: "separator" }, { role: "selectAll" })
    } else if (params.selectionText.trim()) {
      if (items.length) items.push({ type: "separator" })
      items.push({ role: "copy" })
    }
    // Inspect element, as a tab offers it: this is a dev-loop window.
    if (items.length) items.push({ type: "separator" })
    items.push({ label: "Inspect element", click: () => contents.inspectElement(params.x, params.y) })
    Menu.buildFromTemplate(items).popup()
  })
}

function buildMenu(): Menu {
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: "appMenu" } as const] : []),
    {
      label: "File",
      submenu: [
        {
          label: "New window",
          accelerator: "CmdOrCtrl+N",
          click: () => (origin ? openInNewWindow(`${origin}/`) : focusApp()),
        },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    // Without an Edit menu macOS routes ⌘C/⌘V/⌘X/⌘A nowhere — including paste into the terminal.
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { label: "Back", accelerator: isMac ? "Cmd+[" : "Alt+Left", click: () => goBack(BrowserWindow.getFocusedWindow()) },
        { label: "Forward", accelerator: isMac ? "Cmd+]" : "Alt+Right", click: () => goForward(BrowserWindow.getFocusedWindow()) },
        { type: "separator" },
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ]
  return Menu.buildFromTemplate(template)
}

/** The data: pages this app draws are the only ones allowed to ask for a reconnect. */
function fromOwnPage(event: IpcMainEvent): BrowserWindow | undefined {
  if (!event.senderFrame?.url.startsWith("data:")) return undefined
  return BrowserWindow.fromWebContents(event.sender) ?? undefined
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on("second-instance", focusApp)
  app.on("web-contents-created", (_event, contents) => guardNavigation(contents))
  app.on("browser-window-created", (_event, win) => {
    // The trackpad swipe on macOS. (Mouse back/forward buttons need nothing: Chromium already
    // navigates on them, and handling their app-command too went back two pages per click.)
    win.on("swipe", (_e, direction) => {
      if (direction === "left") goBack(win)
      if (direction === "right") goForward(win)
    })
  })

  ipcMain.on("ntwine-desktop:focus-window", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    if (isMac) app.focus({ steal: true })
  })
  ipcMain.on("ntwine-desktop:retry", (event) => {
    const win = fromOwnPage(event)
    if (win) void connect(win)
  })

  app.on("window-all-closed", () => {
    if (!isMac) app.quit()
  })
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })

  void app.whenReady().then(() => {
    Menu.setApplicationMenu(buildMenu())
    createMainWindow()
  })
}
