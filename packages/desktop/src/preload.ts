import { contextBridge, ipcRenderer } from "electron"

/**
 * The only bridge between a page and this app, and deliberately a small one: nothing here reads or
 * writes anything, so a page that calls it — including the board, whose Markdown workers write — can
 * at most raise the window or ask for a reconnect.
 *
 * `focusWindow` exists because `window.focus()` does not raise an Electron window the way it raises a
 * browser tab, so a notification click would otherwise open the thread behind whatever is on top.
 */
contextBridge.exposeInMainWorld("frizzDesktop", {
  focusWindow: () => ipcRenderer.send("frizz-desktop:focus-window"),
  retry: () => ipcRenderer.send("frizz-desktop:retry"),
  chooseProject: () => ipcRenderer.send("frizz-desktop:choose-project"),
})
