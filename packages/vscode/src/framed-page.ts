// WHAT A FRAMED NTWINE PAGE MAY ASK OF THE EDITOR — answered the same wherever the page is framed: the
// sidebar (sidebar.ts) or a thread in an editor tab (thread-panel.ts). Each frame keeps what is its own —
// when its page is ready, the composes it waits on, what its route means to the frame around it (the
// sidebar's title row, a tab's title) — and hands every other page message here: a file or a web link to
// open, a forwarded key chord, the editor's context into a composer, the eye, a review, files for `@`.
//
// Only `import type` from vscode, like app.ts.

import { randomUUID } from "node:crypto"
import type * as vscode from "vscode"
import type { EditorOpen } from "@ntwine/shared/editor-protocol"
import type {
  EmbedAddContextMessage,
  EmbedComposeMessage,
  EmbedComposedMessage,
  EmbedHostMessage,
  EmbedHostStateMessage,
  EmbedPageMessage,
  EmbedPickContextMessage,
  EmbedPickedFile,
  EmbedReviewMessage,
} from "@ntwine/shared/embed-protocol"
import { chordCommand } from "./embed.ts"

type Vscode = typeof vscode

/** Post a compose to one frame's page and wait for its answer; undefined when it did not answer within `ms`. */
export type PageComposer = (input: Omit<EmbedComposeMessage, "type" | "id">, ms: number) => Promise<EmbedComposedMessage | undefined>

/** The extension's side of every framed page, whichever frame it is in. */
export interface PageHost {
  openFile(message: EditorOpen): Promise<{ ok: boolean; error?: string }>
  /**
   * The page asked for the editor's context in its composer (`ntwine:add-context`). `into` is the frame
   * that asked — the context goes back to the page whose bar was clicked — or undefined for the sidebar,
   * whose own path reveals it first. Resolves to what came of it, for the record.
   */
  addContext(message: EmbedAddContextMessage, into: PageComposer | undefined): Promise<string>
  /** What the page shows of the extension's own state (`ntwine:host-state`). */
  hostState(): Omit<EmbedHostStateMessage, "type">
  /** The page's eye: share the editor with Ntwine or stop (`ntwine:share-editor`); resolves to what came of it. */
  setShareEditor(on: boolean): Promise<string>
  /** A thread's changes in this window (`ntwine:review`); resolves to what came of it. */
  review(message: EmbedReviewMessage): Promise<string>
  /** Files for the page's `@` menu, or what was dropped from the explorer (`ntwine:pick-context`). */
  pickContext(message: EmbedPickContextMessage): Promise<EmbedPickedFile[]>
  log: { info(line: string): void; warn(line: string): void }
}

/** The frame a message came from, as `actOnPage` needs it. */
export interface FrameLink {
  post(message: EmbedHostMessage): Promise<boolean>
  /** The window's UI runs on a Mac, as this frame's relay said. */
  mac(): boolean
  /** Run the VS Code command a forwarded chord maps to — a frame may mean something of its own by one. */
  runChord(command: string): Promise<void>
  /** This frame's composer, for `ntwine:add-context`; undefined for the sidebar (see PageHost.addContext). */
  composer?: PageComposer
}

/** The page messages each frame answers itself; everything else is `actOnPage`'s. */
export type FrameOwnMessage = Extract<EmbedPageMessage, { type: "ntwine:ready" | "ntwine:composed" | "ntwine:route" }>
export type SharedPageMessage = Exclude<EmbedPageMessage, FrameOwnMessage>

/** Act on a page message every frame answers alike; resolves to what came of it, for the frame's record. */
export async function actOnPage(api: Vscode, page: SharedPageMessage, host: PageHost, frame: FrameLink): Promise<string> {
  switch (page.type) {
    case "ntwine:open-file": {
      const { type: _, ...open } = page
      const result = await host.openFile({ t: "open", id: randomUUID(), ...open })
      if (!result.ok) void api.window.showWarningMessage(result.error ?? `Couldn't open ${page.path}.`)
      return result.ok ? "opened" : "missing"
    }
    case "ntwine:open-external":
      return (await api.env.openExternal(api.Uri.parse(page.url, true))) ? "opened" : "declined"
    case "ntwine:key": {
      const command = chordCommand(page, frame.mac())
      // Recorded as it is RUN, not once it has finished: a command's effect (the Explorer taking the side
      // bar) lands before VS Code resolves the call, and whoever reads the record after seeing the effect
      // must find it there — the sidebar recorded first until the handling moved here, and the e2e's
      // forwarded-chord step read an empty record behind a shown Explorer when it did not.
      if (command) frame.runChord(command).catch((error: unknown) => host.log.warn(`${command} failed: ${(error as Error).message}`))
      return command ?? "ignored"
    }
    case "ntwine:add-context":
      return host.addContext(page, frame.composer)
    case "ntwine:share-editor": {
      const outcome = await host.setShareEditor(page.on)
      // Whatever came of it, the page shows what is TRUE now: a write that did not take puts its eye back.
      void frame.post({ type: "ntwine:host-state", ...host.hostState() })
      return outcome
    }
    case "ntwine:review":
      return host.review(page)
    case "ntwine:pick-context": {
      // Answered always, with nothing when nothing matched or the ask failed: the page waits on this id.
      let files: EmbedPickedFile[] = []
      try {
        files = await host.pickContext(page)
      } catch (error) {
        host.log.warn(`Listing the workspace's files failed: ${(error as Error).message}`)
      }
      await frame.post({ type: "ntwine:context-picks", id: page.id, files })
      return `${files.length} ${page.uris ? "dropped" : "found"}`
    }
  }
}

/** The pending composes of one frame: an id per post, answered by the page's `ntwine:composed` or dropped. */
export class Composes {
  readonly #pending = new Map<string, (answer: EmbedComposedMessage | undefined) => void>()

  /** Post a compose through `post` and wait for its answer, or undefined after `ms`, or at once when the post failed. */
  send(post: (message: EmbedComposeMessage) => Promise<boolean>, input: Omit<EmbedComposeMessage, "type" | "id">, ms: number): Promise<EmbedComposedMessage | undefined> {
    const id = randomUUID()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        resolve(undefined)
      }, ms)
      this.#pending.set(id, (answer) => {
        clearTimeout(timer)
        resolve(answer)
      })
      void post({ type: "ntwine:compose", id, ...input }).then((sent) => {
        if (sent) return
        this.#pending.delete(id)
        clearTimeout(timer)
        resolve(undefined)
      })
    })
  }

  /** The page answered; false when no compose of this frame waits on that id. */
  answer(message: EmbedComposedMessage): boolean {
    const resolve = this.#pending.get(message.id)
    this.#pending.delete(message.id)
    resolve?.(message)
    return resolve !== undefined
  }

  /** The page is gone: what waited on it falls back now, not at its timeout. */
  drop(): void {
    for (const [id, resolve] of this.#pending) {
      this.#pending.delete(id)
      resolve(undefined)
    }
  }
}
