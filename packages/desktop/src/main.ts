import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
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
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { appPath, classifyNavigation, startAddress } from "./navigation.ts"
import { errorPage, loadingPage, projectPickerPage } from "./pages.ts"
import { locateServer, startServer } from "./server.ts"
import { loginShellEnvironment } from "./shell-env.ts"

/**
 * The Frizz desktop app: a Chromium window onto the Frizz server, and as little else as possible.
 *
 * The server is found or started by server.ts and runs on the system Node; nothing here serves or
 * renders Frizz itself. What this file adds is what a browser gives a tab for free and a bare
 * BrowserWindow does not: links that open in the operator's real browser, the Edit menu macOS needs
 * before copy and paste work at all, back and forward, a context menu, and a window that remembers
 * where it was. Quitting leaves the server running, as closing a browser tab does — the scheduler,
 * PR watchers and wakes keep working, and the next launch joins it.
 */

const APP_ID = "dev.frizz.app"
const here = dirname(fileURLToPath(import.meta.url))
const isMac = process.platform === "darwin"

// One userData directory whether this runs from the checkout or as the packaged Frizz.app.
app.setName("Frizz")
if (process.platform === "win32") app.setAppUserModelId(APP_ID)

/** The server this app is showing — the one origin its windows may navigate within. */
let origin: string | undefined
let mainWindow: BrowserWindow | undefined
let connecting = false

const statePath = () => join(app.getPath("userData"), "window-state.json")
const launcherLogPath = () => join(app.getPath("logs"), "launcher.log")

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
    // The board's own first-paint colours, so a document load (switching projects is one) never
    // flashes white between pages.
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0d0e10" : "#f7f7f7",
    autoHideMenuBar: true,
    title: "Frizz",
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

/** Whatever window should answer "bring Frizz to the front". */
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

async function waitForRunningServer(): Promise<string | undefined> {
  const deadline = Date.now() + 60_000
  for (;;) {
    const found = await locateServer()
    if (found !== "starting") return found
    if (Date.now() > deadline) return undefined
    await delay(500)
  }
}

/**
 * Point `win` at the Frizz server: the one running, or one started now from `cwd`.
 *
 * FRIZZ_DESKTOP_URL skips the search and shows that origin — a board on a non-default port, or a
 * disposable one somebody is testing against.
 */
async function connect(win: BrowserWindow, cwd = homedir()): Promise<void> {
  if (connecting) return
  connecting = true
  const show = async (url: string) => {
    if (!win.isDestroyed()) await win.loadURL(url).catch(() => {})
  }
  const progress = (line: string) => {
    if (win.isDestroyed() || !win.webContents.getURL().startsWith("data:")) return
    win.webContents
      .executeJavaScript(`document.getElementById("detail")?.replaceChildren(${JSON.stringify(line)})`)
      .catch(() => {})
  }
  try {
    await show(loadingPage("looking for a running server"))
    let found = process.env.FRIZZ_DESKTOP_URL ? new URL(process.env.FRIZZ_DESKTOP_URL).origin : await waitForRunningServer()
    if (!found) {
      progress("starting the server")
      const outcome = await startServer({
        env: await loginShellEnvironment(),
        cwd,
        logPath: launcherLogPath(),
        onProgress: progress,
      })
      if (outcome.kind === "failed") {
        // The launcher's own wording for the first-run case tells a terminal user to cd somewhere.
        await show(outcome.needsProject ? projectPickerPage() : errorPage({ message: outcome.message, logPath: launcherLogPath() }))
        return
      }
      found = outcome.origin
    }
    origin = found
    await show(startAddress(readWindowState().path, found))
  } catch (error) {
    await show(errorPage({ message: error instanceof Error ? error.message : String(error) }))
  } finally {
    connecting = false
  }
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

/** Everything a page could ask to open, routed by where it belongs (see navigation.ts). */
function guardNavigation(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    const target = classifyNavigation(url, origin)
    // The board's own pages open as windows of this app — ⌘-click on a thread opens its full page.
    if (target === "app") return { action: "allow", overrideBrowserWindowOptions: { ...windowOptions(), show: true, width: 1100, height: 800 } }
    if (target === "external") void shell.openExternal(url)
    return { action: "deny" }
  })
  contents.on("will-navigate", (event, url) => {
    // The loading and error pages are data: URLs this app loads itself (loadURL is not a
    // page-initiated navigation, so it never reaches here); a page may only move within the board.
    const target = classifyNavigation(url, origin)
    if (target === "app") return
    event.preventDefault()
    if (target === "external") void shell.openExternal(url)
  })
  contents.on("did-fail-load", (_event, code, _description, url, isMainFrame) => {
    // -3 is ERR_ABORTED: another navigation replaced this one, which is not a failure.
    if (!isMainFrame || code === -3 || classifyNavigation(url, origin) !== "app") return
    const win = BrowserWindow.fromWebContents(contents)
    if (win) void connect(win)
  })
  contents.on("render-process-gone", (_event, details) => {
    if (details.reason !== "clean-exit") contents.reload()
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
    if (items.length) Menu.buildFromTemplate(items).popup()
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
          click: () => { if (origin) openInNewWindow(`${origin}/`) },
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
    // Mouse back/forward buttons on Windows, and the trackpad swipe on macOS.
    win.on("app-command", (_e, command) => {
      if (command === "browser-backward") goBack(win)
      if (command === "browser-forward") goForward(win)
    })
    win.on("swipe", (_e, direction) => {
      if (direction === "left") goBack(win)
      if (direction === "right") goForward(win)
    })
  })

  ipcMain.on("frizz-desktop:focus-window", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    if (isMac) app.focus({ steal: true })
  })
  ipcMain.on("frizz-desktop:retry", (event) => {
    const win = fromOwnPage(event)
    if (win) void connect(win)
  })
  ipcMain.on("frizz-desktop:choose-project", async (event) => {
    const win = fromOwnPage(event)
    if (!win) return
    const choice = await dialog.showOpenDialog(win, {
      title: "Choose a project folder",
      buttonLabel: "Open in Frizz",
      properties: ["openDirectory"],
    })
    if (!choice.canceled && choice.filePaths[0]) void connect(win, choice.filePaths[0])
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
